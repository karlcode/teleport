import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { checksMeasure, order, parseSpec, pollScript, runTrial, startScript, summarize, TRIAL_BASE, TrialFiles, type Sample, type TrialControl } from '../src/trial.js';

const root = new URL('../../../', import.meta.url);

const spec = (over: Record<string, unknown> = {}) =>
  parseSpec({ name: 't', variants: [{ name: 'a' }, { name: 'b' }], measure: 'T.done({ms: 1})', ...over });

describe('a trial spec, at the boundary', () => {
  it('fills defaults and keeps what was asked', () => {
    const s = spec();
    expect(s).toMatchObject({ name: 't', where: 'frame', runs: 5, timeoutMs: 10_000, observeMs: 0, keys: [], keyGapMs: 400, profile: true, checks: {}, assets: {}, better: {} });
    expect(s.variants[0]).toEqual({ name: 'a', before: '', scripts: [], html: '', setup: '', vars: {} });
  });

  it('needs no measure: it watches each variant for 2 s and the profile says what happened', () => {
    const s = parseSpec({ variants: [{ name: 'a', html: '<b>x</b>' }] });
    expect(s).toMatchObject({ measure: '', observeMs: 2000, profile: true });
  });

  it('keeps the window long enough for its key presses, and the timeout longer than the window', () => {
    const s = parseSpec({ variants: [{ name: 'a' }], keys: ['right', 'right', 'right', 'ok'], keyGapMs: 1000, timeoutMs: 1000 });
    expect(s.keys).toEqual(['right', 'right', 'right', 'ok']);
    expect(s.observeMs).toBe(4600);
    expect(s.timeoutMs).toBe(6600);
  });

  it('refuses what cannot run, saying why', () => {
    expect(() => parseSpec(null)).toThrow(/a trial is an object/);
    expect(() => parseSpec({ name: 't', variants: [], measure: 'x' })).toThrow(/1 to 8 variants/);
    expect(() => parseSpec({ name: 't', variants: [{ name: 'a' }, { name: 'a' }], measure: 'x' })).toThrow(/two variants named a/);
    expect(() => spec({ keys: ['jump'] })).toThrow(/keys are remote key names: up, down, left, right, ok, back/);
    expect(() => spec({ variants: [{ name: 'a', scripts: ['nope'] }] })).toThrow(/script nope is neither an asset nor a URL/);
    expect(() => spec({ assets: { x: 'relative/path.js' } })).toThrow(/asset x: an absolute path or an http\(s\) URL/);
    expect(() => spec({ where: 'moon' })).toThrow(/where/);
  });

  it('caps runs and timeouts, and takes a function as the measure', () => {
    const s = spec({ runs: 500, timeoutMs: 1, measure: 'function (T) { T.done({}) }' });
    expect(s.runs).toBe(30);
    expect(s.timeoutMs).toBe(2000);
    expect(s.measure).toBe('return (function (T) { T.done({}) })(T);');
  });

  it("shares top-level html, scripts, before and setup with every variant, the variant's own after", () => {
    const s = parseSpec({ assets: { p: '/abs/p.js', q: '/abs/q.js' }, html: '<i>shared</i>', scripts: ['p'], before: 'var a=1', setup: 'var b=2', variants: [{ name: 'x', html: '<b>own</b>', scripts: ['q'], setup: 'var c=3' }, { name: 'y' }] });
    expect(s.variants[0]).toMatchObject({ html: '<i>shared</i><b>own</b>', scripts: ['p', 'q'], before: 'var a=1', setup: 'var b=2\n;var c=3' });
    expect(s.variants[1]).toMatchObject({ html: '<i>shared</i>', scripts: ['p'], before: 'var a=1', setup: 'var b=2' });
  });

  it("refuses a field it doesn't know, rather than ignore it", () => {
    expect(() => spec({ setpu: 'x' })).toThrow(/no field setpu; a trial has name, where, variants/);
    expect(() => spec({ variants: [{ name: 'a', stup: 'x' }] })).toThrow(/variant a has no field stup; a variant has name, html, scripts, before, setup, vars/);
  });

  it('takes asset names, app paths and URLs as scripts', () => {
    const s = spec({ assets: { poly: '/abs/p.js' }, variants: [{ name: 'a', scripts: ['poly', '/vendor/x.js', 'https://cdn.example/y.js'] }] });
    expect(s.variants[0]!.scripts).toEqual(['poly', '/vendor/x.js', 'https://cdn.example/y.js']);
  });
});

