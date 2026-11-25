// What teleport's answers look like to a person: the console prints these, and `tlpt q` does
// when its output is a terminal. Piped, q prints JSON, which is what scripts and AI agents read.
// Claude Code's grammar: a bullet line says what happened, `⎿` lines under it say the rest, and
// labelled rows line their values up. Values are ink and labels faint; amber and red mean a value is
// past the live row's thresholds, and green is kept for good results. Pure: each takes the answer,
// the palette and the width, and returns lines no wider than cols - 1.
import type { NetRecord, Report } from './analyze.js';
import { KEY_PHASES, type DeviceInfo, type DeviceStats, type KeyPhase, type KeyPhases, type KeyTargetStat, type Point } from './live.js';
import { SPEED_RUNS, SPEED_WORK, type CapItem, type Capabilities, type DomReport, type FocusReport, type Reading, type SpeedReport, type SpeedWork, type StorageArea, type StorageReport } from './probes.js';
import { PROFILE } from './profile.js';
import { latestLine } from './q.js';
import type { Heard } from './hear.js';
import { presses, type Press, type RemoteRun } from './remote.js';
import { charWidth, pad, printable, truncate, width, wrap } from './text.js';
import type { TrialReport } from './trial.js';
import type { StylesReport } from './styles.js';
import { G, type Paint } from './tui.js';
import { errorLine, type PageError } from './errors.js';
import { describeUa } from './ua.js';
import { HEAP_SHARE, heapTrend, KEY_MS, MAIN_MS, mainWindow, RTT_MS } from './vitals.js';

/** What an answer doesn't say about itself: which device it came from, and where that device is. */
export interface Context {
  /** The device's id, when the caller knows it. */
  id?: string;
  /** The port tlpt listens on, for the line that says no device is connected. */
  port?: number;
  /** The device page's address, so URLs on its origin show as paths. */
  href?: string;
}


