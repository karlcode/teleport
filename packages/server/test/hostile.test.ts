// What a device, its inspector or a DevTools window may send that nobody meant: an old engine's odd
// JSON, a message cut by a dropped link, another machine on the network. teleport ends on any
// exception nobody caught, so each of these once took every device and DevTools window with it.
// Here it must cost nothing: every message is refused by a check where it is read, which the count
// of messages only the last-resort boundary caught (`unread`) holds at zero.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { KEY } from './keyed.js';
import type { DeviceStats, ServerEvent } from '../src/live.js';
import { request } from '../src/q.js';
import { startDevServer, type DevServer, type DevServerOptions } from '../src/server.js';

let server: DevServer | null = null;
afterEach(() => server?.close());

async function start(o: Partial<DevServerOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tlpt-hostile-'));
  writeFileSync(join(dir, 'index.html'), '<html><head></head><body></body></html>');
  writeFileSync(join(dir, 'a.js'), '1');
  server = await startDevServer({ port: 0, host: '127.0.0.1', app: dir, ...o });
  const port = (server.http.address() as { port: number }).port;
  return { port, at: `127.0.0.1:${port}` };
}
const open = (url: string, headers: Record<string, string> = {}) =>
  new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.on('error', () => {});
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
/** Whatever was sent has been read once the server answers something sent after it. */
const settled = async (ws: WebSocket) => {
  await new Promise<void>((r) => (ws.readyState === 1 ? ws.ping(undefined, undefined, () => r()) : r()));
  await new Promise((r) => setTimeout(r, 30));
};
const stats = async (port: number, id: string) => ((await request(port, 'live')) as { device: { id: string }; stats: DeviceStats }[]).find((d) => d.device.id === id)!.stats;

/** The same odd input on every run. */
function dice(seed: number) {
  const next = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  return { next, pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]! };
}

