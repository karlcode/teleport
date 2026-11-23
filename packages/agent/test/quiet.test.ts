// The agent runs inside someone else's app on a device: it must never throw into it, never reach its
// window.onerror or console (where its error reporting would see teleport), and put nothing on its
// screen unless asked. Here it runs as served (the bundle with its last-resort guard) on fake pages
// that get every odd thing a device or an app can do to it. Every callback the page makes into the agent
// goes through `call`, which records anything thrown: that is what would have reached onerror.
import { build, type Plugin } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { deviceGuard } from '../../../scripts/device-guard.mjs';

const INDEX = fileURLToPath(new URL('../src/index.js', import.meta.url));
const ENTRY = fileURLToPath(new URL('../src/entry.cjs', import.meta.url));
const URL_ = 'ws://192.168.1.5:7070/ws/target';

const bundle = async (options: object) => (await build({ bundle: true, write: false, format: 'iife', target: 'es5', logLevel: 'error', ...options })).outputFiles[0]!.text;
const served = await bundle({ entryPoints: [INDEX], ...deviceGuard });
const unguarded = await bundle({ entryPoints: [INDEX] });
// @tlpt/agent as an app's bundler builds it: the real agent, behind entry.cjs.
const imported = await bundle({ entryPoints: [ENTRY], define: { TELEPORT_BUNDLED: 'true' }, globalName: 'imported' });

interface El {
  tag: string;
  attrs: Record<string, string>;
  style: Record<string, string>;
  src?: string;
  parentNode: El | null;
  children: El[];
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  appendChild(c: El): El;
  removeChild(c: El): El;
}

function el(tag: string, attrs: Record<string, string> = {}): El {
  const e: El = {
    tag,
    attrs: { ...attrs },
    style: {},
    parentNode: null,
    children: [],
    setAttribute: (k, v) => void (e.attrs[k] = v),
    getAttribute: (k) => e.attrs[k] ?? null,
    appendChild: (c) => (c.parentNode?.removeChild(c), (c.parentNode = e), e.children.push(c), c),
    removeChild: (c) => ((e.children = e.children.filter((x) => x !== c)), (c.parentNode = null), c),
  };
  return e;
}

interface PageOptions {
  /** The <script> the agent was loaded by; null for none, undefined for a document without currentScript. */
  script?: El | null;
  /** No document at all, as in a worker or server-side rendering. */
  noDocument?: boolean;
  /** The WebSocket constructor throws, as for a blocked port or an insecure socket from a secure page. */
  refused?: boolean;
  extra?: PropertyDescriptorMap;
  js?: string;
}

