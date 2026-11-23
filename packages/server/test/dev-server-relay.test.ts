import { request } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KEY } from './keyed.js';
import WebSocket from 'ws';
import { startDevServer, type DevServer } from '../src/server.js';

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

const refused = (url: string, headers: Record<string, string> = {}) =>
  new Promise<boolean>((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.once('open', () => (ws.close(), resolve(false)));
    ws.once('error', () => resolve(true));
  });

const nextText = (ws: WebSocket, match: (s: string) => boolean) =>
  new Promise<string>((resolve) => {
    const poll = () => {
      const texts = received.get(ws)!;
      const i = texts.findIndex(match);
      if (i < 0) return void setTimeout(poll, 5);
      resolve(texts.splice(i, 1)[0]!);
    };
    poll();
  });

const status = (port: number, path: string, headers: Record<string, string>) =>
  new Promise<number>((resolve) => {
    request({ host: '127.0.0.1', port, path, headers }, (r) => (r.resume(), resolve(r.statusCode ?? 0))).end();
  });

// An app's own dev server, behind its own tunnel, passes /__teleport/ on to teleport. The device's page
// reaches teleport only through it, so everything the device opens lives under /__teleport/.
describe('a device that reaches teleport through the dev server', () => {
  let s: DevServer;
  let port = 0;
  beforeAll(async () => {
    s = await startDevServer({ port: 0, host: '127.0.0.1' });
    port = (s.http.address() as { port: number }).port;
  });
  afterAll(() => s.close());

  it('connects the page and its inspector under /__teleport/, so DevTools reaches the page', async () => {
    const base = `ws://127.0.0.1:${port}/__teleport`;
    const dut = await open(`${base}/ws/target?id=relayed`);
    const devtools = await open(`ws://127.0.0.1:${port}/__teleport/${KEY}/ws/relayed`);
    devtools.send('{"id":1,"method":"Runtime.evaluate","params":{"expression":"1"}}');
    expect(await nextText(dut, (t) => t.startsWith('load '))).toBe('load /__teleport/inspector.js?id=relayed');
    const inspector = await open(`${base}/ws/cdp/relayed`);
    expect(JSON.parse(await nextText(inspector, (t) => t.includes('Runtime.evaluate')))).toMatchObject({ id: 1 });
    inspector.send('{"id":1,"result":{"result":{"type":"number","value":1}}}');
    expect(JSON.parse(await nextText(devtools, (t) => t.startsWith('{"id":1')))).toMatchObject({ result: { result: { value: 1 } } });
    for (const ws of [dut, devtools, inspector]) ws.close();
  });

  it('opens DevTools only at its own address, never under /__teleport/', async () => {
    const dut = await open(`ws://127.0.0.1:${port}/ws/target?id=narrow`);
    expect(await refused(`ws://127.0.0.1:${port}/__teleport/__teleport/${KEY}/ws/narrow`)).toBe(true);
    dut.close();
  });

  it('keeps DevTools and the API from requests the dev server passes on, which name its port', async () => {
    const dut = await open(`ws://127.0.0.1:${port}/ws/target?id=hop`);
    // A tunnel that rewrites Host to the dev server's local address and adds no forwarded headers,
    // then the dev server's proxy, which keeps the Host it was given.
    const hop = { host: 'localhost:5173' };
    expect(await refused(`ws://127.0.0.1:${port}/__teleport/${KEY}/ws/hop`, hop)).toBe(true);
    expect(await status(port, `/__teleport/${KEY}/api/live`, hop)).toBe(403);
    expect(await status(port, `/__teleport/${KEY}/api/live`, { host: `localhost:${port}` })).toBe(200);
    dut.close();
  });
});