const notNull = <T>(x: T | null): x is T => x !== null;
const r1 = (x: number) => (Math.abs(x) >= 100 ? String(Math.round(x)) : String(Math.round(x * 10) / 10));
/** A time in ms: 1 decimal under 100, whole from 100; the unknown mark when the engine can't say. */
export const ms = (x: number | null | undefined) => (x === null || x === undefined ? G.none : `${r1(x)} ms`);
const num = (x: number | null, f = r1) => (x === null ? G.none : f(x));
const signed = (x: number, f = r1) => `${x > 0 ? '+' : x < 0 ? '-' : ''}${f(Math.abs(x))}`;
const bytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${r1(n / 1024)} KB` : `${r1(n / 1048576)} MB`);
// The agent's share of the main thread is often under a tenth of a percent, where one decimal reads 0.
const pct = (x: number) => `${x >= 0.1 || x === 0 ? r1(x) : Math.round(x * 100) / 100}%`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
/** A span of time as people say it: 4.2 s, 42 s, 1 min 48 s. */
const span = (msec: number) => {
  const s = msec / 1000;
  if (s < 60) return `${s < 10 ? r1(s) : Math.round(s)} s`;
  const whole = Math.round(s);
  return `${Math.floor(whole / 60)} min${whole % 60 ? ` ${whole % 60} s` : ''}`;
};
const dotted = (parts: string[]) => parts.filter(Boolean).join(` ${G.sep} `);
// ua.ts, q.ts and profile.ts write · and →; drawn here, they follow the glyph set like everything else.
const glyphed = (s: string) => s.replace(/ · /g, ` ${G.sep} `).replace(/→/g, G.right);
const engineOf = (ua: string) => glyphed(describeUa(ua));
/** Text from the device with control characters blanked, so a stored value can't move the cursor or recolour the terminal. */
const clean = (s: string) => s.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');

/** Where a detail line's text starts: after `  ⎿ `. */
const indent = () => 3 + width(G.nest);

/** Paint for a value past a threshold: amber past the first, red past the second. */
const toned = (p: Paint, x: number | null, [warn, bad]: readonly [number, number]) => (s: string) => (x === null ? s : x >= bad ? p.bad(s) : x >= warn ? p.warn(s) : s);

/** Text in ink, with ink restored after each colour inside it closes, so a red word leaves the rest ink. */
function inked(p: Paint, s: string): string {
  const [open, close] = p.ink('\0').split('\0') as [string, string];
  return open ? open + s.split(close).join(close + open) + close : s;
}

/** Plain text cut in the middle, keeping both ends: where a path starts and the file it names. */
function middle(s: string, max: number): string {
  if (width(s) <= max) return s;
  const room = max - width(G.ellipsis);
  const chars = [...s];
  let head = '';
  let tail = '';
  for (const ch of chars) {
    if (width(head + ch) > Math.ceil(room / 2)) break;
    head += ch;
  }
  for (let i = chars.length - 1; i >= 0 && width(chars[i] + tail) <= room - width(head); i--) tail = chars[i] + tail;
  return head + G.ellipsis + tail;
}

/**
 * Names cut to `max` so they stay apart. From the middle; else each around where it differs from the
 * name most like it (hero-webp-preload, hero-avif-preload: …webp…, …avif…); else its end, then its
 * start (focus-ring, focus-glow-ring); else from the middle after all. By characters, not UTF-16.
 */
function apart(names: string[], max: number): string[] {
  const xs = [...new Set(names)];
  const cs = xs.map((x) => [...x]);
  const around = (i: number) => {
    // A name that fits is whole: the cut ones all carry an ellipsis, so it can't be taken for one.
    if (width(xs[i]!) <= max) return xs[i]!;
    const a = cs[i]!;
    let pre = 0;
    let suf = 0;
    cs.forEach((b, j) => {
      if (j === i) return;
      let k = 0;
      while (k < a.length && k < b.length && a[k] === b[k]) k++;
      let m = 0;
      while (m < a.length - k && m < b.length - k && a[a.length - 1 - m] === b[b.length - 1 - m]) m++;
      pre = Math.max(pre, k);
      suf = Math.max(suf, m);
    });
    const core = a.slice(pre, Math.max(pre, a.length - suf)).join('');
    if (core) return (pre ? G.ellipsis : '') + core + (suf ? G.ellipsis : '');
    // Nothing of its own between the two (focus-ring beside focus-glow-ring): what follows the prefix
    // it shares, else the whole name (focus beside focus-ring).
    const rest = a.slice(pre).join('');
    return rest ? G.ellipsis + rest : xs[i]!;
  };
  const ways: ((i: number) => string)[] = [
    (i) => middle(xs[i]!, max),
    (i) => truncate(around(i), max),
    (i) => {
      if (width(xs[i]!) <= max) return xs[i]!;
      let t = '';
      for (let k = cs[i]!.length - 1; k >= 0 && width(cs[i]![k] + t) <= max - width(G.ellipsis); k--) t = cs[i]![k] + t;
      return G.ellipsis + t;
    },
    (i) => truncate(xs[i]!, max),
  ];
  for (const way of ways) {
    const cut = xs.map((_, i) => way(i));
    if (cut.every(Boolean) && new Set(cut).size === xs.length) return names.map((n) => cut[xs.indexOf(n)]!);
  }
  return names.map((n) => middle(n, max));
}

const originOf = (url: string | undefined) => {
  try {
    return url ? new URL(url).origin : null;
  } catch {
    return null;
  }
};
/** A URL as a path when it is on the device page's origin. */
const shown = (url: string, origin: string | null) => (origin && (url === origin || url.startsWith(origin + '/')) ? url.slice(origin.length) || '/' : url);

/** Text wrapped at spaces, its colours reopened on each line so a wrapped red reason stays red. */
function wrapStyled(s: string, max: number): string[] {
  let carry = '';
  return wrap(s, max).map((line) => {
    const out = carry + line;
    carry += (line.match(/\x1b\[[0-9;]*m/g) ?? []).join('');
    return out;
  });
}

/** Parts joined by · and wrapped between them to `room` columns; a part wider than that wraps at its spaces. */
function flow(parts: string[], room: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const part of parts.filter(Boolean)) {
    const joined = line ? `${line} ${G.sep} ${part}` : part;
    if (width(joined) <= room) {
      line = joined;
      continue;
    }
    if (line) out.push(line);
    const lines = width(part) <= room ? [part] : wrapStyled(part, room);
    out.push(...lines.slice(0, -1));
    line = lines[lines.length - 1]!;
  }
  if (line) out.push(line);
  return out;
}

/** Values as bars, scaled to `max` or to their own maximum. null draws a gap. */
export function spark(values: (number | null)[], max?: number): string {
  const top = max ?? Math.max(0, ...values.filter(notNull));
  const bars = [...G.bars];
  return values.map((v) => (v === null ? ' ' : top <= 0 ? bars[0] : bars[Math.min(7, Math.max(0, Math.round((v / top) * 7)))])).join('');
}

/** At most `n` values, each the largest of its share of `values`; null where that share has none. */
function squeeze(values: (number | null)[], n: number): (number | null)[] {
  if (values.length <= n) return values;
  return Array.from({ length: n }, (_, i) => {
    const share = values.slice(Math.floor((i * values.length) / n), Math.floor(((i + 1) * values.length) / n)).filter(notNull);
    return share.length ? Math.max(...share) : null;
  });
}

type Tone = 'ink' | 'good' | 'warn' | 'bad' | 'faint';

/**
 * An event's bullet. Each tone has a shape of its own, so it reads with NO_COLOR and to the one man
 * in twelve who sees red and green alike: good, warn and bad are 7.5 apart (OKLab x 100) under
 * simulated protanopia and deuteranopia, against 15 for full colour vision.
 */
export const bullet = (tone: Tone): string => (tone === 'good' ? G.yes : tone === 'warn' ? G.alert : tone === 'bad' ? G.no : G.dot);

/**
 * An event or an answer: a bullet line saying what happened, then detail lines, the first after ⎿
 * and the rest under it. The bullet is the tone's own (● ✓ ▲ ✗) in its colour, or for 'faint' a faint · on a routine
 * line, whose text is muted. The head is cut to the width, and so are details, unless `wrap`: then
 * they wrap under themselves, for reasons and errors, which stay in scrollback for good.
 */
export function block(p: Paint, cols: number, head: string, detail: string[] = [], tone: Tone = 'ink', opts: { wrap?: boolean } = {}): string[] {
  const routine = tone === 'faint';
  const out = [truncate(routine ? `${p.faint(G.sep)} ${p.muted(head)}` : `${p[tone](bullet(tone))} ${inked(p, head)}`, cols - 1)];
  const room = cols - 1 - indent();
  const lines = opts.wrap ? detail.flatMap((d) => wrapStyled(d, room)) : detail.map((d) => truncate(d, room));
  lines.forEach((d, i) => out.push((i === 0 ? `  ${p.faint(G.nest)} ` : ' '.repeat(indent())) + (routine ? p.faint(d) : inked(p, d))));
  return out;
}

const labelWidth = (labels: string[]) => Math.max(12, ...labels.map((l) => width(l) + 2));

/**
 * Labelled lines for a block's detail: a faint label column, at least 12 wide, then the value. A
 * value given as parts is joined with · and wraps under the value column; one given as a string (a
 * spark, a table line) is cut to fit.
 */
export function rows(p: Paint, cols: number, list: [string, string | string[]][]): string[] {
  const w = labelWidth(list.map(([l]) => l));
  // A console narrower than the labels still gets a few columns of value, wrapping, rather than none.
  const room = Math.max(8, cols - 1 - indent() - w);
  return list.flatMap(([label, value]) => (typeof value === 'string' ? [truncate(value, room)] : flow(value, room)).map((v, i) => pad(i || !label ? '' : p.faint(label), w) + v));
}

/** Rows aligned in columns `gap` apart, each padded to its widest cell but the last. */
function align(cells: string[][], gap: number): string[] {
  const widths = cells[0]!.map((_, i) => Math.max(...cells.map((r) => width(r[i] ?? ''))));
  return cells.map((r) => r.map((c, i) => (i === r.length - 1 ? c : pad(c, widths[i]!))).join(' '.repeat(gap)).replace(/ +$/, ''));
}

/** A column fit() may narrow: which, to how few cells at the least, and how its cells are cut. */
type Squeeze = [column: number, min: number, cut: (cells: string[], w: number) => string[]];

/**
 * The first layout (the columns kept, and the gap between them) whose rows fit `room`, else the last
 * with the `squeeze` columns cut in turn, each no narrower than its least, so the columns after them
 * stay whole; what still doesn't fit is cut at the edge. And the columns it kept.
 */
function fit(cells: string[][], room: number, layouts: [number[], number][], squeeze: Squeeze[] = []): { lines: string[]; kept: number[] } {
  const lay = (rows: string[][], [kept, gap]: [number[], number]) => align(rows.map((r) => kept.map((i) => r[i]!)), gap);
  for (const l of layouts) {
    const lines = lay(cells, l);
    if (lines.every((x) => width(x) <= room)) return { lines, kept: l[0] };
  }
  const last = layouts[layouts.length - 1]!;
  const rows = cells.map((r) => [...r]);
  for (const [col, min, cut] of squeeze) {
    if (!last[0].includes(col)) continue;
    // Every row's cell is padded to the widest, so taking the overflow off that column fits them all.
    const over = Math.max(...lay(rows, last).map(width)) - room;
    if (over <= 0) break;
    const widest = Math.max(...rows.map((r) => width(r[col]!)));
    const w = Math.max(min, widest - over);
    if (w < widest) cut(rows.map((r) => r[col]!), w).forEach((c, i) => (rows[i]![col] = c));
  }
  return { lines: lay(rows, last).map((l) => truncate(l, room)), kept: last[0] };
}

/** A table: a faint header row, then columns padded to their widest cell, each line cut to fit. */
export function table(p: Paint, cols: number, head: string[], cells: string[][], indent = 4): string[] {
  return align([head.map((h) => p.faint(h)), ...cells], 2).map((l) => truncate(' '.repeat(indent) + l, cols - 1));
}

/** ` k3x9q2ab`, bold, when the device is known. */
const dut = (p: Paint, id: string | undefined) => (id ? ` ${p.bold(id)}` : '');

// ---- Status and devices ----------------------------------------------------------------------------

/** One entry of api/live. */
export interface LiveDut {
  device: DeviceInfo;
  latest: Point | null;
  stats?: DeviceStats;
}

/** Each device with its last second in q's own words (latestLine), and for devices, how its link is. */
export function formatDuts(list: LiveDut[], p: Paint, cols: number, port?: number, link = false): string[] {
  if (!list.length) return [truncate(`${p.faint(G.ring)} ${inked(p, `no device connected to tlpt${port ? ` on :${port}` : ''}`)}`, cols - 1)];
  return list.flatMap(({ device: d, latest, stats }) => {
    const detail = flow(glyphed(latestLine(latest)).split(` ${G.sep} `), cols - 1 - indent());
    if (link && stats) detail.push(...rows(p, cols, [['link', linkOf(p, stats)]]));
    return block(p, cols, `${p.bold(d.id)}  ${dotted([engineOf(d.ua), d.ip, d.inspecting ? 'DevTools open' : 'DevTools closed'])}`, detail);
  });
}

// DeviceStats.offsetMs is the page clock's origin against the laptop's, not a skew, so it isn't shown.
function linkOf(p: Paint, s: DeviceStats): string[] {
  const lost = Object.values(s.dropped).reduce((a, b) => a + b, 0);
  return [
    `${s.frames} frames, ${s.badFrames ? p.warn(`${s.badFrames} bad`) : 'none bad'}`,
    s.unread ? p.warn(`${plural(s.unread, 'message')} not read`) : '',
    s.rttMs !== null ? `rtt ${toned(p, s.rttMs, RTT_MS)(ms(s.rttMs))}` : '',
    lost ? p.warn(`${plural(lost, 'record')} lost`) : 'nothing lost',
  ];
}

// ---- Device ----------------------------------------------------------------------------------------

/** api/device: one device's last minute. */
export interface DeviceSnapshot {
  device: DeviceInfo;
  latest: Point | null;
  points: Point[];
  keyTargets: KeyTargetStat[];
  stats: DeviceStats;
  requests: NetRecord[];
}

const PHASE_NAMES: Record<KeyPhase, string> = { inputDelay: 'input delay', handlers: 'handlers', waitFrame: 'frame wait', raf: 'raf', style: 'style', layout: 'layout', paint: 'paint' };

/** The two phases a key press spent longest in. */
const whereTime = (ph: KeyPhases | null) =>
  (ph &&
    dotted(
      KEY_PHASES.filter((k) => (ph[k] ?? 0) > 0)
        .sort((a, b) => ph[b]! - ph[a]!)
        .slice(0, 2)
        .map((k) => `${PHASE_NAMES[k]} ${r1(ph[k]!)}`),
    )) ||
  G.none;

const fullIn = (p: Paint, min: number) => (min <= 15 ? p.bad : min <= 60 ? p.warn : (s: string) => s)(`full in ~${min < 120 ? `${Math.round(min)} min` : `${Math.round(min / 60)} h`}`);

/** One device's last minute: main thread, heap and key → frame as bars, key → frame by element, requests. */
export function formatDevice(s: DeviceSnapshot, p: Paint, cols: number): string[] {
  const ps = s.points;
  const last = ps[ps.length - 1];
  const overhead = ps.map((x) => x.overheadPct).filter(notNull);
  const head = dotted([`device${dut(p, s.device.id)}`, engineOf(s.device.ua), `last ${ps.length} s`]);
  const about = flow(
    [
      s.device.ip,
      s.device.inspecting ? 'DevTools open' : 'DevTools closed',
      s.stats.rttMs !== null ? `rtt ${toned(p, s.stats.rttMs, RTT_MS)(ms(s.stats.rttMs))}` : '',
      last?.domNodes != null ? `${last.domNodes} nodes` : '',
      last?.level ? p.warn(last.level === 1 ? 'inspector shedding' : 'inspector paused') : '',
      overhead.length ? `its agent used ${pct(mean(overhead))} of the main thread` : '',
    ],
    cols - 1 - indent(),
  );
  if (!last) return block(p, cols, head, [...about, p.faint('no samples yet')]);

  const keyLabel = `key ${G.right} frame`;
  // Every label here is at most as wide as key → frame, so the table's room is known before rows() lays it out.
  const room = cols - 1 - indent() - labelWidth([keyLabel]);
  const bars = Math.max(10, Math.min(36, cols - 64));
  const list: [string, string | string[]][] = [];
  // A spark and its value as one part while they fit, else two, so a narrow row never wraps a number away from its unit.
  const beside = (bar: string, value: string) => (width(bar) + 2 + width(value) <= room ? [`${bar}  ${value}`] : [bar, value]);

  const blocked = ps.map((x) => Math.max(x.longTaskMs, x.lagMs ?? 0));
  const worst = Math.max(...blocked);
  const main = toned(p, worst, MAIN_MS);
  const win = mainWindow(ps, ps.length);
  list.push(['main', [...beside(main(spark(squeeze(blocked, bars), Math.max(100, worst))), `worst ${main(ms(worst))}`), win.longTasks ? `${plural(win.longTasks, 'long task')}, ${ms(win.longTaskMs)}` : 'no long tasks']]);

  if (last.heapMB !== null) {
    const limit = last.heapLimitMB;
    const heap = toned(p, limit ? last.heapMB / limit : null, HEAP_SHARE);
    const trend = heapTrend(ps);
    list.push([
      'heap',
      [
        ...beside(heap(spark(squeeze(ps.map((x) => x.heapMB), bars), limit ?? undefined)), heap(`${Math.round(last.heapMB)}${limit ? `/${Math.round(limit)}` : ''} MB`)),
        trend ? `${signed(trend.mbPerMin)} MB/min` : '',
        trend?.fullInMin != null ? fullIn(p, trend.fullInMin) : '',
      ],
    ]);
  }

  const keyMs = ps.map((x) => x.keyToFrameMs);
  const pressed = ps.reduce((n, x) => n + x.keys, 0);
  const slowest = keyMs.some(notNull) ? Math.max(...keyMs.filter(notNull)) : null;
  if (pressed || slowest !== null) {
    const key = toned(p, slowest, KEY_MS);
    list.push([keyLabel, [...beside(key(spark(squeeze(keyMs, bars), Math.max(100, slowest ?? 0))), plural(pressed, 'press', 'presses')), slowest !== null ? `worst ${key(ms(slowest))}` : '']]);
  }

  if (s.keyTargets.length) {
    const cells = [
      ['presses', 'p50', 'p95', 'where the time goes', 'element'].map((h) => p.faint(h)),
      ...s.keyTargets.map((t) => [String(t.keys), toned(p, t.p50Ms, KEY_MS)(ms(t.p50Ms)), toned(p, t.p95Ms, KEY_MS)(ms(t.p95Ms)), whereTime(t.phases), clean(t.target)]),
    ];
    // Narrower, the element's name matters more than the median and then the phases.
    const { lines } = fit(cells, room, [
      [[0, 1, 2, 3, 4], 3],
      [[0, 1, 2, 3, 4], 2],
      [[0, 2, 3, 4], 2],
      [[0, 2, 4], 2],
    ]);
    lines.forEach((l, i) => list.push([i ? '' : 'by element', l]));
  }

  const playing = ps.filter((x) => (x.videoDecodedPerS ?? 0) > 0);
  if (playing.length) {
    const dropped = Math.max(...playing.map((x) => x.videoDroppedPerS ?? 0));
    list.push(['video', [`${r1(mean(playing.map((x) => x.videoDecodedPerS!)))} frames/s decoded`, dropped ? p.warn(`up to ${r1(dropped)} dropped/s`) : 'none dropped']]);
  }

  if (s.requests.length) {
    const failed = s.requests.filter((r) => r.failed || r.status >= 400).length;
    const slow = s.requests.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
    const took = ms(slow.end - slow.start);
    const path = middle(shown(slow.url, originOf(s.device.href)), Math.max(12, room - width(`slowest ${slow.method}  ${took}`)));
    list.push(['requests', [String(s.requests.length), failed ? p.bad(`${failed} failed`) : '', `slowest ${slow.method} ${path} ${took}`, p.faint('network lists them')]]);
  }
  return block(p, cols, head, [...about, ...rows(p, cols, list)]);
}

// ---- Capture ---------------------------------------------------------------------------------------

/** A capture: frames, the main thread, key → frame, heap, video, requests and what the agent cost. */
export function formatCapture(r: Report, p: Paint, cols: number, ctx: Context = {}): string[] {
  // Cut short, it says so first, with how much of what was asked it covers.
  const head = dotted([
    `capture${dut(p, ctx.id)}`,
    r.cutShort ? `${r1(r.seconds)} s of ${r1(r.cutShort.askedS)}` : `${r1(r.seconds)} s`,
    r.cutShort ? p.warn(r.cutShort.why) : '',
    r.input ? plural(r.input.keys, 'key press', 'key presses') : '',
  ]);
  const list: [string, string | string[]][] = [];
  const f = r.frames;
  list.push([
    'frames',
    f
      ? [(f.fps >= 50 ? p.good : (s: string) => s)(`${r1(f.fps)} fps`), `p50 ${num(f.p50Ms)}`, `p95 ${num(f.p95Ms)}`, `worst ${ms(f.maxMs)}`, `${f.over33Ms} over 33 ms`, `${f.over50Ms} over 50 ms`]
      : ['none drawn: the page was idle, or has no requestAnimationFrame'],
  ]);
  const lt = r.longTasks;
  const lag = r.lag;
  list.push([
    'main',
    [
      lt.count ? `${plural(lt.count, 'long task')}, ${ms(lt.totalMs)}` : 'no long tasks',
      lt.count ? `worst ${toned(p, lt.maxMs, MAIN_MS)(ms(lt.maxMs))}` : '',
      lag.p95Ms !== null ? `timer lag p95 ${toned(p, lag.p95Ms, MAIN_MS)(ms(lag.p95Ms))}, worst ${toned(p, lag.maxMs, MAIN_MS)(ms(lag.maxMs))}` : '',
    ],
  ]);
  const i = r.input;
  list.push([
    'keys',
    i
      ? [`key ${G.right} frame p50 ${toned(p, i.p50Ms, KEY_MS)(num(i.p50Ms))}`, `p95 ${toned(p, i.p95Ms, KEY_MS)(num(i.p95Ms))}`, `worst ${toned(p, i.maxMs, KEY_MS)(ms(i.maxMs))}`, i.noFrame ? `${i.noFrame} drew nothing` : '']
      : ['none pressed', 'press keys on the device during a capture'],
  ]);
  if (r.heap) list.push(['heap', [`${r1(r.heap.usedMB)} MB (${r1(r.heap.minMB)} to ${r1(r.heap.maxMB)})`, `${signed(r.heap.mbPerMin)} MB/min`]]);
  for (const v of r.video) list.push(['video', [`${r1(v.decodedPerS)} frames/s decoded`, v.droppedPerS ? p.warn(`${r1(v.droppedPerS)} dropped/s, ${r1(v.dropPct)}%`) : 'none dropped']]);
  const res = r.resources;
  if (res.count) {
    const origin = originOf(ctx.href);
    const room = cols - 1 - indent() - 12;
    const named = res.slowest.slice(0, 2).map((x, n) => {
      const took = ms(x.durMs);
      const lead = n ? '' : 'slowest ';
      return `${lead}${middle(shown(x.name, origin), Math.max(12, room - width(`${lead} ${took}`)))} ${took}`;
    });
    list.push(['requests', [String(res.count), res.bytes ? bytes(res.bytes) : '', ...named]]);
  }
  if (r.overhead) list.push(['teleport', [`its agent used ${pct(r.overhead.pct)} of the main thread`]]);
  return block(p, cols, head, rows(p, cols, list), r.cutShort ? 'warn' : 'ink');
}

// ---- Trial -----------------------------------------------------------------------------------------

const MAX_DIFFS = 8;
/** Past the table, how many more clear differences are named; the rest are counted. */
const MORE_NAMED = 6;

/** A trial: what ran, its checks, the clear differences from the first variant with their intervals, and the notes. */
export function formatTrial(r: TrialReport, p: Paint, cols: number): string[] {
  const failed = r.samples.filter((s) => !s.ok).length;
  const runs = r.variants[0]?.runs ?? 0;
  // Failed runs and a trial cut short come before the engine, so a head cut to the width keeps them.
  const head = dotted([
    `trial ${r.name}${dut(p, r.device.id)}`,
    failed ? p.bad(`${failed} failed`) : '',
    r.truncated ? p.warn('stopped early') : '',
    glyphed(r.device.engine),
    `${plural(r.variants.length, 'variant')}, ${plural(runs, 'run')} each`,
    span(r.ms),
  ]);
  const room = cols - 1 - indent();
  const d: string[] = [];
  const checks = Object.entries(r.checks ?? {});
  if (checks.length || r.checksError)
    d.push(...rows(p, cols, [['checks', [...checks.map(([k, v]) => `${k} ${v === true ? 'yes' : v === false ? p.faint('no') : v === null ? p.faint(G.none) : clean(String(v))}`), r.checksError ? p.bad(`failed: ${clean(r.checksError)}`) : '']]]));

  const median = (variant: string, metric: string) => r.variants.find((v) => v.name === variant)?.numbers[metric]?.median ?? null;
  // A custom measure's ratio or score can differ clearly by less than 0.05, which one decimal reads as 0.
  const fine = (x: number) => (Math.abs(x) < 1 && x !== 0 ? String(Number(x.toPrecision(2))) : r1(x));
  const share = (c: TrialReport['compare'][number]) => ((b) => (b ? Math.abs(c.diff) / Math.abs(b) : Infinity))(median(c.baseline, c.metric));
  const clear = r.compare.filter((c) => c.lo > 0 || c.hi < 0).sort((a, b) => share(b) - share(a));
  if (clear.length) {
    const cells = clear.slice(0, MAX_DIFFS).map((c) => {
      const info = PROFILE[c.metric];
      const unit = info?.unit ? ` ${info.unit}` : '';
      return [
        c.variant,
        p.muted(info ? glyphed(info.label) : c.metric),
        `${num(median(c.baseline, c.metric), fine)} ${G.right} ${num(median(c.variant, c.metric), fine)}${unit}`,
        `${signed(c.diff, fine)}${unit}`,
        `${signed(c.lo, fine)} to ${signed(c.hi, fine)}`,
        c.better === 'yes' ? p.good('better') : c.better === 'no' ? p.bad('worse') : '',
      ];
    });
    // Narrower, the verdict and the change stay: the medians go first, then the interval, then the
    // variant when there is only one (the line above names it); then the variants' names are cut,
    // kept apart, and last the measure's.
    // With two variants every row names the same one, which the line above can name instead: it goes
    // before any number does.
    const layouts: [number[], number][] =
      r.variants.length === 2
        ? [
            [[0, 1, 2, 3, 4, 5], 3],
            [[1, 2, 3, 4, 5], 3],
            [[1, 2, 3, 4, 5], 2],
            [[1, 3, 4, 5], 2],
            [[1, 3, 5], 2],
          ]
        : [
            [[0, 1, 2, 3, 4, 5], 3],
            [[0, 1, 2, 3, 4, 5], 2],
            [[0, 1, 3, 4, 5], 2],
            [[0, 1, 3, 5], 2],
          ];
    const { lines, kept } = fit(cells, room - 2, layouts, [
      [0, 6, apart],
      [1, 4, (xs, w) => xs.map((x) => truncate(x, w))],
    ]);
    const shows = kept.includes(2) ? 'medians; 95% interval of the change' : kept.includes(4) ? '95% interval of the change' : '';
    const of = kept.includes(0) ? '' : ` of ${r.variants[1]!.name}`;
    d.push(...wrapStyled(p.faint(`clear differences${of} from ${r.variants[0]!.name}${shows ? ` (${shows})` : ''}`), room), ...lines.map((l) => '  ' + l));
    // The next few are named, so a clear regression past the eighth isn't lost here or in the console;
    // the rest are counted. Variants by short names kept apart, as a narrow table shows them.
    const hidden = clear.slice(MAX_DIFFS);
    // Cut against every variant, so a name stands for one alone even when only one has rows here.
    const all = r.variants.map((v) => v.name);
    const cut = apart(all, 16);
    const short = new Map(all.map((n, i) => [n, cut[i]!]));
    const named = hidden.slice(0, MORE_NAMED).map((c, i) => {
      const info = PROFILE[c.metric];
      const unit = info?.unit ? ` ${info.unit}` : '';
      const verdict = c.better === 'yes' ? ' better' : c.better === 'no' ? ' worse' : '';
      return `${r.variants.length > 2 ? `${short.get(c.variant) ?? c.variant} ` : ''}${info ? glyphed(info.label) : c.metric} ${signed(c.diff, fine)}${unit}${verdict}`;
    });
    const unnamed = hidden.length - named.length;
    if (hidden.length) d.push(...wrap(`and ${hidden.length} more: ${named.join(', ')}${unnamed ? `, and ${unnamed} others` : ''}`, room).map((l) => p.faint(l)));
    const others = r.compare.length - clear.length;
    if (others) d.push(...wrap(`no clear difference on the other ${plural(others, 'comparison')}`, room));
  } else if (r.compare.length) d.push(...wrap(`no clear difference on any of the ${plural(r.compare.length, 'comparison')}`, room));
  else if (r.samples.length) d.push(...wrapStyled(p.faint('nothing to compare: each variant needs 3 runs that measured something'), room));

  const hang = width(G.sep) + 1;
  for (const n of r.notes) wrap(clean(n), room - hang).forEach((l, i) => d.push((i ? ' '.repeat(hang) : `${p.faint(G.sep)} `) + p.muted(l)));
  return block(p, cols, head, d, !failed ? 'ink' : failed === r.samples.length ? 'bad' : 'warn');
}

// ---- Probes ----------------------------------------------------------------------------------------

const probeHead = (p: Paint, name: string, id: string | undefined, took: number | null, more: string[] = []) => dotted([`probe ${name}${dut(p, id)}`, ...more, took !== null ? `${ms(took)} on the device` : '']);

/** A capability probe: ✓ ✗ – in a grid of 3, 2 or 1 columns by width; a long value gets a row of its own. */
export function formatCapabilities(name: string, c: Capabilities, p: Paint, cols: number, ctx: Context = {}): string[] {
  const no = (v: Reading) => v === false || v === 'no';
  const mark = (v: Reading) => (v === null ? G.none : no(v) ? G.no : G.yes);
  const value = (v: Reading) => (typeof v === 'number' || (typeof v === 'string' && v !== 'yes' && v !== 'no') ? clean(String(v)) : '');
  const plain = (it: CapItem) => `${mark(it.v)} ${it.label}${value(it.v) ? `  ${value(it.v)}` : ''}`;
  const paintCell = (it: CapItem, s: string) => (it.v === null || no(it.v) ? p.faint(s) : s);
  const room = cols - 1 - indent() - 2;
  const perRow = cols >= 96 ? 3 : cols >= 66 ? 2 : 1;
  const colW = Math.floor(room / perRow);
  const long = (it: CapItem) => width(value(it.v)) > 16 || width(plain(it)) > colW - 2;
  const items = c.groups.flatMap((g) => g.items);
  const cellW = Math.max(0, ...items.filter((it) => !long(it)).map((it) => width(plain(it)) + 2));

  const d: string[] = [];
  for (const g of c.groups) {
    if (!g.items.length) continue;
    d.push(p.faint(glyphed(g.label)));
    const short = g.items.filter((it) => !long(it));
    for (let i = 0; i < short.length; i += perRow) d.push('  ' + short.slice(i, i + perRow).map((it, j, row) => paintCell(it, j < row.length - 1 ? pad(plain(it), cellW) : plain(it))).join(''));
    for (const it of g.items.filter(long)) {
      const lead = `${mark(it.v)} ${it.label}  `;
      wrap(value(it.v), Math.max(8, room - width(lead))).forEach((l, i) => d.push(paintCell(it, ('  ' + (i ? ' '.repeat(width(lead)) : lead) + l).trimEnd())));
    }
  }
  // What the readings can't say for themselves, said before anyone counts them.
  for (const note of c.notes ?? []) d.push(...wrapStyled(p.warn(clean(note)), room));
  const yes = items.filter((it) => it.v !== null && !no(it.v)).length;
  const nos = items.filter((it) => no(it.v)).length;
  const unknown = items.filter((it) => it.v === null).length;
  d.push(dotted([`${yes} ${G.yes}`, nos ? `${nos} ${G.no}` : '', unknown ? `${unknown} ${G.none} the engine can't say` : '']));
  return block(p, cols, probeHead(p, name, ctx.id, c.wallMs ?? c.ms), d);
}

