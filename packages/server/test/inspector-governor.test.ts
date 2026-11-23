// What the inspector costs a weak device is bounded by construction, not by how fast the device is:
// answering DevTools takes at most a share of the main thread, code the laptop asks the page to run
// is the page's own time, and when the governor stops the console, what the page threw still goes.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { Expander } from '../src/expand.js';

const INSPECTOR = fileURLToPath(new URL('../../inspector/src/index.js', import.meta.url));
const js = (await build({ entryPoints: [INSPECTOR], bundle: true, write: false, format: 'iife', target: 'es5', logLevel: 'error' })).outputFiles[0]!.text;

type Fn = (...a: unknown[]) => unknown;
interface Msg {
  id?: number;
  method?: string;
  params?: { type?: string; args?: { value?: unknown }[]; level?: number; reason?: string; costPct?: number; droppedConsole?: number };
  result?: unknown;
}

/** A device page with the inspector linked. `step`: ms every clock read takes, so work costs time. */
function dut() {
  let clock = 0;
  let step = 0;
  let seq = 0;
  const heap = { usedJSHeapSize: 10, jsHeapSizeLimit: 100 };
  const timers = new Map<number, { at: number; fn: () => void }>();
  const sent: Msg[] = [];
  const expander = new Expander();
  const watch = { observed: 0, disconnects: 0 };
  const listeners: [string, Fn][] = [];
  let socket: { onmessage: Fn | null; onopen: Fn | null; readyState: number } | null = null;
  class FakeSocket {
    readyState = 0;
    bufferedAmount = 0;
    onopen: Fn | null = null;
    onclose: Fn | null = null;
    onmessage: Fn | null = null;
    constructor(public url: string) {
      socket = this;
    }
    send(s: string) {
      for (const line of s.split('\n')) {
        // As the laptop reads it: the inspector's short messages are the protocol's again.
        const read = JSON.parse(line) as (Msg & { teleport?: string }) | unknown[];
        for (const m of Array.isArray(read) ? (expander.expand(read) as Msg[]) : [read]) if (!(m as { teleport?: string }).teleport) sent.push(m);
      }
    }
    close() {
      this.readyState = 3;
    }
  }
  const appConsole: Record<string, Fn> = {};
  for (const name of ['log', 'info', 'warn', 'error', 'debug']) appConsole[name] = () => undefined;
  const ctx: Record<string, unknown> = {
    WebSocket: FakeSocket,
    console: appConsole,
    location: new URL('http://device.example/app'),
    document: { nodeType: 9, nodeName: '#document', URL: 'http://device.example/app', compatMode: 'CSS1Compat', firstChild: null, currentScript: { src: 'http://127.0.0.1:7700/__teleport/inspector.js?id=t1' }, styleSheets: [], addEventListener: () => {}, removeEventListener: () => {}, querySelectorAll: () => [], getElementsByTagName: () => [] },
    MutationObserver: class {
      observe() {
        watch.observed++;
      }
      disconnect() {
        watch.disconnects++;
      }
    },
    performance: { now: () => (clock += step), memory: heap },
    setTimeout: (fn: () => void, ms?: number) => (timers.set(++seq, { at: clock + (ms ?? 0), fn }), seq),
    clearTimeout: (id: number) => timers.delete(id),
    addEventListener: (t: string, f: Fn) => listeners.push([t, f]),
    removeEventListener: () => {},
    work: (ms: number) => void (clock += ms),
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
      next[1].fn();
    }
    clock = Math.max(clock, end);
  };
  const say = (m: object) => socket!.onmessage!({ data: JSON.stringify(m) });
  socket!.readyState = 1;
  socket!.onopen!({});
  say({ teleport: 'link', got: 0, kept: false });
  let id = 0;
  const ask = (method: string, params: object = {}) => (say({ id: ++id, method, params }), id);
  return {
    sent,
    watch,
    heap,
    advance,
    ask,
    console: appConsole,
    fire: (type: string, e: object) => listeners.filter((l) => l[0] === type).forEach((l) => l[1](e)),
    replies: () => sent.filter((m) => m.id !== undefined).length,
    logged: () => sent.filter((m) => m.method === 'Runtime.consoleAPICalled' && !String(m.params?.args?.[0]?.value).startsWith('teleport:')).map((m) => `${m.params!.type}:${String(m.params!.args?.[0]?.value)}`),
    marks: () => sent.filter((m) => m.method === 'teleport.mark').map((m) => m.params!),
    levels: () => sent.filter((m) => m.method === 'teleport.governor').map((m) => m.params!.level),
    now: () => clock,
    setStep: (ms: number) => void (step = ms),
  };
}

