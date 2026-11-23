import { createServer, request, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KEY } from './keyed.js';
import { gzipSync } from 'node:zlib';
import WebSocket from 'ws';
import { upstreamTls } from '../src/app.js';
import { startDevServer, type DevServer } from '../src/server.js';

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));
}

function get(port: number, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((resolve, reject) => {
    request({ host: '127.0.0.1', port, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    })
      .on('error', reject)
      .end();
  });
}

/** What a tunnel sends: https on its own name, the Host rewritten to the local address. */
const TUNNEL = { host: 'localhost:7070', 'x-forwarded-proto': 'https', 'x-original-host': 'device.tunnel.example' };

describe('proxying an app the device reaches through a tunnel', () => {
  let upstream: Server;
  let up = 0;
  let teleport: DevServer;
  let port = 0;
  beforeAll(async () => {
    upstream = createServer((req, res) => {
      const self = `http://127.0.0.1:${up}`;
      if (req.url === '/') {
        return void res
          .writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "script-src 'nonce-a'" })
          .end(`<html><head><meta http-equiv="Content-Security-Policy" content="script-src 'nonce-a'"></head><body><a href="${self}/next">next</a><img src="http://localhost:${up}/a.png"><a href="${self}0/other">other</a><a href="http://127.0.0.1:${up}.evil.example/">lookalike</a></body></html>`);
      }
      if (req.url === '/app.js') return void res.writeHead(200, { 'content-type': 'application/javascript' }).end(`fetch("${self}/api"); new WebSocket("ws://127.0.0.1:${up}/live");`);
      if (req.url === '/data.json') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ next: `${self}/next` }).replace(/\//g, '\\/'));
      if (req.url === '/launch.json') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ files: [`${self}/runtime.js`] }));
      if (req.url === '/gz') return void res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' }).end(gzipSync('<html><head></head><body>packed</body></html>'));
      if (req.url === '/latin1') return void res.writeHead(200, { 'content-type': 'text/html; charset=iso-8859-1' }).end(Buffer.from([...Buffer.from('<html><head></head><body>caf'), 0xe9, ...Buffer.from('</body></html>')]));
      if (req.url === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        return void res.write(`data: ${self}\n\n`);
      }
      res.writeHead(404).end();
    });
    up = await listen(upstream);
    teleport = await startDevServer({ port: 0, host: '127.0.0.1', app: `http://127.0.0.1:${up}`, manifest: '/launch.json' });
    port = (teleport.http.address() as { port: number }).port;
  });
  afterAll(async () => {
    upstream.closeAllConnections();
    await teleport.close();
    upstream.close();
  });

  it('lists the agent in a launcher manifest, which is how a launcher app gets it', async () => {
    const r = await get(port, '/launch.json', TUNNEL);
    const files = (JSON.parse(r.body.toString()) as { files: string[] }).files;
    expect(files).toEqual(['https://device.tunnel.example/teleport.js', 'https://device.tunnel.example/runtime.js']);
  });

  it("points the app's own addresses in its pages at the address the device used", async () => {
    const html = (await get(port, '/', TUNNEL)).body.toString();
    expect(html).toContain('<a href="https://device.tunnel.example/next">');
    expect(html).toContain('<img src="https://device.tunnel.example/a.png">');
    // Another port and a look-alike host are other sites.
    expect(html).toContain(`<a href="http://127.0.0.1:${up}0/other">`);
    expect(html).toContain(`<a href="http://127.0.0.1:${up}.evil.example/">`);
    const plain = (await get(port, '/', { host: `192.168.1.20:${port}` })).body.toString();
    expect(plain).toContain(`<a href="http://192.168.1.20:${port}/next">`);
  });

  it('does the same in scripts and JSON, sockets and escaped slashes included', async () => {
    expect((await get(port, '/app.js', TUNNEL)).body.toString()).toBe('fetch("https://device.tunnel.example/api"); new WebSocket("wss://device.tunnel.example/live");');
    expect(JSON.parse((await get(port, '/data.json', { ...TUNNEL, 'x-forwarded-host': 'fwd.example' })).body.toString())).toEqual({ next: 'https://fwd.example/next' });
  });

  it('lifts a script policy that would keep the agent out', async () => {
    const res = await get(port, '/', TUNNEL);
    expect(res.headers['content-security-policy']).toBeUndefined();
    expect(res.body.toString()).not.toMatch(/http-equiv="Content-Security-Policy"/i);
  });

  it('injects into a page the app compressed anyway', async () => {
    const res = await get(port, '/gz', TUNNEL);
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.body.toString()).toBe('<html><head><script src="/teleport.js"></script></head><body>packed</body></html>');
  });

  it('keeps every byte of a page that is not UTF-8', async () => {
    const body = (await get(port, '/latin1', TUNNEL)).body;
    expect(body.includes(Buffer.from([0x63, 0x61, 0x66, 0xe9]))).toBe(true);
  });

  it('streams server-sent events as they come', async () => {
    const first = await new Promise<string>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/events', headers: TUNNEL }, (res) => res.once('data', (c: Buffer) => (resolve(c.toString()), req.destroy())));
      req.on('error', reject).end();
    });
    expect(first).toContain('data: ');
  });
});

