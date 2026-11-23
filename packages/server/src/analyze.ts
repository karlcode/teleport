// Everything the agent doesn't compute: the agent ships raw timestamps and counters, and this
// module turns a window of them into a report (`q capture`); perfpanel.ts turns them into a trace.
// All times are the agent's clock in ms unless a name says otherwise.
import { STREAMS, type Frame } from '@teleport/protocol';
import { quantile } from '@teleport/stats';

/** Columns per stream, keyed by stream name. Every stream has a `t` column. */
export type Timeline = Record<string, Record<string, number[]>>;

/** A request the teleport server served to the device, as seen on the laptop (server clock, epoch ms). */
export interface NetRecord {
  id: string;
  method: string;
  url: string;
  status: number;
  type: string;
  mimeType: string;
  start: number;
  ttfb: number;
  end: number;
  bytes: number;
  failed?: string;
}

export function emptyTimeline(): Timeline {
  const tl: Timeline = {};
  for (const s of STREAMS) tl[s.name] = Object.fromEntries(s.fields.map((f) => [f, []]));
  return tl;
}

export function appendFrame(tl: Timeline, f: Frame) {
  for (const s of f.streams) {
    const cols = tl[s.name]!;
    for (const [name, values] of Object.entries(s.columns)) {
      const out = cols[name]!;
      for (let i = 0; i < values.length; i++) out.push(values[i]!);
    }
  }
}

/** Drops records older than `before` so a long session's live view stays bounded. */
export function trimTimeline(tl: Timeline, before: number) {
  for (const cols of Object.values(tl)) {
    const t = cols.t!;
    let n = 0;
    while (n < t.length && t[n]! < before) n++;
    if (n > 0) for (const c of Object.values(cols)) c.splice(0, n);
  }
}

function range(t: number[], from: number, to: number): [number, number] {
  let a = 0;
  while (a < t.length && t[a]! < from) a++;
  let b = a;
  while (b < t.length && t[b]! < to) b++;
  return [a, b];
}

function pick(cols: Record<string, number[]>, from: number, to: number) {
  const [a, b] = range(cols.t!, from, to);
  return Object.fromEntries(Object.entries(cols).map(([k, v]) => [k, v.slice(a, b)])) as Record<string, number[]>;
}

const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const q = (xs: number[], p: number) => (xs.length ? round(quantile(xs, p)) : null);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** Animation frames further apart than this belong to different captures. */
const FRAME_GAP_MS = 1000;

export function frameIntervals(t: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < t.length; i++) {
    const d = t[i]! - t[i - 1]!;
    if (d < FRAME_GAP_MS) out.push(d);
  }
  return out;
}

export interface Report {
  from: number;
  to: number;
  seconds: number;
  frames: { count: number; fps: number; p50Ms: number | null; p95Ms: number | null; p99Ms: number | null; maxMs: number | null; over33Ms: number; over50Ms: number } | null;
  longTasks: { count: number; totalMs: number; maxMs: number; msPerS: number };
  lag: { p50Ms: number | null; p95Ms: number | null; maxMs: number | null };
  input: { keys: number; p50Ms: number | null; p95Ms: number | null; maxMs: number | null; noFrame: number } | null;
  video: { el: number; decodedPerS: number; droppedPerS: number; dropPct: number }[];
  heap: { usedMB: number; minMB: number; maxMB: number; mbPerMin: number } | null;
  overhead: { pct: number; workMs: number } | null;
  resources: { count: number; bytes: number; slowest: { name: string; durMs: number; ttfbMs: number | null }[] };
  /** The raw record a vsync lattice is drawn from, in ms from `from`: animation frames, long tasks as [start, duration], key presses. Null without frames. */
  vsync: { frames: number[]; tasks: [number, number][]; keys: number[] } | null;
  /** Set when the page went away before the capture ended: the report covers only what was recorded. */
  cutShort?: { askedS: number; why: string };
}

