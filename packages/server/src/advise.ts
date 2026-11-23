// Advice for one device: what the app should do differently on it, read from what teleport
// measured (a survey's raw answers, or the same gathered live). Each rule looks at one kind of
// evidence and says what it saw, with the numbers, and what to change. Advice is ranked: `must`
// breaks playback or input on this device, `should` costs it visibly, `could` is a cheap gain.
// Nothing here is a finding until a trial shows it; each item names the trial or check that would.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { probeKeyOf, renditionsFromTracks, type ManifestInfo } from './playback.js';

export type Level = 'must' | 'should' | 'could';
export type Area = 'playback' | 'codecs' | 'drm' | 'input' | 'rendering' | 'css' | 'javascript' | 'network' | 'memory' | 'startup';

export interface Advice {
  id: string;
  level: Level;
  area: Area;
  title: string;
  /** What was measured, with numbers. */
  evidence: string;
  /** What to change in the app. */
  action: string;
  /** How to prove it: a trial or a command. */
  check?: string;
  /** The specific things seen: requests, elements, settings, one per line. */
  examples?: string[];
  /** The change itself, as code: a player config call, a CSS rule, a build setting. */
  patch?: string;
}

/** A survey's raw answers, by name (raw/<name>.json); any may be missing or an { error }. */
export type Raw = Record<string, unknown>;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/** A path into an answer: get(raw.capture, 'frames', 'p95Ms'). */
function get(v: unknown, ...path: string[]): unknown {
  let x = v;
  for (const k of path) x = isObj(x) ? x[k] : undefined;
  return x;
}
/** A probe's answers as one map of key → value. */
export function flat(c: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const g of arr(get(c, 'groups'))) for (const i of arr(get(g, 'items'))) if (isObj(i) && typeof i.k === 'string') out[i.k] = i.v;
  return out;
}
const kb = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);
const ms = (n: number) => `${Math.round(n)} ms`;

/** Reads a saved survey's raw answers. */
export function readRaw(dir: string): Raw {
  const r: Raw = {};
  const at = join(dir, 'raw');
  if (!existsSync(at)) throw new Error(`no survey at ${dir} (no raw/ folder)`);
  for (const f of readdirSync(at)) if (f.endsWith('.json')) {
    try {
      r[f.slice(0, -5)] = JSON.parse(readFileSync(join(at, f), 'utf8'));
    } catch {
      // A file cut short is skipped: advice uses what it can read.
    }
  }
  return r;
}

type Rule = (r: Raw, m: Record<string, unknown>) => Advice[];

/** Codecs the browser says yes to: a yes is only a lead, verify plays them. */
const said = (m: Record<string, unknown>, k: string) => m[k];

/** verify's answers by variant name, when a verify run was saved with the survey. */
function verified(r: Raw): Map<string, { plays: boolean | null; why: string | null; firstFrameMs: number | null; dropped: number | null; saidYes: boolean }> {
  const out = new Map();
  for (const v of arr(get(r.verify, 'verdicts'))) if (isObj(v) && typeof v.name === 'string') out.set(v.name, v);
  return out;
}

/** The manifest's ladder, or the player's variant tracks when the manifest couldn't be read here. */
function ladder(r: Raw): ManifestInfo['renditions'] {
  // Written by readManifest in this process's survey: the shape is ours, so the cast is to our own type.
  const fromManifest = arr(r.manifests).flatMap((x) => arr(get(x, 'renditions'))).filter(isObj) as unknown as ManifestInfo['renditions'];
  if (fromManifest.length) return fromManifest;
  const p = arr(get(r.playback, 'players'))[0];
  const ks = get(p, 'drm', 'ks');
  return renditionsFromTracks(get(p, 'tracks'), typeof ks === 'string' ? ks : null);
}

