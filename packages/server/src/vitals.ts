// What the console shows about a device, derived on the laptop from records it already holds: the last
// key presses and how long each took to reach the screen, where the heap is heading, and how
// blocked the main thread has been. Pure, so the numbers are tested without a device.
//
// vitalsOf runs once per sample, about once a second per device, and the console draws its row from the
// result however often it redraws. alarms runs in the same pass and says when a sample crossed one of
// the higher bars that are worth a line in the log.
import type { Timeline } from './analyze.js';
import type { Point } from './live.js';
import { keyWord } from './hear.js';
import { G } from './tui.js';

/**
 * A remote key's name by its key code, as devices send them (hear.ts knows each platform's). Left and
 * right are words, as the remote's KEYS ids are: → is tlpt's notation for key → frame, so a Right
 * press drawn as 'key → 401 ms' would read as that, with no key named. ↑ and ↓ read as keys, and
 * keep the row narrow enough for its key cell at 100 columns.
 */
export const keyName = (code: number) => {
  const w = keyWord(code);
  return w === 'up' ? G.up : w === 'down' ? G.down : w.startsWith('key ') ? `#${code}` : w;
};

export interface Press {
  /** Agent clock, ms. */
  t: number;
  key: string;
  /** Key press to the next painted frame, ms; null when no frame came. */
  toFrameMs: number | null;
  /** Time in the page's own key handlers, where the press was probed. */
  handlersMs: number | null;
  /** Where focus landed, as the agent names elements. */
  target: string | null;
}

/** The last `n` key presses, newest first. */
export function presses(tl: Timeline, names: string[], n: number): Press[] {
  const inp = tl.input!;
  const t = inp.t!;
  const out: Press[] = [];
  for (let i = t.length - 1; i >= 0 && out.length < n; i--) {
    const at = t[i]!;
    const ms = inp.toFrameMs![i]!;
    out.push({ t: at, key: keyName(inp.keyCode![i]!), toFrameMs: ms >= 0 ? ms : null, handlersMs: near(tl.keyphase!, 'handlers', at), target: nameNear(tl.keytarget!, at, names) });
  }
  return out;
}

function near(cols: Record<string, number[]>, field: string, t: number): number | null {
  const ts = cols.t!;
  for (let j = ts.length - 1; j >= 0; j--) {
    if (Math.abs(ts[j]! - t) < 0.5) {
      const v = cols[field]![j]!;
      return v >= 0 ? v : null;
    }
    if (ts[j]! < t - 1) break;
  }
  return null;
}

function nameNear(cols: Record<string, number[]>, t: number, names: string[]): string | null {
  const ts = cols.t!;
  for (let j = ts.length - 1; j >= 0; j--) {
    if (Math.abs(ts[j]! - t) < 0.5) {
      const id = cols.landing![j]! !== 65535 ? cols.landing![j]! : cols.target![j]!;
      return names[id] ?? null;
    }
    if (ts[j]! < t - 1) break;
  }
  return null;
}

export interface HeapTrend {
  /** MB a minute, from the floor of the heap (its lowest point in each 15 s), so garbage that comes and goes doesn't read as growth. */
  mbPerMin: number;
  /** Minutes until the floor reaches the engine's limit at this rate; null when it isn't rising or the limit isn't known. */
  fullInMin: number | null;
}

const BUCKET_MS = 15_000;
const TREND_MS = 120_000;
const MIN_TREND_MS = 60_000;

