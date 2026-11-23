import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { KEY } from './keyed.js';
import WebSocket from 'ws';
import { isProbe, PROBE_IDS, PROBES } from '../src/probes.js';
import { startDevServer, type DevServer } from '../src/server.js';

const root = new URL('../../../', import.meta.url);

/** Every script that runs on the device, named. */
const deviceScripts = (): [string, string][] => PROBE_IDS.map((id) => [`probe ${id}`, PROBES[id].script]);

describe('device scripts', () => {
  it('are ES5, as the device engine needs (es-check)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'teleport-es5-'));
    const files = deviceScripts().map(([name, script]) => {
      const f = join(dir, `${name.replace(/\W+/g, '-')}.js`);
      writeFileSync(f, `${script};\n`);
      return f;
    });
    expect(files.length).toBe(PROBE_IDS.length);
    const out = execFileSync(new URL('node_modules/.bin/es-check', root).pathname, ['es5', ...files], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(out).toMatch(/no ES version matching errors|passed/i);
  });

  it('each parses in Node, so a quoting slip never reaches the device', () => {
    for (const [name, script] of deviceScripts()) expect(() => new Function(script), name).not.toThrow();
  });

  it('asks every check it will show, with no key asked twice', () => {
    for (const id of ['identity', 'features', 'media', 'graphics'] as const) {
      const shown = PROBES[id].parse({}).groups.flatMap((g) => g.items.map((i) => i.k));
      expect(new Set(shown).size, id).toBe(shown.length);
      for (const k of shown) expect(PROBES[id].script, `${id} asks ${k}`).toContain(`g(${JSON.stringify(k)},`);
    }
  });
});

describe('probe parsers at the boundary', () => {
  it('reads a capability answer, with anything missing or odd as unavailable', () => {
    const r = PROBES.identity.parse({ ua: 'Mozilla/5.0 (X11; Linux armv7l)', cores: 4, cookies: true, dnt: { not: 'a reading' }, __ms: 1.25, hdr: 'yes' });
    const item = (k: string) => r.groups.flatMap((g) => g.items).find((i) => i.k === k)!;
    expect(item('ua').v).toBe('Mozilla/5.0 (X11; Linux armv7l)');
    expect(item('cores').v).toBe(4);
    expect(item('cookies').v).toBe(true);
    expect(item('dnt').v).toBeNull();
    expect(item('platform').v).toBeNull();
    expect(item('hdr').v).toBe('yes');
    expect(r.ms).toBe(1.25);
    expect(r.wallMs).toBeNull();
    expect(r.groups.map((g) => g.id)).toEqual(['identity', 'platform', 'page', 'display', 'hardware', 'network']);
  });

  it('survives garbage', () => {
    for (const id of PROBE_IDS) for (const raw of [undefined, null, 42, 'x', [], { local: 7, counts: null, box: [1] }]) expect(() => PROBES[id].parse(raw), `${id} on ${JSON.stringify(raw)}`).not.toThrow();
    expect(PROBES.storage.parse(null)).toMatchObject({ local: null, cookies: null, indexedDB: null, caches: null, workers: null, quota: null, ms: null });
    expect(PROBES.dom.parse('x')).toMatchObject({ elements: 0, depth: 0, largest: null, widest: null, rules: null });
    expect(PROBES.focus.parse({ box: [1, 2, 3] })).toMatchObject({ box: null, active: null });
  });

  it('reads a storage answer and drops entries without a key', () => {
    const r = PROBES.storage.parse({
      local: { count: 2, bytes: 40, entries: [{ key: 'a', preview: '1', bytes: 4 }, { preview: 'no key' }], capped: false },
      session: null,
      cookies: { count: 1, bytes: 7, entries: [{ name: 'sid', preview: 'x', bytes: 5 }] },
      indexedDB: { databases: [{ name: 'app', version: 3, stores: [{ name: 'tiles', count: 12 }, { name: 'bad' }] }], capped: false },
      caches: [{ name: 'v1', entries: 9 }],
      workers: [{ scope: 'http://device/', state: 'activated', scriptURL: 'http://device/sw.js' }],
      quota: { usageBytes: 1024, quotaBytes: 2048, persisted: false },
      __ms: 2,
      __wall: 30,
    });
    expect(r.local).toEqual({ count: 2, bytes: 40, entries: [{ key: 'a', preview: '1', bytes: 4, full: null }], capped: false });
    expect(r.session).toBeNull();
    expect(r.indexedDB?.databases).toEqual([{ name: 'app', version: 3, stores: [{ name: 'tiles', count: 12 }, { name: 'bad', count: null }] }]);
    expect(r.caches).toEqual([{ name: 'v1', entries: 9 }]);
    expect(r.workers?.[0]?.state).toBe('activated');
    expect(r.quota).toEqual({ usageBytes: 1024, quotaBytes: 2048, persisted: false });
    expect([r.ms, r.wallMs]).toEqual([2, 30]);
  });

  it('reads a dom answer', () => {
    const r = PROBES.dom.parse({ elements: 120, textNodes: 80, depth: 9, deepest: 'span.title', largest: { path: 'div#rails', descendants: 100 }, widest: { path: 'div.rail', children: 24 }, counts: { img: 24, script: 2 }, stylesheets: 1, rules: 40, __ms: 0.6 });
    expect(r).toMatchObject({ elements: 120, depth: 9, deepest: 'span.title', largest: { path: 'div#rails', descendants: 100 }, widest: { path: 'div.rail', children: 24 }, stylesheets: 1, rules: 40, ms: 0.6 });
    expect(r.counts).toEqual({ img: 24, video: 0, audio: 0, iframe: 0, canvas: 0, svg: 0, script: 2, style: 0, link: 0 });
  });
});