const codecRules: Rule = (r, m) => {
  const out: Advice[] = [];
  const v = verified(r);
  // The engine said yes and the clip didn't play: the worst kind of yes.
  for (const [name, x] of v) {
    if (x.plays === false && x.saidYes)
      out.push({ id: `lies-${name}`, level: 'must', area: 'codecs', title: `Don't offer ${name}: the engine says yes but it doesn't play`, evidence: `isTypeSupported said yes; the clip failed: ${x.why ?? 'no frames'}`, action: `Filter ${name} out of the player's ladder on this device (e.g. a Shaka preferredVideoCodecs / a restrictions filter keyed on this model), whatever MediaSource says.`, check: `tlpt q verify ${name.split(' ')[0]}` });
    else if (x.plays && (x.dropped ?? 0) > 2) out.push({ id: `drops-${name}`, level: 'should', area: 'codecs', title: `${name} plays but drops frames`, evidence: `${x.dropped} frames dropped in a 2 s clip`, action: `Cap this rendition on this device, or prefer another codec at that resolution.`, check: `tlpt q verify ${name.split(' ')[0]}` });
  }
  const sw = [...v.entries()].filter(([n]) => n.startsWith('switch'));
  const codecSwitch = sw.find(([n]) => /→ (hevc|h264)$/.test(n) && /h264 → hevc|hevc → h264/.test(n));
  const families = new Set(ladder(r).filter((x) => x.kind === 'video').map((x) => (x.codecs ?? '').split('.')[0]!.replace(/hev1|hvc1/, 'hevc').replace(/avc[13]/, 'avc')).filter(Boolean));
  if (said(m, 'changeType') === false || codecSwitch?.[1].plays === false)
    out.push({
      id: 'no-codec-switch',
      level: families.size > 1 ? 'must' : 'should',
      area: 'codecs',
      title: 'Never switch codecs mid-stream',
      evidence: [said(m, 'changeType') === false ? 'SourceBuffer.changeType is missing' : '', codecSwitch ? `the h264↔hevc switch clip ${codecSwitch[1].plays ? 'played' : `failed: ${codecSwitch[1].why}`}` : '', families.size > 1 ? `the playing manifest mixes ${[...families].join(' + ')}` : ''].filter(Boolean).join('; '),
      action: 'Pick one video codec family per session before loading (Shaka: preferredVideoCodecs plus a restrictions filter that drops the other family; disable abr.switchCodecs / manifest.disableCodecSwitching-style options). Same for audio codecs across language switches.',
      check: 'tlpt verify switch',
    });
  const resSwitch = v.get('switch hevc 1080p → 2160p');
  if (resSwitch?.plays === false) out.push({ id: 'no-res-switch', level: 'must', area: 'playback', title: 'Resolution switches stall in HEVC', evidence: `1080p → 2160p clip failed: ${resSwitch.why}`, action: 'Lock resolution at start on this device, or reset MediaSource on a resolution change.', check: 'tlpt verify switch' });
  for (const [k, label] of [['av1', 'AV1'], ['dolbyVision', 'Dolby Vision'], ['vp9p2', 'VP9 10-bit']] as const)
    if (said(m, k) === true && !v.size) out.push({ id: `unproven-${k}`, level: 'could', area: 'codecs', title: `${label}: the engine says yes, nothing has played it`, evidence: `isTypeSupported(${k}) is true; WPE/Amlogic boxes often answer yes for codecs the decoder lacks`, action: `Keep ${label} out of this device's ladder until verify plays it.`, check: 'tlpt q verify' });
  const top = Math.max(0, ...ladder(r).filter((x) => x.kind === 'video').map((x) => x.height ?? 0));
  const screenH = Number(/×(\d+)/.exec(String(flat(r.identity).screen ?? ''))?.[1] ?? 0);
  if (screenH && top > screenH * 1.05) out.push({ id: 'ladder-above-screen', level: 'could', area: 'playback', title: `Ladder tops out at ${top}p on a ${screenH}p UI`, evidence: `screen ${screenH}p; highest rendition ${top}p`, action: 'Fine if the panel is 4K and video is a hardware plane (UI at 1080p is normal on STBs). If the output is 1080p, cap at 1080p: same picture, a quarter of the decode and bandwidth.' });
  for (const c of new Set(ladder(r).flatMap((x) => (x.codecs ?? '').split(',')).map((s) => s.trim()).filter(Boolean))) {
    const k = probeKeyOf(c);
    if (k && said(m, k) === false) out.push({ id: `unsupported-${c}`, level: 'must', area: 'codecs', title: `${c} in the manifest, unsupported here`, evidence: `isTypeSupported(${k}) is false`, action: 'Make sure the player filters it before choosing a variant; a stray switch to it stalls.' });
  }
  return out;
};

const playbackRules: Rule = (r) => {
  const out: Advice[] = [];
  const p = arr(get(r.playback, 'players'))[0];
  const st = get(p, 'stats');
  const load = num(get(st, 'loadS'));
  const drm = num(get(st, 'drmS'));
  const lic = num(get(st, 'licenseS'));
  if (load !== null && drm !== null && drm > 1.5)
    out.push({ id: 'slow-drm', level: 'should', area: 'drm', title: `DRM setup takes ${drm.toFixed(1)} s of a ${load.toFixed(1)} s start`, evidence: `drmTime ${drm.toFixed(2)} s${lic !== null ? `, of which the licence request ${lic.toFixed(2)} s` : ''}: the rest is key-system access and session creation on the device`, action: 'Create MediaKeys once at app start and reuse them (Shaka: keep the player and its DrmEngine alive between titles, or preload); prefetch licences for the focused tile; avoid requesting robustness levels the device lacks, which costs a failed attempt each.', check: 'a trial timing requestMediaKeySystemAccess + createMediaKeys with each robustness' });
  const stalls = num(get(st, 'stalls'));
  if (stalls) out.push({ id: 'stalls', level: 'should', area: 'playback', title: `${stalls} stalls while playing`, evidence: `Shaka stallsDetected ${stalls}, gapsJumped ${num(get(st, 'gaps')) ?? 0}`, action: 'Raise the buffering goal, check segment alignment across renditions.' });
  const dec = num(get(st, 'decoded'));
  const drop = num(get(st, 'dropped'));
  if (dec && drop !== null && drop / dec > 0.01) out.push({ id: 'drops', level: 'should', area: 'playback', title: `${((drop / dec) * 100).toFixed(1)} % of frames dropped`, evidence: `${drop} of ${dec}`, action: 'Cap resolution or frame rate on this device; hide UI animations while playing.' });
  const ks = String(get(p, 'drm', 'ks') ?? '');
  if (ks.includes('playready') && get(r.media, 'groups') && flat(r.media).widevine === 'SW_SECURE_DECODE')
    out.push({ id: 'drm-order', level: 'could', area: 'drm', title: 'Keep PlayReady first here', evidence: 'Widevine only reaches SW_SECURE_DECODE, which studios cap at SD/HD; PlayReady is what played 4K', action: 'Order key systems PlayReady first for this model so no time goes on a Widevine attempt.' });
  return out;
};

