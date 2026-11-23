import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KEY } from './keyed.js';
import WebSocket from 'ws';
import { startDevServer, type DevServer } from '../src/server.js';

const TAG = '<script src="/teleport.js"></script>';

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));
}

async function start(app: string): Promise<[DevServer, number]> {
  const s = await startDevServer({ port: 0, host: '127.0.0.1', app });
  return [s, (s.http.address() as { port: number }).port];
}

const received = new WeakMap<WebSocket, string[]>();

// Records text messages from the moment the socket exists: the server may send in the same
// packet as the upgrade response, before an awaiting caller could attach a listener.
const open = (url: string) =>
  new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url);
    received.set(ws, []);
    ws.on('message', (data: Buffer, isBinary) => {
      if (!isBinary) received.get(ws)!.push(data.toString());
    });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });

/** Polls the API until a connected device matches. */
async function deviceInfo(port: number, match: (d: { id: string; href: string }) => boolean): Promise<{ id: string; href: string; devtools: string; inspect: string }> {
  for (;;) {
    const live = (await (await fetch(`http://127.0.0.1:${port}/__teleport/${KEY}/api/live`)).json()) as { device: { id: string; href: string; devtools: string; inspect: string } }[];
    const hit = live.find((x) => match(x.device));
    if (hit) return hit.device;
    await new Promise((r) => setTimeout(r, 5));
  }
}

const nextText = (ws: WebSocket, match: (s: string) => boolean) =>
  new Promise<string>((resolve) => {
    const poll = () => {
      const texts = received.get(ws)!;
      const i = texts.findIndex(match);
      if (i < 0) return void setTimeout(poll, 5);
      resolve(texts.splice(0, i + 1)[i]!);
    };
    poll();
  });

describe('dev proxy', () => {
  let upstream: Server;
  let dev: DevServer;
  let port: number;

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      if (req.url === '/') res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><html><head><title>x</title></head><body>hi</body></html>');
      else if (req.url === '/app.js') res.writeHead(200, { 'content-type': 'text/javascript' }).end('console.log("<head>")');
      else res.writeHead(404).end();
    });
    [dev, port] = await start(`http://127.0.0.1:${await listen(upstream)}`);
  });
  afterAll(async () => {
    await dev.close();
    upstream.close();
  });

  it('injects the agent as the first thing in <head> of proxied HTML', async () => {
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    expect(html).toContain(`<head>${TAG}<title>`);
  });

  it('passes non-HTML responses through untouched', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/app.js`);
    expect(await res.text()).toBe('console.log("<head>")');
    expect((await fetch(`http://127.0.0.1:${port}/missing`)).status).toBe(404);
  });

  it("keeps the agent reachable next to the app, and teleport's own address out of the app's", async () => {
    expect((await fetch(`http://127.0.0.1:${port}/teleport.js`)).status).toBe(200);
    // Under teleport's address nothing reaches the app, with the key or without.
    expect((await fetch(`http://127.0.0.1:${port}/__teleport/`)).status).toBe(403);
    expect((await fetch(`http://127.0.0.1:${port}/__teleport/${KEY}/nope`)).status).toBe(404);
  });
});

describe('static app directory', () => {
  let dev: DevServer;
  let port: number;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'teleport-app-'));
    writeFileSync(join(dir, 'index.html'), '<html><body>no head</body></html>');
    writeFileSync(join(dir, 'a.css'), 'body{}');
    [dev, port] = await start(dir);
  });
  afterAll(() => dev.close());

  it('serves index.html with the agent injected even without a <head>', async () => {
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    expect(html).toBe(`<html>${TAG}<body>no head</body></html>`);
  });

  it('serves other files with a content type and refuses to escape the directory', async () => {
    const css = await fetch(`http://127.0.0.1:${port}/a.css`);
    expect(css.headers.get('content-type')).toContain('text/css');
    expect((await fetch(`http://127.0.0.1:${port}/..%2f..%2fetc%2fpasswd`)).status).toBe(404);
  });
});

