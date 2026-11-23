// An app that throws while it starts never reaches DevTools, so the agent itself hears the page's
// uncaught errors from its first line and tells the laptop, with or without a link at the time.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const INDEX = fileURLToPath(new URL('../src/index.js', import.meta.url));
const js = (await build({ entryPoints: [INDEX], bundle: true, write: false, format: 'iife', target: 'es5', logLevel: 'error' })).outputFiles[0]!.text;

type Listener = (e: object) => void;

function page() {
  let clock = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const sockets: FakeSocket[] = [];
  const listeners: { type: string; fn: Listener; capture: boolean }[] = [];
  class FakeSocket {
    readyState = 0;
    bufferedAmount = 0;
    sent: unknown[] = [];
    onopen: ((e: object) => void) | null = null;
    constructor(public url: string) {
      sockets.push(this);
    }
    send(d: unknown) {
      this.sent.push(d);
    }
    close() {
      this.readyState = 3;
    }
    open() {
      this.readyState = 1;
      this.onopen?.call(this, {});
    }
    get text() {
      return this.sent.filter((d): d is string => typeof d === 'string' && d.startsWith('err'));
    }
  }
  const ctx: Record<string, unknown> = {
    WebSocket: FakeSocket, ArrayBuffer, DataView, Float64Array, Float32Array, Uint8Array, Uint16Array, Uint32Array, Math, Date, String, Array, Object, JSON,
    performance: { now: () => clock },
    setTimeout: (fn: () => void, ms?: number) => (timers.set(++seq, { at: clock + (ms ?? 0), fn }), seq),
    clearTimeout: (id: number) => timers.delete(id),
    addEventListener: (type: string, fn: Listener, capture?: boolean) => listeners.push({ type, fn, capture: !!capture }),
    removeEventListener: (type: string, fn: Listener) => {
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn);
      if (i >= 0) listeners.splice(i, 1);
    },
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
    clock = end;
  };
  /** The page fires an event at window; anything a listener throws would reach the app. */
  const fire = (type: string, e: object) => {
    for (const l of [...listeners]) if (l.type === type) l.fn(e);
  };
  const throws = (message: string, extra: object = {}) => fire('error', { target: ctx, message, filename: 'http://device/app.js', lineno: 3, colno: 9, error: { message, stack: `Error: ${message}\n    at main (http://device/app.js:3:9)` }, ...extra });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { api: ctx.teleport as any, sockets, listeners, advance, fire, throws };
}

const parsed = (lines: string[]) => lines.filter((l) => l.startsWith('err ')).map((l) => JSON.parse(l.slice(4)) as [number, number, string, string, string, number, number, string]);

describe("the page's uncaught errors", () => {
  it('listens only once started, and stops listening when stopped', () => {
    const p = page();
    const mine = () => p.listeners.filter((l) => l.type === 'error' || l.type === 'unhandledrejection').map((l) => [l.type, l.capture]);
    expect(mine()).toEqual([]);
    p.api.init({ url: 'ws://laptop:7070/ws/target' });
    expect(mine()).toEqual([['error', true], ['unhandledrejection', false]]);
    p.api.stop();
    expect(mine()).toEqual([]);
  });

  it('keeps what the app threw before the laptop was reachable and sends it when the link opens', () => {
    const p = page();
    p.api.init({ url: 'ws://laptop:7070/ws/target' });
    p.advance(120);
    p.throws('main is not defined');
    p.sockets[0]!.open();
    const [e] = parsed(p.sockets[0]!.text);
    expect(e).toEqual([0, 120, 'e', 'main is not defined', 'http://device/app.js', 3, 9, 'Error: main is not defined\n    at main (http://device/app.js:3:9)']);
    expect(p.sockets[0]!.text.at(-1)).toBe('errs 1');
  });

  it('sends an error at once on an open link, and a script that did not load, and a rejection', () => {
    const p = page();
    p.api.init({ url: 'ws://laptop:7070/ws/target' });
    p.sockets[0]!.open();
    p.throws('boom');
    p.fire('error', { target: { tagName: 'SCRIPT', src: 'http://device/vendor.js' } });
    p.fire('error', { target: { tagName: 'IMG', src: 'http://device/poster.jpg' } });
    p.fire('unhandledrejection', { reason: { message: 'no rails', stack: 'Error: no rails' } });
    p.fire('unhandledrejection', { reason: 'plain' });
    expect(parsed(p.sockets[0]!.text).map((e) => [e[0], e[2], e[3], e[4]])).toEqual([
      [0, 'e', 'boom', 'http://device/app.js'],
      [1, 'r', 'script', 'http://device/vendor.js'],
      [2, 'p', 'no rails', ''],
      [3, 'p', 'plain', ''],
    ]);
  });

  it('holds the first 8 and the last 8 of a page that throws in a loop, sends the rest once a tick, and counts them all', () => {
    const p = page();
    p.api.init({ url: 'ws://laptop:7070/ws/target' });
    const s = p.sockets[0]!;
    s.open();
    for (let i = 0; i < 100; i++) p.throws(`e${i}`);
    expect(parsed(s.text).map((e) => e[0])).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    p.advance(1000);
    expect(parsed(s.text).map((e) => e[0])).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 92, 93, 94, 95, 96, 97, 98, 99]);
    expect(s.text.at(-1)).toBe('errs 100');
    expect(p.api.status().errors).toBe(100);
    const n = s.text.length;
    p.advance(3000);
    expect(s.text.length).toBe(n);
  });

  it('clips long text, and never throws into the app whatever the event holds', () => {
    const p = page();
    p.api.init({ url: 'ws://laptop:7070/ws/target' });
    p.sockets[0]!.open();
    p.throws('x'.repeat(5000));
    const hostile = { get target(): never { throw new Error('odd engine'); } };
    expect(() => p.fire('error', hostile)).not.toThrow();
    expect(() => p.fire('unhandledrejection', { get reason(): never { throw new Error('odd'); } })).not.toThrow();
    expect(() => p.fire('error', { target: null, message: undefined, error: null })).not.toThrow();
    expect(parsed(p.sockets[0]!.text)[0]![3]).toHaveLength(300);
  });
});