/** Where the heap is heading, once there is a minute of samples; null before, or without heap readings. */
export function heapTrend(points: Point[]): HeapTrend | null {
  const last = points[points.length - 1];
  if (!last || last.heapMB === null) return null;
  const from = last.t - TREND_MS;
  const floors = new Map<number, { t: number; mb: number }>();
  for (const p of points) {
    if (p.t < from || p.heapMB === null) continue;
    const b = Math.floor(p.t / BUCKET_MS);
    const f = floors.get(b);
    if (!f || p.heapMB < f.mb) floors.set(b, { t: p.t, mb: p.heapMB });
  }
  const pts = [...floors.values()];
  if (pts.length < 3 || pts[pts.length - 1]!.t - pts[0]!.t < MIN_TREND_MS) return null;
  // Least squares over the floors.
  const n = pts.length;
  const mt = pts.reduce((a, p) => a + p.t, 0) / n;
  const mm = pts.reduce((a, p) => a + p.mb, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of pts) {
    num += (p.t - mt) * (p.mb - mm);
    den += (p.t - mt) ** 2;
  }
  const mbPerMin = den > 0 ? (num / den) * 60_000 : 0;
  const fullInMin = mbPerMin > 0 && last.heapLimitMB ? Math.max(0, (last.heapLimitMB - last.heapMB) / mbPerMin) : null;
  return { mbPerMin, fullInMin };
}

/** The main thread over the last `seconds`: the worst timer lag and all long-task time. */
export function mainWindow(points: Point[], seconds = 10): { lagMs: number | null; longTaskMs: number; longTasks: number } {
  const recent = points.slice(-seconds);
  let lag: number | null = null;
  let longTaskMs = 0;
  let longTasks = 0;
  for (const p of recent) {
    if (p.lagMs !== null) lag = Math.max(lag ?? 0, p.lagMs);
    longTaskMs += p.longTaskMs;
    longTasks += p.longTasks;
  }
  return { lagMs: lag, longTaskMs, longTasks };
}

/** How blocked the main thread was in a second: long-task time, or timer lag where it says more (and on engines without long tasks). */
export const blockedMs = (p: Point) => Math.max(p.longTaskMs, p.lagMs ?? 0);

/** Seconds of main-thread blocking the console's row draws. */
export const SPARK_SECONDS = 16;

/** The part of a page's recording the console reads; the server's Session has it. */
export interface Recording {
  points: Point[];
  timeline: Timeline;
  /** Epoch ms of the last frame from the device; 0 before the first. */
  lastFrameAt: number;
  meta: { rttMs: number | null; names: string[] };
}

/** One device's numbers as of its last sample, for its row in the console. */
export interface Vitals {
  /** Agent clock of the last sample. */
  t: number;
  /** blockedMs for each of the last SPARK_SECONDS samples, oldest first. */
  blocked: number[];
  heapMB: number | null;
  heapLimitMB: number | null;
  trend: HeapTrend | null;
  /** The last key press on this page. */
  press: Press | null;
  /** The worst video frames dropped a second over the last 3 s of playback; null when nothing played. */
  videoDroppedPerS: number | null;
  rttMs: number | null;
  /** What waits on the device's sockets to the laptop, KB. */
  backlogKB: number | null;
  devtoolsLagMs: number | null;
  /** Frames a second; only during a capture. */
  fps: number | null;
}

/** A page's vitals as of its last sample; null before the first. Linear in the 300 points it keeps, at most. */
export function vitalsOf(r: Recording): Vitals | null {
  const ps = r.points;
  const last = ps[ps.length - 1];
  if (!last) return null;
  let video: number | null = null;
  for (const p of ps.slice(-3)) if (p.videoDecodedPerS && p.videoDroppedPerS !== null) video = Math.max(video ?? 0, p.videoDroppedPerS);
  return {
    t: last.t,
    blocked: ps.slice(-SPARK_SECONDS).map(blockedMs),
    heapMB: last.heapMB,
    heapLimitMB: last.heapLimitMB,
    trend: heapTrend(ps),
    press: presses(r.timeline, r.meta.names, 1)[0] ?? null,
    videoDroppedPerS: video,
    rttMs: r.meta.rttMs,
    backlogKB: last.agentQueuedKB === null && last.inspectorQueuedKB === null ? null : (last.agentQueuedKB ?? 0) + (last.inspectorQueuedKB ?? 0),
    devtoolsLagMs: last.devtoolsLagMs,
    fps: last.fps,
  };
}