/** A fake device page. Timers, sockets, listeners and frames are the test's to drive. */
function page(o: PageOptions = {}) {
  let clock = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const sockets: FakeSocket[] = [];
  const thrown: unknown[] = [];
  const logged: string[] = [];
  const listeners: { type: string; fn: (e: object) => void }[] = [];
  const frames: (() => void)[] = [];
  const call = (fn: (this: unknown, e?: unknown) => void, self?: unknown, e?: unknown) => {
    try {
      fn.call(self, e);
    } catch (x) {
      thrown.push(x);
    }
  };
  let attempts = 0;
  class FakeSocket {
    readyState = 0;
    bufferedAmount = 0;
    sent: unknown[] = [];
    onopen: ((e: object) => void) | null = null;
    onclose: ((e: object) => void) | null = null;
    onmessage: ((e: object) => void) | null = null;
    constructor(public url: string) {
      attempts++;
      if (o.refused) throw new SyntaxError("Failed to construct 'WebSocket'");
      sockets.push(this);
    }
    send(d: unknown) {
      this.sent.push(d);
    }
    close() {
      if (this.readyState < 2) this.readyState = 2;
    }
    open() {
      this.readyState = 1;
      if (this.onopen) call(this.onopen, this, {});
    }
    say(data: unknown) {
      if (this.onmessage) call(this.onmessage, this, { data });
    }
    fireClose(code = 1006) {
      this.readyState = 3;
      if (this.onclose) call(this.onclose, this, { code });
    }
  }
  const html = el('html');
  const head = el('head');
  html.appendChild(head);
  const document: Record<string, unknown> = {
    documentElement: html,
    head,
    createElement: (tag: string) => el(tag),
    getElementsByTagName: () => [],
    querySelector: () => null,
  };
  if (o.script !== undefined) document.currentScript = o.script;
  // Anything the agent writes to the page's console is a failure, whichever method it uses.
  const console = new Proxy({}, { get: (_t, k) => (...a: unknown[]) => void logged.push(`${String(k)}: ${a.join(' ')}`) });
  const ctx: Record<string, unknown> = {
    WebSocket: FakeSocket,
    console,
    performance: { now: () => clock },
    setTimeout: (fn: () => void, ms?: number) => (timers.set(++seq, { at: clock + (ms ?? 0), fn }), seq),
    clearTimeout: (id: number) => timers.delete(id),
    addEventListener: (type: string, fn: (e: object) => void) => listeners.push({ type, fn }),
    removeEventListener: (type: string, fn: (e: object) => void) => {
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    requestAnimationFrame: (fn: () => void) => frames.push(fn),
    getComputedStyle: () => ({ zIndex: 'auto' }),
    ...(o.noDocument ? {} : { document }),
  };
  if (o.extra) Object.defineProperties(ctx, o.extra);
  ctx.window = ctx;
  runInNewContext(o.js ?? served, ctx);
  const advance = (ms: number) => {
    const end = clock + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | null = null;
      for (const e of timers) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      timers.delete(next[0]);
      clock = Math.max(clock, next[1].at);
      call(next[1].fn);
    }
    clock = end;
  };
  const press = (keyCode: number) => {
    for (const l of listeners.slice()) if (l.type === 'keydown') call(l.fn, ctx, { keyCode, timeStamp: clock });
  };
  const frame = () => {
    for (const fn of frames.splice(0)) call(fn);
  };
  const mark = () => html.children.find((c) => 'data-teleport' in c.attrs) ?? null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { api: ctx.teleport as any, ctx, sockets, timers, thrown, logged, listeners, advance, press, frame, html, head, mark, attempts: () => attempts };
}

/** The agent's own <script> tag, as `tlpt` puts it in the page. */
const tag = (attrs: Record<string, string> = {}, src = 'http://192.168.1.5:7070/teleport.js') => Object.assign(el('script', attrs), { src });

const clean = (p: ReturnType<typeof page>) => {
  expect(p.thrown).toEqual([]);
  expect(p.logged).toEqual([]);
};

describe('the agent loads into any page without a word', () => {
  it('with no config at all it stays asleep: no socket, no timer, nothing on the screen', () => {
    const cases: PageOptions[] = [
      { noDocument: true },
      {},
      { script: null },
      { script: tag({}, 'file:///app/teleport.js') },
      { script: tag({ 'data-url': '' }) },
    ];
    for (const o of cases) {
      const p = page(o);
      expect(p.api.status().running).toBe(false);
      expect(p.sockets).toHaveLength(0);
      expect(p.timers.size).toBe(0);
      expect(p.html.children).toHaveLength(1);
      clean(p);
    }
  });

  it('survives a script tag it cannot read, and a window.teleport the app owns and locked', () => {
    const p = page({
      extra: {
        document: { value: { get currentScript() { throw new Error('odd engine'); } } },
        teleport: { value: 0, writable: false },
      },
    });
    expect(p.api).toBe(0);
    expect(p.timers.size).toBe(0);
    clean(p);
    const q = page({ script: Object.assign(tag(), { getAttribute: () => { throw new Error('odd engine'); } }) });
    expect(q.sockets).toHaveLength(0);
    clean(q);
  });

  it('with an address the engine refuses outright, tries once and then stops: no retries, no timers', () => {
    for (const o of [{ script: tag({ 'data-url': 'not a url' }), refused: true }, { script: tag(), refused: true }]) {
      const p = page(o);
      p.advance(300000);
      expect(p.attempts()).toBe(1);
      expect(p.api.status().running).toBe(false);
      expect(p.timers.size).toBe(0);
      clean(p);
    }
  });

  it('keeps even a load-time failure inside its own script, and only the guard does that', () => {
    const extra = { performance: { value: { get now() { throw new Error('odd engine'); } } } };
    expect(() => page({ extra, js: served })).not.toThrow();
    expect(() => page({ extra, js: unguarded })).toThrow('odd engine');
    expect(served.startsWith('"use strict";try{')).toBe(true);
  });
});

