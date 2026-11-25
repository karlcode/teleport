// The console: what `tlpt` shows while it runs. Event lines scroll above, into the terminal's own
// history; at the bottom a live region shows each device with the few numbers that matter on a device, what is
// running on it, and a line of shortcuts. Keys act on the selected device. `/` opens the same commands as
// `tlpt q`, with completion, and prints their answers here. Everything the server does to a device prints
// a line, whoever asked for it, so a developer sees what an AI agent did on their device too.
//
// The console reads what the laptop already has (each device's samples, DevTools and inspector state);
// it never asks a device for anything the person didn't ask for. Each device's numbers are derived once per
// sample (vitals.ts). The region is a pure function of the console's state (view), drawn when a
// sample arrives, a key is pressed, every 100 ms while something runs, and once a second while
// something on screen counts time.
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { errorLine, type PageError } from './errors.js';
import { block, errorDetail, formatHear, humanize, spark, type HearAnswer } from './format.js';
import { initLine, type Caller, type ServerEvent } from './live.js';
import { PROBE_IDS, PROBES } from './probes.js';
import { argsFromWords, COMMANDS, nearest, paramForm, parseQ, request, runData, type Args, type Command } from './q.js';
import { entriesOf, entry, GROUPS, MENU, REMOTE_KEYS as REMOTE, type Entry, type Group } from './menu.js';
import { listTapes } from './replay.js';
import type { Heard } from './hear.js';
import { KEY, KEYS, type KeyId, type Press, type RemoteRun } from './remote.js';
import { inspectUrl } from './server.js';
import { CODEC_WORDS, OWN, TOGGLES, type Toggle } from './toggles.js';
import { PlainScreen, type Key, type Screen } from './term.js';
import { charWidth, pad, printable, truncate, width, wrap } from './text.js';
import { ASCII, BEAM_MS, beam, G, inGlyphs, paint, plain as plainText, type Color, type Paint } from './tui.js';
import { describeUa } from './ua.js';
import { alarms, BLOCKED_MS, HEAP_ALARM, HEAP_SHARE, KEY_MS, MAIN_MS, presses, RTT_MS, vitalsOf, watch, type Alarm, type Recording, type Vitals, type Watch } from './vitals.js';

/** What the console reads about a device: a structural slice of the server's Device. */
export interface DutSource {
  id: string;
  ua: string;
  ip: string;
  href: string;
  clients: { size: number };
  cdp: unknown;
  governor: { level: number; reason: string };
  errors: { total: number };
  session: Recording;
}

export interface ConsoleOptions {
  screen: Screen;
  color: Color;
  /** A light terminal background (tui.lightBackground): plainer tones. */
  light?: boolean;
  port: number;
  /** teleport's key, which DevTools' links carry (key.ts). */
  key: string;
  /** The devices connected now, newest last. */
  duts: () => Iterable<DutSource>;
  /** Opens DevTools for a device in the browser. */
  openDevtools: (id: string) => void;
  /** Asks the device's page to reload. */
  reload: (id: string) => void;
  quit: () => void;
  /** The device link, shown while no device is connected. */
  dutLink: string | null;
  /** tlpt serves no app yet: the device link shows a page that waits for one, and a port typed in
   *  the input names it. */
  appless?: boolean;
  /** Serves another app: a port, an address or a folder, as typed. Resolves with why not, or null. */
  connect?: (what: string) => Promise<string | null>;
  /** This laptop's address and port, which an app's `teleport.init` is given when tlpt serves none. */
  lan?: string;
  /**
   * What happened about DevTools when a device connected, which cli.ts records in onTab just before the
   * server emits 'page': opened in the browser, opened in the tab that was waiting for a device, or not
   * opened (--no-open, the opens-a-minute limit, or SSH), so d or the link opens it.
   */
  devtoolsNote?: (id: string) => DevtoolsNote | undefined;
  cwd?: string;
  /** The lines pinned at the top (tui.ts header): the console adds a card for each device under them. */
  header?: string[];
  /** For tests: the clock. */
  now?: () => number;
}

export type DevtoolsNote = 'opened' | 'tab' | 'link';

/** Things that happen on the laptop rather than to a device, which cli.ts hands the console to print. */
export type ConsoleNote =
  /** bin/watch.js rebuilt the agent and reloaded this many devices. */
  | { type: 'build'; name: string; reloaded: number }
  | { type: 'build-failed'; name: string; error: string }
  /** A tunnel for the app: tlpt took it over (`took`), or the tunnel kept it on the app. `lan` is
   *  tlpt's own address for the app on this network, which needs no tunnel. */
  | { type: 'tunnel'; url: string; app: string; took: boolean; port: number; lan?: string }
  /** tlpt serves another app now: typed in the input, or a dev server found running. */
  | { type: 'serving'; app: string; found: boolean; reloaded: number }
  /** tlpt's own tunnel (--tunnel) is up at this address. */
  | { type: 'own-tunnel'; url: string }
  /** An older tlpt on this port stepped aside. */
  | { type: 'retired'; port: number }
  /** Whether the app's address takes a connection. An app on this machine that isn't listening yet
   *  is waited for (said when it doesn't, and when it does); anything else says `why`. */
  | { type: 'app'; app: string; up: boolean; why?: string };

/** Each entry's letter: typed alone, then Enter, it runs the entry with its defaults. */
const HOTKEYS = new Map(MENU.filter((e) => e.key).map((e) => [e.key!, e]));

// How long things stay on screen, and how often they may be said.
const GONE_SHOWN_MS = 60_000;
/** A device that went away is said after this long, so a reload, which goes and comes back, prints one line. */
const HOLD_GONE_MS = 5000;
const NOTICE_MS = 2000;
/** The window for the second q of q q, and the second esc of a trial's esc esc. */
const ARM_MS = 2000;
/** With no page through tlpt this long after it started, the waiting line suggests why. */
const QUIET_MS = 60_000;
/** A page that loaded with no agent connecting after this long gets a line. */
const NO_AGENT_MS = 15_000;
/** A reload asked for (l, a build, shim, another app) is counted down this long on the device's row and
 *  card; it doesn't get the heap note, and a device not back by then is said. */
const RELOAD_ASKED_MS = 10_000;
/** How long after a device connects its screen and cores are read, once per kind of device, for its card. */
const SPECS_AFTER_MS = 3000;
/** ES5: the few facts the card shows, read once. */
const SPECS_SCRIPT = "(function(){var n=navigator,s=screen,w=window;return JSON.stringify({screen:s.width+'x'+s.height,dpr:w.devicePixelRatio||1,cores:n.hardwareConcurrency||null,memoryGB:n.deviceMemory||null})})()";
/** Cards shown in the pinned header at most; the rest are rows at the bottom. */
const CARDS = 3;
const SAME_REQUEST_MS = 60_000;
/** Errors of one page load said in full as they happen; the rest show as a count on the device's row. */
const ERRORS_SAID = 3;
const REQUEST_BURST = 3;
const REQUEST_BURST_MS = 10_000;
const MAX_REQUEST_KEYS = 1000;

// The row's tones beyond vitals.ts's shared thresholds: silence, freshness and the alert cells.
const SILENT_MS = 3000;
const DEAD_MS = 10_000;
const KEY_FRESH_MS = 10_000;
const KEY_SHOWN_MS = 60_000;
const FULL_IN_MIN = 60;
const FULL_IN_BAD = 15;
const BACKLOG_KB = 64;
const DEVTOOLS_BEHIND_MS = 1000;

const SPIN_MS = BEAM_MS;
const MAX_INPUT = 4096;
/** Piped, a long answer is cut here, with the command that prints all of it. */
const RESULT_LINES = 60;
/** How often remote mode asks the page what it heard, and how many of those it shows. */
const HEAR_EVERY_MS = 600;
const HEARD_SHOWN = 5;
/** A pressed key stays lit on the drawn remote this long. */
const LIT_MS = 300;
/** An entry that only reads what the laptop has is asked again this often while it is on screen. */
const LIVE_MS = 2000;
/** Runs of an entry kept, and shown on the right; presses shown in the remote. */
const RUNS_KEPT = 20;
const RUNS_SHOWN = 4;
const PRESSES_SHOWN = 4;
/** The last press on the device shows beside remote in the list this long. */
const PRESS_SHOWN_MS = 3000;
/** The entries the right side shows live, and what each is asked with: they cost the device nothing. */
const LIVE: Record<string, Args> = { errors: {}, network: { limit: 20 }, device: { seconds: 60 }, devices: {}, status: {}, keymap: {}, history: { limit: 20 } };
/** Live entries that need no device: they answer for all of them. */
const ANY_DEVICE = new Set(['devices', 'status', 'history']);
/** The entries whose right side is the remote. */
const REMOTE_SIDE = new Set(['remote', 'keys', 'hear', 'keymap']);
const REMOTE_WAITING = 4;
const TRAIL = 4;
const CAPTURE_S = 10;
/** From this width the device row is the wide one: the platform after the id, 16 bars, 3-space gaps. */
const WIDE = 100;

/** How an event line names who asked, when it wasn't this console. */
const WHO: Record<Caller, string> = { console: '', q: 'q', mcp: 'mcp', other: 'API' };

const cmd = (name: string) => COMMANDS.find((c) => c.name === name)!;

/** A group's row in the list is highlighted as this prefix and its name; an entry's as its name. */
const GROUP = 'group:';
const isGroup = (at: string) => at.startsWith(GROUP);
const groupOfAt = (at: string): Group => (isGroup(at) ? (at.slice(GROUP.length) as Group) : (entry(at)?.group ?? 'measure'));

// ---- The live region, as a pure function of what the console knows ---------------------------------

export interface DutView {
  id: string;
  ua: string;
  /** ms since its last frame; null before the first. */
  silentMs: number | null;
  v: Vitals | null;
  /** DevTools windows open on it. */
  devtools: number;
  /** The inspector is loaded: by DevTools, an API call's lease, or remote mode. */
  inspector: boolean;
  /** The inspector governor's level: 1 shedding, 2 paused. */
  governor: number;
  /** What the page threw since it loaded. */
  errors: number;
  /** The test run that holds it, by name. */
  held?: string | null;
  /** A reload was asked for: ms left of the time it has to come back. */
  reloadMs: number | null;
}

/**
 * A row of the list on the left: one of the five groups, or an entry of the one that is open. A
 * group shows its letters and anything that needs a look while it is closed.
 */
export interface ListRow {
  kind: 'group' | 'entry';
  group: Group;
  name: string;
  /** The letter that runs it. */
  key?: string;
  /** Something of this kind (or in this group) runs on a device now. */
  running: boolean;
  /** Its last run failed. */
  failed: boolean;
  /** A few cells beside its name that don't count up: the clock time it last ran, a count, the last key pressed. */
  status: string;
  /** A group whose entries are listed under it. */
  open?: boolean;
}

/** The input line: what is typed, the caret, and what its right side says. */
export interface InputView {
  text: string;
  /** Where the caret is, as an index into text. */
  caret: number;
  /** A mistake, said in red; otherwise the keys that act now. */
  error: string | null;
  hint: string;
  /** The device a line runs on, and how it is: live, quiet a few seconds, or gone quiet. */
  on: string | null;
  tone?: 'good' | 'warn' | 'bad';
}

export interface ViewState {
  p: Paint;
  color: Color;
  now: number;
  port: number;
  /** Keys can arrive. */
  interactive: boolean;
  duts: DutView[];
  gone: { id: string; ua: string; ms: number; waiting: boolean; reloadMs: number | null }[];
  /** The device keys act on. */
  selected: string | null;
  /** No device yet: where to open, and whether something is wrong (nothing opened it, the app doesn't answer). */
  waiting: { link: string | null; lan: string | null; quiet: boolean; appless: boolean; appDown?: string | null };
  notice: string | null;
  /** Remote mode: the device, its last presses, and whether the first press will load the inspector. */
  remote: { id: string; trail: string[]; loads: boolean } | null;
  /** Everything there is, in order, and which is highlighted. */
  list: ListRow[];
  at: number;
  /** The right side: the highlighted entry opened up, for a width and a height. */
  pane: (w: number, h: number) => string[];
  input: InputView | null;
  /** The keys that act now, each with a word for what it does: the last line, most useful first. */
  keys?: [string, string][];
  /** Nothing is open on the right: with no device either, it says how to get one, centred. */
  idle?: boolean;
}

/** The list's width with its group labels, and without them on a narrow terminal. */
const LEFT_WIDE = 30;
const LEFT_NARROW = 15;
/** Below this width the list drops its group labels. */
const LIST_LABELS = 80;
/** Rows kept above the region for the header and a few lines of the log, when the terminal has them. */
const ABOVE = 6;
/** The list is never shorter than this, scrolling with the highlight instead. */
const MIN_LIST = 6;
/** The two columns are this tall when the terminal has the rows, however short the list. */
const PANE_ROWS = 18;
/** From this many rows the last line names the keys that act now. */
const KEYS_ROWS = 20;
/** Rows the region needs besides the list, for every group to stay open: rules, a device row, the input, the keys, a few of the log. */
const AROUND = 14;

/**
 * The live region for a terminal of `cols` by `rows`, at most rows - 1 lines: a rule, then two
 * columns (every entry on the left, the highlighted one opened up on the right), a rule, the device
 * rows, and the input. No line is wider than cols - 1, so none wraps.
 */
export function view(s: ViewState, cols: number, rows: number): string[] {
  const { p } = s;
  const w = cols - 1;
  // The wide row (platform, 16 bars, 3-space gaps) from 100 columns: at 80 it left no room for key and the alerts.
  const gap = cols >= WIDE ? '   ' : '  ';

  // Each device's cells, then padding so ids, main and heap line up when there are several.
  const sel = s.duts.find((t) => t.id === s.selected) ?? s.duts[s.duts.length - 1];
  const several = s.duts.length > 1;
  const numW = several ? Math.max(...s.duts.map((t) => (t.v ? String(Math.round(t.v.blocked[t.v.blocked.length - 1]!)).length : 1))) : 0;
  const cells = s.duts.map((t) => dutCells(t, s, cols, several && t === sel, numW));
  const gone = s.gone.map((g) => goneCells(g, s, cols));
  const headW = s.duts.length + s.gone.length > 1 ? Math.max(...[...cells, ...gone].map((c) => width(c.head))) : 0;
  // A device's message in place of main (silent, or no sample yet) doesn't widen the others' column.
  const mainW = several ? Math.max(0, ...cells.filter((c) => c.sampled).map((c) => width(c.main))) : 0;
  const heapW = several ? Math.max(0, ...cells.map((c) => (c.heap ? width(c.heap) : 0))) : 0;
  const row = (c: Cells) => fit(pad(c.head, headW), [...(c.main ? [pad(c.main, mainW)] : []), ...(c.heap ? [pad(c.heap, heapW)] : []), ...c.rest], cols, gap);

  const bottom = s.input ? [inputLine(s, cols)] : s.remote ? [remoteLine(s, cols)] : footer(s, cols);
  if (s.keys?.length && rows >= KEYS_ROWS) bottom.push(keyLine(s.keys, w, s));
  let room = rows - 1 - 2 - bottom.length - (sel || !s.gone.length ? 1 : 0);
  // The list takes what is left once the header and a few log lines have theirs, and scrolls if that is short.
  // The right side needs room for an answer even while the list is only its five groups.
  const listH = Math.max(0, Math.min(Math.max(s.list.length, PANE_ROWS), Math.max(Math.min(MIN_LIST, room), room - ABOVE)));
  room -= listH;

  // The other devices, as many as fit.
  const others = [...cells.filter((c) => c.dut !== sel), ...gone];
  const shown = others.length <= room ? others.length : Math.max(0, room - 1);
  const hidden = others.length - shown;
  const overflow = hidden > 0 && room > 0;
  const visible = new Set(others.slice(0, shown));

  const leftW = cols >= LIST_LABELS ? LEFT_WIDE : LEFT_NARROW;
  const paneW = Math.max(1, w - leftW - 3);
  const left = listLines(s, leftW, listH);
  // No device and nothing open: the right side says how to get one, in place of the line under the list.
  const blank = !!s.idle && !s.duts.length && !s.gone.length && listH >= 5;
  const right = !listH ? [] : blank ? emptyBlock(s, paneW, listH) : s.pane(paneW, listH);
  const out = [p.rule(G.rule.repeat(leftW + 1) + G.tee[0] + G.rule.repeat(Math.max(0, w - leftW - 2)))];
  for (let i = 0; i < listH; i++) out.push(pad(left[i] ?? '', leftW) + ' ' + p.rule(G.box[5]) + ' ' + truncate(right[i] ?? '', paneW));
  out.push(p.rule(G.rule.repeat(leftW + 1) + G.tee[1] + G.rule.repeat(Math.max(0, w - leftW - 2))));
  for (const c of cells) if (c.dut === sel || visible.has(c)) out.push(row(c));
  for (const c of gone) if (visible.has(c)) out.push(row(c));
  if (overflow) out.push(`  ${p.faint(`+ ${hidden} more device${hidden === 1 ? '' : 's'}${sp()}tab picks one`)}`);
  if (!s.duts.length && !s.gone.length && !blank) out.push(waitingLine(s, w, gap));
  out.push(...bottom);
  return out.map((l) => truncate(l, w));
}