describe('what the media probe says of DRM over plain http', () => {
  const eme = (raw: object) => PROBES.media.parse(raw);

  it('says the key systems are unknown, not missing, when the engine kept them from a page that is no secure context', () => {
    const r = eme({ emeSecure: false, eme: false, widevine: null });
    expect(r.notes).toHaveLength(1);
    expect(r.notes![0]).toMatch(/not a secure context .* the key systems read as unknown, not as missing\. Open the app over https/);
  });

  it('says nothing where the engine could be asked, or is too old to know of secure contexts', () => {
    // Asked and answered: the readings stand for themselves.
    expect(eme({ emeSecure: true, eme: true, widevine: 'L3' }).notes).toBeUndefined();
    // Before Chromium 58 a page over plain http could still ask.
    expect(eme({ emeSecure: false, eme: true, widevine: 'L3' }).notes).toBeUndefined();
    // Chromium 38: no isSecureContext, and no unprefixed EME either. The device has none to offer.
    expect(eme({ eme: false }).notes).toBeUndefined();
    expect(eme({}).notes).toBeUndefined();
  });

  it('asks the engine whether the page is one', () => {
    expect(PROBES.media.script).toContain('g("emeSecure",');
    expect(PROBES.media.script).toContain('window.isSecureContext');
  });
});

describe('probe names', () => {
  it('knows its own and refuses others', () => {
    expect(isProbe('storage')).toBe(true);
    expect(isProbe('nope')).toBe(false);
    expect(PROBE_IDS).toEqual(['identity', 'features', 'media', 'graphics', 'storage', 'dom', 'focus', 'speed']);
  });
});

