// The profile: what every trial run measures on the device without being asked, and what each number means
// for a device app. The runner (trial.ts) measures these around each variant; this is the laptop's side:
// which way is better, what a clear difference means, and why a number is missing on an engine. A
// test holds the two to the same names.
import type { Comparison, Sample, TrialSpec } from './trial.js';

export interface MetricInfo {
  label: string;
  unit: string;
  better: 'lower' | 'higher' | null;
  /** What a difference in it means on a device, as a sentence. */
  means: string;
  /** Why an engine answers null, as "it has no ...", and the name metrics missing together go by. */
  missing?: string;
  group?: string;
  /** The smallest difference worth a note; Infinity for none. Smaller ones stay in compare. */
  noise: number;
}

const NO_FRAMES = 'no frame was drawn while it was watched; raise observeMs';

export const PROFILE: Record<string, MetricInfo> = {
  loadMs: { label: 'load', unit: 'ms', better: 'lower', means: 'Time from a blank frame to the variant loaded: its HTML, scripts and setup.' , noise: 5 },
  scriptsMs: { label: 'scripts', unit: 'ms', better: 'lower', means: 'Fetching, parsing, compiling and running its scripts; old engines compile slowly, so bundle size and transpile target show here.' , noise: 2 },
  frames: { label: 'frames drawn', unit: '', better: null, means: 'Animation frames drawn while watched.' , noise: Infinity },
  fps: { label: 'frame rate', unit: 'fps', better: 'higher', means: 'Frames per second while watched; a device may refresh at 60 Hz but draw a busy page far slower.', missing: NO_FRAMES, group: 'frames' , noise: 2 },
  frameP95Ms: { label: 'frame time p95', unit: 'ms', better: 'lower', means: 'How long the slower frames take; over 16.7 ms a 60 Hz screen skips frames, often from paint (shadows, blur, large layers) or main-thread work.', missing: NO_FRAMES, group: 'frames' , noise: 2 },
  frameWorstMs: { label: 'worst frame', unit: 'ms', better: 'lower', means: 'The longest gap between frames: the hitch a person sees, often a long task, a garbage collection or an image decode.', missing: NO_FRAMES, group: 'frames' , noise: 5 },
  slowFrames: { label: 'frames over 50 ms', unit: '', better: 'lower', means: 'Each one a visible hitch.', missing: NO_FRAMES, group: 'frames' , noise: 1 },
  lagP95Ms: { label: 'timer lag p95', unit: 'ms', better: 'lower', means: 'How late a 50 ms timer fired: the main thread was busy, and keys wait as long.' , noise: 5 },
  lagMaxMs: { label: 'longest block', unit: 'ms', better: 'lower', means: 'The longest the main thread was blocked, as a timer saw it; a key pressed then waits as long.' , noise: 5 },
  longTaskMs: { label: 'long tasks', unit: 'ms', better: 'lower', means: 'Main-thread time in tasks over 50 ms while watched.', missing: 'it has no longtask PerformanceObserver', group: 'long tasks' , noise: 20 },
  longTasks: { label: 'long task count', unit: '', better: 'lower', means: 'Tasks over 50 ms while watched.', missing: 'it has no longtask PerformanceObserver', group: 'long tasks' , noise: 1 },
  heapKB: { label: 'JS heap', unit: 'KB', better: 'lower', means: "JavaScript heap in use after the run, the whole page's; a device gives the browser far less memory than a desktop, and running out ends the app without an error.", missing: 'it has no performance.memory', group: 'JS heap' , noise: 256 },
  heapDeltaKB: { label: 'JS heap added', unit: 'KB', better: 'lower', means: 'JavaScript heap the run added, garbage included until a collection runs.', missing: 'it has no performance.memory', group: 'JS heap' , noise: 256 },
  domNodes: { label: 'DOM nodes', unit: '', better: 'lower', means: 'More elements make style and layout slower, and old engines most.' , noise: 10 },
  layoutMs: { label: 'forced layout', unit: 'ms', better: 'lower', means: "One style and layout of the whole document, forced: what each change that reflows the page costs, such as a focus move that resizes a tile." , noise: 1 },
  images: { label: 'images', unit: '', better: null, means: 'Image elements in the document.' , noise: 1 },
  imageKB: { label: 'decoded images', unit: 'KB', better: 'lower', means: "Decoded image memory, width × height × 4 bytes whatever the file format; a device's image cache is small, so large images are evicted and decoded again while scrolling." , noise: 64 },
  imagesBroken: { label: "images that didn't decode", unit: '', better: 'lower', means: 'Loaded but not decoded: a format this engine lacks, or a broken file.' , noise: 1 },
  resources: { label: 'requests', unit: '', better: 'lower', means: 'Requests the variant made; on old engines and TLS stacks each costs more than on a desktop.', missing: 'it has no Resource Timing', group: 'requests' , noise: 1 },
  resourceKB: { label: 'bytes fetched', unit: 'KB', better: 'lower', means: 'Bytes transferred, compressed where the server compressed them.', missing: 'it reports no transfer sizes (an old engine, or a server without Timing-Allow-Origin)', group: 'transfer sizes' , noise: 8 },
  resourceMaxMs: { label: 'slowest request', unit: 'ms', better: 'lower', means: 'The slowest request, start to end.', missing: 'it has no Resource Timing', group: 'requests' , noise: 20 },
  media: { label: 'media elements', unit: '', better: null, means: 'Video and audio elements; many devices have one hardware video decoder, so a second video can fail or take it from the first.' , noise: 1 },
  mediaDecoded: { label: 'video frames decoded', unit: '', better: 'higher', means: 'Video frames decoded while watched.', missing: 'it has neither getVideoPlaybackQuality nor webkitDecodedFrameCount', group: 'video frames' , noise: 10 },
  mediaDropped: { label: 'video frames dropped', unit: '', better: 'lower', means: 'The decoder or the compositor fell behind.', missing: 'it has neither getVideoPlaybackQuality nor webkitDroppedFrameCount', group: 'video frames' , noise: 2 },
  mediaErrors: { label: 'media errors', unit: '', better: 'lower', means: 'Media elements in error; mediaError says which (a format or codec the device refuses is MEDIA_ERR_SRC_NOT_SUPPORTED).' , noise: 1 },
  mediaError: { label: 'media error', unit: '', better: null, means: 'The first media error.' , noise: Infinity },
  keyHandlerMs: { label: 'key handlers', unit: 'ms', better: 'lower', means: "Time in the page's own key handlers per press (median)." , noise: 2 },
  keyFrameMs: { label: 'key → frame', unit: 'ms', better: 'lower', means: 'From a remote key press to the frame after it painted (median): what a person feels.' , noise: 4 },
  keyFrameMaxMs: { label: 'slowest key → frame', unit: 'ms', better: 'lower', means: 'The slowest press to frame.' , noise: 8 },
  errors: { label: 'uncaught errors', unit: '', better: 'lower', means: 'Errors the variant threw outside a handler.' , noise: 1 },
  profilerMs: { label: "teleport's profiling", unit: 'ms', better: 'lower', means: "Main-thread time teleport's own profiling took during the run." , noise: Infinity },
};