/**
 * The list: the five groups, each with its letters while it is closed, and the open one's entries
 * under it with their letters, the highlight, and a portal turning beside whatever runs now. Scrolls
 * with the highlight when it is taller than `h`.
 */
function listLines(s: ViewState, w: number, h: number): string[] {
  const { p } = s;
  const wide = w >= LEFT_WIDE;
  const top = s.list.length <= h ? 0 : Math.max(0, Math.min(s.at - Math.floor(h / 2), s.list.length - h));
  const portal = G.portal[Math.floor(s.now / BEAM_MS) % G.portal.length]!;
  const out: string[] = [];
  for (let i = top; i < Math.min(s.list.length, top + h); i++) {
    const r = s.list[i]!;
    const on = i === s.at;
    const sel = on ? p.ink(G.sel) : ' ';
    const mark = r.running ? p.accent(portal) : r.failed ? p.bad(G.no) : ' ';
    if (r.kind === 'group') {
      const name = on ? p.bold(p.ink(r.name)) : r.open ? p.ink(r.name) : p.muted(r.name);
      out.push(`${sel} ${pad(name, wide ? 11 : 12)}${mark}${wide && r.status ? ' ' + r.status : ''}`);
    } else {
      const name = on ? p.bold(p.ink(r.name)) : p.muted(r.name);
      // With room, what it shows now follows its name; narrow, only whether it runs or failed.
      out.push(`${wide ? '  ' : ' '}${sel} ${r.key ? p.accent(r.key) : ' '} ${pad(name, 9)}${mark}${wide && r.status ? ' ' + r.status : ''}`);
    }
  }
  // Scrolled: the last row in view says how many more there are, in place of a row.
  if (top + h < s.list.length && h > 1) out[h - 1] = `  ${p.faint(`${G.down} ${s.list.length - top - h} more`)}`;
  return out;
}

interface Cells {
  dut?: DutView;
  head: string;
  main: string;
  /** main is the device's numbers, not a message. */
  sampled?: boolean;
  heap: string | null;
  rest: string[];
}

/** A device's row as cells, most important first: the end is dropped to fit. */
function dutCells(t: DutView, s: ViewState, cols: number, selected: boolean, numW: number): Cells {
  const { p } = s;
  const v = t.v;
  const silent = t.silentMs ?? 0;
  const late = silent >= DEAD_MS ? p.bad : silent >= SILENT_MS ? p.warn : null;
  const [platform, engine] = uaParts(t.ua);
  // The dot is the device's state at a glance: green while its samples come, amber when they stop a
  // few seconds, red when they have stopped.
  const head = `${selected ? p.ink(G.sel) : ' '} ${(late ?? (v ? p.good : p.warn))(G.dot)} ${p.bold(t.id)}${cols >= WIDE && platform ? ' ' + p.muted(platform) : ''}`;
  const main = late ? late(`no sample for ${Math.floor(silent / 1000)} s`) : v ? mainCell(v, p, cols, numW) : p.faint('waiting for its first sample');
  const rest: string[] = [];
  if (t.held) rest.push(p.accent(`${G.mark} ${printable(t.held)}`));
  if (t.reloadMs !== null) rest.push(p.warn(`reloading ${Math.ceil(t.reloadMs / 1000)} s`));
  let heap: string | null = null;
  if (v && v.heapMB !== null) {
    const share = v.heapLimitMB ? v.heapMB / v.heapLimitMB : 0;
    const tone = share >= HEAP_SHARE[1] ? p.bad : share >= HEAP_SHARE[0] ? p.warn : p.ink;
    heap = `${p.faint('heap')} ${tone(`${Math.round(v.heapMB)}${v.heapLimitMB ? `/${Math.round(v.heapLimitMB)}` : ''} MB`)}`;
  }
  const full = v?.trend?.fullInMin;
  if (full !== null && full !== undefined && full <= FULL_IN_MIN) rest.push((full <= FULL_IN_BAD ? p.bad : p.warn)(`full in ${Math.round(full)} min`));
  if (t.errors) rest.push(p.bad(`${t.errors} error${t.errors === 1 ? '' : 's'}`));
  if (t.governor) rest.push(p.warn(t.governor === 1 ? 'inspector shedding' : 'inspector paused'));
  if (v) {
    if (t.devtools && (v.devtoolsLagMs ?? 0) >= DEVTOOLS_BEHIND_MS) rest.push(p.warn(`DevTools ${Math.round(v.devtoolsLagMs! / 1000)} s behind`));
    const link = [...(v.rttMs !== null && v.rttMs >= RTT_MS[0] ? [`rtt ${Math.round(v.rttMs)} ms`] : []), ...(v.backlogKB !== null && v.backlogKB >= BACKLOG_KB ? [`backlog ${Math.round(v.backlogKB)} KB`] : [])];
    if (link.length) rest.push(p.warn(link.join(sp())));
    if (v.videoDroppedPerS) rest.push(p.warn(`video ${Math.round(v.videoDroppedPerS)} dropped/s`));
    const key = keyCell(v, p);
    if (key) rest.push(key);
  }
  if (t.devtools) rest.push(p.ink(t.devtools > 1 ? `DevTools ${G === ASCII ? 'x' : '×'}${t.devtools}` : 'DevTools'));
  else if (t.inspector) rest.push(p.faint('inspector on'));
  if (engine) rest.push(p.muted(engine));
  return { dut: t, head, main, sampled: !late && !!v, heap, rest };
}

/** main: a bar for each of the last seconds, scaled to the worst of them (100 ms at least), and the last one's ms. */
function mainCell(v: Vitals, p: Paint, cols: number, numW: number): string {
  const bars = v.blocked.slice(cols >= WIDE ? -16 : -8);
  const worst = Math.max(...bars);
  const toned = (ms: number) => (ms >= MAIN_MS[1] ? p.bad : ms >= MAIN_MS[0] ? p.warn : p.ink);
  const last = v.blocked[v.blocked.length - 1]!;
  const n = String(Math.round(last)).padStart(numW);
  const line = cols >= 50 ? toned(worst)(spark(bars, Math.max(100, worst)).padStart(cols >= WIDE ? 16 : 8)) + ' ' : '';
  // The spark is toned by the window's worst and the number by the last second, which it is; with no
  // spark, the number carries the window.
  return `${p.faint('main')} ${line}${toned(line ? last : worst)(`${n} ms`)}`;
}

/** The last key press and how long it took to reach the screen: toned while fresh, faint after, gone after a minute. */
function keyCell(v: Vitals, p: Paint): string | null {
  const k = v.press;
  if (!k || v.t - k.t > KEY_SHOWN_MS) return null;
  const n = k.toFrameMs === null ? G.none : `${Math.round(k.toFrameMs)} ms`;
  if (v.t - k.t > KEY_FRESH_MS) return p.faint(`key ${k.key} ${n}`);
  const tone = k.toFrameMs === null ? p.ink : k.toFrameMs >= KEY_MS[1] ? p.bad : k.toFrameMs >= KEY_MS[0] ? p.warn : p.ink;
  return `${p.faint('key')} ${p.ink(k.key)} ${tone(n)}`;
}

function goneCells(g: ViewState['gone'][number], s: ViewState, cols: number): Cells {
  const { p } = s;
  const [platform] = uaParts(g.ua);
  return {
    head: `  ${(g.reloadMs !== null ? p.warn : p.bad)(G.ring)} ${p.bold(g.id)}${cols >= WIDE && platform ? ' ' + p.muted(platform) : ''}`,
    main: '',
    heap: null,
    // A reload asked for counts down the time it has to come back; otherwise, how long DevTools waits.
    rest:
      g.reloadMs !== null
        ? [p.warn(`reloading${sp()}back within ${Math.ceil(g.reloadMs / 1000)} s`)]
        : [p.bad(`gone ${Math.floor(g.ms / 1000)} s`), ...(g.waiting ? [p.faint(`DevTools waits ${Math.max(0, Math.ceil((GONE_SHOWN_MS - g.ms) / 1000))} s more`)] : [])],
  };
}

/**
 * The line while no device is connected, toned as a status: amber while it waits, red when something is
 * plainly wrong (the app doesn't answer, or nothing has opened the link in a minute).
 */
function waitingLine(s: ViewState, w: number, gap: string): string {
  const { tone, what, how } = waitingSays(s);
  return truncate(`  ${tone(G.ring)} ${tone(what)}${gap}${how}`, w);
}

/** What is waited for and what to do about it, with the tone of its state. */
function waitingSays(s: ViewState): { tone: (x: string) => string; what: string; how: string } {
  const { p } = s;
  const { link, lan, quiet, appless, appDown } = s.waiting;
  if (appDown) return { tone: p.bad, what: `nothing answers at ${appDown}`, how: p.faint('start your app: the device opens it once it answers') };
  // No app yet: naming one is the next thing to do; an app that bundles the agent needs none.
  if (appless) {
    const how = quiet
      ? p.faint(`type its port below${sp()}or in an app that bundles the agent: `) + p.ink(initLine(lan ?? `<this laptop>:${s.port}`))
      : p.faint('type its port below, or start your dev server');
    return { tone: p.warn, what: 'waiting for an app', how };
  }
  if (quiet) return { tone: p.bad, what: link ? `nothing has opened the link yet` : 'no app has connected yet', how: p.faint(`${link ? `${link}${sp()}` : ''}same network? port ${s.port}?`) };
  const how = link ? p.faint('open ') + p.accent(link) + p.faint(' on it') : p.faint('in your app: ') + p.ink(initLine(lan ?? `<this laptop>:${s.port}`));
  return { tone: p.warn, what: 'waiting for a device', how };
}

/** A key and the word for what it does: the key on a plate where there is colour. */
const chip = (s: ViewState, k: string, label: string) => (s.color === 'none' ? `${k} ${label}` : `${s.p.inverse(s.p.faint(` ${k} `))} ${s.p.muted(label)}`);

/** The keys that act now, as many as fit, the last two (help and quit) kept. */
function keyLine(keys: [string, string][], w: number, s: ViewState): string {
  const gap = '   ';
  const made = keys.map(([k, l]) => chip(s, k, l));
  const tail = made.length > 2 ? made.slice(-2) : [];
  const head = made.slice(0, made.length - tail.length);
  let room = w - 2 - tail.reduce((n, c) => n + width(c) + gap.length, 0);
  const shown: string[] = [];
  for (const c of head) {
    if (width(c) + (shown.length ? gap.length : 0) > room) break;
    room -= width(c) + (shown.length ? gap.length : 0);
    shown.push(c);
  }
  return '  ' + [...shown, ...tail].join(gap);
}

/** No device yet, in the middle of the right side: what is waited for, what to do, and the keys that work meanwhile. */
function emptyBlock(s: ViewState, w: number, h: number): string[] {
  const { p } = s;
  const { tone, what, how } = waitingSays(s);
  const keys: [string, string][] = [...(s.waiting.appless ? ([['5173', "your app's port"]] as [string, string][]) : []), ['?', 'help'], ['h', 'history']];
  // Too long for the side (the line to add to an app): what to do, then the line itself under it.
  const hows = width(how) > w && how.includes(': ') ? [how.slice(0, how.indexOf(': ') + 1), how.slice(how.indexOf(': ') + 2)] : [how];
  const lines = [tone(G.ring), '', p.bold(tone(what)), ...hows, '', keys.map(([k, l]) => chip(s, k, l)).join('   ')];
  const top = Math.max(0, (h - lines.length) >> 1);
  const out: string[] = Array.from({ length: top }, () => '');
  for (const l of lines) {
    const t = truncate(l, w);
    out.push(' '.repeat(Math.max(0, (w - width(t)) >> 1)) + t);
  }
  return out.slice(0, h);
}

/** In place of the input when keys can't arrive: a notice for a moment, else why there is no input. */
function footer(s: ViewState, cols: number): string[] {
  const { p } = s;
  const w = cols - 1;
  if (s.notice) return [truncate('  ' + p.ink(s.notice), w)];
  return [truncate('  ' + p.faint(`keys need a terminal on stdin${sp()}tlpt <command> works from another shell`), w)];
}

/** Remote mode's input line: the device it drives and how to leave. The keys and what was sent are on the right side, drawn. */
function remoteLine(s: ViewState, cols: number): string {
  const { p } = s;
  const r = s.remote!;
  const w = cols - 1;
  const badge = s.color === 'none' ? '[REMOTE]' : p.inverse('REMOTE');
  const head = `  ${badge} ${p.bold(r.id)}  `;
  if (s.notice) return truncate(head + p.ink(s.notice), w);
  const hint = p.faint('first press loads the inspector');
  return spread(head + p.faint(`esc leaves${sp()}c captures`), r.loads ? hint : '', w);
}

/** The input, always open on the last line: what is typed, then a mistake, a notice or the keys, and the device at the right. */
function inputLine(s: ViewState, cols: number): string {
  const { p } = s;
  const w = cols - 1;
  const iv = s.input!;
  const lead = `  ${p.ink('>')} `;
  const tone = iv.tone === 'bad' ? p.bad : iv.tone === 'warn' ? p.warn : p.good;
  const on = iv.on ? p.faint('on ') + tone(G.dot) + ' ' + p.ink(iv.on) : p.warn(`${G.ring} no device yet`);
  const said = s.notice ? p.ink(s.notice) : iv.error ? p.bad(`${G.no} ${iv.error}`) : p.faint(iv.hint);
  // The text takes what it needs and what is said follows it, cut to fit; a mistake or a notice
  // keeps up to half the line, the text scrolling to its caret in the rest. The device gives way first.
  const loud = !!iv.error || !!s.notice;
  const reserve = !iv.text ? width(said) + 2 : loud ? Math.min(width(said) + 2, Math.floor((w - width(lead)) / 2)) : 0;
  const text = field(iv.text, iv.caret, Math.max(4, w - width(lead) - reserve), p, s.color === 'none');
  const room = w - width(lead + text) - 2;
  const line = lead + text + (room >= Math.min(width(said), 12) ? '  ' + truncate(said, room) : '');
  return width(line) + 4 + width(on) <= w ? spread(line, on, w) : line;
}

/** The input line's text with its caret, scrolled so the caret shows: an inverse cell, or `_` without colour. */
function field(text: string, caret: number, avail: number, p: Paint, plain: boolean): string {
  const before = [...text.slice(0, caret)];
  const after = [...text.slice(caret)];
  const cw = (c: string) => charWidth(c.codePointAt(0)!);
  // Without colour the caret is a `_` between characters; with it, the character under it inverted.
  const at = plain || !after.length ? '' : after.shift()!;
  let used = at ? cw(at) : 1;
  let from = before.length;
  while (from > 0 && used + cw(before[from - 1]!) <= avail) used += cw(before[--from]!);
  let tail = '';
  for (const c of after) {
    if (used + cw(c) > avail) break;
    tail += c;
    used += cw(c);
  }
  const caretCell = plain ? '_' : p.inverse(at || ' ');
  return p.ink(before.slice(from).join('')) + caretCell + p.ink(tail);
}

// ---- The console ------------------------------------------------------------------------------------

/** One device's numbers, derived from its current page's recording once per sample. */
interface Track {
  session: Recording;
  v: Vitals | null;
  watch: Watch;
  /** Its last heap and limit, kept across page loads: a page that went at 96% may have been ended for it. */
  heap: { mb: number; limit: number } | null;
}

/** Something running on a device. */
interface Busy {
  id: string;
  kind: 'capture' | 'trial' | 'probe' | 'eval' | 'keys' | 'call';
  /** The list's entry it belongs to, whose side shows it. */
  entry: string;
  /** '' for this console's own, else who asked: q, mcp or API. */
  who: string;
  what: string;
  since: number;
  /** A capture's length, s. */
  seconds?: number;
  done?: number;
  total?: number;
  /** The console's own: the line it ran, and for a trial, how to stop it. */
  line?: string;
  stop?: AbortController;
  /** Another caller's call, as the server named it, to match its end. */
  call?: string;
}

/** A row the input offers: a command, or a value for its word. */
interface PaletteRow {
  kind: 'command' | 'value' | 'empty';
  name: string;
  brief: string;
  /** A command's arguments, or a value's cost. */
  right: string;
  /** The key that runs a command with its defaults. */
  key?: string;
}

/** One run of an entry: when, who asked ('' for this console), the line, how long, and why it failed. */
interface Run {
  at: number;
  who: string;
  line: string;
  id: string | undefined;
  ms: number;
  failed?: string;
}

