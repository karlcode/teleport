// Questions `tlpt q probe` asks a device on demand. Each probe is ES5 that runs once through the
// inspector (Runtime.evaluate on a lease, never on a timer), a parser that turns the raw answer into
// a typed result here at the boundary, and the time the script measured for itself on the device.
// One registry (PROBES) says what each probe asks; the capability catalogue below drives both the
// device script and the parser, so a check can't be asked and then dropped, or shown and never asked.
// Alongside: the Rendering tab's page tools (ES5 applied and undone in the page), storage edits,
// and the page commands, which run the same way.

import { OPEN_SECURELY } from './errors.js';

/** One capability reading: yes, no, a value, or null when the device can't say (the API to ask is missing, or the check threw). */
export type Reading = boolean | number | string | null;

export interface CapItem {
  k: string;
  label: string;
  v: Reading;
  /** What was evaluated, for the hover. */
  what: string;
}

export interface CapGroup {
  id: string;
  label: string;
  items: CapItem[];
}

export interface Capabilities {
  groups: CapGroup[];
  /** Main-thread time the script measured for itself, ms; null when the device has no clock to say. */
  ms: number | null;
  /** For a probe that waits on the device (decoders, key systems, frames): until the answer settled. */
  wallMs: number | null;
  /** What the readings can't say for themselves, such as why a whole group reads as unknown. */
  notes?: string[];
}

export interface StorageEntry {
  key: string;
  preview: string;
  /** UTF-16 code units × 2: what the engine holds, not what the disk holds. */
  bytes: number;
  /** The whole value, for editing, while it is short and the probe's budget for them lasts; else null. */
  full: string | null;
}

export interface StorageArea {
  count: number;
  bytes: number;
  entries: StorageEntry[];
  /** More keys than the probe lists. */
  capped: boolean;
}

export interface CookieEntry {
  name: string;
  preview: string;
  bytes: number;
}

export interface IdbStore {
  name: string;
  /** null when counting failed or wasn't tried. */
  count: number | null;
}

export interface IdbDatabase {
  name: string;
  version: number | null;
  /** null when the database couldn't be opened to list its stores. */
  stores: IdbStore[] | null;
}

export interface CacheInfo {
  name: string;
  entries: number | null;
}

export interface WorkerInfo {
  scope: string;
  state: string;
  scriptURL: string;
}

export interface StorageReport {
  /** null: the area isn't there, or access threw (storage disabled). */
  local: StorageArea | null;
  session: StorageArea | null;
  cookies: { count: number; bytes: number; entries: CookieEntry[] } | null;
  /** `databases` is null when the engine has no indexedDB.databases() to list them with. */
  indexedDB: { databases: IdbDatabase[] | null; capped: boolean } | null;
  caches: CacheInfo[] | null;
  workers: WorkerInfo[] | null;
  quota: { usageBytes: number | null; quotaBytes: number | null; persisted: boolean | null } | null;
  ms: number | null;
  wallMs: number | null;
}

export interface DomReport {
  elements: number;
  textNodes: number;
  depth: number;
  /** The element at the greatest depth. */
  deepest: string;
  /** Under <body>, the element with the most descendants. */
  largest: { path: string; descendants: number } | null;
  /** The element with the most direct children. */
  widest: { path: string; children: number } | null;
  counts: Record<DomTag, number>;
  stylesheets: number;
  /** Rules across the sheets this origin may read; null when none could be read. */
  rules: number | null;
  ms: number | null;
}

export const DOM_TAGS = ['img', 'video', 'audio', 'iframe', 'canvas', 'svg', 'script', 'style', 'link'] as const;
export type DomTag = (typeof DOM_TAGS)[number];

export interface FocusReport {
  /** document.activeElement, as the agent names elements; null when nothing has DOM focus. */
  active: string | null;
  /** The element the focus selector marks (the agent's default list, or the script tag's data-focus). */
  marked: string | null;
  selector: string;
  /** Whether the marked element is what the agent would report as focused. */
  tabindex: number | null;
  box: [number, number, number, number] | null;
  /** Elements the keyboard can reach: a[href], button, input, [tabindex]. */
  focusable: number;
  ms: number | null;
}

export interface ProbeResults {
  identity: Capabilities;
  features: Capabilities;
  media: Capabilities;
  graphics: Capabilities;
  storage: StorageReport;
  dom: DomReport;
  focus: FocusReport;
  speed: SpeedReport;
}

export type ProbeId = keyof ProbeResults;

export interface ProbeDef<R> {
  label: string;
  /** What it answers, in a few words, for the palette and help. */
  about: string;
  /** What running it costs the device, in words. */
  cost: string;
  /** ES5 that evaluates to the answer, or to a Promise of it. */
  script: string;
  /** How long the laptop waits for the answer, for a probe that holds a slow device longer than a question's 15 s. */
  waitMs?: number;
  parse(raw: unknown): R;
}

const q = (s: string) => JSON.stringify(s);
const MAX_STR = 200;
const PREVIEW = 120;
const MAX_ENTRIES = 200;
const MAX_LIST = 20;
/** A value this long or shorter comes back whole, for editing, until FULL_BUDGET characters have. */
const FULL_MAX = 2048;
const FULL_BUDGET = 65536;
/** An async probe answers with what it has by then. */
const SETTLE_MS = 4000;

// ---- Capability catalogue -------------------------------------------------------------------------

interface Check {
  k: string;
  label: string;
  /** An ES5 function body returning the reading, or a Promise of it. */
  code: string;
  /** Shown on hover; the expression itself when the body is one `return`. */
  what?: string;
}

interface GroupDef {
  id: string;
  label: string;
  checks: Check[];
}

const c = (k: string, label: string, expr: string, what?: string): Check => ({ k, label, code: `return ${expr}`, what: what ?? expr });
const sup = (k: string, label: string, prop: string, value: string): Check => c(k, label, `CSS.supports(${q(prop)},${q(value)})`);
const sel = (k: string, label: string, selector: string): Check => c(k, label, `CSS.supports(${q(`selector(${selector})`)})`);
/** Parses the source without running it: a syntax check of the engine, nothing more. */
const syntax = (k: string, label: string, src: string): Check => c(k, label, `(function(){try{new Function(${q(src)});return true}catch(e){return false}})()`, `new Function(${q(src)})`);
const def = (k: string, label: string, name: string): Check => c(k, label, `typeof ${name}!=='undefined'`);
const inProto = (k: string, label: string, type: string, prop: string): Check => c(k, label, `typeof ${type}!=='undefined'&&${q(prop)} in ${type}.prototype`);
const mm = (k: string, label: string, query: string): Check => c(k, label, `matchMedia(${q(query)}).matches`);
const mse = (k: string, label: string, type: string): Check => c(k, label, `MS()?MS().isTypeSupported(${q(type)}):null`, `MediaSource.isTypeSupported(${q(type)})`);
const play = (k: string, label: string, type: string): Check => c(k, label, `V().canPlayType?(V().canPlayType(${q(type)})||'no'):null`, `video.canPlayType(${q(type)})`);
const entry = (k: string, label: string, type: string): Check => c(k, label, `ET()?ET().indexOf(${q(type)})>=0:null`, `PerformanceObserver.supportedEntryTypes has ${q(type)}`);
const gl = (k: string, label: string, expr: string, what?: string): Check => c(k, label, `GL()?(${expr}):null`, what ?? expr.replace(/GL\(\)/g, 'gl'));
const gl2 = (k: string, label: string, expr: string): Check => c(k, label, `GL2()?(${expr}):null`, expr.replace(/GL2\(\)/g, 'gl2'));
const ext = (k: string, label: string, name: string): Check => gl(k, label, `!!GL().getExtension(${q(name)})`, `gl.getExtension(${q(name)})`);

const CONN = "(navigator.connection||navigator.webkitConnection||navigator.mozConnection)";
const NAV_ENTRY = "(P&&P.getEntriesByType?P.getEntriesByType('navigation')[0]:null)";
const WIDEVINE_LEVELS = ['HW_SECURE_ALL', 'HW_SECURE_DECODE', 'HW_SECURE_CRYPTO', 'SW_SECURE_DECODE', 'SW_SECURE_CRYPTO', ''];
const PLAYREADY_LEVELS = ['3000', '2000', '150', ''];
/** Asks for a key system at each robustness in turn; answers with the first level the device grants ("yes" for no level), or false. */
const keySystem = (k: string, label: string, name: string, levels: string[] = ['']): Check => ({
  k,
  label,
  code: `if(!navigator.requestMediaKeySystemAccess)return null;var L=${JSON.stringify(levels)},i=0;function next(){if(i>=L.length)return false;var r=L[i++];return navigator.requestMediaKeySystemAccess(${q(name)},KS(r)).then(function(){return r||'yes'},next)}return next()`,
  what: `requestMediaKeySystemAccess(${q(name)}) · avc1.42E01E + mp4a.40.2, cenc${levels.length > 1 ? ' · highest robustness granted' : ''}`,
});
const image = (k: string, label: string, dataUri: string): Check => ({
  k,
  label,
  code: `var i=new Image();return new Promise(function(res){var t=setTimeout(function(){res(null)},1500);i.onload=function(){clearTimeout(t);res(i.width>0)};i.onerror=function(){clearTimeout(t);res(false)};i.src=${q(dataUri)}})`,
  what: `decode a 1 px ${label} from a data: URI`,
});

