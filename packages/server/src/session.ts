// One page's recording on the laptop: raw agent frames decoded into a bounded timeline, one Point
// per frame, the agent's clock offset from pings, and key → frame per focused element. Nothing is
// written to disk; the timeline keeps the last LIVE_WINDOW_MS, enough for a capture and for the
// Performance panel.
import { decodeFrame, Positions, RESOURCE_KINDS, type Frame } from '@teleport/protocol';
import { quantile } from '@teleport/stats';
import { appendFrame, emptyTimeline, frameIntervals, trimTimeline, type Timeline } from './analyze.js';
import { KEY_PHASES, type DeviceStats, type KeyPhases, type KeyTargetStat, type Point } from './live.js';
import { serverNow } from './netlog.js';

export type { Point } from './live.js';

const LIVE_WINDOW_MS = 30 * 60 * 1000;
const POINTS = 300;
const CLOCK_SAMPLES = 8;
const NONE = new Float64Array(0);
/** The agent's resource name id when its string table is full. */
const NAME_TABLE_FULL = 65535;
const TARGETS = 64;
const TARGET_SAMPLES = 64;
const SHOWN_TARGETS = 8;

export interface SessionMeta {
  device: string;
  href: string;
  ua: string;
  ip: string;
  started: number;
  names: string[];
  /** Agent clock minus server clock, ms, from the lowest-latency ping. */
  offsetMs: number;
  rttMs: number | null;
  frames: number;
  badFrames: number;
  /** Cumulative records lost to ring overwrite on the device, per stream. */
  dropped: Record<string, number>;
  /** Records sent that never arrived, per stream: lost with a link before the page came back, or
   *  while it was away longer than its rings hold. Resent records count once. */
  missed?: Record<string, number>;
  /** Sockets the page came back on after its link dropped, within this session. */
  relinks?: number;
}

/** The phase record written for the key at agent time t, if this frame carries it. */
export function keyPhasesAt(kp: Record<string, ArrayLike<number>>, t: number): KeyPhases | null {
  const ts = kp.t!;
  for (let j = 0; j < ts.length; j++) {
    if (Math.abs(ts[j]! - t) >= 0.5) continue;
    const out = {} as KeyPhases;
    for (const k of KEY_PHASES) {
      const v = kp[k]![j]!;
      out[k] = v >= 0 ? v : null;
    }
    return out;
  }
  return null;
}

export function medianPhases(xs: KeyPhases[]): KeyPhases | null {
  if (!xs.length) return null;
  const out = {} as KeyPhases;
  for (const k of KEY_PHASES) {
    const vs = xs.map((x) => x[k]).filter((v): v is number => v !== null);
    out[k] = vs.length ? quantile(vs, 0.5) : null;
  }
  return out;
}

function last(xs: Float64Array | undefined) {
  return xs && xs.length ? xs[xs.length - 1]! : null;
}

export class Session {
  readonly meta: SessionMeta;
  readonly timeline: Timeline = emptyTimeline();
  readonly points: Point[] = [];
  private bytesIn = 0;
  /** Epoch ms of the last frame. */
  lastFrameAt = 0;
  /** Messages from this page, its inspector or its DevTools that could not be read (server.ts `reading`). */
  unread = 0;
  /** From the inspector's marks: how long its messages sat in the device's queue plus the trip. */
  devtoolsLagMs: number | null = null;
  private domNodes: number | null = null;
  private keyTargets = new Map<string, { ms: number[]; phases: KeyPhases[] }>();
  private pongs: { rtt: number; offset: number }[] = [];
  private prevVideo = new Map<number, { t: number; dropped: number; decoded: number }>();
  private positions = new Positions();

  constructor(info: { device: string; href: string; ua: string; ip: string }) {
    this.meta = { ...info, started: Date.now(), names: [], offsetMs: 0, rttMs: null, frames: 0, badFrames: 0, dropped: {} };
  }

  /** Decodes, records and returns one agent frame, or null when it doesn't decode. */
  frame(data: Buffer): Frame | null {
    let f: Frame;
    try {
      f = decodeFrame(data);
    } catch {
      this.meta.badFrames++;
      return null;
    }
    this.meta.frames++;
    this.bytesIn += data.length;
    this.lastFrameAt = Date.now();
    f = this.positions.admit(f);
    appendFrame(this.timeline, f);
    for (const s of f.streams) {
      this.meta.dropped[s.name] = s.dropped;
      const missed = this.positions.missed(s.id);
      if (missed) (this.meta.missed ??= {})[s.name] = missed;
    }
    const t = this.timeline.overhead!.t!;
    if (this.meta.frames % 60 === 0 && t.length) trimTimeline(this.timeline, t[t.length - 1]! - LIVE_WINDOW_MS);
    this.point(f, data.length);
    return f;
  }

