import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyTimeline } from '../src/analyze.js';
import type { PageError } from '../src/errors.js';
import { Console, fit, isApp, splitWords, type DevtoolsNote, type DutSource } from '../src/console.js';
import { humanize } from '../src/format.js';
import type { Point } from '../src/live.js';
import { GROUPS, MENU } from '../src/menu.js';
import { COMMANDS, runData } from '../src/q.js';
import { PlainScreen, type Key, type Screen } from '../src/term.js';
import { strip, width } from '../src/text.js';
import { setGlyphs, type Color } from '../src/tui.js';

// The console's commands go through runData, and their answers through humanize, which format.ts
// owns; both are stubbed per test, so these tests say what the console does, not what an answer reads.
vi.mock('../src/q.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/q.js')>()), runData: vi.fn() }));
vi.mock('../src/format.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/format.js')>();
  return { ...real, humanize: vi.fn(() => ['● answer']) };
});
const run = vi.mocked(runData);
const answer = vi.mocked(humanize);

const T0 = new Date(2026, 10, 9, 14, 2, 11).getTime();
const ARM = 'Mozilla/5.0 (X11; Linux armv7l) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/63.0.3239.84 Safari/537.36';
const ARM64 = 'Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/53.0.2785.34 Safari/537.36';
const HREF = 'http://192.168.1.20:7070/';
const LINK = 'http://192.168.1.20:7070/';

const point = (t: number, o: Partial<Point> = {}): Point => ({
  t, overheadPct: 0.05, lagMs: 0, longTaskMs: 0, longTasks: 0, heapMB: 212, heapTotalMB: 250, videoDroppedPerS: null, videoDecodedPerS: null,
  resources: 0, resourceKB: 0, keys: 0, keyToFrameMs: null, fps: null, frameP95Ms: null, wireBytes: 90, agentQueuedKB: 0, inspectorQueuedKB: null,
  inspectorPct: null, level: 0, heapLimitMB: 512, domNodes: 400, devtoolsLagMs: null, ...o,
});

interface DutFixture {
  ua?: string;
  ip?: string;
  /** Per-second samples, oldest first, ending now. */
  points?: Partial<Point>[];
  /** The last press: its key code, key → frame, and how long before the last sample. */
  press?: { code: number; ms: number; ago?: number; handlers?: number; target?: string };
  /** ms before now of the last frame. */
  silent?: number;
  devtools?: number;
  cdp?: boolean;
  governor?: number;
  errors?: number;
  rtt?: number | null;
}

function dut(id: string, f: DutFixture = {}): DutSource {
  const pts = (f.points ?? [{}]).map((o, i, a) => point((i - a.length + 1) * 1000 + 100_000, o));
  const tl = emptyTimeline();
  const names: string[] = [];
  if (f.press) {
    const t = pts.at(-1)!.t - (f.press.ago ?? 0);
    Object.assign(tl.input!, { t: [t], keyCode: [f.press.code], toFrameMs: [f.press.ms], delayMs: [1] });
    if (f.press.handlers !== undefined) Object.assign(tl.keyphase!, { t: [t], inputDelay: [1], handlers: [f.press.handlers], waitFrame: [1], raf: [1], style: [1], layout: [1], paint: [1] });
    if (f.press.target) {
      names.push(f.press.target);
      Object.assign(tl.keytarget!, { t: [t], target: [0], landing: [65535], x: [0], y: [0], w: [1], h: [1], moved: [1] });
    }
  }
  return {
    id,
    ua: f.ua ?? ARM,
    ip: f.ip ?? '192.168.1.42',
    href: HREF,
    clients: { size: f.devtools ?? 0 },
    cdp: f.cdp || f.devtools ? {} : null,
    governor: { level: f.governor ?? 0, reason: '' },
    errors: { total: f.errors ?? 0 },
    session: { points: pts, timeline: tl, lastFrameAt: T0 - (f.silent ?? 0), meta: { rttMs: f.rtt === undefined ? 12 : f.rtt, names } },
  };
}

interface Options {
  cols?: number;
  rows?: number;
  color?: Color;
  interactive?: boolean;
  note?: DevtoolsNote;
  link?: string | null;
  /** Use Date.now, for fake timers. */
  realClock?: boolean;
  appless?: boolean;
  connect?: (what: string) => Promise<string | null>;
}

const open: Console[] = [];
afterEach(() => {
  for (const c of open.splice(0)) c.close();
  vi.useRealTimers();
});
beforeEach(() => {
  run.mockReset();
  answer.mockClear();
});

function harness(duts: DutSource[] = [], o: Options = {}) {
  const printed: string[] = [];
  let tail = 0;
  let mark = 0;
  let raw: string[] = [];
  const scrolls: number[] = [];
  const keyFns: ((k: Key) => void)[] = [];
  const screen: Screen = {
    cols: o.cols ?? 100,
    rows: o.rows ?? 30,
    interactive: o.interactive ?? true,
    print: (l) => {
      printed.push(...l);
      tail = l.length;
      return ++mark;
    },
    amend: (m, l) => {
      if (m !== mark) return false;
      printed.splice(printed.length - tail, tail, ...l);
      tail = l.length;
      return true;
    },
    pin: () => {},
    scroll: (pages) => scrolls.push(pages),
    live: (l) => (raw = l),
    onKey: (fn) => keyFns.push(fn),
    onResize: () => {},
    close: () => {},
  };
  let t = T0;
  const calls: string[] = [];
  const con = new Console({
    screen,
    color: o.color ?? 'none',
    port: 7070,
    key: 'Kq3xT9b2Lm',
    duts: () => duts,
    dutLink: o.link === undefined ? LINK : o.link,
    lan: '192.168.1.20:7070',
    cwd: process.cwd(),
    devtoolsNote: () => o.note,
    appless: o.appless,
    connect: o.connect,
    now: o.realClock ? undefined : () => t,
    openDevtools: (id) => calls.push(`devtools ${id}`),
    reload: (id) => calls.push(`reload ${id}`),
    quit: () => calls.push('quit'),
  });
  open.push(con);
  const key = (name: string, k: Partial<Key> = {}) => keyFns.forEach((fn) => fn({ name, text: '', ctrl: false, meta: false, shift: false, ...k }));
  const h = {
    con,
    duts,
    calls,
    screen,
    scrolls,
    /** What was printed into scrollback, without colour. */
    printed: () => printed.map(strip),
    rawPrinted: () => printed,
    live: () => raw.map(strip),
    raw: () => raw,
    key,
    type: (text: string) => [...text].forEach((ch) => key(ch === ' ' ? 'space' : ch.toLowerCase(), { text: ch })),
    /** A letter alone, then Enter: its entry with its defaults. */
    hot: (ch: string) => {
      key(ch, { text: ch });
      key('return');
    },
    paste: (text: string) => key('paste', { text }),
    ctrl: (name: string) => key(name, { ctrl: true }),
    advance: (ms: number) => (t += ms),
    /** Every device sends a sample. */
    sample: () => duts.forEach((x) => con.event({ type: 'sample', id: x.id })),
    connect: (x: DutSource) => con.event({ type: 'page', id: x.id, kind: 'new', href: x.href, ua: x.ua, ip: x.ip }),
    /** The device rows and the input, under the list. */
    rows: () => below(raw).map(strip),
    rowsRaw: () => below(raw),
    /** The right side: the highlighted entry opened up, each line trimmed. */
    side: () => {
      const r = sides(raw).map((l) => l.right);
      while (r.length && !r[r.length - 1]) r.pop();
      return r;
    },
    /** The list on the left, each line trimmed. */
    list: () => sides(raw).map((l) => l.left),
    /** The highlighted entry's name. */
    at: () => sides(raw).map((l) => /^\s*[›>]\s+(?:\S\s+)?(\S+)/.exec(l.left)?.[1]).find(Boolean),
    /** The value highlighted on the right, while a command's word is typed. */
    picked: () => sides(raw).map((l) => /^[›>] (\S+)/.exec(l.right)?.[1]).find(Boolean),
  };
  return h;
}

/** Where the list's bottom rule is: the lines under it are the device rows and the input. */
const ruleAt = (lines: string[]) => lines.map(strip).findLastIndex((l) => /^[─-]+[┴+][─-]*$/.test(l));
const below = (lines: string[]) => lines.slice(ruleAt(lines) + 1);
/** The two columns between the rules, split at the divider. */
const sides = (lines: string[]) => {
  const plain = lines.map(strip);
  const top = plain.findIndex((l) => /^[─-]+[┬+][─-]*$/.test(l));
  return plain.slice(top + 1, ruleAt(lines)).map((l) => {
    const at = l.search(/ [│|] /);
    return { left: l.slice(0, at).trimEnd(), right: l.slice(at + 3).trimEnd() };
  });
};

/** What the input line says after what is typed: a mistake, a notice or the keys, without the device at the right. */
const info = (h: ReturnType<typeof harness>) => h.rows().at(-1)!.replace(/ {3,}(on (?:[●*] )?\S+|(?:[○o] )?no device yet)$/, '');

/** The input at 100 columns with nothing typed and capture highlighted. */
const BAR = '  > _  ↑↓ pick · enter captures 10 s · ? help';

const settle = () => new Promise((r) => setTimeout(r, 0));

/** Two devices as in the design's mockup (b): k3x9q2ab fine with DevTools open, p7m2d4cf struggling. */
function mockupDuts() {
  const fine = dut('k3x9q2ab', { points: Array.from({ length: 32 }, (_, i) => ({ lagMs: [2, 2, 12, 2, 2, 2, 2, 2, 2, 30, 2, 2, 2, 2, 2, 0][i % 16]!, fps: 58 })), press: { code: 40, ms: 41, ago: 2000 }, devtools: 1 });
  // The heap's floor rises 2.13 MB a minute to 446 of 512 MB: full in about 31 minutes.
  const struggling = dut('p7m2d4cf', {
    ua: ARM64,
    ip: '192.168.1.43',
    points: Array.from({ length: 120 }, (_, i) => ({ lagMs: [180, 340, 640, 420, 90, 560, 640, 640, 180, 420, 640, 560, 340, 420, 640, 340][i % 16]!, heapMB: 446 - ((119 - i) / 60) * 2.13 })),
    press: { code: 40, ms: 180, ago: 3000 },
  });
  return [fine, struggling];
}