// The yardstick: four fixed pieces of work, timed on the device. Run here on a page made of the few
// calls it uses, with a clock that moves a set amount each time it is read.
describe('the speed probe', () => {
  /** A page for the script: every read of the clock moves it `tick` ms, so each run takes `tick`. */
  function page(tick: number, o: { promise?: boolean; broken?: boolean } = {}) {
    let clock = 0;
    const node = (): Record<string, any> => ({
      style: {},
      children: [] as unknown[],
      parentNode: null,
      setAttribute() {},
      appendChild(c: Record<string, any>) {
        this.children.push(c);
        c.parentNode = this;
        return c;
      },
      removeChild(c: unknown) {
        this.children = this.children.filter((x: unknown) => x !== c);
      },
      set innerHTML(_: string) {
        this.children = [];
      },
      get offsetHeight() {
        return 20;
      },
    });
    const made: string[] = [];
    const frameDoc = {
      open() {},
      write() {},
      close() {},
      body: node(),
      createElement(tag: string) {
        if (o.broken && tag === 'div' && made.includes('host')) throw new Error('no elements on this engine');
        made.push(made.length ? tag : 'host');
        return node();
      },
      createDocumentFragment: node,
      createTextNode: () => ({}),
    };
    const body = node();
    const document = { body, documentElement: node(), createElement: (tag: string) => Object.assign(node(), tag === 'iframe' ? { contentDocument: frameDoc } : {}) };
    const ctx = { window: { performance: { now: () => (clock += tick) } }, document, JSON, Math, setTimeout: (fn: () => void) => void fn(), Promise: o.promise === false ? undefined : Promise };
    return { body, run: () => runInNewContext(PROBES.speed.script, ctx) as unknown };
  }

  it('times each piece of work as the median of five runs, and leaves the page as it was', async () => {
    const p = page(4);
    const r = PROBES.speed.parse(await p.run());
    expect(r).toMatchObject({ js: 4, json: 4, dom: 4, layout: 4, runs: { js: 5, json: 5, dom: 5, layout: 5 }, ms: 80 });
    expect(r.wallMs).toBeGreaterThanOrEqual(80);
    // The frame it worked in is gone, and nothing else was added.
    expect(p.body.children).toEqual([]);
  });

  it('stops running a piece of work once it has taken the budget, and says how many runs it got', async () => {
    // 600 ms a run: the third run takes it past 1.5 s.
    expect(PROBES.speed.parse(await page(600).run())).toMatchObject({ js: 600, layout: 600, runs: { js: 3, json: 3, dom: 3, layout: 3 } });
    // One run alone is over the budget: that run is the answer.
    expect(PROBES.speed.parse(await page(4000).run())).toMatchObject({ layout: 4000, runs: { js: 1, json: 1, dom: 1, layout: 1 } });
  });

  it('answers at once on an engine without Promise', () => {
    const raw = page(2, { promise: false }).run();
    expect(raw).not.toBeInstanceOf(Promise);
    expect(PROBES.speed.parse(raw)).toMatchObject({ js: 2, layout: 2, runs: { dom: 5 } });
  });

  it('gives no number for work the engine could not do, and still times the rest', async () => {
    const p = page(3, { broken: true });
    const r = PROBES.speed.parse(await p.run());
    expect(r).toMatchObject({ js: 3, json: 3, dom: null, layout: 3, runs: { dom: 0 } });
    expect(p.body.children).toEqual([]);
  });

  it('reads garbage as no numbers', () => {
    const r = PROBES.speed.parse({ js: 'fast', runs: 7, __ms: {} });
    expect(r).toEqual({ js: null, json: null, dom: null, layout: null, runs: { js: 0, json: 0, dom: 0, layout: 0 }, laptop: r.laptop, ms: null, wallMs: null });
  });
});