describe('the agent puts nothing on the screen unless asked', () => {
  const connected = (script: El) => {
    const p = page({ script });
    p.sockets[0]!.open();
    return p;
  };

  it('shows no mark by default, or with data-badge="off"', () => {
    for (const script of [tag(), tag({ 'data-badge': 'off' }), tag({ 'data-badge': '' })]) {
      const p = connected(script);
      expect(p.mark()).toBeNull();
      p.sockets[0]!.fireClose();
      expect(p.mark()).toBeNull();
      clean(p);
    }
  });

  it('shows it with data-badge="on" or init({ badge: true })', () => {
    const p = connected(tag({ 'data-badge': 'on' }));
    expect(p.mark()!.attrs['data-teleport']).toBe('connected');
    const q = page({ script: null });
    q.api.init({ url: URL_, badge: true });
    q.sockets[0]!.open();
    expect(q.mark()!.attrs['data-teleport']).toBe('connected');
    clean(p);
    clean(q);
  });

  it('takes the inspector\'s script tag back out of the page once it has loaded or failed', () => {
    const p = connected(tag());
    p.sockets[0]!.say('load /__teleport/inspector.js?id=t1');
    const s = p.head.children.at(-1) as El & { onload: (() => void) | null; onerror: (() => void) | null };
    expect(s.src).toBe('http://192.168.1.5:7070/__teleport/inspector.js?id=t1');
    s.onload!.call(s);
    expect(p.head.children).not.toContain(s);
    p.sockets[0]!.say('load /__teleport/inspector.js?id=t1');
    const t = p.head.children.at(-1) as typeof s;
    t.onerror!.call(t);
    expect(p.head.children).not.toContain(t);
    clean(p);
  });
});

describe('the agent never throws into the app', () => {
  it('takes whatever init is given and still answers; a start that fails part way is undone', () => {
    const odd: [unknown, boolean][] = [
      [undefined, true],
      [null, true],
      ['ws://x', true],
      [5, true],
      [{}, true],
      [{ url: 5 }, true],
      [{ url: Symbol('x') }, true],
      [{ url: { toString: () => { throw new Error('app value'); } } }, false],
      [{ get url() { throw new Error('app getter'); } }, false],
    ];
    for (const [opts, running] of odd) {
      const p = page({ script: null });
      expect(p.api.init(opts)).toBe(p.api);
      expect(p.api.status().running).toBe(running);
      if (!running) expect(p.timers.size).toBe(0);
      expect(p.api.stop()).toBe(p.api);
      expect(p.timers.size).toBe(0);
      clean(p);
    }
  });

  it('starts without storage, and in a page whose storage throws', () => {
    const p = page({
      script: null,
      extra: {
        location: { value: { href: 'http://device.example/app', reload: () => {} } },
        sessionStorage: { get: () => { throw new Error('SecurityError'); } },
      },
    });
    p.api.init({ url: URL_ });
    expect(new URL(p.sockets[0]!.url).searchParams.get('id')).toBeNull();
    clean(p);
  });

  it('ignores whatever the server sends that it does not understand', () => {
    const p = page({ script: tag() });
    const s = p.sockets[0]!;
    s.open();
    for (const d of ['', ' ', 'load', 'load ', 'capture', 'capture abc', 'capture -1', 'capture 1e999', 'ping', 'reload', 'nonsense here', null, undefined, 42, {}, new ArrayBuffer(4)]) s.say(d);
    p.advance(5000);
    expect(p.api.status().ticks).toBe(5);
    expect(s.readyState).toBe(1);
    clean(p);
  });

  it('keeps a failing DOM to itself when told to load a script', () => {
    const p = page({ script: tag(), extra: { document: { value: { currentScript: tag(), createElement: () => { throw new Error('odd engine'); } } } } });
    p.sockets[0]!.open();
    p.sockets[0]!.say('load /__teleport/inspector.js?id=t1');
    p.advance(3000);
    expect(p.api.status().ticks).toBe(3);
    clean(p);
  });

  it("keeps its key, frame and timer callbacks' failures to itself, inside the app's own key handling", () => {
    let broken = false;
    const odd = <T,>(v: T) => () => {
      if (broken) throw new Error('odd engine');
      return v;
    };
    const p = page({ script: tag() });
    p.sockets[0]!.open();
    // While `broken`, everything the samplers read on a key, a frame or a probe throws.
    const doc = p.ctx.document as Record<string, unknown>;
    Object.defineProperty(doc, 'activeElement', { get: odd(null) });
    doc.querySelector = odd(null);
    p.ctx.getComputedStyle = odd({ zIndex: 'auto' });
    for (let k = 0; k < 20; k++) {
      broken = k % 2 === 1;
      p.press(39);
      broken = true;
      p.frame();
      p.frame();
      p.advance(300);
    }
    p.sockets[0]!.say('capture 500');
    for (let k = 0; k < 10; k++) p.frame();
    expect(p.listeners.filter((l) => l.type === 'keydown')).toHaveLength(2);
    expect(p.api.status().ticks).toBeGreaterThan(5);
    clean(p);
  });

  it('removes every listener it added when stopped', () => {
    const p = page({ script: tag() });
    // Two for keys, and two that hear what the page throws (errors.js).
    expect(p.listeners.map((l) => l.type).sort()).toEqual(['error', 'keydown', 'keydown', 'unhandledrejection']);
    p.api.stop();
    expect(p.listeners).toHaveLength(0);
    expect(p.timers.size).toBe(0);
    clean(p);
  });
});

