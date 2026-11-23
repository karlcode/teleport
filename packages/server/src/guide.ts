// The guide: what is worth profiling in an app on a device, as short entries an agent or a person reads
// before designing a trial. Each says why it matters on a device, which profile metrics show it, what to
// ask the engine (ES5 expressions for a trial's checks) and what to try as variants. Generic device and
// web knowledge only; every claim here is something to measure, not a result.
import { AVIF_1PX, WEBP_1PX } from './probes.js';

export interface Consideration {
  id: string;
  title: string;
  why: string;
  /** Profile metrics that move when this matters. */
  shows: string[];
  /** ES5 expressions for a trial's checks; a Promise is waited for. */
  ask: string[];
  /** Variants worth trying. */
  try: string[];
  /** Words people use for it, for finding it. */
  words: string;
}

const MS = '(window.MediaSource||window.WebKitMediaSource)';
const supports = (prop: string, value: string) => `typeof CSS!=='undefined'&&CSS.supports?CSS.supports(${JSON.stringify(prop)},${JSON.stringify(value)}):null`;
const parses = (src: string) => `(function(){try{new Function(${JSON.stringify(src)});return true}catch(e){return false}})()`;
const native = (name: string) => `typeof ${name}==='function'&&/\\[native code\\]/.test(Function.prototype.toString.call(${name}))`;
const decodes = (uri: string) => `new Promise(function(r){var i=new Image();i.onload=function(){r(i.width>0)};i.onerror=function(){r(false)};i.src=${JSON.stringify(uri)}})`;
const keySystem = (name: string, robustness: string) =>
  `navigator.requestMediaKeySystemAccess?navigator.requestMediaKeySystemAccess(${JSON.stringify(name)},[{initDataTypes:['cenc'],videoCapabilities:[{contentType:'video/mp4; codecs="avc1.640028"',robustness:${JSON.stringify(robustness)}}]}]).then(function(){return true},function(){return false}):null`;

