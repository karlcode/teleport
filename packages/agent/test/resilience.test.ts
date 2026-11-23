import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { decodeFrame } from '@teleport/protocol';

const INDEX = fileURLToPath(new URL('../src/index.js', import.meta.url));
const URL_ = 'ws://127.0.0.1:7070/ws/target';

const js = (
  await build({ entryPoints: [INDEX], bundle: true, write: false, format: 'iife', target: 'es5', logLevel: 'error' })
).outputFiles[0]!.text;

/** The agent on a fake page: a manual clock, timers and WebSockets the test drives. */
function page(perf: object = {}) {
  let clock = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const sockets: FakeSocket[] = [];
  const errors: string[] = [];
  class FakeSocket {
    readyState = 0;
    bufferedAmount = 0;
    sent: unknown[] = [];
    onopen: ((e: object) => void) | null = null;
    onclose: ((e: object) => void) | null = null;
    constructor(public url: string) {
      sockets.push(this);
    }
    send(d: unknown) {
      if (this.readyState !== 1) throw new Error('InvalidStateError');
      this.sent.push(d);
    }
    close() {
      if (this.readyState < 2) this.readyState = 2;
    }
    open() {
      this.readyState = 1;
      this.onopen?.call(this, {});
    }
    fireClose(code = 1006) {
      this.readyState = 3;
      this.onclose?.call(this, { code });
    }
  }
  const performance = Object.defineProperties({ now: () => clock }, Object.getOwnPropertyDescriptors(perf));
  const ctx: Record<string, unknown> = {
    WebSocket: FakeSocket, ArrayBuffer, DataView, Float64Array, Float32Array, Uint8Array, Uint16Array, Uint32Array, Math, Date, String, Array, Object,
    performance,
    setTimeout: (fn: () => void, ms?: number) => (timers.set(++seq, { at: clock + (ms ?? 0), fn }), seq),
    clearTimeout: (id: number) => timers.delete(id),
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
      try {
        next[1].fn();
      } catch (e) {
        errors.push(String(e));
      }
    }
    clock = end;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { api: ctx.teleport as any, sockets, timers, errors, advance };
}

describe('agent fault tolerance', () => {
  it('keeps ticking after a sampler throws on an odd engine', () => {
    let reads = 0;
    const p = page({
      get memory() {
        if (++reads === 4) throw new Error('odd engine');
        return { usedJSHeapSize: 1, totalJSHeapSize: 2 };
      },
    });
    p.api.init({ url: URL_ });
    p.sockets[0]!.open();
    p.advance(10000);
    expect(p.api.status().ticks).toBe(10);
  });

  it('keeps ticking when send() throws', () => {
    const p = page();
    p.api.init({ url: URL_ });
    const s = p.sockets[0]!;
    s.open();
    s.send = () => {
      throw new Error('closed');
    };
    p.advance(5000);
    expect(p.api.status().ticks).toBe(5);
    expect(p.errors).toEqual([]);
  });

  it('ignores a late close from a socket it already replaced', () => {
    const p = page();
    p.api.init({ url: URL_ });
    const old = p.sockets[0]!;
    old.open();
    p.api.stop();
    p.api.init({ url: URL_ });
    p.sockets[1]!.open();
    old.fireClose(1000);
    const before = p.api.status().framesSent;
    p.advance(5000);
    expect(p.api.status().framesSent - before).toBe(5);
  });

  it('never has two live sockets, even if stopped and restarted while a retry is pending', () => {
    const p = page();
    p.api.init({ url: URL_ });
    p.sockets[0]!.fireClose();
    p.api.stop();
    p.api.init({ url: URL_ });
    for (let k = 0; k < 60; k++) {
      p.advance(1000);
      expect(p.sockets.filter((s) => s.readyState < 2).length).toBeLessThanOrEqual(1);
    }
  });

  it('replaces a socket that hangs while connecting', () => {
    const p = page();
    p.api.init({ url: URL_ });
    p.advance(60000);
    expect(p.sockets.length).toBeGreaterThan(1);
    expect(p.sockets.filter((s) => s.readyState < 2).length).toBeLessThanOrEqual(1);
  });

  it('replaces an open socket whose send buffer never drains', () => {
    const p = page();
    p.api.init({ url: URL_ });
    p.sockets[0]!.open();
    p.sockets[0]!.bufferedAmount = 1e6;
    p.advance(60000);
    expect(p.sockets[0]!.readyState).toBeGreaterThanOrEqual(2);
    expect(p.sockets.length).toBeGreaterThan(1);
  });

  it('backs off while the laptop is away, and stops after being replaced by another page (4000)', () => {
    const p = page();
    p.api.init({ url: URL_ });
    p.sockets[0]!.fireClose();
    p.advance(200000);
    // 5 s doubling to 30 s, instead of one attempt every 5 s (40).
    expect(p.sockets.length).toBeLessThan(15);
    const q = page();
    q.api.init({ url: URL_ });
    q.sockets[0]!.open();
    q.sockets[0]!.fireClose(4000);
    q.advance(60000);
    expect(q.sockets.length).toBe(1);
  });

  it('sends the whole backlog in one decodable frame when the link comes back', () => {
    const p = page({ memory: { usedJSHeapSize: 5, totalJSHeapSize: 9, jsHeapSizeLimit: 1e10 } });
    p.api.init({ url: URL_ });
    p.sockets[0]!.fireClose();
    p.advance(200000);
    let live;
    while (!(live = p.sockets.find((s) => s.readyState === 0))) p.advance(1000);
    live.open();
    p.advance(1000);
    const f = decodeFrame(live.sent.find((d) => typeof d !== 'string') as Uint8Array);
    const s = Object.fromEntries(f.streams.map((x) => [x.name, x]));
    // Streams encoded last no longer starve behind the ones before them.
    expect(s.overhead!.count).toBe(120);
    expect(s.link!.count).toBe(120);
    expect(s.link!.columns.heapLimit![0]).toBe(4294967295);
  });

  it('reports how late its timer fired: 0 when on time, not minus a tick', () => {
    const p = page();
    p.api.init({ url: URL_ });
    p.sockets[0]!.open();
    p.advance(3000);
    const lags = p.sockets[0]!.sent
      .filter((d) => typeof d !== 'string')
      .flatMap((d) => decodeFrame(d as Uint8Array).streams.filter((x) => x.name === 'lag').flatMap((x) => Array.from(x.columns.lagMs!)));
    expect(lags.length).toBeGreaterThan(0);
    for (const ms of lags) expect(ms).toBe(0);
  });

  it('leaves no timers behind after stop()', () => {
    const p = page();
    p.api.init({ url: URL_ });
    p.sockets[0]!.fireClose();
    p.api.stop();
    expect(p.timers.size).toBe(0);
  });

  it('bounds the memory interned names can hold', () => {
    const entries: object[] = [];
    for (let i = 0; i < 300; i++) entries.push({ name: `http://ads.example/b?${i}&${'x'.repeat(8000)}`, startTime: i, duration: 1, responseStart: 0, initiatorType: 'img' });
    const p = page({ getEntriesByType: () => entries });
    p.api.init({ url: URL_ });
    p.sockets[0]!.open();
    p.advance(6000);
    const names = p.sockets[0]!.sent.filter((d): d is string => typeof d === 'string' && d.startsWith('name '));
    expect(names.length).toBe(300);
    for (const n of names) expect(n.length).toBeLessThan(600);
  });
});
