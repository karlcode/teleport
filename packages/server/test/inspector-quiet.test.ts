// The inspector runs inside someone else's app on a device, and wraps the app's own console, XHR and
// fetch while DevTools (or an API call) needs it. It must never throw into the app, never reach its
// window.onerror or console, never swallow the app's own errors, and never change what the app's
// calls return. Here it runs as served (the bundle with its last-resort guard) on a fake page; every
// callback the page makes into it goes through `call`, which records anything thrown: that is what
// would have reached the app's onerror.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { Expander } from '../src/expand.js';
import { deviceGuard } from '../../../scripts/device-guard.mjs';

const INSPECTOR = fileURLToPath(new URL('../../inspector/src/index.js', import.meta.url));
const js = (await build({ entryPoints: [INSPECTOR], bundle: true, write: false, format: 'iife', target: 'es5', logLevel: 'error', ...deviceGuard })).outputFiles[0]!.text;

type Fn = (this: unknown, ...a: unknown[]) => unknown;
interface Msg {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message: string };
}

interface Options {
  /** The inspector's <script>; null for a page that can't say (no currentScript). */
  src?: string | null;
  /** The WebSocket constructor throws. */
  refused?: boolean;
  /** No document at all. */
  noDocument?: boolean;
  /** Console methods the app's engine has. */
  consoleMethods?: string[];
}