  private point(f: Frame, wireBytes: number) {
    const s = Object.fromEntries(f.streams.map((x) => [x.name, x.columns]));
    const work = last(s.overhead?.workMs);
    const win = last(s.overhead?.windowMs);
    let videoDroppedPerS: number | null = null;
    let videoDecodedPerS: number | null = null;
    const v = s.video;
    if (v) {
      for (let i = 0; i < v.t!.length; i++) {
        const el = v.el![i]!;
        const prev = this.prevVideo.get(el);
        const cur = { t: v.t![i]!, dropped: v.dropped![i]!, decoded: v.decoded![i]! };
        this.prevVideo.set(el, cur);
        if (prev && cur.t > prev.t) {
          videoDroppedPerS = (videoDroppedPerS ?? 0) + ((cur.dropped - prev.dropped) * 1000) / (cur.t - prev.t);
          videoDecodedPerS = (videoDecodedPerS ?? 0) + ((cur.decoded - prev.decoded) * 1000) / (cur.t - prev.t);
        }
      }
    }
    const used = last(s.heap?.used);
    const total = last(s.heap?.total);
    const col = (stream: string, field: string) => s[stream]?.[field] ?? NONE;
    const lt = { t: col('longtask', 't'), dur: col('longtask', 'durMs') };
    let longTaskMs = 0;
    for (let i = 0; i < lt.t.length; i++) longTaskMs += lt.dur[i]!;
    const inp = { t: col('input', 't'), ms: col('input', 'toFrameMs') };
    const kt = { t: col('keytarget', 't'), name: col('keytarget', 'target') };
    const kp = s.keyphase;
    let keyToFrameMs: number | null = null;
    for (let i = 0; i < inp.t.length; i++) {
      const ms = inp.ms[i]! >= 0 ? inp.ms[i]! : null;
      if (ms !== null) keyToFrameMs = Math.max(keyToFrameMs ?? 0, ms);
      const target = this.keyTarget(inp.t[i]!, kt.t, kt.name);
      // A phase record usually rides in the same frame as its key; one that straddles a tick is
      // only in the timeline (and so in captures and the Performance panel).
      const phases = kp ? keyPhasesAt(kp, inp.t[i]!) : null;
      if (target !== null && ms !== null) this.addTargetSample(target, ms, phases);
    }
    const res = { t: col('resource', 't'), bytes: col('resource', 'bytes') };
    let resourceBytes = 0;
    for (let i = 0; i < res.t.length; i++) resourceBytes += res.bytes[i]!;
    const link = { agent: col('link', 'agentQueued'), insp: col('link', 'inspectorQueued'), ms: col('link', 'inspectorMs'), level: col('link', 'level'), limit: col('link', 'heapLimit') };
    const li = link.agent.length - 1;
    const nodes = col('dom', 'nodes');
    if (nodes.length) this.domNodes = nodes[nodes.length - 1]!;
    const iv = frameIntervals(Array.from(col('frame', 't')));
    const span = iv.reduce((a, b) => a + b, 0);
    const p: Point = {
      t: last(s.overhead?.t) ?? f.baseTime,
      overheadPct: work !== null && win ? (100 * work) / win : null,
      lagMs: last(s.lag?.lagMs),
      longTaskMs,
      longTasks: lt.t.length,
      heapMB: used === null ? null : used / 1048576,
      heapTotalMB: total === null ? null : total / 1048576,
      videoDroppedPerS,
      videoDecodedPerS,
      resources: res.t.length,
      resourceKB: resourceBytes / 1024,
      keys: inp.t.length,
      keyToFrameMs,
      fps: span > 0 ? (1000 * iv.length) / span : null,
      frameP95Ms: iv.length ? quantile(iv, 0.95) : null,
      wireBytes,
      agentQueuedKB: li >= 0 ? link.agent[li]! / 1024 : null,
      inspectorQueuedKB: li >= 0 && link.level[li]! + link.ms[li]! + link.insp[li]! > 0 ? link.insp[li]! / 1024 : null,
      inspectorPct: li >= 0 && link.ms[li]! > 0 && win ? (100 * link.ms[li]!) / win : null,
      level: li >= 0 ? link.level[li]! : 0,
      heapLimitMB: li >= 0 && link.limit[li]! > 0 ? link.limit[li]! / 1048576 : null,
      domNodes: this.domNodes,
      devtoolsLagMs: this.devtoolsLagMs,
    };
    this.points.push(p);
    if (this.points.length > POINTS) this.points.shift();
  }