/** A command's last answer here, kept as data so the right side can draw it at any width. */
interface Answer {
  name: string;
  args: Args;
  data: unknown;
  id: string | undefined;
  /** The line that ran it. */
  line: string;
  /** Why it failed. */
  failed?: string;
  /** Drawn at this width. */
  lines?: string[];
  width?: number;
}

/** A palette row with what choosing it does. */
interface Row extends PaletteRow {
  /** The text it puts in place of the word at the caret: for a recent line, of the empty line. */
  value: string;
  cmd: Command | null;
  /** Completing it adds a space, for more words. */
  more: boolean;
  /** Enter completes it and waits, rather than running the line. */
  waits: boolean;
  /** A likely meaning of a typo: tab takes it, enter doesn't. */
  guess?: boolean;
  /** One of a few lengths offered: enter takes it once the highlight is moved to it, or it is typed. */
  hint?: boolean;
  /** Its own cost line. */
  cost?: string;
}

interface Suggestions {
  rows: Row[];
  /** The command typed, past the first word. */
  cmd: Command | null;
  /** Where the word being completed starts and ends in the input. */
  from: number;
  to: number;
  /** Past the command name. */
  args: boolean;
}

type Tone = 'ink' | 'good' | 'warn' | 'bad' | 'routine';

export class Console {
  private overlay: 'none' | 'help' = 'none';
  /** What is highlighted in the list: an entry by its name, or a group as `group:<name>`. Its side is open on the right. */
  private at = entriesOf(GROUPS[0]!.id)[0]!.name;
  /** The lines pinned at the top, without the device cards, and the last pinned with them. */
  private head: string[] | null;
  private pinned = '';
  /** Each kind of device's screen and cores, read once for its card; null while asking. */
  private specs = new Map<string, Specs | null>();
  /** The app tlpt serves doesn't answer: its address, said on the waiting line in red. */
  private appDown: string | null = null;
  /** Each entry's last answer here, kept to draw on the right at whatever width it has. */
  private results = new Map<string, Answer>();
  /** How far down a long answer the right side is scrolled, in lines, and how far it can go. */
  private paneTop = 0;
  private paneLong = 0;
  // The key reader, while remote mode is on.
  private heard: Heard[] = [];
  private sends: Record<string, Press> = {};
  private hearing: NodeJS.Timeout | null = null;
  private hearAsking = false;
  private hearError: string | null = null;
  private lit: { key: string; until: number } | null = null;
  /** Each entry's runs this session, oldest first, whoever asked. */
  private runs = new Map<string, Run[]>();
  /** What the entries that only read show now, asked again while one is on screen. */
  private live = new Map<string, { a: Answer; at: number; asking: boolean }>();
  /** Mapping a remote key by hand, in remote mode: which key (null until one is pressed), then the code typed for it. */
  private mapping: { id: KeyId | null; typed: string } | null = null;
  /** Remote mode: the device it was started on. It lasts through that device's reloads, and on no other device. */
  private remote: string | null = null;
  private selected: string | null = null;
  /** When each device was first seen, so rows keep their places when a device reloads (the server re-adds it last). */
  private order = new Map<string, number>();
  private seen = 0;
  private tracks = new Map<string, Track>();
  /** Devices that went away, shown a minute. */
  private gone = new Map<string, { id: string; ua: string; at: number; waiting: boolean }>();
  /** Devices that went away whose line waits HOLD_GONE_MS, in case they come back. */
  private held = new Map<string, { at: number; waiting: boolean; heap: Track['heap'] }>();
  /** Each device's user agent, remembered from when it connected: the server forgets a device as it goes. */
  private agents = new Map<string, string>();
  private devtools = new Map<string, number>();
  /** Devices a test run holds, each with who holds it. */
  private holding = new Map<string, string>();
  /** The event line said last, which the same thing said again replaces. */
  private last: { kind: string; times: number; mark: number } | null = null;
  private busy = new Map<number, Busy>();
  private seq = 0;
  private notice: { text: string; until: number } | null = null;
  private escArmed = 0;
  private reloads = new Map<string, number>();
  private requests = new Map<string, { at: number; more: number }>();
  /** When each device's growing error count was last said. */
  private errorsTold = new Map<string, { at: number; total: number }>();
  private bursts = new Map<string, { from: number; n: number }>();
  /** Pages loaded with no agent yet, by address, and the addresses already said. */
  private documents = new Map<string, { at: number; path: string }>();
  private noAgent = new Set<string>();
  /** A page has reached tlpt: a page load through it, or an agent. */
  private reached = false;
  /** A key has been pressed in this console: from then on the highlight is the person's, and nothing moves it for them. */
  private touched = false;
  private readonly started: number;
  // The palette.
  private input = '';
  private caret = 0;
  private pick = 0;
  private error: string | null = null;
  private files: string[] | null = null;
  // Remote mode.
  private waiting: string[] = [];
  private sending = false;
  private trail: string[] = [];
  private spinner: NodeJS.Timeout | null = null;
  private align: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private closed = false;
  private readonly p: Paint;
  private readonly now: () => number;
  /** Piped or logged: lines only, no region to draw. */
  private readonly plain: boolean;

  constructor(private o: ConsoleOptions) {
    this.p = paint(o.color, o.light);
    this.now = o.now ?? (() => Date.now());
    this.plain = o.screen instanceof PlainScreen;
    this.started = this.now();
    this.head = o.header ?? null;
    o.screen.onKey((k) => this.key(k));
    o.screen.onResize(() => this.render());
    // The watchdog ticks on wall-clock seconds, so every count on screen moves together.
    this.align = setTimeout(() => {
      this.align = null;
      this.tick();
      this.watchdog = setInterval(() => this.tick(), 1000);
      this.watchdog.unref?.();
    }, 1000 - (this.now() % 1000));
    this.align.unref?.();
    this.render();
  }

  /** tlpt serves another app now: its device link, or the waiting page's while it serves none. */
  setApp(link: string | null, appless = false) {
    this.o.dutLink = link;
    this.o.appless = appless;
    this.appDown = null;
    this.render();
  }

  /** The lines pinned at the top changed (another app, a tunnel): the cards go under the new ones. */
  setHeader(lines: string[]) {
    this.head = lines;
    this.pinned = '';
    this.render();
  }

  // ---- Server events ------------------------------------------------------------------------------

  event(heard: ServerEvent) {
    if (this.closed) return;
    // A device's own words are in most events: printed as text, never obeyed as escapes.
    const e = printable(heard);
    const p = this.p;
    const id = (x: string) => p.bold(x);
    const now = this.now();
    switch (e.type) {
      case 'sample': {
        const t = this.find(e.id);
        if (!t) return;
        const tr = this.trackOf(t);
        const v = (tr.v = vitalsOf(t.session));
        if (v) {
          for (const a of alarms(tr.watch, t.session, v)) this.alarm(e.id, a);
          if (v.heapMB !== null && v.heapLimitMB) tr.heap = { mb: v.heapMB, limit: v.heapLimitMB };
        }
        return this.render();
      }
      case 'page': {
        const tr = this.tracks.get(e.id);
        const heap = tr?.heap;
        if (tr) tr.heap = null;
        const away = this.held.get(e.id) ?? this.gone.get(e.id);
        this.held.delete(e.id);
        this.gone.delete(e.id);
        this.agents.delete(e.id);
        this.agents.set(e.id, e.ua);
        if (this.agents.size > 256) this.agents.delete(this.agents.keys().next().value!);
        this.documents.delete(e.ip);
        this.reached = true;
        this.selected ??= e.id;
        if (e.kind !== 'relink') this.errorsTold.delete(e.id);
        const due = this.reloads.get(e.id);
        const asked = (due ?? 0) > now;
        this.reloads.delete(e.id);
        if (!this.specs.has(e.ua)) setTimeout(() => void this.askSpecs(e.id), SPECS_AFTER_MS).unref?.();
        // What a person does first with a device that has just connected is drive it to the screen
        // they came to look at, so that is what Enter does. Only while the highlight is still where
        // the console put it: once a key has been pressed it is theirs.
        if (e.kind === 'new' && !this.touched && this.agents.size === 1 && this.o.screen.interactive) this.at = 'remote';
        if (e.kind === 'new') this.connected(e);
        else if (e.kind === 'reload' && due !== undefined) this.say('routine', `${id(e.id)} reloaded in ${dur(Math.max(0, now - (due - RELOAD_ASKED_MS)))}`);
        else if (e.kind === 'reload') this.say('routine', `${id(e.id)} reloaded`, heap && heap.mb / heap.limit >= HEAP_ALARM && !asked ? [`its heap was at ${pct(heap.mb / heap.limit)} of the limit just before: the engine may have ended the page`] : []);
        else this.say('routine', `${id(e.id)} back${away ? ` after ${Math.round((now - away.at) / 1000)} s` : ''}`, ['the link dropped; same page, DevTools kept what it had']);
        return this.render();
      }
      case 'gone': {
        this.gone.set(e.id, { id: e.id, ua: this.agents.get(e.id) ?? '', at: now, waiting: e.waiting });
        this.held.set(e.id, { at: now, waiting: e.waiting, heap: this.tracks.get(e.id)?.heap ?? null });
        return this.render();
      }
      case 'devtools': {
        this.devtools.set(e.id, e.open);
        if (!e.open) this.say('routine', `${id(e.id)} DevTools closed`, [`its console isn't recorded until DevTools opens again${this.o.screen.interactive ? `${sp()}d opens it` : ''}`]);
        // Opening is not said: the device's row shows DevTools, and how many, for as long as it is open.
        return this.render();
      }
      case 'hold': {
        const was = this.holding.get(e.id);
        if (e.as) this.holding.set(e.id, e.as);
        else this.holding.delete(e.id);
        this.say(e.as ? 'ink' : 'routine', e.as ? `${id(e.id)} reserved by ${printable(e.as)}` : `${id(e.id)} released${was ? ` by ${printable(was)}` : ''}`, e.as ? ['calls from anyone else wait until it lets go; this console still acts'] : []);
        return this.render();
      }
      case 'governor':
        if (e.level) this.say('warn', `${id(e.id)} inspector ${e.level === 1 ? 'shedding detail' : 'paused console, network and DOM watching'}`, [], e.reason);
        else this.say('good', `${id(e.id)} inspector back to full detail`);
        return this.render();
      case 'error':
        this.threw(e.id, e.error);
        return this.render();
      case 'errors': {
        // Past the ones said one by one, a page that keeps throwing is counted, a line a minute.
        const told = this.errorsTold.get(e.id);
        if (!told || now - told.at >= SAME_REQUEST_MS) {
          this.errorsTold.set(e.id, { at: now, total: e.total });
          if (e.total > ERRORS_SAID) this.say('bad', `${id(e.id)} has thrown ${e.total} errors`, [`${p.ink('e')} ${p.faint('lists the first and the last of them')}`]);
        }
        return this.render();
      }
      case 'dropped': {
        const parts = [...(e.console ? [`${e.console} console message${e.console === 1 ? '' : 's'}`] : []), ...(e.network ? [`${e.network} network event${e.network === 1 ? '' : 's'}`] : [])];
        this.say('warn', `${id(e.id)} inspector left out ${parts.join(' and ')}`, [], 'The device was too busy or its link too full to report them. What the page threw is not among them: errors are kept.');
        return this.render();
      }
      case 'call': {
        // The console prints its own answers; for others it says who did what.
        if (e.by === 'console') return;
        const who = WHO[e.by];
        if (e.phase === 'start') {
          const capture = /^capture ([\d.]+) s$/.exec(e.what);
          const name = capture ? 'capture' : (entry(e.what.split(' ')[0]!)?.name ?? 'status');
          this.busy.set(++this.seq, { id: e.id, kind: capture ? 'capture' : 'call', entry: name, who, what: capture ? 'capture' : e.what, since: now, seconds: capture ? Number(capture[1]) : undefined, call: e.what });
          this.spin();
        } else {
          // Another caller turned the shim on or off: the device reloads into it.
          if (/^shim (on|off): reloading$/.test(e.what)) this.reloading(e.id);
          for (const [k, b] of this.busy) if (b.call === e.what && b.who === who && b.id === e.id) {
            this.busy.delete(k);
            break;
          }
          const capture = /^capture ([\d.]+) s$/.test(e.what);
          const name = capture ? 'capture' : entry(e.what.split(' ')[0]!)?.name;
          if (name) this.record(name, { at: now, who, line: e.what, id: e.id, ms: e.ms ?? 0, failed: e.error ? e.error.split('\n')[0] : undefined });
          if (e.error) this.say('bad', `${who} ${e.what} on ${id(e.id)} failed${sp()}${dur(e.ms ?? 0)}`, [], e.error);
          else this.say('routine', `${who} ${e.what} on ${id(e.id)}${sp()}${dur(e.ms ?? 0)}`, [], undefined, false, `call ${who} ${e.what.split(' ')[0]} ${e.id}`);
        }
        return this.render();
      }
      case 'trial': {
        if (e.by === 'console') {
          const b = [...this.busy.values()].reverse().find((x) => x.kind === 'trial' && !x.who && x.id === e.id);
          if (b) Object.assign(b, { what: `trial ${e.name}`, done: e.done, total: e.total });
          return this.render();
        }
        const who = WHO[e.by];
        const key = [...this.busy].find(([, b]) => b.kind === 'trial' && b.who === who && b.id === e.id)?.[0];
        const head = `${who} trial ${e.name} on ${id(e.id)}`;
        if (e.phase === 'start') {
          this.busy.set(++this.seq, { id: e.id, kind: 'trial', entry: 'trial', who, what: `trial ${e.name}`, since: now, done: 0, total: e.total });
          this.spin();
          this.say('routine', `${head}${sp()}${e.total} runs${sp()}its screen is covered until it ends`);
        } else if (e.phase === 'run') {
          if (key !== undefined) Object.assign(this.busy.get(key)!, { done: e.done, total: e.total });
        } else {
          if (key !== undefined) this.busy.delete(key);
          this.record('trial', { at: now, who, line: `trial ${e.name}`, id: e.id, ms: 0, failed: e.done < e.total ? `stopped after ${e.done} of ${e.total} runs` : undefined });
          this.say('routine', `${head}${sp()}${e.done < e.total ? `stopped after ${e.done} of ${e.total} runs` : `${e.done} of ${e.total} runs done`}`);
        }
        return this.render();
      }
      case 'request': {
        if (e.document) {
          this.reached = true;
          if (e.id === null && !this.noAgent.has(e.ip) && !this.documents.has(e.ip)) this.documents.set(e.ip, { at: now, path: pathOf(e.url) });
        }
        if (e.id && (e.failed || e.status >= 400) && !(e.status === 404 && /\/favicon\.ico$/.test(pathOf(e.url).split('?')[0]!))) this.failedRequest(e as RequestEvent & { id: string }, now);
        // A page load is what the waiting line's hint counts.
        if (e.document) this.render();
        return;
      }
    }
  }

  /** A laptop-side line: a build, the tunnel, an older tlpt that stepped aside. */
  note(n: ConsoleNote) {
    if (this.closed) return;
    if (n.type === 'build') {
      this.say('routine', `${n.name} rebuilt${n.reloaded ? `${sp()}reloading ${n.reloaded} device${n.reloaded === 1 ? '' : 's'}` : ''}`);
      if (n.reloaded) for (const t of this.duts()) this.reloads.set(t.id, this.now() + RELOAD_ASKED_MS);
    } else if (n.type === 'build-failed') this.say('bad', `${n.name} build failed`, [], n.error.split('\n')[0]);
    else if (n.type === 'tunnel') {
      // The free plan's warning page comes from the tunnel, before the request reaches tlpt; tlpt's own
      // address on this network has none.
      if (n.took)
        this.say('routine', `${n.url} goes through tlpt while it runs`, [], /^https?:\/\/[^/]*-free\./i.test(n.url) ? `the tunnel shows the device its warning page once: press Visit Site${n.lan ? `, or open ${n.lan} on this network` : ''}` : undefined);
      else this.say('warn', `the tunnel kept ${n.url} on your app`, [], `open the device link above, or point the tunnel at 127.0.0.1:${n.port}`);
    } else if (n.type === 'own-tunnel') {
      this.say('ink', `the tunnel is up${sp()}${this.p.link(n.url)}`, ['the device opens this address; it ends when tlpt does'], undefined, true);
    } else if (n.type === 'serving') {
      const reloading = n.reloaded ? [`reloading ${n.reloaded} device${n.reloaded === 1 ? '' : 's'} into it`] : [];
      this.appDown = null;
      if (n.reloaded) for (const t of this.duts()) this.reloads.set(t.id, this.now() + RELOAD_ASKED_MS);
      this.say('ink', n.found ? `found a dev server at ${n.app}; serving it` : `serving ${n.app}`, reloading);
    } else if (n.type === 'app') {
      this.appDown = n.up ? null : n.app;
      if (n.up) this.say('good', `${n.app} answers now`);
      else if (n.why) this.say('bad', `${n.app} doesn't answer`, [], n.why);
      else this.say('warn', `nothing answers at ${n.app} yet`, [], 'start your app; the device waits for it and opens it once it answers');
    } else this.say('routine', `an older tlpt on port ${n.port} stepped aside`);
    this.render();
  }

