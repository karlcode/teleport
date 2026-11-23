import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KEY } from './keyed.js';
import WebSocket from 'ws';
import { startDevServer, type DevServer } from '../src/server.js';

const require = createRequire(import.meta.url);
const ring = require('../../agent/src/ring.js');
const enc = require('../../agent/src/encode.js');
const S = require('../../agent/src/generated/schema.js');

const received = new WeakMap<WebSocket, string[]>();
const arrived = new WeakMap<WebSocket, number>();
const open = (url: string) =>
  new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url);
    received.set(ws, []);
    ws.on('message', (data: Buffer, isBinary) => {
      if (isBinary) return;
      const t = data.toString();
      received.get(ws)!.push(t);
      if (!t.startsWith('{"teleport":')) arrived.set(ws, (arrived.get(ws) ?? 0) + 1);
    });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
const texts = (ws: WebSocket) => received.get(ws)!;
const next = (ws: WebSocket, match: (s: string) => boolean) =>
  new Promise<string>((resolve, reject) => {
    const end = Date.now() + 3000;
    const poll = () => {
      const i = texts(ws).findIndex(match);
      if (i >= 0) return resolve(texts(ws).splice(i, 1)[0]!);
      if (Date.now() > end) return reject(new Error(`timed out; got ${JSON.stringify(texts(ws))}`));
      setTimeout(poll, 5);
    };
    poll();
  });
const quiet = () => new Promise((r) => setTimeout(r, 200));
const log = (text: string) => JSON.stringify({ method: 'Runtime.consoleAPICalled', params: { type: 'log', args: [{ type: 'string', value: text }], executionContextId: 1, timestamp: 1 } });
/** Application messages a link client got: control messages aren't counted. */
const counted = (ws: WebSocket) => arrived.get(ws) ?? 0;

