'use strict';
// Raw-event samplers. Each one writes timestamps and counters into its ring and nothing else.
// Every derived number (fps, percentiles, key-to-frame, drop rates) is computed on the laptop.
// Callbacks are module-level functions, so registering and running them allocates no closures. The
// page calls each one through its guard() (safe.js), made once at load: a sampler that fails on an
// odd engine loses its own record, and the app, its key handlers and its onerror never hear of it.

var S = require('./generated/schema.js');
var ring = require('./ring.js');
var clock = require('./clock.js');
var guard = require('./safe.js').guard;

var now = clock.now;
var MAX_CAPTURE_MS = 10000;
var MAX_VIDEOS = 4;
var NAME_CAP = 1024;
// Longest interned string. Tracking URLs can run to kilobytes; 1024 of them would hold megabytes.
var NAME_CHARS = 512;
var NO_NAME = 65535;
// The page's own origin, left off resource names: the laptop knows the page and puts it back.
var origin = '';
// Whether a laptop is connected. Keys are followed to their frame, and probed, only then: nobody
// else wants the numbers, and an app left running costs nothing for them.
var live = false;
var PENDING_KEYS = 8;
var KEY_TIMEOUT_MS = 1000;
var POLL_TICKS = 5;
var DOM_TICKS = 5;
var PENDING_TARGETS = 16;
var TARGET_DEPTH = 6;
var PHASES = 7;
var PROBE_GAP_MS = 250;
var MAX_INPUT_DELAY_MS = 10000;
// Key phase probe stages.
var IDLE = 0;
var IN_HANDLERS = 1;
var TO_FRAME = 2;
var IN_RAF = 3;
var TO_PAINT = 4;

var root = typeof window !== 'undefined' ? window : {};
/** @type {any} performance.memory is non-standard */
var perf = typeof performance !== 'undefined' && performance ? performance : null;
var raf = root.requestAnimationFrame || root.webkitRequestAnimationFrame || null;
var PO = root.PerformanceObserver;

var kinds = {};
for (var kk = 0; kk < S.RESOURCE_KINDS.length; kk++) kinds[S.RESOURCE_KINDS[kk]] = kk;

var rings = null;
var work = null;
var sendName = null;

var captureUntil = 0;
var rafPending = false;
var keyT = null;
var keyCode = null;
var keyEl = null;
var keyDelay = null;
var keyCount = 0;
// Focused elements of written key records, resolved to names at the 1 Hz tick, off the event path.
var targetT = null;
var targetEl = null;
var targetLand = null;
var targetCount = 0;
var allElements = null;
// Apps for these devices usually move focus with a class, not DOM focus, so activeElement stays <body>. This
// selector finds the focused element instead; data-focus on the agent's script tag overrides it.
var focusSelector = '.focused,.focus,.is-focused,.selected,[data-focused="true"]';
// The element the selector found last time. On the key's own path it is checked first: one
// matches() on it instead of a selector query over the whole document, which the next key's focus
// almost always confirms.
var lastMarked = null;
var matchFn = null;
var domIn = 0;
// One key at a time is followed through its frame (see probe* below). The forced style and layout
// reads move work the frame was about to do anyway; they add work only if a later rAF callback
// dirties the page again.
var phasesOn = true;
var probeStage = IDLE;
var probeKeyT = 0;
var probeMark = 0;
var probeLast = -PROBE_GAP_MS;
var probePh = null;
var probeEl = null;
var probeStyle = null;
var probePort = null;
var sink = null;

// '$' + name → id. One copy of each string; the ids count up with nameCount.
var names = {};
var nameCount = 0;
var namesDropped = 0;

var videos = null;
var longObserver = null;
var resObserver = null;
var resCursor = 0;
var pollIn = 0;

var features = {
  frame: raf ? 'requestAnimationFrame' : 'unavailable',
  input: 'keydown',
  longtask: 'unavailable',
  resource: 'unavailable',
  video: 'unavailable',
  heap: perf && perf.memory ? 'performance.memory' : 'unavailable',
  keyphase: 'unavailable'
};