describe("import '@tlpt/agent' never breaks the app's bundle", () => {
  const load = (href: string, extra: PropertyDescriptorMap = {}) =>
    page({
      js: imported,
      script: null,
      extra: { location: { value: Object.assign(new URL(href), { reload: () => {} }) }, ...extra },
    });

  type Imported = { init(o?: { url: string }): unknown; status(): { running: boolean } };
  const LAPTOP = 'ws://192.168.1.20:7070/ws/target';

  it('stays asleep whatever the address says, and needs no `process`', () => {
    for (const href of ['http://device.example/?tlpt=%E0%A4%A', 'http://device.example/?tlpt=192.168.1.20']) {
      const p = load(href);
      expect((p.ctx.imported as Imported).status().running).toBe(false);
      expect(p.sockets).toHaveLength(0);
      clean(p);
    }
  });

  it("starts alongside a window.teleport of the app's own, and leaves that alone", () => {
    const mine = { flag: 'app' };
    const p = load('http://device.example/', { teleport: { value: mine, writable: true } });
    (p.ctx.imported as Imported).init({ url: LAPTOP });
    expect(p.ctx.teleport).toBe(mine);
    expect(p.sockets[0]!.url).toMatch(/^ws:\/\/192\.168\.1\.20:7070\/ws\/target\?/);
    clean(p);
  });

  it("starts even when the app's own window.teleport throws from status()", () => {
    const mine = {
      status() {
        throw new Error('not an agent');
      },
    };
    const p = load('http://device.example/', { teleport: { value: mine, writable: true } });
    (p.ctx.imported as Imported).init({ url: LAPTOP });
    expect(p.sockets[0]!.url).toMatch(/^ws:\/\/192\.168\.1\.20:7070\/ws\/target\?/);
    clean(p);
  });

  it('gives the app a sleeping agent if the agent cannot even load', async () => {
    const broken: Plugin = {
      name: 'broken-agent',
      setup(b) {
        b.onResolve({ filter: /^\.\/index\.js$/ }, () => ({ path: 'agent', namespace: 'broken' }));
        b.onLoad({ filter: /.*/, namespace: 'broken' }, () => ({ contents: "throw new Error('odd engine');" }));
      },
    };
    const js = await bundle({ entryPoints: [ENTRY], globalName: 'imported', plugins: [broken] });
    const p = page({ js, script: null, extra: { location: { value: new URL('http://device.example/?tlpt=192.168.1.20') } } });
    const agent = p.ctx.imported as { init(o: object): { status(): { running: boolean } } };
    expect(agent.init({ url: URL_ }).status().running).toBe(false);
    expect(p.sockets).toHaveLength(0);
    clean(p);
  });
});
