import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KEY } from './keyed.js';
import WebSocket from 'ws';
import type { Point } from '../src/live.js';
import { startDevServer, type DevServer } from '../src/server.js';

const require = createRequire(import.meta.url);
const ring = require('../../agent/src/ring.js');
const enc = require('../../agent/src/encode.js');
const S = require('../../agent/src/generated/schema.js');

const OFFSET = 5000;
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

const next = (ws: WebSocket, match: (s: string) => boolean) =>
  new Promise<string>((resolve) => {
    const poll = () => {
      const texts = received.get(ws)!;
      const i = texts.findIndex(match);
      if (i < 0) return void setTimeout(poll, 5);
      resolve(texts.splice(0, i + 1)[i]!);
    };
    poll();
  });
const nextJson = async (ws: WebSocket, match: (m: any) => boolean) => JSON.parse(await next(ws, (s) => s.startsWith('{') && match(JSON.parse(s))));

/** A fake agent: answers pings with a clock OFFSET ms ahead of the server and sends frames. */
function fakeAgent(ws: WebSocket) {
  const rings = S.STREAM_TYPES.map((types: number[]) => ring.createRing(256, types));
  const e = enc.createEncoder(8192);
  const now = () => performance.timeOrigin + performance.now() + OFFSET;
  ws.on('message', (data: Buffer, isBinary) => {
    const s = data.toString();
    if (!isBinary && s.startsWith('ping ')) ws.send(`pong ${s.slice(5)} ${now()}`);
  });
  return {
    rings,
    now,
    push(stream: number, t: number, ...cols: number[]) {
      const r = rings[stream];
      const i = ring.ringNext(r);
      r.t[i] = t;
      cols.forEach((v, c) => (r.cols[c][i] = v));
    },
    flush() {
      ws.send(new Uint8Array(e.buf, 0, enc.encodeFrame(e, rings)).slice());
    },
  };
}

interface Snapshot {
  device: { id: string; href: string; inspecting: boolean };
  latest: Point | null;
  points: Point[];
  keyTargets: { target: string; keys: number; p50Ms: number }[];
  stats: { frames: number; names: number; offsetMs: number };
  requests: { url: string; status: number }[];
}