describe('trusting an https app', () => {
  it("trusts the app's own certificate on this machine, and checks any other", () => {
    expect(upstreamTls(new URL('https://localhost:5173'), false).rejectUnauthorized).toBe(false);
    expect(upstreamTls(new URL('https://127.0.0.1:8443'), false).rejectUnauthorized).toBe(false);
    expect(upstreamTls(new URL('https://staging.example.com'), false).rejectUnauthorized).toBe(true);
    expect(upstreamTls(new URL('https://staging.example.com'), true).rejectUnauthorized).toBe(false);
  });
});

const received = new WeakMap<WebSocket, string[]>();
const open = (url: string, headers: Record<string, string> = {}) =>
  new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    received.set(ws, []);
    ws.on('message', (data: Buffer, isBinary) => {
      if (!isBinary) received.get(ws)!.push(data.toString());
    });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
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
const closed = (ws: WebSocket) => new Promise<void>((resolve) => (ws.readyState === WebSocket.CLOSED ? resolve() : ws.once('close', () => resolve())));

describe('DevTools on a device behind a tunnel', () => {
  let dev: DevServer;
  let base = '';
  beforeAll(async () => {
    dev = await startDevServer({ port: 0, host: '127.0.0.1' });
    base = `ws://127.0.0.1:${(dev.http.address() as { port: number }).port}`;
  });
  afterAll(() => dev.close());

  it('names the inspector by path, so the device loads it from wherever it reached teleport', async () => {
    const target = await open(`${base}/ws/target?id=tun-1`, TUNNEL);
    const client = await open(`${base}/__teleport/${KEY}/ws/tun-1`);
    expect(await nextText(target, (s) => s.startsWith('load '))).toBe('load /__teleport/inspector.js?id=tun-1');
    for (const ws of [target, client]) ws.close();
  });

  it("resumes what DevTools had enabled when the inspector's link drops and it reconnects", async () => {
    const target = await open(`${base}/ws/target?id=tun-2`);
    const client = await open(`${base}/__teleport/${KEY}/ws/tun-2`);
    client.send('{"id":1,"method":"Runtime.enable"}');
    await nextText(target, (s) => s.startsWith('load '));
    const cdp = await open(`${base}/ws/cdp/tun-2`);
    await nextText(cdp, () => true);
    cdp.send('{"id":1,"result":{}}');
    await nextText(client, (s) => s === '{"id":1,"result":{}}');

    cdp.terminate();
    await closed(cdp);
    const again = await open(`${base}/ws/cdp/tun-2`);
    expect(await nextText(client, () => true)).toBe('{"method":"Runtime.executionContextsCleared","params":{}}');
    expect(await nextText(client, () => true)).toBe('{"method":"DOM.documentUpdated","params":{}}');
    expect(await nextText(again, () => true)).toBe('{"id":"teleport:Runtime.enable","method":"Runtime.enable"}');
    again.send('{"method":"Runtime.consoleAPICalled","params":{"type":"log","args":[{"type":"string","value":"back"}]}}');
    expect(await nextText(client, () => true)).toContain('"value":"back"');
    for (const ws of [target, client, again]) ws.close();
  });

  it('also resumes DevTools opened on an inspector an API call had loaded', async () => {
    const target = await open(`${base}/ws/target?id=tun-5`);
    const port = Number(base.split(':')[2]);
    const probing = fetch(`http://127.0.0.1:${port}/__teleport/${KEY}/api/probe?name=dom&id=tun-5`);
    await nextText(target, (s) => s.startsWith('load '));
    const cdp = await open(`${base}/ws/cdp/tun-5`);
    const client = await open(`${base}/__teleport/${KEY}/ws/tun-5`);
    client.send('{"id":1,"method":"Runtime.enable"}');
    await nextText(cdp, (s) => s.includes('"id":1'));

    cdp.terminate();
    await closed(cdp);
    const again = await open(`${base}/ws/cdp/tun-5`);
    expect(await nextText(client, (s) => !s.includes('"error"'))).toBe('{"method":"Runtime.executionContextsCleared","params":{}}');
    expect(await nextText(again, (s) => s.includes('Runtime.enable'))).toBe('{"id":"teleport:Runtime.enable","method":"Runtime.enable"}');
    // The probe its link dropped under fails instead of waiting for an inspector that is gone.
    expect((await probing).status).toBe(502);
    for (const ws of [target, client, again]) ws.close();
  });

  it("tells DevTools the tree changed when the inspector stopped watching it under pressure", async () => {
    const target = await open(`${base}/ws/target?id=tun-7`);
    const client = await open(`${base}/__teleport/${KEY}/ws/tun-7`);
    await nextText(target, (s) => s.startsWith('load '));
    const cdp = await open(`${base}/ws/cdp/tun-7`);
    cdp.send('{"method":"teleport.stale"}');
    expect(await nextText(client, () => true)).toBe('{"method":"DOM.documentUpdated","params":{}}');
    for (const ws of [target, client, cdp]) ws.close();
  });

  it('closes an older inspector socket when the page opens a new one', async () => {
    const target = await open(`${base}/ws/target?id=tun-3`);
    const client = await open(`${base}/__teleport/${KEY}/ws/tun-3`);
    const first = await open(`${base}/ws/cdp/tun-3`);
    const second = await open(`${base}/ws/cdp/tun-3`);
    await closed(first);
    expect(dev.devices.get('tun-3')?.cdp).toBeTruthy();
    client.send('{"id":5,"method":"Runtime.evaluate","params":{"expression":"1"}}');
    expect(await nextText(second, (s) => s.includes('"id":5'))).toContain('Runtime.evaluate');
    for (const ws of [target, client, second]) ws.close();
  });

  it("keeps DevTools and the API from anyone who has the tunnel's address", async () => {
    const target = await open(`${base}/ws/target?id=tun-6`);
    await expect(open(`${base}/__teleport/${KEY}/ws/tun-6`, TUNNEL)).rejects.toThrow();
    const port = base.split(':')[2];
    expect((await get(Number(port), `/__teleport/${KEY}/api/live`, TUNNEL)).status).toBe(403);
    expect((await get(Number(port), `/__teleport/${KEY}/api/live`, { host: `localhost:${port}` })).status).toBe(200);
    target.close();
  });

  it('closes the inspector of a page that left with nobody watching', async () => {
    const target = await open(`${base}/ws/target?id=tun-4`);
    const cdp = await open(`${base}/ws/cdp/tun-4`);
    target.close();
    await closed(cdp);
  });
});