const SHOWN_KEYS = 12;

/** The storage probe: each area in a row, then its keys. */
export function formatStorage(s: StorageReport, p: Paint, cols: number, ctx: Context = {}): string[] {
  const area = (a: StorageArea | null) => (a ? [plural(a.count, 'key'), bytes(a.bytes)] : [p.faint('unavailable')]);
  const list: [string, string | string[]][] = [
    ['localStorage', area(s.local)],
    ['sessionStorage', area(s.session)],
  ];
  if (s.cookies) list.push(['cookies', [String(s.cookies.count), bytes(s.cookies.bytes)]]);
  const idb = s.indexedDB;
  if (idb)
    list.push([
      'IndexedDB',
      idb.databases === null
        ? [p.faint("can't list them on this engine")]
        : idb.databases.length
          ? [...idb.databases.map((db) => `${clean(db.name)}${db.stores ? ` (${db.stores.map((x) => `${clean(x.name)}${x.count !== null ? ` ${x.count}` : ''}`).join(', ')})` : ''}`), idb.capped ? 'and more' : '']
          : ['none'],
    ]);
  if (s.caches) list.push(['Cache Storage', s.caches.length ? s.caches.map((c) => `${clean(c.name)}${c.entries !== null ? ` ${c.entries}` : ''}`) : ['none']]);
  if (s.workers) list.push(['service workers', s.workers.length ? s.workers.map((w) => `${clean(w.scope)} ${w.state}`) : ['none']]);
  const q = s.quota;
  if (q && q.usageBytes !== null) list.push(['quota', [`${bytes(q.usageBytes)} of ${q.quotaBytes !== null ? bytes(q.quotaBytes) : G.none}`, q.persisted ? 'persisted' : '']]);

  // A long key (auth SDKs write 50 and more) is cut in the middle, so the size and value columns keep their room.
  const keyW = Math.min(28, Math.max(12, cols - indent() - 30));
  const keys = [
    ...(s.local?.entries ?? []).map((e) => ['local', middle(clean(e.key), keyW), bytes(e.bytes), clean(e.preview)]),
    ...(s.session?.entries ?? []).map((e) => ['session', middle(clean(e.key), keyW), bytes(e.bytes), clean(e.preview)]),
  ];
  const d = rows(p, cols, list);
  if (keys.length) d.push(...table(p, cols - indent(), ['area', 'key', 'size', 'value'], keys.slice(0, SHOWN_KEYS), 0));
  const more = (s.local?.count ?? 0) + (s.session?.count ?? 0) - Math.min(keys.length, SHOWN_KEYS);
  if (keys.length && more > 0) d.push(...wrapStyled(p.faint(`and ${more} more: tlpt probe storage --json prints them all`), cols - 1 - indent()));
  return block(p, cols, probeHead(p, 'storage', ctx.id, s.wallMs ?? s.ms), d);
}