describe('the API on the device', () => {
  let server: DevServer | null = null;
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const s of sockets) s.terminate();
    sockets.length = 0;
    await server?.close();
    server = null;
  });

  const inbox = new Map<WebSocket, string[]>();
  const open = async (url: string) => {
    const ws = new WebSocket(url);
    sockets.push(ws);
    inbox.set(ws, []);
    ws.on('message', (d: Buffer, binary: boolean) => {
      if (!binary) inbox.get(ws)!.push(d.toString());
    });
    await new Promise((r) => ws.once('open', r));
    return ws;
  };
  const next = async <T>(ws: WebSocket, test: (m: T) => boolean): Promise<T> => {
    for (;;) {
      const box = inbox.get(ws)!;
      for (let i = 0; i < box.length; i++) {
        let m: T;
        try {
          m = JSON.parse(box[i]!);
        } catch {
          continue;
        }
        if (!test(m)) continue;
        box.splice(0, i + 1);
        return m;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  const text = async (ws: WebSocket, prefix: string) => {
    for (;;) {
      const box = inbox.get(ws)!;
      const i = box.findIndex((s) => s.startsWith(prefix));
      if (i >= 0) return box.splice(0, i + 1)[i]!;
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  type Eval = { id: string; method: string; params: { expression: string; awaitPromise?: boolean } };

  it('serves a probe over the API, parsed, loading the inspector once for a run of calls', async () => {
    server = await startDevServer({ port: 0, host: '127.0.0.1' });
    const base = `127.0.0.1:${(server.http.address() as { port: number }).port}`;
    const agent = await open(`ws://${base}/ws/target?id=tv2&href=${encodeURIComponent('http://device/')}`);
    while (!server.devices.has('tv2')) await new Promise((r) => setTimeout(r, 10));
    const bad = await fetch(`http://${base}/__teleport/${KEY}/api/probe?name=nope`);
    expect(bad.status).toBe(400);
    const load = text(agent, 'load ');
    const res = fetch(`http://${base}/__teleport/${KEY}/api/probe?name=dom`);
    expect(await load).toBe('load /__teleport/inspector.js?id=tv2');
    const inspector = await open(`ws://${base}/ws/cdp/tv2`);
    const m = await next<Eval>(inspector, (x) => x.method === 'Runtime.evaluate');
    expect(m.id).toMatch(/^q:\d+$/);
    expect(m.params.expression).toBe(PROBES.dom.script);
    expect(m.params.awaitPromise).toBe(true);
    inspector.send(JSON.stringify({ id: m.id, result: { result: { type: 'object', value: { elements: 3, depth: 2, counts: { img: 1 }, __ms: 0.1 } } } }));
    const body = (await (await res).json()) as { elements: number; counts: { img: number; video: number } };
    expect(body.elements).toBe(3);
    expect(body.counts).toMatchObject({ img: 1, video: 0 });

    // The inspector is held for the next call: no second load, and eval answers through it.
    const evaluated = fetch(`http://${base}/__teleport/${KEY}/api/eval?expr=${encodeURIComponent('1+1')}`, { method: 'POST', headers: { 'x-teleport': 'test' } });
    const e = await next<Eval>(inspector, (x) => x.method === 'Runtime.evaluate');
    expect(e.params.expression).toBe('1+1');
    inspector.send(JSON.stringify({ id: e.id, result: { result: { type: 'number', value: 2 } } }));
    expect(await (await evaluated).json()).toEqual({ value: 2 });
    expect(inbox.get(agent)!.filter((s) => s.startsWith('load '))).toEqual([]);

    // What the page throws comes back as the error, not as a hang.
    const threw = fetch(`http://${base}/__teleport/${KEY}/api/eval?expr=x`, { method: 'POST', headers: { 'x-teleport': 'test' } });
    const t = await next<Eval>(inspector, (x) => x.method === 'Runtime.evaluate');
    inspector.send(JSON.stringify({ id: t.id, result: { result: { type: 'undefined' }, exceptionDetails: { text: 'Uncaught', exception: { description: 'ReferenceError: x is not defined' } } } }));
    const failed = await threw;
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: 'eval: ReferenceError: x is not defined' });

    // Without the key nothing runs on the device, whatever headers come with it.
    expect((await fetch(`http://${base}/__teleport/api/eval?expr=1`, { method: 'POST', headers: { 'x-teleport': 'test' } })).status).toBe(403);
  }, 15_000);

  it('presses remote keys through the inspector, as the platform sends them', async () => {
    server = await startDevServer({ port: 0, host: '127.0.0.1' });
    const base = `127.0.0.1:${(server.http.address() as { port: number }).port}`;
    const agent = await open(`ws://${base}/ws/target?id=tv4`);
    while (!server.devices.has('tv4')) await new Promise((r) => setTimeout(r, 10));
    const res = fetch(`http://${base}/__teleport/${KEY}/api/keys?seq=right,ok`, { method: 'POST', headers: { 'x-teleport': 'test' } });
    await text(agent, 'load ');
    const inspector = await open(`ws://${base}/ws/cdp/tv4`);
    const pressed: string[] = [];
    for (let i = 0; i < 2; i++) {
      const m = await next<Eval>(inspector, (x) => x.method === 'Runtime.evaluate');
      pressed.push(m.params.expression);
      inspector.send(JSON.stringify({ id: m.id, result: { result: { type: 'string', value: '' } } }));
    }
    expect(pressed[0]).toContain('ArrowRight');
    expect(pressed[1]).toContain('Enter');
    const run = (await (await res).json()) as { phase: string; presses: number };
    expect(run).toMatchObject({ phase: 'done', presses: 2 });
  }, 15_000);

  it('fails the calls an inspector will never answer when its page goes away', async () => {
    server = await startDevServer({ port: 0, host: '127.0.0.1' });
    const base = `127.0.0.1:${(server.http.address() as { port: number }).port}`;
    const agent = await open(`ws://${base}/ws/target?id=tv5`);
    while (!server.devices.has('tv5')) await new Promise((r) => setTimeout(r, 10));
    const res = fetch(`http://${base}/__teleport/${KEY}/api/probe?name=dom`);
    await text(agent, 'load ');
    const inspector = await open(`ws://${base}/ws/cdp/tv5`);
    await next<Eval>(inspector, (x) => x.method === 'Runtime.evaluate');
    agent.close();
    const failed = await res;
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: 'the page went away' });
  }, 15_000);
});