var keyListener = guard(onKey);
var keyEndListener = guard(onKeyEnd);
var frameCb = guard(onFrame);
var probeFrameCb = guard(onProbeFrame);
var probeTaskCb = guard(onProbeTask);
var longTasksCb = guard(onLongTasks);
var resourcesCb = guard(onResources);

function nameId(s) {
  if (origin && s.lastIndexOf(origin, 0) === 0 && s.charAt(origin.length) === '/') s = s.slice(origin.length);
  if (s.length > NAME_CHARS) s = s.slice(0, NAME_CHARS);
  var key = '$' + s;
  var id = names[key];
  if (id !== undefined) return id;
  if (nameCount >= NAME_CAP) {
    namesDropped++;
    return NO_NAME;
  }
  id = nameCount++;
  names[key] = id;
  sendName(id, s);
  return id;
}

function recordResource(e) {
  var r = rings[S.S_RESOURCE];
  var i = ring.ringNext(r);
  r.t[i] = e.startTime;
  r.cols[0][i] = e.duration;
  r.cols[1][i] = e.responseStart > 0 ? e.responseStart - e.startTime : -1;
  r.cols[2][i] = e.transferSize || e.encodedBodySize || 0;
  r.cols[3][i] = nameId(e.name);
  var kind = kinds[e.initiatorType];
  r.cols[4][i] = kind === undefined ? 0 : kind;
}

function onResources(list) {
  var t0 = now();
  var a = list.getEntries();
  for (var i = 0; i < a.length; i++) recordResource(a[i]);
  work(now() - t0);
}

function pollResources() {
  var a = perf.getEntriesByType('resource');
  if (a.length < resCursor) resCursor = 0;
  for (var i = resCursor; i < a.length; i++) recordResource(a[i]);
  resCursor = a.length;
}

function onLongTasks(list) {
  var t0 = now();
  var a = list.getEntries();
  var r = rings[S.S_LONGTASK];
  for (var j = 0; j < a.length; j++) {
    var i = ring.ringNext(r);
    r.t[i] = a[j].startTime;
    r.cols[0][i] = a[j].duration;
  }
  work(now() - t0);
}

function writeKey(t, code, toFrame, el, delay, land) {
  var r = rings[S.S_INPUT];
  var i = ring.ringNext(r);
  r.t[i] = t;
  r.cols[0][i] = code;
  r.cols[1][i] = toFrame;
  r.cols[2][i] = delay;
  if (targetCount < PENDING_TARGETS) {
    targetT[targetCount] = t;
    targetEl[targetCount] = el;
    targetLand[targetCount] = land;
    targetCount++;
  }
}

function classOf(el) {
  var c = el.className;
  if (typeof c !== 'string' || !c) return '';
  var m = /^\s*(\S+)/.exec(c);
  return m ? '.' + m[1] : '';
}

// "div.tile in #rail-trending": the element's tag and first class, then the nearest ancestor id.
// Classes over ids for the element itself, so a thousand tiles share one name.
function describe(el) {
  if (!el || !el.tagName) return '';
  var own = el.tagName.toLowerCase() + (classOf(el) || (el.id ? '#' + el.id : ''));
  var p = el.parentNode;
  for (var d = 0; p && p.tagName && d < TARGET_DEPTH; d++) {
    if (p.id) return own + ' in #' + p.id;
    p = p.parentNode;
  }
  return own;
}

// The landing element's box is read here at the 1 Hz tick, off the key's path: where focus came to
// rest, after any scroll it started.
function writeTargets() {
  var r = rings[S.S_KEYTARGET];
  for (var k = 0; k < targetCount; k++) {
    var el = targetEl[k];
    var land = targetLand[k];
    var name = describe(el);
    var lname = land === el ? name : describe(land);
    var b = land && land.getBoundingClientRect ? land.getBoundingClientRect() : null;
    var i = ring.ringNext(r);
    r.t[i] = targetT[k];
    r.cols[0][i] = name ? nameId(name) : NO_NAME;
    r.cols[1][i] = lname ? nameId(lname) : NO_NAME;
    r.cols[2][i] = b ? b.left : -1;
    r.cols[3][i] = b ? b.top : -1;
    r.cols[4][i] = b ? b.width : 0;
    r.cols[5][i] = b ? b.height : 0;
    r.cols[6][i] = land ? (land === el ? 0 : 1) : 255;
    targetEl[k] = null;
    targetLand[k] = null;
  }
  targetCount = 0;
}