/** The dom probe: how big and deep the document is, and where. */
export function formatDom(r: DomReport, p: Paint, cols: number, ctx: Context = {}): string[] {
  const tags = Object.entries(r.counts).filter(([, n]) => n > 0);
  const list: [string, string | string[]][] = [
    ['text nodes', [String(r.textNodes)]],
    ['depth', [String(r.depth), clean(r.deepest)]],
  ];
  if (r.largest) list.push(['largest', [clean(r.largest.path), plural(r.largest.descendants, 'descendant')]]);
  if (r.widest) list.push(['widest', [clean(r.widest.path), plural(r.widest.children, 'child', 'children')]]);
  list.push(['tags', tags.length ? tags.map(([t, n]) => `${t} ${n}`) : ['none counted']], ['styles', [plural(r.stylesheets, 'stylesheet'), r.rules !== null ? plural(r.rules, 'rule') : '']]);
  return block(p, cols, probeHead(p, 'dom', ctx.id, r.ms, [plural(r.elements, 'element')]), rows(p, cols, list));
}

/** What the engine drops from the app's style sheets, the most used first. */
export function formatStyles(r: StylesReport, p: Paint, cols: number, ctx: Context = {}): string[] {
  const SHOWN = 12;
  const part = (list: StylesReport['selectors']) => [
    ...list.slice(0, SHOWN).map((d) => `${clean(d.text)}  ${p.faint(`${clean(d.at)}${d.uses > 1 ? `, ${d.uses} uses` : ''}`)}`),
    ...(list.length > SHOWN ? [p.faint(`and ${list.length - SHOWN} more`)] : []),
  ];
  const list: [string, string | string[]][] = [
    ['read', [`${plural(r.sheets - r.unread.length, 'sheet')}, ${plural(r.rules, 'rule')}, ${plural(r.declarations, 'declaration')}`, p.faint(`${plural(r.questions, 'question')}, ${r.ms} ms of the device's time`)]],
    ['selectors', r.selectors.length ? [`${r.selectors.length} this engine can't parse: each loses its whole rule`, ...part(r.selectors)] : ['every selector parses']],
    ['declarations', r.properties.length ? [`${r.properties.length} this engine drops${r.supports ? '' : p.faint(' (no CSS.supports: judged by setting each on a style)')}`, ...part(r.properties)] : ['every declaration is kept']],
  ];
  if (r.unread.length) list.push(['not read', r.unread.map((u) => `${clean(u.href)}  ${p.faint(clean(u.why))}`)]);
  return block(p, cols, probeHead(p, 'styles', ctx.id, r.ms), rows(p, cols, list));
}

