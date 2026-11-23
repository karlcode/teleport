export type Stat = (xs: readonly number[]) => number;

export interface Summary { n: number; median: number; p95: number; min: number; max: number }
export interface Interval { estimate: number; lo: number; hi: number }
export interface BootstrapOptions { iterations?: number; alpha?: number; seed?: number }

function nonEmpty(xs: readonly number[]) {
  if (xs.length === 0) throw new RangeError('empty sample');
}

/** Linear-interpolation quantile (R type 7, numpy default). */
export function quantile(xs: readonly number[], q: number): number {
  nonEmpty(xs);
  if (!(q >= 0 && q <= 1)) throw new RangeError(`quantile out of range: ${q}`);
  const s = [...xs].sort((a, b) => a - b);
  const h = (s.length - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return s[lo]! + (h - lo) * (s[hi]! - s[lo]!);
}

export const median: Stat = (xs) => quantile(xs, 0.5);

export const mean: Stat = (xs) => {
  nonEmpty(xs);
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
};

export function summarize(xs: readonly number[]): Summary {
  nonEmpty(xs);
  return { n: xs.length, median: median(xs), p95: quantile(xs, 0.95), min: Math.min(...xs), max: Math.max(...xs) };
}

/** Small, fast, seedable PRNG so bootstrap results are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function resample(xs: readonly number[], rnd: () => number, out: number[]) {
  for (let i = 0; i < xs.length; i++) out[i] = xs[Math.floor(rnd() * xs.length)]!;
  return out;
}

/** Percentile bootstrap CI for stat(xs). */
export function bootstrapCI(xs: readonly number[], stat: Stat, opts: BootstrapOptions = {}): Interval {
  nonEmpty(xs);
  const { iterations = 2000, alpha = 0.05, seed = 1 } = opts;
  const rnd = mulberry32(seed);
  const buf = new Array<number>(xs.length);
  const draws: number[] = [];
  for (let i = 0; i < iterations; i++) draws.push(stat(resample(xs, rnd, buf)));
  return { estimate: stat(xs), lo: quantile(draws, alpha / 2), hi: quantile(draws, 1 - alpha / 2) };
}

/** Percentile bootstrap CI for stat(a) - stat(b), resampling each group independently. */
export function bootstrapDiffCI(a: readonly number[], b: readonly number[], stat: Stat, opts: BootstrapOptions = {}): Interval {
  nonEmpty(a);
  nonEmpty(b);
  const { iterations = 2000, alpha = 0.05, seed = 1 } = opts;
  const rnd = mulberry32(seed);
  const ba = new Array<number>(a.length);
  const bb = new Array<number>(b.length);
  const draws: number[] = [];
  for (let i = 0; i < iterations; i++) draws.push(stat(resample(a, rnd, ba)) - stat(resample(b, rnd, bb)));
  return { estimate: stat(a) - stat(b), lo: quantile(draws, alpha / 2), hi: quantile(draws, 1 - alpha / 2) };
}

export interface Period {
  ms: number;
  /** Share of the gaps that fit a whole number of periods, 0..1. */
  fit: number;
  /** Events it was found from. */
  n: number;
}

/**
 * The period of events that repeat on a timer, from the gaps between them. A gap of two or three
 * periods still fits, so runs that went unseen don't hide the timer. Null with fewer than five events,
 * or when fewer than `minFit` of the gaps land within `tolerance` of a whole number of periods.
 */
export function period(times: readonly number[], tolerance = 0.1, minFit = 0.8): Period | null {
  if (times.length < 5) return null;
  const s = [...times].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < s.length; i++) gaps.push(s[i]! - s[i - 1]!);
  const guess = median(gaps);
  if (!(guess > 0)) return null;
  let fits = 0;
  let sum = 0;
  let periods = 0;
  for (const g of gaps) {
    const k = Math.round(g / guess);
    if (k >= 1 && Math.abs(g - k * guess) <= tolerance * guess) {
      fits++;
      sum += g;
      periods += k;
    }
  }
  const fit = fits / gaps.length;
  return fit >= minFit ? { ms: sum / periods, fit, n: s.length } : null;
}

export interface Shift {
  p: number;
  /** The quantile in each sample. */
  a: number;
  b: number;
  /** a minus b, with a percentile bootstrap interval. */
  diff: number;
  lo: number;
  hi: number;
}

export const SHIFT_QUANTILES = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99] as const;

/** How sample a differs from sample b at each quantile: whether a change moved everything or only the tail. */
export function shiftFunction(a: readonly number[], b: readonly number[], ps: readonly number[] = SHIFT_QUANTILES, opts: BootstrapOptions = {}): Shift[] {
  return ps.map((p) => {
    const at: Stat = (xs) => quantile(xs, p);
    const ci = bootstrapDiffCI(a, b, at, opts);
    return { p, a: at(a), b: at(b), diff: ci.estimate, lo: ci.lo, hi: ci.hi };
  });
}