  private connected(e: Extract<ServerEvent, { type: 'page' }>) {
    const p = this.p;
    const note = this.o.devtoolsNote?.(e.id);
    const link = p.link(inspectUrl(this.o.port, this.o.key, e.id));
    // The link even when a browser was asked to open: the opener may be missing, and nothing would.
    const devtools =
      note === 'opened' ? `DevTools opening in your browser${sp()}${link}`
      : note === 'tab' ? 'DevTools opening in the tab that was waiting for a device'
      : `${this.o.screen.interactive ? 'd opens DevTools' : 'DevTools'}${sp()}${link}`;
    // Which device, on one line; then where its DevTools is. Its page is in i.
    const where = [...uaParts(e.ua).filter(Boolean), e.ip.replace(/^::ffff:/, '')].join(sp());
    this.say('ink', `${p.bold(e.id)} connected${p.muted(sp() + where)}`, [p.muted(devtools)], undefined, true);
  }

  private alarm(dut: string, a: Alarm) {
    const id = this.p.bold(dut);
    switch (a.type) {
      case 'stall':
        return this.say('warn', `${id} stalled ${Math.round(a.gapMs / 1000)} s`, [a.lagMs !== null && a.lagMs >= BLOCKED_MS ? `no samples, then timer lag ${sec(a.lagMs, 2)}: the page's main thread was blocked` : 'no samples, but its timer was on time: the link stalled']);
      case 'blocked': {
        const parts = [...(a.longTaskMs ? [`long tasks ${Math.round(a.longTaskMs)} ms`] : []), ...(a.lagMs !== null ? [`timer lag ${a.lagMs >= 1000 ? sec(a.lagMs, 2) : `${Math.round(a.lagMs)} ms`}`] : [])];
        return this.say('warn', `${id} main thread blocked ${sec(Math.max(a.longTaskMs, a.lagMs ?? 0), 1)}`, [parts.join(sp())], undefined, false, `blocked ${dut}`);
      }
      case 'heap': {
        const t = a.trend;
        const rising = t && t.mbPerMin > 0 ? [`rising ${t.mbPerMin.toFixed(1)} MB/min from its floor${t.fullInMin !== null ? `: full in about ${Math.round(t.fullInMin)} min` : ''}`] : [];
        return this.say('bad', `${id} heap at ${pct(a.mb / a.limitMB)} of its limit${sp()}${Math.round(a.mb)} of ${Math.round(a.limitMB)} MB`, rising);
      }
      case 'slow-key': {
        const k = a.press;
        const parts = [...(k.handlersMs !== null ? [`${Math.round(k.handlersMs)} ms in the page's key handlers`] : []), ...(k.target ? [`focus landed on ${k.target}`] : [])];
        return this.say('warn', `${id} key ${k.key} ${k.toFrameMs === null ? 'drew no frame' : `took ${Math.round(k.toFrameMs)} ms to the next frame`}`, parts.length ? [parts.join(sp())] : [], undefined, false, `slow-key ${dut} ${k.key}`);
      }
    }
  }

  /**
   * A request that failed: one line per device, method, path and status a minute, and at most a few per device
   * in a burst, so a page that 404s its images doesn't bury everything else.
   */
  /** What a page threw: the first few of a page load in full, since the first is usually the cause; the rest are counted on its row. */
  private threw(dut: string, e: PageError) {
    if (e.n >= ERRORS_SAID) return;
    const p = this.p;
    const cols = this.o.screen.cols;
    const when = e.atMs < 10_000 ? `${Math.round(e.atMs)} ms into the page` : `${Math.round(e.atMs / 1000)} s into the page`;
    const verb = e.kind === 'resource' ? '' : 'threw ';
    this.say('bad', `${p.bold(dut)} ${verb}${errorLine(e)} ${p.faint(`${G.sep} ${when}`)}`, errorDetail({ ...e, hint: null }, p, Math.max(20, cols - 8)), e.hint ?? undefined);
  }

  private failedRequest(e: RequestEvent & { id: string }, now: number) {
    const origin = originOf(this.find(e.id)?.href ?? '');
    const shown = origin && e.url.startsWith(origin + '/') ? e.url.slice(origin.length) : e.url;
    const key = `${e.id} ${e.method} ${shown.split('?')[0]} ${e.failed ? 'failed' : e.status}`;
    const seen = this.requests.get(key);
    if (seen && now - seen.at < SAME_REQUEST_MS) return void seen.more++;
    const burst = this.bursts.get(e.id);
    if (burst && now - burst.from < REQUEST_BURST_MS) {
      if (++burst.n > REQUEST_BURST) {
        if (burst.n === REQUEST_BURST + 1) this.say('bad', `${this.p.bold(e.id)} more requests failed${sp()}n lists them`);
        return;
      }
    } else this.bursts.set(e.id, { from: now, n: 1 });
    this.requests.delete(key);
    this.requests.set(key, { at: now, more: 0 });
    if (this.requests.size > MAX_REQUEST_KEYS) this.requests.delete(this.requests.keys().next().value!);
    const what = e.failed ? `${e.method} ${shown} failed${sp()}${e.failed}` : `${e.method} ${shown} ${G.right} ${e.status}`;
    const more = seen?.more ? `${sp()}${seen.more} more since ${clock(seen.at)}` : '';
    this.say('bad', `${this.p.bold(e.id)} ${what}${sp()}${dur(e.ms)}${more}`);
  }

  /**
   * Prints an event in Claude Code's grammar: a bullet line, then '  ⎿ ' and 4-space detail lines. A
   * routine one has a faint '·' and muted text. `reason` (an error, a why) wraps rather than being cut,
   * because the log keeps it. With `whole`, the last line, which ends in a link, is never cut: the
   * terminal wraps it and copies it whole, where a cut one could be neither copied nor opened.
   */
  private say(tone: Tone, head: string, detail: string[] = [], reason?: string, whole = false, same?: string) {
    if (this.closed) return;
    // The same thing again takes the place of the line before it, with a count: a device that reloads
    // five times, or an agent that asks the same probe ten times, is one line. `same` names what
    // counts as the same when the numbers in the line differ; otherwise it is the line's own words.
    const body = reason ? [...detail, reason] : detail;
    // Without a name for it, the same means the same words, detail included, so nothing said is lost.
    const kind = `${tone} ${same ?? plainText([head, ...body].join('\n'))}`;
    const lines = (h: string) => {
      const at = (cols: number) => block(this.p, cols, h, body, tone === 'routine' ? 'faint' : tone, { wrap: !!reason });
      const out = at(this.o.screen.cols);
      if (whole) out[out.length - 1] = at(Infinity).at(-1)!;
      return out;
    };
    const again = this.last?.kind === kind ? this.last : null;
    if (again) {
      const out = lines(`${head} ${this.p.faint(`${G === ASCII ? 'x' : '×'}${again.times + 1}`)}`);
      if (this.o.screen.amend(again.mark, out)) return void again.times++;
    }
    // The first time, or piped, or something else was printed in between: said in full, uncounted.
    this.last = { kind, times: 1, mark: this.o.screen.print(lines(head)) };
  }

  /** An answer or anything else that is not an event line: what follows it starts a new count. */
  private put(lines: string[]) {
    this.last = null;
    this.o.screen.print(lines);
  }


  // ---- What the console draws ---------------------------------------------------------------------

  render() {
    if (this.closed || this.plain) return;
    const s = this.o.screen;
    this.pinCards();
    s.live(view(this.state(), s.cols, s.rows));
  }

  /**
   * The header pinned at the top, with a card under it for each device: its state as a coloured dot,
   * its name, platform and engine, its screen and cores, its address, and a reload's countdown. Pinned
   * again only when a card changes.
   */
  private pinCards() {
    if (!this.head) return;
    const lines = [...this.head, ...this.cards()];
    const key = lines.join('\n');
    if (key === this.pinned) return;
    this.pinned = key;
    this.o.screen.pin(lines);
  }

  private cards(): string[] {
    const p = this.p;
    const now = this.now();
    const w = this.o.screen.cols - 1;
    const label = (s: string) => '  ' + p.faint(s.padEnd(20));
    const duts = this.duts();
    const out: string[] = [];
    for (const t of duts.slice(-CARDS)) {
      const silent = t.session.lastFrameAt ? now - t.session.lastFrameAt : 0;
      const v = this.tracks.get(t.id)?.v;
      const due = this.reloads.get(t.id);
      const [tone, state] =
        due !== undefined && due > now ? [p.warn, `reloading ${Math.ceil((due - now) / 1000)} s`]
        : silent >= DEAD_MS ? [p.bad, `no sample for ${Math.floor(silent / 1000)} s`]
        : silent >= SILENT_MS ? [p.warn, `quiet ${Math.floor(silent / 1000)} s`]
        : v ? [p.good, 'live'] : [p.warn, 'connecting'];
      const [platform, engine] = uaParts(t.ua);
      const sp1 = this.specs.get(t.ua);
      const specs = [
        ...(sp1?.screen ? [sp1.screen.replace('x', G === ASCII ? 'x' : '×') + (sp1.dpr && sp1.dpr !== 1 ? ` @${sp1.dpr}x` : '')] : []),
        ...(sp1?.cores ? [`${sp1.cores} cores`] : []),
        ...(sp1?.memoryGB ? [`${sp1.memoryGB} GB`] : []),
        ...(v?.heapLimitMB ? [`heap ${v.heapLimitMB >= 1024 ? `${Math.round(v.heapLimitMB / 102.4) / 10} GB` : `${Math.round(v.heapLimitMB)} MB`}`] : []),
      ].join(sp());
      // Its state first, beside the dot, so a narrow terminal cuts the specs, never the state.
      out.push(label(out.length ? '' : duts.length > 1 ? 'devices' : 'device') + `${tone(G.dot)} ${p.bold(t.id)} ${tone(state)}  ${p.ink([platform, engine].filter(Boolean).join(sp()))}${specs ? '  ' + p.muted(specs) : ''}  ${p.faint(t.ip.replace(/^::ffff:/, ''))}`);
    }
    for (const g of [...this.gone.values()].filter((g) => !duts.some((t) => t.id === g.id)).slice(0, Math.max(0, CARDS - out.length))) {
      const due = this.reloads.get(g.id);
      const back = due !== undefined && due > now;
      const [platform, engine] = uaParts(g.ua);
      const state = back ? p.warn(`reloading${sp()}back within ${Math.ceil((due - now) / 1000)} s`) : p.bad(`gone ${Math.floor((now - g.at) / 1000)} s`);
      out.push(label(out.length ? '' : 'device') + `${(back ? p.warn : p.bad)(G.ring)} ${p.bold(g.id)} ${state}  ${p.muted([platform, engine].filter(Boolean).join(sp()))}`);
    }
    if (!out.length) out.push(label('device') + p.warn(`${G.ring} none yet`) + p.faint(`${sp()}open the address above on it`));
    return out.map((l) => truncate(l, w));
  }

  /** Reads a device's screen and cores once for its kind, for its card. Quietly: it is not an experiment. */
  private async askSpecs(id: string) {
    const t = this.find(id);
    if (!t || this.closed || this.specs.has(t.ua) || [...this.busy.values()].some((b) => b.id === id)) return;
    this.specs.set(t.ua, null);
    try {
      const r = (await request(this.o.port, 'eval', { id, by: 'console', body: { expr: SPECS_SCRIPT }, part: true })) as { value?: unknown };
      const v = typeof r.value === 'string' ? (JSON.parse(r.value) as Specs) : null;
      if (v) this.specs.set(t.ua, v);
      else this.specs.delete(t.ua);
    } catch {
      this.specs.delete(t.ua);
    }
    this.render();
  }

  /** A reload was asked for on a device: its row and card count down the time it has to come back. */
  private reloading(id: string) {
    this.reloads.set(id, this.now() + RELOAD_ASKED_MS);
  }

  private state(): ViewState {
    const now = this.now();
    const duts = this.duts();
    const target = this.target(duts);
    const remote = this.remoteOn(target);
    const sug = this.o.screen.interactive && !remote ? this.suggest() : null;
    // Typing a name: the list keeps only the entries it matches, under their groups.
    const matching = sug && this.input && !sug.args ? new Set(sug.rows.map(entryOf).filter((x): x is string => !!x)) : null;
    const running = new Set([...this.busy.values()].map((b) => b.entry));
    const at = remote ? 'remote' : this.showing(sug);
    const list = this.listRows(at, matching?.size ? matching : null, running, target);
    const due = (id: string) => {
      const d = this.reloads.get(id);
      return d !== undefined && d > now ? d - now : null;
    };
    return {
      p: this.p,
      color: this.o.color,
      now,
      port: this.o.port,
      interactive: this.o.screen.interactive,
      duts: duts.map((t) => {
        const tr = this.tracks.get(t.id);
        const last = t.session.lastFrameAt;
        return { id: t.id, ua: t.ua, silentMs: last ? Math.max(0, now - last) : null, v: tr?.session === t.session ? tr.v : null, devtools: t.clients.size, inspector: !!t.cdp, governor: t.governor.level, errors: t.errors.total, reloadMs: due(t.id), held: this.holding.get(t.id) ?? null };
      }),
      gone: [...this.gone.values()].map((g) => ({ id: g.id, ua: g.ua, ms: now - g.at, waiting: g.waiting, reloadMs: due(g.id) })),
      selected: target?.id ?? null,
      waiting: { link: this.o.dutLink, lan: this.o.lan ?? null, quiet: !this.reached && now - this.started >= QUIET_MS, appless: !!this.o.appless, appDown: this.appDown },
      notice: this.notice && this.notice.until > now ? this.notice.text : null,
      // Kept while its device is between pages, so a reload doesn't look like the mode ended.
      remote: remote ? { id: this.remote!, trail: this.trail, loads: target?.id === this.remote && !this.trail.length && !target.cdp } : null,
      list: list.rows,
      at: Math.max(0, list.ids.indexOf(at)),
      pane: (w, h) => this.pane(w, h, sug, target, at),
      // The input is always there while keys can arrive; remote mode has the keyboard instead.
      input: sug ? this.inputView(sug, target, at) : null,
      keys: this.o.screen.interactive ? this.keysNow(remote, duts.length) : [],
      idle: !this.input && this.overlay === 'none' && !remote && !this.results.get(at) && !running.has(at),
    };
  }

  /** The keys that act now, for the last line: the remote's while it has the keyboard, the input's while a line is typed, else the list's and the letters most used. */
  private keysNow(remote: boolean, duts: number): [string, string][] {
    if (remote) return [['arrows', 'move'], ['enter', 'ok'], [G.back, 'back'], ['0-9', 'digits'], ['c', 'capture'], ['m', 'map a key'], ['esc', 'leave']];
    if (this.input) return [['enter', 'run'], ['tab', 'complete'], [ud(), 'pick'], ['esc', 'clear']];
    // In the order a session goes: drive it there, measure, change one thing, then look closer.
    const letters = ['remote', 'capture', 'try', 'errors', 'devtools', 'survey', 'probe', 'network', 'history'].map((n) => entry(n)).filter((e): e is Entry => !!e?.key);
    return [[ud(), 'move'], ['enter', 'open'], ...letters.map((e): [string, string] => [e.key!, e.name]), ...(duts > 1 ? ([['tab', 'device']] as [string, string][]) : []), ['?', 'help'], ['^C', 'quit']];
  }

  /** The terminal has the rows for every group to stay open, so nothing waits behind a closed one. */
  private roomy(): boolean {
    return this.o.screen.rows >= GROUPS.length + MENU.length + AROUND;
  }

  /**
   * The list's rows: every group, and the entries of the one open, which is the group of the entry
   * highlighted (none while a group itself is highlighted). Typing a name shows only the entries it
   * matches, under their groups. `ids` names each row as `at` does.
   */
  private listRows(at: string, matching: Set<string> | null, running: Set<string>, target: DutSource | undefined): { rows: ListRow[]; ids: string[] } {
    const open = matching || isGroup(at) ? null : entry(at)?.group ?? null;
    const rows: ListRow[] = [];
    const ids: string[] = [];
    for (const g of GROUPS) {
      const all = entriesOf(g.id);
      const shown = matching ? all.filter((e) => matching.has(e.name)) : all;
      if (matching && !shown.length) continue;
      const expanded = !!matching || g.id === open || this.roomy();
      rows.push({ kind: 'group', group: g.id, name: g.id, running: !expanded && all.some((e) => running.has(e.name)), failed: false, status: expanded ? '' : this.groupStatus(g.id, target), open: expanded });
      ids.push(GROUP + g.id);
      if (!expanded) continue;
      for (const e of shown) {
        rows.push({ kind: 'entry', group: g.id, name: e.name, key: e.key, running: running.has(e.name), failed: !!this.runs.get(e.name)?.at(-1)?.failed, status: this.status(e.name, target) });
        ids.push(e.name);
      }
    }
    return { rows, ids };
  }