/** The focus probe: what has focus, what the focus class marks, and its box. */
export function formatFocus(r: FocusReport, p: Paint, cols: number, ctx: Context = {}): string[] {
  const list: [string, string | string[]][] = [
    ['DOM focus', [r.active ? clean(r.active) : p.faint('nothing')]],
    ['focus class', [r.marked ? clean(r.marked) : p.faint('nothing marked'), p.faint(clean(r.selector))]],
    ['reachable', [`${plural(r.focusable, 'element')} the keyboard can reach`]],
  ];
  if (r.box) list.push(['box', [`${r.box[2]} by ${r.box[3]} px at ${r.box[0]}, ${r.box[1]}`]]);
  return block(p, cols, probeHead(p, 'focus', ctx.id, r.ms), rows(p, cols, list));
}

/** The speed probe: four fixed pieces of work and how long each took, the yardstick to compare devices by. */
export function formatSpeed(r: SpeedReport, p: Paint, cols: number, ctx: Context = {}): string[] {
  const list = (Object.keys(SPEED_WORK) as SpeedWork[]).map((k): [string, string[]] => {
    const took = r[k];
    if (took === null) return [k, [p.faint("couldn't run on this engine")]];
    // Against the same source run on this laptop, where it can run here: how many times longer the device takes.
    const here = k === 'js' || k === 'json' ? r.laptop[k] : 0;
    const times = here > 0 ? took / here : 0;
    // Fewer runs than usual is said: one run of slow work is a rougher number than the median of five.
    return [k, [took >= 1000 ? span(took) : ms(took), p.faint(SPEED_WORK[k]), r.runs[k] < SPEED_RUNS ? p.faint(plural(r.runs[k], 'run')) : '', times ? p.faint(`${times >= 10 ? Math.round(times) : r1(times)} times this laptop`) : '']];
  });
  return block(p, cols, probeHead(p, 'speed', ctx.id, r.ms), rows(p, cols, list));
}

