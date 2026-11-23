import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KEY } from './keyed.js';
import WebSocket from 'ws';
import { startDevServer, type DevServer } from '../src/server.js';

const received = new WeakMap<WebSocket, string[]>();
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
const CONTEXT = '{"method":"Runtime.executionContextCreated","params":{"context":{"id":1}}}';
const cleared = (s: string) => s.includes('Runtime.executionContextsCleared');

describe('a device whose link drops and comes back', () => {
  let s: DevServer;
  let base = '';
  beforeAll(async () => {
    s = await startDevServer({ port: 0, host: '127.0.0.1' });
    base = `ws://127.0.0.1:${(s.http.address() as { port: number }).port}`;
  });
  afterAll(() => s.close());

  /** A page with DevTools open on it, its console enabled and one line logged. */
  async function watched(id: string) {
    const dut = await open(`${base}/ws/target?id=${id}&page=first`);
    const devtools = await open(`${base}/__teleport/${KEY}/ws/${id}`);
    devtools.send('{"id":1,"method":"Runtime.enable"}');
    await next(dut, (t) => t.startsWith('load '));
    const inspector = await open(`${base}/ws/cdp/${id}`);
    await next(inspector, (t) => t.includes('Runtime.enable'));
    inspector.send('{"id":1,"result":{}}');
    inspector.send(CONTEXT);
    inspector.send(log('before'));
    await next(devtools, (t) => t.includes('before'));
    return { dut, devtools, inspector };
  }

  it('keeps DevTools as it was: no page change, nothing replayed, and the page carries on', async () => {
    const { dut, devtools, inspector } = await watched('drop');
    dut.terminate();
    inspector.terminate();
    await quiet();
    const tv2 = await open(`${base}/ws/target?id=drop&page=first`);
    await next(tv2, (t) => t.startsWith('load '));
    // The inspector in the page held on to what DevTools had switched on.
    const inspector2 = await open(`${base}/ws/cdp/drop?kept=1`);
    await quiet();
    expect(texts(inspector2).filter((t) => t.includes('teleport:'))).toEqual([]);
    inspector2.send(log('after'));
    await next(devtools, (t) => t.includes('after'));
    expect(texts(devtools).filter(cleared)).toEqual([]);
    for (const ws of [tv2, devtools, inspector2]) ws.close();
  });

  it('still treats a reload as a new page', async () => {
    const { dut, devtools, inspector } = await watched('reload');
    dut.terminate();
    inspector.terminate();
    await quiet();
    const tv2 = await open(`${base}/ws/target?id=reload&page=second`);
    await next(devtools, cleared);
    for (const ws of [tv2, devtools]) ws.close();
  });

  it('tells an inspector that held on while DevTools closed to let go', async () => {
    const { dut, devtools, inspector } = await watched('closed');
    inspector.terminate();
    devtools.close();
    await quiet();
    const inspector2 = await open(`${base}/ws/cdp/closed?kept=1`);
    await next(inspector2, (t) => t.includes('teleport.detach'));
    for (const ws of [dut, inspector2]) ws.close();
  });
});

describe('DevTools opened again on a page', () => {
  let s: DevServer;
  let base = '';
  beforeAll(async () => {
    s = await startDevServer({ port: 0, host: '127.0.0.1' });
    base = `ws://127.0.0.1:${(s.http.address() as { port: number }).port}`;
  });
  afterAll(() => s.close());

  it("gets the page's console from before, and a line where it went unrecorded", async () => {
    const dut = await open(`${base}/ws/target?id=again&page=one`);
    const first = await open(`${base}/__teleport/${KEY}/ws/again`);
    first.send('{"id":1,"method":"Runtime.enable"}');
    await next(dut, (t) => t.startsWith('load '));
    const inspector = await open(`${base}/ws/cdp/again`);
    await next(inspector, (t) => t.includes('Runtime.enable'));
    inspector.send(CONTEXT);
    inspector.send(log('earlier'));
    await next(first, (t) => t.includes('earlier'));
    first.close();
    await next(inspector, (t) => t.includes('teleport.detach'));

    const second = await open(`${base}/__teleport/${KEY}/ws/again`);
    second.send('{"id":1,"method":"Runtime.enable"}');
    await next(inspector, (t) => t.includes('Runtime.enable'));
    inspector.send(CONTEXT);
    expect(await next(second, () => true)).toBe(CONTEXT);
    expect(await next(second, () => true)).toContain('earlier');
    expect(await next(second, () => true)).toMatch(/DevTools closed/);
    inspector.send(log('now'));
    expect(await next(second, () => true)).toContain('now');

    // A reload starts the console again, as in Chrome.
    dut.close();
    inspector.close();
    await quiet();
    const tv2 = await open(`${base}/ws/target?id=again&page=two`);
    await next(tv2, (t) => t.startsWith('load '));
    const inspector2 = await open(`${base}/ws/cdp/again`);
    inspector2.send(CONTEXT);
    await next(second, (t) => t === CONTEXT);
    await quiet();
    expect(texts(second).filter((t) => t.includes('earlier') || t.includes('now'))).toEqual([]);
    for (const ws of [tv2, second, inspector2]) ws.close();
  });
});