  /**
   * A closed group's few cells: what needs a look inside it (the page's errors, the last key pressed,
   * DevTools open), else its letters, so the letters are learned from the list.
   */
  private groupStatus(g: Group, target: DutSource | undefined): string {
    const p = this.p;
    if (g === 'inspect' && target?.errors.total) return p.bad(`${target.errors.total} error${target.errors.total === 1 ? '' : 's'}`);
    if (g === 'input') {
      const key = this.status('remote', target);
      if (key) return key;
    }
    if (g === 'inspect' && target?.clients.size) return p.ink('DevTools open');
    // What is inside, by name, so a closed group hides nothing: as many as the column fits.
    return p.faint(truncate(entriesOf(g).map((e) => e.name).join(' '), LEFT_WIDE - 15));
  }

  /**
   * What an entry shows now, in a few cells beside its name: the last key pressed on the device beside
   * remote (amber when nothing drew after it), the page's errors, DevTools open, and for the rest the
   * clock time it last ran, which stays put: a count of seconds since read as a timer still running.
   */
  private status(name: string, target: DutSource | undefined): string {
    const p = this.p;
    const now = this.now();
    if (name === 'remote' && target) {
      const v = this.tracks.get(target.id)?.v;
      const k = v?.press;
      const age = k && v ? v.t - k.t + Math.max(0, now - target.session.lastFrameAt) : Infinity;
      if (k && age < PRESS_SHOWN_MS) return (k.toFrameMs === null ? p.warn : p.accent)(truncate(k.key, 6));
    }
    if (name === 'errors' && target?.errors.total) return p.bad(String(target.errors.total));
    if (name === 'devtools' && target?.clients.size) return p.ink('open');
    const last = this.runs.get(name)?.at(-1);
    return last ? p.faint(hm(last.at)) : '';
  }

  /** Keeps a run of an entry for the right side, whoever asked. */
  private record(name: string, run: Run) {
    const list = this.runs.get(name) ?? [];
    list.push(run);
    if (list.length > RUNS_KEPT) list.shift();
    this.runs.set(name, list);
  }

  /** Remote mode is on: on the device keys act on, or on its device while that is between pages. */
  private remoteOn(target = this.target()): boolean {
    return !!this.remote && (target?.id === this.remote || this.held.has(this.remote));
  }

  /** The entry the right side opens: the one typed (the highlighted match, or the command whose words are being typed), else the one moved to. */
  private showing(sug: Suggestions | null): string {
    if (!sug || !this.input) return this.at;
    if (sug.args) return entry(this.input.split(' ')[0]!)?.name ?? this.at;
    const r = highlighted(sug.rows, this.pick);
    return (r && entryOf(r)) ?? this.at;
  }

  private inputView(sug: Suggestions, target: DutSource | undefined, at: string): InputView {
    const typed = !!this.input;
    // A port, an address or a folder typed: Enter serves it, which says so before it is pressed.
    const app = typed && this.o.connect && isApp(this.input) ? `enter serves ${appName(this.input)} to the device` : null;
    // What Enter does now, and nothing else: it is the one thing on this line that changes with what
    // is typed or highlighted. The keys that don't change are on the line under it, once.
    const hint = app ? [app] : typed ? [!this.taken(sug)?.waits ? 'enter runs it' : 'enter lists what it takes'] : [enterSays(at)];
    const silent = target?.session.lastFrameAt ? this.now() - target.session.lastFrameAt : 0;
    const tone = !target ? undefined : silent >= DEAD_MS ? 'bad' : silent >= SILENT_MS || this.reloads.has(target.id) ? 'warn' : 'good';
    return { text: this.input, caret: this.caret, error: this.error, hint: hint.join(sp()), on: /(?:^|\s)--id\s+(\S+)/.exec(this.input)?.[1] ?? target?.id ?? null, tone };
  }

  // ---- The right side -------------------------------------------------------------------------------

  /**
   * The highlighted entry, opened up to `w` by `h`: an explorer of it, never a manual. Whatever of it
   * runs now, as a beam; what it has done this session, whoever asked; and what it shows now: its last
   * answer, the device's own numbers for what only reads (errors, requests, the last minute), the
   * probes run and not, or the remote with the presses the page saw and what each key sends. `?`
   * adds what it does and costs. While its words are typed, the values there are to pick.
   */
  private pane(w: number, h: number, sug: Suggestions | null, target: DutSource | undefined, at: string): string[] {
    const p = this.p;
    this.paneLong = 0;
    if (this.remoteOn(target)) return this.remotePanel(w, h, target, true);
    if (isGroup(at)) return this.groupPane(groupOfAt(at), w, h, target);
    const e = entry(at)!;
    const on = e.cmd?.local ? '' : target ? p.faint('on ') + p.ink(target.id) : '';
    const out = [spread(`${p.bold(p.ink(e.name))}  ${p.muted(inGlyphs(e.brief))}`, on, w)];
    // Its words being typed: the values to pick from, and what the highlighted one costs.
    if (sug?.args && sug.rows.length) return [...out, '', ...this.valueLines(sug, w, h - 3), '', this.costLine(sug, w)].slice(0, h);
    if (this.overlay === 'help') return [...out, '', ...this.aboutLines(e, w), '', ...this.keyLegend(w)].slice(0, h);
    if (REMOTE_SIDE.has(e.name)) return this.remotePanel(w, h, target, false, e.name);
    for (const b of this.busy.values()) if (b.entry === e.name) out.push('', ...this.beamLines(b, w));
    out.push(...this.explore(e, w, target));
    const r = LIVE[e.name] ? this.liveAnswer(e.name, target) : this.results.get(e.name);
    if (r) {
      out.push('');
      const lines = this.answerLines(r, w);
      const room = h - out.length;
      if (lines.length <= room) return [...out, ...lines];
      // A long answer scrolls: page down shows more, and the last row says how much is left.
      this.paneLong = lines.length - (room - 1);
      const top = Math.min(this.paneTop, this.paneLong);
      const left = lines.length - top - (room - 1);
      return [...out, ...lines.slice(top, top + room - 1), p.faint(left > 0 ? `${G.down} ${left} more line${left === 1 ? '' : 's'}${sp()}page down` : `${G.up} page up`)];
    }
    if (out.length === 1) out.push('', p.faint(`nothing yet${sp()}${enterSays(e.name)}${sp()}? help`));
    return out.slice(0, h).map((l) => truncate(l, w));
  }

  /**
   * A group highlighted: what it is for, each of its entries with its letter, what it does and when it
   * last ran, and the group's latest runs this session, whoever asked.
   */
  private groupPane(g: Group, w: number, h: number, target: DutSource | undefined): string[] {
    const p = this.p;
    const brief = GROUPS.find((x) => x.id === g)!.brief;
    const out = [spread(`${p.bold(p.ink(g))}  ${p.muted(brief)}`, target ? p.faint('on ') + p.ink(target.id) : '', w), ''];
    const es = entriesOf(g);
    const nameW = Math.max(...es.map((e) => width(e.name))) + 2;
    for (const e of es) {
      const last = this.runs.get(e.name)?.at(-1);
      const mark = last ? `${last.failed ? p.bad(G.no) : p.accent(G.yes)} ${p.faint(hm(last.at))}` : '';
      out.push(spread(`${e.key ? p.accent(e.key) : ' '} ${pad(p.ink(e.name), nameW)}${p.muted(inGlyphs(e.brief))}`, mark, w));
    }
    const runs = es.flatMap((e) => this.runs.get(e.name) ?? []).sort((a, b) => a.at - b.at);
    if (runs.length && out.length + 3 <= h) out.push('', ...this.runLines(runs, w).slice(0, Math.max(1, h - out.length - 1)));
    return out.slice(0, h).map((l) => truncate(l, w));
  }

  /**
   * What the right side shows of an entry beyond its answer: its runs this session, the probes run
   * and not, the device's numbers now for capture, DevTools on each device, each device's page.
   */
  private explore(e: Entry, w: number, target: DutSource | undefined): string[] {
    const p = this.p;
    const now = this.now();
    const out: string[] = [];
    const runs = this.runs.get(e.name) ?? [];
    if (e.name === 'probe') {
      // Every probe, run or not: ✓ and how long ago, ✗ when it failed, · when it hasn't run.
      const last = (id: string) => [...runs].reverse().find((r) => r.line.split(' ')[1] === id);
      const cells = PROBE_IDS.map((id) => {
        const r = last(id);
        return `${r ? (r.failed ? p.bad(G.no) : p.accent(G.yes)) : p.faint(G.sep)} ${pad(r ? p.ink(id) : p.muted(id), 9)}${pad(r ? p.faint(hm(r.at)) : '', 5)}`;
      });
      out.push('');
      for (let i = 0; i < cells.length; i += 2) out.push(truncate(cells.slice(i, i + 2).join('  '), w));
    } else if (e.name === 'capture' && !this.results.has('capture') && target) {
      const v = this.tracks.get(target.id)?.v;
      if (v) {
        const k = v.press && v.t - v.press.t < KEY_SHOWN_MS ? `${p.faint('key')} ${p.ink(v.press.key)} ${p.muted(v.press.toFrameMs === null ? G.none : `${Math.round(v.press.toFrameMs)} ms`)}` : '';
        out.push('', [mainCell(v, p, 80, 0), v.heapMB !== null ? `${p.faint('heap')} ${p.muted(`${Math.round(v.heapMB)}${v.heapLimitMB ? `/${Math.round(v.heapLimitMB)}` : ''} MB`)}` : '', k].filter(Boolean).join('   '));
      }
    } else if (e.name === 'devtools') {
      out.push('');
      for (const t of this.duts()) {
        const open = t.clients.size;
        out.push(truncate(`${open ? p.accent(G.dot) : p.faint(G.ring)} ${p.bold(t.id)}  ${open ? p.ink(`open${open > 1 ? ` ×${open}` : ''}`) : p.muted('closed')}  ${p.faint(inspectUrl(this.o.port, this.o.key, t.id))}`, w));
      }
    } else if (e.name === 'reload') {
      out.push('');
      for (const t of this.duts()) out.push(truncate(`${p.bold(t.id)}  ${p.muted(pathOf(t.href))}`, w));
    }
    if (runs.length && e.name !== 'probe') out.push('', ...this.runLines(runs, w));
    return out;
  }

  /** An entry's last few runs, newest first: when, who asked when not this console, the line, how long, and how it ended. */
  private runLines(runs: Run[], w: number): string[] {
    const p = this.p;
    const now = this.now();
    return [...runs]
      .reverse()
      .slice(0, RUNS_SHOWN)
      .map((r) => truncate(`${pad(p.faint(hm(r.at)), 6)}${r.failed ? p.bad(G.no) : p.accent(G.yes)} ${r.who ? p.muted(r.who) + ' ' : ''}${p.ink(r.line)}${p.faint(`${sp()}${dur(r.ms)}`)}${r.failed ? p.bad(`${sp()}${r.failed}`) : ''}`, w));
  }

  /** What an entry does, how to type it, and what that costs: the `?` tidbit. */
  private aboutLines(e: Entry, w: number): string[] {
    const p = this.p;
    const help = inGlyphs(e.cmd?.help ?? REMOTE_ABOUT[e.name] ?? e.brief);
    const out = wrap(help, w).slice(0, 4).map((l) => p.muted(l));
    const usage = e.cmd ? [e.name, ...e.cmd.params.filter((x) => x.positional).map(paramForm)].join(' ') : e.name;
    out.push(`${p.faint(pad('type', 6))}${p.ink(usage)}${e.key ? p.faint(`${sp()}or ${e.key}, then enter`) : ''}`);
    out.push(`${p.faint(pad('cost', 6))}${p.muted(e.cmd ? costOf(e.cmd).replace(/^costs the device: /, '') : inGlyphs(e.cost ?? ''))}`);
    return out.map((l) => truncate(l, w));
  }

  /** The keys, and what each cell of a device's row means: the rest of `?`. */
  private keyLegend(w: number): string[] {
    const p = this.p;
    const bars = this.o.screen.cols >= WIDE ? 16 : this.o.screen.cols >= 50 ? 8 : 0;
    const rows: [string, string][] = [
      [ud(), 'move through the list; enter runs it, or lists the words it takes'],
      [`${G.right} ${G.left}`, 'open a group, and back up to it'],
      ['tab', 'picks the device; shift+tab goes back'],
      ['pgup/dn', 'scroll a long answer, else the log'],
      ['esc', 'clears what is typed; twice stops a trial you started'],
      ['main', bars ? `main thread blocked, each of the last ${bars} s` : 'main thread blocked, the last second'],
      ['heap', 'JS heap, of the limit where the device ends the app'],
      ['key', `last key press ${G.right} next frame; ${G.none} when none came`],
    ];
    return rows.map(([t, d]) => truncate(`${pad(p.ink(t), 9)}${p.muted(d)}`, w));
  }

  /** Something running, as a beam between two portals, with how far along and who asked. */
  private beamLines(b: Busy, w: number): string[] {
    const p = this.p;
    const now = this.now();
    const ms = now - b.since;
    const frac = b.seconds ? Math.min(1, ms / 1000 / b.seconds) : b.total ? Math.min(1, (b.done ?? 0) / b.total) : null;
    const fps = b.kind === 'capture' ? this.tracks.get(b.id)?.v?.fps : null;
    const says = b.seconds
      ? [`${Math.min(Math.floor(ms / 1000), b.seconds)} s of ${b.seconds}`, ...(fps !== null && fps !== undefined ? [`${Math.round(fps)} fps`] : [])]
      : b.total
        ? [`run ${Math.min((b.done ?? 0) + 1, b.total)} of ${b.total}`, elapsed(ms)]
        : [elapsed(ms)];
    const n = Math.max(8, Math.min(30, w - 2 - width(says.join(sp()))));
    const own = b === this.ownTrial();
    const under = [
      ...(b.who ? [`${b.who} ${b.what}`] : b.what !== b.entry ? [b.what] : []),
      `on ${b.id}`,
      ...(b.kind === 'capture' ? ['press keys on the device now'] : []),
      ...(own ? [this.escArmed > now ? 'esc again to stop it' : 'esc stops it'] : []),
    ];
    return [truncate(`${beam(p, frac, n, now)}  ${p.ink(says.join(sp()))}`, w), truncate(p.faint(under.join(sp())), w)];
  }

  /** An answer at the right side's width: the same lines `tlpt` prints, drawn again only when the width changes. */
  private answerLines(r: Answer, w: number): string[] {
    if (r.lines && r.width === w) return r.lines;
    const p = this.p;
    r.lines = r.failed
      ? block(p, w + 1, `${r.line}${r.id ? ` on ${p.bold(r.id)}` : ''} failed`, [], 'bad').concat(wrap(r.failed, w - 4).map((l) => `    ${p.muted(l)}`))
      : humanize(r.name, r.args, r.data, r.id, p, w + 1, { port: this.o.port, href: r.id ? this.find(r.id)?.href : undefined });
    r.width = w;
    return r.lines;
  }

  /**
   * An entry that only reads what this laptop has (errors, requests, the last minute, the devices, what
   * each key sends), kept fresh while it is on screen: asked again every LIVE_MS, which costs the device
   * nothing. The last answer there is meanwhile.
   */
  private liveAnswer(name: string, target: DutSource | undefined): Answer | undefined {
    const held = this.live.get(name);
    const id = name === 'devices' || name === 'status' ? undefined : target?.id;
    if (!held?.asking && (!held || this.now() - held.at >= LIVE_MS || held.a.id !== id) && (id || name === 'devices' || name === 'status')) {
      const args = LIVE[name]!;
      const slot = { a: held?.a ?? { name, args, data: null, id, line: name }, at: this.now(), asking: true };
      this.live.set(name, slot);
      // No folder: what only reads takes no paths.
      void (async () => {
        try {
          slot.a = { name, args, data: await runData(cmd(name), args, this.o.port, undefined, id, 'console'), id, line: name };
        } catch (e) {
          slot.a = { name, args, data: null, id, line: name, failed: firstLine(e) };
        }
        slot.asking = false;
        slot.at = this.now();
        if (!this.closed) this.render();
      })();
    }
    const a = this.live.get(name)?.a;
    return a && (a.data !== null || a.failed) ? a : undefined;
  }