function dut(o: Options = {}) {
  let clock = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const thrown: unknown[] = [];
  const call = (fn: Fn, self?: unknown, ...a: unknown[]) => {
    try {
      return fn.apply(self, a);
    } catch (x) {
      thrown.push(x);
    }
  };
  const sockets: FakeSocket[] = [];
  // The inspector sends what one task produced as one WebSocket message, a line each, from a
  // zero-delay timer: timers due now run before anything reads what a socket was sent.
  const settle = () => {
    for (;;) {
      const due = [...timers].find((e) => e[1].at <= clock);
      if (!due) break;
      timers.delete(due[0]);
      call(due[1].fn);
    }
  };
  class FakeSocket {
    readyState = 0;
    bufferedAmount = 0;
    lines: Msg[] = [];
    get sent(): Msg[] {
      settle();
      return this.lines;
    }
    onopen: Fn | null = null;
    onclose: Fn | null = null;
    onmessage: Fn | null = null;
    expander = new Expander();
    constructor(public url: string) {
      if (o.refused) throw new DOMException('refused', 'SecurityError');
      sockets.push(this);
    }
    send(s: string) {
      for (const line of s.split('\n')) {
        // As the laptop reads it: the inspector's short messages are the protocol's again.
        const read = JSON.parse(line);
        // The link's own acknowledgements are not CDP.
        for (const m of Array.isArray(read) ? this.expander.expand(read) : [read]) if (!('teleport' in m)) this.lines.push(m);
      }
    }
    close() {
      this.readyState = 3;
    }
    open() {
      this.readyState = 1;
      if (this.onopen) call(this.onopen, this, {});
    }
    say(data: unknown) {
      if (this.onmessage) call(this.onmessage, this, { data });
    }
  }

  // The app's console: what it gets called with, and nothing else. A call the test didn't make is
  // the inspector writing to the page's console.
  const consoleCalls: { name: string; self: unknown; args: unknown[] }[] = [];
  const appConsole: Record<string, Fn> = {};
  for (const name of o.consoleMethods ?? ['log', 'info', 'warn', 'error', 'debug', 'dir', 'trace', 'group', 'groupEnd', 'assert', 'clear']) {
    appConsole[name] = function (...args: unknown[]) {
      consoleCalls.push({ name, self: this, args });
      return `ret-${name}`;
    };
  }

  // The app's network: XHR and fetch that record how they were called.
  const net: { what: string; self: unknown; args: unknown[] }[] = [];
  const failures: Record<string, unknown> = {};
  class FakeXhr {
    status = 200;
    statusText = 'OK';
    responseType = '';
    responseText = '{"ok":true}';
    listeners: [string, Fn][] = [];
    addEventListener(t: string, f: Fn) {
      this.listeners.push([t, f]);
    }
    getAllResponseHeaders() {
      return 'content-type: application/json\r\n';
    }
  }
  for (const what of ['open', 'send', 'setRequestHeader']) {
    (FakeXhr.prototype as unknown as Record<string, Fn>)[what] = function (...args: unknown[]) {
      net.push({ what, self: this, args });
      if (failures[what]) throw failures[what];
      return `ret-${what}`;
    };
  }
  let fetchImpl: Fn = () => Promise.resolve({ status: 200, statusText: 'OK', url: 'http://device.example/api', headers: { 'content-type': 'text/plain' }, clone: () => ({ text: () => Promise.resolve('hello') }) });

  const winListeners: [string, Fn][] = [];
  const docListeners: [string, Fn][] = [];
  let mutated: Fn | null = null;
  const location = Object.assign(new URL('http://device.example/app'), { reload: () => {} });
  const document: Record<string, unknown> = {
    nodeType: 9,
    nodeName: '#document',
    URL: location.href,
    compatMode: 'CSS1Compat',
    firstChild: null,
    currentScript: o.src === null ? null : { src: o.src ?? 'http://127.0.0.1:7700/__teleport/inspector.js?id=t1' },
    styleSheets: [],
    scripts: [],
    images: [],
    createElement: () => {
      let h = '';
      return {
        get href() {
          return h;
        },
        set href(v: string) {
          h = new URL(v, location.href).href;
        },
      };
    },
    querySelectorAll: () => [],
    getElementsByTagName: () => [],
    addEventListener: (t: string, f: Fn) => docListeners.push([t, f]),
    removeEventListener: (t: string, f: Fn) => {
      const i = docListeners.findIndex((l) => l[0] === t && l[1] === f);
      if (i >= 0) docListeners.splice(i, 1);
    },
  };
  const ctx: Record<string, unknown> = {
    WebSocket: FakeSocket,
    console: appConsole,
    XMLHttpRequest: FakeXhr,
    fetch: function (this: unknown, ...a: unknown[]) {
      net.push({ what: 'fetch', self: this, args: a });
      return fetchImpl.apply(this, a);
    },
    MutationObserver: class {
      constructor(cb: Fn) {
        mutated = cb;
      }
      observe() {}
      disconnect() {}
    },
    location,
    performance: { now: () => clock },
    setTimeout: (fn: () => void, ms?: number) => (timers.set(++seq, { at: clock + (ms ?? 0), fn }), seq),
    clearTimeout: (id: number) => timers.delete(id),
    addEventListener: (t: string, f: Fn) => winListeners.push([t, f]),
    removeEventListener: (t: string, f: Fn) => {
      const i = winListeners.findIndex((l) => l[0] === t && l[1] === f);
      if (i >= 0) winListeners.splice(i, 1);
    },
    ...(o.noDocument ? {} : { document }),
  };
  ctx.window = ctx;
  runInNewContext(js, ctx);
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
  const ws = () => sockets.at(-1)!;
  let id = 0;
  /** A CDP call from DevTools; its reply, if one came. */
  const cdp = (method: string, params: unknown = {}) => {
    const n = ++id;
    ws().say(JSON.stringify({ id: n, method, params }));
    return ws().sent.find((m) => m.id === n);
  };
  const events = (method: string) => sockets.flatMap((s) => s.sent).filter((m) => m.method === method);
  return {
    ctx,
    thrown,
    consoleCalls,
    net,
    failures,
    winListeners,
    docListeners,
    mutated: () => mutated,
    sockets,
    timers,
    ws,
    cdp,
    events,
    advance,
    setFetch: (f: Fn) => void (fetchImpl = f),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    console: appConsole as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    window: ctx as any,
  };
}

/** An inspector with its link open. */
function linked(o: Options = {}) {
  const p = dut(o);
  p.ws().open();
  // The durable link: nothing goes out on a socket until the server says what it got.
  p.ws().say('{"teleport":"link","got":0,"kept":false}');
  return p;
}

const caught = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e;
  }
  return undefined;
};

