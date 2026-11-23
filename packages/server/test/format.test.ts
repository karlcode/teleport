import { afterEach, describe, expect, it } from 'vitest';
import type { Report } from '../src/analyze.js';
import { block, formatCapabilities, formatKeys, formatTrial, humanize, ms, rows, spark, table, type DeviceSnapshot, type LiveDut, type NetworkRow } from '../src/format.js';
import { guide } from '../src/guide.js';
import type { DeviceInfo, DeviceStats, Point } from '../src/live.js';
import type { Capabilities, DomReport, FocusReport, StorageReport } from '../src/probes.js';
import { parseSteps, type RemoteRun } from '../src/remote.js';
import { strip, width } from '../src/text.js';
import type { TrialReport } from '../src/trial.js';
import { G, paint, setGlyphs } from '../src/tui.js';

const p = paint('none');
const text = (lines: string[]) => lines.map(strip).join('\n');

const ARM = 'Mozilla/5.0 (X11; Linux armv7l) AppleWebKit/537.36 (KHTML, like Gecko) Version/5.0 Safari/537.36 Chrome/63.0.3239.84';
const ARM64 = 'Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/53.0.2785.34 Safari/537.36';
const PAGE = 'http://192.168.1.20:7070';

const point = (t: number, o: Partial<Point> = {}): Point => ({
  t, overheadPct: 0.07, lagMs: 3, longTaskMs: 0, longTasks: 0, heapMB: 170 + t / 7000, heapTotalMB: 200, videoDroppedPerS: null, videoDecodedPerS: null,
  resources: 0, resourceKB: 0, keys: 0, keyToFrameMs: null, fps: null, frameP95Ms: null, wireBytes: 90, agentQueuedKB: 0, inspectorQueuedKB: null,
  inspectorPct: null, level: 0, heapLimitMB: 256, domNodes: 1842, devtoolsLagMs: null, ...o,
});
const info = (id: string, o: Partial<DeviceInfo> = {}): DeviceInfo => ({ id, href: `${PAGE}/`, ua: ARM, ip: '192.168.1.42', inspecting: true, inspect: '', devtools: '', started: 0, governor: { level: 0, reason: '' }, errors: 0, ...o });
const stats: DeviceStats = { frames: 1212, badFrames: 0, unread: 0, bytesIn: 1, inspectorBytesIn: 0, dropped: {}, offsetMs: -1.7e12, rttMs: 12, names: 4 };

const live: LiveDut[] = [
  { device: info('k3x9q2ab'), latest: point(0, { lagMs: 4, heapMB: 212.4, heapLimitMB: 512, keyToFrameMs: 41 }), stats },
  { device: info('p7m2d4cf', { ua: ARM64, ip: '192.168.1.43', inspecting: false }), latest: point(0, { lagMs: 640, longTasks: 3, longTaskMs: 1380, heapMB: 446.1, heapLimitMB: 512, domNodes: 4210 }), stats: { ...stats, badFrames: 2, rttMs: 180, dropped: { input: 3 } } },
];

const snapshot: DeviceSnapshot = {
  device: info('k3x9q2ab'),
  latest: null,
  points: Array.from({ length: 90 }, (_, i) =>
    point(i * 1000, i === 30 ? { longTaskMs: 212, longTasks: 1 } : i === 50 ? { longTaskMs: 168, longTasks: 2, keys: 2, keyToFrameMs: 183 } : i % 9 === 0 ? { keys: 1, keyToFrameMs: 40 + i } : {}),
  ),
  keyTargets: [
    { target: 'div.tile in #rail-trending', keys: 8, p50Ms: 96, p95Ms: 183, maxMs: 190, phases: { inputDelay: 2, handlers: 38, waitFrame: 10, raf: 1, style: 9, layout: 21, paint: 18 } },
    { target: 'input#search', keys: 3, p50Ms: 41, p95Ms: 52, maxMs: 60, phases: null },
  ],
  stats: { ...stats, rttMs: 38 },
  requests: [
    { id: 'p1', method: 'GET', url: `${PAGE}/`, status: 200, type: 'Document', mimeType: 'text/html', start: 0, ttfb: 10, end: 42, bytes: 3100 },
    { id: 'p2', method: 'GET', url: `${PAGE}/api/rails`, status: 500, type: 'XHR', mimeType: 'application/json', start: 50, ttfb: 1800, end: 1890, bytes: 0 },
  ],
};

const capture: Report = {
  from: 0, to: 10000, seconds: 10,
  frames: { count: 541, fps: 54.1, p50Ms: 16.7, p95Ms: 33.4, p99Ms: 50, maxMs: 160, over33Ms: 6, over50Ms: 4 },
  longTasks: { count: 4, totalMs: 600, maxMs: 150, msPerS: 60 },
  lag: { p50Ms: 1, p95Ms: 3, maxMs: 152 },
  input: { keys: 7, p50Ms: 41, p95Ms: 88, maxMs: 160, noFrame: 1 },
  video: [{ el: 1, decodedPerS: 29.97, droppedPerS: 0.4, dropPct: 1.3 }],
  heap: { usedMB: 212.4, minMB: 208, maxMB: 216, mbPerMin: 1.2 },
  overhead: { pct: 0.3, workMs: 30 },
  resources: { count: 3, bytes: 49152, slowest: [{ name: `${PAGE}/api/rails`, durMs: 420, ttfbMs: 400 }, { name: `${PAGE}/img/hero.jpg`, durMs: 210, ttfbMs: null }] },
  vsync: null,
};
const idle: Report = { ...capture, frames: null, input: null, video: [], heap: null, overhead: null, lag: { p50Ms: null, p95Ms: null, maxMs: null }, longTasks: { count: 0, totalMs: 0, maxMs: 0, msPerS: 0 }, resources: { count: 0, bytes: 0, slowest: [] } };