describe('links that outlive their sockets', () => {
  let s: DevServer;
  let base = '';
  beforeAll(async () => {
    s = await startDevServer({ port: 0, host: '127.0.0.1' });
    base = `ws://127.0.0.1:${(s.http.address() as { port: number }).port}`;
  });
  afterAll(() => s.close());

  it('keep a DevTools open on a tab teleport does not know yet, and join it when it connects', async () => {
    const devtools = await open(`${base}/__teleport/${KEY}/ws/later?link=dtlater0001&got=0`);
    expect(JSON.parse(await next(devtools, (t) => t.includes('"link"')))).toEqual({ teleport: 'link', got: 0, kept: false });
    await next(devtools, (t) => t === '{"teleport":"away"}');
    devtools.send('{"id":1,"method":"Runtime.enable"}');
    const dut = await open(`${base}/ws/target?id=later&page=one`);
    await next(dut, (t) => t.startsWith('load '));
    const inspector = await open(`${base}/ws/cdp/later?link=inlater0001&got=0`);
    await next(inspector, (t) => t.includes('Runtime.enable'));
    inspector.send('{"id":1,"result":{}}');
    expect(await next(devtools, (t) => t.startsWith('{"id":1'))).toBe('{"id":1,"result":{}}');
    await next(devtools, (t) => t === '{"teleport":"here"}');
    for (const ws of [dut, devtools, inspector]) ws.close();
  });

  it('still tell a DevTools without the protocol that there is no such tab', async () => {
    const ws = await open(`${base}/__teleport/${KEY}/ws/nowhere`);
    const code = await new Promise((resolve) => ws.once('close', resolve));
    expect(code).toBe(1008);
  });

  async function watched(id: string) {
    const dut = await open(`${base}/ws/target?id=${id}&page=first`);
    const devtools = await open(`${base}/__teleport/${KEY}/ws/${id}?link=dt${id}00001&got=0`);
    devtools.send('{"id":1,"method":"Runtime.enable"}');
    await next(dut, (t) => t.startsWith('load '));
    const inspector = await open(`${base}/ws/cdp/${id}?link=in${id}00001&got=0`);
    await next(inspector, (t) => t.includes('Runtime.enable'));
    inspector.send('{"id":1,"result":{}}');
    inspector.send(log('before'));
    await next(devtools, (t) => t.includes('before'));
    return { dut, devtools, inspector };
  }

  it('give a DevTools whose socket dropped what it missed, once, on its next socket', async () => {
    const { dut, devtools, inspector } = await watched('dtdrop');
    const got = counted(devtools);
    devtools.terminate();
    await quiet();
    inspector.send(log('while away'));
    await quiet();
    const back = await open(`${base}/__teleport/${KEY}/ws/dtdrop?link=dtdtdrop00001&got=${got}`);
    expect(JSON.parse(await next(back, (t) => t.includes('"link"')))).toMatchObject({ teleport: 'link', kept: true });
    await next(back, (t) => t.includes('while away'));
    inspector.send(log('after'));
    await next(back, (t) => t.includes('after'));
    expect(texts(back).filter((t) => t.includes('before') || t.includes('while away'))).toEqual([]);
    expect(texts(back).filter((t) => t.includes('executionContextsCleared'))).toEqual([]);
    for (const ws of [dut, back, inspector]) ws.close();
  });

  it('take several messages an inspector sent as one, a line each, counted once', async () => {
    const { dut, devtools, inspector } = await watched('batch');
    inspector.send([log('one'), log('two'), log('three')].join('\n'));
    await next(devtools, (t) => t.includes('"one"'));
    await next(devtools, (t) => t.includes('"two"'));
    await next(devtools, (t) => t.includes('"three"'));
    const ack = JSON.parse(await next(inspector, (t) => t.startsWith('{"teleport":"ack"')));
    // Runtime.enable's reply, 'before', and the batch.
    expect(ack.got).toBe(3);
    for (const ws of [dut, devtools, inspector]) ws.close();
  });

  it('answer the requests an inspector missed while its socket was down, instead of failing them', async () => {
    const { dut, devtools, inspector } = await watched('indrop');
    const got = counted(inspector);
    inspector.terminate();
    await quiet();
    devtools.send('{"id":7,"method":"Runtime.evaluate","params":{"expression":"1+1"}}');
    await quiet();
    const back = await open(`${base}/ws/cdp/indrop?link=inindrop00001&got=${got}&kept=1`);
    expect(JSON.parse(await next(back, (t) => t.includes('"link"')))).toMatchObject({ teleport: 'link', kept: true });
    await next(back, (t) => t.includes('"id":7'));
    back.send('{"id":7,"result":{"result":{"type":"number","value":2}}}');
    const reply = JSON.parse(await next(devtools, (t) => t.startsWith('{"id":7')));
    expect(reply.result.result.value).toBe(2);
    for (const ws of [dut, devtools, back]) ws.close();
  });

  it('let a page back on a new link carry on in its session, told what the session holds', async () => {
    const rings = S.STREAM_TYPES.map((t: number[]) => ring.createRing(64, t));
    const e = enc.createEncoder(16384);
    const tick = (t: number) => {
      const r = rings[S.S_LAG];
      const i = ring.ringNext(r);
      r.t[i] = t;
      r.cols[0][i] = t / 100;
    };
    const frame = () => new Uint8Array(e.buf, 0, enc.encodeFrame(e, rings)).slice();
    const dut = await open(`${base}/ws/target?id=resume&page=p1`);
    await next(dut, (t) => t === 'resume');
    for (let k = 1; k <= 3; k++) tick(k * 1000);
    dut.send(frame());
    await quiet();
    // The fourth record goes into a socket that is already dead.
    tick(4000);
    dut.send(frame());
    dut.terminate();
    await quiet();
    const session = s.devices.get('resume') ?? null;
    expect(session).toBeNull();
    const back = await open(`${base}/ws/target?id=resume&page=p1`);
    const holds = (await next(back, (t) => t.startsWith('resume'))).split(' ').slice(1).map(Number);
    const lag = rings[S.S_LAG];
    expect(holds[S.S_LAG]).toBeLessThanOrEqual(lag.total);
    // The agent rewinds to what the server holds and sends again; the server takes each record once.
    lag.unsent = lag.total - holds[S.S_LAG]!;
    tick(5000);
    back.send(frame());
    await quiet();
    const d = s.devices.get('resume')!;
    expect(Array.from(d.session.timeline.lag!.t!)).toEqual([1000, 2000, 3000, 4000, 5000]);
    expect(d.session.meta.relinks).toBe(1);
    back.close();
  });

  it('start a page that comes back as another page in a new session', async () => {
    const dut = await open(`${base}/ws/target?id=fresh&page=a`);
    await next(dut, (t) => t === 'resume');
    const first = s.devices.get('fresh')!.session;
    dut.terminate();
    await quiet();
    const reloaded = await open(`${base}/ws/target?id=fresh&page=b`);
    await next(reloaded, (t) => t === 'resume');
    expect(s.devices.get('fresh')!.session).not.toBe(first);
    reloaded.close();
  });
});