describe('the live region', () => {
  it('draws the mockup at 100 columns: the groups on the left, the first open, the highlighted entry on the right, a row per device, the input', () => {
    const duts = mockupDuts();
    const h = harness(duts, { rows: 40 });
    duts.forEach(h.connect);
    h.sample();
    const live = h.live();
    expect(live[0]).toBe('─'.repeat(31) + '┬' + '─'.repeat(67));
    // The five groups, the first open with its entries and their letters; its first is highlighted, and the right side opens it.
    expect(h.list().filter(Boolean)).toEqual([
      '  measure',
      '  › c capture',
      '    s survey',
      '    p probe',
      '      styles',
      '      advise',
      '      report',
      '    h history',
      '  experiment   t',
      '  video',
      // Beside a closed group, what needs a look in it: the last key pressed on the device, DevTools open.
      '  input        ↓',
      '  inspect      DevTools open',
    ]);
    expect(h.at()).toBe('capture');
    expect(h.side()[0]).toMatch(/^capture {2}fps and key → frame +on k3x9q2ab$/);
    const [a, b, foot] = h.rows();
    // The engine is the first cell to go: the row would be 105 wide with it.
    expect(a).toMatch(/^› ● k3x9q2ab Linux {3}main .{16} {3}0 ms {3}heap 212\/512 MB {3}key ↓ 41 ms {3}DevTools$/);
    expect(b).toMatch(/^ {2}● p7m2d4cf Linux {3}main .{16} 640 ms {3}heap 446\/512 MB {3}full in 31 min {3}key ↓ 180 ms$/);
    expect(foot).toMatch(/^ {2}> _ {2}↑↓ pick · enter captures 10 s · \? help +on ● k3x9q2ab$/);
    expect(h.rows()).toHaveLength(3);
  });

  it('keeps the wide row for 100 columns: below, 8 bars, no platform and 2-space gaps leave room for key and the alerts', () => {
    const duts = mockupDuts();
    const h80 = harness(duts, { cols: 80 });
    duts.forEach(h80.connect);
    h80.sample();
    expect(h80.rows()[0]).toMatch(/^› ● k3x9q2ab {2}main .{8} {3}0 ms {2}heap 212\/512 MB {2}key ↓ 41 ms {2}DevTools$/);
    expect(h80.rows()[1]).toMatch(/^ {2}● p7m2d4cf {2}main .{8} 640 ms {2}heap 446\/512 MB {2}full in 31 min$/);
    expect(info(h80)).toBe(BAR);
    h80.type('?');
    expect(h80.side()).toContainEqual(expect.stringMatching(/^main {5}main thread blocked/));
    // Narrower, the list drops its group labels and the input its help hint.
    const h60 = harness(duts, { cols: 60 });
    duts.forEach(h60.connect);
    h60.sample();
    const [a, b, bar] = h60.rows();
    expect(a).toMatch(/^› ● k3x9q2ab {2}main .{8} {3}0 ms {2}heap 212\/512 MB$/);
    expect(b).toMatch(/^ {2}● p7m2d4cf {2}main .{8} 640 ms {2}heap 446\/512 MB$/);
    expect(bar).toMatch(/^ {2}> _ {2}↑↓ pick · enter captures 10 s/);
    expect(h60.list().slice(0, 2)).toEqual(['  measure', ' › c capture']);
  });

  it('colours a device by its state, green only on the dot: green while sampling, amber at 3 s silent, red at 10 s', () => {
    const red = '\x1b[38;2;240;110;90m';
    const amber = '\x1b[38;2;242;173;72m';
    const green = '38;2;120;200;140';
    const duts = [dut('ab12', { points: [{ lagMs: 300 }] }), dut('cd34', { silent: 4000 }), dut('ef56', { silent: 12_000 })];
    const h = harness(duts, { color: 'truecolor' });
    h.sample();
    const [a, b, c] = h.rowsRaw();
    expect(a).toContain(`${red}300 ms`);
    expect(strip(b!)).toContain('no sample for 4 s');
    expect(b).toContain(`${amber}●`);
    expect(c).toContain(`${red}●`);
    expect(strip(c!)).toContain('no sample for 12 s');
    expect(a).toContain(`\x1b[${green}m●`);
    // Green says a state at a glance; a number within its limits stays ink.
    for (const after of h.raw().join('').split(`\x1b[${green}m`).slice(1)) expect(after.startsWith('●')).toBe(true);
  });

  it('tones the main number by the last second, which it is, and the spark by the window', () => {
    const red = '\x1b[38;2;240;110;90m';
    const duts = [dut('ab12', { points: [...Array.from({ length: 12 }, () => ({})), { lagMs: 401 }, {}, {}, {}] })];
    const h = harness(duts, { color: 'truecolor' });
    h.sample();
    expect(h.rowsRaw()[0]).toContain(red);
    expect(h.rowsRaw()[0]).not.toContain(`${red}0 ms`);
    // With no spark, the number is all there is of the window.
    const narrow = harness(duts, { color: 'truecolor', cols: 40 });
    narrow.sample();
    expect(narrow.rowsRaw()[0]).toContain(`${red}0 ms`);
  });

  it('says what a device is waiting for, and shows the alert cells only when something is wrong', () => {
    const duts = [
      dut('ab12', { points: [] }),
      dut('cd34', { rtt: 180, devtools: 2, governor: 1, points: [{ agentQueuedKB: 80, devtoolsLagMs: 2000 }] }),
      dut('ef56', { cdp: true, points: [{ videoDecodedPerS: 25, videoDroppedPerS: 6 }] }),
      dut('gh78', { rtt: 40, points: [{ heapMB: null }] }),
    ];
    duts[0]!.session.lastFrameAt = 0;
    const h = harness(duts, { cols: 200, rows: 40 });
    h.sample();
    const [a, b, c, d] = h.rows();
    expect(a).toContain('waiting for its first sample');
    expect(b).toContain('inspector shedding   DevTools 2 s behind   rtt 180 ms · backlog 80 KB   DevTools ×2   Chrome 63');
    expect(c).toContain('video 6 dropped/s   inspector on');
    expect(d).not.toMatch(/rtt|heap|DevTools|inspector/);
  });

  it('shows the last key while fresh, faint after 10 s, and not after a minute', () => {
    const shown = (ago: number) => {
      const h = harness([dut('ab12', { press: { code: 39, ms: 120, ago } })], { color: 'truecolor' });
      h.sample();
      return h.rowsRaw()[0]!;
    };
    expect(shown(1000)).toContain('\x1b[38;2;240;110;90m120 ms');
    expect(strip(shown(20_000))).toContain('key right 120 ms');
    expect(shown(20_000)).not.toContain('\x1b[38;2;240;110;90m120 ms');
    expect(strip(shown(61_000))).not.toContain('key');
  });

  it('names a key a device sends of its own: gamepad A is ok, and a code nobody knows is its number', () => {
    const shown = (code: number) => {
      const h = harness([dut('ab12', { press: { code, ms: 40 } })]);
      h.sample();
      return h.rows()[0]!;
    };
    expect(shown(195)).toContain('key ok 40 ms');
    expect(shown(27)).toContain('key back 40 ms');
    expect(shown(4321)).toContain('key #4321 40 ms');
  });

  it('waits for a device with its link, then after a quiet minute says what may be wrong', () => {
    const h = harness();
    expect(h.rows()[0]).toBe('  ○ waiting for a device   open http://192.168.1.20:7070/ on it');
    expect(info(h)).toBe(BAR);
    h.advance(60_000);
    h.con.render();
    expect(h.rows()[0]).toBe('  ○ nothing has opened the link yet   http://192.168.1.20:7070/ · same network? port 7070?');
    h.con.event({ type: 'request', id: null, ip: '192.168.1.42', method: 'GET', url: HREF, status: 200, ms: 3, document: true });
    expect(h.rows()[0]).toContain('open http://192.168.1.20:7070/ on it');
    const app = harness([], { link: null });
    expect(app.rows()[0]).toBe("  ○ waiting for a device   in your app: teleport.init({ url: 'ws://192.168.1.20:7070/ws/target' })");
    const piped = harness([], { interactive: false });
    expect(piped.live().at(-1)).toBe('  keys need a terminal on stdin · tlpt <command> works from another shell');
  });

  it('collapses the devices that do not fit, keeping the selected one', () => {
    const duts = ['aa', 'bb', 'cc', 'dd', 'ee', 'ff'].map((id) => dut(id));
    const h = harness(duts, { rows: 14 });
    duts.forEach(h.connect);
    h.key('tab', { shift: true });
    h.key('tab', { shift: true });
    const live = h.live();
    expect(live.length).toBeLessThanOrEqual(13);
    expect(live).toContain('  + 3 more devices · tab picks one');
    expect(live.some((l) => l.startsWith('› ● ee'))).toBe(true);
  });

  it('draws in ASCII where the terminal lacks the glyphs', () => {
    setGlyphs(true);
    try {
      const duts = [dut('ab12', { devtools: 2 }), dut('cd34')];
      const h = harness(duts);
      duts.forEach(h.connect);
      h.sample();
      expect(h.live()[0]).toBe('-'.repeat(31) + '+' + '-'.repeat(67));
      expect(h.list().slice(0, 2)).toEqual(['  measure', '  > c capture']);
      expect(h.rows()[0]).toMatch(/^> \* ab12 Linux {3}main .* {3}DevTools x2 {3}Chrome 63$/);
      expect(info(h)).toBe('  > _  up/down pick - enter captures 10 s - ? help');
      expect(h.printed()[0]).toBe('* ab12 connected - Linux - Chrome 63 - 192.168.1.42');
      // The ? side's key column fits 'up/down'.
      h.type('?');
      expect(h.side()).toContainEqual(expect.stringMatching(/^up\/down {2}move through the list/));
      h.key('escape');
      // The values' briefs and costs in ASCII too.
      h.type('probe med');
      expect(h.side().at(-1)).toMatch(/^costs the device: isTypeSupported and/);
    } finally {
      setGlyphs(false);
    }
  });

  it('shows what runs as a portal beside its entry, and opens it on the right as a beam', () => {
    const h = harness([dut('ab12')]);
    for (const what of ['probe dom', 'eval 1', 'keys ok']) h.con.event({ type: 'call', id: 'ab12', by: 'q', what, phase: 'start' });
    // In the open group, the entry; a closed group carries the mark for what runs in it.
    const marked = h.list().filter((l) => /[◌○◎◉]/.test(l)).map((l) => l.replace(/[◌○◎◉].*$/, '').trim());
    expect(marked).toEqual(['p probe', 'experiment', 'input']);
    h.type('probe');
    expect(h.side()).toEqual(expect.arrayContaining([expect.stringMatching(/^◎[━┈·✦✧]+[◌○◎◉] {2}0 s$/), 'q probe dom · on ab12']));
  });

  it('never draws a line wider than the terminal, nor more lines than it has, CJK text included', () => {
    for (const color of ['none', 'truecolor'] as const) {
      for (const cols of [100, 80, 60, 50, 40]) {
        for (const rows of [30, 12]) {
          const duts = [...mockupDuts(), dut('漢字テレビ', { ua: 'テレビ ブラウザ', press: { code: 13, ms: 700, handlers: 650, target: 'div.ボタン in #メニュー一覧の中の要素' }, points: [{ keys: 1, keyToFrameMs: 700 }] })];
          const h = harness(duts, { cols, rows, color });
          const check = () => {
            expect(h.raw().length).toBeLessThanOrEqual(rows - 1);
            for (const l of h.raw()) expect(width(l), `${cols}x${rows} ${color}: ${strip(l)}`).toBeLessThanOrEqual(cols - 1);
          };
          duts.forEach(h.connect);
          h.sample();
          h.con.event({ type: 'call', id: 'k3x9q2ab', by: 'mcp', what: 'eval document.querySelector("#メニュー").textContent', phase: 'start' });
          h.con.event({ type: 'trial', id: 'p7m2d4cf', by: 'q', name: '焦点リングの比較と測定', done: 3, total: 15, phase: 'start' });
          h.con.event({ type: 'gone', id: 'p7m2d4cf', waiting: true });
          check();
          h.type('?');
          check();
          h.key('escape');
          h.type('/');
          check();
          h.paste('eval "日本語のテキストを長く長く長く長く長く長く長く長く長く長く長く長く長く長く長く長く長く長く長く".length');
          check();
          h.key('home');
          check();
          h.ctrl('u');
          h.paste('probe ');
          check();
          h.key('escape');
          h.hot('r');
          h.key('right');
          check();
          // But a DevTools link, printed whole for the terminal to wrap: a cut one can't be copied.
          for (const l of h.rawPrinted()) if (!strip(l).includes('/__teleport/Kq3xT9b2Lm/d/')) expect(width(l), `${cols}: ${strip(l)}`).toBeLessThanOrEqual(cols - 1);
        }
      }
    }
  });
});

