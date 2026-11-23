import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KEY } from './keyed.js';
import WebSocket from 'ws';
import type { ServerEvent } from '../src/live.js';
import { startDevServer, type DevServer } from '../src/server.js';

const require = createRequire(import.meta.url);
const ring = require('../../agent/src/ring.js');
const enc = require('../../agent/src/encode.js');
const S = require('../../agent/src/generated/schema.js');

describe('what the server tells the console', () => {
  let dev: DevServer;
  let base: string;
  const events: ServerEvent[] = [];
  const inbox = new Map<WebSocket, string[]>();

  beforeAll(async () => {
    dev = await startDevServer({ port: 0, host: '127.0.0.1', onEvent: (e) => events.push(e) });
    base = `127.0.0.1:${(dev.http.address() as { port: number }).port}`;
  });
  afterAll(() => dev.close());

  const open = async (path: string) => {
    const ws = new WebSocket(`ws://${base}${path}`);
    inbox.set(ws, []);
    ws.on('message', (d: Buffer, binary: boolean) => {
      if (!binary) inbox.get(ws)!.push(d.toString());
    });
    await new Promise((r) => ws.once('open', r));
    return ws;
  };
  const closed = (ws: WebSocket) => new Promise<void>((r) => (ws.readyState === WebSocket.CLOSED ? r() : ws.once('close', () => r())));
  const until = async (fn: () => boolean) => {
    while (!fn()) await new Promise((r) => setTimeout(r, 5));
  };
  const of = <T extends ServerEvent['type']>(type: T) => events.filter((e): e is Extract<ServerEvent, { type: T }> => e.type === type);
  const frame = () => {
    const r = ring.createRing(4, S.S_OVERHEAD_TYPES);
    r.t[ring.ringNext(r)] = 1000;
    const e = enc.createEncoder(256);
    return new Uint8Array(e.buf, 0, enc.encodeFrame(e, [r])).slice();
  };

  it('tells a new tab from a reload, and says when a page goes', async () => {
    const dut = await open('/ws/target?id=ev1&href=http%3A%2F%2Fdevice%2F');
    await until(() => of('page').length === 1);
    expect(of('page')[0]).toMatchObject({ id: 'ev1', kind: 'new', href: 'http://device/' });
    dut.send(frame());
    await until(() => of('sample').length === 1);
    dut.close();
    await until(() => of('gone').length === 1);
    expect(of('gone')[0]).toEqual({ type: 'gone', id: 'ev1', waiting: false });
    const again = await open('/ws/target?id=ev1');
    await until(() => of('page').length === 2);
    expect(of('page')[1]!.kind).toBe('reload');
    again.close();
    await closed(again);
  });

  it('counts DevTools windows as they open and close, and passes on the governor', async () => {
    events.length = 0;
    const dut = await open('/ws/target?id=ev2');
    const devtools = await open(`/__teleport/${KEY}/ws/ev2`);
    await until(() => of('devtools').length === 1);
    expect(of('devtools')[0]).toEqual({ type: 'devtools', id: 'ev2', open: 1 });
    const cdp = await open('/ws/cdp/ev2');
    cdp.send(JSON.stringify({ method: 'teleport.governor', params: { level: 2, reason: 'the JS heap is at 88% of its limit' } }));
    await until(() => of('governor').length === 1);
    expect(of('governor')[0]).toEqual({ type: 'governor', id: 'ev2', level: 2, reason: 'the JS heap is at 88% of its limit' });
    devtools.close();
    await until(() => of('devtools').length === 2);
    expect(of('devtools')[1]!.open).toBe(0);
    dut.close();
    cdp.close();
    await closed(dut);
  });

  it('says what an API call did on the device, who asked, and how it ended', async () => {
    events.length = 0;
    const dut = await open('/ws/target?id=ev3');
    await until(() => dev.devices.has('ev3'));
    // Written over lines, as agents write code: the console shows it on one.
    const asking = fetch(`http://${base}/__teleport/${KEY}/api/eval?id=ev3&expr=${encodeURIComponent('1+\n  1')}`, { method: 'POST', headers: { 'x-teleport': 'q' } });
    await until(() => inbox.get(dut)!.some((s) => s.startsWith('load ')));
    const cdp = await open('/ws/cdp/ev3');
    await until(() => inbox.get(cdp)!.some((s) => s.includes('Runtime.evaluate')));
    const m = JSON.parse(inbox.get(cdp)!.find((s) => s.includes('Runtime.evaluate'))!);
    cdp.send(JSON.stringify({ id: m.id, result: { result: { type: 'number', value: 2 } } }));
    expect(await (await asking).json()).toEqual({ value: 2 });
    const calls = of('call');
    expect(calls.map((c) => [c.phase, c.by, c.what])).toEqual([['start', 'q', 'eval 1+ 1'], ['end', 'q', 'eval 1+ 1']]);
    expect(calls[1]!.error).toBeUndefined();
    expect(calls[1]!.ms).toBeGreaterThanOrEqual(0);
    dut.close();
    cdp.close();
    await closed(dut);
  });
});