  /** The values a command's word is picked from, around the highlighted one. */
  private valueLines(sug: Suggestions, w: number, h: number): string[] {
    const p = this.p;
    const rows = sug.rows;
    const pick = Math.min(this.pick, rows.length - 1);
    const nameW = Math.min(Math.max(0, ...rows.map((r) => width(r.name))) + 2, Math.floor(w / 2));
    const line = (r: Row, on: boolean) => {
      if (r.kind === 'empty') return `  ${p.faint(r.name)}`;
      const name = on ? p.bold(p.ink(r.name)) : p.muted(r.name);
      return truncate(`${on ? p.ink(G.sel) : ' '} ${pad(name, nameW)}${p.muted(r.brief)}`, w);
    };
    const n = Math.max(1, h);
    if (rows.length <= n) return rows.map((r, i) => line(r, i === pick));
    const slots = n - 1;
    const top = Math.max(0, Math.min(pick - Math.floor(slots / 2), rows.length - slots));
    const out = rows.slice(top, top + slots).map((r, i) => line(r, top + i === pick));
    const below = rows.length - top - slots;
    out.push(`  ${p.faint([...(below ? [`${G.down} ${below} more`] : []), ...(top ? [`${G.up} ${top} more`] : [])].join(sp()))}`);
    return out;
  }

  /** What the highlighted value or command costs the device, before it runs. */
  private costLine(sug: Suggestions, w: number): string {
    const r = highlighted(sug.rows, this.pick);
    const c = r?.cmd ?? sug.cmd;
    const info = r?.cost ? r.cost : c?.name === 'eval' && sug.args ? sentence(c.params[0]!.help) : c ? costOf(c) : '';
    return truncate(this.p.faint(info), w);
  }

  /**
   * The remote, whether or not it has the keyboard: a d-pad lit by the last key sent or pressed on the
   * device, the presses the page saw (the device's own too, from its samples, which costs nothing) with
   * what each led to, what the page heard in remote mode, and what each key sends here, which `m`
   * changes in remote mode.
   */
  private remotePanel(w: number, h: number, target: DutSource | undefined, driving: boolean, name = 'remote'): string[] {
    const p = this.p;
    const now = this.now();
    const tr = target ? this.tracks.get(target.id) : undefined;
    const v = tr?.v;
    const seen = tr && target ? presses(target.session.timeline, target.session.meta.names, PRESSES_SHOWN) : [];
    // The newest press on the device lights its key for a moment, as one sent from here does.
    const fresh = v?.press && v.t - v.press.t < LIT_MS * 4 ? v.press.key : null;
    const lit = this.lit && this.lit.until > now ? this.lit.key : fresh === G.up ? 'up' : fresh === G.down ? 'down' : fresh;
    const k = (id: string, label: string) => (lit === id ? p.inverse(p.accent(label)) : p.ink(label));
    const pad3 = (s: string) => pad(s, 3);
    const side = driving
      ? [`arrows move${sp()}enter ok`, `${G.back} back${sp()}0-9 digits`, `m maps a key${sp()}esc leaves`]
      : [name === 'remote' ? 'enter drives the device' : enterSays(name), 'from this keyboard', ''];
    const pad16 = [
      `      ${k('up', G.up)}`,
      `   ${pad3(k('left', G.left))}${pad3(k('ok', 'ok'))} ${k('right', G.right)}`,
      `      ${k('down', G.down)}`,
    ].map((l, i) => pad(l, 16) + p.faint(side[i]!));
    const e = entry(name)!;
    const head = driving ? `${p.bold(p.ink('remote'))}  ${p.muted('this keyboard is the remote')}` : `${p.bold(p.ink(e.name))}  ${p.muted(inGlyphs(e.brief))}`;
    const out = [spread(head, target ? p.faint('on ') + p.ink(target.id) : '', w), '', ...pad16, ''];
    if (this.mapping) out.push(this.mappingLine(), '');
    if (driving && this.trail.length) out.push(`${p.faint(pad('sent', 7))}${p.ink(this.trail.map((t) => (t === 'up' || t === 'down' || t === 'left' || t === 'right' ? G[t] : t)).join(' '))}`);
    // What the page heard, named, while listening; else the presses the page's samples hold.
    if (driving && this.heard.length) out.push(...formatHear({ heard: this.heard, learned: [], sends: {} }, p, w + 1).slice(1));
    else if (seen.length) {
      out.push(p.faint('presses the page saw, newest first'));
      for (const s of seen) {
        const did = s.toFrameMs === null ? p.warn(`nothing drew${sp()}the app may not answer ${s.key}`) : p.muted(`${Math.round(s.toFrameMs)} ms to a frame${s.target ? `${sp()}focus ${s.target}` : ''}`);
        out.push(truncate(`  ${pad(p.ink(s.key), 7)}${did}`, w));
      }
    } else out.push(p.faint(driving && this.hearError ? `can't listen in the page: ${this.hearError}` : "no presses yet: press keys here in remote mode, or on the device's own remote"));
    const map = this.liveAnswer('keymap', target)?.data as { sends?: Record<string, Press>; mapped?: string[] } | undefined;
    const sends = map?.sends ?? this.sends;
    // OK and back always; an arrow only when it sends something other than the arrow key.
    const ids = Object.keys(sends).filter((id) => id === 'ok' || id === 'back' || map?.mapped?.includes(id) || sends[id]!.keyCode !== KEY[id as KeyId]?.press.keyCode);
    if (ids.length) {
      out.push('', `${p.faint('sends')}  ${ids.map((id) => `${p.ink(id === 'up' || id === 'down' || id === 'left' || id === 'right' ? G[id] : id)} ${p.muted(pressWords(sends[id]!))}${map?.mapped?.includes(id) ? p.accent('*') : ''}`).join('  ')}`);
      if (map?.mapped?.length) out.push(p.faint(`${' '.repeat(7)}* set here or heard${sp()}keymap ${map.mapped[0]} reset undoes it`));
    }
    if (name === 'hear' || name === 'keys' || name === 'keymap') {
      const runs = this.runs.get(name) ?? [];
      if (runs.length) out.push('', ...this.runLines(runs, w));
      const r = this.results.get(name);
      if (r && name !== 'keymap') out.push('', ...this.answerLines(r, w));
    }
    return out.slice(0, h).map((l) => truncate(l, w));
  }

  /** Where mapping a key by hand is: which key, then what it should send. */
  private mappingLine(): string {
    const p = this.p;
    const m = this.mapping!;
    if (!m.id) return p.accent(`map: press the key to change, here (arrows, enter, ${G.back})${sp()}esc cancels`);
    return p.accent(`map ${m.id}: press the button the app answers to on the device's own remote, or type its key code, then enter${sp()}`) + p.ink(m.typed ? `${m.typed}_` : '_');
  }

  /** Once a second: expire what has had its time, say what was held, and redraw if anything on screen counts time. */
  private tick() {
    if (this.closed) return;
    const now = this.now();
    const duts = this.duts();
    const counting =
      this.gone.size > 0 || this.held.size > 0 || this.documents.size > 0 || this.reloads.size > 0 || !!this.notice || this.escArmed > 0 || !duts.length ||
      // What is on the right side now is kept fresh: an entry that reads live, or the remote's presses.
      !!LIVE[this.at] || REMOTE_SIDE.has(this.at) ||
      duts.some((t) => t.session.lastFrameAt && now - t.session.lastFrameAt >= SILENT_MS);
    for (const [id, h] of this.held) {
      // A reload asked for has its own countdown: the device is said gone only once that runs out.
      const due = this.reloads.get(id);
      if (now - h.at < HOLD_GONE_MS || (due !== undefined && due > now)) continue;
      this.held.delete(id);
      const share = h.heap ? h.heap.mb / h.heap.limit : 0;
      this.say(due !== undefined ? 'bad' : 'warn', due !== undefined ? `${this.p.bold(id)} didn't come back ${Math.round(RELOAD_ASKED_MS / 1000)} s after the reload` : `${this.p.bold(id)} went away`, [
        ...(h.waiting ? ['DevTools waits a minute for it to come back'] : []),
        ...(h.heap && share >= HEAP_ALARM ? [`its heap was ${Math.round(h.heap.mb)} of ${Math.round(h.heap.limit)} MB (${pct(share)}): the engine may have ended it for memory`] : []),
      ]);
      // It didn't come back: keys act on the newest device left, and remote mode on it is over.
      if (this.selected === id) this.selected = duts[duts.length - 1]?.id ?? null;
      if (this.remote === id) this.endRemote();
    }
    for (const [id, g] of this.gone) {
      if (now - g.at < GONE_SHOWN_MS) continue;
      this.gone.delete(id);
      if (!duts.some((t) => t.id === id)) {
        this.tracks.delete(id);
        this.devtools.delete(id);
        this.order.delete(id);
      }
    }
    for (const [ip, d] of this.documents) {
      if (now - d.at < NO_AGENT_MS) continue;
      this.documents.delete(ip);
      if (duts.some((t) => t.ip === ip)) continue;
      this.noAgent.add(ip);
      this.say('warn', `${ip.replace(/^::ffff:/, '')} loaded ${d.path} ${Math.round(NO_AGENT_MS / 1000)} s ago, but no agent connected`, [`a firewall on port ${this.o.port}, or the page's content security policy, may block it`]);
    }
    // A reload whose device never went (the page ignored it) or came back is done with once its time is up.
    for (const [id, due] of this.reloads) if (due <= now && !this.held.has(id)) this.reloads.delete(id);
    if (this.notice && this.notice.until <= now) this.notice = null;
    if (this.escArmed <= now) this.escArmed = 0;
    if (counting) this.render();
  }

  /** A spinner timer, only while something runs. */
  private spin() {
    if (this.spinner || !this.busy.size || this.plain) return;
    this.spinner = setInterval(() => {
      if (!this.busy.size) {
        clearInterval(this.spinner!);
        this.spinner = null;
      }
      this.render();
    }, SPIN_MS);
    this.spinner.unref?.();
  }

  close() {
    this.closed = true;
    this.stopHearing();
    if (this.spinner) clearInterval(this.spinner);
    if (this.align) clearTimeout(this.align);
    if (this.watchdog) clearInterval(this.watchdog);
    this.spinner = this.align = this.watchdog = null;
  }

  // ---- Devices ----------------------------------------------------------------------------------------

  private duts(): DutSource[] {
    const duts = [...this.o.duts()];
    for (const t of duts) if (!this.order.has(t.id)) this.order.set(t.id, this.seen++);
    return duts.sort((a, b) => this.order.get(a.id)! - this.order.get(b.id)!);
  }

  private find(id: string) {
    for (const t of this.o.duts()) if (t.id === id) return t;
    return undefined;
  }

  /** The device keys act on: the selected one, or the newest while it is away. */
  private target(duts = this.duts()): DutSource | undefined {
    return duts.find((t) => t.id === this.selected) ?? duts[duts.length - 1];
  }

  private trackOf(t: DutSource): Track {
    let tr = this.tracks.get(t.id);
    if (!tr) this.tracks.set(t.id, (tr = { session: t.session, v: null, watch: watch(), heap: null }));
    else if (tr.session !== t.session) Object.assign(tr, { session: t.session, v: null, watch: watch() });
    return tr;
  }

  private ownTrial(): Busy | undefined {
    let own: Busy | undefined;
    for (const b of this.busy.values()) if (b.stop) own = b;
    return own;
  }

  /** Why a capture or trial now would be wrong: one already runs on that device, and each would measure the other. */
  private clash(id: string, wanted: string): string | null {
    for (const b of this.busy.values()) if (b.id === id && (b.kind === 'capture' || b.kind === 'trial')) return `a ${b.kind} is running on ${id}; a ${wanted} now would measure it`;
    return null;
  }

  private noDut(): string {
    const how = this.o.dutLink ? `open ${this.o.dutLink} on it` : `in your app: ${initLine(this.o.lan ?? `<this laptop>:${this.o.port}`)}`;
    return `no device connected yet${sp()}${how}`;
  }

  /** A notice in place of the footer for a couple of seconds. */
  private tell(text: string) {
    this.notice = { text, until: this.now() + NOTICE_MS };
    this.render();
  }

  // ---- Keys ---------------------------------------------------------------------------------------

  key(k: Key) {
    if (this.closed) return;
    const now = this.now();
    this.touched = true;
    // Another device where remote mode's was (it went away) ends the mode, so no press goes to a device not
    // chosen. While its device is between pages (a reload, a link) the mode waits for it.
    const on = this.target();
    if (this.remote && on && on.id !== this.remote && !this.held.has(this.remote)) this.endRemote();
    // ctrl+c clears what is typed; with nothing typed it quits.
    if (k.ctrl && k.name === 'c') {
      if (!this.input) return this.o.quit();
      this.closePalette();
      return this.render();
    }
    if (k.name === 'pageup' || k.name === 'pagedown') {
      // A long answer on the right scrolls first; otherwise the log does.
      if (this.paneLong > 0 && !this.remote) {
        const page = Math.max(1, this.o.screen.rows >> 2);
        this.paneTop = Math.max(0, Math.min(this.paneLong, this.paneTop + (k.name === 'pagedown' ? page : -page)));
        return this.render();
      }
      return this.o.screen.scroll(k.name === 'pageup' ? 1 : -1);
    }
    const duts = this.duts();
    const dut = this.target(duts);
    const ch = k.ctrl || k.meta ? '' : k.text;
    if (this.remote) {
      // Remote mode has the keyboard: its keys go to the device, c captures the presses, m maps a key,
      // esc or r leaves.
      if (k.name === 'paste') return;
      if (this.mapping) return this.mapKey(k, ch, dut);
      if (ch === 'm') this.mapping = { id: null, typed: '' };
      else if (k.name === 'escape' || ch === 'r') this.endRemote();
      else if (!k.ctrl && !k.meta && REMOTE[k.name]) {
        if (dut?.id !== this.remote) return this.tell(`between pages${sp()}press again once it is back`);
        return this.press(REMOTE[k.name]!, dut);
      } else if (ch === 'c' && dut) {
        const fail = this.act(entry('capture')!, dut);
        if (fail) return this.tell(fail);
      }
      return this.render();
    }
    if (k.name === 'escape') {
      this.o.screen.scroll(0);
      this.paneTop = 0;
      if (this.input) this.closePalette();
      else this.escape(now);
      return this.render();
    }
    if (!this.input) {
      // An empty input: the arrows move through the list and enter opens what is highlighted; ? explains
      // the keys and the rows; tab picks the next device.
      if (ch === '?') {
        this.overlay = this.overlay === 'help' ? 'none' : 'help';
        return this.render();
      }
      if (k.name === 'tab') {
        if (duts.length > 1) return this.select(duts, k.shift ? -1 : 1);
        return this.tell(dut ? 'one device connected' : this.noDut());
      }
      if (k.name === 'up' || k.name === 'down') {
        this.overlay = 'none';
        return this.move(k.name === 'up' ? -1 : 1);
      }
      if (k.name === 'return') {
        this.overlay = 'none';
        return this.open();
      }
      // Right opens the group highlighted; left goes back up to the entry's group.
      if (k.name === 'right') {
        if (isGroup(this.at)) return this.open();
        return this.tell(dut ? `arrows drive the device in remote mode${sp()}r, then enter` : this.noDut());
      }
      if (k.name === 'left') {
        if (!isGroup(this.at)) return this.up();
        return this.tell(dut ? `arrows drive the device in remote mode${sp()}r, then enter` : this.noDut());
      }
      // The list is always open: / has nothing more to show.
      if (k.name === 'backspace' || ch === '/') return this.render();
    }
    // Anything typed closes the ? side and goes into the input.
    this.overlay = 'none';
    if (k.name === 'paste') {
      // A line copied from a shell or an agent runs as it is.
      this.insert((this.input ? k.text : k.text.trim().replace(/^(?:npx )?(?:tlpt|tp|teleport) (?:q )?|^q /, '')));
      return this.render();
    }
    this.paletteKey(k);
  }

  /** Moves the highlight through the rows shown, round at the ends: past a group's last entry is the next group. */
  private move(step: number) {
    const { ids } = this.listRows(this.at, null, new Set(), undefined);
    const i = Math.max(0, ids.indexOf(this.at));
    this.at = ids[(i + step + ids.length) % ids.length]!;
    this.paneTop = 0;
    this.render();
  }

  /** Back up from an entry to its group, which closes. */
  private up() {
    if (!isGroup(this.at)) this.at = GROUP + groupOfAt(this.at);
    this.paneTop = 0;
    this.render();
  }

  /**
   * Enter on the highlighted entry: one that needs a word, or has values to pick from, starts its line
   * in the input and lists them on the right; the rest run with their defaults.
   */
  private open() {
    // A group opens onto its first entry.
    if (isGroup(this.at)) {
      this.at = entriesOf(groupOfAt(this.at))[0]!.name;
      this.paneTop = 0;
      return this.render();
    }
    const e = entry(this.at)!;
    const c = e.cmd;
    if (c && ((PICKS.has(e.name) && e.name !== 'capture') || c.params.some((x) => x.positional && x.required))) {
      this.edit(`${e.name} `, e.name.length + 1);
      return this.render();
    }
    // Those with a letter run as the letter does; the rest as their name typed alone.
    const dut = this.target();
    if (dut && (!c || Console.DEFAULTS[e.name])) {
      const fail = this.act(e, dut);
      return fail ? this.tell(fail) : this.render();
    }
    this.run(e.name);
  }