describe('what a device sends that nobody meant', () => {
  it('reads odd frames and lines from the agent as bad ones, and stays up', async () => {
    const { port, at } = await start();
    const d = dice(7);
    const dut = await open(`ws://${at}/ws/target?id=odd&page=p&e=1&href=${encodeURIComponent('http://x/')}`);
    for (let i = 0; i < 1500; i++) dut.send(Buffer.from(Array.from({ length: Math.floor(d.next() * 200) }, () => Math.floor(d.next() * 256))));
    const lines = ['name', 'name ', 'name x', 'name -1 a', 'name NaN a', 'name 1e9 a', 'name 4294967294 big', 'name 3 /ok.js', 'pong', 'pong x y', 'pong 1e999 -1e999', 'err', 'err [', 'err []', 'err [0]', 'err [0,0,"e"]', 'err [1,0,"e",5,{},[],null,7]', 'errs', 'errs x', 'errs 1e999', 'val', 'val ', 'val x', 'val x {', 'thr', 'thr x', '', ' ', '\u0000', 'x'.repeat(100_000)];
    for (const l of lines) dut.send(l);
    await settled(dut);
    const s = await stats(port, 'odd');
    expect(s.badFrames).toBeGreaterThan(1000);
    expect(s.unread).toBe(0);
    // A name's number past any table the agent keeps doesn't make the laptop's list that long.
    expect(s.names).toBe(4);
    dut.close();
  });

  it("follows no inspector or DevTools message it can't, and stays up", async () => {
    const { port, at } = await start();
    const d = dice(11);
    const dut = await open(`ws://${at}/ws/target?id=odd&page=p&href=${encodeURIComponent('http://x/')}`);
    const devtools = await open(`ws://${at}/__teleport/${KEY}/ws/odd`);
    const inspector = await open(`ws://${at}/ws/cdp/odd`);
    for (const method of ['DOM.enable', 'CSS.enable', 'Network.enable', 'Runtime.enable', 'DOM.getDocument']) devtools.send(JSON.stringify({ id: Math.floor(d.next() * 1e6), method, params: {} }));
    await settled(devtools);

    // Every method the laptop's side names, with arguments of every wrong shape, as a call, a reply and both.
    const src = ['devtools.ts', 'mirror.ts', 'expand.ts', 'server.ts', 'cdp.ts'].map((f) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')).join('\n');
    const methods = [...new Set([...src.matchAll(/'((?:teleport|DOM|CSS|Runtime|Network|Page|Overlay|Tracing)\.[A-Za-z]+)'/g)].map((m) => m[1]!))];
    expect(methods.length).toBeGreaterThan(30);
    const shapes = [undefined, null, 0, -1, 1.5, 1e308, 'x', true, [], {}, [null], [[]], [[1, 2, 3]], [['k', 1, [[2, 1, 'DIV', [], 0]]]], { nodeId: 1 }, { root: null }, { root: 5 }, { root: {} }, { root: [1, 9, 'u', 'c', [null, 5, {}]] }, { ops: 5 }, { ops: [5] }, { ops: [['k']] }, { ops: [['k', 1, 5]] }, { ops: [10, 1, 1, 1, 1] }, { nodeIds: [1, 'x', null, {}] }, { nodeId: 'x' }, { t: 'x' }, { id: {} }, { level: 'x', reason: {} }, { args: [5, null, {}] }, { requestId: {} }, { teleportOps: [[1]] }];
    for (const method of methods) {
      for (const v of shapes) {
        const id = d.pick([undefined, 1, -1, -2, 'q:1', 'resync', {}]);
        for (const m of [{ id, method, params: v }, { id, result: v }, { id, method, result: v, params: v }]) inspector.send(JSON.stringify(m));
      }
    }
    // The short forms: arrays of whatever.
    const atoms = [0, 1, 2, 3, 4, 5, 10, 11, 12, -1, 1.5, 'a', '', null, true, [], {}, [1], ['a', 1]];
    for (let i = 0; i < 4000; i++) inspector.send(JSON.stringify([d.pick([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 20, 'x']), ...Array.from({ length: Math.floor(d.next() * 9) }, () => d.pick(atoms))]));
    for (const raw of ['5', 'null', '"x"', 'true', '[]', '{}', '{', 'x', '[[[[[[[[[[]]]]]]]]]]', '{"teleport":"gap","lost":1e308}', '{"teleport":"ack","got":"x"}', '{"teleport":5}']) inspector.send(raw);
    await settled(inspector);

    // And DevTools' own side, which only this machine reaches: still not a way to end the process.
    for (const raw of ['{"id":1,"method":5}', '{"id":1,"method":{"match":1}}', '5', 'null', '[]', '"x"', '{"id":1,"method":"Network.getResponseBody","params":5}', '{"id":2,"method":"DOM.getDocument","params":5}', '{"id":3,"method":"DOM.requestChildNodes","params":{"nodeId":{},"depth":"x"}}', '{"id":4,"method":"DOM.pushNodesByBackendIdsToFrontend","params":{"backendNodeIds":5}}', '{"id":5,"method":"Tracing.end"}', '{"id":6,"method":"Tracing.start","params":null}']) devtools.send(raw);
    await settled(devtools);

    expect((await stats(port, 'odd')).unread).toBe(0);
    for (const ws of [dut, devtools, inspector]) ws.close();
  });

  it('drops a message it throws on, counts it, and carries on with the next', async () => {
    // What no check foresaw, stood in for by an embedding app whose own listener throws.
    const heard: ServerEvent['type'][] = [];
    let bomb = true;
    const { port, at } = await start({
      onEvent: (e) => {
        heard.push(e.type);
        if (e.type === 'errors' && bomb) throw new Error('nobody foresaw this');
      },
    });
    const dut = await open(`ws://${at}/ws/target?id=thrower&page=p&href=${encodeURIComponent('http://x/')}`);
    dut.send(`errs 3`);
    dut.send(`errs 4`);
    await settled(dut);
    expect((await stats(port, 'thrower')).unread).toBe(2);
    bomb = false;
    dut.send(`errs 5`);
    await settled(dut);
    expect(heard.filter((t) => t === 'errors')).toHaveLength(3);
    expect((await stats(port, 'thrower')).unread).toBe(2);
    const devtools = await open(`ws://${at}/__teleport/${KEY}/ws/thrower`);
    const answers: string[] = [];
    devtools.on('message', (m: Buffer) => answers.push(m.toString()));
    // A DevTools request teleport can't follow is answered as failed, so DevTools doesn't wait on it.
    server!.devices.get('thrower')!.bridge.fromClient = () => {
      throw new Error('nobody foresaw this');
    };
    devtools.send('{"id":41,"method":"DOM.getDocument"}');
    await settled(devtools);
    expect(answers).toContain(JSON.stringify({ id: 41, error: { code: -32603, message: "teleport couldn't follow this request" } }));
    expect((await stats(port, 'thrower')).unread).toBe(3);
    for (const ws of [dut, devtools]) ws.close();
  });
});

describe('questions and requests', () => {
  it('runs an expression of any length: it travels in the body, not the address', async () => {
    const { port, at } = await start();
    const dut = await open(`ws://${at}/ws/target?id=long&page=p&e=1`);
    const asked: number[] = [];
    dut.on('message', (m: Buffer, binary) => {
      const s = m.toString();
      if (binary || !s.startsWith('eval ')) return;
      const [, id, , ...src] = s.split(' ');
      asked.push(src.join(' ').length);
      dut.send(`val ${id} ${src.join(' ').length}`);
    });
    // 150 KB with spaces and newlines: as a URL it was three times that, and refused at 16 KB.
    const expr = '"' + 'a b\n'.repeat(37_500) + '".length';
    expect(await request(port, 'eval', { body: { expr }, id: 'long' })).toEqual({ value: expr.length });
    expect(asked).toEqual([expr.length]);
    // The address still works for a short one, as a script with curl would send it.
    const r = await fetch(`http://${at}/__teleport/${KEY}/api/eval?id=long&expr=1%2B1`, { method: 'POST' });
    expect(await r.json()).toEqual({ value: 3 });
    dut.close();
  });

  it("gives each device its own requests where several share an address, by browser", async () => {
    const { port, at } = await start();
    const get = (path: string, ua: string) => new Promise<void>((done) => void httpRequest({ host: '127.0.0.1', port, path, headers: { 'user-agent': ua } }, (res) => res.resume().on('end', done)).end());
    const a = await open(`ws://${at}/ws/target?id=dev-a`, { 'user-agent': 'DEV-A' });
    const b = await open(`ws://${at}/ws/target?id=dev-b`, { 'user-agent': 'DEV-B' });
    await get('/a.js?from=a', 'DEV-A');
    await get('/a.js?from=b', 'DEV-B');
    // A device's own media player asks in its own name: no device's browser, so each device is shown it.
    await get('/a.js?from=player', 'Player/1.0');
    const urls = async (id: string) => ((await request(port, 'network', { id })) as { url: string }[]).map((r) => r.url.split('=')[1]);
    expect(await urls('dev-a')).toEqual(['a', 'player']);
    expect(await urls('dev-b')).toEqual(['b', 'player']);
    for (const ws of [a, b]) ws.close();
  });
});