// Key records are written when their frame arrives, so a 1 Hz flush never sends a half-filled one.
function flushKeys(t) {
  var land = t < 0 ? null : focused();
  for (var k = 0; k < keyCount; k++) {
    writeKey(keyT[k], keyCode[k], t < 0 ? -1 : t - keyT[k], keyEl[k], keyDelay[k], land);
    keyEl[k] = null;
  }
  keyCount = 0;
}

function requestFrame() {
  if (rafPending || !raf) return;
  rafPending = true;
  raf.call(root, frameCb);
}

function onFrame() {
  var t0 = now();
  rafPending = false;
  if (t0 < captureUntil) {
    var r = rings[S.S_FRAME];
    // The callback's own time, not rAF's timestamp: after a long task Chrome stamps the frame with a
    // time scheduled during the block, so a 120 ms freeze read as 100 ms.
    r.t[ring.ringNext(r)] = t0;
    requestFrame();
  }
  if (keyCount > 0) flushKeys(t0);
  if (probeStage === TO_FRAME) {
    probePh[2] = t0 - probeMark;
    probeMark = t0;
    probeStage = IN_RAF;
  } else if (probeStage === IN_HANDLERS) {
    // The frame came before the handlers were seen to end: nothing after input delay is reliable.
    probeDone();
  }
  work(now() - t0);
}

// Old engines stamp events with epoch ms, newer ones with the performance.now() clock.
function inputDelay(e, t0) {
  var ts = e.timeStamp;
  if (!(ts > 0)) return -1;
  var d = ts > 1e12 ? Date.now() - ts : t0 - ts;
  return d >= 0 && d < MAX_INPUT_DELAY_MS ? d : -1;
}

function probeStart(e, t0) {
  probeStage = IN_HANDLERS;
  probeKeyT = t0;
  probeLast = t0;
  probeMark = t0;
  for (var k = 0; k < PHASES; k++) probePh[k] = -1;
  probePh[0] = inputDelay(e, t0);
  // Fallback end of the handlers, for apps that stop propagation before the bubble listener.
  probeNextTask();
}

function probeNextTask() {
  if (probePort) probePort.postMessage(0);
  else setTimeout(probeTaskCb, 0);
}

function probeHandlersEnd(t) {
  probePh[1] = t - probeMark;
  probeMark = t;
  probeStage = TO_FRAME;
  // Registered after the app's handlers, so it runs after the rAF callbacks they registered.
  raf.call(root, probeFrameCb);
}

function onKeyEnd() {
  if (probeStage === IN_HANDLERS) probeHandlersEnd(now());
}

function onProbeTask() {
  var t = now();
  if (probeStage === IN_HANDLERS) {
    probeHandlersEnd(t);
  } else if (probeStage === TO_PAINT) {
    probePh[6] = t - probeMark;
    probeDone();
  }
  work(now() - t);
}

function styleOf(el) {
  if (el !== probeEl) {
    probeEl = el;
    probeStyle = root.getComputedStyle(el, null);
  }
  return probeStyle;
}

function onProbeFrame() {
  var t = now();
  if (probeStage !== IN_RAF) {
    probeDone();
    return;
  }
  probePh[3] = t - probeMark;
  var el = focused() || document.documentElement;
  // A computed-style read on the (likely dirty) focused element forces a style recalc only;
  // offsetHeight then forces layout.
  var s = styleOf(el);
  var s0 = now();
  sink = s.zIndex;
  var s1 = now();
  sink = document.body ? document.body.offsetHeight : 0;
  var l1 = now();
  probePh[4] = s1 - s0;
  probePh[5] = l1 - s1;
  probeMark = l1;
  probeStage = TO_PAINT;
  probeNextTask();
  work(s0 - t + now() - l1);
}