describe('inspector relay', () => {
  let dev: DevServer;
  let port: number;

  beforeAll(async () => {
    dev = await startDevServer({ port: 0, host: '127.0.0.1' });
    port = (dev.http.address() as { port: number }).port;
  });
  afterAll(() => dev.close());

  it('lists devices, asks the device to load the inspector, and pipes CDP both ways', async () => {
    const base = `ws://127.0.0.1:${port}`;
    const target = await open(`${base}/ws/target?href=${encodeURIComponent('http://device/app')}`);
    const device = await deviceInfo(port, (d) => d.href === 'http://device/app');
    expect(device.href).toBe('http://device/app');

    const client = await open(`${base}/__teleport/${KEY}/ws/${device.id}`);
    client.send('{"id":1,"method":"Runtime.enable"}');
    expect(await nextText(target, (s) => s.startsWith('load '))).toBe(`load /__teleport/inspector.js?id=${device.id}`);

    const cdp = await open(`${base}/ws/cdp/${device.id}`);
    expect(await nextText(cdp, () => true)).toBe('{"id":1,"method":"Runtime.enable"}');
    cdp.send('{"id":1,"result":{}}');
    expect(await nextText(client, () => true)).toBe('{"id":1,"result":{}}');

    for (const ws of [target, client, cdp]) ws.close();
  });

  it('tells the inspector to detach when DevTools closes', async () => {
    const base = `ws://127.0.0.1:${port}`;
    const target = await open(`${base}/ws/target?href=${encodeURIComponent('http://device/x')}`);
    const device = await deviceInfo(port, (d) => d.href === 'http://device/x');
    const client = await open(`${base}/__teleport/${KEY}/ws/${device.id}`);
    const cdp = await open(`${base}/ws/cdp/${device.id}`);
    client.close();
    expect(await nextText(cdp, () => true)).toBe('{"method":"teleport.detach"}');

    target.close();
    cdp.close();
  });

  it('links DevTools through 127.0.0.1, the only host its Content Security Policy lets it connect to', async () => {
    const target = await open(`ws://localhost:${port}/ws/target?id=lan-device`);
    const device = await deviceInfo(port, (d) => d.id === 'lan-device');
    expect(device.inspect).toBe(`http://localhost:${port}/__teleport/${KEY}/d/lan-device`);
    expect(device.devtools).toBe(`devtools://devtools/bundled/devtools_app.html?ws=127.0.0.1:${port}/__teleport/${KEY}/ws/lan-device`);
    target.close();
  });

  // The key is what a request through a tunnel or proxy on this machine can't have: such a request
  // reads as this machine's own in every other way (tested through one below).
  it('answers nothing that drives a device without the key', async () => {
    const target = await open(`ws://127.0.0.1:${port}/ws/target?id=keyless`);
    const at = `127.0.0.1:${port}`;
    const refused = async (url: string, init?: RequestInit) => {
      const r = await fetch(url, { redirect: 'manual', ...init });
      return [r.status, ((await r.json()) as { error: string }).error.slice(0, 26)];
    };
    const NO = [403, "this needs teleport's key."];
    expect(await refused(`http://${at}/__teleport/api/live`)).toEqual(NO);
    expect(await refused(`http://${at}/__teleport/wrongkey00/api/live`)).toEqual(NO);
    expect(await refused(`http://${at}/__teleport/api/eval?id=keyless&expr=1`, { method: 'POST', headers: { 'x-teleport': 'q' } })).toEqual(NO);
    expect(await refused(`http://${at}/__teleport/devtools/keyless`)).toEqual(NO);
    expect(await refused(`http://${at}/__teleport/`)).toEqual(NO);
    for (const path of ['/ws/client/keyless', '/__teleport/wrongkey00/ws/keyless', '/__teleport/ws/client/keyless']) await expect(open(`ws://${at}${path}`), path).rejects.toThrow();
    // No list of devices for whoever asks, either: it named each one's address and DevTools socket.
    expect((await fetch(`http://${at}/json/list`)).status).not.toBe(200);
    expect((await fetch(`http://${at}/__teleport/${KEY}/api/live`)).status).toBe(200);
    target.close();
  });

  it('keeps DevTools attached when the tab reloads and restores what it had enabled', async () => {
    const base = `ws://127.0.0.1:${port}`;
    const target = await open(`${base}/ws/target?id=tab-1`);
    const client = await open(`${base}/__teleport/${KEY}/ws/tab-1`);
    client.send('{"id":1,"method":"Runtime.enable"}');
    await nextText(target, (s) => s.startsWith('load '));
    const cdp = await open(`${base}/ws/cdp/tab-1`);
    await nextText(cdp, () => true);
    cdp.send('{"id":1,"result":{}}');
    await nextText(client, (s) => s === '{"id":1,"result":{}}');
    client.send('{"id":2,"method":"Runtime.evaluate","params":{"expression":"1"}}');
    await nextText(cdp, () => true);

    target.close();
    cdp.close();
    expect(JSON.parse(await nextText(client, () => true))).toMatchObject({ id: 2, error: { message: 'The page went away' } });

    const reloaded = await open(`${base}/ws/target?id=tab-1`);
    expect(await nextText(client, () => true)).toBe('{"method":"Runtime.executionContextsCleared","params":{}}');
    expect(await nextText(client, () => true)).toBe('{"method":"DOM.documentUpdated","params":{}}');
    expect(await nextText(reloaded, (s) => s.startsWith('load '))).toBe('load /__teleport/inspector.js?id=tab-1');
    const cdp2 = await open(`${base}/ws/cdp/tab-1`);
    expect(await nextText(cdp2, () => true)).toBe('{"id":"teleport:Runtime.enable","method":"Runtime.enable"}');
    cdp2.send('{"id":"teleport:Runtime.enable","result":{}}');
    cdp2.send('{"method":"Runtime.executionContextCreated","params":{}}');
    expect(await nextText(client, () => true)).toBe('{"method":"Runtime.executionContextCreated","params":{}}');
    expect(client.readyState).toBe(WebSocket.OPEN);

    for (const ws of [reloaded, client, cdp2]) ws.close();
  });

  it('closes an older page that holds the same tab id with the code that stops its reconnects', async () => {
    const base = `ws://127.0.0.1:${port}`;
    const first = await open(`${base}/ws/target?id=tab-2`);
    const closed = new Promise<number>((resolve) => first.once('close', resolve));
    const second = await open(`${base}/ws/target?id=tab-2`);
    expect(await closed).toBe(4000);
    expect(dev.devices.get('tab-2')?.socket).toBeTruthy();
    second.close();
  });

  it('refuses a DevTools client for an unknown device', async () => {
    const ws = await open(`ws://127.0.0.1:${port}/__teleport/${KEY}/ws/nope`);
    await new Promise((resolve) => ws.once('close', resolve));
  });
});