describe('the events above the region', () => {
  it('says a device connected, where it is, and where its DevTools is', () => {
    const say = (note: DevtoolsNote | undefined, interactive = true) => {
      const h = harness([], { note, interactive });
      h.connect(dut('k3x9q2ab'));
      return h.printed();
    };
    // The link even then: when no browser opens after all, it is the way in.
    expect(say('opened')).toEqual(['● k3x9q2ab connected · Linux · Chrome 63 · 192.168.1.42', '  ⎿ DevTools opening in your browser · http://localhost:7070/__teleport/Kq3xT9b2Lm/d/k3x9q2ab']);
    expect(say('tab')[1]).toBe('  ⎿ DevTools opening in the tab that was waiting for a device');
    expect(say('link')[1]).toBe('  ⎿ d opens DevTools · http://localhost:7070/__teleport/Kq3xT9b2Lm/d/k3x9q2ab');
    expect(say(undefined, false)[1]).toBe('  ⎿ DevTools · http://localhost:7070/__teleport/Kq3xT9b2Lm/d/k3x9q2ab');
    const h = harness([], { note: 'link', color: 'truecolor' });
    h.connect(dut('k3x9q2ab'));
    expect(h.rawPrinted()[1]).toContain('\x1b]8;;http://localhost:7070/__teleport/Kq3xT9b2Lm/d/k3x9q2ab\x1b\\');
  });

  it('logs with the time when piped, and prints the DevTools link since nothing opens on its own', () => {
    const out: string[] = [];
    const screen = new PlainScreen({ write: (s: string) => out.push(s) }, () => new Date(T0));
    const con = new Console({ screen, color: 'none', port: 7070, key: 'Kq3xT9b2Lm', duts: () => [], dutLink: LINK, now: () => T0, openDevtools: () => {}, reload: () => {}, quit: () => {} });
    open.push(con);
    con.event({ type: 'page', id: 'k3x9q2ab', kind: 'new', href: HREF, ua: ARM, ip: '192.168.1.42' });
    expect(out.join('')).toBe(
      ['14:02:11 ● k3x9q2ab connected · Linux · Chrome 63 · 192.168.1.42', '           ⎿ DevTools · http://localhost:7070/__teleport/Kq3xT9b2Lm/d/k3x9q2ab', ''].join('\n'),
    );
  });

  it('holds a device that went away for 5 s, and says nothing more if it reloaded meanwhile', () => {
    vi.useFakeTimers({ now: T0 });
    const duts = [dut('ab12')];
    const h = harness(duts, { realClock: true });
    h.connect(duts[0]!);
    duts.length = 0;
    h.con.event({ type: 'gone', id: 'ab12', waiting: false });
    expect(h.rows()[0]).toBe('  ○ ab12 Linux   gone 0 s');
    vi.advanceTimersByTime(3000);
    duts.push(dut('ab12'));
    h.con.event({ type: 'page', id: 'ab12', kind: 'reload', href: HREF, ua: ARM, ip: '192.168.1.42' });
    vi.advanceTimersByTime(10_000);
    expect(h.printed().slice(2)).toEqual(['· ab12 reloaded']);
  });

  it('expires a gone row on the watchdog alone, after saying it went away', () => {
    vi.useFakeTimers({ now: T0 });
    const duts = [dut('ab12')];
    const h = harness(duts, { realClock: true });
    h.connect(duts[0]!);
    duts.length = 0;
    h.con.event({ type: 'gone', id: 'ab12', waiting: true });
    vi.advanceTimersByTime(5000);
    expect(h.printed().slice(2)).toEqual(['● ab12 went away', '  ⎿ DevTools waits a minute for it to come back']);
    // DevTools' wait counts down.
    expect(h.rows()[0]).toBe('  ○ ab12 Linux   gone 5 s   DevTools waits 55 s more');
    vi.advanceTimersByTime(55_000);
    expect(h.rows()[0]).toBe('  ○ waiting for a device   open http://192.168.1.20:7070/ on it');
  });

  it('says a page that went at a heap near its limit may have been ended for it', () => {
    const duts = [dut('ab12', { points: [{ heapMB: 247, heapLimitMB: 256 }] })];
    const h = harness(duts);
    h.sample();
    h.con.event({ type: 'gone', id: 'ab12', waiting: false });
    h.advance(1000);
    h.con.event({ type: 'page', id: 'ab12', kind: 'reload', href: HREF, ua: ARM, ip: '192.168.1.42' });
    expect(h.printed().slice(-2)).toEqual(['· ab12 reloaded', "  ⎿ its heap was at 96% of the limit just before: the engine may have ended the page"]);
    // A reload asked for with l isn't a surprise: it is said as it is asked, counted down on the row, and said with how long it took.
    h.sample();
    h.hot('l');
    expect(h.printed().at(-1)).toBe('· ab12 reloading · 10 s to come back');
    expect(h.rows()[0]).toMatch(/reloading 10 s/);
    h.advance(1600);
    h.con.render();
    expect(h.rows()[0]).toMatch(/reloading 9 s/);
    h.con.event({ type: 'page', id: 'ab12', kind: 'reload', href: HREF, ua: ARM, ip: '192.168.1.42' });
    expect(h.printed().at(-1)).toBe('· ab12 reloaded in 1.6 s');
    expect(h.rows()[0]).not.toMatch(/reloading/);
    expect(h.calls).toEqual(['reload ab12']);
  });

  it("says a device that doesn't come back from a reload, once its countdown runs out", () => {
    const h = harness([dut('ab12')]);
    h.hot('l');
    h.con.event({ type: 'gone', id: 'ab12', waiting: false });
    h.duts.length = 0;
    h.advance(6000);
    h.con.render();
    // Past the usual hold, still counting down: no "went away" yet.
    expect(h.printed().at(-1)).toBe('· ab12 reloading · 10 s to come back');
    expect(h.rows()[0]).toMatch(/^ {2}○ ab12 .*reloading · back within 4 s$/);
    h.advance(5000);
    (h.con as unknown as { tick(): void }).tick();
    expect(h.printed().at(-1)).toBe("● ab12 didn't come back 10 s after the reload");
  });

  it('says a page back after its link dropped, and DevTools coming and going', () => {
    const h = harness([dut('ab12')]);
    h.con.event({ type: 'gone', id: 'ab12', waiting: true });
    h.advance(4000);
    h.con.event({ type: 'page', id: 'ab12', kind: 'relink', href: HREF, ua: ARM, ip: '192.168.1.42' });
    h.con.event({ type: 'devtools', id: 'ab12', open: 1 });
    h.con.event({ type: 'devtools', id: 'ab12', open: 2 });
    h.con.event({ type: 'devtools', id: 'ab12', open: 0 });
    h.con.event({ type: 'governor', id: 'ab12', level: 2, reason: 'the device is short of memory' });
    h.con.event({ type: 'governor', id: 'ab12', level: 0, reason: '' });
    expect(h.printed()).toEqual([
      '· ab12 back after 4 s',
      '  ⎿ the link dropped; same page, DevTools kept what it had',
      '· ab12 DevTools closed',
      "  ⎿ its console isn't recorded until DevTools opens again · d opens it",
      '● ab12 inspector paused console, network and DOM watching',
      '  ⎿ the device is short of memory',
      '● ab12 inspector back to full detail',
    ]);
  });

  it('says the samples that crossed a bar: blocked, heap, a slow key, a stall', () => {
    const duts = [dut('p7m2d4cf', { press: { code: 40, ms: 612, handlers: 540, target: 'div.tile in #rail-trending' }, points: [...Array.from({ length: 119 }, (_, i) => ({ heapMB: 446 - ((119 - i) / 60) * 2.13 })), { longTaskMs: 1380, lagMs: 1210, heapMB: 446, keys: 1, keyToFrameMs: 612 }] })];
    const h = harness(duts);
    h.sample();
    expect(h.printed()).toEqual([
      '● p7m2d4cf main thread blocked 1.4 s',
      '  ⎿ long tasks 1380 ms · timer lag 1.21 s',
      '● p7m2d4cf heap at 87% of its limit · 446 of 512 MB',
      '  ⎿ rising 2.1 MB/min from its floor: full in about 31 min',
      '● p7m2d4cf key ↓ took 612 ms to the next frame',
      "  ⎿ 540 ms in the page's key handlers · focus landed on div.tile in #rail-trending",
    ]);
    duts[0]!.session.lastFrameAt += 9000;
    duts[0]!.session.points.push(point(109_000, { lagMs: 8900 }));
    h.sample();
    expect(h.printed().slice(-2)).toEqual(['● p7m2d4cf stalled 9 s', "  ⎿ no samples, then timer lag 8.9 s: the page's main thread was blocked"]);
  });

  it('says failed requests, one a minute per path and a few a burst, and never the ones that worked', () => {
    const h = harness([dut('ab12'), dut('cd34')]);
    const req = (o: { id?: string; url?: string; status?: number; failed?: string; method?: string }) =>
      h.con.event({ type: 'request', id: o.id ?? 'ab12', ip: '192.168.1.42', method: o.method ?? 'GET', url: o.url ?? `${HREF}api/rails?page=2`, status: o.status ?? 500, ms: 412, failed: o.failed, document: false });
    req({ status: 200 });
    req({ url: `${HREF}favicon.ico`, status: 404 });
    req({});
    req({ url: `${HREF}api/rails?page=3` });
    req({ url: 'https://cdn.example.com/hero.avif', status: 0, failed: 'socket hang up' });
    expect(h.printed()).toEqual(['● ab12 GET /api/rails?page=2 → 500 · 412 ms', '● ab12 GET https://cdn.example.com/hero.avif failed · socket hang up · 412 ms']);
    for (const n of [1, 2, 3, 4]) req({ url: `${HREF}img/${n}.jpg`, status: 404 });
    expect(h.printed().slice(2)).toEqual(['● ab12 GET /img/1.jpg → 404 · 412 ms', '● ab12 more requests failed · n lists them']);
    req({ id: 'cd34' });
    expect(h.printed().at(-1)).toBe('● cd34 GET /api/rails?page=2 → 500 · 412 ms');
    h.advance(61_000);
    req({});
    expect(h.printed().at(-1)).toBe('● ab12 GET /api/rails?page=2 → 500 · 412 ms · 1 more since 14:02:11');
  });

  it('says a page that loaded with no agent connecting, once per address', () => {
    vi.useFakeTimers({ now: T0 });
    const h = harness([], { realClock: true });
    const load = () => h.con.event({ type: 'request', id: null, ip: '192.168.1.31', method: 'GET', url: HREF, status: 200, ms: 3, document: true });
    load();
    vi.advanceTimersByTime(16_000);
    load();
    vi.advanceTimersByTime(16_000);
    expect(h.printed()).toEqual(['● 192.168.1.31 loaded / 15 s ago, but no agent connected', "  ⎿ a firewall on port 7070, or the page's content security policy, may block it"]);
  });

  it('says the same thing again as one line with a count, and never loses a line that says more', () => {
    const h = harness([dut('ab12')]);
    const call = (what: string, ms: number) => h.con.event({ type: 'call', id: 'ab12', by: 'mcp', what, phase: 'end', ms });
    for (const ms of [10, 2, 4]) call('probe media', ms);
    // The same command with other words is the same kind of line: the newest takes its place.
    call('probe focus', 1);
    expect(h.printed()).toEqual(['· mcp probe focus on ab12 · 1 ms ×4']);
    call('keys right', 300);
    call('probe focus', 1);
    expect(h.printed()).toEqual(['· mcp probe focus on ab12 · 1 ms ×4', '· mcp keys right on ab12 · 300 ms', '· mcp probe focus on ab12 · 1 ms']);
    // A failure is its own line, and so is a line whose detail differs.
    h.con.event({ type: 'call', id: 'ab12', by: 'mcp', what: 'probe focus', phase: 'end', ms: 1, error: 'the page went away' });
    expect(h.printed().slice(-2)).toEqual(['● mcp probe focus on ab12 failed · 1 ms', '  ⎿ the page went away']);
    // An answer printed in between starts a new count.
    for (let i = 0; i < 2; i++) h.con.event({ type: 'page', id: 'ab12', kind: 'reload', href: HREF, ua: ARM, ip: '192.168.1.42' });
    expect(h.printed().at(-1)).toBe('· ab12 reloaded ×2');
    h.screen.print(['an answer']);
    h.con.event({ type: 'page', id: 'ab12', kind: 'reload', href: HREF, ua: ARM, ip: '192.168.1.42' });
    expect(h.printed().slice(-3)).toEqual(['· ab12 reloaded ×2', 'an answer', '· ab12 reloaded']);
  });

  it("doesn't say DevTools opened: the device's row shows it", () => {
    const h = harness([dut('ab12')]);
    h.con.event({ type: 'devtools', id: 'ab12', open: 1 });
    h.con.event({ type: 'devtools', id: 'ab12', open: 2 });
    expect(h.printed()).toEqual([]);
    h.hot('d');
    h.hot('d');
    expect(h.printed()).toEqual(['· DevTools for ab12 · http://localhost:7070/__teleport/Kq3xT9b2Lm/d/ab12 ×2']);
  });

  it('says what q, an AI agent or the API did on a device, and shows it running meanwhile', () => {
    const h = harness([dut('k3x9q2ab')]);
    h.con.event({ type: 'call', id: 'k3x9q2ab', by: 'mcp', what: 'probe media', phase: 'start' });
    h.advance(3000);
    h.con.render();
    h.type('probe');
    expect(h.side()).toContain('mcp probe media · on k3x9q2ab');
    expect(h.side().some((l) => / {2}3 s$/.test(l))).toBe(true);
    h.key('escape');
    h.con.event({ type: 'call', id: 'k3x9q2ab', by: 'mcp', what: 'probe media', phase: 'end', ms: 420 });
    h.con.event({ type: 'call', id: 'k3x9q2ab', by: 'q', what: 'eval foo()', phase: 'end', ms: 15_000, error: 'eval: ReferenceError: foo is not defined' });
    h.con.event({ type: 'call', id: 'k3x9q2ab', by: 'other', what: 'keys right', phase: 'end', ms: 80 });
    h.con.event({ type: 'call', id: 'k3x9q2ab', by: 'console', what: 'capture 10 s', phase: 'end', ms: 11_500 });
    expect(h.printed()).toEqual(['· mcp probe media on k3x9q2ab · 420 ms', '● q eval foo() on k3x9q2ab failed · 15 s', '  ⎿ eval: ReferenceError: foo is not defined', '· API keys right on k3x9q2ab · 80 ms']);
    expect(h.list().some((l) => /[◌○◎◉]$/.test(l))).toBe(false);
  });

  it("says another caller's trial as it starts and ends, and shows its progress beside trial", () => {
    const h = harness([dut('k3x9q2ab')]);
    const trial = (phase: 'start' | 'run' | 'end', done: number) => h.con.event({ type: 'trial', id: 'k3x9q2ab', by: 'mcp', name: 'focus ring', done, total: 15, phase });
    trial('start', 0);
    trial('run', 8);
    h.type('trial');
    expect(h.side()).toEqual(expect.arrayContaining([expect.stringMatching(/ {2}run 9 of 15 · 0 s$/), 'mcp trial focus ring · on k3x9q2ab']));
    h.key('escape');
    trial('end', 9);
    trial('start', 0);
    trial('end', 15);
    expect(h.printed()).toEqual([
      '· mcp trial focus ring on k3x9q2ab · 15 runs · its screen is covered until it ends',
      '· mcp trial focus ring on k3x9q2ab · stopped after 9 of 15 runs',
      '· mcp trial focus ring on k3x9q2ab · 15 runs · its screen is covered until it ends',
      '· mcp trial focus ring on k3x9q2ab · 15 of 15 runs done',
    ]);
  });

  it('says builds, the tunnel and an older tlpt stepping aside', () => {
    const h = harness([dut('ab12'), dut('cd34')]);
    h.con.note({ type: 'build', name: 'agent', reloaded: 2 });
    h.con.note({ type: 'build-failed', name: 'server', error: 'src/x.ts(3,1): error TS1005\nmore' });
    h.con.note({ type: 'tunnel', url: 'https://x.tunnel.app', app: 'localhost:5173', took: true, port: 7070 });
    h.con.note({ type: 'tunnel', url: 'https://x.tunnel.app', app: 'localhost:5173', took: false, port: 7070 });
    h.con.note({ type: 'retired', port: 7070 });
    h.con.note({ type: 'tunnel', url: 'https://x.tunnel-free.app', app: 'localhost:5173', took: true, port: 7070, lan: 'http://192.168.1.20:7070/' });
    h.con.note({ type: 'app', app: 'localhost:5173', up: false });
    h.con.note({ type: 'app', app: 'localhost:5173', up: true });
    h.con.note({ type: 'app', app: 'app.exmaple.com', up: false, why: 'getaddrinfo ENOTFOUND app.exmaple.com' });
    expect(h.printed()).toEqual([
      '· agent rebuilt · reloading 2 devices',
      '● server build failed',
      '  ⎿ src/x.ts(3,1): error TS1005',
      '· https://x.tunnel.app goes through tlpt while it runs',
      '● the tunnel kept https://x.tunnel.app on your app',
      '  ⎿ open the device link above, or point the tunnel at 127.0.0.1:7070',
      '· an older tlpt on port 7070 stepped aside',
      '· https://x.tunnel-free.app goes through tlpt while it runs',
      '  ⎿ the tunnel shows the device its warning page once: press Visit Site, or open',
      '    http://192.168.1.20:7070/ on this network',
      '● nothing answers at localhost:5173 yet',
      '  ⎿ start your app; the device waits for it and opens it once it answers',
      '● localhost:5173 answers now',
      "● app.exmaple.com doesn't answer",
      '  ⎿ getaddrinfo ENOTFOUND app.exmaple.com',
    ]);
  });
});