describe('run order', () => {
  it('alternates, so a drift in the page does not read as a difference', () => {
    expect(order(2, 3)).toEqual([
      { variant: 0, round: 0 },
      { variant: 1, round: 0 },
      { variant: 1, round: 1 },
      { variant: 0, round: 1 },
      { variant: 0, round: 2 },
      { variant: 1, round: 2 },
    ]);
  });
});

const sample = (variant: string, round: number, metrics: Sample['metrics'], error: string | null = null): Sample => ({ variant, round, ok: error === null, metrics, error, uncaught: [], ms: 1 });

describe('the report', () => {
  it('summarizes numbers, counts values and compares each variant with the first', () => {
    const s = spec({ better: { ms: 'lower' } });
    const samples = [10, 11, 12, 13, 14].flatMap((x, i) => [sample('a', i, { ms: x, fmt: 'jpg' }), sample('b', i, { ms: x + 10, fmt: 'webp' })]);
    const r = summarize(s, samples);
    expect(r.variants[0]).toMatchObject({ name: 'a', runs: 5, ok: 5, numbers: { ms: { n: 5, median: 12, min: 10, max: 14 } }, values: { fmt: [{ value: 'jpg', count: 5 }] } });
    const c = r.compare.find((x) => x.metric === 'ms')!;
    expect(c).toMatchObject({ variant: 'b', baseline: 'a', diff: 10, better: 'no' });
    expect(c.lo).toBeGreaterThan(0);
    expect(c.text).toMatch(/b's ms median is 10 higher than a's \(95% CI .* to .*, 5 and 5 runs\): worse/);
  });

  it('says nothing is clear when the interval spans zero, and leaves direction out when unknown', () => {
    const samples = [1, 5, 2, 4, 3].flatMap((x, i) => [sample('a', i, { n: x }), sample('b', i, { n: 6 - x })]);
    const c = summarize(spec(), samples).compare[0]!;
    expect(c.better).toBeNull();
    expect(c.text).toMatch(/no clear difference/);
  });

  it('groups errors and notes a variant that failed every run, and an engine that cannot parse the measure', () => {
    const samples = [0, 1, 2].flatMap((i) => [sample('a', i, { ms: 1 }), sample('b', i, {}, "the measure threw: SyntaxError: Unexpected token '>'")]);
    const r = summarize(spec(), samples);
    expect(r.variants[1]!.errors).toEqual([{ message: "the measure threw: SyntaxError: Unexpected token '>'", count: 3 }]);
    expect(r.notes.join('\n')).toMatch(/b failed all 3 runs/);
    expect(r.notes.join('\n')).toMatch(/ES5/);
  });

  it('compares and summarizes only the runs that finished, and notes a variant that failed some', () => {
    // A failed run still carries the automatic metrics; they must not make a broken variant look the same, or better.
    const samples = [0, 1, 2, 3].flatMap((i) => [sample('a', i, { loadMs: 100 + i }), sample('b', i, { loadMs: 1 + i }, i < 3 ? 'setup threw: ReferenceError: x is not defined' : null)]);
    const r = summarize(spec(), samples);
    expect(r.compare).toEqual([]);
    expect(r.variants[1]!.numbers.loadMs).toMatchObject({ n: 1, median: 4 });
    expect(r.notes.join('\n')).toMatch(/^b failed 3 of 4 runs, left out of its numbers: setup threw: ReferenceError/m);
    const none = summarize(spec(), [0, 1, 2].flatMap((i) => [sample('a', i, { loadMs: 100 }), sample('b', i, { loadMs: 1 }, 'timed out')]));
    expect(none.compare).toEqual([]);
    expect(none.notes.join('\n')).toMatch(/b failed all 3 runs: timed out/);
  });

  it('keeps metric values to numbers, short strings, booleans and null', () => {
    const r = summarize(spec(), [sample('a', 0, { x: 1.23456, s: 'y'.repeat(500), b: true, o: null })]);
    expect(r.samples[0]!.metrics).toEqual({ x: 1.235, s: 'y'.repeat(200), b: true, o: null });
  });
});