const inputRules: Rule = (r) => {
  const out: Advice[] = [];
  const targets = arr(get(r.device, 'keyTargets')).filter(isObj);
  const slow = targets.filter((t) => (num(t.p50Ms) ?? 0) > 150).sort((a, b) => (num(b.p50Ms) ?? 0) - (num(a.p50Ms) ?? 0));
  if (!slow.length) return out;
  const worst = slow[0]!;
  // Phases summed over the slow targets that have them: the worst one may have none.
  const sum: Record<string, number> = {};
  for (const t of slow) if (isObj(t.phases)) for (const [k, x] of Object.entries(t.phases)) sum[k] = (sum[k] ?? 0) + (num(x) ?? 0);
  const total = Object.values(sum).reduce((a, b) => a + b, 0) || 1;
  const top = Object.entries(sum).sort((a, b) => b[1] - a[1]);
  const lead = top[0]?.[0];
  const fix: Record<string, string> = {
    handlers: 'the key handler itself is slow: do less on keydown (no synchronous state fan-out, no layout reads), and defer anything not needed for the focus move to after the frame',
    waitFrame: 'the frame after the key waits on other work: something else holds the main thread (timers, player callbacks, a re-render of the whole rail); move it off the key path or yield',
    paint: 'painting is the cost: fewer, smaller layers changing per key (move focus with transform/opacity, no box-shadow/filter/border-radius changes on focus), and no repaint of a full-screen background',
    style: 'style recalculation is the cost: fewer elements matched by the focus class change, simpler selectors',
    layout: 'layout is the cost: avoid size or position changes on focus; scroll rails with transform',
  };
  out.push({
    id: 'slow-keys',
    level: (num(worst.p50Ms) ?? 0) > 300 ? 'must' : 'should',
    area: 'input',
    title: `Key presses take ${ms(num(worst.p50Ms) ?? 0)} to show on ${slow.length} focus target${slow.length > 1 ? 's' : ''}`,
    evidence: slow.slice(0, 4).map((t) => `${t.target}: p50 ${ms(num(t.p50Ms) ?? 0)}, p95 ${ms(num(t.p95Ms) ?? 0)}`).join('; ') + (top.length ? `. Across them the time goes to ${top.slice(0, 3).map(([k, x]) => `${k} ${Math.round((x / total) * 100)} %`).join(', ')}` : ''),
    action: lead && fix[lead] ? `Mostly ${lead}: ${fix[lead]}.${top[1] && fix[top[1][0]] ? ` Then ${top[1][0]}: ${fix[top[1][0]]}.` : ''}` : 'Profile the focus move with a trial using keys.',
    check: 'a trial with where: "page", keys: ["right","right","right"], comparing the current focus style against a transform-only one',
  });
  return out;
};