function probeDone() {
  var r = rings[S.S_KEYPHASE];
  var i = ring.ringNext(r);
  r.t[i] = probeKeyT;
  for (var k = 0; k < PHASES; k++) r.cols[k][i] = probePh[k];
  probeStage = IDLE;
}

function markedElement() {
  if (!focusSelector) return null;
  var m = lastMarked;
  if (m && matchFn && document.documentElement.contains(m) && matchFn.call(m, focusSelector)) return m;
  lastMarked = document.querySelector(focusSelector);
  return lastMarked;
}

// An app that keeps DOM focus on a wrapper and marks the focused item with a class: the item wins.
function focused() {
  if (typeof document === 'undefined') return null;
  var el = document.activeElement;
  var marked = markedElement();
  if (!el || el === document.body || el === document.documentElement) return marked || el;
  return marked && marked !== el && el.contains(marked) ? marked : el;
}

// try/catch lives only here: querySelector throws on an invalid selector.
function validSelector(sel) {
  try {
    document.querySelector(sel);
    return true;
  } catch (e) {
    return false;
  }
}

function setFocusSelector(sel) {
  if (typeof document !== 'undefined' && (sel === '' || validSelector(sel))) {
    focusSelector = sel;
    lastMarked = null;
  }
}

function onKey(e) {
  if (!live) return;
  var t0 = now();
  if (keyCount < PENDING_KEYS) {
    keyT[keyCount] = t0;
    keyCode[keyCount] = e.keyCode;
    keyEl[keyCount] = focused();
    keyDelay[keyCount] = inputDelay(e, t0);
    keyCount++;
  } else {
    writeKey(t0, e.keyCode, -1, null, inputDelay(e, t0), null);
  }
  if (phasesOn && probeStage === IDLE && t0 - probeLast >= PROBE_GAP_MS && features.keyphase !== 'unavailable') probeStart(e, t0);
  requestFrame();
  work(now() - t0);
}

function sampleVideo(v, el, t) {
  var decoded, dropped;
  if (typeof v.getVideoPlaybackQuality === 'function') {
    var q = v.getVideoPlaybackQuality();
    decoded = q.totalVideoFrames;
    dropped = q.droppedVideoFrames;
    features.video = 'getVideoPlaybackQuality';
  } else if (typeof v.webkitDecodedFrameCount === 'number') {
    decoded = v.webkitDecodedFrameCount;
    dropped = v.webkitDroppedFrameCount;
    features.video = 'webkitDecodedFrameCount';
  } else {
    return;
  }
  var r = rings[S.S_VIDEO];
  var i = ring.ringNext(r);
  r.t[i] = t;
  r.cols[0][i] = el;
  r.cols[1][i] = decoded;
  r.cols[2][i] = dropped;
  r.cols[3][i] = v.currentTime;
}

function supports(type) {
  var list = PO && PO.supportedEntryTypes;
  return !list || list.indexOf(type) >= 0;
}

// try/catch lives only here: observe() throws on engines that don't know the entry type.
function observe(cb, type) {
  if (typeof PO !== 'function' || !supports(type)) return null;
  try {
    var o = new PO(cb);
    o.observe({ entryTypes: [type] });
    return o;
  } catch (e) {
    return null;
  }
}