describe('the inspector loads into any page without a word', () => {
  it('with nothing to go on: no script address, a refused socket, or no document at all', () => {
    for (const o of [{ src: null }, { refused: true }, { noDocument: true }]) {
      const p = dut(o);
      expect(p.sockets).toHaveLength(0);
      p.advance(120000);
      expect(p.sockets).toHaveLength(0);
      expect(p.timers.size).toBe(0);
      expect(p.thrown).toEqual([]);
      expect(p.consoleCalls).toEqual([]);
    }
  });
});

describe('the inspector answers whatever it is sent, and never throws', () => {
  it('ignores what is not a call, and answers every call, even one it cannot serialise', async () => {
    const p = linked();
    for (const d of ['not json', 'null', '5', '"text"', '{}', '{"method":5}', '[]', null, 7, new ArrayBuffer(2)]) p.ws().say(d);
    expect(p.ws().sent).toEqual([]);
    for (const method of ['__proto__', 'constructor', 'hasOwnProperty', 'toString', 'No.such']) expect(p.cdp(method)!.error).toBeDefined();
    expect(p.cdp('DOM.getOuterHTML', null)!.error).toBeDefined();
    expect(p.cdp('DOM.getOuterHTML', 5)!.error).toBeDefined();
    expect(p.cdp('Runtime.evaluate', { expression: '1n', returnByValue: true })!.error!.message).toMatch(/serialised/);
    expect(p.cdp('Runtime.callFunctionOn', { functionDeclaration: 'function () { throw Object.create(null); }' })!.result!.exceptionDetails).toBeDefined();
    // A promise the page resolves with something that can't even be looked at.
    p.cdp('Runtime.evaluate', { expression: 'Promise.resolve((function(){var r=Proxy.revocable({},{});r.revoke();return [r.proxy]})())', awaitPromise: true, generatePreview: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(p.ws().sent.at(-1)!.error!.message).toMatch(/could not be read/);
    p.advance(10000);
    expect(p.thrown).toEqual([]);
    expect(p.consoleCalls).toEqual([]);
  });

  it("keeps its listeners' and observers' failures to itself", () => {
    const p = linked();
    p.cdp('Runtime.enable');
    p.cdp('teleport.snapshot', { budget: 10 });
    p.cdp('Overlay.setInspectMode', { mode: 'searchForNode', highlightConfig: {} });
    // The page dispatching its own error events, odd ones included.
    expect(p.winListeners.map((l) => l[0])).toEqual(['error', 'unhandledrejection']);
    for (const [, f] of p.winListeners) {
      f.call(p.window, null);
      f.call(p.window, { get error() { throw new Error('odd'); }, get reason() { throw new Error('odd'); } });
    }
    for (const [, f] of p.docListeners) {
      f.call(p.ctx.document, {});
      f.call(p.ctx.document, { target: { nodeType: 1 } });
    }
    p.mutated()!.call(null, null);
    p.mutated()!.call(null, [{ type: 'childList', target: null }]);
    p.advance(20000);
    expect(p.thrown).toEqual([]);
    expect(p.consoleCalls).toEqual([]);
  });
});

describe("the app's console, while DevTools has it", () => {
  it('returns what the app\'s own returns, called with the same this and arguments, and DevTools gets a copy', () => {
    const p = linked();
    const original = p.console.log;
    p.cdp('Runtime.enable');
    expect(p.console.log).not.toBe(original);
    const self = { mine: true };
    expect(p.console.log.call(self, 'a', 1)).toBe('ret-log');
    expect(p.consoleCalls).toEqual([{ name: 'log', self, args: ['a', 1] }]);
    expect(p.events('Runtime.consoleAPICalled').map((m) => (m.params!.args as { value: unknown }[]).map((a) => a.value))).toEqual([['a', 1]]);
  });

  it('still reaches the app\'s method when the copy fails, and carries on copying after', () => {
    const p = linked();
    p.cdp('Runtime.enable');
    const r = Proxy.revocable({}, {});
    r.revoke();
    expect(p.console.log(r.proxy)).toBe('ret-log');
    expect(p.consoleCalls.at(-1)!.args[0]).toBe(r.proxy);
    expect(p.console.info({ later: 1 })).toBe('ret-info');
    const copied = p.events('Runtime.consoleAPICalled').at(-1)!;
    expect(copied.params!.type).toBe('info');
    // Objects made remote after the failure go back to DevTools' own ring, not the console's.
    expect(String((p.cdp('Runtime.evaluate', { expression: '({})' })!.result!.result as { objectId: string }).objectId)).not.toMatch(/^c/);
    expect(p.thrown).toEqual([]);
  });

  it("lets the app's own exception through unchanged", () => {
    const p = linked();
    const boom = { app: 'error' };
    p.console.warn = () => {
      throw boom;
    };
    p.cdp('Runtime.enable');
    expect(caught(() => p.console.warn('x'))).toBe(boom);
  });

  it("leaves out what the engine lacks, and gives the console back as it was, or as the app's error reporter left it", () => {
    const p = linked({ consoleMethods: ['log', 'warn'] });
    const log = p.console.log;
    p.cdp('Runtime.enable');
    expect('table' in p.console).toBe(false);
    expect('error' in p.console).toBe(false);
    p.ws().say('{"method":"teleport.detach"}');
    expect(p.console.log).toBe(log);

    // An error reporter that wraps the console while DevTools has it keeps its wrapper.
    p.cdp('Runtime.enable');
    const ours = p.console.log;
    const reporter = function (this: unknown, ...a: unknown[]) {
      return ours.apply(this, a);
    };
    p.console.log = reporter;
    p.ws().say('{"method":"teleport.detach"}');
    expect(p.console.log).toBe(reporter);
    const before = p.events('Runtime.consoleAPICalled').length;
    p.console.log('after');
    expect(p.events('Runtime.consoleAPICalled').length).toBe(before);
    p.cdp('Runtime.enable');
    p.console.log('again');
    expect(p.events('Runtime.consoleAPICalled').length).toBe(before + 1);
    expect(p.consoleCalls.map((c) => c.args[0])).toEqual(['after', 'again']);
  });
});

describe('what teleport does for DevTools stays out of the app', () => {
  it("tells a trial's runner where the laptop is, as the inspector's script tag is gone", () => {
    const p = linked();
    expect(p.window.__teleportInspector.server).toBe('http://127.0.0.1:7700');
  });

  it("asks only for the page's own files: another origin's would fail into the app's console and reporting", () => {
    const p = linked();
    p.cdp('Page.getResourceContent', { frameId: 'main', url: 'https://cdn.example/lib.js' });
    expect(p.net.filter((n) => n.what === 'open')).toEqual([]);
    const reply = (p.ws().sent as { error?: { message: string } }[]).at(-1)!;
    expect(reply.error?.message).toMatch(/another origin/);
    p.cdp('Page.getResourceContent', { frameId: 'main', url: '/app.js' });
    expect(p.net.filter((n) => n.what === 'open').map((n) => n.args[1])).toEqual(['/app.js']);
  });

  it("keeps console calls its own reading causes (a getter, a Proxy's handler) out of the app's console", () => {
    const p = linked();
    p.cdp('Runtime.enable');
    // Like a Vue 3 reactive object: reading its keys runs the app's handler, which warns.
    let reads = 0;
    const watched = new Proxy(
      { state: 1 },
      {
        ownKeys(t) {
          reads++;
          p.console.warn('[Vue warn] enumerating keys');
          return Reflect.ownKeys(t);
        },
      },
    );
    p.console.log(watched);
    expect(reads).toBeGreaterThan(0);
    // The app's log reaches its console; the warning only teleport's reading caused doesn't.
    expect(p.consoleCalls.map((c) => c.name)).toEqual(['log']);
    p.console.warn('the app warns itself');
    expect(p.consoleCalls.map((c) => c.name)).toEqual(['log', 'warn']);
  });
});

describe("the app's fetch and XHR, while DevTools has them", () => {
  it('fetch: the same promise back when noting it fails, and the same exception when the app\'s own throws', () => {
    const p = linked();
    p.cdp('Network.enable');
    const promise = Promise.resolve('app');
    p.setFetch(() => promise);
    (p.ctx.document as Record<string, unknown>).createElement = () => {
      throw new Error('odd engine');
    };
    const self = { mine: true };
    expect(p.window.fetch.call(self, '/api', { method: 'POST' })).toBe(promise);
    expect(p.net.at(-1)).toEqual({ what: 'fetch', self, args: ['/api', { method: 'POST' }] });
    const boom = new TypeError('app');
    p.setFetch(() => {
      throw boom;
    });
    expect(caught(() => p.window.fetch('/api'))).toBe(boom);
    expect(p.thrown).toEqual([]);
  });

  it('fetch: the app gets its very own promise back, whatever is on it, and the outcome is noted on the side', async () => {
    const p = linked();
    p.cdp('Network.enable');
    const res = await p.window.fetch('/api');
    expect(res.status).toBe(200);
    expect(p.events('Network.requestWillBeSent')).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(p.events('Network.loadingFinished')).toHaveLength(1);

    // Its own object, with what an app's wrapper put on it (a cancel()), never a promise of teleport's.
    let handlers: Fn[] = [];
    const own = { then: (...h: Fn[]) => ((handlers = h), {}), cancel: () => 'cancel ok' };
    p.setFetch(() => own);
    const got = p.window.fetch('/api') as typeof own;
    expect(got).toBe(own);
    expect(got.cancel()).toBe('cancel ok');
    const reason = new TypeError('Failed to fetch');
    // Noting the outcome never throws back into the promise chain.
    expect(caught(() => handlers[1]!(reason))).toBeUndefined();
    expect(caught(() => handlers[0]!(res))).toBeUndefined();
    expect(p.events('Network.loadingFailed')).toHaveLength(1);
    await expect(
      (() => {
        p.setFetch(() => Promise.reject(reason));
        return p.window.fetch('/api');
      })(),
    ).rejects.toBe(reason);
    expect(p.thrown).toEqual([]);
  });

  it('fetch: an error reporter that wrapped it since keeps its wrapper, and each call reaches the app once', () => {
    const p = linked();
    p.cdp('Network.enable');
    const ours = p.window.fetch;
    const reporter = function (this: unknown, ...a: unknown[]) {
      return ours.apply(this, a);
    };
    p.window.fetch = reporter;
    p.cdp('Network.disable');
    expect(p.window.fetch).toBe(reporter);
    p.cdp('Network.enable');
    const n = p.net.length;
    void p.window.fetch('/api');
    expect(p.net.length).toBe(n + 1);
    expect(p.events('Network.requestWillBeSent')).toHaveLength(1);
  });

  it('XHR: the same return value and this when noting fails, the same exception from the app, and nothing the app can see', () => {
    const p = linked();
    p.cdp('Network.enable');
    const X = p.ctx.XMLHttpRequest as new () => Record<string, Fn> & { listeners: [string, Fn][] };
    const x = new X();
    expect(x.open!('GET', '/data')).toBe('ret-open');
    expect(x.setRequestHeader!('a', 'b')).toBe('ret-setRequestHeader');
    expect(Object.keys(x)).not.toContain('__teleportReq');
    expect(x.send!()).toBe('ret-send');
    for (const [, f] of x.listeners) f.call(x, {});
    expect(p.events('Network.responseReceived')).toHaveLength(1);
    expect(p.net.map((c) => [c.what, c.self === x])).toEqual([
      ['open', true],
      ['setRequestHeader', true],
      ['send', true],
    ]);

    (p.ctx.document as Record<string, unknown>).createElement = () => {
      throw new Error('odd engine');
    };
    const y = new X();
    expect(y.open!('GET', '/data')).toBe('ret-open');
    expect(y.send!('body')).toBe('ret-send');
    expect(p.net.at(-1)).toEqual({ what: 'send', self: y, args: ['body'] });

    const boom = new DOMException('app', 'InvalidStateError');
    p.failures.send = boom;
    expect(caught(() => y.send!())).toBe(boom);
    expect(p.thrown).toEqual([]);
    expect(p.consoleCalls).toEqual([]);
  });
});