export const WEBP_1PX = 'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';
export const AVIF_1PX =
  'data:image/avif;base64,AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAADybWV0YQAAAAAAAAAoaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAGxpYmF2aWYAAAAADnBpdG0AAAAAAAEAAAAeaWxvYwAAAABEAAABAAEAAAABAAABGgAAAB0AAAAoaWluZgAAAAAAAQAAABppbmZlAgAAAAABAABhdjAxQ29sb3IAAAAAamlwcnAAAABLaXBjbwAAABRpc3BlAAAAAAAAAAIAAAACAAAAEHBpeGkAAAAAAwgICAAAAAxhdjFDgQ0MAAAAABNjb2xybmNseAACAAIAAYAAAAAXaXBtYQAAAAAAAAABAAEEAQKDBAAAACVtZGF0EgAKCBgANogQEAwgMg8f8D///8WfhwB8+ErK42A=';

const IDENTITY: GroupDef[] = [
  {
    id: 'identity',
    label: 'identity',
    checks: [
      c('ua', 'user agent', 'navigator.userAgent'),
      c('platform', 'platform', 'navigator.platform'),
      c('vendor', 'vendor', 'navigator.vendor||"none"'),
      c('brands', 'ua brands', 'navigator.userAgentData?navigator.userAgentData.brands.map(function(b){return b.brand+" "+b.version}).join(", "):null', 'navigator.userAgentData.brands'),
      c('uaPlatform', 'ua platform', 'navigator.userAgentData?navigator.userAgentData.platform:null', 'navigator.userAgentData.platform'),
      c('language', 'language', 'navigator.language'),
      c('languages', 'languages', 'navigator.languages?navigator.languages.join(", "):null', 'navigator.languages'),
      c('timezone', 'time zone', 'Intl.DateTimeFormat().resolvedOptions().timeZone'),
      c('utcOffset', 'utc offset h', '-new Date().getTimezoneOffset()/60'),
      c('cookies', 'cookies enabled', 'navigator.cookieEnabled'),
      c('dnt', 'do not track', 'navigator.doNotTrack'),
      c('webdriver', 'webdriver', 'navigator.webdriver'),
      c('secure', 'secure context', 'window.isSecureContext'),
      c('isolated', 'cross-origin isolated', 'window.crossOriginIsolated'),
      c('v8', 'v8 engine', '!!Error.captureStackTrace', 'Error.captureStackTrace'),
      c('chrome', 'window.chrome', 'typeof chrome!=="undefined"'),
    ],
  },
  {
    id: 'platform',
    label: 'platform objects',
    checks: [
      def('cordova', 'cordova', 'cordova'),
    ],
  },
  {
    id: 'page',
    label: 'page',
    checks: [
      c('href', 'url', 'location.href'),
      c('title', 'title', 'document.title||"none"'),
      c('ready', 'ready state', 'document.readyState'),
      c('visibility', 'visibility', 'document.visibilityState'),
      c('quirks', 'quirks mode', 'document.compatMode==="BackCompat"'),
      c('charset', 'charset', 'document.characterSet'),
      c('referrer', 'referrer', 'document.referrer||"none"'),
      c('navType', 'navigation', `${NAV_ENTRY}?${NAV_ENTRY}.type:null`, 'performance navigation entry type'),
      c('protocol', 'protocol', `${NAV_ENTRY}?${NAV_ENTRY}.nextHopProtocol||"unknown":null`, 'navigation entry nextHopProtocol'),
      c('ttfb', 'ttfb ms', 'P&&P.timing&&P.timing.responseStart?P.timing.responseStart-P.timing.requestStart:null', 'performance.timing responseStart − requestStart'),
      c('dcl', 'domcontentloaded ms', 'P&&P.timing&&P.timing.domContentLoadedEventEnd?P.timing.domContentLoadedEventEnd-P.timing.navigationStart:null', 'performance.timing domContentLoadedEventEnd − navigationStart'),
      c('load', 'load ms', 'P&&P.timing&&P.timing.loadEventEnd?P.timing.loadEventEnd-P.timing.navigationStart:null', 'performance.timing loadEventEnd − navigationStart'),
      c('transfer', 'document kb', `${NAV_ENTRY}&&${NAV_ENTRY}.transferSize?Math.round(${NAV_ENTRY}.transferSize/1024):null`, 'navigation entry transferSize'),
      c('scripts', 'scripts', 'document.scripts.length'),
      c('sheets', 'stylesheets', 'document.styleSheets.length'),
      c('images', 'images', 'document.images.length'),
      c('frames', 'frames', 'window.frames.length'),
      c('resources', 'resources recorded', 'P&&P.getEntriesByType?P.getEntriesByType("resource").length:null', 'performance.getEntriesByType("resource").length'),
      c('uptime', 'page age s', 'P&&P.now?Math.round(P.now()/1000):null', 'performance.now()'),
    ],
  },
  {
    id: 'display',
    label: 'display',
    checks: [
      c('screen', 'screen', 'screen.width+"×"+screen.height'),
      c('avail', 'available', 'screen.availWidth+"×"+screen.availHeight'),
      c('viewport', 'viewport', 'innerWidth+"×"+innerHeight'),
      c('outer', 'window', 'outerWidth+"×"+outerHeight'),
      c('dpr', 'device pixel ratio', 'window.devicePixelRatio'),
      c('zoom', 'visual zoom', 'window.visualViewport?visualViewport.scale:null', 'visualViewport.scale'),
      c('colorDepth', 'color depth', 'screen.colorDepth'),
      c('pixelDepth', 'pixel depth', 'screen.pixelDepth'),
      c('orientation', 'orientation', 'screen.orientation?screen.orientation.type:(typeof window.orientation==="number"?String(window.orientation)+"°":null)', 'screen.orientation.type'),
      c('gamut', 'color gamut', 'matchMedia("(color-gamut: rec2020)").matches?"rec2020":matchMedia("(color-gamut: p3)").matches?"p3":matchMedia("(color-gamut: srgb)").matches?"srgb":"unknown"', '(color-gamut: rec2020 | p3 | srgb)'),
      mm('hdr', 'hdr display', '(dynamic-range: high)'),
      mm('videoHdr', 'hdr video', '(video-dynamic-range: high)'),
      c('scheme', 'color scheme', 'matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"', '(prefers-color-scheme)'),
      mm('reducedMotion', 'reduced motion', '(prefers-reduced-motion: reduce)'),
      mm('hover', 'hover', '(hover: hover)'),
      c('pointer', 'pointer', 'matchMedia("(pointer: fine)").matches?"fine":matchMedia("(pointer: coarse)").matches?"coarse":"none"', '(pointer: fine | coarse)'),
      c('update', 'update speed', 'matchMedia("(update: fast)").matches?"fast":matchMedia("(update: slow)").matches?"slow":"none"', '(update: fast | slow)'),
      c('displayMode', 'display mode', 'matchMedia("(display-mode: fullscreen)").matches?"fullscreen":matchMedia("(display-mode: standalone)").matches?"standalone":"browser"', '(display-mode)'),
      c('fullscreen', 'fullscreen api', '!!(document.fullscreenEnabled||document.webkitFullscreenEnabled)'),
      c('visualViewport', 'visual viewport', '!!window.visualViewport'),
      c('screenDetails', 'multi-screen', '!!window.getScreenDetails'),
      c('orientationLock', 'orientation lock', '!!(screen.orientation&&screen.orientation.lock)'),
    ],
  },
  {
    id: 'hardware',
    label: 'hardware',
    checks: [
      c('cores', 'cores', 'navigator.hardwareConcurrency'),
      c('deviceMemory', 'device memory gb', 'navigator.deviceMemory'),
      c('heapLimit', 'js heap limit mb', 'P&&P.memory?Math.round(P.memory.jsHeapSizeLimit/1048576):null', 'performance.memory.jsHeapSizeLimit'),
      c('heapUsed', 'js heap used mb', 'P&&P.memory?Math.round(P.memory.usedJSHeapSize/1048576):null', 'performance.memory.usedJSHeapSize'),
      c('touchPoints', 'touch points', 'navigator.maxTouchPoints'),
      c('touch', 'touch events', '"ontouchstart" in window'),
      def('pointerEvents', 'pointer events', 'PointerEvent'),
      c('gamepads', 'gamepad api', '!!(navigator.getGamepads||navigator.webkitGetGamepads)'),
      c('battery', 'battery api', '!!navigator.getBattery'),
      c('vibrate', 'vibration', '!!navigator.vibrate'),
      c('keyboard', 'keyboard api', '!!navigator.keyboard'),
      c('keyboardLock', 'keyboard lock', '!!(navigator.keyboard&&navigator.keyboard.lock)'),
    ],
  },
  {
    id: 'network',
    label: 'network',
    checks: [
      c('online', 'online', 'navigator.onLine'),
      c('connType', 'connection', `${CONN}?${CONN}.type||"unknown":null`, 'navigator.connection.type'),
      c('effective', 'effective type', `${CONN}?${CONN}.effectiveType||null:null`, 'navigator.connection.effectiveType'),
      c('downlink', 'downlink mb/s', `${CONN}&&typeof ${CONN}.downlink==="number"?${CONN}.downlink:null`, 'navigator.connection.downlink'),
      c('rtt', 'rtt ms', `${CONN}&&typeof ${CONN}.rtt==="number"?${CONN}.rtt:null`, 'navigator.connection.rtt'),
      c('saveData', 'save data', `${CONN}?!!${CONN}.saveData:null`, 'navigator.connection.saveData'),
      c('beacon', 'beacon', '!!navigator.sendBeacon'),
      def('ws', 'websocket', 'WebSocket'),
      def('sse', 'eventsource', 'EventSource'),
      def('webtransport', 'webtransport', 'WebTransport'),
      c('webrtc', 'webrtc', '!!(window.RTCPeerConnection||window.webkitRTCPeerConnection)'),
    ],
  },
];