  /** What each key's entry runs with no words after it. */
  private static readonly DEFAULTS: Record<string, [Args, string]> = {
    history: [{ limit: 20 }, 'history'],
    capture: [{ seconds: CAPTURE_S }, `capture ${CAPTURE_S}`],
    device: [{ seconds: 60 }, 'device --seconds 60'],
    network: [{ limit: 20 }, 'network --limit 20'],
  };

  /** Runs a menu entry on a device with its defaults, from its key or its bare name. Returns why not, if not. */
  private act(e: Entry, dut: DutSource): string | null {
    const p = this.p;
    this.at = e.name;
    this.paneTop = 0;
    switch (e.name) {
      case 'remote':
        this.remote = dut.id;
        this.trail = [];
        this.startHearing(dut.id);
        return null;
      case 'devtools':
        this.o.openDevtools(dut.id);
        this.say('routine', `DevTools for ${p.bold(dut.id)}${sp()}${p.link(inspectUrl(this.o.port, this.o.key, dut.id))}`, [], undefined, true);
        return null;
      case 'reload':
        this.o.reload(dut.id);
        this.reloading(dut.id);
        this.say('routine', `${p.bold(dut.id)} reloading${sp()}${Math.round(RELOAD_ASKED_MS / 1000)} s to come back`);
        return null;
    }
    const clash = e.name === 'capture' || e.name === 'survey' ? this.clash(dut.id, e.name) : null;
    if (clash) return clash;
    const [args, line] = Console.DEFAULTS[e.name] ?? [{}, e.name];
    void this.perform(e.cmd!, args, dut.id, line);
    return null;
  }

  /** Esc with nothing typed closes the ? panel; with nothing open, twice stops the console's own trial. */
  private escape(now: number) {
    if (this.overlay === 'help') this.overlay = 'none';
    else {
      const own = this.ownTrial();
      if (own && this.escArmed > now) this.stopTrial(own);
      else if (own) this.escArmed = now + ARM_MS;
    }
    this.render();
  }

  private select(duts: DutSource[], step: number) {
    const i = duts.indexOf(this.target(duts)!);
    this.selected = duts[(i + step + duts.length) % duts.length]!.id;
    this.render();
  }

  // ---- Remote mode --------------------------------------------------------------------------------

  private endRemote() {
    this.remote = null;
    this.trail = [];
    this.mapping = null;
    this.stopHearing();
  }

  /**
   * A key while mapping: first the remote key to change (pressed here), then what it should send: the
   * next press heard on the device's own remote, or a key code typed and Enter. Esc gives up.
   */
  private mapKey(k: Key, ch: string, dut: DutSource | undefined) {
    const m = this.mapping!;
    if (k.name === 'escape') this.mapping = null;
    else if (!m.id) {
      const id = REMOTE[k.name];
      if (id && id in KEY) m.id = id as KeyId;
    } else if (/^[0-9]$/.test(ch)) m.typed = (m.typed + ch).slice(0, 5);
    else if (k.name === 'backspace') m.typed = m.typed.slice(0, -1);
    else if (k.name === 'return' && m.typed && dut) void this.setKey(dut.id, m.id, m.typed);
    this.render();
  }

  /** Sets what a remote key sends on this kind of device, and says so. */
  private async setKey(id: string, key: KeyId, code: string) {
    this.mapping = null;
    try {
      const r = (await runData(cmd('keymap'), { key, code }, this.o.port, undefined, id, 'console')) as { sends?: Record<string, Press> } | undefined;
      if (r?.sends) this.sends = r.sends;
      this.live.delete('keymap');
      const now = r?.sends?.[key];
      this.say('ink', `${this.p.bold(id)} ${key} sends ${now ? pressWords(now) : code} now`, [`for every device of its platform${sp()}keymap ${key} reset puts it back`]);
    } catch (e) {
      this.say('bad', `keymap ${key} on ${this.p.bold(id)} failed`, [], firstLine(e));
    }
    this.render();
  }

  /**
   * Asks the page what it heard, every HEAR_EVERY_MS while remote mode is on: the presses sent from
   * here and the device's own, named, and any key the device sends differently, which the remote
   * sends from then on (hear.ts).
   */
  private startHearing(id: string) {
    this.stopHearing();
    this.heard = [];
    this.sends = {};
    this.hearError = null;
    const ask = async () => {
      if (this.hearAsking || this.closed || this.remote !== id) return;
      this.hearAsking = true;
      try {
        const a = (await runData(cmd('hear'), { seconds: 0 }, this.o.port, undefined, id, 'console')) as Partial<HearAnswer> | undefined;
        this.hearError = null;
        if (!a || !Array.isArray(a.heard) || this.remote !== id) return;
        const sends = JSON.stringify(a.sends ?? {});
        const changed = sends !== JSON.stringify(this.sends) || a.heard.length > 0;
        if (a.sends) this.sends = a.sends;
        if (a.heard.length) this.heard = [...this.heard, ...a.heard].slice(-HEARD_SHOWN);
        // Mapping a key and waiting for the device's own button: the first it presses is the one.
        const own = a.heard.find((h) => h.kind === 'key' && h.from === 'device');
        if (this.mapping?.id && own) void this.setKey(id, this.mapping.id, String(own.keyCode));
        for (const l of a.learned ?? []) this.say('ink', `${this.p.bold(id)} sends ${l.id} as ${l.name}`, [`heard from the device's own remote (${pressWords(l.press)})${sp()}the remote sends that now`]);
        if (changed) this.render();
      } catch (e) {
        this.hearError = firstLine(e);
      } finally {
        this.hearAsking = false;
      }
    };
    void ask();
    this.hearing = setInterval(() => void ask(), HEAR_EVERY_MS);
    this.hearing.unref?.();
  }

  private stopHearing() {
    if (this.hearing) clearInterval(this.hearing);
    this.hearing = null;
  }

  private press(name: string, dut: DutSource | undefined) {
    if (!dut) return this.tell(this.noDut());
    if (this.waiting.length >= REMOTE_WAITING) return this.tell(`the device is behind${sp()}extra presses dropped`);
    this.waiting.push(name);
    this.trail = [...this.trail, name].slice(-TRAIL);
    this.lit = { key: name, until: this.now() + LIT_MS };
    // The lit key goes out again once its time is up.
    setTimeout(() => this.render(), LIT_MS + 10).unref?.();
    this.render();
    void this.pump(dut.id);
  }

  /** Sends the waiting presses in order, all that wait as one request, so a burst is one round trip. */
  private async pump(id: string) {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.waiting.length) {
        const run = (await runData(cmd('keys'), { sequence: this.waiting.splice(0) }, this.o.port, undefined, id, 'console')) as RemoteRun;
        if (run.error) throw new Error(run.error);
      }
    } catch (e) {
      this.waiting = [];
      this.say('bad', `remote on ${this.p.bold(id)} failed`, [], firstLine(e));
    } finally {
      this.sending = false;
    }
  }

  // ---- Commands -----------------------------------------------------------------------------------

  /**
   * Runs a command against this tlpt. Its answer opens on the right, under its entry, which is
   * highlighted; the log gets its first line. Piped, the whole answer is printed, as `tlpt` prints it.
   */
  private async perform(c: Command, args: Args, id: string | undefined, line: string) {
    const p = this.p;
    const token = ++this.seq;
    const stop = c.name === 'trial' || c.name === 'try' ? new AbortController() : undefined;
    const kind = (c.name === 'try' ? 'trial' : ['capture', 'trial', 'probe', 'eval', 'keys'].includes(c.name) ? c.name : 'call') as Busy['kind'];
    this.at = c.name;
    this.paneTop = 0;
    if (id && ['capture', 'trial', 'try', 'probe', 'eval', 'keys', 'survey', 'verify', 'hear', 'replay'].includes(c.name)) {
      // The length q.ts sends: none is the default, and 0 or less is 1 s, not 10.
      const seconds = kind === 'capture' ? Math.min(Math.max(Number(args.seconds ?? CAPTURE_S) || 1, 1), CAPTURE_S) : c.name === 'hear' ? Math.min(Math.max(Number(args.seconds ?? 10) || 1, 1), 60) : undefined;
      this.busy.set(token, { id, kind, entry: c.name, who: '', what: kind === 'capture' ? 'capture' : line.replace(/\s*--id\s+\S+/, ''), since: this.now(), seconds, line, stop });
      this.spin();
      this.render();
    }
    const since = this.now();
    try {
      const data = await runData(c, args, this.o.port, this.o.cwd ?? process.cwd(), id, 'console', stop?.signal);
      if (this.closed) return;
      const lines = humanize(c.name, args, data, id, p, this.o.screen.cols, { port: this.o.port, href: id ? this.find(id)?.href : undefined });
      const a: Answer = { name: c.name, args, data, id, line };
      this.results.set(c.name, a);
      // The shim turned on or off: each device it named reloads into it.
      for (const r of (c.name === 'shim' && (data as { reloaded?: string[] })?.reloaded) || []) this.reloading(r);
      // What only reads is shown live; this answer is the freshest of it until the next.
      if (LIVE[c.name]) this.live.set(c.name, { a, at: this.now(), asking: false });
      this.record(c.name, { at: this.now(), who: '', line, id, ms: this.now() - since });
      this.put(this.plain ? this.cut(lines, line, id) : lines.slice(0, 1));
    } catch (e) {
      // A trial stopped with esc esc has said so already.
      if (!stop?.signal.aborted) {
        this.results.set(c.name, { name: c.name, args, data: null, id: c.local ? undefined : id, line: `/${line}`, failed: firstLine(e) });
        this.record(c.name, { at: this.now(), who: '', line, id, ms: this.now() - since, failed: firstLine(e) });
        this.say('bad', `/${line}${id && !c.local ? ` on ${p.bold(id)}` : ''} failed`, [], firstLine(e));
      } else this.record(c.name, { at: this.now(), who: '', line, id, ms: this.now() - since, failed: 'stopped' });
    } finally {
      this.busy.delete(token);
      this.render();
    }
  }

  /**
   * A long answer, cut, with the command that prints the same view in full. Its last line stays, which
   * for a probe is the tally.
   */
  private cut(lines: string[], line: string, id: string | undefined): string[] {
    if (lines.length <= RESULT_LINES) return lines;
    const which = id && !/--id\b/.test(line) && this.duts().length > 1 ? ` --id ${id}` : '';
    return [...lines.slice(0, RESULT_LINES - 1), `    ${this.p.faint(`${G.ellipsis} ${lines.length - RESULT_LINES} more lines${sp()}tlpt ${line}${which} prints all of it`)}`, lines[lines.length - 1]!];
  }

  /** Stops the console's own trial after its current run: the server ends it when the request goes. */
  private stopTrial(b: Busy) {
    b.stop!.abort();
    this.escArmed = 0;
    const runs = b.total ? `${Math.min((b.done ?? 0) + 1, b.total)} of ${b.total} runs` : null;
    this.say('ink', `/${b.line} stopped`, [runs ? `the device finishes the run in progress, then the trial ends: ${runs}, no report` : 'the trial ends before its first run, with no report']);
  }

  // ---- The palette --------------------------------------------------------------------------------

  /** Empties the input and closes its list. */
  private closePalette() {
    this.files = null;
    this.edit('', 0);
  }

  private edit(text: string, caret: number) {
    this.input = text;
    this.caret = caret;
    this.pick = 0;
    this.error = null;
  }

  private insert(text: string) {
    // A tab or another control character would move the terminal's cursor where width() doesn't count it.
    let t = text.replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '');
    // The prompt is already a slash.
    if (!this.input && t.startsWith('/')) t = t.slice(1);
    t = t.slice(0, Math.max(0, MAX_INPUT - this.input.length));
    if (t) this.edit(this.input.slice(0, this.caret) + t + this.input.slice(this.caret), this.caret + t.length);
  }

  /** What is typed moves the list's highlight to what it finds, which stays highlighted once the input is cleared. */
  private follow() {
    if (!this.input) return;
    const at = this.showing(this.suggest());
    if (entry(at)) this.at = at;
  }

  private paletteKey(k: Key) {
    this.paletteEdit(k);
    this.follow();
    this.render();
  }

  private paletteEdit(k: Key) {
    const s = this.input;
    const at = this.caret;
    switch (k.name) {
      case 'return':
        return this.enter();
      case 'tab': {
        const sug = this.suggest();
        const r = highlighted(sug.rows, this.pick);
        if (r && r.kind !== 'empty') this.complete(r, sug);
        return this.render();
      }
      case 'up':
      case 'down': {
        const n = this.suggest().rows.filter((r) => r.kind !== 'empty').length;
        if (n) this.pick = (Math.min(this.pick, n - 1) + (k.name === 'up' ? -1 : 1) + n) % n;
        return this.render();
      }
      case 'left':
        this.caret = back(s, at);
        return this.render();
      case 'right':
        this.caret = forward(s, at);
        return this.render();
      case 'home':
        this.caret = 0;
        return this.render();
      case 'end':
        this.caret = s.length;
        return this.render();
      case 'backspace':
        // Alt+Backspace takes a word, as ctrl+w does.
        if (k.meta) this.edit(s.slice(0, wordStart(s, at)) + s.slice(at), wordStart(s, at));
        else if (at) this.edit(s.slice(0, back(s, at)) + s.slice(at), back(s, at));
        return this.render();
      case 'delete':
        if (at < s.length) this.edit(s.slice(0, at) + s.slice(forward(s, at)), at);
        return this.render();
      case 'paste':
        this.insert(k.text);
        return this.render();
    }
    if (k.ctrl) {
      if (k.name === 'a') this.caret = 0;
      else if (k.name === 'e') this.caret = s.length;
      else if (k.name === 'u') this.edit('', 0);
      else if (k.name === 'w') this.edit(s.slice(0, wordStart(s, at)) + s.slice(at), wordStart(s, at));
    } else if (k.text && !k.meta) this.insert(k.text);
    this.render();
  }

  /**
   * What the palette offers at the caret: before the first space, the commands (or the recent lines
   * when nothing is typed), ranked; after it, the command's values for the word being typed.
   */
  private suggest(): Suggestions {
    const s = this.input;
    const before = s.slice(0, this.caret);
    const from = before.lastIndexOf(' ') + 1;
    const to = this.caret + /^\S*/.exec(s.slice(this.caret))![0].length;
    // The whole word at the caret, so the row offered is the word the line shows (devices, not device).
    const word = s.slice(from, to).toLowerCase();
    if (!from) {
      const all = MENU.map(entryRow);
      // Nothing typed: the list on the left is the whole list.
      if (!s) return { rows: [], cmd: null, from: 0, to: 0, args: false };
      if (this.o.connect && isApp(s)) return { rows: [emptyRow(`enter serves ${appName(s)} to the device${sp()}${this.o.appless ? 'it opens there within 2 s' : 'its page reloads on it'}`)], cmd: null, from: 0, to, args: false };
      const words = (r: Row) => r.brief.toLowerCase().split(/[^a-z0-9]+/);
      const ranked = rank(all, word, (r) => words(r).some((x) => x.startsWith(word)));
      // A letter alone is its entry first (r is remote, not report), and a toggle's name is offered as the line that tries it.
      const rows = [...ranked.filter((r) => r.key === word), ...ranked.filter((r) => r.key !== word), ...(word.length > 1 ? TOGGLES.filter((t) => t.name.startsWith(word)).map(toggleRow) : [])];
      return { rows: rows.length ? rows : [emptyRow(`no command matches "${s.slice(0, to)}"`)], cmd: null, from: 0, to, args: false };
    }
    const c = COMMANDS.find((x) => x.name === before.slice(0, before.indexOf(' ')).toLowerCase()) ?? null;
    if (!c) return { rows: [], cmd: null, from, to, args: true };
    const typed = before.slice(before.indexOf(' ') + 1, from).trim();
    const prev = typed.split(' ').pop() ?? '';
    let values: Row[] = [];
    if (prev === '--id') values = this.duts().map((t) => valueRow(c, t.id, uaParts(t.ua).filter(Boolean).join(sp())));
    else if (word.startsWith('-')) values = flagRows(c);
    else if (!(prev.startsWith('--') && takesValue(c, prev)) && !positionalsFull(c, typed)) {
      values = this.valuesOf(c);
      // A length typed for capture is a row of its own, first, so the row Enter runs is the one typed.
      if (c.name === 'capture' && /^\d+(\.\d+)?$/.test(word) && +word >= 1 && +word <= CAPTURE_S && !values.some((v) => v.value === word)) values = [valueRow(c, word, 'seconds'), ...values];
    }
    let rows = rank(values, word);
    if (!rows.length && word && values.length) {
      const near = nearest(word, values.map((v) => v.value));
      if (near) rows = values.filter((v) => v.value === near).map((v) => ({ ...v, guess: true }));
    }
    return { rows, cmd: c, from, to, args: true };
  }

  private valuesOf(c: Command): Row[] {
    switch (c.name) {
      case 'probe':
        return PROBE_IDS.map((id) => ({ ...valueRow(c, id, inGlyphs(PROBES[id].about)), right: inGlyphs(PROBES[id].cost), cost: `costs the device: ${inGlyphs(PROBES[id].cost)}` }));
      case 'keys':
        return KEYS.map((k) => ({ ...valueRow(c, k.id, k.id === 'up' || k.id === 'down' || k.id === 'left' || k.id === 'right' ? G[k.id] : k.label), more: true }));
      case 'capture':
        // Lengths to pick, the longest first. Enter runs the length typed, not one that starts with it
        // (1 isn't 10), one moved to, and with neither the default, so enter twice is a 10 s capture.
        return ['10', '5', '3'].map((n) => ({ ...valueRow(c, n, 'seconds'), hint: true }));
      case 'trial':
        this.files ??= trialFiles(this.o.cwd ?? process.cwd());
        return this.files.map((f) => valueRow(c, f, ''));
      case 'try':
        return [
          ...TOGGLES.map((t) => valueRow(c, t.name, t.brief)),
          // Your own css, js or markup: enter waits for it.
          ...OWN.map((o) => {
            const word = o.name.split(' ')[0]!;
            return word === 'codec' ? valueRow(c, word, o.brief) : { ...valueRow(c, word, o.brief), more: true, waits: true };
          }),
        ];
      case 'replay':
        // Enter alone lists the tapes; a tape is played once it is moved to or typed.
        return [{ ...valueRow(c, 'save', 'keep the presses the device just saw'), more: true, waits: true, hint: true }, ...listTapes().map((t) => ({ ...valueRow(c, t.name, `${t.steps} presses${sp()}${t.model}`), hint: true }))];
      case 'shim':
        return [
          { ...valueRow(c, 'on', 'fill in what the engine lacks, and reload'), hint: true },
          { ...valueRow(c, 'off', 'pages load without it, and reload'), hint: true },
        ];
    }
    return [];
  }

  /**
   * The row Enter takes: the highlighted one, unless it is a guess, a hint nobody moved to or typed,
   * or words follow the one it would complete (the caret was moved back into the line), when Enter
   * runs the line as typed.
   */
  private taken(sug: Suggestions): Row | undefined {
    const r = highlighted(sug.rows, this.pick);
    if (!r || r.kind === 'empty' || r.guess || this.input.slice(sug.to).trim()) return undefined;
    return r.hint && this.pick === 0 && r.value !== this.input.slice(sug.from, sug.to) ? undefined : r;
  }

  /** Puts a row in place of the word it completes; a recent line, in place of the empty line. */
  private complete(r: Row, sug: Suggestions) {
    const s = this.input;
    const rest = s.slice(sug.to);
    const text = r.value + (r.more && !rest.startsWith(' ') ? ' ' : '');
    this.edit(s.slice(0, sug.from) + text + rest, sug.from + text.length);
  }

  /**
   * Enter: a command that takes words is completed and waits for them; otherwise the highlighted
   * completion is taken, and the line is checked and run. A line that won't run stays, with why.
   */
  private enter() {
    const sug = this.suggest();
    // A letter alone, with its entry highlighted, runs the entry with its defaults: c is a 10 s capture.
    const hot = this.input.length === 1 ? HOTKEYS.get(this.input.toLowerCase()) : undefined;
    if (hot && highlighted(sug.rows, this.pick)?.name === hot.name && hot.name !== 'probe' && hot.name !== 'try') {
      const dut = this.target();
      const fail = dut ? this.act(hot, dut) : this.noDut();
      this.closePalette();
      return fail ? this.tell(fail) : this.render();
    }
    const r = this.taken(sug);
    if (r) {
      this.complete(r, sug);
      if (r.waits) return this.render();
    }
    const line = this.input.trim();
    if (!line) {
      this.closePalette();
      return this.render();
    }
    this.run(line);
  }

  /** Checks a line and runs it; one that won't run stays in the input, with why. */
  private run(line: string): void {
    // A port, an address or a folder: the app to serve from now on.
    if (this.o.connect && isApp(line)) {
      this.closePalette();
      this.render();
      void this.o.connect(line).then((why) => {
        if (!why || this.closed) return;
        // Typed again where it was, with why, unless something else was typed since.
        if (!this.input) this.edit(line, line.length);
        this.fail(why);
      });
      return;
    }
    const { name, pos, flags } = parseQ(splitWords(line));
    // A command copied with q's own flags still runs here.
    delete flags.json;
    delete flags.port;
    const e = entry(name);
    if (!e) {
      // Not a command: a toggle or a codec by its name is tried (hevc is a codec, not a typo of hear),
      // a near miss is asked about, and plain words ask the guide.
      if (TOGGLES.some((t) => t.name === name.toLowerCase()) || CODEC_WORDS.test(name)) return this.run(`try ${line}`);
      const near = nearest(name, MENU.map((x) => x.name));
      if (near) return this.fail(`no command ${name}${sp()}did you mean ${near}?`);
      return this.fail(`no command ${name}${sp()}the list has them all`);
    }
    if (!e.cmd) {
      // remote, devtools, reload: no words to take, and done at once on the device keys act on.
      if (pos.length) return this.fail(`${e.name} takes no word "${pos[0]}"`);
      if (flags.id && !this.find(flags.id)) return this.fail(`no device ${flags.id}${sp()}connected: ${this.duts().map((t) => t.id).join(', ') || 'none'}`);
      const dut = flags.id ? this.find(flags.id) : this.target();
      if (!dut) return this.fail(this.noDut());
      // Remote mode is on the selected device, so naming another selects it.
      if (e.name === 'remote') this.selected = dut.id;
      this.closePalette();
      this.act(e, dut);
      return this.render();
    }
    const c = e.cmd;
    let args: Args;
    try {
      args = argsFromWords(c, pos, flags);
    } catch (e) {
      return this.fail(firstLine(e));
    }
    const onDut = !c.local && c.name !== 'status' && c.name !== 'devices';
    // A mistyped id is an input error: the line stays, with the ids there are.
    if (onDut && flags.id && !this.find(flags.id)) return this.fail(`no device ${flags.id}${sp()}connected: ${this.duts().map((t) => t.id).join(', ') || 'none'}`);
    const id = flags.id || (onDut ? this.target()?.id : undefined);
    if (onDut && !id) return this.fail(this.noDut());
    const clash = (c.name === 'capture' || c.name === 'trial' || c.name === 'try' || c.name === 'replay') && id ? this.clash(id, c.name) : null;
    if (clash) return this.fail(clash);
    this.closePalette();
    this.render();
    void this.perform(c, args, id, line);
  }

  private fail(why: string) {
    this.error = why;
    this.render();
  }
}