const renderRules: Rule = (r) => {
  const out: Advice[] = [];
  const f = get(r.capture, 'frames');
  const fps = num(get(f, 'fps'));
  const p99 = num(get(f, 'p99Ms'));
  const playing = arr(get(r.capture, 'video')).some((v) => (num(get(v, 'decodedPerS')) ?? 0) > 0);
  if (fps !== null && fps < 50)
    out.push({ id: 'low-fps', level: fps < 30 ? 'must' : 'should', area: 'rendering', title: `UI runs at ${Math.round(fps)} fps${playing ? ' while video plays' : ''}`, evidence: `capture: ${fps} fps, p95 frame ${num(get(f, 'p95Ms'))} ms, p99 ${p99} ms, ${num(get(f, 'over50Ms')) ?? 0} frames over 50 ms`, action: playing ? 'The UI composites over decoding video: hide or freeze overlays during playback (no animated spinners, progress bars updated at most 1 Hz, no blur/opacity animation over video).' : 'Find what repaints every frame: an infinite CSS animation, a timer-driven update, a canvas.', check: 'tlpt q capture 10 with and without the overlay' });
  const lag = num(get(r.capture, 'lag', 'p95Ms'));
  if (lag !== null && lag > 50) out.push({ id: 'timer-lag', level: 'should', area: 'javascript', title: `Timers run ${ms(lag)} late (p95)`, evidence: `timer lag p95 ${lag} ms, max ${num(get(r.capture, 'lag', 'maxMs'))} ms, with ${num(get(r.capture, 'longTasks', 'count')) ?? 0} long tasks`, action: 'Main thread is busy in chunks the engine does not report as long tasks: break up work in player event handlers and analytics flushes; batch setInterval polling.' });
  const speed = r.speed;
  const layout = num(get(speed, 'layout'));
  if (layout !== null && layout > 500) out.push({ id: 'layout-expensive', level: 'should', area: 'rendering', title: `Layout is ${Math.round(layout / Math.max(1, num(get(speed, 'js')) ?? 1))}× the cost of script here`, evidence: `speed probe: layout ${ms(layout)}, js ${num(get(speed, 'js'))} ms, dom ${num(get(speed, 'dom'))} ms`, action: 'Never read layout (offsetWidth, getBoundingClientRect) after a write in one frame; fix widths in CSS; keep rails out of flow (position absolute + transform).' });
  const g = flat(r.graphics);
  if (g.webgl2 === false && g.webgl === true) out.push({ id: 'webgl1', level: 'could', area: 'rendering', title: `WebGL 1 only, ${g.gpuRenderer ?? 'GPU'}`, evidence: `no WebGL 2; float textures ${g.floatTex}, instancing ${g.instanced}; ASTC ${g.astc}, ETC1 ${g.etc1}`, action: 'If any UI uses WebGL (e.g. a Lottie/Pixi renderer), target WebGL 1 without float textures; prefer ASTC/ETC1 textures.' });
  const dom = num(get(r.dom, 'elements'));
  if (dom !== null && dom > 1500) out.push({ id: 'big-dom', level: 'should', area: 'rendering', title: `${dom} elements in the page`, evidence: `largest subtree ${get(r.dom, 'largest', 'path')} with ${get(r.dom, 'largest', 'descendants')}`, action: 'Virtualise rails: render only visible tiles plus one each side.' });
  return out;
};

/** CSS the app uses that this engine drops or that costs it, and features the app must not rely on. */
const cssRules: Rule = (r) => {
  const out: Advice[] = [];
  const s = r.styles;
  const dropped = [...arr(get(s, 'selectors')), ...arr(get(s, 'properties'))].filter(isObj);
  if (dropped.length) out.push({ id: 'css-dropped', level: dropped.some((d) => arr(get(s, 'selectors')).includes(d)) ? 'should' : 'could', area: 'css', title: `${dropped.length} CSS rule${dropped.length > 1 ? 's' : ''} this engine drops`, evidence: dropped.slice(0, 8).map((d) => `\`${d.text}\` at ${d.at} (${d.uses}×)`).join('; '), action: 'A dropped selector loses its whole rule: split it out, or give this engine a fallback. Unknown properties are dead weight here.', check: 'tlpt q styles' });
  const f = flat(r.features);
  const missing: [string, string, string][] = [
    ['flexGap', 'flex gap', 'margins on children'],
    ['aspect', 'aspect-ratio', 'the padding-top hack'],
    ['focusVisible', ':focus-visible', 'a focus class set by the key handler'],
    ['has', ':has()', 'a class on the parent'],
    ['inset', 'inset', 'top/right/bottom/left'],
    ['clamp', 'clamp()', 'fixed sizes per resolution'],
    ['backdrop', 'backdrop-filter', 'a pre-blurred image'],
    ['container', 'container queries', 'a class per layout'],
    ['contentVisibility', 'content-visibility', 'virtualising off-screen rows'],
  ];
  const gone = missing.filter(([k]) => f[k] === false);
  if (gone.length) out.push({ id: 'css-missing', level: 'could', area: 'css', title: `${gone.length} modern CSS features missing`, evidence: gone.map(([, n]) => n).join(', '), action: gone.map(([, n, use]) => `${n} → ${use}`).join('; ') + '. Lint for them (stylelint plugin no-unsupported-browser-features with this engine) so they never ship silently.' });
  out.push({ id: 'css-animation', level: 'should', area: 'css', title: 'Animate only transform and opacity', evidence: `paint dominates key → frame here (see input), the GPU is a ${flat(r.graphics).gpuRenderer ?? 'low-end part'}${f.willChange ? ', will-change is supported' : ''}`, action: 'No animated box-shadow, filter, blur, border-radius, width/height, top/left, or background-position. No infinite animations (shimmer skeletons, pulsing focus) while video plays. Promote the focus ring with will-change: transform only on the focused tile, not every tile (layers cost memory on a Mali-G31).', check: 'a trial: two variants of the focus style, keys: right ×5, compare keyMs and paint' });
  return out;
};