describe('what the page threw', () => {
  const thrown = (n: number, o: Partial<PageError> = {}): PageError => ({
    n, atMs: 840, kind: 'error', text: 'Uncaught SyntaxError: Unexpected token =>', src: 'http://192.168.1.20:7070/app.js', line: 3, col: 9, stack: '',
    hint: 'The engine could not parse this file, so none of it ran.', near: { text: 'var go = () => 1;', caret: 9 }, from: null, ...o,
  });
  const error = (h: ReturnType<typeof harness>, n: number, o: Partial<PageError> = {}) => h.con.event({ type: 'error', id: 'ab12', error: thrown(n, o), total: n + 1 });

  it("prints what a page says as text: none of its escapes reaches the terminal", () => {
    const h = harness([dut('ab12')], { color: 'truecolor' });
    const E = '\x1b';
    error(h, 0, { text: `boom ${E}]0;pwned\x07${E}[2J`, src: `http://192.168.1.20:7070/${E}[5mapp.js`, hint: `${E}]52;c;cHduZWQ=${E}\\`, near: { text: `x ${E}[41m y`, caret: 2 } });
    h.con.event({ type: 'page', id: 'ab12', kind: 'new', href: `http://device/${E}]0;href\x07`, ua: `UA ${E}[2J`, ip: '192.168.1.42' });
    h.con.event({ type: 'call', id: 'ab12', by: 'q', what: `eval ${E}[2J`, phase: 'end', ms: 5, error: `threw ${E}]0;x\x07` });
    const out = [...h.rawPrinted(), ...h.raw()].join('\n');
    // teleport's own styling is there, so escapes do reach the terminal: only never the page's.
    expect(out).toContain(`${E}[`);
    expect(out).not.toMatch(/\x1b\]0;|\x1b\]52;|\x1b\[2J|\x1b\[5m|\x1b\[41m|\x07/);
    expect(h.printed().join('\n')).toContain('boom ]0;pwned[2J');
  });

  it('says each of a page\'s first 3 errors with the source around it and what it likely means, and nothing for later ones', () => {
    const h = harness([dut('ab12')]);
    error(h, 0);
    expect(h.printed()).toEqual([
      '● ab12 threw SyntaxError: Unexpected token => · app.js:3:9 · 840 ms into the page',
      '  ⎿ var go = () => 1;',
      '    ---------^',
      '    The engine could not parse this file, so none of it ran.',
    ]);
    for (const n of [1, 2]) error(h, n);
    // The same error thrown again is the same line, counted.
    expect(h.printed().filter((l) => l.startsWith('● ab12 threw '))).toEqual(['● ab12 threw SyntaxError: Unexpected token => · app.js:3:9 · 840 ms into the page ×3']);
    const before = h.printed().length;
    for (const n of [3, 4, 20]) error(h, n);
    expect(h.printed()).toHaveLength(before);
  });

  it('says a script that did not load without "threw", and a rejection as one', () => {
    const h = harness([dut('ab12')]);
    error(h, 0, { kind: 'resource', text: 'script', src: 'http://192.168.1.20:7070/vendor.js', line: 0, col: 0, near: null, hint: 'Nothing this script defines exists.' });
    error(h, 1, { kind: 'rejection', text: 'Uncaught undefined is not a function', hint: null, near: null });
    expect(h.printed()[0]).toMatch(/^● ab12 script did not load: http:\/\/192\.168\.1\.20:7070\/vendor\.js · /);
    expect(h.printed().find((l) => l.startsWith('● ab12 threw '))).toContain('unhandled rejection: undefined is not a function');
  });

  it('counts a page that keeps throwing, once a minute per device and only past 3', () => {
    const h = harness([dut('ab12'), dut('cd34')]);
    const count = (id: string, total: number) => h.con.event({ type: 'errors', id, total });
    count('ab12', 3);
    expect(h.printed()).toEqual([]);
    count('ab12', 4);
    expect(h.printed()).toEqual([]);
    h.advance(61_000);
    count('ab12', 9);
    expect(h.printed()).toEqual(['● ab12 has thrown 9 errors', '  ⎿ e lists the first and the last of them']);
    h.advance(30_000);
    count('ab12', 30);
    expect(h.printed()).toHaveLength(2);
    count('cd34', 8);
    expect(h.printed().at(-2)).toMatch(/^● cd34 has thrown 8 errors/);
    h.advance(31_000);
    count('ab12', 40);
    expect(h.printed().filter((l) => l.startsWith('● ab12 has thrown'))).toEqual(['● ab12 has thrown 9 errors', '● ab12 has thrown 40 errors']);
  });

  it('starts counting afresh when the page loads again', () => {
    const h = harness([dut('ab12')]);
    h.con.event({ type: 'errors', id: 'ab12', total: 5 });
    h.con.event({ type: 'errors', id: 'ab12', total: 6 });
    expect(h.printed().filter((l) => l.includes('has thrown'))).toHaveLength(1);
    h.con.event({ type: 'page', id: 'ab12', kind: 'reload', href: HREF, ua: ARM, ip: '192.168.1.42' });
    h.con.event({ type: 'errors', id: 'ab12', total: 7 });
    expect(h.printed().filter((l) => l.includes('has thrown'))).toHaveLength(2);
  });

  it('says what the inspector left out, and that errors are not among it', () => {
    const h = harness([dut('ab12')]);
    h.con.event({ type: 'dropped', id: 'ab12', console: 1, network: 12 });
    h.con.event({ type: 'dropped', id: 'ab12', console: 0, network: 1 });
    expect(h.printed()).toEqual([
      '● ab12 inspector left out 1 console message and 12 network events',
      '  ⎿ The device was too busy or its link too full to report them. What the page threw is not among',
      '    them: errors are kept.',
      '● ab12 inspector left out 1 network event',
      '  ⎿ The device was too busy or its link too full to report them. What the page threw is not among',
      '    them: errors are kept.',
    ]);
  });

  it('shows the count on the device\'s row, red, and nothing when there are none', () => {
    const h = harness([dut('ab12', { errors: 1 }), dut('cd34', { errors: 12 }), dut('ef56')]);
    h.duts.forEach(h.connect);
    h.sample();
    const rows = h.rows();
    expect(rows[0]).toContain('1 error');
    expect(rows[0]).not.toContain('1 errors');
    expect(rows[1]).toContain('12 errors');
    expect(rows[2]).not.toMatch(/error/);
    const color = harness([dut('ab12', { errors: 2 })], { color: 'truecolor' });
    color.connect(color.duts[0]!);
    color.sample();
    expect(color.rowsRaw()[0]).toMatch(/\x1b\[[0-9;]*m2 errors/);
  });

  // packages/server/src/console.ts: the key filter `'dclrin'.includes(ch)` lacks 'e'. Make this `it` once it has it.
  it('runs errors on the selected device with e', () => {
    const duts = [dut('ab12'), dut('cd34')];
    const h = harness(duts);
    duts.forEach(h.connect);
    run.mockResolvedValue({});
    h.key('tab');
    h.hot('e');
    expect(calls()[0]![0].name).toBe('errors');
    expect(calls()[0]!.slice(1, 6)).toEqual([{}, 7070, process.cwd(), 'cd34', 'console']);
  });
});

/**
 * The console's commands, without what it reads by itself: the right side's live reads, remote mode's
 * listening and what each key sends, which go with no folder (they take no paths).
 */
const calls = () => run.mock.calls.filter((c) => c[3] !== undefined);
const named = () => calls().map((c) => [(c[0] as { name: string }).name, c[1]]);
/** What the page heard, as the server answers it. */
const heardNothing = { heard: [], learned: [], sends: { ok: { key: 'Enter', code: 'Enter', keyCode: 13 } } };

describe('the keys', () => {
  it('acts on the selected device: the first to connect, then whichever tab picks', () => {
    const duts = [dut('ab12'), dut('cd34')];
    const h = harness(duts);
    duts.forEach(h.connect);
    expect(h.rows()[0]).toMatch(/^› ● ab12/);
    h.key('tab');
    expect(h.rows()[1]).toMatch(/^› ● cd34/);
    h.hot('d');
    h.hot('l');
    expect(h.calls).toEqual(['devtools cd34', 'reload cd34']);
    expect(h.printed().slice(-2)).toEqual(['· DevTools for cd34 · http://localhost:7070/__teleport/Kq3xT9b2Lm/d/cd34', '· cd34 reloading · 10 s to come back']);
    h.key('tab', { shift: true });
    expect(h.rows()[0]).toMatch(/^› ● ab12/);
    // The link is never cut: the terminal wraps it, and it copies whole.
    const narrow = harness([dut('ab12')], { cols: 40, note: 'opened' });
    narrow.connect(narrow.duts[0]!);
    narrow.hot('d');
    expect(narrow.printed().slice(1)).toEqual(['  ⎿ DevTools opening in your browser · http://localhost:7070/__teleport/Kq3xT9b2Lm/d/ab12', '· DevTools for ab12 · http://localhost:7070/__teleport/Kq3xT9b2Lm/d/ab12']);
    expect(narrow.printed()[0]).toMatch(/…$/);
  });

  it('moves through the groups and their entries with the arrows, opens a group with → or enter, and backs up with ←', async () => {
    const h = harness([dut('ab12')], { rows: 40 });
    expect(h.at()).toBe('capture');
    h.key('down');
    expect(h.at()).toBe('survey');
    // Up from a group's first entry is the group, which closes; down from there is the next group.
    h.key('up');
    h.key('up');
    expect(h.at()).toBe('measure');
    expect(h.list().filter(Boolean)).toHaveLength(5);
    expect(h.side()[0]).toMatch(/^measure {2}how the app runs on it, as it is/);
    expect(h.side()).toContainEqual(expect.stringMatching(/^c capture +fps and key → frame$/));
    h.key('down');
    expect(h.at()).toBe('experiment');
    // Round at the ends: up from the first group is the last.
    h.key('up');
    h.key('up');
    expect(h.at()).toBe('inspect');
    h.key('down');
    h.key('down');
    // Right, or enter, opens a group onto its first entry.
    h.key('right');
    expect(h.at()).toBe('try');
    expect(h.side()[0]).toMatch(/^try {2}flip one thing, measured/);
    // Enter on one that takes a word starts its line and lists the values on the right.
    h.key('return');
    expect(h.rows().at(-1)).toMatch(/^ {2}> try _/);
    expect(h.side()).toContainEqual(expect.stringMatching(/^› transform +move with transform, or with left$/));
    h.key('escape');
    // Left backs up to the group, and enter opens it again.
    h.key('left');
    expect(h.at()).toBe('experiment');
    h.key('return');
    expect(h.at()).toBe('try');
    h.key('left');
    // On one that takes no word, enter runs it with its defaults.
    run.mockResolvedValue({});
    h.key('up');
    h.key('return');
    expect(h.at()).toBe('capture');
    h.key('return');
    expect((calls()[0]![0] as { name: string }).name).toBe('capture');
    expect(calls()[0]![1]).toEqual({ seconds: 10 });
  });

  it('quits on ctrl+c with nothing typed; with something typed, ctrl+c clears it first', () => {
    const h = harness([dut('ab12')]);
    h.type('q');
    expect(h.rows().at(-1)).toMatch(/^ {2}> q_ /);
    h.ctrl('c');
    expect(h.calls).toEqual([]);
    expect(info(h)).toBe(BAR);
    h.ctrl('c');
    expect(h.calls).toEqual(['quit']);
  });

  it('scrolls the log a page on page up and page down, and back to the newest on Escape', () => {
    const h = harness([dut('ab12')]);
    h.key('pageup');
    h.key('pagedown');
    h.key('pageup');
    expect(h.scrolls).toEqual([1, -1, 1]);
    h.key('escape');
    expect(h.scrolls).toEqual([1, -1, 1, 0]);
  });

  it('scrolls a long answer on the right instead, while one is open there', async () => {
    const h = harness([dut('ab12')]);
    answer.mockImplementation(() => Array.from({ length: 80 }, (_, i) => `line ${i}`));
    try {
      run.mockResolvedValue({});
      h.type('styles');
      h.key('return');
      await settle();
      // Its run, then its answer.
      expect(h.side().slice(1, 5)).toEqual(['', '14:02 ✓ styles · 0 ms', '', 'line 0']);
      expect(h.side().at(-1)).toMatch(/^↓ \d+ more lines · page down$/);
      h.key('pagedown');
      expect(h.side()[4]).not.toBe('line 0');
      expect(h.scrolls).toEqual([]);
      h.key('escape');
      expect(h.side()[4]).toBe('line 0');
    } finally {
      answer.mockImplementation(() => ['● answer']);
    }
  });

  it('shows what the highlighted entry does and costs on ?, with the keys, and closes it on esc or any other key', () => {
    const h = harness([dut('ab12')], { rows: 40 });
    expect(h.side()).not.toContainEqual(expect.stringMatching(/^cost /));
    h.type('?');
    const side = h.side();
    expect(side[0]).toMatch(/^capture {2}fps and key → frame +on ab12$/);
    expect(side[2]).toMatch(/^Records every frame and key press/);
    expect(side).toEqual(
      expect.arrayContaining([
        'type  capture [seconds] · or c, then enter',
        'cost  the agent records every frame while it runs; nothing else',
        'tab      picks the device; shift+tab goes back',
        'main     main thread blocked, each of the last 16 s',
        'key      last key press → next frame; – when none came',
      ]),
    );
    h.key('escape');
    expect(h.side()).not.toContainEqual(expect.stringMatching(/^cost /));
    h.type('?');
    h.hot('l');
    expect(h.calls).toEqual(['reload ab12']);
    expect(h.side()[0]).toMatch(/^reload /);
  });

  it('says what an unbound key or an arrow would do, and that keys need a device', () => {
    const h = harness([dut('ab12')]);
    // Right on an entry (left backs up to its group).
    h.key('right');
    expect(h.rows().at(-1)).toMatch(/^ {2}> _ {2}arrows drive the device in remote mode · r, then enter/);
    h.advance(3000);
    h.con.render();
    expect(info(h)).toBe(BAR);
    const none = harness();
    none.hot('c');
    expect(none.rows().at(-1)).toMatch(/^ {2}> _ {2}no device connected yet · open http:\/\/192\.168\.1\.20:7070\/ on it/);
    expect(none.printed()).toEqual([]);
  });

  it('captures 10 s on c, as a beam with live fps on the right, and says so when one already runs', async () => {
    const duts = [dut('k3x9q2ab', { points: [{ fps: 58 }] })];
    const h = harness(duts);
    h.sample();
    let done!: (v: unknown) => void;
    run.mockReturnValueOnce(new Promise((r) => (done = r)));
    h.hot('c');
    expect(calls()[0]!.slice(1, 6)).toEqual([{ seconds: 10 }, 7070, process.cwd(), 'k3x9q2ab', 'console']);
    h.advance(4200);
    h.con.render();
    expect(h.side().slice(0, 4)).toEqual([expect.stringMatching(/^capture {2}fps and key → frame +on k3x9q2ab$/), '', expect.stringMatching(/^◎━+[✦✧]┈.*[◌○◎◉] {2}4 s of 10 · 58 fps$/), 'on k3x9q2ab · press keys on the device now']);
    // With no capture yet, what the device's samples say now.
    expect(h.side().slice(4)).toEqual(['', expect.stringMatching(/^main .* ms {3}heap 212\/512 MB$/)]);
    expect(h.list().find((l) => l.includes('capture'))).toMatch(/capture +[◌○◎◉]/);
    h.hot('c');
    expect(h.rows().at(-1)).toMatch(/^ {2}> _ {2}a capture is running on k3x9q2ab; a capture now would measure it/);
    expect(run).toHaveBeenCalledTimes(1);
    done({ seconds: 10 });
    await settle();
    expect(answer).toHaveBeenCalledWith('capture', { seconds: 10 }, { seconds: 10 }, 'k3x9q2ab', expect.anything(), 100, { port: expect.any(Number), href: expect.any(String) });
    // The log gets its first line; the answer opens on the right, at the right's width.
    expect(h.printed()).toEqual(['● answer']);
    expect(answer).toHaveBeenLastCalledWith('capture', { seconds: 10 }, { seconds: 10 }, 'k3x9q2ab', expect.anything(), 67, expect.anything());
    expect(h.side().slice(2)).toEqual(['14:02 ✓ capture 10 · 4.2 s', '', '● answer']);
    // Beside it, the clock time it ran, which stays put: a count of seconds since read as a timer still going.
    expect(h.list().find((l) => l.includes('capture'))).toMatch(/capture +14:02$/);
    h.advance(120_000);
    h.con.render();
    expect(h.list().find((l) => l.includes('capture'))).toMatch(/capture +14:02$/);
  });

  it('keeps a q trial marked beside trial while i opens the device details', async () => {
    const h = harness([dut('ab12')], { rows: 40 });
    h.con.event({ type: 'trial', id: 'ab12', by: 'q', name: 'focus ring', done: 0, total: 15, phase: 'start' });
    let fail!: (e: Error) => void;
    // What the right side reads by itself (no folder) answers at once; the command waits.
    run.mockImplementation((_c, _a, _p, cwd) => (cwd === undefined ? Promise.resolve({}) : new Promise((_, r) => (fail = r))));
    h.hot('i');
    expect(calls()[0]!.slice(1, 2)).toEqual([{ seconds: 60 }]);
    fail(new Error('the page went away'));
    await settle();
    expect(h.printed().slice(1)).toEqual(['● /device --seconds 60 on ab12 failed', '  ⎿ the page went away']);
    expect(h.at()).toBe('device');
    // The device's last minute is shown live; the run that failed is listed above it, with why.
    expect(h.side()[2]).toBe('14:02 ✗ device --seconds 60 · 0 ms · the page went away');
    // trial's group is closed: the group carries the mark.
    expect(h.list().find((l) => l.includes('experiment'))).toMatch(/[◌○◎◉] t$/);
    expect(h.list().find((l) => l.includes('device'))).toMatch(/✗ 14:02$/);
  });

  it('drives the device in remote mode with arrows, enter, backspace and digits only, never letters', async () => {
    const h = harness([dut('ab12')]);
    const sent: unknown[] = [];
    let answerNext!: () => void;
    run.mockImplementation((c, args) => {
      const name = (c as { name: string }).name;
      if (name === 'hear') return Promise.resolve(heardNothing);
      if (name === 'keymap') return Promise.resolve({ sends: heardNothing.sends, mapped: [] });
      sent.push((args as { sequence: string[] }).sequence);
      return new Promise((r) => (answerNext = () => r({ error: null })));
    });
    h.hot('r');
    expect(h.rows().at(-1)).toMatch(/^ {2}\[REMOTE\] ab12 {2}esc leaves · c captures +first press loads the inspector$/);
    // The right side is the remote: a d-pad, and what else the keyboard does.
    expect(h.side().slice(0, 5)).toEqual([
      expect.stringMatching(/^remote {2}this keyboard is the remote +on ab12$/),
      '',
      '      ↑         arrows move · enter ok',
      '   ←  ok  →     ⌫ back · 0-9 digits',
      '      ↓         m maps a key · esc leaves',
    ]);
    h.type('gybx');
    expect(sent).toEqual([]);
    h.key('right');
    h.key('down');
    h.key('return');
    h.type('5');
    h.key('backspace');
    // Four wait while the device answers the first; a fifth is dropped.
    h.key('left');
    expect(h.rows().at(-1)).toBe('  [REMOTE] ab12  the device is behind · extra presses dropped');
    h.paste('keys red');
    answerNext();
    await settle();
    expect(sent).toEqual([['right'], ['down', 'ok', '5', 'back']]);
    h.advance(3000);
    h.con.render();
    expect(h.side()).toContain('sent   ↓ ok 5 back');
    expect(h.side().at(-1)).toBe('sends  ok Enter 13');
    h.key('escape');
    expect(info(h)).toBe('  > _  ↑↓ pick · enter drives the device · ? help');
  });

  it("names what the page heard in remote mode, the device's own presses too, and says a key it learned", async () => {
    vi.useFakeTimers({ now: T0 });
    const h = harness([dut('ab12')], { realClock: true, rows: 40 });
    const heard = (o: object) => ({ kind: 'key', code: 'GamepadA', from: 'device', took: false, clicked: true, changed: true, at: 'button#play', to: null, t: 0, ...o });
    const asks: unknown[] = [];
    run.mockImplementation((c, args) => {
      if ((c as { name: string }).name !== 'hear') return Promise.resolve({ sends: { ok: { key: 'GamepadA', code: 'GamepadA', keyCode: 195 } }, mapped: ['ok'] });
      asks.push(args);
      return Promise.resolve({
        heard: [heard({ key: 'GamepadA', keyCode: 195, what: { id: 'ok', name: 'gamepad A' } })],
        learned: asks.length === 1 ? [{ id: 'ok', press: { key: 'GamepadA', code: 'GamepadA', keyCode: 195 }, name: 'gamepad A' }] : [],
        sends: { ok: { key: 'GamepadA', code: 'GamepadA', keyCode: 195 } },
      });
    });
    h.hot('r');
    await vi.advanceTimersByTimeAsync(0);
    expect(asks[0]).toEqual({ seconds: 0 });
    expect(h.side()).toContain('  ⎿ device  gamepad A  GamepadA 195  ok  clicked');
    expect(h.side().slice(-2)).toEqual(['sends  ok GamepadA 195*', '       * set here or heard · keymap ok reset undoes it']);
    expect(h.printed()).toEqual(['● ab12 sends ok as gamepad A', "  ⎿ heard from the device's own remote (GamepadA 195) · the remote sends that now"]);
    // It asks while the mode is on, and no longer once it is left.
    await vi.advanceTimersByTimeAsync(1300);
    expect(asks.length).toBe(3);
    h.key('escape');
    await vi.advanceTimersByTimeAsync(3000);
    expect(asks.length).toBe(3);
  });

  it("shows on the remote, without remote mode, the device's own presses and when one drew nothing", () => {
    const h = harness([dut('ab12', { press: { code: 13, ms: -1 } })], { color: 'truecolor', rows: 40 });
    h.sample();
    h.type('remote');
    h.ctrl('u');
    expect(h.at()).toBe('remote');
    expect(h.side()).toContain('presses the page saw, newest first');
    expect(h.side()).toContain('  ok     nothing drew · the app may not answer ok');
    // Beside remote in the list, the key, amber: it did nothing on the screen.
    expect(h.raw().find((l) => strip(l).includes(' r remote'))).toContain('\x1b[38;2;242;173;72mok');
  });

  it('keeps remote mode on its device through a reload, and never hands it to another device', () => {
    vi.useFakeTimers({ now: T0 });
    const duts = [dut('ab12'), dut('cd34')];
    const h = harness(duts, { realClock: true });
    duts.forEach(h.connect);
    run.mockResolvedValue({ error: null });
    h.hot('r');
    expect(h.rows().at(-1)).toMatch(/^ {2}\[REMOTE\] ab12 /);
    // ab12 reloads: the server forgets it, then adds it again, last. Its row keeps its place.
    const ab12 = duts.shift()!;
    h.con.event({ type: 'gone', id: 'ab12', waiting: false });
    // Between pages the mode waits for it: a press isn't sent to cd34, and isn't the end of the mode.
    expect(h.rows().at(-1)).toMatch(/^ {2}\[REMOTE\] ab12 /);
    h.key('down');
    expect(calls()).toEqual([]);
    expect(h.rows().at(-1)).toMatch(/^ {2}\[REMOTE\] ab12 +between pages · press again once it is back/);
    duts.push(ab12);
    h.con.event({ type: 'page', id: 'ab12', kind: 'reload', href: HREF, ua: ARM, ip: '192.168.1.42' });
    expect(h.rows().slice(0, 2).map((l) => l.slice(0, 9))).toEqual(['› ● ab12 ', '  ● cd34 ']);
    expect(h.rows().at(-1)).toMatch(/^ {2}\[REMOTE\] ab12 /);
    // ab12 goes for good: cd34 isn't driven, and an arrow is only an arrow.
    duts.pop();
    h.con.event({ type: 'gone', id: 'ab12', waiting: false });
    vi.advanceTimersByTime(6000);
    h.key('right');
    expect(calls()).toEqual([]);
    expect(h.rows().at(-1)).toMatch(/^ {2}> _ {2}arrows drive the device in remote mode · r, then enter/);
    // Nor does it come back with a device that returns after it was said to have gone.
    h.hot('r');
    expect(h.rows().at(-1)).toMatch(/^ {2}\[REMOTE\] cd34 /);
    const cd34 = duts.pop()!;
    h.con.event({ type: 'gone', id: 'cd34', waiting: false });
    vi.advanceTimersByTime(6000);
    duts.push(cd34);
    h.con.event({ type: 'page', id: 'cd34', kind: 'new', href: HREF, ua: ARM, ip: '192.168.1.42' });
    expect(info(h)).toBe('  > _  ↑↓ pick · enter drives the device · ? help');
  });

  it('says when a remote press failed', async () => {
    const h = harness([dut('ab12')]);
    run.mockImplementation((c) => Promise.resolve((c as { name: string }).name === 'hear' ? heardNothing : { error: 'nothing matches #menu' }));
    h.hot('r');
    h.key('up');
    await settle();
    expect(h.printed()).toEqual(['● remote on ab12 failed', '  ⎿ nothing matches #menu']);
  });

  it("stops the console's own trial on esc esc, after its current run", async () => {
    const h = harness([dut('ab12')]);
    let signal: AbortSignal | undefined;
    run.mockImplementation((...a) => {
      signal = a[6];
      return new Promise((_, rej) => signal!.addEventListener('abort', () => rej(new Error('stopped'))));
    });
    h.paste('trial examples/trials/focus-ring.mjs');
    h.key('return');
    expect(h.at()).toBe('trial');
    expect(h.side()[3]).toBe('trial examples/trials/focus-ring.mjs · on ab12 · esc stops it');
    h.con.event({ type: 'trial', id: 'ab12', by: 'console', name: 'focus ring', done: 8, total: 15, phase: 'run' });
    h.key('escape');
    expect(h.side()[2]).toMatch(/ {2}run 9 of 15 · 0 s$/);
    expect(h.side()[3]).toBe('trial focus ring · on ab12 · esc again to stop it');
    h.advance(2500);
    h.key('escape');
    expect(signal!.aborted).toBe(false);
    h.key('escape');
    expect(signal!.aborted).toBe(true);
    await settle();
    expect(h.printed()).toEqual(['● /trial examples/trials/focus-ring.mjs stopped', '  ⎿ the device finishes the run in progress, then the trial ends: 9 of 15 runs, no report']);
    expect(h.list().some((l) => /[◌○◎◉]$/.test(l))).toBe(false);
  });
});

describe('naming the app in the input', () => {
  it('knows a port, an address or a folder from a command or plain words', () => {
    for (const app of ['5173', ':5173', 'localhost:5173', '192.168.1.5:8080/app', 'http://localhost:3000', 'app.example.com', './dist', '../site', '~/site']) expect(isApp(app), app).toBe(true);
    for (const not of ['capture', 'capture 5', '5', 'is webp worth it', 'hevc', 'probe media', 'css * { a: b }']) expect(isApp(not), not).toBe(false);
  });

  it('serves a port typed, says so before enter, and keeps the line with why when it cannot', async () => {
    const asked: string[] = [];
    let answer: string | null = null;
    const h = harness([], { connect: async (what) => (asked.push(what), answer) });
    h.type('5173');
    expect(h.live().at(-1)).toContain('enter serves localhost:5173 to the device');
    h.key('return');
    await settle();
    expect(asked).toEqual(['5173']);
    expect(h.live().find((l) => l.startsWith('  > '))).toMatch(/^ {2}> +/);
    answer = './nope is not a port, an address or a folder here';
    h.type('./nope');
    h.key('return');
    await settle();
    expect(h.live().find((l) => l.startsWith('  > '))).toContain('./nope');
    expect(h.live().at(-1)).toContain('✗ ./nope is not a port, an address or a folder here');
  });

  it('says what to do while there is no app, and drops it once there is one', () => {
    const h = harness([], { appless: true, connect: async () => null });
    expect(h.live().find((l) => l.includes('waiting for'))).toBe("  ○ waiting for an app   type its port below, or start your dev server");
    h.con.setApp('http://192.168.1.20:7070/', false);
    expect(h.live().find((l) => l.includes('waiting for'))).toBe('  ○ waiting for a device   open http://192.168.1.20:7070/ on it');
  });
});

describe('one list for everything', () => {
  it('lists every entry, each with its letter, and runs the same thing by key, by name or by moving to it', async () => {
    expect(MENU.filter((e) => e.key).map((e) => e.key + e.name[0])).toEqual(['cc', 'ss', 'pp', 'hh', 'tt', 'rr', 'dd', 'ee', 'nn', 'id', 'lr']);
    const h = harness([dut('ab12')], { rows: 40 });
    // The first group is open; a closed one shows its letters.
    expect(h.list().filter(Boolean).map((l) => l.trim())).toEqual(['measure', '› c capture', 's survey', 'p probe', 'styles', 'advise', 'report', 'h history', 'experiment   t', 'video', 'input        r', 'inspect      d e n i l']);
    run.mockResolvedValue({});
    h.hot('s');
    h.type('survey');
    h.key('return');
    h.key('down');
    h.key('return');
    await settle();
    expect(calls().map((c) => [(c[0] as { name: string }).name, c[4]])).toEqual([['survey', 'ab12'], ['survey', 'ab12'], ['trial', 'ab12']].slice(0, 2));
  });

  it('reaches remote, devtools and reload by name as well as by key', () => {
    const h = harness([dut('ab12'), dut('cd34')]);
    h.type('rem');
    expect(h.at()).toBe('remote');
    expect(h.side()[0]).toMatch(/^remote {2}remote control, from here +on cd34$/);
    expect(h.side()[2]).toMatch(/^ {6}↑ +enter drives the device$/);
    h.key('return');
    expect(h.rows().at(-1)).toMatch(/^ {2}\[REMOTE\] cd34 /);
    h.key('escape');
    h.type('reload --id ab12');
    h.key('return');
    h.type('devtools');
    h.key('return');
    expect(h.calls).toEqual(['reload ab12', 'devtools cd34']);
    h.type('reload now');
    h.key('return');
    expect(h.rows().at(-1)).toContain('✗ reload takes no word "now"');
  });
});

/** The input's text, the caret drawn as `_`, without what is said after it. */
const box = (h: ReturnType<typeof harness>) => /^ {2}> (.*?)(?: {2}(?:enter|esc|✗|↑↓|a |no |arrows).*)?$/.exec(h.rows().at(-1)!)![1]!.trimEnd();

describe('the input, always open', () => {
  it('runs an entry by its letter and enter, and a toggle or a codec by its own name', async () => {
    const h = harness([dut('ab12')]);
    run.mockResolvedValue({});
    const names = named;
    // r is remote, not report: the letter's own entry comes first.
    h.type('r');
    expect(h.at()).toBe('remote');
    h.ctrl('c');
    h.hot('s');
    h.type('shadow');
    expect(h.at()).toBe('try');
    h.key('return');
    // One trial at a time on a device: the next waits for the first to end.
    await settle();
    h.type('hevc');
    h.key('return');
    await settle();
    expect(names()).toEqual([['survey', {}], ['try', { what: ['shadow'] }], ['try', { what: ['hevc'] }]]);
    h.type('zzzz');
    h.key('return');
    expect(h.rows().at(-1)).toContain('✗ no command zzzz · the list has them all');
  });

  it('lists only the entries what is typed matches, under their groups', () => {
    const h = harness([dut('ab12')], { rows: 40 });
    h.type('dev');
    expect(h.list().filter(Boolean).map((l) => l.trim())).toEqual(['inspect', '› d devtools', 'i device', 'devices']);
    expect(h.at()).toBe('devtools');
    // Cleared, the highlight stays where typing found it, with its group open.
    h.ctrl('u');
    expect(h.list().filter(Boolean).map((l) => l.trim().split(/\s+/).pop())).toEqual(['h', 't', 'video', 'r', 'inspect', 'devtools', 'errors', 'network', 'device', 'devices', 'reload']);
  });

  it('lists what there is to try, each with what is flipped, and takes css rules as words', async () => {
    const h = harness([dut('ab12')]);
    run.mockResolvedValue({});
    h.hot('t');
    expect(box(h)).toBe('try _');
    expect(h.picked()).toBe('transform');
    expect(h.side()).toContainEqual(expect.stringMatching(/^› transform +move with transform, or with left$/));
    h.type('css * { box-shadow: none }');
    h.key('return');
    await settle();
    expect(calls()[0]![1]).toEqual({ what: ['css', '*', '{', 'box-shadow:', 'none', '}'] });
  });

  it('gives remote mode the keyboard: c captures the presses, other letters do nothing, esc gives it back', async () => {
    const h = harness([dut('ab12')]);
    run.mockResolvedValue({ error: null });
    h.hot('r');
    expect(h.rows().some((l) => l.startsWith('  > '))).toBe(false);
    h.type('x');
    h.type('c');
    await settle();
    expect(calls().map((c) => (c[0] as { name: string }).name)).toEqual(['capture']);
    h.key('escape');
    expect(box(h)).toBe('_');
  });
});

describe('the palette', () => {
  it('opens a command typed on the right as an explorer: the probes, which have run and when', async () => {
    const h = harness([dut('k3x9q2ab')]);
    h.type('pro');
    expect(box(h)).toBe('pro_');
    expect(h.at()).toBe('probe');
    expect(h.side()[0]).toMatch(/^probe {2}what the engine supports +on k3x9q2ab$/);
    expect(h.side().slice(2, 4)).toEqual(['· identity        · features', '· media           · graphics']);
    expect(h.rows().at(-1)).toMatch(/ on ● k3x9q2ab$/);
    // One that ran is ticked, with how long ago; an AI agent's run counts as well as this console's.
    h.con.event({ type: 'call', id: 'k3x9q2ab', by: 'mcp', what: 'probe media', phase: 'end', ms: 420 });
    h.advance(5000);
    h.con.render();
    expect(h.side()[3]).toBe('✓ media    14:02  · graphics');
    expect(h.list().find((l) => l.includes('probe'))).toMatch(/probe +14:02$/);
    // What it does and costs is there on ?, with nothing typed.
    h.ctrl('u');
    h.type('?');
    expect(h.side()).toContain('cost  one script, answered by the agent');
  });

  it('draws the input as one line, with no box, whatever the terminal', () => {
    for (const o of [{}, { rows: 15 }, { cols: 39 }]) {
      const h = harness([dut('ab12')], o);
      expect(box(h)).toBe('_');
      expect(h.rows().filter((l) => l.startsWith('  > '))).toHaveLength(1);
      expect(h.live().some((l) => /^[╭╰]/.test(l))).toBe(false);
    }
  });

  it('shows the keys on the input line, with the device at the right when it fits', () => {
    const h = harness([dut('ab12')]);
    h.type('xyz');
    expect(info(h)).toMatch(/^ {2}> xyz_ {2}enter (run|choose) · tab complete · esc cancel$/);
    expect(h.rows().at(-1)).toMatch(/ on ● ab12$/);
    const narrow = harness([dut('ab12')], { cols: 60 });
    narrow.type('xyz');
    expect(info(narrow)).toBe('  > xyz_  enter run · esc cancel');
    const none = harness();
    none.type('xyz');
    expect(none.rows().at(-1)).toMatch(/no device yet$/);
  });

  it('scrolls the list with the highlight when the terminal is short, and says how many more', () => {
    for (const rows of [16, 12]) {
      const h = harness([dut('ab12')], { rows });
      // Every entry, reached by opening each group in turn: every q command but those for agents, and the three done by hand.
      const seen: string[] = [];
      for (let i = 0; i < 100 && !(seen.length && h.at() === 'capture'); i++) {
        const at = h.at()!;
        if (GROUPS.some((g) => g.id === at)) h.key('right');
        else {
          seen.push(at);
          h.key('down');
        }
      }
      expect(seen).toEqual(MENU.map((c) => c.name));
      expect([...seen].sort()).toEqual([...COMMANDS.filter((c) => !c.agents).map((c) => c.name), 'remote', 'devtools', 'reload'].sort());
      expect(h.at()).toBe('capture');
      expect(h.list().at(-1)).toMatch(/↓ \d+ more$/);
      expect(h.live().length).toBeLessThanOrEqual(rows - 1);
    }
  });

  it('ranks names that start with the text, then contain it, then briefs with a word that starts with it', () => {
    const h = harness([dut('ab12')], { color: 'truecolor', rows: 40 });
    h.type('key');
    expect(h.at()).toBe('keys');
    h.key('down');
    expect(h.at()).toBe('keymap');
    h.key('down');
    expect(h.at()).toBe('capture');
    h.ctrl('u');
    h.type('xyz');
    expect(h.side()[0]).toMatch(/^capture /);
  });

  it('completes a command that takes a word and waits for it, then lists its values with their costs', () => {
    const h = harness([dut('k3x9q2ab')]);
    h.key('down');
    h.key('down');
    expect(h.at()).toBe('probe');
    h.key('return');
    expect(box(h)).toBe('probe _');
    expect(h.side().slice(2, 5)).toEqual([
      '› identity  model, screen, memory, network',
      '  features  CSS, JavaScript syntax, web APIs',
      '  media     codecs, key systems, robustness',
    ]);
    expect(h.side().at(-1)).toBe('costs the device: reads properties and media queries');
    expect(h.rows().at(-1)).toMatch(/ {3}on ● k3x9q2ab$/);
    h.key('escape');
    h.type('cap');
    h.key('return');
    expect(box(h)).toBe('capture _');
    expect(h.picked()).toBe('10');
  });

  it('completes key names and stays open for the next, and lists flags, device ids, what to try, the shim and trial files', () => {
    const h = harness([dut('ab12'), dut('cd34')]);
    h.type('keys ri');
    h.key('tab');
    expect(box(h)).toBe('keys right _');
    expect(h.picked()).toBe('up');
    h.ctrl('u');
    h.type('network --');
    expect(h.side().filter((l) => /^[› ] -/.test(l)).map((l) => l.slice(2).split(/\s{2,}/)[0])).toEqual(['--url', '--min-ms', '--failed', '--limit', '--id']);
    h.ctrl('u');
    h.type('errors --id ');
    expect(h.side().filter((l) => /^[› ] \w/.test(l)).map((l) => l.slice(2))).toEqual(['ab12  Linux · Chrome 63', 'cd34  Linux · Chrome 63']);
    h.key('down');
    h.key('tab');
    expect(h.rows().at(-1)).toMatch(/ on ● cd34$/);
    h.ctrl('u');
    h.type('try j');
    expect(h.picked()).toBe('js');
    h.ctrl('u');
    h.type('shim of');
    expect(h.picked()).toBe('off');
    h.ctrl('u');
    h.type('trial focus');
    expect(h.picked()).toBe('examples/trials/focus-ring.mjs');
  });

  it('keeps the line as typed when it cannot run, and says why', () => {
    const h = harness([dut('ab12')]);
    h.type('probe medai');
    h.key('return');
    expect(box(h)).toBe('probe medai_');
    expect(h.picked()).toBe('media');
    expect(info(h)).toBe('  > probe medai_  ✗ name is one of identity, features, media, graphics, storage, dom, focus, speed');
    h.key('tab');
    expect(box(h)).toBe('probe media_');
    expect(h.side().at(-1)).toMatch(/^costs the device: isTypeSupported and/);
    h.ctrl('u');
    h.type('cpature');
    h.key('return');
    expect(info(h)).toBe('  > cpature_  ✗ no command cpature · did you mean capture?');
    h.ctrl('u');
    h.type('capture 5 foo');
    h.key('return');
    expect(info(h)).toBe('  > capture 5 foo_  ✗ capture takes no word "foo"');
    expect(run).not.toHaveBeenCalled();
    const none = harness();
    none.type('probe media');
    none.key('return');
    expect(none.rows().at(-1)).toMatch(/^ {2}> probe media_ {2}✗ no device connected yet · open http:\/\/192\.168\.1\.20:7070\/ on it/);
  });

  it('runs the command typed when it is a whole name, not a longer one that starts with it', async () => {
    const h = harness([dut('ab12')]);
    run.mockResolvedValue({});
    h.type('device');
    expect(h.at()).toBe('device');
    h.key('return');
    await settle();
    expect(calls()[0]![0].name).toBe('device');
  });

  it('runs the line as typed when the caret was moved back into it, and completes only the word at the caret', async () => {
    const h = harness([dut('ab12')]);
    run.mockResolvedValue({});
    h.type('devices');
    h.key('return');
    await settle();
    h.type('network --failed');
    h.ctrl('a');
    h.key('return');
    await settle();
    // A typo fixed in place, with the caret left in the word.
    h.type('captre 3');
    for (let i = 0; i < 4; i++) h.key('left');
    h.type('u');
    h.key('return');
    await settle();
    // The word at the caret is the whole word: devices stays devices, 10 stays 10, network network.
    h.type('devices');
    h.key('left');
    h.key('return');
    await settle();
    h.type('capture 10');
    h.key('left');
    h.key('return');
    await settle();
    h.type('network');
    h.ctrl('a');
    h.key('return');
    await settle();
    expect(calls().map((c) => [c[0].name, c[1]])).toEqual([
      ['devices', {}],
      ['network', { failed: true }],
      ['capture', { seconds: '3' }],
      ['devices', {}],
      ['capture', { seconds: '10' }],
      ['network', {}],
    ]);
    h.type('probe dom');
    h.key('home');
    h.key('right');
    h.key('right');
    h.key('tab');
    expect(box(h)).toBe('probe_ dom');
  });

  it('runs the capture length typed, which shows as its own row, and with none the default', () => {
    run.mockReturnValue(new Promise(() => {}));
    const capture = (...keys: string[]) => {
      const h = harness([dut('ab12')]);
      for (const k of keys) if (k === '⏎') h.key('return');
      else if (k === '↓') h.key('down');
      else h.type(k);
      return h;
    };
    const one = capture('capture 1');
    expect(one.picked()).toBe('1');
    one.key('return');
    expect(calls().at(-1)![1]).toEqual({ seconds: '1' });
    expect(one.side()).toContainEqual(expect.stringMatching(/ {2}0 s of 1$/));
    // Enter twice is the default capture, which is 10 s.
    const bare = capture('cap', '⏎', '⏎');
    expect(calls().at(-1)![1]).toEqual({});
    expect(bare.side()).toContainEqual(expect.stringMatching(/ {2}0 s of 10$/));
    // 0 is 1 s, as q sends it, not 10.
    const zero = capture('capture 0', '⏎');
    expect(calls().at(-1)![1]).toEqual({ seconds: '0' });
    expect(zero.side()).toContainEqual(expect.stringMatching(/ {2}0 s of 1$/));
    // A length moved to is the one Enter runs.
    capture('cap', '⏎', '↓', '⏎');
    expect(calls().at(-1)![1]).toEqual({ seconds: '5' });
    // Tab still takes a listed length.
    const tab = capture('capture ');
    tab.key('tab');
    expect(box(tab)).toBe('capture 10_');
  });

  it('lists only files that say trial, so Enter never imports a build or deploy script', () => {
    const h = harness([dut('ab12')]);
    h.type('trial ');
    const files = h.side().filter((l) => /^[› ] \S/.test(l)).map((l) => l.slice(2).trim());
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(f).toMatch(/trial/i);
    h.type('build');
    expect(h.picked()).toBeUndefined();
  });

  it('keeps the line on an id no device has, with the ids there are', () => {
    const h = harness([dut('ab12'), dut('cd34')]);
    h.type('capture --id zzz');
    h.key('return');
    expect(box(h)).toBe('capture --id zzz_');
    expect(info(h)).toBe('  > capture --id zzz_  ✗ no device zzz · connected: ab12, cd34');
    expect(run).not.toHaveBeenCalled();
  });

  it('runs a pasted line on Enter, and opens its answer under its entry', async () => {
    const h = harness([dut('ab12')]);
    run.mockResolvedValue({});
    h.paste('npx tlpt q probe media');
    expect(box(h)).toBe('probe media_');
    h.key('return');
    await settle();
    expect(calls()[0]!.slice(1, 6)).toEqual([{ name: 'media' }, 7070, process.cwd(), 'ab12', 'console']);
    expect(h.at()).toBe('probe');
    expect(h.side().slice(2, 5)).toContain('✓ media    14:02  · graphics');
    expect(h.side().at(-1)).toBe('● answer');
  });

  it('opens on a paste, taking off what a copied command starts with', () => {
    const h = harness([dut('ab12')]);
    for (const [pasted, typed] of [['npx tlpt q probe media', 'probe media'], ['tlpt q capture 5\n', 'capture 5'], ['q status', 'status'], ['/keys ok', 'keys ok']]) {
      h.paste(pasted!);
      expect(box(h)).toBe(`${typed}_`);
      h.key('escape');
    }
  });

  it('edits the line: the caret moves, ctrl+w takes a word, backspace on an empty line does nothing', () => {
    const h = harness([dut('ab12')]);
    h.type('probe media');
    h.key('left');
    h.key('left');
    h.type('X');
    expect(box(h)).toBe('probe medX_ia');
    h.key('home');
    h.type('[');
    h.key('end');
    h.ctrl('w');
    expect(box(h)).toBe('[probe _');
    h.ctrl('a');
    h.key('delete');
    expect(box(h)).toBe('_probe');
    h.ctrl('c');
    expect(box(h)).toBe('_');
    h.key('backspace');
    expect(info(h)).toBe("  > _  ↑↓ pick · enter picks a probe · ? help");
    h.paste('x'.repeat(5000));
    h.key('end');
    expect(h.rows().at(-1)).toMatch(/^ {2}> x+_$/);
    // Alt+Backspace takes a word.
    h.ctrl('u');
    h.type('network --url items');
    h.key('backspace', { meta: true });
    expect(box(h)).toBe('network --url _');
  });

  it('pastes tabs as spaces and drops other control characters, which would move the cursor', () => {
    const h = harness([dut('ab12')]);
    h.paste('eval\tvar\ta\x07 = 1;');
    expect(box(h)).toBe('eval var a = 1;_');
  });

  it('draws the caret as an inverse cell with colour', () => {
    const h = harness([dut('ab12')], { color: 'truecolor' });
    h.type('ab');
    h.key('left');
    expect(h.raw().find((l) => strip(l).startsWith('  > '))).toContain('\x1b[7mb\x1b[27m');
  });

  it("logs an answer's first line here, and piped, all of it cut at 60 lines with the command that prints the rest", async () => {
    const h = harness([dut('ab12'), dut('cd34')]);
    answer.mockImplementation(() => Array.from({ length: 75 }, (_, i) => `line ${i}`));
    try {
      run.mockResolvedValue({});
      h.type('probe features');
      h.key('return');
      await settle();
      expect(h.printed()).toEqual(['line 0']);
      expect(h.side()).toEqual(expect.arrayContaining(['line 0', 'line 1']));
      // Piped, nothing is on screen to read it from: the whole answer, cut, ending in a probe's tally.
      const printed: string[] = [];
      const piped = new Console({
        screen: new PlainScreen({ write: (s: string) => printed.push(...s.split('\n').filter(Boolean)) }, () => new Date(T0)),
        color: 'none', port: 7070, key: 'Kq3xT9b2Lm', duts: () => [dut('ab12'), dut('cd34')], dutLink: LINK, openDevtools: () => {}, reload: () => {}, quit: () => {},
      });
      open.push(piped);
      await (piped as unknown as { perform: (...a: unknown[]) => Promise<void> }).perform(COMMANDS.find((c) => c.name === 'probe'), { name: 'features' }, 'cd34', 'probe features');
      expect(printed).toHaveLength(61);
      expect(printed.slice(-3).map((l) => l.trim())).toEqual(['line 58', '… 15 more lines · tlpt probe features --id cd34 prints all of it', 'line 74']);
    } finally {
      answer.mockImplementation(() => ['● answer']);
    }
    run.mockRejectedValueOnce(new Error('the page went away\nat line 1'));
    h.type('probe media');
    h.key('return');
    await settle();
    expect(h.printed().slice(-2)).toEqual(['● /probe media on cd34 failed', '  ⎿ the page went away']);
    expect(h.side().slice(-2)).toEqual(['● /probe media on cd34 failed', '    the page went away']);
  });

  it('will not start a capture or a trial on a device where one already runs', () => {
    const h = harness([dut('ab12')]);
    run.mockReturnValue(new Promise(() => {}));
    h.hot('c');
    h.type('trial examples/trials/focus-ring.mjs');
    h.key('return');
    expect(info(h)).toContain('✗ a capture is running on ab12');
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('console helpers', () => {
  it('fits as many parts as the width takes', () => {
    expect(fit('head', ['one', 'two', 'three'], 18)).toBe('head   one   two');
    expect(fit('head', ['one', 'two', 'three'], 18, '  ')).toBe('head  one  two');
  });
  it('splits words like a shell, quotes grouping', () => {
    expect(splitWords(`eval "navigator.userAgent" --id 'ab 12'`)).toEqual(['eval', 'navigator.userAgent', '--id', 'ab 12']);
  });
});