// ---- Helpers ----------------------------------------------------------------------------------------

type RequestEvent = Extract<ServerEvent, { type: 'request' }>;

/** A head and as many parts as fit the width, separated by gaps; from the first that doesn't fit, the rest are left off. */
export function fit(head: string, parts: string[], cols: number, gap = '   '): string {
  let s = head;
  for (const part of parts) {
    if (width(s) + gap.length + width(part) > cols - 1) break;
    s += gap + part;
  }
  return truncate(s, cols - 1);
}

/** Left and right on one line of width `w`, the right dropped when there is no room for it. */
function spread(left: string, right: string, w: number): string {
  const room = w - width(left) - width(right);
  return right && room >= 2 ? left + ' '.repeat(room) + right : truncate(left, w);
}

/** The separator between parts of a line, in the glyphs in use. */
const sp = () => ` ${G.sep} `;
/** ↑↓ as one key, or up/down where arrows are words. */
const ud = () => (G.up.length > 1 ? `${G.up}/${G.down}` : G.up + G.down);
const pct = (share: number) => `${Math.round(share * 100)}%`;
const sec = (ms: number, digits: number) => `${Number((ms / 1000).toFixed(digits))} s`;
const dur = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : ms < 10_000 ? sec(ms, 1) : elapsed(ms));
const elapsed = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
};
const clock = (at: number) => {
  const d = new Date(at);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
};
/** The clock time something ran, hh:mm: it stays put, where "3m ago" counts up as if still running. */
const hm = (at: number) => clock(at).slice(0, 5);
const firstLine = (e: unknown) => (e as Error).message.split('\n')[0]!;

/** What a device's card shows of its screen and cores, read once per kind of device. */
interface Specs {
  screen?: string;
  dpr?: number;
  cores?: number | null;
  memoryGB?: number | null;
}
const sentence = (s: string) => s.replace(/\.$/, '');

/** A user agent's platform and engine, as describeUa names them. */
function uaParts(ua: string): [string, string] {
  const [platform, engine] = describeUa(ua).split(' · ');
  return [truncate(platform ?? '', 16), engine ?? ''];
}

function originOf(href: string): string {
  try {
    return new URL(href).origin;
  } catch {
    return '';
  }
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

/** The caret one character back or forward, a surrogate pair being one. */
const back = (s: string, at: number) => (at >= 2 && /[\udc00-\udfff]/.test(s[at - 1]!) && /[\ud800-\udbff]/.test(s[at - 2]!) ? at - 2 : Math.max(0, at - 1));
const forward = (s: string, at: number) => (at < s.length - 1 && /[\ud800-\udbff]/.test(s[at]!) ? at + 2 : Math.min(s.length, at + 1));

/** Where the word before the caret starts, with the spaces after it: what ctrl+w takes. */
const wordStart = (s: string, at: number) => s.slice(0, at).replace(/\S*\s*$/, '').length;

/** The highlighted row; the list may have shrunk under it. */
const highlighted = (rows: Row[], pick: number): Row | undefined => rows[Math.min(pick, rows.length - 1)];

/**
 * The row that is the text, then those that start with it, then those that contain it, then any the
 * extra test passes; stable within each. The exact one first, so 'device' isn't taken as 'devices'.
 */
function rank(rows: Row[], word: string, extra: (r: Row) => boolean = () => false): Row[] {
  const name = (r: Row) => r.value.toLowerCase();
  const a = [...rows.filter((r) => name(r) === word), ...rows.filter((r) => name(r) !== word && name(r).startsWith(word))];
  const b = rows.filter((r) => !name(r).startsWith(word) && name(r).includes(word));
  const c = rows.filter((r) => !name(r).includes(word) && extra(r));
  return [...a, ...b, ...c];
}

/** The list's entry a row stands for: a command's own, or try for a toggle's line. */
const entryOf = (r: Row): string | undefined => (r.kind === 'command' ? (entry(r.name)?.name ?? r.cmd?.name) : undefined);

/** What enter does on the highlighted entry, for the input's hint. */
function enterSays(name: string): string {
  if (isGroup(name)) return `enter opens ${name.slice(GROUP.length)}`;
  switch (name) {
    case 'capture':
      return `enter captures ${CAPTURE_S} s`;
    case 'remote':
      return 'enter drives the device';
    case 'probe':
      return 'enter picks a probe';
    case 'try':
      return 'enter picks what to try';
    case 'keys':
      return 'enter picks keys';
    case 'trial':
      return 'enter picks a trial file';
    case 'replay':
      return 'enter lists the tapes';
    case 'shim':
      return 'enter says what it fills';
    case 'eval':
      return 'enter, then type ES5';
  }
  return `enter runs ${name}`;
}

/** What the three entries a person does by hand do, for the right side. */
const REMOTE_ABOUT: Record<string, string> = {
  remote: "The keyboard becomes the device's remote: arrows move, enter is OK and clicks a focused button as a real OK does, backspace is back, digits are digits. The page's answer to each press shows here, and so do presses on the device's own remote, named: a key it sends differently (gamepad A from a controller) is sent from then on. m maps a key by hand.",
  devtools: 'Opens Chrome DevTools for the device in your browser: console, elements, network and sources, through the inspector teleport loads while DevTools is open.',
  reload: "Reloads the device's page.",
};

/** A press as a person reads it: its key and code, `GamepadA 195`. */
const pressWords = (x: Press) => [x.key, String(x.keyCode)].filter(Boolean).join(' ');

const entryRow = (e: Entry): Row => ({
  kind: 'command',
  name: e.name,
  brief: inGlyphs(e.brief),
  // Only the words it takes: its flags are listed once a - is typed.
  right: e.cmd ? e.cmd.params.filter((p) => p.positional).map(paramForm).join(' ') : '',
  key: e.key,
  value: e.name,
  cmd: e.cmd ?? null,
  more: !!e.cmd && e.cmd.params.length > 0,
  // Enter waits for a word only where one is needed or there are some to pick; survey just runs.
  waits: !!e.cmd && e.cmd.params.some((p) => p.positional && (p.required || PICKS.has(e.name))),
  cost: e.cmd ? undefined : `costs the device: ${e.cost}`,
});

/** Commands whose word is picked from a list the palette shows (valuesOf). */
const PICKS = new Set(['probe', 'keys', 'capture', 'trial', 'try', 'replay', 'shim']);

/** A toggle by its own name, as the line that tries it. */
const toggleRow = (t: Toggle): Row => ({ kind: 'command', name: `try ${t.name}`, brief: t.brief, right: '', value: `try ${t.name}`, cmd: COMMANDS.find((c) => c.name === 'try') ?? null, more: false, waits: false });


const valueRow = (c: Command, value: string, brief: string): Row => ({ kind: 'value', name: value, brief, right: '', value, cmd: c, more: false, waits: false });

const emptyRow = (text: string): Row => ({ kind: 'empty', name: text, brief: '', right: '', value: '', cmd: null, more: false, waits: false });

const kebab = (s: string) => s.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);

/** The command's own flags, and --id; one that takes a value waits for it. */
function flagRows(c: Command): Row[] {
  const flags = c.params.filter((x) => !x.positional).map((x) => ({ ...valueRow(c, `--${kebab(x.name)}`, sentence(x.help)), more: x.type !== 'boolean', waits: x.type !== 'boolean' }));
  return [...flags, { ...valueRow(c, '--id', 'which device, by its id'), more: true, waits: true }];
}

function takesValue(c: Command, flag: string): boolean {
  if (flag === '--id') return true;
  const x = c.params.find((q) => `--${kebab(q.name)}` === flag);
  return !!x && x.type !== 'boolean';
}

/** Whether the words typed already fill the command's positional parameters. */
function positionalsFull(c: Command, typed: string): boolean {
  const pos = c.params.find((x) => x.positional);
  if (!pos) return true;
  if (pos.positional === 'rest') return false;
  const words = typed.split(' ').filter(Boolean);
  let n = 0;
  for (let i = 0; i < words.length; i++) {
    if (words[i]!.startsWith('--')) {
      if (takesValue(c, words[i]!)) i++;
    } else n++;
  }
  return n > 0;
}

/** The cost line: what running it costs the device, before it runs. */
function costOf(c: Command): string {
  if (c.local) return 'answered here; needs no device';
  return c.cost ? `costs the device: ${inGlyphs(c.cost)}` : 'free on the device: answered from what this laptop has';
}

/**
 * Whether a line names an app rather than a command: a port (5173, :5173), an address (http://…,
 * host:port, app.example.com) or a folder (./dist, ../site, /abs, ~/x). One word only, so plain words
 * still ask the guide.
 */
export function isApp(line: string): boolean {
  const s = line.trim();
  if (/\s/.test(s)) return false;
  return /^:?\d{2,5}$/.test(s) || /^https?:\/\/\S+$/i.test(s) || /^[\w.-]+:\d{2,5}(\/\S*)?$/.test(s) || /^[\w-]+(\.[\w-]+)*\.[a-z]{2,}(\/\S*)?$/i.test(s) || /^(\.{1,2}|~)?\//.test(s);
}

/** The app as the input's row names it: localhost:5173 for a port. */
const appName = (s: string) => (/^:?\d{2,5}$/.test(s.trim()) ? `localhost:${s.trim().replace(':', '')}` : s.trim());

/** Shell-like words: spaces split, quotes group. */
export function splitWords(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]!);
  return out;
}

/**
 * Trial files under the folder, two levels deep, for completion: only paths that say trial, since
 * running one imports it into tlpt, and a build or deploy script must never be a row Enter runs. A
 * path typed in full still runs.
 */
function trialFiles(cwd: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (n.startsWith('.') || n === 'node_modules' || out.length >= 50) continue;
      const f = join(dir, n);
      let st;
      try {
        st = statSync(f);
      } catch {
        continue;
      }
      if (st.isDirectory() && depth > 0) walk(f, depth - 1);
      else if (/\.(mjs|json)$/.test(n) && !/package(-lock)?\.json$|tsconfig/.test(n) && /trial/i.test(relative(cwd, f))) out.push(relative(cwd, f));
    }
  };
  walk(cwd, 2);
  return out;
}