const PERF_ENTRY_TYPES = ['longtask', 'long-animation-frame', 'event', 'first-input', 'paint', 'largest-contentful-paint', 'layout-shift', 'resource', 'navigation', 'element', 'mark', 'measure', 'visibility-state', 'soft-navigation'];

const FEATURES: GroupDef[] = [
  {
    id: 'css',
    label: 'css',
    checks: [
      c('supports', 'css.supports', 'typeof CSS!=="undefined"&&!!CSS.supports'),
      sup('grid', 'grid', 'display', 'grid'),
      sup('subgrid', 'subgrid', 'grid-template-columns', 'subgrid'),
      sup('flex', 'flexbox', 'display', 'flex'),
      {
        k: 'flexGap',
        label: 'gap in flex',
        code: 'var d=document.createElement("div");d.style.cssText="position:absolute;left:-9999px;top:0;display:flex;flex-direction:column;gap:1px;width:1px";d.appendChild(document.createElement("div"));d.appendChild(document.createElement("div"));(document.body||document.documentElement).appendChild(d);var ok=d.scrollHeight===1;d.parentNode.removeChild(d);return ok',
        what: 'a column flex box with gap: 1px measures 1 px tall (forces one layout)',
      },
      sup('aspect', 'aspect-ratio', 'aspect-ratio', '1'),
      sel('has', ':has()', ':has(a)'),
      sel('where', ':where()', ':where(a)'),
      sel('focusVisible', ':focus-visible', ':focus-visible'),
      sup('container', 'container queries', 'container-type', 'inline-size'),
      c('backdrop', 'backdrop-filter', 'CSS.supports("backdrop-filter","blur(1px)")||CSS.supports("-webkit-backdrop-filter","blur(1px)")'),
      sup('willChange', 'will-change', 'will-change', 'transform'),
      sup('contain', 'contain', 'contain', 'strict'),
      sup('contentVisibility', 'content-visibility', 'content-visibility', 'auto'),
      sup('snap', 'scroll-snap', 'scroll-snap-type', 'x mandatory'),
      sup('scrollBehavior', 'scroll-behavior', 'scroll-behavior', 'smooth'),
      sup('overscroll', 'overscroll-behavior', 'overscroll-behavior', 'contain'),
      sup('transform3d', '3d transforms', 'transform-style', 'preserve-3d'),
      sup('perspective', 'perspective', 'perspective', '1px'),
      sup('vars', 'custom properties', 'color', 'var(--a)'),
      sup('sticky', 'position: sticky', 'position', 'sticky'),
      sup('objectFit', 'object-fit', 'object-fit', 'cover'),
      sup('clipPath', 'clip-path', 'clip-path', 'inset(1px)'),
      c('mask', 'mask-image', 'CSS.supports("mask-image","none")||CSS.supports("-webkit-mask-image","none")'),
      sup('filter', 'filter', 'filter', 'blur(1px)'),
      sup('blend', 'mix-blend-mode', 'mix-blend-mode', 'multiply'),
      sup('calc', 'calc()', 'width', 'calc(1px + 1px)'),
      sup('clamp', 'clamp()', 'width', 'clamp(1px, 2px, 3px)'),
      sup('inset', 'inset', 'inset', '0'),
      sup('logical', 'logical properties', 'margin-inline-start', '1px'),
      sup('colorMix', 'color-mix()', 'color', 'color-mix(in srgb, red, blue)'),
      sup('oklch', 'oklch()', 'color', 'oklch(50% 0.1 0)'),
      sup('env', 'env()', 'width', 'env(safe-area-inset-top)'),
      sup('textWrap', 'text-wrap: balance', 'text-wrap', 'balance'),
      sup('scrollTimeline', 'scroll-driven animation', 'animation-timeline', 'view()'),
      sup('touchAction', 'touch-action', 'touch-action', 'none'),
      c('registerProperty', '@property', 'typeof CSS!=="undefined"&&!!CSS.registerProperty'),
      c('typedOm', 'typed om', 'typeof CSS!=="undefined"&&!!CSS.px'),
      c('paintWorklet', 'paint worklet', 'typeof CSS!=="undefined"&&!!CSS.paintWorklet'),
      c('fontLoading', 'font loading api', '!!document.fonts'),
      def('fontFace', 'FontFace', 'FontFace'),
    ],
  },
  {
    id: 'js',
    label: 'javascript',
    checks: [
      syntax('letConst', 'let / const', 'let a=1;const b=2'),
      syntax('arrow', 'arrow functions', 'var f=()=>1'),
      syntax('classes', 'classes', 'class A{}'),
      syntax('classFields', 'class fields', 'class A{x=1;static y=2;#p=3}'),
      syntax('template', 'template literals', 'var s=`a${1}`'),
      syntax('destructuring', 'destructuring', 'var {a}={a:1};var [b]=[1]'),
      syntax('defaults', 'default parameters', 'function f(a=1){}'),
      syntax('spread', 'rest / spread', 'function f(...a){};var b=[...[]]'),
      syntax('forOf', 'for-of', 'for(var x of []){}'),
      syntax('generators', 'generators', 'function*g(){yield 1}'),
      syntax('async', 'async / await', 'async function f(){await 1}'),
      syntax('asyncIter', 'for await', 'async function f(){for await(var x of []){}}'),
      syntax('exponent', '**', 'var a=2**3'),
      syntax('optionalChaining', 'optional chaining', 'var a={};a?.b'),
      syntax('nullish', '??', 'var a=null;a??1'),
      syntax('logicalAssign', '||= &&= ??=', 'var a=0;a||=1;a&&=2;a??=3'),
      syntax('bigint', 'bigint', 'var a=1n'),
      syntax('separators', 'numeric separators', 'var a=1_000'),
      syntax('optionalCatch', 'optional catch binding', 'try{}catch{}'),
      syntax('lookbehind', 'regexp lookbehind', 'var r=/(?<=a)b/'),
      syntax('namedGroups', 'regexp named groups', 'var r=/(?<n>a)/'),
      def('symbol', 'Symbol', 'Symbol'),
      def('map', 'Map / Set', 'Map'),
      def('weakmap', 'WeakMap', 'WeakMap'),
      def('weakref', 'WeakRef', 'WeakRef'),
      def('finalization', 'FinalizationRegistry', 'FinalizationRegistry'),
      def('proxy', 'Proxy', 'Proxy'),
      def('reflect', 'Reflect', 'Reflect'),
      def('promise', 'Promise', 'Promise'),
      c('allSettled', 'Promise.allSettled', 'typeof Promise!=="undefined"&&!!Promise.allSettled'),
      c('promiseAny', 'Promise.any', 'typeof Promise!=="undefined"&&!!Promise.any'),
      def('structuredClone', 'structuredClone', 'structuredClone'),
      def('queueMicrotask', 'queueMicrotask', 'queueMicrotask'),
      def('globalThis', 'globalThis', 'globalThis'),
      def('intl', 'Intl', 'Intl'),
      c('intlRelative', 'Intl.RelativeTimeFormat', 'typeof Intl!=="undefined"&&!!Intl.RelativeTimeFormat'),
      c('intlPlural', 'Intl.PluralRules', 'typeof Intl!=="undefined"&&!!Intl.PluralRules'),
      c('intlList', 'Intl.ListFormat', 'typeof Intl!=="undefined"&&!!Intl.ListFormat'),
      c('intlSegmenter', 'Intl.Segmenter', 'typeof Intl!=="undefined"&&!!Intl.Segmenter'),
      c('includes', 'Array includes', '!!Array.prototype.includes'),
      c('flat', 'Array flat', '!!Array.prototype.flat'),
      c('at', 'Array at', '!!Array.prototype.at'),
      c('findLast', 'Array findLast', '!!Array.prototype.findLast'),
      c('fromAsync', 'Array.fromAsync', '!!Array.fromAsync'),
      c('entries', 'Object.entries', '!!Object.entries'),
      c('fromEntries', 'Object.fromEntries', '!!Object.fromEntries'),
      c('hasOwn', 'Object.hasOwn', '!!Object.hasOwn'),
      c('groupBy', 'Object.groupBy', '!!Object.groupBy'),
      c('padStart', 'String padStart', '!!String.prototype.padStart'),
      c('replaceAll', 'String replaceAll', '!!String.prototype.replaceAll'),
      c('errorCause', 'Error cause', 'new Error("a",{cause:1}).cause===1'),
      def('aggregateError', 'AggregateError', 'AggregateError'),
      def('textEncoder', 'TextEncoder', 'TextEncoder'),
      def('float64', 'typed arrays', 'Float64Array'),
      def('bigint64', 'BigInt64Array', 'BigInt64Array'),
      c('resizable', 'resizable ArrayBuffer', '"resize" in ArrayBuffer.prototype'),
      def('sab', 'SharedArrayBuffer', 'SharedArrayBuffer'),
      def('atomics', 'Atomics', 'Atomics'),
      def('wasm', 'WebAssembly', 'WebAssembly'),
    ],
  },
  {
    id: 'apis',
    label: 'web apis',
    checks: [
      c('fetch', 'fetch', 'typeof fetch==="function"'),
      def('abort', 'AbortController', 'AbortController'),
      def('readable', 'ReadableStream', 'ReadableStream'),
      def('writable', 'WritableStream', 'WritableStream'),
      def('transform', 'TransformStream', 'TransformStream'),
      def('compression', 'CompressionStream', 'CompressionStream'),
      def('decoderStream', 'TextDecoderStream', 'TextDecoderStream'),
      def('xhr', 'XMLHttpRequest', 'XMLHttpRequest'),
      def('worker', 'Worker', 'Worker'),
      def('sharedWorker', 'SharedWorker', 'SharedWorker'),
      c('serviceWorker', 'service worker', '!!navigator.serviceWorker'),
      c('indexedDB', 'indexedDB', '!!window.indexedDB'),
      c('idbDatabases', 'indexedDB.databases()', '!!(window.indexedDB&&indexedDB.databases)'),
      c('caches', 'cache storage', '!!window.caches'),
      c('localStorage', 'localStorage', '!!window.localStorage'),
      c('sessionStorage', 'sessionStorage', '!!window.sessionStorage'),
      c('cookieStore', 'cookieStore', '!!window.cookieStore'),
      c('storageEstimate', 'storage.estimate()', '!!(navigator.storage&&navigator.storage.estimate)'),
      c('storagePersist', 'storage.persist()', '!!(navigator.storage&&navigator.storage.persist)'),
      c('opfs', 'origin private fs', '!!(navigator.storage&&navigator.storage.getDirectory)'),
      c('filePicker', 'file system access', '!!window.showOpenFilePicker'),
      def('intersection', 'IntersectionObserver', 'IntersectionObserver'),
      def('resize', 'ResizeObserver', 'ResizeObserver'),
      def('mutation', 'MutationObserver', 'MutationObserver'),
      def('reporting', 'ReportingObserver', 'ReportingObserver'),
      def('idle', 'requestIdleCallback', 'requestIdleCallback'),
      def('raf', 'requestAnimationFrame', 'requestAnimationFrame'),
      c('postTask', 'scheduler.postTask', '!!(window.scheduler&&scheduler.postTask)'),
      c('isInputPending', 'isInputPending', '!!(navigator.scheduling&&navigator.scheduling.isInputPending)'),
      c('webAudio', 'web audio', '!!(window.AudioContext||window.webkitAudioContext)'),
      def('audioWorklet', 'AudioWorklet', 'AudioWorkletNode'),
      c('speechSynthesis', 'speech synthesis', '!!window.speechSynthesis'),
      c('speechRecognition', 'speech recognition', '!!(window.SpeechRecognition||window.webkitSpeechRecognition)'),
      c('clipboard', 'clipboard', '!!(navigator.clipboard&&navigator.clipboard.writeText)'),
      def('notifications', 'Notification', 'Notification'),
      c('push', 'push', '!!window.PushManager'),
      c('wakeLock', 'wake lock', '!!(navigator.wakeLock&&navigator.wakeLock.request)'),
      c('geolocation', 'geolocation', '!!navigator.geolocation'),
      c('userMedia', 'getUserMedia', '!!(navigator.mediaDevices&&navigator.mediaDevices.getUserMedia)'),
      c('bluetooth', 'bluetooth', '!!navigator.bluetooth'),
      c('usb', 'usb', '!!navigator.usb'),
      c('hid', 'hid', '!!navigator.hid'),
      c('serial', 'serial', '!!navigator.serial'),
      def('nfc', 'nfc', 'NDEFReader'),
      c('xr', 'webxr', '!!navigator.xr'),
      c('permissions', 'permissions', '!!(navigator.permissions&&navigator.permissions.query)'),
      c('credentials', 'credentials', '!!navigator.credentials'),
      def('payment', 'PaymentRequest', 'PaymentRequest'),
      c('share', 'web share', '!!navigator.share'),
      c('locks', 'web locks', '!!navigator.locks'),
      def('broadcast', 'BroadcastChannel', 'BroadcastChannel'),
      def('messageChannel', 'MessageChannel', 'MessageChannel'),
      c('pushState', 'history.pushState', '!!(window.history&&history.pushState)'),
      c('navigation', 'navigation api', '!!window.navigation'),
      c('customElements', 'custom elements', '!!window.customElements'),
      c('shadow', 'shadow dom', '!!Element.prototype.attachShadow'),
      def('templateEl', '<template>', 'HTMLTemplateElement'),
      def('dialog', '<dialog>', 'HTMLDialogElement'),
      inProto('popover', 'popover', 'HTMLElement', 'popover'),
      inProto('inert', 'inert', 'HTMLElement', 'inert'),
      c('animate', 'web animations', '!!Element.prototype.animate'),
      c('getAnimations', 'document.getAnimations', '!!document.getAnimations'),
      c('trustedTypes', 'trusted types', '!!window.trustedTypes'),
      c('subtle', 'crypto.subtle', '!!(window.crypto&&crypto.subtle)'),
      c('randomUUID', 'crypto.randomUUID', '!!(window.crypto&&crypto.randomUUID)'),
      c('url', 'URL', 'typeof URL==="function"'),
      def('urlParams', 'URLSearchParams', 'URLSearchParams'),
      def('idleDetector', 'idle detection', 'IdleDetector'),
      c('presentation', 'presentation api', '!!navigator.presentation'),
      c('xpath', 'xpath', '!!document.evaluate'),
    ],
  },
  {
    id: 'perf',
    label: 'performance apis',
    checks: [
      c('now', 'performance.now', '!!(P&&P.now)'),
      c('mark', 'mark / measure', '!!(P&&P.mark)'),
      c('markDetail', 'mark with detail', '(function(){try{P.mark("__tlpt",{detail:1});P.clearMarks("__tlpt");return true}catch(e){return false}})()', 'performance.mark(name, { detail })'),
      c('timeOrigin', 'timeOrigin', '!!(P&&P.timeOrigin)'),
      c('navTiming2', 'navigation timing 2', `!!${NAV_ENTRY}`),
      c('resourceTiming', 'resource timing', '!!(P&&P.getEntriesByType)'),
      c('serverTiming', 'server timing', `${NAV_ENTRY}?"serverTiming" in ${NAV_ENTRY}:null`),
      def('observer', 'PerformanceObserver', 'PerformanceObserver'),
      c('entryTypes', 'supported entry types', 'ET()?ET().join(", "):null', 'PerformanceObserver.supportedEntryTypes'),
      ...PERF_ENTRY_TYPES.map((t) => entry(`entry:${t}`, t, t)),
      c('memory', 'performance.memory', '!!(P&&P.memory)'),
      c('uaMemory', 'measureUserAgentSpecificMemory', '!!(P&&P.measureUserAgentSpecificMemory)'),
      c('eventCounts', 'eventCounts', '!!(P&&P.eventCounts)'),
      c('interactionCount', 'interactionCount', '!!(P&&"interactionCount" in P)'),
      c('timeline', 'document.timeline', '!!document.timeline'),
    ],
  },
];

