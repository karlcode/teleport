import { describe, expect, it } from 'vitest';
import { bootstrapCI, bootstrapDiffCI, mean, median, mulberry32, period, quantile, shiftFunction, summarize } from '../src/index.js';

describe('descriptive statistics', () => {
  it('median of odd and even lengths, input not mutated', () => {
    const xs = [5, 1, 3];
    expect(median(xs)).toBe(3);
    expect(xs).toEqual([5, 1, 3]);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('quantile uses linear interpolation (R type 7 / numpy default)', () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(quantile(xs, 0)).toBe(1);
    expect(quantile(xs, 1)).toBe(10);
    expect(quantile(xs, 0.5)).toBe(5.5);
    expect(quantile(xs, 0.95)).toBeCloseTo(9.55, 10);
    expect(quantile([42], 0.95)).toBe(42);
  });

  it('mean', () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
  });

  it('rejects empty input and bad quantiles', () => {
    expect(() => median([])).toThrow();
    expect(() => quantile([1], 1.5)).toThrow();
    expect(() => mean([])).toThrow();
  });

  it('summarize gives n, median, p95, min, max', () => {
    expect(summarize([3, 1, 2])).toEqual({ n: 3, median: 2, p95: 2.9, min: 1, max: 3 });
  });
});

describe('seeded PRNG', () => {
  it('is deterministic per seed and in [0, 1)', () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    const seqA = Array.from({ length: 100 }, () => a());
    const seqB = Array.from({ length: 100 }, () => b());
    expect(seqA).toEqual(seqB);
    expect(seqA.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(mulberry32(8)()).not.toBe(seqA[0]);
  });
});

describe('bootstrap confidence intervals', () => {
  it('contains the estimate and is reproducible with a seed', () => {
    const xs = [10, 12, 11, 13, 12, 11, 10, 14, 12, 11];
    const ci1 = bootstrapCI(xs, median, { seed: 1 });
    const ci2 = bootstrapCI(xs, median, { seed: 1 });
    expect(ci1).toEqual(ci2);
    expect(ci1.estimate).toBe(11.5);
    expect(ci1.lo).toBeLessThanOrEqual(ci1.estimate);
    expect(ci1.hi).toBeGreaterThanOrEqual(ci1.estimate);
    expect(ci1.lo).toBeGreaterThanOrEqual(10);
    expect(ci1.hi).toBeLessThanOrEqual(14);
  });

  it('collapses to a point for constant data', () => {
    const ci = bootstrapCI([5, 5, 5, 5], median);
    expect([ci.lo, ci.estimate, ci.hi]).toEqual([5, 5, 5]);
  });

  it('A/B difference excludes zero for a clear effect and includes it for none', () => {
    const rnd = mulberry32(3);
    const noise = () => (rnd() - 0.5) * 2;
    const a = Array.from({ length: 30 }, () => 34 + noise());
    const b = Array.from({ length: 30 }, () => 21 + noise());
    const big = bootstrapDiffCI(a, b, median, { seed: 2 });
    expect(big.estimate).toBeGreaterThan(11);
    expect(big.lo).toBeGreaterThan(0);

    const c = Array.from({ length: 30 }, () => 20 + noise());
    const d = Array.from({ length: 30 }, () => 20 + noise());
    const none = bootstrapDiffCI(c, d, median, { seed: 2 });
    expect(none.lo).toBeLessThan(0);
    expect(none.hi).toBeGreaterThan(0);
  });

  it('wider alpha gives a narrower interval', () => {
    const xs = Array.from({ length: 50 }, (_, i) => (i * 37) % 23);
    const w95 = bootstrapCI(xs, mean, { seed: 4, alpha: 0.05 });
    const w50 = bootstrapCI(xs, mean, { seed: 4, alpha: 0.5 });
    expect(w50.hi - w50.lo).toBeLessThan(w95.hi - w95.lo);
  });
});

describe('period', () => {
  it('finds a timer from the gaps between its runs, through jitter and missed runs', () => {
    const rnd = mulberry32(3);
    const ts: number[] = [];
    for (let i = 0; i < 24; i++) if (i % 7 !== 3) ts.push(1000 + i * 2500 + (rnd() - 0.5) * 60);
    const p = period(ts);
    expect(p!.ms).toBeGreaterThan(2490);
    expect(p!.ms).toBeLessThan(2510);
    expect(p!.fit).toBeGreaterThanOrEqual(0.8);
    expect(p!.n).toBe(ts.length);
  });

  it('finds none in events a person makes, a few hundred ms apart at random', () => {
    const rnd = mulberry32(9);
    let t = 0;
    const ts = Array.from({ length: 40 }, () => (t += 250 + rnd() * 500));
    expect(period(ts)).toBeNull();
  });

  it('needs at least five events', () => {
    expect(period([0, 1000, 2000, 3000])).toBeNull();
  });
});

describe('shift function', () => {
  it('finds the same shift at every quantile when one sample is the other moved, and is sure of it', () => {
    const b = Array.from({ length: 200 }, (_, i) => 16 + (i % 20));
    const a = b.map((x) => x - 5);
    const s = shiftFunction(a, b, [0.1, 0.5, 0.9, 0.99]);
    expect(s.map((x) => x.p)).toEqual([0.1, 0.5, 0.9, 0.99]);
    for (const x of s) {
      expect(x.diff).toBeCloseTo(-5, 6);
      expect(x.hi).toBeLessThan(0);
    }
  });

  it('shows a change in the tail only where the tail moved', () => {
    const b = Array.from({ length: 200 }, (_, i) => (i % 20 === 0 ? 120 : 17));
    const a = b.map((x) => (x > 100 ? 40 : x));
    const s = shiftFunction(a, b, [0.5, 0.99]);
    expect(s[0]!.diff).toBe(0);
    expect(s[1]!.diff).toBeLessThan(-50);
  });
});