const jsRules: Rule = (r) => {
  const f = flat(r.features);
  const gone = ['classFields', 'optionalChaining', 'nullish', 'bigint', 'structuredClone', 'requestIdleCallback', 'serviceWorker', 'resizeObserver', 'intersectionObserver', 'abortController', 'weakRef', 'privateMethods', 'topLevelAwait'].filter((k) => f[k] === false);
  if (!gone.length) return [];
  return [{ id: 'js-target', level: 'must', area: 'javascript', title: 'Build target must cover this engine', evidence: `missing: ${gone.join(', ')}`, action: 'Transpile class fields and newer syntax for this engine (browserslist entry for WPE 2.28 / Safari 14-ish); polyfill only the APIs used. Never rely on requestIdleCallback or a service worker here.' }];
};

const networkRules: Rule = (r) => {
  const out: Advice[] = [];
  const reqs = arr(r.network).filter(isObj);
  const scripts = reqs.filter((x) => x.type === 'Script');
  const js = scripts.reduce((a, x) => a + (num(x.bytes) ?? 0), 0);
  const dupes = new Map<string, number>();
  for (const x of reqs) if (typeof x.url === 'string') dupes.set(x.url, (dupes.get(x.url) ?? 0) + 1);
  const twice = [...dupes].filter(([, n]) => n > 1);
  if (twice.length) out.push({ id: 'dupe-requests', level: 'should', area: 'network', title: `${twice.length} URL${twice.length > 1 ? 's' : ''} fetched more than once`, evidence: twice.slice(0, 5).map(([u, n]) => `${u.replace(/^https?:\/\/[^/]+/, '')} ×${n}`).join('; '), action: 'Dedupe: one import of each chunk, long cache headers on hashed files.' });
  if (js > 2 * 1048576) out.push({ id: 'js-weight', level: 'should', area: 'startup', title: `${kb(js)} of script in ${scripts.length} files`, evidence: scripts.sort((a, b) => (num(b.bytes) ?? 0) - (num(a.bytes) ?? 0)).slice(0, 3).map((x) => `${String(x.url).split('/').pop()} ${kb(num(x.bytes) ?? 0)}`).join(', '), action: 'Parse/compile on this CPU is the cost, not the download: split by route, load the player bundle only when playback starts, drop polyfills this engine does not need.' });
  const doc = reqs.find((x) => x.type === 'Document');
  if (doc && (num(doc.bytes) ?? 0) > 300 * 1024) out.push({ id: 'html-weight', level: 'should', area: 'startup', title: `The HTML is ${kb(num(doc.bytes) ?? 0)}`, evidence: 'inline state or styles in index.html; parsed before anything shows', action: 'Move inlined data out of the document; fetch it after first paint.' });
  const imgs = reqs.filter((x) => x.type === 'Image');
  const big = imgs.filter((x) => (num(x.bytes) ?? 0) > 200 * 1024);
  if (big.length) out.push({ id: 'big-images', level: 'should', area: 'network', title: `${big.length} images over 200 KB`, evidence: big.slice(0, 5).map((x) => `${String(x.url).split('/').pop()?.slice(0, 40)} ${kb(num(x.bytes) ?? 0)}`).join('; '), action: `Request images at the size drawn (1080p UI), as WebP${flat(r.graphics).avif === true ? ' or AVIF' : ' (no AVIF here)'}; decode cost scales with pixels.` });
  const failed = reqs.filter((x) => (num(x.status) ?? 0) >= 400 || x.failed);
  if (failed.length) out.push({ id: 'failed-requests', level: 'could', area: 'network', title: `${failed.length} failed requests`, evidence: failed.slice(0, 5).map((x) => `${x.status ?? 'failed'} ${String(x.url).slice(0, 80)}`).join('; '), action: 'Remove them: each one is a socket and a timeout on this box.' });
  return out;
};

const memoryRules: Rule = (r) => {
  const out: Advice[] = [];
  const f = flat(r.features);
  if (flat(r.identity).deviceMemory == null && f.memory === false) out.push({ id: 'no-heap', level: 'could', area: 'memory', title: 'Heap is not measurable here', evidence: 'performance.memory and deviceMemory are missing', action: 'Watch for leaks by DOM node count (tlpt q device) across long sessions instead; cap image caches by count.' });
  return out;
};