export function formatProbe(name: string, result: unknown, p: Paint, cols: number, ctx: Context = {}): string[] {
  if (name === 'speed') return formatSpeed(result as SpeedReport, p, cols, ctx);
  if (name === 'storage') return formatStorage(result as StorageReport, p, cols, ctx);
  if (name === 'dom') return formatDom(result as DomReport, p, cols, ctx);
  if (name === 'focus') return formatFocus(result as FocusReport, p, cols, ctx);
  return formatCapabilities(name, result as Capabilities, p, cols, ctx);
}

// ---- Requests, keys, eval, guide -------------------------------------------------------------------

/** One entry of api/network. */
export interface NetworkRow {
  method: string;
  url: string;
  status: number;
  bytes: number;
  ttfbMs: number;
  durMs: number;
  failed?: string;
}

const failedRow = (r: { status: number; failed?: string }) => !!r.failed || r.status >= 400;

/** The device's requests through tlpt: failures red, paths cut in the middle to fit, and the flags that narrow them. */
export function formatNetwork(list: NetworkRow[], p: Paint, cols: number, ctx: Context = {}, filtered = false): string[] {
  const failed = list.filter(failedRow).length;
  const head = dotted([`requests${dut(p, ctx.id)}`, list.length ? `the last ${list.length}` : '', failed ? p.bad(`${failed} failed`) : '']);
  if (!list.length) return block(p, cols, head, [p.faint(filtered ? 'none match' : 'none through tlpt since the page loaded')]);
  // tlpt records each request on the address the device used to reach it, so when the page's own
  // address isn't given, the one most requests share is it.
  const seen = new Map<string, number>();
  for (const o of list.map((r) => originOf(r.url)).filter(notNull)) seen.set(o, (seen.get(o) ?? 0) + 1);
  const origin = originOf(ctx.href) ?? [...seen].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const room = cols - 1 - indent();
  const names = ['status', 'method', 'time', 'size'];
  const cells = list.map((r) => [r.failed ? 'fail' : String(r.status), r.method, ms(r.durMs), bytes(r.bytes)]);
  const widths = names.map((h, i) => Math.max(width(h), ...cells.map((c) => width(c[i]!))));
  const line = (c: string[], last: string) => [...c.map((x, i) => pad(x, widths[i]!)), last].join('  ');
  const pathRoom = room - width(line(names, ''));
  const d = [p.faint(line(names, 'path'))];
  list.forEach((r, i) => {
    const why = r.failed ? ` ${G.sep} ${clean(r.failed)}` : '';
    const l = truncate(line(cells[i]!, middle(shown(r.url, origin), Math.max(12, pathRoom - width(why))) + why), room);
    d.push(failedRow(r) ? p.bad(l) : l);
  });
  d.push(...flow(['--failed', '--url text', '--min-ms n', '--limit n'], room).map((l) => p.faint(l)));
  return block(p, cols, head, d);
}

export interface ErrorsAnswer {
  id: string;
  href: string;
  engine: string;
  total: number;
  errors: PageError[];
}

/** One error for a person: what and where, then the source around it with a mark under the column, then what it likely means. */
export function errorDetail(e: PageError, p: Paint, room: number): string[] {
  const out: string[] = [];
  if (e.near) {
    const from = Math.max(0, Math.min(e.near.caret - Math.floor(room / 2), e.near.text.length - room));
    // Dashes up to the mark: leading spaces would be taken for indentation and wrapped away.
    out.push(p.muted(clean(e.near.text.slice(from, from + room))), p.faint('-'.repeat(Math.max(0, e.near.caret - from))) + p.bad('^'));
  }
  if (e.hint) out.push(e.hint);
  return out;
}

/** What the page threw since it loaded, oldest first, with how many more there were than are held. */
export function formatErrors(a: ErrorsAnswer, p: Paint, cols: number, ctx: Context = {}): string[] {
  const head = dotted([`errors${dut(p, ctx.id ?? a.id)}`, a.total ? p.bad(String(a.total)) : '', a.engine]);
  if (!a.total) return block(p, cols, head, [p.faint('none since the page loaded')]);
  const room = cols - 1 - indent() - 2;
  const d: string[] = [];
  let last = -1;
  for (const e of a.errors) {
    if (e.n > last + 1) d.push(p.faint(`${e.n - last - 1} more, counted on the device and not kept`));
    last = e.n;
    d.push(...wrapStyled(`${p.faint(`${e.n + 1}`)} ${p.bad(clean(errorLine(e)))} ${p.faint(`${G.sep} ${ms(e.atMs)} in`)}`, room + 2));
    d.push(...errorDetail(e, p, room).flatMap((l) => wrapStyled(l, room)).map((l) => '  ' + l));
  }
  if (a.total > last + 1) d.push(p.faint(`${a.total - last - 1} more, counted on the device and not kept`));
  return block(p, cols, head, d);
}

/** A key sequence as the words that would ask for it. */
const sequenceOf = (run: RemoteRun) =>
  run.steps.map((s) => (s.kind === undefined ? Array<string>(s.repeat).fill(s.key).join(' ') : s.kind === 'wait' ? `wait ${s.ms} ms` : s.kind === 'text' ? `type "${s.text}"` : `${s.kind} ${s.selector}`)).join(' ');

/** How a key sequence ended: pressed, stopped part way (a routine line), or failed with why. */
export function formatKeys(run: RemoteRun, p: Paint, cols: number, ctx: Context = {}): string[] {
  const of = `${run.presses} of ${presses(run.steps)}`;
  const what = `keys${dut(p, ctx.id)}`;
  if (run.phase === 'failed') return block(p, cols, `${what} failed after ${of}`, run.error ? [clean(run.error)] : [], 'bad', { wrap: true });
  const stopped = run.phase === 'stopped';
  return block(p, cols, dotted([what, clean(sequenceOf(run)), stopped ? `stopped after ${of}` : `${run.presses} pressed`]), [], stopped ? 'faint' : 'ink');
}

/** What `hear` answers: each thing heard, named, and the keys the device was heard sending. */
export interface HearAnswer {
  heard: Heard[];
  learned: { id: string; press: Press; name: string }[];
  sends: Record<string, Press>;
}

/** A press as a person reads it: its key name and its code, `GamepadA 195`. */
const sp = () => ` ${G.sep} `;
const pressText = (x: Press) => [x.key, String(x.keyCode)].filter(Boolean).join(' ');

/**
 * What the page heard, a line each: who pressed it, what it is, the codes the page got, the remote
 * key it stands for, and what the page did with it (taken: it cancelled the key; clicked; focus
 * moved; the page changed), or that nothing changed. Then what the remote sends now.
 */