// The row's colours, amber past the first and red past the second. Results in format.ts colour by the
// same, so amber means one thing everywhere. The bars for a line in the log, below, sit above these.
export const MAIN_MS = [50, 200] as const;
export const HEAP_SHARE = [0.7, 0.85] as const;
export const KEY_MS = [50, 100] as const;
export const RTT_MS = [150, Infinity] as const;

// The bars for a line in the log. They sit above the row's colours (main 50 and 200 ms, heap 70 and
// 85 %, key 50 and 100 ms), and each is said at most so often, so the log stays worth reading.
/** No frame for this long, then one: the device stalled. */
export const STALL_MS = 5000;
/** One second this blocked. */
export const BLOCKED_MS = 1000;
export const BLOCKED_EVERY_MS = 10_000;
/** The heap's share of its limit that is said once, and the share it must fall below to be said again. */
export const HEAP_ALARM = 0.85;
export const HEAP_REARM = 0.75;
/** A key press this slow to reach the screen. */
export const SLOW_KEY_MS = 300;
export const SLOW_KEY_EVERY_MS = 30_000;

/** What one page's alarms remember between samples. */
export interface Watch {
  /** Epoch ms of the frame before this one; 0 before the first. */
  frameAt: number;
  blockedAt: number;
  slowKeyAt: number;
  heapArmed: boolean;
}

export const watch = (): Watch => ({ frameAt: 0, blockedAt: -Infinity, slowKeyAt: -Infinity, heapArmed: true });

export type Alarm =
  /** No frame for `gapMs`; the frame that ended it has this timer lag. */
  | { type: 'stall'; gapMs: number; lagMs: number | null }
  | { type: 'blocked'; longTaskMs: number; lagMs: number | null }
  | { type: 'heap'; mb: number; limitMB: number; trend: HeapTrend | null }
  | { type: 'slow-key'; press: Press };

/** The alarms the page's newest sample raises, given what `w` remembers; updates `w`. */
export function alarms(w: Watch, r: Recording, v: Vitals): Alarm[] {
  const out: Alarm[] = [];
  const last = r.points[r.points.length - 1]!;
  const at = r.lastFrameAt;
  const gap = w.frameAt ? at - w.frameAt : 0;
  w.frameAt = at;
  if (gap >= STALL_MS) {
    out.push({ type: 'stall', gapMs: gap, lagMs: last.lagMs });
    // The same block shows in this sample's numbers; the stall line already says it.
    w.blockedAt = at;
  } else if (blockedMs(last) >= BLOCKED_MS && at - w.blockedAt >= BLOCKED_EVERY_MS) {
    out.push({ type: 'blocked', longTaskMs: last.longTaskMs, lagMs: last.lagMs });
    w.blockedAt = at;
  }
  if (v.heapMB !== null && v.heapLimitMB) {
    const share = v.heapMB / v.heapLimitMB;
    if (w.heapArmed && share >= HEAP_ALARM) {
      out.push({ type: 'heap', mb: v.heapMB, limitMB: v.heapLimitMB, trend: v.trend });
      w.heapArmed = false;
    } else if (share < HEAP_REARM) w.heapArmed = true;
  }
  if (last.keyToFrameMs !== null && last.keyToFrameMs >= SLOW_KEY_MS && at - w.slowKeyAt >= SLOW_KEY_EVERY_MS) {
    const ps = presses(r.timeline, r.meta.names, Math.max(1, last.keys));
    // A press that drew no frame counts as the slowest.
    const worst = ps.reduce<Press | null>((a, b) => (!a || (b.toFrameMs ?? Infinity) > (a.toFrameMs ?? Infinity) ? b : a), null);
    if (worst) {
      out.push({ type: 'slow-key', press: worst });
      w.slowKeyAt = at;
    }
  }
  return out;
}