describe('the API a shell or an agent asks', () => {
  let dev: DevServer;
  let base: string;
  const seen: string[] = [];

  beforeAll(async () => {
    const app = mkdtempSync(join(tmpdir(), 'teleport-app-'));
    writeFileSync(join(app, 'index.html'), '<!doctype html><html><head></head><body>device</body></html>');
    writeFileSync(join(app, 'data.json'), '{"rails":3}');
    dev = await startDevServer({ port: 0, host: '127.0.0.1', app, onDevice: (d) => seen.push(d.id) });
    base = `127.0.0.1:${(dev.http.address() as { port: number }).port}`;
  });
  afterAll(() => dev.close());

  const get = async <T>(path: string): Promise<T> => (await fetch(`http://${base}/__teleport/${KEY}/api/${path}`)).json() as Promise<T>;
  const post = (path: string) => fetch(`http://${base}/__teleport/${KEY}/api/${path}`, { method: 'POST', headers: { 'x-teleport': 'test' } });
  const until = async <T>(fn: () => Promise<T | null | undefined>): Promise<T> => {
    for (;;) {
      const v = await fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  it('turns the frames an agent sends into samples, captures, requests and DevTools network events', async () => {
    await fetch(`http://${base}/`);
    await fetch(`http://${base}/data.json`);
    const dut = await open(`ws://${base}/ws/target?id=api-1&href=${encodeURIComponent(`http://${base}/`)}`);
    const agent = fakeAgent(dut);
    await until(async () => (await get<{ device: { id: string } }[]>('live')).find((d) => d.device.id === 'api-1'));
    expect(seen).toContain('api-1');
    expect((await fetch(`http://${base}/__teleport/${KEY}/api/device?id=nope`)).status).toBe(404);

    dut.send(`name 0 http://${base}/data.json`);
    dut.send('name 1 div.tile in #rail');
    agent.push(S.S_OVERHEAD, agent.now(), 2, 1000);
    agent.push(S.S_LAG, agent.now(), 3);
    agent.push(S.S_LONGTASK, agent.now() - 100, 80);
    agent.push(S.S_RESOURCE, agent.now() - 50, 40, 12, 11, 0, 6);
    agent.push(S.S_INPUT, agent.now() - 30, 39, 14);
    agent.push(S.S_KEYTARGET, agent.now() - 30, 1);
    agent.flush();
    const snap = await until(async () => {
      const s = await get<Snapshot>('device?id=api-1&seconds=5');
      return s.latest ? s : null;
    });
    expect(snap.latest).toMatchObject({ overheadPct: 0.2, lagMs: 3, longTasks: 1, longTaskMs: 80, resources: 1, keys: 1, keyToFrameMs: 14, fps: null });
    expect(snap.points).toHaveLength(1);
    expect(snap.keyTargets).toEqual([expect.objectContaining({ target: 'div.tile in #rail', keys: 1, p50Ms: 14 })]);
    expect(snap.stats).toMatchObject({ frames: 1, names: 2 });
    expect(snap.requests.map((r) => r.url)).toEqual([`http://${base}/`, `http://${base}/data.json`]);
    // The clock offset settles from the ping burst.
    await new Promise((r) => setTimeout(r, 600));
    const offset = dev.devices.get('api-1')!.session.meta.offsetMs;
    expect(offset).toBeGreaterThan(OFFSET - 50);
    expect(offset).toBeLessThan(OFFSET + 50);

    // A capture: the agent records frames for the window; the laptop reports on it.
    const capturing = post('capture?id=api-1&ms=500');
    expect(await next(dut, (s) => s.startsWith('capture '))).toBe('capture 500');
    const t0 = agent.now();
    for (let i = 0; i < 20; i++) agent.push(S.S_FRAME, t0 + 10 + i * 16);
    agent.push(S.S_INPUT, t0 + 20, 39, 12, 3);
    agent.flush();
    const report = (await (await capturing).json()) as { frames: { count: number; p50Ms: number }; input: { keys: number; p50Ms: number } };
    expect(report.frames).toMatchObject({ count: 20, p50Ms: 16 });
    expect(report.input).toMatchObject({ keys: 1, p50Ms: 12 });

    // Requests, filtered, on the page's clock.
    const slow = await get<{ url: string; durMs: number; ttfbMs: number }[]>('network?id=api-1&url=data.json');
    expect(slow).toHaveLength(1);
    expect(slow[0]).toMatchObject({ url: `http://${base}/data.json` });
    expect(slow[0]!.durMs).toBeGreaterThanOrEqual(0);

    // DevTools' Network panel gets the same requests, with bodies, as CDP events.
    const client = await open(`ws://${base}/__teleport/${KEY}/ws/api-1`);
    client.send(JSON.stringify({ id: 1, method: 'Network.enable' }));
    const sent = await nextJson(client, (m) => m.method === 'Network.requestWillBeSent' && m.params.request.url.endsWith('/data.json'));
    const agentClockS = (performance.timeOrigin + performance.now() + OFFSET) / 1000;
    expect(Math.abs(sent.params.timestamp - agentClockS)).toBeLessThan(5);
    const resp = await nextJson(client, (m) => m.method === 'Network.responseReceived' && m.params.requestId === sent.params.requestId);
    expect(resp.params.response).toMatchObject({ status: 200, mimeType: 'application/json' });
    client.send(JSON.stringify({ id: 2, method: 'Network.getResponseBody', params: { requestId: sent.params.requestId } }));
    expect((await nextJson(client, (m) => m.id === 2)).result).toEqual({ body: '{"rails":3}', base64Encoded: false });
    await fetch(`http://${base}/data.json?live`);
    const live = await nextJson(client, (m) => m.method === 'Network.requestWillBeSent' && m.params.request.url.endsWith('?live'));
    expect(live.params.requestId).toMatch(/^p/);
    expect((await get<Snapshot>('device?id=api-1')).device.inspecting).toBe(true);

    client.close();
    dut.close();
  }, 15_000);

  it('answers a capture with what it recorded when the device goes away during it', async () => {
    const dut = await open(`ws://${base}/ws/target?id=api-3`);
    await until(async () => (await get<{ device: { id: string } }[]>('live')).find((d) => d.device.id === 'api-3'));
    const capturing = post('capture?id=api-3&ms=500');
    await next(dut, (s) => s.startsWith('capture '));
    const t0 = Date.now();
    dut.close();
    const res = await capturing;
    expect(res.status).toBe(200);
    // At once, covering the part recorded, and saying it was cut short.
    expect(Date.now() - t0).toBeLessThan(400);
    const r = (await res.json()) as { seconds: number; cutShort?: { askedS: number; why: string } };
    expect(r.cutShort).toEqual({ askedS: 0.5, why: 'the page went away' });
    expect(r.seconds).toBeLessThan(0.5);
  }, 10_000);

  it('answers 404 with no device, 405 where it takes a POST, and nothing without the key', async () => {
    expect((await fetch(`http://${base}/__teleport/${KEY}/api/device`)).status).toBe(404);
    const dut = await open(`ws://${base}/ws/target?id=api-2`);
    await until(async () => (await get<{ device: { id: string } }[]>('live')).find((d) => d.device.id === 'api-2'));
    expect((await fetch(`http://${base}/__teleport/api/capture?id=api-2`, { method: 'POST', headers: { 'x-teleport': 'q' } })).status).toBe(403);
    expect((await fetch(`http://${base}/__teleport/${KEY}/api/capture?id=api-2`)).status).toBe(405);
    expect((await fetch(`http://${base}/__teleport/${KEY}/api/nope?id=api-2`, { method: 'POST', headers: { 'x-teleport': 'x' } })).status).toBe(404);
    dut.close();
  });
});

describe('a question to a page whose agent answers it', () => {
  let server: DevServer;
  let base: string;
  beforeAll(async () => {
    server = await startDevServer({ port: 0, host: '127.0.0.1', app: mkdtempSync(join(tmpdir(), 'teleport-ask-')) });
    base = `127.0.0.1:${(server.http.address() as { port: number }).port}`;
  });
  afterAll(() => server.close());
  const ask = (id: string, expr: string) => fetch(`http://${base}/__teleport/${KEY}/api/eval?id=${id}&expr=${encodeURIComponent(expr)}`, { method: 'POST', headers: { 'x-teleport': 'test' } }).then((r) => r.json() as Promise<{ value?: unknown; error?: string }>);

  it('goes over the agent\'s own socket, and no inspector is loaded for it', async () => {
    const dut = await open(`ws://${base}/ws/target?id=ask-1&e=1`);
    const answer = ask('ask-1', 'document.title\n+ "!"');
    const line = await next(dut, (s) => s.startsWith('eval '));
    const [, id, wait, source] = /^eval (\S+) ([01]) ([\s\S]*)$/.exec(line)!;
    expect(wait).toBe('0');
    expect(source).toBe('document.title\n+ "!"');
    dut.send(`val ${id} {"title":"Home","n":[1,2]}`);
    expect(await answer).toEqual({ value: { title: 'Home', n: [1, 2] } });
    expect(received.get(dut)!.some((s) => s.startsWith('load '))).toBe(false);
    dut.close();
  });

  it('gives what the page threw, an empty answer as no value, and says when the page went away', async () => {
    const dut = await open(`ws://${base}/ws/target?id=ask-2&e=1`);
    const reply = async (text: (id: string) => string) => {
      const line = await next(dut, (s) => s.startsWith('eval '));
      dut.send(text(line.split(' ')[1]!));
    };
    let answer = ask('ask-2', 'nope');
    await reply((id) => `thr ${id} ReferenceError: nope is not defined`);
    expect(await answer).toEqual({ error: 'eval: ReferenceError: nope is not defined' });
    answer = ask('ask-2', 'throw 1');
    await reply((id) => `thr ${id} `);
    expect(await answer).toEqual({ error: 'eval: the page threw' });
    answer = ask('ask-2', 'undefined');
    await reply((id) => `val ${id} `);
    expect(await answer).toEqual({});
    // An answer to a question nobody is waiting on, or one that isn't JSON, harms nothing.
    dut.send('val zz 1');
    answer = ask('ask-2', '1');
    await reply((id) => `val ${id} {not json`);
    expect((await answer).error).toMatch(/wasn't JSON/);
    answer = ask('ask-2', 'location.reload()');
    await next(dut, (s) => s.startsWith('eval '));
    dut.close();
    expect((await answer).error).toMatch(/went away/);
  });

  it('asks again when the same page comes back on a new link, and gives up when another page does', async () => {
    let dut = await open(`ws://${base}/ws/target?id=ask-4&page=one&e=1`);
    const answer = ask('ask-4', '6*7');
    const line = await next(dut, (s) => s.startsWith('eval '));
    // The link drops before the answer got through.
    dut.terminate();
    dut = await open(`ws://${base}/ws/target?id=ask-4&page=one&e=1`);
    expect(await next(dut, (s) => s.startsWith('eval '))).toBe(line);
    // The agent answers from what it kept; an answer that arrives twice is taken once.
    dut.send(`val ${line.split(' ')[1]} 42`);
    dut.send(`val ${line.split(' ')[1]} 42`);
    expect(await answer).toEqual({ value: 42 });
    // Asked while the link is down: it waits, and goes when the page is back.
    dut.terminate();
    await new Promise((r) => setTimeout(r, 30));
    const waited = ask('ask-4', '"while away"');
    await new Promise((r) => setTimeout(r, 30));
    dut = await open(`ws://${base}/ws/target?id=ask-4&page=one&e=1`);
    const late = await next(dut, (s) => s.startsWith('eval '));
    expect(late).toContain('"while away"');
    dut.send(`val ${late.split(' ')[1]} "ok"`);
    expect(await waited).toEqual({ value: 'ok' });
    const lost = ask('ask-4', '1');
    await next(dut, (s) => s.startsWith('eval '));
    dut.terminate();
    const other = await open(`ws://${base}/ws/target?id=ask-4&page=two&e=1`);
    expect((await lost).error).toMatch(/went away/);
    expect(received.get(other)!.some((s) => s.startsWith('eval '))).toBe(false);
    other.close();
  });

  it('still asks through the inspector of an agent that can\'t answer', async () => {
    const dut = await open(`ws://${base}/ws/target?id=ask-3`);
    void ask('ask-3', '1').catch(() => {});
    expect(await next(dut, (s) => s.startsWith('load ') || s.startsWith('eval '))).toMatch(/^load .*inspector\.js/);
    dut.close();
  });
});

describe('styles: the laptop reads only what the device could fetch through teleport', () => {
  let server: DevServer;
  let base: string;
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'teleport-styles-'));
    writeFileSync(join(dir, 'a.css'), '.a { color: red }\n.b:nope { frob: 1 }');
    server = await startDevServer({ port: 0, host: '127.0.0.1', app: dir });
    base = `127.0.0.1:${(server.http.address() as { port: number }).port}`;
  });
  afterAll(() => server.close());

  it("reads the app's own sheet by path, and neither another address nor teleport's own routes, whatever the device names", async () => {
    const dut = await open(`ws://${base}/ws/target?id=styles-1&e=1`);
    const report = fetch(`http://${base}/__teleport/${KEY}/api/styles?id=styles-1`, { headers: { 'x-teleport': 'test' } }).then((r) => r.json() as Promise<Record<string, any>>);
    const named = [`http://${base}/a.css?v=2`, 0, 2, 'http://127.0.0.1:1/secret', 0, 1, `http://${base}/__teleport/${KEY}/api/live`, 0, 1, 'http://169.254.169.254/latest/meta-data', 0, -1];
    let asked = await next(dut, (s) => s.startsWith('eval '));
    dut.send(`val ${asked.split(' ')[1]} ${JSON.stringify(named)}`);
    asked = await next(dut, (s) => s.startsWith('eval '));
    // Only a.css was read: its two selectors and two declarations are all the device is asked about.
    expect(asked).toContain('[".a",".b:nope"]');
    expect(asked).toContain('["color","red","frob","1"]');
    expect(asked).not.toMatch(/devices|meta-data|secret/);
    dut.send(`val ${asked.split(' ')[1]} [1,-2,1,0]`);
    const r = await report;
    expect(r).toMatchObject({ sheets: 4, rules: 2, selectors: [{ text: '.b:nope', at: 'a.css:2' }], properties: [{ text: 'frob: 1', at: 'a.css:2' }] });
    expect(r.unread.map((u: { href: string }) => u.href).sort()).toEqual(['http://127.0.0.1:1/secret', 'http://169.254.169.254/latest/meta-data', `http://${base}/__teleport/${KEY}/api/live`].sort());
    dut.close();
  });
});