/** Shaka's configuration, read live: the settings to change, named, with the patch. */
const playerConfigRules: Rule = (r, m) => {
  const out: Advice[] = [];
  const pc = r.playerConfig;
  if (get(pc, 'lib') !== 'shaka') return out;
  const c = get(pc, 'config');
  const player = arr(get(r.playback, 'players'))[0];
  const live = get(player, 'live') === true;
  const v = String(get(pc, 'version') ?? '');
  const noChangeType = said(m, 'changeType') === false || get(pc, 'mse', 'changeType') === false;

  const prefV = arr(get(c, 'preferredVideo')).map((x) => String(get(x, 'codec') ?? '')).filter(Boolean);
  const fam = (s: string) => (/^(hev1|hvc1)/.test(s) ? 'hevc' : /^avc/.test(s) ? 'avc' : /^(dvhe|dvh1)/.test(s) ? 'dolby vision' : /^vp0?9/.test(s) ? 'vp9' : /^av01/.test(s) ? 'av1' : s.split('.')[0]!);
  const families = [...new Set(prefV.map(fam))];
  const strategy = get(c, 'mediaSource', 'codecSwitchingStrategy');
  if (noChangeType && strategy === 'smooth')
    out.push({
      id: 'shaka-codec-switch',
      level: families.length > 1 ? 'must' : 'should',
      area: 'codecs',
      title: "Shaka is set to switch codecs smoothly; this engine can't",
      evidence: `mediaSource.codecSwitchingStrategy is 'smooth' (it relies on SourceBuffer.changeType, missing here)${families.length > 1 ? `; preferredVideo spans ${families.join(', ')}, so a switch between them is on the table` : ''}`,
      examples: prefV.map((x, i) => `preferredVideo[${i}] ${x} (${fam(x)})`),
      action: 'Make Shaka reload MediaSource for a codec change instead of attempting changeType, and keep one family per session so it rarely has to.',
      patch: `player.configure({\n  mediaSource: { codecSwitchingStrategy: 'reload' },\n  preferredVideo: [${prefV.filter((x) => fam(x) === families[0]).map((x) => `{ codec: '${x}' }`).join(', ')}],\n});`,
      check: 'tlpt verify switch',
    });

  const audio = ladder(r).filter((x) => x.kind === 'audio');
  const afams = [...new Set(audio.map((x) => (x.codecs ?? '').split('.')[0]!).filter(Boolean))];
  if (noChangeType && afams.length > 1 && !arr(get(c, 'preferredAudio')).length) {
    const playing = arr(get(player, 'tracks')).find((t) => get(t, 'active') === true);
    const active = String(get(playing, 'a') ?? afams[0]);
    out.push({
      id: 'shaka-audio-codec',
      level: 'should',
      area: 'codecs',
      title: `Audio comes as ${afams.join(' and ')}, and nothing pins one`,
      evidence: `preferredAudio is empty; the ladder offers ${afams.join(' + ')}; a language or track change can cross codecs, which needs changeType`,
      examples: [...new Set(audio.map((x) => `${x.codecs} ${x.channels ?? '?'}ch ${x.lang ?? ''}`.trim()))].slice(0, 8),
      action: `Pin the audio codec that is playing now (${active}) so a language change stays in it.`,
      patch: `player.configure({ preferredAudio: [{ codec: '${active}' }] });`,
    });
  }

  if (!live && get(c, 'streaming', 'lowLatencyMode') === true)
    out.push({ id: 'shaka-low-latency-vod', level: 'should', area: 'playback', title: 'Low-latency mode is on for on-demand content', evidence: 'streaming.lowLatencyMode is true and the stream is not live', action: 'Low-latency mode is for live edges: it changes how Shaka fetches and buffers segments and gives nothing on VOD. Turn it on only when isLive().', patch: 'player.configure({ streaming: { lowLatencyMode: player.isLive() } });' });

  const est = num(get(c, 'abr', 'defaultBandwidthEstimate'));
  const measured = num(get(player, 'stats', 'bw'));
  if (est !== null && measured !== null && measured > est * 3)
    out.push({
      id: 'shaka-bw-seed',
      level: 'could',
      area: 'startup',
      title: `Each title starts from a ${(est / 1e6).toFixed(0)} Mb/s guess; this box measured ${(measured / 1e6).toFixed(0)} Mb/s`,
      evidence: `abr.defaultBandwidthEstimate ${est}; estimatedBandwidth now ${Math.round(measured)}. The first segments come at a rendition picked for the guess, then ABR climbs (switches so far: ${num(get(player, 'stats', 'switches')) ?? '?'})`,
      action: "Keep the last session's estimate (capped) and start from it, so the first picture is the right quality and there is no early switch.",
      patch: `// after playback: localStorage.bw = String(Math.round(player.getStats().estimatedBandwidth));\nplayer.configure({ abr: { defaultBandwidthEstimate: Math.min(Number(localStorage.bw) || ${est}, 50e6) } });`,
    });

  const video = ladder(r).filter((x) => x.kind === 'video');
  const top = video.reduce((a, x) => (x.bandwidth && x.bandwidth > a ? x.bandwidth : a), 0);
  const goal = num(get(c, 'streaming', 'bufferingGoal'));
  const behind = num(get(c, 'streaming', 'bufferBehind'));
  if (top && goal !== null && behind !== null) {
    const mb = ((goal + behind) * top) / 8 / 1048576;
    if (mb > 40)
      out.push({ id: 'shaka-buffer-size', level: 'could', area: 'memory', title: `Up to ${Math.round(mb)} MB of video held in MediaSource at the top rendition`, evidence: `bufferingGoal ${goal} s + bufferBehind ${behind} s at ${(top / 1e6).toFixed(1)} Mb/s; this engine reports no heap, and device MediaSource quotas are small (QuotaExceededError shows as a stall)`, action: 'Hold less behind the playhead at 4K; keep the goal for rebuffer safety.', patch: 'player.configure({ streaming: { bufferBehind: 4 } });', check: 'watch tlpt q errors for QuotaExceededError on long sessions' });
  }

  const maxH = get(c, 'abr', 'restrictions', 'maxHeight');
  const screenH = Number(/×(\d+)/.exec(String(flat(r.identity).screen ?? ''))?.[1] ?? 0);
  const topH = Math.max(0, ...video.map((x) => x.height ?? 0));
  if (screenH && topH > screenH * 1.05 && (maxH === null || maxH === undefined) && get(c, 'abr', 'restrictToScreenSize') === false)
    out.push({ id: 'shaka-no-cap', level: 'could', area: 'playback', title: 'Nothing caps the ladder at what this box can show', evidence: `abr.restrictions.maxHeight null, restrictToScreenSize false; ladder to ${topH}p; UI screen ${screenH}p (the video plane may be 4K: check the HDMI output mode)`, action: 'If this model outputs 1080p, cap it; if it outputs 2160p, leave it and say so in the device config.', patch: `// only for models whose output mode is 1080p\nplayer.configure({ abr: { restrictions: { maxHeight: ${screenH} } } });` });

  const keys = Object.values(isObj(get(c, 'drm', 'preferredKeySystems')) ? (get(c, 'drm', 'preferredKeySystems') as Record<string, unknown>) : {}).concat(arr(get(c, 'drm', 'preferredKeySystems'))).map(String);
  if (keys[0]) out.push({ id: 'shaka-keys', level: 'could', area: 'drm', title: `Key system order already set: ${keys.join(', ')}`, evidence: `drm.preferredKeySystems ${JSON.stringify(keys)}, licence servers configured for ${arr(get(c, 'drm', 'servers')).join(', ') || 'none'}`, action: 'Nothing to change; keep it per model, since Widevine here only reaches SW_SECURE_DECODE.' });

  if (v && /^v?[0-4]\./.test(v)) out.push({ id: 'shaka-old', level: 'could', area: 'playback', title: `Shaka ${v}`, evidence: 'an older major version', action: 'Newer Shaka handles codec switching and MSE recovery better on old engines; upgrade when you next touch the player.' });
  return out;
};