describe("what answering DevTools may take of a device's main thread", () => {
  it('answers a burst in short slices, resting between them so the app runs', () => {
    const p = dut();
    p.setStep(3);
    const t0 = p.now();
    for (let i = 0; i < 40; i++) p.ask('Log.enable');
    p.advance(0);
    // One slice: a few answers, not forty in one long task.
    expect(p.replies()).toBeGreaterThan(0);
    expect(p.replies()).toBeLessThan(8);
    for (let i = 0; i < 200 && p.replies() < 40; i++) p.advance(10);
    expect(p.replies()).toBe(40);
    // Forty answers of 3 ms each are 120 ms of work; at a 30% share they take at least 400 ms.
    expect(p.now() - t0).toBeGreaterThan(400);
  });

  it('answers at once on a device that is fast enough for it not to matter', () => {
    const p = dut();
    for (let i = 0; i < 40; i++) p.ask('Log.enable');
    p.advance(0);
    expect(p.replies()).toBe(40);
  });

  it("does not count code the laptop asks the page to run as the inspector's, nor rest for it", () => {
    const p = dut();
    for (let i = 0; i < 5; i++) p.ask('Runtime.evaluate', { expression: 'work(400)' });
    p.advance(0);
    expect(p.replies()).toBe(5);
    p.advance(1000);
    expect(p.levels()).toEqual([]);
    expect(p.marks().at(-1)!.costPct).toBeLessThan(1);
  });
});

describe('what still reaches the laptop while the governor has the console stopped', () => {
  const surviving = () => {
    const p = dut();
    p.ask('Runtime.enable');
    p.heap.usedJSHeapSize = 90;
    p.advance(1000);
    expect(p.levels()).toEqual([2]);
    return p;
  };

  it('drops what the page logs and counts it, and keeps what it logs as an error or throws', () => {
    const p = surviving();
    p.console.log!('chatter');
    p.console.error!('rails failed');
    p.fire('error', { message: 'Uncaught TypeError: x', filename: 'http://device.example/app.js', lineno: 1, colno: 1 });
    p.advance(1000);
    expect(p.logged()).toEqual(['error:rails failed']);
    expect(p.sent.filter((m) => m.method === 'Runtime.exceptionThrown')).toHaveLength(1);
    expect(p.marks().at(-1)!.droppedConsole).toBe(1);
  });

  it('lets through only a few errors a second from a page that throws in a loop', () => {
    const p = surviving();
    for (let i = 0; i < 500; i++) p.console.error!(`e${i}`);
    p.advance(0);
    expect(p.logged()).toHaveLength(10);
    p.advance(1000);
    p.console.error!('later');
    p.advance(0);
    expect(p.logged().at(-1)).toBe('error:later');
  });
});

describe('watching the DOM of a device that cannot carry it', () => {
  it('stops watching while surviving, and has DevTools fetch the tree again once the page is calm', () => {
    const p = dut();
    p.ask('teleport.snapshot');
    p.advance(0);
    expect(p.watch.observed).toBe(1);
    const before = p.watch.disconnects;
    p.heap.usedJSHeapSize = 90;
    p.advance(1000);
    expect(p.levels()).toEqual([2]);
    expect(p.watch.disconnects).toBe(before + 1);
    expect(p.sent.some((m) => m.method === 'teleport.stale')).toBe(false);
    p.heap.usedJSHeapSize = 10;
    p.advance(6000);
    expect(p.levels()).toEqual([2, 1]);
    expect(p.sent.filter((m) => m.method === 'teleport.stale')).toHaveLength(1);
  });
});

describe('a second that costs too much', () => {
  it('stops the console at once when reporting the page passes its budget, without waiting for the tick', () => {
    const p = dut();
    p.ask('Runtime.enable');
    p.advance(10);
    p.setStep(2);
    for (let i = 0; i < 200 && !p.levels().length; i++) p.console.log!('line ' + i);
    p.setStep(0);
    p.advance(0);
    expect(p.levels()).toEqual([2]);
    expect(p.now()).toBeLessThan(1000);
  });
});