const MEDIA: GroupDef[] = [
  {
    id: 'mse',
    label: 'media source · isTypeSupported',
    checks: [
      c('mse', 'media source extensions', '!!MS()', 'window.MediaSource || WebKitMediaSource'),
      def('managed', 'ManagedMediaSource', 'ManagedMediaSource'),
      c('mseWorker', 'mse in worker', 'MS()?!!MS().canConstructInDedicatedWorker:null', 'MediaSource.canConstructInDedicatedWorker'),
      inProto('changeType', 'SourceBuffer.changeType', 'SourceBuffer', 'changeType'),
      mse('h264Baseline', 'h.264 baseline', 'video/mp4; codecs="avc1.42E01E"'),
      mse('h264Main', 'h.264 main', 'video/mp4; codecs="avc1.4D401E"'),
      mse('h264High', 'h.264 high', 'video/mp4; codecs="avc1.64001F"'),
      mse('h264High51', 'h.264 high 5.1 (4k)', 'video/mp4; codecs="avc1.640033"'),
      mse('hevcMain', 'hevc main', 'video/mp4; codecs="hev1.1.6.L93.B0"'),
      mse('hevcHvc1', 'hevc main (hvc1)', 'video/mp4; codecs="hvc1.1.6.L93.B0"'),
      mse('hevcMain10', 'hevc main 10', 'video/mp4; codecs="hev1.2.4.L153.B0"'),
      mse('dolbyVision', 'dolby vision p5', 'video/mp4; codecs="dvh1.05.06"'),
      mse('vp8', 'vp8', 'video/webm; codecs="vp8"'),
      mse('vp9', 'vp9', 'video/webm; codecs="vp9"'),
      mse('vp9p0', 'vp9 profile 0', 'video/webm; codecs="vp09.00.10.08"'),
      mse('vp9p2', 'vp9 profile 2 10-bit', 'video/webm; codecs="vp09.02.10.10"'),
      mse('av1', 'av1 (mp4)', 'video/mp4; codecs="av01.0.08M.08"'),
      mse('av1webm', 'av1 (webm)', 'video/webm; codecs="av01.0.08M.08"'),
      mse('mp2t', 'mpeg-ts h.264', 'video/mp2t; codecs="avc1.42E01E"'),
      mse('aac', 'aac-lc', 'audio/mp4; codecs="mp4a.40.2"'),
      mse('heaac', 'he-aac', 'audio/mp4; codecs="mp4a.40.5"'),
      mse('eac3', 'e-ac-3 (dolby digital plus)', 'audio/mp4; codecs="ec-3"'),
      mse('ac3', 'ac-3 (dolby digital)', 'audio/mp4; codecs="ac-3"'),
      mse('opusWebm', 'opus (webm)', 'audio/webm; codecs="opus"'),
      mse('opusMp4', 'opus (mp4)', 'audio/mp4; codecs="opus"'),
      mse('mp3', 'mp3', 'audio/mpeg'),
      mse('flac', 'flac', 'audio/mp4; codecs="flac"'),
    ],
  },
  {
    id: 'canplay',
    label: 'video element · canPlayType',
    checks: [
      play('cpH264', 'mp4 h.264', 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"'),
      play('cpHevc', 'mp4 hevc', 'video/mp4; codecs="hev1.1.6.L93.B0"'),
      play('cpVp9', 'webm vp9', 'video/webm; codecs="vp9, opus"'),
      play('cpAv1', 'mp4 av1', 'video/mp4; codecs="av01.0.08M.08"'),
      play('cpHls', 'hls (native)', 'application/vnd.apple.mpegurl'),
      play('cpDash', 'dash (native)', 'application/dash+xml'),
      play('cpMkv', 'matroska', 'video/x-matroska; codecs="avc1.42E01E"'),
      play('cpTs', 'mpeg-ts', 'video/mp2t'),
      play('cpMp3', 'mp3', 'audio/mpeg'),
      play('cpAac', 'aac', 'audio/aac'),
      play('cpOgg', 'ogg vorbis', 'audio/ogg; codecs="vorbis"'),
      play('cpWav', 'wav', 'audio/wav'),
    ],
  },
  {
    id: 'eme',
    label: 'encrypted media',
    checks: [
      c('emeSecure', 'secure context', 'window.isSecureContext'),
      c('eme', 'eme (requestMediaKeySystemAccess)', '!!navigator.requestMediaKeySystemAccess'),
      keySystem('widevine', 'widevine', 'com.widevine.alpha', WIDEVINE_LEVELS),
      {
        k: 'widevinePersistent',
        label: 'widevine persistent license',
        code: 'if(!navigator.requestMediaKeySystemAccess)return null;var cfg=KS("");cfg[0].persistentState="required";cfg[0].sessionTypes=["persistent-license"];return navigator.requestMediaKeySystemAccess("com.widevine.alpha",cfg).then(function(){return true},function(){return false})',
        what: 'com.widevine.alpha with persistentState: required, sessionTypes: persistent-license',
      },
      keySystem('playreadyRec', 'playready (recommendation)', 'com.microsoft.playready.recommendation', PLAYREADY_LEVELS),
      keySystem('playready', 'playready', 'com.microsoft.playready', PLAYREADY_LEVELS),
      keySystem('clearkey', 'clearkey', 'org.w3.clearkey'),
      keySystem('fairplay', 'fairplay', 'com.apple.fps.1_0'),
      inProto('hdcpPolicy', 'hdcp policy check', 'MediaKeys', 'getStatusForPolicy'),
      def('webkitKeys', 'legacy WebKitMediaKeys', 'WebKitMediaKeys'),
      inProto('webkitKeyRequest', 'legacy webkitGenerateKeyRequest', 'HTMLMediaElement', 'webkitGenerateKeyRequest'),
      def('msKeys', 'legacy MSMediaKeys', 'MSMediaKeys'),
    ],
  },
  {
    id: 'video',
    label: 'video apis',
    checks: [
      inProto('playbackQuality', 'getVideoPlaybackQuality', 'HTMLVideoElement', 'getVideoPlaybackQuality'),
      inProto('webkitDropped', 'webkitDroppedFrameCount', 'HTMLVideoElement', 'webkitDroppedFrameCount'),
      inProto('rvfc', 'requestVideoFrameCallback', 'HTMLVideoElement', 'requestVideoFrameCallback'),
      c('pip', 'picture-in-picture', '!!document.pictureInPictureEnabled'),
      c('docPip', 'document picture-in-picture', '!!window.documentPictureInPicture'),
      c('mediaCapabilities', 'media capabilities', '!!(navigator.mediaCapabilities&&navigator.mediaCapabilities.decodingInfo)'),
      def('videoDecoder', 'webcodecs VideoDecoder', 'VideoDecoder'),
      def('audioDecoder', 'webcodecs AudioDecoder', 'AudioDecoder'),
      inProto('captureStream', 'captureStream', 'HTMLMediaElement', 'captureStream'),
      inProto('sinkId', 'setSinkId', 'HTMLMediaElement', 'setSinkId'),
      inProto('srcObject', 'srcObject', 'HTMLMediaElement', 'srcObject'),
      inProto('preservesPitch', 'preservesPitch', 'HTMLMediaElement', 'preservesPitch'),
      inProto('audioTracks', 'audioTracks', 'HTMLMediaElement', 'audioTracks'),
      inProto('remote', 'remote playback', 'HTMLMediaElement', 'remote'),
      c('mediaSession', 'media session', '!!navigator.mediaSession'),
      def('textTrack', 'TextTrack', 'TextTrack'),
      def('vttCue', 'VTTCue', 'VTTCue'),
      c('autoplay', 'autoplay policy', 'navigator.getAutoplayPolicy?navigator.getAutoplayPolicy("mediaelement"):null', 'navigator.getAutoplayPolicy("mediaelement")'),
    ],
  },
];

const GRAPHICS: GroupDef[] = [
  {
    id: 'webgl',
    label: 'webgl',
    checks: [
      c('webgl', 'webgl', '!!GL()', 'canvas.getContext("webgl") || "experimental-webgl"'),
      gl('glVersion', 'version', 'GL().getParameter(GL().VERSION)'),
      gl('glsl', 'glsl', 'GL().getParameter(GL().SHADING_LANGUAGE_VERSION)'),
      gl('glVendor', 'vendor', 'GL().getParameter(GL().VENDOR)'),
      gl('glRenderer', 'renderer', 'GL().getParameter(GL().RENDERER)'),
      gl('gpuVendor', 'gpu vendor', 'DBG()?GL().getParameter(DBG().UNMASKED_VENDOR_WEBGL):null', 'WEBGL_debug_renderer_info UNMASKED_VENDOR_WEBGL'),
      gl('gpuRenderer', 'gpu renderer', 'DBG()?GL().getParameter(DBG().UNMASKED_RENDERER_WEBGL):null', 'WEBGL_debug_renderer_info UNMASKED_RENDERER_WEBGL'),
      gl('maxTexture', 'max texture px', 'GL().getParameter(GL().MAX_TEXTURE_SIZE)'),
      gl('maxRenderbuffer', 'max renderbuffer px', 'GL().getParameter(GL().MAX_RENDERBUFFER_SIZE)'),
      gl('maxViewport', 'max viewport', 'GL().getParameter(GL().MAX_VIEWPORT_DIMS)[0]+"×"+GL().getParameter(GL().MAX_VIEWPORT_DIMS)[1]', 'gl.MAX_VIEWPORT_DIMS'),
      gl('maxTextureUnits', 'texture units', 'GL().getParameter(GL().MAX_COMBINED_TEXTURE_IMAGE_UNITS)'),
      gl('maxVertexAttribs', 'vertex attribs', 'GL().getParameter(GL().MAX_VERTEX_ATTRIBS)'),
      gl('maxVarying', 'varying vectors', 'GL().getParameter(GL().MAX_VARYING_VECTORS)'),
      gl('antialias', 'antialias', '!!(GL().getContextAttributes()&&GL().getContextAttributes().antialias)'),
      gl('extensions', 'extensions', 'GL().getSupportedExtensions().length'),
      ext('anisotropic', 'anisotropic filtering', 'EXT_texture_filter_anisotropic'),
      ext('floatTex', 'float textures', 'OES_texture_float'),
      ext('halfFloatTex', 'half-float textures', 'OES_texture_half_float'),
      ext('s3tc', 's3tc (dxt)', 'WEBGL_compressed_texture_s3tc'),
      ext('etc1', 'etc1', 'WEBGL_compressed_texture_etc1'),
      ext('etc', 'etc2 / eac', 'WEBGL_compressed_texture_etc'),
      ext('astc', 'astc', 'WEBGL_compressed_texture_astc'),
      ext('pvrtc', 'pvrtc', 'WEBGL_compressed_texture_pvrtc'),
      ext('instanced', 'instanced arrays', 'ANGLE_instanced_arrays'),
      ext('vao', 'vertex array objects', 'OES_vertex_array_object'),
      ext('depthTex', 'depth textures', 'WEBGL_depth_texture'),
      ext('drawBuffers', 'draw buffers', 'WEBGL_draw_buffers'),
    ],
  },
  {
    id: 'webgl2',
    label: 'webgl 2',
    checks: [
      c('webgl2', 'webgl 2', '!!GL2()', 'canvas.getContext("webgl2")'),
      gl2('gl2Version', 'version', 'GL2().getParameter(GL2().VERSION)'),
      gl2('gl2MaxTexture', 'max texture px', 'GL2().getParameter(GL2().MAX_TEXTURE_SIZE)'),
      gl2('gl2Max3d', 'max 3d texture px', 'GL2().getParameter(GL2().MAX_3D_TEXTURE_SIZE)'),
      gl2('gl2ColorAttachments', 'color attachments', 'GL2().getParameter(GL2().MAX_COLOR_ATTACHMENTS)'),
      gl2('gl2Samples', 'max samples', 'GL2().getParameter(GL2().MAX_SAMPLES)'),
      gl2('gl2Extensions', 'extensions', 'GL2().getSupportedExtensions().length'),
      gl2('gl2FloatBuffer', 'float color buffers', '!!GL2().getExtension("EXT_color_buffer_float")'),
    ],
  },
  {
    id: 'gpu',
    label: 'gpu · canvas',
    checks: [
      c('webgpu', 'webgpu', '!!navigator.gpu'),
      {
        k: 'gpuAdapter',
        label: 'webgpu adapter',
        code: 'if(!navigator.gpu)return null;return navigator.gpu.requestAdapter().then(function(a){return a?(a.info&&(a.info.vendor||a.info.architecture)?[a.info.vendor,a.info.architecture].join(" "):"yes"):false},function(){return false})',
        what: 'navigator.gpu.requestAdapter()',
      },
      c('canvas2d', 'canvas 2d', '!!document.createElement("canvas").getContext("2d")'),
      def('offscreen', 'OffscreenCanvas', 'OffscreenCanvas'),
      def('imageBitmap', 'createImageBitmap', 'createImageBitmap'),
      def('imageDecoder', 'ImageDecoder', 'ImageDecoder'),
      def('path2d', 'Path2D', 'Path2D'),
      inProto('roundRect', 'roundRect', 'CanvasRenderingContext2D', 'roundRect'),
      inProto('canvasFilter', 'canvas filter', 'CanvasRenderingContext2D', 'filter'),
      inProto('letterSpacing', 'canvas letterSpacing', 'CanvasRenderingContext2D', 'letterSpacing'),
      inProto('toBlob', 'canvas.toBlob', 'HTMLCanvasElement', 'toBlob'),
      inProto('transferControl', 'transferControlToOffscreen', 'HTMLCanvasElement', 'transferControlToOffscreen'),
      def('bitmapRenderer', 'ImageBitmapRenderingContext', 'ImageBitmapRenderingContext'),
    ],
  },
  {
    id: 'images',
    label: 'images',
    checks: [
      image('webp', 'webp', WEBP_1PX),
      image('avif', 'avif', AVIF_1PX),
      c('svg', 'svg', '!!(document.createElementNS&&document.createElementNS("http://www.w3.org/2000/svg","svg").createSVGRect)'),
      inProto('imgDecode', 'img.decode()', 'HTMLImageElement', 'decode'),
      inProto('lazy', 'loading="lazy"', 'HTMLImageElement', 'loading'),
      inProto('srcset', 'srcset', 'HTMLImageElement', 'srcset'),
      inProto('sizes', 'sizes', 'HTMLImageElement', 'sizes'),
      inProto('decoding', 'decoding', 'HTMLImageElement', 'decoding'),
      inProto('fetchPriority', 'fetchpriority', 'HTMLImageElement', 'fetchPriority'),
      def('picture', '<picture>', 'HTMLPictureElement'),
    ],
  },
  {
    id: 'frames',
    label: 'frames',
    checks: [
      {
        k: 'rafHz',
        label: 'raf rate hz',
        code: 'if(!window.requestAnimationFrame)return null;return new Promise(function(res){var ts=[],n=0;function f(t){ts.push(t);if(++n<14)requestAnimationFrame(f);else{var ds=[];for(var i=2;i<ts.length;i++)ds.push(ts[i]-ts[i-1]);ds.sort(function(a,b){return a-b});var m=ds[Math.floor(ds.length/2)];res(m>0?Math.round(1000/m):null)}}requestAnimationFrame(f)})',
        what: 'median of 11 requestAnimationFrame deltas · a hint, not the panel refresh rate',
      },
    ],
  },
];

/** Shared by every check of a probe: lazily made objects that would be costly to make per check. */
const PRELUDE: Record<string, string> = {
  media:
    'function MS(){return window.MediaSource||window.WebKitMediaSource||null}var vid=null;function V(){return vid||(vid=document.createElement("video"))}' +
    'function KS(r){return [{initDataTypes:["cenc"],videoCapabilities:[{contentType:"video/mp4; codecs=\\"avc1.42E01E\\"",robustness:r}],audioCapabilities:[{contentType:"audio/mp4; codecs=\\"mp4a.40.2\\"",robustness:r}]}]}',
  graphics:
    'var gl1,gl1Tried=false,gl2,gl2Tried=false,dbg,dbgTried=false;' +
    'function GL(){if(!gl1Tried){gl1Tried=true;try{var cv=document.createElement("canvas");gl1=cv.getContext("webgl")||cv.getContext("experimental-webgl")||null}catch(e){gl1=null}}return gl1}' +
    'function GL2(){if(!gl2Tried){gl2Tried=true;try{gl2=document.createElement("canvas").getContext("webgl2")||null}catch(e){gl2=null}}return gl2}' +
    'function DBG(){if(!dbgTried){dbgTried=true;dbg=GL()?GL().getExtension("WEBGL_debug_renderer_info"):null}return dbg}',
  features: 'function ET(){return typeof PerformanceObserver!=="undefined"&&PerformanceObserver.supportedEntryTypes?PerformanceObserver.supportedEntryTypes:null}',
};

/** Frees what the checks made, before the answer goes back. */
const EPILOGUE: Record<string, string> = {
  graphics: 'function lose(g){var e=g&&g.getExtension("WEBGL_lose_context");if(e)e.loseContext()}lose(GL());lose(GL2());',
};

const TIMER = 'var P=window.performance,now=function(){return P&&P.now?P.now():Date.now()},t0=now();';

/**
 * The whole probe: every check in its own guarded call, so one throwing never costs the rest, and
 * a thenable settles later. Answers with the object at once when nothing is pending, else with a
 * Promise that resolves to what it has after SETTLE_MS at the latest.
 */
function capabilityScript(groups: GroupDef[], prelude = '', epilogue = ''): string {
  const body = groups.flatMap((g) => g.checks).map((ch) => `g(${q(ch.k)},function(){${ch.code}});`).join('');
  return (
    `(function(){${TIMER}var o={},pend=[];${prelude}` +
    'function norm(v){var t=typeof v;return t==="boolean"||t==="number"||t==="string"?v:null}' +
    'function g(k,f){var v;try{v=f()}catch(e){o[k]=null;return}if(v&&typeof v.then==="function"){if(typeof Promise!=="function"){o[k]=null;return}pend.push(v.then(function(x){o[k]=norm(x)},function(){o[k]=null}))}else{o[k]=norm(v)}}' +
    body +
    epilogue +
    'o.__ms=now()-t0;if(!pend.length)return o;' +
    `var late=new Promise(function(r){setTimeout(r,${SETTLE_MS})});return Promise.race([Promise.all(pend),late]).then(function(){o.__wall=now()-t0;return o});})()`
  );
}

const rec = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown, max = MAX_STR): string | null => (typeof v === 'string' ? v.slice(0, max) : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const list = (v: unknown): unknown[] | null => (Array.isArray(v) ? v : null);
const reading = (v: unknown): Reading => (typeof v === 'boolean' ? v : num(v) ?? str(v));

function parseCapabilities(groups: GroupDef[]) {
  return (raw: unknown): Capabilities => {
    const o = rec(raw) ?? {};
    return {
      groups: groups.map((g) => ({ id: g.id, label: g.label, items: g.checks.map((ch) => ({ k: ch.k, label: ch.label, v: reading(o[ch.k]), what: ch.what ?? ch.code.replace(/^return /, '') })) })),
      ms: num(o.__ms),
      wallMs: num(o.__wall),
    };
  };
}

/**
 * The media probe's answer, with what its DRM readings can't say for themselves. An engine that
 * knows the page is not a secure context and has no way to ask for a key system: since Chromium 58
 * the first is the reason for the second, and "no DRM on this device" would be the wrong thing to
 * read from it.
 */
function parseMedia(raw: unknown): Capabilities {
  const c = parseCapabilities(MEDIA)(raw);
  const v = (k: string) => c.groups.flatMap((g) => g.items).find((i) => i.k === k)?.v;
  if (v('emeSecure') !== false || v('eme') !== false) return c;
  return { ...c, notes: [`This page is not a secure context (plain http from another machine), and this engine offers DRM only to one: the key systems read as unknown, not as missing. ${OPEN_SECURELY}`] };
}

// ---- Storage ---------------------------------------------------------------------------------------

const STORAGE_SCRIPT =
  `(function(){${TIMER}var o={},pend=[],CAP=${MAX_ENTRIES},PREV=${PREVIEW},LIST=${MAX_LIST},FULL=${FULL_MAX},budget=${FULL_BUDGET};` +
  'function cut(s){return s.length>PREV?s.slice(0,PREV)+"…":s}' +
  'function whole(v){if(v.length>FULL||v.length>budget)return null;budget-=v.length;return v}' +
  'function area(s){var n=s.length,es=[],bytes=0;for(var i=0;i<n;i++){var k=s.key(i),v=s.getItem(k)||"",b=(k.length+v.length)*2;bytes+=b;if(i<CAP)es.push({key:k,preview:cut(v),bytes:b,full:whole(v)})}return {count:n,bytes:bytes,entries:es,capped:n>CAP}}' +
  'try{o.local=window.localStorage?area(localStorage):null}catch(e){o.local=null}' +
  'try{o.session=window.sessionStorage?area(sessionStorage):null}catch(e){o.session=null}' +
  'try{var cs=document.cookie?document.cookie.split("; "):[],ce=[],cb=0;for(var i=0;i<cs.length;i++){var eq=cs[i].indexOf("=");cb+=cs[i].length;if(i<CAP)ce.push({name:eq<0?cs[i]:cs[i].slice(0,eq),preview:cut(eq<0?"":cs[i].slice(eq+1)),bytes:cs[i].length})}o.cookies={count:cs.length,bytes:cb,entries:ce}}catch(e){o.cookies=null}' +
  'var hasP=typeof Promise==="function";' +
  'var idb=window.indexedDB;' +
  'if(!idb)o.indexedDB=null;else if(typeof idb.databases!=="function"||!hasP)o.indexedDB={databases:null,capped:false};else pend.push(idb.databases().then(function(all){' +
  'return Promise.all(all.slice(0,LIST).map(function(info){return new Promise(function(res){var bare={name:info.name,version:info.version||null,stores:null};var req;try{req=idb.open(info.name)}catch(e){return res(bare)}' +
  'req.onerror=function(){res(bare)};req.onblocked=function(){res(bare)};req.onupgradeneeded=function(){try{req.transaction.abort()}catch(e){}res(bare)};' +
  'req.onsuccess=function(){var db=req.result,names=[],i;for(i=0;i<db.objectStoreNames.length;i++)names.push(db.objectStoreNames[i]);var stores=[];for(i=0;i<names.length&&i<LIST;i++)stores.push({name:names[i],count:null});var out={name:db.name,version:db.version,stores:stores};if(!stores.length){db.close();return res(out)}' +
  'var left=stores.length;function one(st){var cr=tx.objectStore(st.name).count();cr.onsuccess=function(){st.count=cr.result;if(--left===0){db.close();res(out)}};cr.onerror=function(){if(--left===0){db.close();res(out)}}}' +
  'try{var tx=db.transaction(names.slice(0,LIST),"readonly");for(i=0;i<stores.length;i++)one(stores[i])}catch(e){db.close();res(out)}}})}))' +
  '.then(function(dbs){o.indexedDB={databases:dbs,capped:all.length>LIST}})},function(){o.indexedDB={databases:null,capped:false}}));' +
  'if(!window.caches||!hasP)o.caches=null;else pend.push(caches.keys().then(function(names){return Promise.all(names.slice(0,LIST).map(function(n){return caches.open(n).then(function(c){return c.keys()}).then(function(ks){return {name:n,entries:ks.length}},function(){return {name:n,entries:null}})}))}).then(function(l){o.caches=l},function(){o.caches=null}));' +
  'var sw=navigator.serviceWorker;if(!sw||!sw.getRegistrations||!hasP)o.workers=null;else pend.push(sw.getRegistrations().then(function(rs){o.workers=rs.slice(0,LIST).map(function(r){var w=r.active||r.waiting||r.installing;return {scope:r.scope,state:w?w.state:"none",scriptURL:w?w.scriptURL:""}})},function(){o.workers=null}));' +
  'var st=navigator.storage;if(st&&st.estimate&&hasP){pend.push(st.estimate().then(function(e){o.quota={usageBytes:e.usage,quotaBytes:e.quota,persisted:null};return st.persisted?st.persisted().then(function(p){o.quota.persisted=p},function(){}):null},function(){o.quota=null}))}' +
  'else if(navigator.webkitTemporaryStorage&&hasP){pend.push(new Promise(function(res){navigator.webkitTemporaryStorage.queryUsageAndQuota(function(u,qa){o.quota={usageBytes:u,quotaBytes:qa,persisted:null};res()},function(){o.quota=null;res()})}))}else o.quota=null;' +
  'o.__ms=now()-t0;if(!pend.length)return o;' +
  `var late=new Promise(function(r){setTimeout(r,${SETTLE_MS})});return Promise.race([Promise.all(pend),late]).then(function(){o.__wall=now()-t0;return o});})()`;

function parseArea(v: unknown): StorageArea | null {
  const a = rec(v);
  if (!a) return null;
  const entries = (list(a.entries) ?? []).flatMap((e) => {
    const r = rec(e);
    const key = r && str(r.key, 1000);
    return r && key !== null ? [{ key, preview: str(r.preview, PREVIEW + 1) ?? '', bytes: num(r.bytes) ?? 0, full: str(r.full, FULL_MAX) }] : [];
  });
  return { count: num(a.count) ?? entries.length, bytes: num(a.bytes) ?? 0, entries, capped: a.capped === true };
}

function parseStorage(raw: unknown): StorageReport {
  const o = rec(raw) ?? {};
  const cookies = rec(o.cookies);
  const idb = rec(o.indexedDB);
  const quota = rec(o.quota);
  return {
    local: parseArea(o.local),
    session: parseArea(o.session),
    cookies: cookies
      ? {
          count: num(cookies.count) ?? 0,
          bytes: num(cookies.bytes) ?? 0,
          entries: (list(cookies.entries) ?? []).flatMap((e) => {
            const r = rec(e);
            const name = r && str(r.name, 1000);
            return r && name !== null ? [{ name, preview: str(r.preview, PREVIEW + 1) ?? '', bytes: num(r.bytes) ?? 0 }] : [];
          }),
        }
      : null,
    indexedDB: idb
      ? {
          databases: list(idb.databases)?.flatMap((d) => {
            const r = rec(d);
            const name = r && str(r.name, 1000);
            if (!r || name === null) return [];
            const stores = list(r.stores)?.flatMap((s) => {
              const x = rec(s);
              const n = x && str(x.name, 1000);
              return x && n !== null ? [{ name: n, count: num(x.count) }] : [];
            });
            return [{ name, version: num(r.version), stores: stores ?? null }];
          }) ?? null,
          capped: idb.capped === true,
        }
      : null,
    caches:
      list(o.caches)?.flatMap((x) => {
        const r = rec(x);
        const name = r && str(r.name, 1000);
        return r && name !== null ? [{ name, entries: num(r.entries) }] : [];
      }) ?? null,
    workers:
      list(o.workers)?.flatMap((x) => {
        const r = rec(x);
        const scope = r && str(r.scope, 1000);
        return r && scope !== null ? [{ scope, state: str(r.state) ?? 'unknown', scriptURL: str(r.scriptURL, 1000) ?? '' }] : [];
      }) ?? null,
    quota: quota ? { usageBytes: num(quota.usageBytes), quotaBytes: num(quota.quotaBytes), persisted: bool(quota.persisted) } : null,
    ms: num(o.__ms),
    wallMs: num(o.__wall),
  };
}

// ---- DOM -------------------------------------------------------------------------------------------

/** How the agent names an element: tag, #id, and up to two classes. */
const NAME_FN =
  'function name(el){var s=el.tagName.toLowerCase();if(el.id)s+="#"+el.id;var cl=el.getAttribute&&el.getAttribute("class");if(cl){var cs=String(cl).split(/\\s+/).filter(Boolean).slice(0,2);if(cs.length)s+="."+cs.join(".")}return s}';

const DOM_SCRIPT =
  `(function(){${TIMER}${NAME_FN}var TAGS=${JSON.stringify(DOM_TAGS)},counts={},i;for(i=0;i<TAGS.length;i++)counts[TAGS[i]]=0;` +
  'var elements=0,texts=0,depth=0,deepest=null,largest=null,largestN=-1,widest=null,widestN=-1,body=document.body;' +
  'function walk(el,d){elements++;if(d>depth){depth=d;deepest=el}var tag=el.tagName.toLowerCase();if(counts.hasOwnProperty(tag))counts[tag]++;var kids=el.childNodes,n=0,ek=0;for(var j=0;j<kids.length;j++){var k=kids[j];if(k.nodeType===1){ek++;n+=1+walk(k,d+1)}else if(k.nodeType===3)texts++}' +
  'if(ek>widestN){widestN=ek;widest=el}if(el!==body&&el!==document.documentElement&&n>largestN){largestN=n;largest=el}return n}' +
  'walk(document.documentElement,0);' +
  'var sheets=document.styleSheets,rules=null;for(i=0;i<sheets.length;i++){try{var rs=sheets[i].cssRules;if(rs)rules=(rules||0)+rs.length}catch(e){}}' +
  'return {elements:elements,textNodes:texts,depth:depth,deepest:deepest?name(deepest):"",largest:largest?{path:name(largest),descendants:largestN}:null,widest:widest?{path:name(widest),children:widestN}:null,counts:counts,stylesheets:sheets.length,rules:rules,__ms:now()-t0}})()';

function parseDom(raw: unknown): DomReport {
  const o = rec(raw) ?? {};
  const counts = rec(o.counts) ?? {};
  const largest = rec(o.largest);
  const widest = rec(o.widest);
  return {
    elements: num(o.elements) ?? 0,
    textNodes: num(o.textNodes) ?? 0,
    depth: num(o.depth) ?? 0,
    deepest: str(o.deepest) ?? '',
    largest: largest && str(largest.path) !== null ? { path: str(largest.path)!, descendants: num(largest.descendants) ?? 0 } : null,
    widest: widest && str(widest.path) !== null ? { path: str(widest.path)!, children: num(widest.children) ?? 0 } : null,
    counts: Object.fromEntries(DOM_TAGS.map((t) => [t, num(counts[t]) ?? 0])) as Record<DomTag, number>,
    stylesheets: num(o.stylesheets) ?? 0,
    rules: num(o.rules),
    ms: num(o.__ms),
  };
}

// ---- Focus -----------------------------------------------------------------------------------------

/** The agent's default focus selector (packages/agent/src/samplers.js); the script tag's data-focus overrides it there and here. */
export const FOCUS_SELECTOR = '.focused,.focus,.is-focused,.selected,[data-focused="true"]';
export const FOCUSABLE_SELECTOR = 'a[href],button,input,select,textarea,[tabindex]';

const FOCUS_SCRIPT =
  `(function(){${TIMER}${NAME_FN}var tag=document.querySelector("script[data-focus]"),sel=tag?tag.getAttribute("data-focus"):${q(FOCUS_SELECTOR)};` +
  'var marked=null;try{marked=sel?document.querySelector(sel):null}catch(e){}' +
  'var a=document.activeElement;if(a===document.body||a===document.documentElement)a=null;' +
  'var el=marked&&(!a||a.contains(marked))?marked:a,box=null;if(el&&el.getBoundingClientRect){var r=el.getBoundingClientRect();box=[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)]}' +
  'var ti=el&&el.hasAttribute("tabindex")?parseInt(el.getAttribute("tabindex"),10):null;' +
  `return {active:a?name(a):null,marked:marked?name(marked):null,selector:sel||"",tabindex:ti,box:box,focusable:document.querySelectorAll(${q(FOCUSABLE_SELECTOR)}).length,__ms:now()-t0}})()`;

function parseFocus(raw: unknown): FocusReport {
  const o = rec(raw) ?? {};
  const b = list(o.box);
  const box = b && b.length === 4 && b.every((x) => typeof x === 'number') ? (b as [number, number, number, number]) : null;
  return { active: str(o.active), marked: str(o.marked), selector: str(o.selector) ?? FOCUS_SELECTOR, tabindex: num(o.tabindex), box, focusable: num(o.focusable) ?? 0, ms: num(o.__ms) };
}

// ---- Speed -----------------------------------------------------------------------------------------

/** The four pieces of work the speed probe times, in the order it runs them, and what each is. */
export const SPEED_WORK = {
  js: 'arithmetic and array work in script',
  json: 'stringify and parse of a 2,000-item list',
  dom: '2,000 elements made, attached and removed',
  layout: '200 forced layouts of 500 boxes',
} as const;
export type SpeedWork = keyof typeof SPEED_WORK;
/** Runs of each piece of work when the device is quick enough; the answer is their median. */
export const SPEED_RUNS = 5;
/** Once a piece of work has taken this long in all, no further run of it starts. */
const SPEED_BUDGET_MS = 1500;

/**
 * How fast this device does four fixed pieces of work, each the median of up to five runs, in ms.
 * A fixed yardstick: the same numbers from a device, from an emulated engine and from a laptop say how
 * far apart they are, and `js` is what an emulator's CPU share is tuned to match.
 */
export interface SpeedReport extends Record<SpeedWork, number | null> {
  /** How many runs each median is of: fewer than five where one run took most of the budget. */
  runs: Record<SpeedWork, number>;
  /** The same script and JSON work timed on this laptop, in Node, to read the device's against. */
  laptop: { js: number; json: number };
  /** Main-thread time the work took in all, ms. */
  ms: number | null;
  /** From the first piece of work to the last, the page's own work between them included. */
  wallMs: number | null;
}

// The work is fixed: change a loop and no number taken before compares with one taken after. It runs
// in a frame of its own, so the app's styles don't reach it (the tiles it makes have a class an app
// may well style) and the app's own document is touched twice, to add the frame and to take it
// away. The frame is laid out but not shown. Each piece of work is a task of its own, so the page
// gets a turn between them.
const SPEED_LIST = 'var list=[],i;for(i=0;i<2000;i++)list.push({id:i,title:"Episode "+i+" of a long running show",tags:["hd","new"],x:i*220});';
const SPEED_JS = 'var a=[],s=0;for(var i=0;i<300000;i++){a[i&1023]=(i*31)^(s>>>3);s=(s+a[(i*7)&1023])|0}return s';
const SPEED_JSON = 'return JSON.parse(JSON.stringify(list)).length';

let laptop: SpeedReport['laptop'] | null = null;
/** The script and JSON work on this laptop: the very source the device runs, the median of five,
 *  timed once for the life of the process. A device's number over this one is how many times
 *  longer the same code takes there than here, engine and chip together. */
function laptopSpeed(): SpeedReport['laptop'] {
  if (laptop) return laptop;
  const median = (work: () => unknown) => {
    const t = Array.from({ length: SPEED_RUNS }, () => {
      const t0 = performance.now();
      work();
      return performance.now() - t0;
    }).sort((a, b) => a - b);
    return Math.round(t[Math.floor(t.length / 2)]! * 100) / 100;
  };
  const list = new Function(`${SPEED_LIST}return list`)() as unknown;
  return (laptop = { js: median(new Function(SPEED_JS) as () => unknown), json: median(new Function('list', SPEED_JSON).bind(null, list) as () => unknown) });
}

const SPEED_SCRIPT =
  `(function(){${TIMER}var MAX=${SPEED_RUNS},BUDGET=${SPEED_BUDGET_MS},out={runs:{}},busy=0;` +
  'var f=document.createElement("iframe");f.setAttribute("data-teleport","speed");' +
  'f.style.cssText="position:fixed;left:0;top:0;width:1280px;height:720px;border:0;visibility:hidden;pointer-events:none;z-index:-1";' +
  '(document.body||document.documentElement).appendChild(f);var d=f.contentDocument;d.open();d.write("<!doctype html><html><body></body></html>");d.close();' +
  'var host=d.createElement("div");d.body.appendChild(host);' +
  SPEED_LIST +
  'function timed(k,fn){var t=[],spent=0;try{while(t.length<MAX&&(!t.length||spent<BUDGET)){var a=now();fn();var ms=now()-a;t.push(ms);spent+=ms}}catch(e){}' +
  'busy+=spent;out.runs[k]=t.length;if(!t.length){out[k]=null;return}t.sort(function(x,y){return x-y});out[k]=Math.round(t[Math.floor(t.length/2)]*10)/10}' +
  'var work=[' +
  `function(){timed("js",function(){${SPEED_JS}})},` +
  `function(){timed("json",function(){${SPEED_JSON}})},` +
  'function(){timed("dom",function(){var g=d.createDocumentFragment();for(var i=0;i<2000;i++){var e=d.createElement("div");e.className="tile";e.setAttribute("data-id","item-"+i);e.appendChild(d.createTextNode("Episode "+i));g.appendChild(e)}host.appendChild(g);host.innerHTML=""})},' +
  'function(){var h="";for(var i=0;i<500;i++)h+="<div style=\\"float:left;width:"+(50+(i%7)*10)+"px;height:20px\\">"+i+"</div>";host.innerHTML=h;' +
  'timed("layout",function(){for(var i=0;i<200;i++){host.style.width=600+(i%50)+"px";host.offsetHeight}});host.innerHTML=""}],n=0;' +
  'function done(){if(f.parentNode)f.parentNode.removeChild(f);out.__ms=busy;out.__wall=now()-t0;return out}' +
  'if(typeof Promise!=="function"){for(;n<work.length;n++)work[n]();return done()}' +
  'return new Promise(function(resolve){(function next(){if(n>=work.length)return resolve(done());work[n++]();setTimeout(next,0)})()})})()';

function parseSpeed(raw: unknown): SpeedReport {
  const o = rec(raw) ?? {};
  const runs = rec(o.runs) ?? {};
  const each = <T>(of: (k: SpeedWork) => T) => Object.fromEntries((Object.keys(SPEED_WORK) as SpeedWork[]).map((k) => [k, of(k)])) as Record<SpeedWork, T>;
  return { ...each((k) => num(o[k])), runs: each((k) => num(runs[k]) ?? 0), laptop: laptopSpeed(), ms: num(o.__ms), wallMs: num(o.__wall) };
}

// ---- Registry --------------------------------------------------------------------------------------

export const PROBES: { [K in ProbeId]: ProbeDef<ProbeResults[K]> } = {
  identity: { label: 'identity', about: 'model, screen, memory, network', cost: 'reads properties and media queries', script: capabilityScript(IDENTITY), parse: parseCapabilities(IDENTITY) },
  features: { label: 'features', about: 'CSS, JavaScript syntax, web APIs', cost: 'CSS.supports, syntax checks and property lookups · one forced layout', script: capabilityScript(FEATURES, PRELUDE.features), parse: parseCapabilities(FEATURES) },
  media: { label: 'media', about: 'codecs, key systems, robustness', cost: 'isTypeSupported and canPlayType · key system requests wait on the device', script: capabilityScript(MEDIA, PRELUDE.media), parse: parseMedia },
  graphics: { label: 'graphics', about: 'WebGL limits, image formats, fps', cost: 'makes and frees a WebGL and a WebGL2 context · two 1 px decodes · 14 animation frames', script: capabilityScript(GRAPHICS, PRELUDE.graphics, EPILOGUE.graphics), parse: parseCapabilities(GRAPHICS) },
  storage: { label: 'storage', about: 'local, session, cookies, IndexedDB', cost: 'reads every stored value · opens each database read-only to count', script: STORAGE_SCRIPT, parse: parseStorage },
  dom: { label: 'dom', about: 'size, depth, widest subtree', cost: 'walks every node once', script: DOM_SCRIPT, parse: parseDom },
  focus: { label: 'focus', about: 'the focused element and its box', cost: 'two selector queries and one box read', script: FOCUS_SCRIPT, parse: parseFocus },
  speed: { label: 'speed', about: 'speed of script, JSON, DOM, layout', cost: 'holds the page a second or more: four fixed pieces of work in a hidden frame', script: SPEED_SCRIPT, waitMs: 60_000, parse: parseSpeed },
};

export const PROBE_IDS = Object.keys(PROBES) as ProbeId[];
export const isProbe = (s: unknown): s is ProbeId => typeof s === 'string' && Object.prototype.hasOwnProperty.call(PROBES, s);