export function formatHear(a: HearAnswer, p: Paint, cols: number, ctx: Context = {}): string[] {
  const keys = a.heard.filter((h) => h.kind === 'key');
  const head = dotted([`hear${dut(p, ctx.id)}`, a.heard.length ? `${a.heard.length} heard` : 'nothing heard']);
  const cells = a.heard.map((h) => [
    h.from === 'device' ? p.ink('device') : p.faint('sent'),
    p.ink(clean(h.what.name)),
    p.muted(h.kind === 'button' ? `gamepad button ${h.keyCode}` : clean([h.key, String(h.keyCode)].filter(Boolean).join(' '))),
    h.what.id ? p.accent(h.what.id) : p.faint(G.none),
    h.kind === 'button'
      ? p.faint('Gamepad API: no key event')
      : h.took || h.clicked || h.to || h.changed
        ? p.ink([h.took ? 'taken' : '', h.clicked ? 'clicked' : '', h.to ? `focus ${G.right} ${clean(h.to)}` : '', h.changed && !h.to && !h.clicked ? 'page changed' : ''].filter(Boolean).join(sp()))
        : p.warn('nothing changed'),
  ]);
  const detail = cells.length ? align(cells, 2) : [p.faint('press keys on the device\'s own remote while it listens')];
  if (a.heard.some((h) => h.kind === 'button') && !keys.some((h) => h.from === 'device')) detail.push(p.muted('the controller is read through the Gamepad API: the page polls it, and no key press reaches it'));
  for (const l of a.learned) detail.push(`${p.faint('learned')}  ${p.accent(l.id)} ${p.ink(`is ${clean(l.name)} (${clean(pressText(l.press))}) on this device`)}${p.faint(sp() + 'the remote sends that now')}`);
  const sends = Object.entries(a.sends).map(([id, x]) => `${id} ${clean(pressText(x))}`);
  if (sends.length) detail.push(`${p.faint('sends')}  ${p.muted(sends.join(sp()))}`);
  return block(p, cols, head, detail);
}

const EVAL_LINES = 20;

/** An expression's value: strings quoted, objects as indented JSON, at most 20 lines. */
export function formatEval(expr: string, value: unknown, p: Paint, cols: number, ctx: Context = {}): string[] {
  const room = cols - 1 - indent();
  const tail = ctx.id ? ` ${G.sep} ${p.bold(ctx.id)}` : '';
  // The expression is cut before the device's id, so a long one doesn't push the id off the line.
  // On one line however it was written: an agent's code comes indented over several.
  const head = `eval ${truncate(clean(expr).replace(/ {2,}/g, ' ').trim(), Math.max(12, cols - 1 - width(`${G.dot} eval ${tail}`)))}${tail}`;
  let text: string | undefined;
  try {
    text = JSON.stringify(value, null, value !== null && typeof value === 'object' ? 2 : undefined);
  } catch {
    text = String(value);
  }
  const shown: string[] = [];
  let total = 0;
  for (const l of (text ?? 'undefined').split('\n')) {
    total += Math.max(1, Math.ceil(width(l) / room));
    // Only as much of a line as can still be shown is broken up, so a megabyte string costs little.
    const left = EVAL_LINES - shown.length;
    if (left > 0) shown.push(...breakAt(l.slice(0, left * room * 2), room).slice(0, left));
  }
  const more = total - shown.length;
  return block(p, cols, head, more > 0 ? [...shown, p.faint(`${G.ellipsis} ${plural(more, 'more line')}`)] : shown);
}

/** Plain text broken every `room` columns: at the width rather than at spaces, which would lose JSON's indentation. */
function breakAt(s: string, room: number): string[] {
  const out: string[] = [];
  let line = '';
  let w = 0;
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0)!);
    if (w + cw > room) {
      out.push(line);
      [line, w] = ['', 0];
    }
    line += ch;
    w += cw;
  }
  return [...out, line];
}

/** guide's answer: the topics, or the entries that match some words. */
export interface GuideAnswer {
  topics?: { id: string; title: string }[];
  matches?: { id: string; title: string; why: string; shows: string[]; try: string[]; ask: string[] }[];
}

/** The topics as id and title; a match as its title, why it matters on a device, what shows it, what to try and what to ask. */
export function formatGuide(g: GuideAnswer, p: Paint, cols: number): string[] {
  if (g.topics) {
    const w = Math.max(...g.topics.map((t) => width(t.id))) + 2;
    return block(p, cols, dotted(['guide', plural(g.topics.length, 'topic')]), g.topics.map((t) => pad(t.id, w) + p.muted(t.title)));
  }
  const room = cols - 1 - indent();
  const out = (g.matches ?? []).flatMap((m) =>
    block(p, cols, `${p.bold(m.title)} ${p.faint(m.id)}`, [
      ...wrap(m.why, room).map((l) => p.muted(l)),
      ...rows(p, cols, [
        ['shows', m.shows],
        ...m.try.map((t, i): [string, string[]] => [i ? '' : 'try', [t]]),
        ['ask', [`${plural(m.ask.length, 'check')} for a trial`, `tlpt guide ${m.id} --json prints them`]],
      ]),
    ]),
  );
  return out.length ? out : block(p, cols, 'guide', [p.faint('nothing matched; guide with no words lists the topics')]);
}

/**
 * A command's answer as lines for a person. `at` says what the answer can't: the port tlpt is on,
 * for the no-device line, and the device page's address, so its URLs show as paths.
 */
export function humanize(name: string, args: Record<string, unknown>, said: unknown, id: string | undefined, p: Paint, cols: number, at: Omit<Context, 'id'> = {}): string[] {
  const ctx: Context = { ...at, id };
  // What the device said is printed as text, never obeyed as escapes (text.ts `printable`).
  const data = printable(said);
  switch (name) {
    case 'status':
    case 'devices':
      return formatDuts(data as LiveDut[], p, cols, at.port, name === 'devices');
    case 'device':
      return formatDevice(data as DeviceSnapshot, p, cols);
    case 'errors':
      return formatErrors(data as ErrorsAnswer, p, cols, ctx);
    case 'network':
      return formatNetwork(data as NetworkRow[], p, cols, ctx, args.url !== undefined || args.minMs !== undefined || !!args.failed);
    case 'capture':
      return formatCapture(data as Report, p, cols, ctx);
    case 'probe':
      return formatProbe(String(args.name), data, p, cols, ctx);
    case 'trial':
      return formatTrial(data as TrialReport, p, cols);
    case 'try': {
      const d = data as { toggles?: { name: string; brief: string }[]; verdicts?: VerifyRow[] };
      if (d.toggles) return block(p, cols, 'try', [...rows(p, cols, d.toggles.map((t) => [t.name, t.brief] as [string, string])), p.faint('try <name> flips it on the device and measures both ways')]);
      return d.verdicts ? formatVerify(d as VerifyAnswer, p, cols, ctx) : formatTrial(data as TrialReport, p, cols);
    }
    case 'verify':
      return formatVerify(data as VerifyAnswer, p, cols, ctx);
    case 'keys':
      return formatKeys(data as RemoteRun, p, cols, ctx);
    case 'hear':
      return formatHear(data as HearAnswer, p, cols, ctx);
    case 'eval':
      return formatEval(String(args.expression), (data as { value: unknown }).value, p, cols, ctx);
    case 'guide':
      return formatGuide(data as GuideAnswer, p, cols);
    case 'styles':
      return formatStyles(data as StylesReport, p, cols, ctx);
    case 'survey':
      return formatSurvey(data as SurveyAnswer, p, cols);
    case 'report':
      if (isObj(data) && typeof (data as { html?: unknown }).html === 'string') return formatSurvey({ report: (data as { html: string }).html, ...(data as object) } as SurveyAnswer, p, cols, 'report written');
      break;
    case 'history':
      return formatHistory(data as HistoryAnswer, p, cols);
    case 'replay':
      return formatReplay(data as ReplayData, p, cols, ctx);
    case 'shim':
      return formatShim(data as ShimAnswer, p, cols, ctx);
  }
  return block(p, cols, name, [JSON.stringify(data)]);
}

interface VerifyRow {
  name: string;
  plays: boolean | null;
  firstFrameMs: number | null;
  dropped: number | null;
  why: string | null;
  saidYes: boolean;
}
interface VerifyAnswer {
  verdicts: VerifyRow[];
  notMade?: Record<string, string>;
}