const S = (median: number) => ({ n: 5, median, p95: median, min: median, max: median });
const trial: TrialReport = {
  name: 'focus ring', device: { id: 'k3x9q2ab', ua: ARM, engine: 'Linux · Chrome 63' }, startedAt: 0, ms: 108_000, truncated: false,
  notes: ['Not measured on this engine: long tasks (it has no longtask PerformanceObserver).', 'box-shadow: each key press takes about 36 ms longer to reach the screen on this device, which a person feels as a slower remote.'],
  variants: [
    { name: 'outline', runs: 5, ok: 5, errors: [], numbers: { keyFrameMs: S(61), frameP95Ms: S(18.4), layoutMs: S(3.1) }, values: {} },
    { name: 'box-shadow', runs: 5, ok: 5, errors: [], numbers: { keyFrameMs: S(97), frameP95Ms: S(33.1), layoutMs: S(3) }, values: {} },
    { name: 'border', runs: 5, ok: 5, errors: [], numbers: { keyFrameMs: S(60), frameP95Ms: S(18), layoutMs: S(2.2) }, values: {} },
  ],
  compare: [
    { metric: 'keyFrameMs', variant: 'box-shadow', baseline: 'outline', diff: 36, lo: 21, hi: 50, better: 'no', text: '' },
    { metric: 'frameP95Ms', variant: 'box-shadow', baseline: 'outline', diff: 14.7, lo: 9.9, hi: 20, better: 'no', text: '' },
    { metric: 'layoutMs', variant: 'border', baseline: 'outline', diff: -0.9, lo: -1.4, hi: -0.4, better: 'yes', text: '' },
    { metric: 'layoutMs', variant: 'box-shadow', baseline: 'outline', diff: -0.1, lo: -0.5, hi: 0.3, better: null, text: '' },
    { metric: 'keyFrameMs', variant: 'border', baseline: 'outline', diff: -1, lo: -4, hi: 3, better: null, text: '' },
  ],
  checks: { outlineOffset: true, willChange: false, boxShadowInset: true },
  checksError: null,
  samples: Array.from({ length: 15 }, (_, i) => ({ variant: ['outline', 'box-shadow', 'border'][i % 3]!, round: Math.floor(i / 3), ok: i !== 4, metrics: {}, error: null, uncaught: [], ms: 5 })),
};

const media: Capabilities = {
  groups: [
    { id: 'mse', label: 'media source · isTypeSupported', items: [['h.264 high', true], ['h.264 high 5.1 (4k)', true], ['hevc main 10', true], ['av1 (mp4)', false], ['e-ac-3', true], ['opus (webm)', false]].map(([label, v]) => ({ k: String(label), label: String(label), v: v as boolean, what: '' })) },
    {
      id: 'eme', label: 'encrypted media', items: [
        { k: 'widevine', label: 'widevine', v: 'HW_SECURE_ALL', what: '' }, { k: 'playready', label: 'playready', v: 3000, what: '' }, { k: 'clearkey', label: 'clearkey', v: true, what: '' },
        { k: 'fairplay', label: 'fairplay', v: 'no', what: '' }, { k: 'persistent', label: 'widevine persistent license', v: null, what: '' },
      ],
    },
    { id: 'gpu', label: 'webgl', items: [{ k: 'renderer', label: 'gpu renderer', v: 'Mali-G52 MC1 OpenGL ES 3.2 v1.r20p0-01rel0.git', what: '' }, { k: 'ua', label: 'user agent', v: ARM, what: '' }] },
  ],
  ms: 30,
  wallMs: 412,
};

const storage: StorageReport = {
  local: { count: 14, bytes: 4300, capped: false, entries: Array.from({ length: 14 }, (_, i) => ({ key: `key${i}`, preview: i === 0 ? 'line one\nline two \x1b[31mred' : `value ${i}`, bytes: 300, full: null })) },
  session: { count: 1, bytes: 40, capped: false, entries: [{ key: 'tab', preview: 'k3x9q2ab', bytes: 40, full: 'k3x9q2ab' }] },
  cookies: { count: 3, bytes: 310, entries: [] },
  indexedDB: { databases: [{ name: 'keyval', version: 1, stores: [{ name: 'store', count: 40 }] }, { name: 'player', version: 2, stores: [{ name: 'tracks', count: 12 }, { name: 'art', count: 3 }] }], capped: false },
  caches: [],
  workers: null,
  quota: { usageBytes: 1258291, quotaBytes: 125829120, persisted: false },
  ms: 10,
  wallMs: 12,
};
const dom: DomReport = { elements: 1842, textNodes: 612, depth: 23, deepest: 'span in div.card', largest: { path: 'main#app', descendants: 1200 }, widest: { path: 'ul.rail', children: 48 }, counts: { img: 40, video: 1, audio: 0, iframe: 0, canvas: 0, svg: 3, script: 12, style: 2, link: 1 }, stylesheets: 4, rules: 820, ms: 4 };
const focus: FocusReport = { active: 'div.tile in #rail-trending', marked: 'div.tile in #rail-trending', selector: '.focused, [data-focus]', tabindex: 0, box: [120, 340, 300, 200], focusable: 42, ms: 1 };

const network: NetworkRow[] = [
  { method: 'GET', url: `${PAGE}/`, status: 200, bytes: 3174, ttfbMs: 20, durMs: 42 },
  { method: 'GET', url: `${PAGE}/static/js/main.3f2a9c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1.chunk.js`, status: 200, bytes: 421888, ttfbMs: 30, durMs: 412 },
  { method: 'GET', url: `${PAGE}/api/rails?page=2`, status: 503, bytes: 0, ttfbMs: 1200, durMs: 1240 },
  { method: 'POST', url: `${PAGE}/v1/collect`, status: 0, bytes: 0, ttfbMs: 0, durMs: 2010, failed: 'socket hang up' },
];