/** Called from the agent's 1 Hz tick. */
function tick(t0) {
  var m = perf && perf.memory;
  if (m) {
    var r = rings[S.S_HEAP];
    var i = ring.ringNext(r);
    r.t[i] = t0;
    r.cols[0][i] = m.usedJSHeapSize;
    r.cols[1][i] = m.totalJSHeapSize;
  }
  if (videos) for (var k = 0; k < videos.length && k < MAX_VIDEOS; k++) sampleVideo(videos[k], k, t0);
  if (keyCount > 0 && t0 - keyT[0] > KEY_TIMEOUT_MS) flushKeys(-1);
  if (probeStage !== IDLE && t0 - probeKeyT > KEY_TIMEOUT_MS) probeDone();
  if (targetCount > 0) writeTargets();
  if (allElements && --domIn <= 0) {
    domIn = DOM_TICKS;
    var dr = rings[S.S_DOM];
    var di = ring.ringNext(dr);
    dr.t[di] = t0;
    dr.cols[0][di] = allElements.length;
  }
  if (features.resource === 'poll' && --pollIn <= 0) {
    pollIn = POLL_TICKS;
    pollResources();
  }
}

/** Records animation frames for up to 10 s. Returns false when the engine has no rAF. */
function capture(ms) {
  if (!raf) return false;
  captureUntil = now() + (ms > MAX_CAPTURE_MS ? MAX_CAPTURE_MS : ms);
  requestFrame();
  return true;
}

function start(rs, workFn, nameFn) {
  rings = rs;
  work = workFn;
  sendName = nameFn;
  keyT = new Float64Array(PENDING_KEYS);
  keyCode = new Uint16Array(PENDING_KEYS);
  keyEl = new Array(PENDING_KEYS);
  keyDelay = new Float64Array(PENDING_KEYS);
  targetT = new Float64Array(PENDING_TARGETS);
  targetEl = new Array(PENDING_TARGETS);
  targetLand = new Array(PENDING_TARGETS);
  probePh = new Float64Array(PHASES);
  if (root.addEventListener) {
    root.addEventListener('keydown', keyListener, true);
    root.addEventListener('keydown', keyEndListener, false);
  }
  if (typeof location !== 'undefined') origin = location.protocol + '//' + location.host;
  if (typeof document !== 'undefined') {
    videos = document.getElementsByTagName('video');
    allElements = document.getElementsByTagName('*');
    if (raf && typeof root.getComputedStyle === 'function') features.keyphase = 'probe';
    var EP = root.Element && root.Element.prototype;
    matchFn = EP ? EP.matches || EP.webkitMatchesSelector || EP.msMatchesSelector || null : null;
  }
  if (typeof root.MessageChannel === 'function') {
    var ch = new root.MessageChannel();
    ch.port1.onmessage = probeTaskCb;
    probePort = ch.port2;
  }
  longObserver = observe(longTasksCb, 'longtask');
  if (longObserver) features.longtask = 'PerformanceObserver';
  resObserver = observe(resourcesCb, 'resource');
  if (resObserver) {
    features.resource = 'PerformanceObserver';
    if (perf.getEntriesByType) pollResources();
  } else if (perf && typeof perf.getEntriesByType === 'function') {
    features.resource = 'poll';
  }
}

function stop() {
  captureUntil = 0;
  if (root.removeEventListener) {
    root.removeEventListener('keydown', keyListener, true);
    root.removeEventListener('keydown', keyEndListener, false);
  }
  probeStage = IDLE;
  probeEl = probeStyle = null;
  lastMarked = null;
  if (longObserver) longObserver.disconnect();
  if (resObserver) resObserver.disconnect();
  longObserver = resObserver = null;
}

/** Calls fn(id, name) for every interned string, so a fresh connection can be told them all. */
function eachName(fn) {
  for (var key in names) fn(names[key], key.slice(1));
}

function stats() {
  return { names: nameCount, namesDropped: namesDropped, capturing: now() < captureUntil };
}

function setLive(on) {
  live = !!on;
}

function setKeyPhases(on) {
  phasesOn = !!on;
}

exports.CAPS = [120, 120, 256, 1024, 128, 256, 128, 120, 120, 32, 128, 32];
exports.setKeyPhases = setKeyPhases;
exports.setLive = setLive;
exports.features = features;
exports.start = start;
exports.stop = stop;
exports.tick = tick;
exports.capture = capture;
exports.eachName = eachName;
exports.stats = stats;
exports.setFocusSelector = setFocusSelector;