/** Which way is better for a metric: the spec's word first, then the profile's. */
export const betterOf = (spec: TrialSpec, metric: string) => spec.better[metric] ?? PROFILE[metric]?.better ?? undefined;

const MAX_DIFFS = 8;
/** A difference this small a share of the baseline goes without a note. */
const MIN_SHARE = 0.05;
/** A heap that grows in every run, by this much a run (median) and in all, reads as a leak. */
const LEAK_STEP_KB = 1024;
const LEAK_TOTAL_KB = 4096;
const LEAK_RUNS = 4;

/** What the profile says about a trial, in plain words: clear differences and what they mean, then what this engine couldn't measure, growth that outlives each run, and uncaught errors. */
export function profileNotes(spec: TrialSpec, r: { samples: Sample[]; compare: Comparison[] }): string[] {
  const out: string[] = [];
  // Runs that finished: compare's numbers leave the failed ones out, so the notes do too.
  const done = r.samples.filter((s) => s.ok);
  const share = (c: Comparison) => {
    const xs = done.filter((s) => s.variant === c.baseline).map((s) => s.metrics[c.metric]).filter((v): v is number => typeof v === 'number');
    const m = xs.length ? xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : 0;
    return m === 0 ? Infinity : Math.abs(c.diff) / Math.abs(m);
  };
  const clear = r.compare
    .filter((c) => PROFILE[c.metric] && (c.lo > 0 || c.hi < 0) && Math.abs(c.diff) >= PROFILE[c.metric]!.noise && share(c) >= MIN_SHARE)
    .sort((a, b) => share(b) - share(a));
  for (const c of clear.slice(0, MAX_DIFFS)) {
    const p = PROFILE[c.metric]!;
    const n = (k: string) => done.filter((s) => s.variant === k && typeof s.metrics[c.metric] === 'number').length;
    const by = `${Math.round(Math.abs(c.diff) * 100) / 100}${p.unit ? ` ${p.unit}` : ''}`;
    out.push(`${c.variant} against ${c.baseline}: ${p.label} ${c.diff > 0 ? 'higher' : 'lower'} by ${by} (95% CI ${c.lo} to ${c.hi}, ${n(c.variant)} and ${n(c.baseline)} runs)${c.better ? `, ${c.better === 'yes' ? 'better' : 'worse'}` : ''}. ${p.means}`);
  }

  const missing = new Map<string, string>();
  for (const [k, p] of Object.entries(PROFILE)) {
    const vals = r.samples.filter((s) => k in s.metrics).map((s) => s.metrics[k]);
    if (p.missing && vals.length && vals.every((v) => v === null)) missing.set(p.group ?? p.label, p.missing);
  }
  if (missing.size) out.push(`Not measured on this engine: ${[...missing].map(([g, why]) => `${g} (${why})`).join(', ')}.`);

  for (const v of spec.variants) {
    const runs = done.filter((s) => s.variant === v.name).sort((a, b) => a.round - b.round);
    const heap = runs.map((s) => s.metrics.heapKB).filter((x): x is number => typeof x === 'number');
    const steps = heap.slice(1).map((h, i) => h - heap[i]!).sort((a, b) => a - b);
    const step = steps[Math.floor(steps.length / 2)] ?? 0;
    if (heap.length >= LEAK_RUNS && steps[0]! >= 0 && step >= LEAK_STEP_KB && heap[heap.length - 1]! - heap[0]! >= LEAK_TOTAL_KB)
      out.push(`${v.name}: the JS heap grew in every run, ${heap[0]} → ${heap[heap.length - 1]} KB over ${heap.length} runs (about ${Math.round(step)} KB a run), though each run's frame is thrown away: something outlives it (a possible leak), held by the page or the engine.`);
    // Over every run, failed ones too: a page's uncaught error is often why a run failed.
    const all = r.samples.filter((s) => s.variant === v.name);
    const threw = all.filter((s) => s.uncaught.length || (typeof s.metrics.errors === 'number' && s.metrics.errors > 0));
    if (threw.length) out.push(`${v.name}: ${threw.length} of ${all.length} runs threw uncaught errors, first: ${threw.find((s) => s.uncaught.length)?.uncaught[0] ?? 'unknown'}.`);
  }
  return out;
}