/** What played: a line per clip, with the engine's own answer beside it where the two disagree. */
function formatVerify(r: VerifyAnswer, p: Paint, cols: number, ctx: Context): string[] {
  const played = r.verdicts.filter((v) => v.plays).length;
  const line = (v: VerifyRow): string => {
    if (v.plays) return [p.good('plays'), ...(v.firstFrameMs !== null ? [`first frame ${Math.round(v.firstFrameMs)} ms`] : []), ...(v.dropped ? [p.warn(`${v.dropped} dropped`)] : []), ...(v.saidYes ? [] : [p.warn('though the engine said no')])].join(` ${G.sep} `);
    return [p.bad(v.plays === null ? 'not run' : "doesn't play"), ...(v.why ? [v.why] : []), ...(v.saidYes ? [p.bad('though the engine said yes')] : [])].join(` ${G.sep} `);
  };
  const missing = Object.keys(r.notMade ?? {});
  const detail = [
    ...rows(p, cols, r.verdicts.map((v) => [v.name, line(v)] as [string, string])),
    ...(r.verdicts.length ? [] : [p.faint('no clip has that name: hevc, h264, vp9, av1, aac, ac-3, opus, switch, clearkey')]),
    ...(missing.length ? [p.faint(`not made on this laptop (ffmpeg): ${missing.join(', ')}`)] : []),
  ];
  return block(p, cols, `clips played${dut(p, ctx.id)} ${G.sep} ${played} of ${r.verdicts.length} play`, detail, r.verdicts.some((v) => v.plays === false) ? 'warn' : 'ink');
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

interface SurveyAnswer {
  dir?: string;
  report: string;
  device?: { name?: string; model?: string };
  content?: { title?: string | null };
  advice?: { level: 'must' | 'should' | 'could'; title: string }[] | string[] | null;
  must?: number;
  should?: number;
  could?: number;
}

/** Where a survey went, first and clickable, then what it found: the report is the point of running it. */
export function formatSurvey(s: SurveyAnswer, p: Paint, cols: number, head = 'survey saved'): string[] {
  const fileUrl = (path: string) => `file://${path.split('/').map(encodeURIComponent).join('/')}`;
  const url = s.report.startsWith('file:') ? s.report : fileUrl(s.report);
  const dir = s.dir ?? s.report.replace(/\/[^/]+$/, '');
  // The home folder as ~, so the path fits; the link itself carries the whole of it.
  const home = process.env.HOME;
  const short = (path: string) => (home && path.startsWith(home + '/') ? '~' + path.slice(home.length) : path);
  const list = (s.advice ?? []).map((a) => (typeof a === 'string' ? { level: a.split(':')[0] as 'must', title: a.replace(/^\w+:\s*/, '') } : a));
  const count = (l: string) => s[l as 'must'] ?? list.filter((a) => a.level === l).length;
  const tally = dotted([`${count('must')} must`, `${count('should')} should`, `${count('could')} could`]);
  const name = s.device?.name ?? s.device?.model;
  const title = s.content?.title;
  const lead = list.filter((a) => a.level !== 'could').slice(0, 5).map((a): [string, string] => [a.level, a.title]);
  return block(p, cols, `${p.good(head)}${name ? ` ${G.sep} ${p.bold(name)}` : ''}${title ? ` ${G.sep} ${title}` : ''}`, [
    ...rows(p, cols, [
      ['report', p.link(url, short(dir) + '/report.html')],
      ['folder', p.link(fileUrl(dir) + '/', short(dir))],
      ['advice', tally],
      ...lead,
    ]),
  ]);
}

// ---- The journal, replay and shim ----------------------------------------------------------------------

interface HistoryAnswer {
  file: string;
  model: string | null;
  experiments: { at: string; id: string; page: string; by: string; kind: string; what: string; ms: number; error?: string; gist: string }[];
}

/** The home folder as ~, so a path fits. */
const short = (path: string) => {
  const home = process.env.HOME;
  return home && path.startsWith(home + '/') ? '~' + path.slice(home.length) : path;
};

/** A time as the clock said it, hh:mm, for a list that doesn't count up. */
const hhmm = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** The journal, newest first: when, what ran, who when not the console, and a line of its answer. */
export function formatHistory(h: HistoryAnswer, p: Paint, cols: number): string[] {
  const list = h.experiments ?? [];
  const head = dotted(['history', h.model ? p.bold(h.model) : 'every device', plural(list.length, 'experiment')]);
  if (!list.length) return block(p, cols, head, [p.faint('nothing kept yet: capture, probe, try or survey, and each lands here'), p.faint(short(h.file))]);
  const room = cols - 1 - indent();
  const lines = list.map((e) => {
    const who = e.by && e.by !== 'console' ? p.muted(e.by) + ' ' : '';
    const said = e.error ? p.bad(`${G.no} ${e.error}`) : p.muted(e.gist || span(e.ms));
    return truncate(`${p.faint(hhmm(e.at))}  ${e.error ? p.bad(G.no) : p.good(G.yes)} ${who}${p.ink(e.what)}${e.gist || e.error ? `  ${said}` : ''}`, room);
  });
  return block(p, cols, head, [...lines, p.faint(`kept in ${short(h.file)}`)]);
}

interface ReplayData {
  tapes?: { name: string; steps: number; ms: number; model: string; savedAt: string }[];
  saved?: string;
  name?: string;
  presses?: number;
  ms?: number;
  skipped?: number;
  keys?: RemoteRun;
  capture?: Report;
  partial?: boolean;
}

/** The tapes, a tape just kept, or a journey pressed again with its capture. */
export function formatReplay(r: ReplayData, p: Paint, cols: number, ctx: Context): string[] {
  if (r.tapes) {
    if (!r.tapes.length) return block(p, cols, 'replay', [p.faint('no tapes yet: press keys on the device, then replay save <name>')]);
    return block(p, cols, dotted(['replay', plural(r.tapes.length, 'tape')]), [
      ...rows(p, cols, r.tapes.map((t) => [t.name, dotted([plural(t.steps, 'press', 'presses'), span(t.ms), t.model, hhmm(t.savedAt)])] as [string, string])),
      p.faint('replay <name> presses one again and captures it'),
    ]);
  }
  if (r.saved) return block(p, cols, dotted([p.good('tape kept'), p.bold(r.name ?? ''), plural(r.presses ?? 0, 'press', 'presses'), span(r.ms ?? 0)]), [p.faint(short(r.saved)), ...(r.skipped ? [p.faint(`${plural(r.skipped, 'press', 'presses')} of no remote key left out`)] : []), p.faint(`replay ${r.name} presses it again and captures it`)]);
  const head = block(p, cols, dotted([`replay ${p.bold(r.name ?? '')}${dut(p, ctx.id)}`, plural(r.presses ?? 0, 'press', 'presses'), span(r.ms ?? 0)]), [
    ...(r.keys?.error ? [p.bad(r.keys.error)] : []),
    ...(r.partial ? [p.warn('a capture is at most 10 s: this is the journey\'s first 10 s')] : []),
  ], r.keys?.error ? 'bad' : 'ink');
  return r.capture ? [...head, ...formatCapture(r.capture, p, cols, ctx)] : head;
}

interface ShimAnswer {
  on: boolean;
  filled?: string[] | null;
  names: string[];
  reloaded?: string[];
}

/** Whether the shim is on, and what the page filled with it. */
export function formatShim(s: ShimAnswer, p: Paint, cols: number, ctx: Context): string[] {
  const room = cols - 1 - indent();
  if (s.reloaded) return block(p, cols, dotted([`shim ${s.on ? p.good('on') : 'off'}`, s.reloaded.length ? `reloading ${s.reloaded.join(', ')}` : 'no device to reload']), [p.faint(s.on ? 'pages tlpt serves load it ahead of the app; shim says what each filled' : 'pages load without it from now on')]);
  if (!s.on) return block(p, cols, 'shim off', wrap(`shim on fills in ${plural(s.names.length, 'built-in')} old engines lack, ahead of the app's own scripts: ${s.names.slice(0, 6).join(', ')}, …`, room).map((l) => p.faint(l)));
  if (!s.filled) return block(p, cols, dotted([`shim ${p.good('on')}`, `nothing heard from the page${dut(p, ctx.id)}`]), [p.faint('reload the page, or it was loaded before shim was on')]);
  return block(p, cols, dotted([`shim ${p.good('on')}${dut(p, ctx.id)}`, s.filled.length ? `filled ${plural(s.filled.length, 'built-in')}` : 'the engine had all of them']), wrap(s.filled.join(', '), room).map((l) => p.ink(l)));
}