describe('device scripts', () => {
  const s = parseSpec({ name: 't', variants: [{ name: 'a', before: 'window.Promise = undefined', scripts: ['p'], html: '<b>x</b>', setup: 'T.set("s", 1)', vars: { k: 'v' } }], measure: 'T.done({})', keys: ['right', 'ok'], assets: { p: '/abs/p.js' }, checks: { promise: 'typeof Promise' } });
  const presses = [
    { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    { key: 'Enter', code: 'Enter', keyCode: 13 },
  ];
  const scripts: [string, string][] = [
    ['start', startScript('r1', s, 0, 0, { p: '/__teleport/trial/ab/p.js' }, presses)],
    ['start page', startScript('r2', { ...s, where: 'page' }, 0, 1, { p: '/__teleport/trial/ab/p.js' }, presses)],
    ['poll', pollScript('r1')],
    ['checks', startScript('c1', { ...s, measure: checksMeasure(s.checks), profile: false, variants: [{ ...s.variants[0]!, scripts: [], vars: { checks: s.checks } }] }, 0, 0, {}, [])],
  ];

  it('are ES5, as the device needs (es-check)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'teleport-trial-es5-'));
    const files = scripts.map(([name, script]) => {
      const f = join(dir, `${name.replace(/\W+/g, '-')}.js`);
      writeFileSync(f, `${script};\n`);
      return f;
    });
    const out = execFileSync(new URL('node_modules/.bin/es-check', root).pathname, ['es5', ...files], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(out).toMatch(/no ES version matching errors|passed/i);
  });

  it('each parses, so a quoting slip never reaches the device', () => {
    for (const [name, script] of scripts) expect(() => new Function(script), name).not.toThrow();
  });

  it("carry the variant's code as data, never spliced into the runner", () => {
    const evil = parseSpec({ name: 't', variants: [{ name: 'a', vars: { q: '"});alert(1);//' } }], measure: 'T.done({})' });
    const script = startScript('r', evil, 0, 0, {}, []);
    expect(script).toContain(JSON.stringify('"});alert(1);//'));
    expect(() => new Function(script)).not.toThrow();
  });
});

describe('running a trial', () => {
  const control = (answer: (script: string, n: number) => unknown): TrialControl & { scripts: string[] } => {
    const scripts: string[] = [];
    let polls = 0;
    return {
      scripts,
      start: async (script) => void scripts.push(script),
      poll: async (script) => answer(script, polls++),
      sleep: async () => undefined,
      alive: () => true,
    };
  };

  it('runs every variant in alternating order, checks first', async () => {
    const s = spec({ runs: 2, checks: { p: 'typeof Promise' } });
    const ctl = control((script) => (script.includes('"checks-') ? { done: true, metrics: { p: 'function' }, error: null, errors: [], ms: 1 } : { done: true, metrics: { ms: 2 }, error: null, errors: [], ms: 3 }));
    const r = await runTrial(ctl, s, { id: 'device', ua: 'Chrome/56' });
    expect(r.checks).toEqual({ p: 'function' });
    expect(r.samples.map((x) => `${x.variant}${x.round}`)).toEqual(['a0', 'b0', 'b1', 'a1']);
    expect(r.device).toEqual({ id: 'device', ua: 'Chrome/56', engine: 'Chrome 56' });
  });

  it('records a run whose page went away, and one that never finished', async () => {
    let n = 0;
    const ctl = control(() => (n++ === 0 ? { gone: true } : { done: false }));
    const r = await runTrial(ctl, spec({ runs: 1, timeoutMs: 1000 }), { id: 'device', ua: '' }, { pollMs: 1, graceMs: 0 });
    expect(r.samples[0]!.error).toMatch(/the page reloaded or crashed during the run/);
    expect(r.samples[1]!.error).toMatch(/no result from the device/);
  });

  it('starts a run only if its timeout ends within the budget, so the answer beats the caller', async () => {
    const ctl = control(() => ({ done: true, metrics: { ms: 2 }, error: null, errors: [], ms: 3 }));
    // 10 s of timeout and 5 s of grace don't fit in a 12 s budget, though no time has passed yet.
    const r = await runTrial(ctl, spec({ runs: 3 }), { id: 'device', ua: '' }, { budgetMs: 12_000 });
    expect(r.samples).toHaveLength(0);
    expect(r.truncated).toBe(true);
    expect(r.notes.join(' ')).toMatch(/stopped after 0 runs to answer within 12 s/);
    expect((await runTrial(ctl, spec({ runs: 3 }), { id: 'device', ua: '' }, { budgetMs: 16_000 })).samples).toHaveLength(6);
  });

  it('starts no more runs once the caller stops waiting, and says so', async () => {
    let stop = false;
    const ctl = { ...control(() => ((stop = true), { done: true, metrics: { ms: 2 }, error: null, errors: [], ms: 3 })), stopped: () => stop };
    const r = await runTrial(ctl, spec({ runs: 3 }), { id: 'device', ua: '' });
    expect(r.samples).toHaveLength(1);
    expect(r.truncated).toBe(true);
    expect(r.notes.join(' ')).toMatch(/stopped after 1 of 6 runs: the caller stopped waiting/);
  });
});

describe("files the laptop serves for a trial", () => {
  it('gives each a path under teleport, and refuses a local file that is not there', () => {
    const files = new TrialFiles();
    const dir = mkdtempSync(join(tmpdir(), 'teleport-trial-files-'));
    writeFileSync(join(dir, 'p.js'), 'x');
    expect(files.register(join(dir, 'p.js'))).toMatch(/^\/__teleport\/trial\/[0-9a-f]{16}\/p\.js$/);
    expect(files.register(dir + '/')).toMatch(/^\/__teleport\/trial\/[0-9a-f]{16}\/$/);
    expect(files.register('https://cdn.example/a/')).toMatch(/^\/__teleport\/trial\/[0-9a-f]{16}\/$/);
    expect(() => files.register(join(dir, 'missing.js'))).toThrow(/no file at/);
  });

  it('serves a folder or URL prefix only below itself', async () => {
    const files = new TrialFiles();
    const dir = mkdtempSync(join(tmpdir(), 'teleport-trial-below-'));
    writeFileSync(join(dir, 'a.txt'), 'a');
    const folder = files.register(dir + '/').slice(TRIAL_BASE.length);
    const prefix = files.register('https://cdn.example/a/').slice(TRIAL_BASE.length);
    const status = async (rest: string) => {
      let code = 0;
      const res = { writeHead: (c: number) => ((code = c), res), end: () => res, on: () => res, once: () => res, emit: () => true, write: () => true } as unknown as ServerResponse;
      await files.serve(rest, { method: 'GET', headers: {} } as IncomingMessage, res);
      return code;
    };
    expect(await status(folder + '..%2F..%2Fetc%2Fpasswd')).toBe(404);
    expect(await status(prefix + '../../secret')).toBe(404);
  });

  it('keeps a bounded number', () => {
    const files = new TrialFiles(2);
    const a = files.register('https://cdn.example/a.js');
    files.register('https://cdn.example/b.js');
    files.register('https://cdn.example/c.js');
    expect(files.resolve(a.split('/')[3]!)).toBeNull();
  });
});