const run = (phase: RemoteRun['phase'], presses: number, error: string | null = null): RemoteRun => ({ steps: parseSteps('right,right,ok'), loop: false, phase, step: 0, press: 0, presses, error });

/** Every command's answer, as humanize gets it: [name, args, data, id]. */
const answers: [string, Record<string, unknown>, unknown, string | undefined][] = [
  ['status', {}, live, undefined],
  ['status', {}, [], undefined],
  ['devices', {}, live, undefined],
  ['device', {}, snapshot, undefined],
  ['device', {}, { ...snapshot, points: [], keyTargets: [], requests: [] }, undefined],
  ['capture', {}, capture, 'k3x9q2ab'],
  ['capture', {}, idle, 'k3x9q2ab'],
  ['probe', { name: 'media' }, media, 'k3x9q2ab'],
  ['probe', { name: 'storage' }, storage, 'k3x9q2ab'],
  ['probe', { name: 'dom' }, dom, 'k3x9q2ab'],
  ['probe', { name: 'focus' }, focus, 'k3x9q2ab'],
  ['trial', {}, trial, undefined],
  ['trial', {}, { ...trial, compare: [], notes: [], checks: null, checksError: 'ReferenceError: CSS is not defined, so the checks could not be read on this engine at all' }, undefined],
  ['network', {}, network, 'k3x9q2ab'],
  ['network', { failed: true }, [], 'k3x9q2ab'],
  ['keys', { sequence: ['right', 'right', 'ok'] }, run('done', 3), 'k3x9q2ab'],
  ['keys', {}, run('stopped', 2), 'k3x9q2ab'],
  ['keys', {}, run('failed', 1, 'nothing matches #menu, so the click step could not find an element to press on this page'), 'k3x9q2ab'],
  ['eval', { expression: 'document.title' }, { value: 'Home' }, 'k3x9q2ab'],
  ['eval', { expression: 'performance.timing' }, { value: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`field${i}`, i])) }, 'k3x9q2ab'],
  ['eval', { expression: 'navigator.userAgent' }, { value: ARM.repeat(3) }, 'k3x9q2ab'],
  ['guide', { words: '' }, guide(''), undefined],
  ['guide', { words: 'polyfills' }, guide('polyfills'), undefined],
];

afterEach(() => setGlyphs(false));