/** Every request the page made, from the engine's own resource timing: hosts, repeats, work during playback. */
const resourceRules: Rule = (r) => {
  const out: Advice[] = [];
  const res = r.resources;
  const es = arr(get(res, 'entries')).filter(isObj).map((e) => ({ u: String(e.u ?? ''), t: String(e.t ?? ''), s: num(e.s) ?? 0, d: num(e.d) ?? 0 }));
  if (!es.length) return out;
  const host = (u: string) => /^https?:\/\/([^/]+)/.exec(u)?.[1] ?? '(page)';
  const shape = (e: { u: string; t: string }) => `${e.t} ${host(e.u)}${e.u.replace(/^https?:\/\/[^/]+/, '').split('?')[0]!.replace(/\/\d+(?=\/|$)/g, '/:n').slice(0, 70)}`;
  const hosts = [...new Set(es.map((e) => host(e.u)))];

  const env = hosts.filter((h) => /(^|[.-])(test|staging|stage|stg|dev|qa|uat|sandbox)([.-]|$)/i.test(h));
  if (env.length) {
    const prod = hosts.filter((h) => !env.includes(h) && /^api\./.test(h));
    out.push({ id: 'test-hosts', level: 'should', area: 'network', title: `The page calls ${env.length > 1 ? 'test hosts' : `a test host, ${env[0]}`}${prod.length ? `, alongside ${prod.join(', ')}` : ''}`, evidence: env.map((h) => `${h} ×${es.filter((e) => host(e.u) === h).length}`).join(', '), examples: es.filter((e) => env.includes(host(e.u))).slice(0, 6).map((e) => `${e.t} ${e.u}`), action: 'A build that mixes environments: check the config this device type gets (a per-platform override left pointing at test, or a feature-flag service). Each extra host is a DNS lookup and TLS handshake on this CPU.' });
  }

  const vt = num(get(res, 'videoT'));
  const now = num(get(res, 'now'));
  if (vt !== null && now !== null && vt > 5000) {
    const since = now - vt;
    const during = es.filter((e) => e.s > since + 2000 && !/\.(m4s|mp4|ts|m4v|m4a|cmfv|cmfa|vtt)(\?|$)/.test(e.u));
    if (during.length >= 3) {
      const by = new Map<string, number>();
      for (const e of during) by.set(shape(e), (by.get(shape(e)) ?? 0) + 1);
      out.push({ id: 'work-while-playing', level: 'should', area: 'javascript', title: `${during.length} requests while the video plays`, evidence: `in the ${Math.round(vt / 1000)} s since playback started (from the video's clock); each response is parsed and often rendered on the main thread the player and the key handlers share`, examples: [...by].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, n]) => `${k} ×${n}`), action: 'Pause rails, recommendations, image preloading and polling while the player is in front; resume on exit. Leave only the player, heartbeat and analytics batches.', check: 'tlpt q capture 10 during playback, before and after pausing them: lag p95 and fps' });
    }
  }

  const rep = new Map<string, number>();
  for (const e of es) if (e.t === 'fetch' || e.t === 'xmlhttprequest') rep.set(e.u, (rep.get(e.u) ?? 0) + 1);
  const repeated = [...rep].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
  if (repeated.length) out.push({ id: 'repeat-api', level: repeated.some(([, n]) => n > 3) ? 'should' : 'could', area: 'network', title: `${repeated.length} API call${repeated.length > 1 ? 's' : ''} made more than once`, evidence: 'the same URL (query values aside) from fetch or XHR in this page session', examples: repeated.slice(0, 8).map(([u, n]) => `${u} ×${n}`), action: 'Cache by URL for the session (or until the data says it changed); a re-render must not refetch.' });

  const imgs = es.filter((e) => e.t === 'img' || (e.t === 'css' && /\.(png|jpe?g|webp|avif|gif)(\?|$)/i.test(e.u)));
  const widths = [...new Set(imgs.map((e) => /[?&](?:w|width|resize)=(\d+)/.exec(e.u)?.[1]).filter(Boolean))];
  const pngs = imgs.filter((e) => /\.png(\?|$)/i.test(e.u));
  const webp = flat(r.graphics).webp === true;
  if (imgs.length >= 20 || pngs.length >= 5)
    out.push({ id: 'images', level: 'could', area: 'network', title: `${imgs.length} images${pngs.length ? `, ${pngs.length} of them PNG` : ''}`, evidence: `from ${[...new Set(imgs.map((e) => host(e.u)))].join(', ')}${widths.length ? `; widths asked for: ${widths.join(', ')}` : ''}${webp ? '; the engine decodes WebP' : ''}`, examples: pngs.slice(0, 5).map((e) => e.u), action: `Ask the image CDN for ${webp ? 'WebP (supported here)' : 'JPEG'} at the drawn size; PNG photos and logos decode slowly on this CPU and hold more memory. Load only visible tiles plus one each side.` });

  const hidden = hosts.filter((h) => h !== '(page)' && es.filter((e) => host(e.u) === h).every((e) => e.d === 0));
  out.push({
    id: 'hosts',
    level: 'could',
    area: 'network',
    title: `${hosts.length} hosts in ${es.length} requests${get(res, 'bufferFull') ? ' (the engine kept only the last 150)' : ''}`,
    evidence: hidden.length ? `no timings from ${hidden.join(', ')}: they send no Timing-Allow-Origin, so neither this tool nor your RUM can see their latency on devices` : 'every host exposes timing',
    examples: hosts.map((h) => {
      const hs = es.filter((e) => host(e.u) === h);
      const ds = hs.map((e) => e.d).filter((d) => d > 0).sort((a, b) => a - b);
      return `${h}: ${hs.length} (${[...new Set(hs.map((e) => e.t))].join('/')})${ds.length ? `, median ${ms(ds[Math.floor(ds.length / 2)]!)}` : ''}`;
    }),
    action: `${hidden.length ? 'Send Timing-Allow-Origin from your own API and image hosts so their latency is measurable on devices. ' : ''}Call performance.setResourceTimingBufferSize(500) at start so long sessions keep their history.${hosts.length > 4 ? ' Preconnect to the API and image hosts early.' : ''}`,
  });
  return out;
};

const RULES: Rule[] = [codecRules, playbackRules, playerConfigRules, inputRules, renderRules, cssRules, jsRules, networkRules, resourceRules, memoryRules];
const RANK: Record<Level, number> = { must: 0, should: 1, could: 2 };

/** Every piece of advice the answers support, most important first. */
export function advise(r: Raw): Advice[] {
  const m = flat(r.media);
  const out: Advice[] = [];
  for (const rule of RULES) {
    try {
      out.push(...rule(r, m));
    } catch {
      // One rule tripping on an answer it didn't expect must not cost the rest.
    }
  }
  return out.sort((a, b) => RANK[a.level] - RANK[b.level]);
}