export const CONSIDERATIONS: Consideration[] = [
  {
    id: 'startup',
    title: 'Startup: the first useful screen',
    why: "The time from launch to a usable home screen is what people judge first. Before it, the page fetches, parses and runs its bundle, builds the DOM and decodes the first images, on a CPU several times slower than a laptop's.",
    shows: ['loadMs', 'scriptsMs', 'resources', 'resourceKB', 'domNodes', 'imageKB'],
    ask: ["typeof requestIdleCallback!=='undefined'", "typeof IntersectionObserver!=='undefined'", "'loading' in HTMLImageElement.prototype"],
    try: ["the app's built entry (its scripts as assets) against a trimmed one", 'the same bundle split so the first screen loads alone', "the first screen's CSS inline against a stylesheet"],
    words: 'launch boot splash first paint start startup cold home screen time to interactive',
  },
  {
    id: 'bundle',
    title: 'Bundle size, syntax and transpile target',
    why: 'Old engines parse and compile slowly and lack modern syntax. Code built for them is larger and slower to start; code built for a newer engine than the device throws a SyntaxError and nothing runs.',
    shows: ['scriptsMs', 'loadMs', 'longTaskMs', 'errors'],
    ask: [parses('var f=(a)=>a'), parses('let a=1;const b=2'), parses('class A{}'), parses('async function f(){await 1}'), parses('var o={...{a:1}}'), parses('var a={};a?.b'), parses('var s=`x${1}`')],
    try: ['the same code built for ES5 against a newer target', 'minified against not', 'one bundle against several'],
    words: 'javascript js parse compile babel transpile target es5 es2015 es6 syntax bundle webpack vite rollup size chunk',
  },
  {
    id: 'polyfills',
    title: 'Polyfills the device may not need',
    why: 'A polyfill costs download, parse and memory on every launch. Where the engine has the feature natively it is dead weight, and one that replaces a native implementation can be slower.',
    shows: ['scriptsMs', 'heapDeltaKB', 'loadMs'],
    ask: [native('Promise'), native('fetch'), native('Object.assign'), native('Array.prototype.includes'), native('Symbol'), native('Map'), native('IntersectionObserver')],
    try: ["the polyfill loaded with the native global removed in before (try{delete window.Promise}catch(e){}) against the native one", "the app's polyfill bundle against none"],
    words: 'polyfill polyfills core-js shim native promise fetch dead weight',
  },
  {
    id: 'main-thread',
    title: 'Long tasks on the main thread',
    why: "One thread runs the app's JavaScript, style, layout and often paint. While a task runs, key presses, timers and animations wait, and a task that is short on a laptop runs several times longer on a device.",
    shows: ['longTaskMs', 'longTasks', 'lagMaxMs', 'lagP95Ms', 'keyFrameMs'],
    ask: ["typeof PerformanceObserver!=='undefined'&&!!PerformanceObserver.supportedEntryTypes&&PerformanceObserver.supportedEntryTypes.indexOf('longtask')>=0", "typeof requestIdleCallback!=='undefined'"],
    try: ['the work in one go against chunked with setTimeout', 'the work in the key handler against after the next frame'],
    words: 'jank janky block blocked freeze frozen busy cpu task tasks long slow stutter',
  },
  {
    id: 'paint',
    title: 'Paint-heavy CSS',
    why: "box-shadow, filter and blur, border-radius with clipping, gradients and opacity over large areas are expensive to rasterize on a device's GPU or software rasterizer, and cost again whenever the element repaints: as it animates, or takes and loses focus.",
    shows: ['frameP95Ms', 'frameWorstMs', 'slowFrames', 'fps', 'keyFrameMs'],
    ask: [supports('filter', 'blur(2px)'), `${supports('backdrop-filter', 'blur(2px)')}||${supports('-webkit-backdrop-filter', 'blur(2px)')}`],
    try: ['a moving or focusing tile with box-shadow against a border', 'a blur filter against a pre-blurred image', 'a focus ring as outline against box-shadow'],
    words: 'css shadow shadows box-shadow blur filter gradient radius rounded opacity paint raster repaint effects glow',
  },
  {
    id: 'compositing',
    title: 'Animate transform and opacity, not layout',
    why: 'Animating left, top, width or height reflows and repaints every frame; transform and opacity can move a layer without either. Too many layers (will-change everywhere, a 3D transform on every tile) cost GPU memory, which a device has little of.',
    shows: ['fps', 'frameP95Ms', 'frameWorstMs', 'layoutMs'],
    ask: [supports('will-change', 'transform'), supports('transform', 'translate3d(0,0,0)')],
    try: ['a rail scrolled by left against transform', 'will-change on every tile against the focused one only', 'a CSS transition against requestAnimationFrame'],
    words: 'animation animate animated transform translate will-change layer layers gpu compositor composite scroll rail carousel slide transition',
  },
  {
    id: 'layout',
    title: 'DOM size and forced layout',
    why: 'Every element is styled and laid out, so long lists and deep trees make each reflow slower, and reading a size right after changing a style forces a reflow on the spot. Old engines are slowest at both.',
    shows: ['domNodes', 'layoutMs', 'keyFrameMs', 'longTaskMs'],
    ask: [supports('contain', 'layout'), supports('content-visibility', 'auto')],
    try: ['the full list against only the rows on screen', 'reads then writes against interleaved', 'flexbox against absolute positioning for a grid of tiles'],
    words: 'dom node nodes elements list lists virtualize virtualise virtual reflow layout thrashing offsetheight getboundingclientrect tree',
  },
  {
    id: 'css-support',
    title: 'CSS the engine lacks',
    why: "Missing CSS falls back silently, so the page looks wrong rather than failing: grid, aspect-ratio, custom properties, position: sticky, :focus-visible, object-fit. Flex gap can't be asked with CSS.supports; measure an element's box with and without it.",
    shows: [],
    ask: [supports('display', 'grid'), supports('aspect-ratio', '1'), supports('--x', '0'), `${supports('position', 'sticky')}||${supports('position', '-webkit-sticky')}`, "typeof CSS!=='undefined'&&CSS.supports?CSS.supports('selector(:focus-visible)'):null", supports('object-fit', 'cover')],
    try: ['the modern layout against its fallback, each reporting the box sizes that matter with T.set'],
    words: 'css support supported grid flexbox flex gap aspect ratio sticky variables custom properties fallback prefix webkit selector',
  },
  {
    id: 'images',
    title: 'Image format, size and decoded memory',
    why: "A decoded image takes width × height × 4 bytes whatever its format, so a 3840×2160 image holds about 32 MB. A device's small image cache evicts and decodes again while scrolling, which shows as hitches. WebP and AVIF save bytes but can decode slower, and AVIF needs Chrome 85 or later.",
    shows: ['imageKB', 'images', 'imagesBroken', 'resourceKB', 'frameWorstMs', 'loadMs'],
    ask: [decodes(WEBP_1PX), decodes(AVIF_1PX)],
    try: ['the same picture as JPEG, WebP and AVIF', 'served at the size it is shown against larger', 'one sprite against many files', 'eager against lazy for images off screen'],
    words: 'image images picture jpg jpeg png webp avif gif decode decoding memory sprite poster thumbnail artwork tile',
  },
  {
    id: 'fonts',
    title: 'Web fonts',
    why: 'A web font is fetched, decoded and rasterized per glyph and size; large fonts (CJK) cost memory, some engines show no text until the font loads, and WOFF2 needs a newer engine than WOFF.',
    shows: ['resourceKB', 'loadMs', 'frameWorstMs', 'heapDeltaKB'],
    ask: ["typeof document.fonts!=='undefined'", "typeof FontFace!=='undefined'"],
    try: ['WOFF2 against WOFF against TTF of one font', 'a subset against the full font', 'the system font against a web font'],
    words: 'font fonts webfont woff woff2 ttf otf typeface text glyph glyphs cjk',
  },
  {
    id: 'video',
    title: 'Video: codecs, containers and players',
    why: "The video element may play a format natively, only through Media Source Extensions with a player, or not at all, and support is decided by the exact codec string (profile and level), not the codec's name. HLS and DASH manifests list those strings (CODECS, codecs). Many devices have one hardware decoder, so a preview or background video can fail or stall the main one.",
    shows: ['media', 'mediaDecoded', 'mediaDropped', 'mediaErrors', 'mediaError', 'frameWorstMs'],
    ask: [
      `${MS}?${MS}.isTypeSupported('video/mp4; codecs="avc1.640028"'):null`,
      `${MS}?${MS}.isTypeSupported('video/mp4; codecs="hvc1.1.6.L120.90"'):null`,
      `${MS}?${MS}.isTypeSupported('audio/mp4; codecs="ec-3"'):null`,
      "document.createElement('video').canPlayType('application/vnd.apple.mpegurl')",
      "document.createElement('video').canPlayType('application/dash+xml')",
    ],
    try: ['the stream natively against through hls.js, dash.js or shaka (as scripts)', "the stream's top rendition against a lower profile", 'one video element against two', "quiet: ['video'] to free the app's own decoder"],
    words: 'video videos stream streaming hls dash m3u8 mpd mse mediasource codec codecs h264 avc hevc h265 vp9 av1 player shaka hlsjs dashjs playback buffering container mp4',
  },
  {
    id: 'drm',
    title: 'DRM key systems and robustness',
    why: 'Which key systems a device grants, at which robustness, decides whether protected content plays at all and at what resolution, and it differs by model and firmware. A license that works on a desktop can be refused on the device for the same codec.',
    shows: ['mediaErrors', 'mediaError'],
    ask: [keySystem('com.widevine.alpha', 'HW_SECURE_ALL'), keySystem('com.widevine.alpha', 'SW_SECURE_CRYPTO'), keySystem('com.microsoft.playready.recommendation', '3000'), keySystem('com.microsoft.playready', '')],
    try: ['each robustness level the app asks for, as a check', "the stream's own video codec string in videoCapabilities"],
    words: 'drm eme widevine playready fairplay license key system keysystem robustness protected encrypted cenc hdcp',
  },
  {
    id: 'video-plane',
    title: 'Hardware video plane (punch-through)',
    why: 'Many devices draw video on a plane behind the page and show it through a transparent hole. Canvas reads of the video then come back black; CSS transforms, filters, rounded corners and opacity on the video may not apply; and elements over it can tear.',
    shows: ['mediaDecoded', 'frameWorstMs'],
    ask: [],
    try: ['a measure that draws the playing video into a 16×16 canvas and reports whether every pixel is black', 'the video with an overlay against without', 'a transformed video against a plain one'],
    words: 'holepunch hole punch punch-through video plane overlay transparent canvas black tearing',
  },
  {
    id: 'memory',
    title: 'Memory limits and leaks',
    why: 'The browser on a device gets far less memory than on a desktop, and when it runs out the app is killed or reloaded without an error. A leak shows as heap that grows run after run; decoded images and the DOM count too, outside the JS heap.',
    shows: ['heapKB', 'heapDeltaKB', 'imageKB', 'domNodes'],
    ask: ["typeof navigator.deviceMemory!=='undefined'?navigator.deviceMemory:null", 'window.performance&&performance.memory?Math.round(performance.memory.jsHeapSizeLimit/1048576):null'],
    try: ['runs: 20 of the same variant, watching the heap', 'a screen opened and closed with keys in a loop', 'with a cache against without'],
    words: 'memory ram heap leak leaks oom out of memory crash crashes killed reload',
  },
  {
    id: 'gc',
    title: 'Garbage collection pauses',
    why: 'Allocating in hot paths (closures and objects per frame, array copies, string building) makes the collector run often, and each run pauses the main thread: a worst frame or a late key.',
    shows: ['frameWorstMs', 'lagMaxMs', 'longTaskMs', 'heapDeltaKB'],
    ask: ['!!(window.performance&&performance.memory)'],
    try: ['allocating per frame against reusing buffers', 'parsing per update against once'],
    words: 'garbage collection collector gc allocation allocate allocations closures objects pause pauses',
  },
  {
    id: 'timers',
    title: 'Timers and animation frames',
    why: 'Animation driven by setInterval drifts and stacks up on a slow engine; requestAnimationFrame follows the display, but some devices draw pages below 60 Hz. Timers fire late whenever the main thread is busy.',
    shows: ['fps', 'frameP95Ms', 'lagP95Ms', 'lagMaxMs'],
    ask: ["typeof requestAnimationFrame!=='undefined'||typeof webkitRequestAnimationFrame!=='undefined'", "typeof requestIdleCallback!=='undefined'"],
    try: ['an animation by setInterval against requestAnimationFrame against a CSS transition'],
    words: 'timer timers settimeout setinterval requestanimationframe raf 30fps 60fps refresh rate frame rate',
  },
  {
    id: 'input',
    title: 'Remote keys and focus navigation',
    why: 'Each press runs key handlers, moves focus, often scrolls a rail and repaints the old and new tile. A held key repeats faster than a slow page can follow, so presses queue; spatial navigation that measures every focusable element on each press gets slower as the page grows.',
    shows: ['keyFrameMs', 'keyFrameMaxMs', 'keyHandlerMs', 'longTaskMs', 'layoutMs'],
    ask: ["typeof KeyboardEvent!=='undefined'&&'key' in KeyboardEvent.prototype", "typeof Element!=='undefined'&&typeof Element.prototype.scrollIntoView==='function'"],
    try: ["keys: ['right','right','right'] with focus effects on against off", 'a handler that measures every tile against one that knows its neighbours', 'key repeat throttled against not'],
    words: 'remote key keys press presses pressed keydown focus navigation spatial arrow ok back latency input responsive responsiveness sluggish',
  },
  {
    id: 'network',
    title: 'Requests, TLS and HTTP on old engines',
    why: 'Old engines may lack HTTP/2 and newer TLS, and handshakes cost more on a slow CPU. Many small requests cost more than a few larger ones, and a cross-origin request with custom headers adds a preflight each time.',
    shows: ['resources', 'resourceKB', 'resourceMaxMs', 'loadMs'],
    ask: ["typeof fetch!=='undefined'", "typeof PerformanceResourceTiming!=='undefined'&&'transferSize' in PerformanceResourceTiming.prototype", "typeof navigator.connection!=='undefined'"],
    try: ['the same data as one request against many', 'files through teleport against from the CDN', 'a request with a custom header (a preflight) against without'],
    words: 'network request requests http http2 http/2 tls https ssl cdn cors preflight latency api fetch xhr server serving',
  },
  {
    id: 'caching',
    title: 'Compression and caching',
    why: "Compressed responses save bytes but cost decompression on the device, and brotli needs https and a newer engine than gzip. A device's HTTP cache can be small or cleared on restart, so a launch often fetches everything again.",
    shows: ['resourceKB', 'resourceMaxMs', 'loadMs'],
    ask: ["'caches' in window", "typeof navigator.serviceWorker!=='undefined'"],
    try: ['compressed against not', 'a cold run against a warm one, the same file loaded twice in setup'],
    words: 'compression compressed gzip brotli cache caching etag headers service worker offline',
  },
  {
    id: 'data',
    title: 'Large JSON and data shaping',
    why: 'JSON.parse of a large response blocks the main thread in one piece, and turning it into view models allocates; both take several times longer on a device than on a laptop. Shaping data on the server saves the device the work.',
    shows: ['longTaskMs', 'lagMaxMs', 'heapDeltaKB'],
    ask: ["typeof Worker!=='undefined'"],
    try: ['the full response against a trimmed one (two JSON files as assets, fetched and parsed in setup)', 'parsing in a worker against on the main thread'],
    words: 'json parse parsing data api payload response large model models',
  },
  {
    id: 'storage',
    title: 'Storage',
    why: 'localStorage is synchronous, so large reads and writes block; its quota may be small and the platform may clear it. IndexedDB may be missing or unreliable on old engines, and cookies may not survive an app restart.',
    shows: ['longTaskMs', 'lagMaxMs', 'errors'],
    ask: [
      "(function(){try{localStorage.setItem('__tlpt','1');localStorage.removeItem('__tlpt');return true}catch(e){return false}})()",
      "typeof indexedDB!=='undefined'",
      "navigator.storage&&navigator.storage.estimate?navigator.storage.estimate().then(function(e){return Math.round(e.quota/1048576)+' MB'}):null",
    ],
    try: ['one large localStorage value against many small ones', 'localStorage against IndexedDB for the same data'],
    words: 'storage localstorage sessionstorage indexeddb cookie cookies quota persist persistence',
  },
  {
    id: 'graphics',
    title: 'Canvas and WebGL',
    why: 'WebGL may be missing, slow or limited in texture size, and canvas 2D may be drawn in software, so a canvas animation that is smooth on a laptop can be the slowest way on a device.',
    shows: ['fps', 'frameP95Ms', 'frameWorstMs', 'heapDeltaKB'],
    ask: [
      "(function(){try{var c=document.createElement('canvas');return !!(c.getContext('webgl')||c.getContext('experimental-webgl'))}catch(e){return false}})()",
      "(function(){try{var g=document.createElement('canvas').getContext('webgl');return g?g.getParameter(g.MAX_TEXTURE_SIZE):null}catch(e){return null}})()",
    ],
    try: ['the same animation in CSS, canvas 2D and WebGL'],
    words: 'canvas webgl gl gpu texture 2d drawing draw game graphics',
  },
  {
    id: 'workers',
    title: 'Workers',
    why: 'Moving work to a Web Worker keeps keys responsive only where workers exist and start quickly; on some devices they are missing or slow to start, and messages copy their data both ways.',
    shows: ['longTaskMs', 'keyFrameMs', 'loadMs'],
    ask: ["typeof Worker!=='undefined'", "typeof SharedArrayBuffer!=='undefined'", "typeof OffscreenCanvas!=='undefined'"],
    try: ['the same work in a worker (a Blob URL in setup) against on the main thread'],
    words: 'worker workers web worker thread threads offload background parallel',
  },
  {
    id: 'quirks',
    title: 'Engine quirks',
    why: 'Old engines differ in small ways that break apps quietly: Date parses only some string formats, Intl may be missing or partial, newer array and string methods are absent, KeyboardEvent.key may be missing so only keyCode works. Ask the exact thing the app relies on.',
    shows: ['errors'],
    ask: [
      "!isNaN(new Date('2024-01-02 03:04:05').getTime())",
      "typeof Intl!=='undefined'&&typeof Intl.DateTimeFormat!=='undefined'",
      "typeof Array.prototype.includes==='function'",
      "typeof Object.entries==='function'",
      "typeof String.prototype.padStart==='function'",
    ],
    try: ['a check for each suspect', "the app's code path with and without a workaround"],
    words: 'quirk quirks bug bugs engine date intl locale array includes keycode compatibility old chromium webkit broken',
  },
];

const STOP = new Set('a an and are as at be but by can do does for from how i if in is it my of on or so that the this to what when which why with on'.split(' '));
const tokens = (s: string) => s.toLowerCase().split(/[^a-z0-9.+-]+/).filter((t) => t.length > 1 && !STOP.has(t));
const near = (a: string, b: string) => a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)));

/** The topics, without words; with words, the entries that match them best, best first. */
export function guide(words: string): { topics?: { id: string; title: string }[]; matches?: Consideration[] } {
  const q = [...new Set(tokens(words))];
  if (!q.length) return { topics: CONSIDERATIONS.map((c) => ({ id: c.id, title: c.title })) };
  const scored = CONSIDERATIONS.map((c) => {
    const strong = tokens(`${c.id} ${c.title} ${c.words}`);
    const weak = tokens(`${c.why} ${c.try.join(' ')}`);
    let score = 0;
    for (const t of q) score += strong.some((w) => near(t, w)) ? 3 : weak.some((w) => near(t, w)) ? 1 : 0;
    return { c, score };
  });
  return { matches: scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 3).map((x) => x.c) };
}