describe('answers as a person reads them', () => {
  it('draws values as bars, with gaps for what was not measured', () => {
    expect(spark([0, 5, 10])).toBe('▁▅█');
    expect(spark([null, 1])).toBe(' █');
    expect(spark([0, 0])).toBe('▁▁');
    expect(spark([500], 1000)).toBe('▅');
  });

  it('writes ms with one decimal under 100 and whole from 100', () => {
    expect([ms(16.67), ms(41), ms(99.94), ms(160.4), ms(null)]).toEqual(['16.7 ms', '41 ms', '99.9 ms', '160 ms', '–']);
  });

  it('nests detail under a bullet, cuts the head, and wraps reasons with a hanging indent when asked', () => {
    const lines = block(p, 30, 'capture · ab12 · 10 s · 7 key presses', ['58 fps · frame p95 18 ms · 0 over 50 ms and more']);
    expect(lines[0]).toBe('● capture · ab12 · 10 s · 7 …');
    expect(lines[1]!.startsWith('  ⎿ 58 fps')).toBe(true);
    for (const l of lines) expect(width(l)).toBeLessThanOrEqual(29);
    const wrapped = block(paint('truecolor'), 30, 'remote failed', [paint('truecolor').bad('nothing matches #menu on this page at all')], 'bad', { wrap: true });
    expect(wrapped.map(strip)).toEqual(['● remote failed', '  ⎿ nothing matches #menu on', '    this page at all']);
    // The red is reopened on the wrapped line rather than lost.
    expect(wrapped[2]).toContain('\x1b[38;2;240;110;90m');
  });

  it('marks a routine line with a faint dot and mutes it', () => {
    expect(block(p, 80, 'k3x9q2ab reloaded', [], 'faint')).toEqual(['· k3x9q2ab reloaded']);
  });

  it('lays rows out in a faint label column at least 12 wide, wrapping parts under the value', () => {
    expect(rows(p, 100, [['frames', ['54.1 fps', 'p50 16.7']], ['teleport', 'its agent used 0.3%']])).toEqual(['frames      54.1 fps · p50 16.7', 'teleport    its agent used 0.3%']);
    expect(rows(p, 40, [['localStorage', ['12 keys', '4.2 KB', 'sessionStorage 1 key']]])).toEqual(['localStorage  12 keys · 4.2 KB', '              sessionStorage 1 key']);
  });

  it('pads table columns to their widest cell', () => {
    expect(table(p, 80, ['a', 'bb'], [['xxx', 'y']], 0)).toEqual(['a    bb', 'xxx  y']);
  });

  it('reports a capture in rows, and says what to do when nothing was drawn or pressed', () => {
    const out = text(humanize('capture', {}, capture, 'k3x9q2ab', p, 100, { href: `${PAGE}/` }));
    expect(out).toContain('● capture k3x9q2ab · 10 s · 7 key presses');
    // A page that went away mid-capture: what was recorded, of what was asked, and why.
    const cut = text(humanize('capture', {}, { ...capture, seconds: 3.2, cutShort: { askedS: 10, why: 'the page went away' } }, 'k3x9q2ab', p, 100));
    expect(cut).toContain('● capture k3x9q2ab · 3.2 s of 10 · the page went away · 7 key presses');
    expect(out).toContain('  ⎿ frames      54.1 fps · p50 16.7 · p95 33.4 · worst 160 ms · 6 over 33 ms · 4 over 50 ms');
    expect(out).toContain('    main        4 long tasks, 600 ms · worst 150 ms · timer lag p95 3 ms, worst 152 ms');
    expect(out).toContain('    keys        key → frame p50 41 · p95 88 · worst 160 ms · 1 drew nothing');
    expect(out).toContain('    heap        212 MB (208 to 216) · +1.2 MB/min');
    expect(out).toContain('    video       30 frames/s decoded · 0.4 dropped/s, 1.3%');
    expect(out).toContain('    requests    3 · 48 KB · slowest /api/rails 420 ms · /img/hero.jpg 210 ms');
    expect(out).toContain('    teleport    its agent used 0.3% of the main thread');
    const none = text(humanize('capture', {}, idle, 'k3x9q2ab', p, 100));
    expect(none).toContain('frames      none drawn: the page was idle, or has no requestAnimationFrame');
    expect(none).toContain('keys        none pressed · press keys on the device during a capture');
    // fps of 50 and up is the one green value in a capture.
    expect(humanize('capture', {}, capture, 'k3x9q2ab', paint('truecolor'), 100).join('\n')).toContain('\x1b[38;2;120;200;140m54.1 fps');
  });

  it('reports a trial: checks, clear differences with medians, interval and verdict, the rest counted, notes wrapped', () => {
    const lines = formatTrial(trial, p, 100);
    const out = text(lines);
    expect(out).toContain('● trial focus ring k3x9q2ab · 1 failed · Linux · Chrome 63 · 3 variants, 5 runs each · 1 min 48 s');
    expect(out).toContain('  ⎿ checks      outlineOffset yes · willChange no · boxShadowInset yes');
    expect(out).toContain('    clear differences from outline (medians; 95% interval of the change)');
    expect(out).toMatch(/^ {6}box-shadow {3}frame time p95 {3}18\.4 → 33\.1 ms {3}\+14\.7 ms {3}\+9\.9 to \+20 {4}worse$/m);
    expect(out).toMatch(/^ {6}box-shadow {3}key → frame {6}61 → 97 ms {7}\+36 ms {5}\+21 to \+50 {5}worse$/m);
    expect(out).toMatch(/^ {6}border {7}forced layout {4}3\.1 → 2\.2 ms {5}-0\.9 ms {4}-1\.4 to -0\.4 {3}better$/m);
    // Sorted by the change as a share of the baseline: frame time p95 moved most.
    expect(out.indexOf('frame time p95')).toBeLessThan(out.indexOf('key → frame'));
    expect(out).toContain('    no clear difference on the other 2 comparisons');
    expect(out).toContain('    · Not measured on this engine: long tasks (it has no longtask PerformanceObserver).');
    expect(out).toMatch(/· box-shadow: each key press .*\n {6}\S/);
    const t = formatTrial(trial, paint('truecolor'), 100).join('\n');
    expect(t).toContain('\x1b[38;2;120;200;140mbetter');
    expect(t).toContain('\x1b[38;2;240;110;90mworse');
    // Narrower, the verdict and the change stay, the medians go and then the interval, and the
    // header says only what is left.
    const narrow = text(formatTrial(trial, p, 66));
    expect(narrow).toMatch(/box-shadow\s+key → frame\s+\+36 ms\s+\+21 to \+50\s+worse/);
    expect(narrow).toContain('clear differences from outline (95% interval of the change)');
    expect(narrow).not.toContain('61 → 97');
    const narrowest = text(formatTrial(trial, p, 60));
    expect(narrowest).toMatch(/box-shadow\s+key → frame\s+\+36 ms\s+worse/);
    expect(narrowest).toMatch(/clear differences from outline$/m);
  });

  it('says a trial had failed runs where a narrow head still shows it, amber when only some failed', () => {
    const t = paint('truecolor');
    expect(strip(formatTrial(trial, t, 60)[0]!)).toMatch(/^● trial focus ring k3x9q2ab · 1 failed · /);
    expect(formatTrial(trial, t, 80)[0]).toMatch(/^\x1b\[38;2;242;173;72m●/);
    const stopped = strip(formatTrial({ ...trial, truncated: true }, t, 60)[0]!);
    expect(stopped).toMatch(/^● trial focus ring k3x9q2ab · 1 failed · stopped early · /);
    const allFailed = { ...trial, samples: trial.samples.map((x) => ({ ...x, ok: false })) };
    expect(formatTrial(allFailed, t, 80)[0]).toMatch(/^\x1b\[38;2;240;110;90m●/);
    expect(formatTrial({ ...trial, samples: trial.samples.map((x) => ({ ...x, ok: true })) }, t, 80)[0]).not.toMatch(/^\x1b\[38;2;(242|240)/);
  });

  it('counts the clear differences past the eighth, rather than leave them out without a word', () => {
    const many: TrialReport['compare'] = Array.from({ length: 11 }, (_, i) => ({ metric: `m${i}`, variant: 'box-shadow', baseline: 'outline', diff: 1 + i, lo: 0.5, hi: 2 + i, better: null, text: '' }));
    const out = text(formatTrial({ ...trial, compare: [...many, ...trial.compare.slice(3)] }, p, 100));
    expect(out.match(/^ {6}box-shadow {3}m\d+/gm)).toHaveLength(8);
    // Named, with their change, so they can be read here and in the console without a rerun.
    expect(out).toMatch(/^ {4}and 3 more: box-shadow m\d+ \+\d+, box-shadow m\d+ \+\d+, box-shadow m\d+ \+\d+$/m);
    expect(out).toContain('    no clear difference on the other 2 comparisons');
  });

  it('shows a clear difference under 0.05 in two digits, not as 0 → 0', () => {
    const variants = trial.variants.map((v, i) => ({ ...v, numbers: { ...v.numbers, shiftScore: S([0.012, 0.041, 0.01][i]!) } }));
    const compare = [{ metric: 'shiftScore', variant: 'box-shadow', baseline: 'outline', diff: 0.029, lo: 0.021, hi: 0.044, better: null, text: '' }];
    expect(text(formatTrial({ ...trial, variants, compare }, p, 100))).toMatch(/box-shadow {3}shiftScore {3}0\.012 → 0\.041 {3}\+0\.029 {3}\+0\.021 to \+0\.044/);
  });

  it('keeps the change and the verdict on a narrow trial table: the variant goes when there is one, then the name is cut', () => {
    const two: TrialReport = {
      ...trial,
      variants: trial.variants.slice(0, 2).map((v) => ({ ...v, name: v.name === 'box-shadow' ? 'box-shadow-with-a-long-variant-name' : v.name })),
      compare: [
        { metric: 'longTaskMs', variant: 'box-shadow-with-a-long-variant-name', baseline: 'outline', diff: 357, lo: 210, hi: 480, better: 'no', text: '' },
        { metric: 'imagesBroken', variant: 'box-shadow-with-a-long-variant-name', baseline: 'outline', diff: 3, lo: 1, hi: 4, better: 'no', text: '' },
      ],
      samples: trial.samples.map((x) => ({ ...x, ok: true })),
    };
    for (const cols of [40, 50, 66, 80]) {
      const lines = formatTrial(two, p, cols);
      const rowsOf = text(lines).split('\n').filter((l) => /\+357 ms|\+3 /.test(l));
      expect(rowsOf, `${cols}`).toHaveLength(2);
      for (const l of rowsOf) expect(l, `${cols}: ${l}`).toMatch(/worse$/);
      for (const l of lines) expect(width(l)).toBeLessThanOrEqual(cols - 1);
    }
    const narrow = text(formatTrial(two, p, 40));
    expect(narrow.replace(/\s+/g, ' ')).toContain('clear differences of box-shadow-with-a-long-variant-name from outline');
    expect(narrow).toMatch(/^ {6}images that didn… {2}\+3 {7}worse$/m);
    expect(narrow).not.toMatch(/^ {6}box-s/m);
    // Two variants: the one name goes to the line above before any number goes from the rows.
    const wide = text(formatTrial(two, p, 100));
    expect(wide.replace(/\s+/g, ' ')).toContain('clear differences of box-shadow-with-a-long-variant-name from outline (medians; 95% interval of the change)');
    expect(wide).toMatch(/^ {6}long tasks +– → – ms +\+357 ms +\+210 to \+480 +worse$/m);
    expect(text(formatTrial(two, p, 80))).toMatch(/^ {6}long tasks .*\+357 ms +\+210 to \+480 +worse$/m);
  });

  it('cuts names apart around where they differ, by characters, and never to nothing', () => {
    const cuts = (names: string[], w: number) => {
      const t: TrialReport = {
        ...trial,
        variants: [trial.variants[0]!, ...names.map((n) => ({ ...trial.variants[1]!, name: n }))],
        compare: names.map((n, i) => ({ metric: 'longTaskMs', variant: n, baseline: 'outline', diff: 100 + i, lo: 50, hi: 150 + i, better: 'no' as const, text: '' })),
      };
      return text(formatTrial(t, p, w)).split('\n').filter((l) => /\+1\d\d ms/.test(l)).map((l) => l.trim().split(/\s{2,}/)[0]!);
    };
    for (const names of [['lazy-images', 'lazy-iframes', 'eager'], ['focus-scale-ring', 'focus-scale-glow-ring'], ['card 🔴 shadow glow', 'card 🟢 shadow glow'], ['hero-image-webp-preload', 'hero-image-avif-preload', 'third']]) {
      const got = cuts(names, 40);
      // A name that fits stays whole.
      if (names.includes('third')) expect(got).toContain('third');
      expect(new Set(got).size, `${names}: ${got}`).toBe(names.length);
      for (const g of got) expect(g, `${names}: ${got}`).not.toMatch(/^…*$|\uFFFD|\p{Cs}/u);
    }
  });

  it('names a variant in the "and N more" line so it stands for that one alone', () => {
    const names = ['menu-anim-none-fast', 'menu-anim-transform-fast', 'menu-anim-opacity-fast'];
    const t: TrialReport = {
      ...trial,
      variants: trial.variants.map((v, i) => ({ ...v, name: names[i]! })),
      compare: Array.from({ length: 12 }, (_, i) => ({ metric: `m${i}`, variant: names[i < 2 ? 2 : 1]!, baseline: names[0]!, diff: 1 + i, lo: 0.5, hi: 2 + i, better: null, text: '' })),
    };
    for (const cols of [80, 120]) {
      const more = text(formatTrial(t, p, cols)).split('\n').filter((l) => /^ {4}and \d+ more/.test(l) || /^ {4}\S/.test(l)).join(' ');
      // All four are transform's; the name used fits no other variant.
      expect(more, `${cols}`).toMatch(/and 4 more: menu-ani…rm-fast m\d+/);
      expect(more, `${cols}`).not.toMatch(/ne-fast m|ty-fast m/);
    }
  });

  it('names each variant whole when there is room, and cut apart when there is not', () => {
    const names = ['hero-image-png-preload', 'hero-image-webp-preload', 'hero-image-avif-preload'];
    const three: TrialReport = {
      ...trial,
      variants: trial.variants.map((v, i) => ({ ...v, name: names[i]! })),
      compare: [
        { metric: 'longTaskMs', variant: names[1]!, baseline: names[0]!, diff: 311, lo: 200, hi: 420, better: 'no', text: '' },
        { metric: 'longTaskMs', variant: names[2]!, baseline: names[0]!, diff: 156, lo: 90, hi: 220, better: 'no', text: '' },
      ],
    };
    for (const cols of [100, 120]) {
      const out = text(formatTrial(three, p, cols));
      expect(out, `${cols}`).toMatch(/^ {6}hero-image-webp-preload +long tasks .*\+311 ms/m);
      expect(out, `${cols}`).toMatch(/^ {6}hero-image-avif-preload +long tasks .*\+156 ms/m);
    }
    for (const cols of [40, 50]) {
      const rowsOf = text(formatTrial(three, p, cols)).split('\n').filter((l) => /\+311 ms|\+156 ms/.test(l));
      expect(rowsOf, `${cols}`).toHaveLength(2);
      // Cut around the part that differs, so the two rows don't read the same; the verdict stays.
      expect(rowsOf[0]!.trim().split(/\s{2,}/)[0]).not.toBe(rowsOf[1]!.trim().split(/\s{2,}/)[0]);
      expect(rowsOf[0]).toMatch(/webp/);
      expect(rowsOf[1]).toMatch(/avif/);
      for (const l of rowsOf) expect(l, `${cols}: ${l}`).toMatch(/worse$/);
    }
  });

  it('lays a capability probe out as ✓ ✗ – in 3, 2 or 1 columns, with long values on rows of their own', () => {
    const wide = text(formatCapabilities('media', media, p, 100, { id: 'k3x9q2ab' }));
    expect(wide).toContain('● probe media k3x9q2ab · 412 ms on the device');
    expect(wide).toContain('  ⎿ media source · isTypeSupported');
    expect(wide).toMatch(/^ {6}✓ h\.264 high +✓ h\.264 high 5\.1 \(4k\) +✓ hevc main 10$/m);
    expect(wide).toMatch(/^ {6}✗ av1 \(mp4\) +✓ e-ac-3 +✗ opus \(webm\)$/m);
    expect(wide).toMatch(/✓ widevine {2}HW_SECURE_ALL +✓ playready {2}3000 +✓ clearkey/);
    expect(wide).toMatch(/^ {6}✗ fairplay +– widevine persistent license$/m);
    expect(wide).toMatch(/^ {6}✓ gpu renderer {2}Mali-G52 MC1 OpenGL ES 3\.2 v1\.r20p0-01rel0\.git$/m);
    // A user agent is never cut: it wraps under its value.
    expect(wide).toMatch(/✓ user agent {2}Mozilla\/5\.0 .*\n {20}Version\/5\.0 Safari\/537\.36 Chrome\/63\.0\.3239\.84$/m);
    expect(wide).toContain("    9 ✓ · 3 ✗ · 1 – the engine can't say");
    expect(text(formatCapabilities('media', media, p, 80))).toMatch(/^ {6}✓ h\.264 high +✓ h\.264 high 5\.1 \(4k\)$/m);
    expect(text(formatCapabilities('media', media, p, 60))).toMatch(/^ {6}✓ h\.264 high$/m);
    const t = formatCapabilities('media', media, paint('truecolor'), 100).join('\n');
    expect(t).toContain('\x1b[38;2;149;155;121m✗ av1 (mp4)');
  });

  it('shows storage, dom and focus in rows, and keeps what a page stored from moving the cursor', () => {
    const s = text(humanize('probe', { name: 'storage' }, storage, 'k3x9q2ab', p, 100));
    expect(s).toContain('● probe storage k3x9q2ab · 12 ms on the device');
    expect(s).toContain('  ⎿ localStorage    14 keys · 4.2 KB');
    expect(s).toContain('    sessionStorage  1 key · 40 B');
    expect(s).toContain('    cookies         3 · 310 B');
    expect(s).toContain('    IndexedDB       keyval (store 40) · player (tracks 12, art 3)');
    expect(s).toContain('    Cache Storage   none');
    expect(s).toContain('    quota           1.2 MB of 120 MB');
    expect(s).toMatch(/local\s+key0\s+300 B\s+line one line two \[31mred/);
    expect(s).not.toContain('\x1b');
    expect(s).toContain('and 3 more: tlpt probe storage --json prints them all');
    // A long key is cut in the middle, so every row keeps its size and value at 80 columns.
    const long = { ...storage, local: { ...storage.local!, entries: [{ key: 'CognitoIdentityServiceProvider.4abc123def5678ghi.LastAuthUser', preview: 'someone@example.com', bytes: 180, full: null }, ...storage.local!.entries.slice(1, 3)] } };
    const narrow = text(humanize('probe', { name: 'storage' }, long, 'k3x9q2ab', p, 80));
    expect(narrow).toMatch(/local +Cognit\S*…\S*AuthUser +180 B +someone@example\.com$/m);
    expect(narrow).toMatch(/local +key1 +300 B +value 1$/m);
    const d = text(humanize('probe', { name: 'dom' }, dom, 'k3x9q2ab', p, 100));
    expect(d).toContain('● probe dom k3x9q2ab · 1842 elements · 4 ms on the device');
    expect(d).toContain('    widest      ul.rail · 48 children');
    expect(d).toContain('    tags        img 40 · video 1 · svg 3 · script 12 · style 2 · link 1');
    const f = text(humanize('probe', { name: 'focus' }, focus, 'k3x9q2ab', p, 100));
    expect(f).toContain('  ⎿ DOM focus    div.tile in #rail-trending');
    expect(f).toContain('    box          300 by 200 px at 120, 340');
  });

  it('shows how fast a device is: each piece of work, how it compares with this laptop, and a rough number as rough', () => {
    const speed = { js: 16.3, json: 13.1, dom: 27.6, layout: 3224.8, runs: { js: 5, json: 5, dom: 5, layout: 1 }, laptop: { js: 2.4, json: 0.5 }, ms: 3576, wallMs: 3665 };
    expect(text(humanize('probe', { name: 'speed' }, speed, 'k3x9q2ab', p, 100))).toBe(
      [
        '● probe speed k3x9q2ab · 3576 ms on the device',
        '  ⎿ js          16.3 ms · arithmetic and array work in script · 6.8 times this laptop',
        '    json        13.1 ms · stringify and parse of a 2,000-item list · 26 times this laptop',
        '    dom         27.6 ms · 2,000 elements made, attached and removed',
        '    layout      3.2 s · 200 forced layouts of 500 boxes · 1 run',
      ].join('\n'),
    );
    // Work the engine couldn't do has no number, and nothing is divided by a laptop time of nothing.
    const none = text(humanize('probe', { name: 'speed' }, { ...speed, dom: null, runs: { ...speed.runs, dom: 0 }, laptop: { js: 0, json: 0 } }, 'k3x9q2ab', p, 100));
    expect(none).toContain("    dom         couldn't run on this engine");
    expect(none).not.toContain('this laptop');
  });

  it("shows a device's last minute: bars over the whole window, the heap trend, and where key time goes by element", () => {
    const out = text(humanize('device', {}, snapshot, undefined, p, 100));
    expect(out).toContain('● device k3x9q2ab · Linux · Chrome 63 · last 90 s');
    expect(out).toContain('  ⎿ 192.168.1.42 · DevTools open · rtt 38 ms · 1842 nodes · its agent used 0.07% of the main thread');
    expect(out).toMatch(/^ {4}main {9}[▁▂▃▄▅▆▇█]{36} {2}worst 212 ms · 3 long tasks, 380 ms$/m);
    expect(out).toMatch(/^ {4}heap {9}[▁▂▃▄▅▆▇█]{36} {2}183\/256 MB · \+8\.6 MB\/min · full in ~9 min$/m);
    expect(out).toMatch(/^ {4}key → frame {2}[▁▂▃▄▅▆▇█ ]{36} {2}12 presses · worst 183 ms$/m);
    expect(out).toMatch(/^ {4}by element {3}presses {3}p50 {5}p95 {6}where the time goes {7}element$/m);
    expect(out).toMatch(/^ {17}8 {9}96 ms {3}183 ms {3}handlers 38 · layout 21 {3}div\.tile in #rail-trending$/m);
    expect(out).toMatch(/^ {17}3 {9}41 ms {3}52 ms {4}– {25}input#search$/m);
    // Narrower, the element keeps its column and the median and phases go.
    expect(text(humanize('device', {}, snapshot, undefined, p, 60))).toMatch(/^ {4}by element {3}presses {2}p95 {5}element$/m);
    expect(out).toContain('    requests     2 · 1 failed · slowest GET /api/rails 1840 ms · network lists them');
    expect(text(humanize('device', {}, { ...snapshot, points: [] }, undefined, p, 100))).toContain('no samples yet');
    // At 40 columns a spark and its value no longer fit as one, and the value keeps its unit.
    const big = { ...snapshot, points: snapshot.points.map((x, i) => (i === 30 ? { ...x, longTaskMs: 1275 } : { ...x, heapMB: 2770, heapLimitMB: 4096 })) };
    const at40 = text(humanize('device', {}, big, undefined, p, 40));
    expect(at40).toMatch(/worst 1275 ms/);
    expect(at40).toMatch(/2770\/4096 MB/);
    expect(at40).not.toMatch(/^ *(ms|MB)\b/m);
  });

  it('says each device in a line of its own, word for word what status said, and the link for devices', () => {
    const out = text(humanize('devices', {}, live, undefined, p, 100));
    expect(out).toContain('● k3x9q2ab  Linux · Chrome 63 · 192.168.1.42 · DevTools open');
    expect(out).toContain('  ⎿ timer lag 4 ms · no long tasks · heap 212.4 MB of 512 · 1842 nodes · key → frame 41 ms');
    expect(out).toContain('    link        1212 frames, none bad · rtt 12 ms · nothing lost');
    expect(out).toContain('● p7m2d4cf  Linux · Chrome 53 · 192.168.1.43 · DevTools closed');
    expect(out).toContain('    link        1212 frames, 2 bad · rtt 180 ms · 3 records lost');
    // Messages teleport dropped because it couldn't follow them are said, where there were any.
    const dropped = text(humanize('devices', {}, [{ ...live[0]!, stats: { ...stats, unread: 3 } }], undefined, p, 100));
    expect(dropped).toContain('    link        1212 frames, none bad · 3 messages not read · rtt 12 ms · nothing lost');
    expect(text(humanize('status', {}, live, undefined, p, 100))).not.toContain('link');
    expect(humanize('status', {}, [], undefined, p, 100, { port: 7070 })).toEqual(['○ no device connected to tlpt on :7070']);
  });

  it('lists requests: failures red, paths on the page cut in the middle, and the flags', () => {
    const out = text(humanize('network', {}, network, 'k3x9q2ab', p, 100));
    expect(out).toContain('● requests k3x9q2ab · the last 4 · 2 failed');
    expect(out).toMatch(/⎿ status {2}method {2}time {5}size {4}path$/m);
    expect(out).toMatch(/^ {4}200 {5}GET {5}42 ms {4}3\.1 KB {2}\/$/m);
    expect(out).toMatch(/^ {4}200 {5}GET {5}412 ms {3}412 KB {2}\/static\/js\/main\.3f2a\w*…\w*\.chunk\.js$/m);
    expect(out).toMatch(/^ {4}503 {5}GET {5}1240 ms {2}0 B {5}\/api\/rails\?page=2$/m);
    expect(out).toMatch(/^ {4}fail {4}POST {4}2010 ms {2}0 B {5}\/v1\/collect · socket hang up$/m);
    expect(out).toContain('    --failed · --url text · --min-ms n · --limit n');
    expect(humanize('network', {}, network, 'k3x9q2ab', paint('truecolor'), 100).join('\n')).toContain('\x1b[38;2;240;110;90mfail');
    expect(text(humanize('network', { failed: true }, [], 'k3x9q2ab', p, 100))).toBe('● requests k3x9q2ab\n  ⎿ none match');
  });

  it('says how a key sequence ended: pressed, stopped on a routine line, or failed with why', () => {
    expect(text(formatKeys(run('done', 3), p, 80, { id: 'k3x9q2ab' }))).toBe('● keys k3x9q2ab · right right ok · 3 pressed');
    expect(text(formatKeys(run('stopped', 2), p, 80, { id: 'k3x9q2ab' }))).toBe('· keys k3x9q2ab · right right ok · stopped after 2 of 3');
    expect(text(formatKeys(run('failed', 1, 'nothing matches #menu'), p, 80, { id: 'k3x9q2ab' }))).toBe('● keys k3x9q2ab failed after 1 of 3\n  ⎿ nothing matches #menu');
    // The console still calls it with three arguments.
    expect(text(formatKeys(run('done', 3), p, 80))).toBe('● keys · right right ok · 3 pressed');
  });

  it('shows an eval value: strings quoted, objects as indented JSON, 20 lines at most', () => {
    expect(text(humanize('eval', { expression: 'document.title' }, { value: 'Home' }, 'k3x9q2ab', p, 100))).toBe('● eval document.title · k3x9q2ab\n  ⎿ "Home"');
    // Code written over lines, as agents send it, heads the answer on one.
    expect(strip(humanize('eval', { expression: '(function(){\n  return 1;\n})()' }, { value: 1 }, 'k3x9q2ab', p, 100)[0]!)).toBe('● eval (function(){ return 1; })() · k3x9q2ab');
    const obj = humanize('eval', { expression: 'x' }, { value: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`field${i}`, i])) }, 'k3x9q2ab', p, 100).map(strip);
    expect(obj[1]).toBe('  ⎿ {');
    expect(obj[2]).toBe('      "field0": 0,');
    expect(obj).toHaveLength(22);
    expect(obj.at(-1)).toBe('    … 12 more lines');
  });

  it('lists guide topics as id and title, and shows a match with what to try', () => {
    const topics = text(humanize('guide', {}, guide(''), undefined, p, 100));
    expect(topics).toMatch(/^● guide · \d+ topics/);
    expect(topics).toMatch(/startup +Startup: the first useful screen/);
    const match = text(humanize('guide', {}, guide('polyfills'), undefined, p, 100));
    expect(match).toMatch(/^ {4}try {9}\S/m);
    expect(match).toMatch(/checks? for a trial · tlpt guide \S+ --json prints them/);
  });

  it('answers in a console narrower than its labels, rather than hang', () => {
    for (const cols of [20, 24, 28, 32]) for (const [name, args, data, id] of answers) expect(humanize(name, args, data, id, p, cols).length).toBeGreaterThan(0);
  });

  it('keeps every answer inside the width, at 100 and 60 columns, with and without colour', () => {
    for (const cols of [100, 60])
      for (const color of ['none', 'truecolor'] as const)
        for (const [name, args, data, id] of answers) {
          const lines = humanize(name, args, data, id, paint(color), cols, { port: 7070, href: `${PAGE}/` });
          expect(lines.length, `${name} at ${cols}`).toBeGreaterThan(0);
          for (const l of lines) expect(width(l), `${name} at ${cols} ${color}: ${strip(l)}`).toBeLessThanOrEqual(cols - 1);
        }
  });

  it('draws ASCII in place of every glyph when the terminal lacks them', () => {
    setGlyphs(true);
    const own = /[^\x20-\x7e]/;
    const out = [
      ...humanize('capture', {}, capture, 'k3x9q2ab', p, 100),
      ...humanize('probe', { name: 'media' }, { ...media, groups: media.groups.slice(0, 2) }, 'k3x9q2ab', p, 100),
      ...humanize('device', {}, snapshot, undefined, p, 100),
      ...humanize('devices', {}, live, undefined, p, 100),
      ...humanize('trial', {}, trial, undefined, p, 100),
      ...humanize('network', {}, network, 'k3x9q2ab', p, 100),
      ...humanize('eval', { expression: 'x' }, { value: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${i}`, i])) }, 'k3x9q2ab', p, 100),
    ];
    for (const l of out) expect(l, l).not.toMatch(own);
    const t = text(out);
    expect(t).toContain('* capture k3x9q2ab - 10 s - 7 key presses');
    expect(t).toContain('  `- frames      54.1 fps - p50 16.7');
    expect(t).toContain('     main        4 long tasks, 600 ms');
    expect(t).toContain('+ h.264 high');
    expect(t).toContain('x av1 (mp4)');
    expect(t).toContain('... 12 more lines');
    expect(text(block(p, 80, 'reloaded', [], 'faint'))).toBe('- reloaded');
    expect(G.dot).toBe('*');
    for (const l of humanize('device', {}, snapshot, undefined, p, 60)) expect(width(l)).toBeLessThanOrEqual(59);
  });
});