/** Summarizes [from, to) of the agent's clock. `names` resolves resource name ids. */
export function report(tl: Timeline, from: number, to: number, names: string[] = []): Report {
  const seconds = (to - from) / 1000;
  const fr = pick(tl.frame!, from, to);
  const iv = frameIntervals(fr.t!);
  const lt = pick(tl.longtask!, from, to);
  const lag = pick(tl.lag!, from, to);
  const inp = pick(tl.input!, from, to);
  const heap = pick(tl.heap!, from, to);
  const ov = pick(tl.overhead!, from, to);
  const res = pick(tl.resource!, from, to);
  const vid = pick(tl.video!, from, to);

  const keyMs = inp.toFrameMs!.filter((x) => x >= 0);
  const work = sum(ov.workMs!);
  const win = sum(ov.windowMs!);

  const video: Report['video'] = [];
  for (const el of new Set(vid.el)) {
    const idx = vid.el!.map((e, i) => (e === el ? i : -1)).filter((i) => i >= 0);
    const a = idx[0]!;
    const b = idx[idx.length - 1]!;
    const dt = (vid.t![b]! - vid.t![a]!) / 1000;
    const decoded = vid.decoded![b]! - vid.decoded![a]!;
    const dropped = vid.dropped![b]! - vid.dropped![a]!;
    video.push({ el, decodedPerS: dt > 0 ? round(decoded / dt) : 0, droppedPerS: dt > 0 ? round(dropped / dt) : 0, dropPct: decoded + dropped > 0 ? round((100 * dropped) / (decoded + dropped)) : 0 });
  }

  const used = heap.used!.map((b) => b / 1048576);
  const heapDt = heap.t!.length > 1 ? (heap.t![heap.t!.length - 1]! - heap.t![0]!) / 60000 : 0;

  const order = res.durMs!.map((_, i) => i).sort((a, b) => res.durMs![b]! - res.durMs![a]!);

  return {
    from,
    to,
    seconds: round(seconds),
    frames: fr.t!.length
      ? {
          count: fr.t!.length,
          fps: iv.length ? round(1000 / (sum(iv) / iv.length)) : 0,
          p50Ms: q(iv, 0.5),
          p95Ms: q(iv, 0.95),
          p99Ms: q(iv, 0.99),
          maxMs: iv.length ? round(Math.max(...iv)) : null,
          over33Ms: iv.filter((x) => x > 33.4).length,
          over50Ms: iv.filter((x) => x > 50).length,
        }
      : null,
    longTasks: {
      count: lt.t!.length,
      totalMs: round(sum(lt.durMs!)),
      maxMs: lt.durMs!.length ? round(Math.max(...lt.durMs!)) : 0,
      msPerS: seconds > 0 ? round(sum(lt.durMs!) / seconds) : 0,
    },
    lag: { p50Ms: q(lag.lagMs!, 0.5), p95Ms: q(lag.lagMs!, 0.95), maxMs: lag.lagMs!.length ? round(Math.max(...lag.lagMs!)) : null },
    input: inp.t!.length
      ? { keys: inp.t!.length, p50Ms: q(keyMs, 0.5), p95Ms: q(keyMs, 0.95), maxMs: keyMs.length ? round(Math.max(...keyMs)) : null, noFrame: inp.t!.length - keyMs.length }
      : null,
    video,
    heap: used.length
      ? { usedMB: round(used[used.length - 1]!), minMB: round(Math.min(...used)), maxMB: round(Math.max(...used)), mbPerMin: heapDt > 0 ? round((used[used.length - 1]! - used[0]!) / heapDt) : 0 }
      : null,
    overhead: win > 0 ? { pct: round((100 * work) / win, 3), workMs: round(work) } : null,
    resources: {
      count: res.t!.length,
      bytes: sum(res.bytes!),
      slowest: order.slice(0, 5).map((i) => ({
        name: names[res.name![i]!] ?? '(name table full)',
        durMs: round(res.durMs![i]!),
        ttfbMs: res.ttfbMs![i]! >= 0 ? round(res.ttfbMs![i]!) : null,
      })),
    },
    vsync: fr.t!.length ? { frames: fr.t!.map((t) => round(t - from)), tasks: lt.t!.map((t, i) => [round(t - from), round(lt.durMs![i]!)] as [number, number]), keys: inp.t!.map((t) => round(t - from)) } : null,
  };
}