  private keyTarget(t: number, ts: Float64Array, names: Float64Array): string | null {
    for (let j = 0; j < ts.length; j++) {
      if (Math.abs(ts[j]! - t) < 0.5) {
        const id = names[j]!;
        return id === NAME_TABLE_FULL ? null : (this.meta.names[id] ?? null);
      }
    }
    return null;
  }

  private addTargetSample(target: string, ms: number, phases: KeyPhases | null) {
    let x = this.keyTargets.get(target);
    if (!x) {
      if (this.keyTargets.size >= TARGETS) return;
      x = { ms: [], phases: [] };
      this.keyTargets.set(target, x);
    }
    x.ms.push(ms);
    if (x.ms.length > TARGET_SAMPLES) x.ms.shift();
    if (phases) {
      x.phases.push(phases);
      if (x.phases.length > TARGET_SAMPLES) x.phases.shift();
    }
  }

  /** Key → frame per focused element, slowest p95 first. */
  targets(): KeyTargetStat[] {
    const out: KeyTargetStat[] = [];
    for (const [target, x] of this.keyTargets) {
      const xs = x.ms;
      out.push({ target, keys: xs.length, p50Ms: quantile(xs, 0.5), p95Ms: quantile(xs, 0.95), maxMs: Math.max(...xs), phases: medianPhases(x.phases) });
    }
    return out.sort((a, b) => b.p95Ms - a.p95Ms).slice(0, SHOWN_TARGETS);
  }

  /** The resource name for an id the agent sent. */
  nameOf(id: number): string {
    return this.meta.names[id] ?? (id === NAME_TABLE_FULL ? '(string table full)' : `#${id}`);
  }

  /** The kind of resource the agent recorded, by its kind id. */
  static kindOf(kind: number): string {
    return RESOURCE_KINDS[kind] ?? 'other';
  }

  /** An inspector mark: `t` is the agent-clock time the device queued it. */
  mark(t: number) {
    this.devtoolsLagMs = Math.max(0, serverNow() - (t - this.meta.offsetMs));
  }

  stats(inspectorBytesIn = 0): DeviceStats {
    const m = this.meta;
    return { frames: m.frames, badFrames: m.badFrames, unread: this.unread, bytesIn: this.bytesIn, inspectorBytesIn, dropped: m.dropped, offsetMs: m.offsetMs, rttMs: m.rttMs, names: m.names.length };
  }

  lastPoint() {
    return this.points[this.points.length - 1] ?? null;
  }

  /** Handles a text line from the agent. Returns true when it was one of ours. */
  text(line: string): boolean {
    const at = line.indexOf(' ');
    const cmd = line.slice(0, at);
    const arg = line.slice(at + 1);
    if (cmd === 'name') {
      const sp = arg.indexOf(' ');
      const id = Number(arg.slice(0, sp));
      // The agent's table stops at 1024 names. An id past any table would make this list that long.
      if (Number.isInteger(id) && id >= 0 && id < NAME_TABLE_FULL) this.meta.names[id] = this.absolute(arg.slice(sp + 1));
      return true;
    }
    if (cmd === 'pong') {
      const [sent, agent] = arg.split(' ').map(Number) as [number, number];
      const recv = serverNow();
      this.pongs.push({ rtt: recv - sent, offset: agent - (sent + recv) / 2 });
      if (this.pongs.length > CLOCK_SAMPLES) this.pongs.shift();
      const best = this.pongs.reduce((a, b) => (b.rtt < a.rtt ? b : a));
      this.meta.offsetMs = best.offset;
      this.meta.rttMs = best.rtt;
      return true;
    }
    return false;
  }

  /** A resource name as the agent sent it: its own origin left off, which the page's address gives back. */
  private absolute(name: string) {
    if (name.charAt(0) !== '/') return name;
    try {
      return new URL(name, this.meta.href).href;
    } catch {
      return name;
    }
  }

  /** What the session holds of each stream, in schema order, for a page that comes back on a new
   *  link; null before its first frame. */
  holds(): number[] | null {
    return this.positions.list();
  }

  /** The page came back on a new link soon enough to carry on in this session. */
  reopen() {
    this.meta.relinks = (this.meta.relinks ?? 0) + 1;
  }

  /** Converts a server-clock time to the agent's clock. */
  agentTime(serverMs: number) {
    return serverMs + this.meta.offsetMs;
  }
}