describe('the journal, the shim and the presses a replay keeps', () => {
  let server: DevServer;
  let base: string;
  const kept: { kind: string; what: string; by: string; result?: unknown; error?: string }[] = [];
  beforeAll(async () => {
    const app = mkdtempSync(join(tmpdir(), 'teleport-journal-'));
    writeFileSync(join(app, 'index.html'), '<!doctype html><html><head><title>t</title></head><body>hi</body></html>');
    server = await startDevServer({ port: 0, host: '127.0.0.1', app, journal: (e) => kept.push(e) });
    base = `127.0.0.1:${(server.http.address() as { port: number }).port}`;
  });
  afterAll(() => server.close());
  const api = (path: string, init: RequestInit = {}) => fetch(`http://${base}/__teleport/${KEY}/api/${path}`, init).then((r) => r.json() as Promise<Record<string, unknown>>);

  it('keeps each experiment once, and leaves out a call that is part of a bigger one', async () => {
    const dut = await open(`ws://${base}/ws/target?id=jr-1&e=1`);
    const reply = async (value: string) => {
      const line = await next(dut, (s) => s.startsWith('eval '));
      dut.send(`val ${line.split(' ')[1]} ${value}`);
    };
    let answer = api('eval?id=jr-1&expr=1%2B1', { method: 'POST', headers: { 'x-teleport': 'q' } });
    await reply('2');
    expect(await answer).toEqual({ value: 2 });
    expect(kept).toEqual([expect.objectContaining({ kind: 'eval', what: 'eval 1+1', by: 'q', result: { value: 2 } })]);
    answer = api('eval?id=jr-1&expr=3', { method: 'POST', headers: { 'x-teleport': 'q', 'x-teleport-part': '1' } });
    await reply('3');
    await answer;
    expect(kept).toHaveLength(1);
    dut.close();
  });

  it('turns the shim on for every page from now, reloads the devices into it, and off again', async () => {
    const dut = await open(`ws://${base}/ws/target?id=sh-1&e=1`);
    // It asks the page what it filled: nothing, before the shim was on.
    const asked = api('shim?id=sh-1');
    const line = await next(dut, (x) => x.startsWith('eval '));
    expect(line).toContain('__teleportShimmed');
    dut.send(`val ${line.split(' ')[1]} null`);
    expect(await asked).toMatchObject({ on: false, filled: null, names: expect.arrayContaining(['Object.assign', 'Element.prototype.closest']) });
    expect(await fetch(`http://${base}/`).then((r) => r.text())).not.toContain('teleport-shim.js');
    expect(await api('shim?on=1', { method: 'POST' })).toMatchObject({ on: true, reloaded: ['sh-1'] });
    await next(dut, (s) => s === 'reload');
    const page = await fetch(`http://${base}/`).then((r) => r.text());
    // After the agent, ahead of the app's own scripts.
    expect(page.indexOf('/teleport.js')).toBeLessThan(page.indexOf('/teleport-shim.js'));
    expect(await fetch(`http://${base}/teleport-shim.js`).then((r) => r.text())).toContain('__teleportShimmed');
    // On again changes nothing, so nothing reloads.
    expect(await api('shim?on=1', { method: 'POST' })).toMatchObject({ on: true, reloaded: [] });
    expect(await api('shim?on=0', { method: 'POST' })).toMatchObject({ on: false, reloaded: ['sh-1'] });
    expect(await fetch(`http://${base}/`).then((r) => r.text())).not.toContain('teleport-shim.js');
    dut.close();
  });

  it('answers the presses a page saw, none before any', async () => {
    const dut = await open(`ws://${base}/ws/target?id=pr-1&e=1`);
    expect(await api('presses?id=pr-1&seconds=60')).toMatchObject({ id: 'pr-1', presses: [] });
    dut.close();
  });
});
