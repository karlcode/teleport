import { describe, expect, it } from 'vitest';
import { PROFILE, profileNotes } from '../src/profile.js';
import { parseSpec, startScript, summarize, type Sample } from '../src/trial.js';

const spec = parseSpec({ name: 't', variants: [{ name: 'a' }, { name: 'b' }], keys: ['ok'] });
const sample = (variant: string, round: number, metrics: Sample['metrics'], uncaught: string[] = []): Sample => ({ variant, round, ok: true, metrics, error: null, uncaught, ms: 1 });
const notes = (samples: Sample[]) => profileNotes(spec, summarize(spec, samples));

describe('the profile', () => {
  it('describes every metric the runner measures, and only those', () => {
    const script = startScript('r', spec, 0, 0, {}, [{ key: 'Enter', code: 'Enter', keyCode: 13 }]);
    const emitted = new Set([...script.matchAll(/\bx\.(\w+)=/g)].map((m) => m[1]));
    expect([...emitted].sort()).toEqual(Object.keys(PROFILE).sort());
  });

  it('says what a clear difference means on a device', () => {
    const lines = notes([0, 1, 2, 3, 4].flatMap((i) => [sample('a', i, { domNodes: 100 + i }), sample('b', i, { domNodes: 5000 + i })]));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^b against a: DOM nodes higher by 4900 \(95% CI .* to .*, 5 and 5 runs\), worse\. More elements make style and layout slower/);
  });

  it('leaves failed runs out, as compare does', () => {
    const failed = (s: Sample): Sample => ({ ...s, ok: false, error: 'setup threw' });
    const lines = notes([0, 1, 2, 3, 4].flatMap((i) => [sample('a', i, { domNodes: 100 + i }), sample('b', i, { domNodes: 5000 + i }), failed(sample('b', 9 + i, { domNodes: 1 }))]));
    expect(lines[0]).toMatch(/, 5 and 5 runs\)/);
  });

  it('is quiet about what did not clearly move, or moved too little to matter', () => {
    expect(notes([0, 1, 2, 3].flatMap((i) => [sample('a', i, { fps: 59 + (i % 2) }), sample('b', i, { fps: 60 - (i % 2) })]))).toEqual([]);
    expect(notes([0, 1, 2, 3].flatMap((i) => [sample('a', i, { layoutMs: 0.1, profilerMs: 0.2, fps: 59.1 }), sample('b', i, { layoutMs: 0.3, profilerMs: 0.4, fps: 59.6 })]))).toEqual([]);
  });

  it('names what this engine could not measure, once', () => {
    const lines = notes([0, 1, 2].flatMap((i) => [sample('a', i, { heapKB: null, longTaskMs: null, fps: 60 }), sample('b', i, { heapKB: null, longTaskMs: null, fps: 60 })]));
    expect(lines).toEqual(['Not measured on this engine: long tasks (it has no longtask PerformanceObserver), JS heap (it has no performance.memory).']);
  });

  it('flags a heap that grows in every run', () => {
    const lines = notes([10000, 12000, 14000, 16500].map((h, i) => sample('a', i, { heapKB: h })));
    expect(lines.join('\n')).toMatch(/a: the JS heap grew in every run, 10000 → 16500 KB over 4 runs \(about 2000 KB a run\)/);
    expect(notes([2137, 2800, 3500, 4200, 4925].map((h, i) => sample('a', i, { heapKB: h })))).toEqual([]);
  });

  it("names a failed run's uncaught error, often why it failed", () => {
    const failed = [0, 1, 2].map((i) => ({ ...sample('b', i, {}, ['ReferenceError: WeakRef is not defined']), ok: false, error: 'the app never became ready' }));
    expect(notes([...[0, 1, 2].map((i) => sample('a', i, {})), ...failed]).join('\n')).toMatch(/b: 3 of 3 runs threw uncaught errors, first: ReferenceError: WeakRef is not defined/);
  });

  it('reports uncaught errors with the first one', () => {
    const lines = notes([0, 1, 2].map((i) => sample('b', i, { errors: 1 }, ['TypeError: x is undefined (line 3)'])));
    expect(lines.join('\n')).toMatch(/b: 3 of 3 runs threw uncaught errors, first: TypeError: x is undefined \(line 3\)/);
  });
});
