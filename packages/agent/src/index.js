'use strict';
// teleport agent entry. A 1 Hz tick records the agent's own main-thread time and timer lag, runs
// the 1 Hz samplers, and ships pending ring records as one binary frame over WebSocket.
// Event samplers (long tasks, resources, keys, capture frames) live in samplers.js.
// The app shouldn't know it is there: nothing on its screen unless asked for (data-badge="on"),
// nothing in its console, and nothing the agent does can throw into it or reach its error
// reporting (safe.js).

var S = require('./generated/schema.js');
var ring = require('./ring.js');
var enc = require('./encode.js');
var clock = require('./clock.js');
var samplers = require('./samplers.js');
var errors = require('./errors.js');
var ask = require('./ask.js');
var safe = require('./safe.js');

var safely = safe.safely;
var guard = safe.guard;

// The package's version, put in by the build (build.mjs); from source, as the tests run it, none.
var VERSION = typeof TELEPORT_VERSION === 'string' ? TELEPORT_VERSION : '0.0.0';
var TICK_MS = 1000;
// With no socket at all for this many ticks (the laptop is away, retries are backing off), the
// tick slows to IDLE_TICK_MS: the page keeps a thin history and pays almost nothing for it.
var IDLE_AFTER_TICKS = 60;
var IDLE_TICK_MS = 5000;
var MAX_BUFFERED = 65536; // back off when ws.bufferedAmount exceeds this
var RETRY_MS = 5000;
var RELINK_MS = 1000; // the first retry after an open link drops, as a tunnel does now and then
var MAX_RETRY_MS = 10000; // reconnect backoff doubles up to this: a failed attempt costs the device next to nothing
// Ticks a socket may sit in CONNECTING, or OPEN with a send buffer that never drains, before it is
// abandoned for a fresh one. Some device WebSocket stacks never fire onclose on a dead link.
var CONNECT_TICKS = 10;
var STALL_TICKS = 30;
// Ticks an open socket may go without a word from the server, which pings every 15 s, before it is
// taken for a link a tunnel or router dropped without telling this side, and replaced.
var SILENT_TICKS = 45;
// A server that beats (every 4 s) is heard from far more often, so its silence means sooner.
var BEAT_SILENT_TICKS = 10;
// After a socket opens, frames wait this long for the server to say what it holds of this page.
var RESUME_WAIT_MS = 500;
// The server closes with this code when another page connected under this tab's id.
var REPLACED = 4000;
var ID_KEY = 'teleport.id';
// This page load, so the laptop can tell a link that came back from a reload in the same tab.
var PAGE_ID = Math.random().toString(36).slice(2, 10);

var now = clock.now;
var root = typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : {};

var features = {
  typedArrays: typeof ArrayBuffer === 'function' && typeof DataView === 'function' && typeof Float64Array === 'function',
  websocket: typeof WebSocket === 'function' || typeof WebSocket === 'object',
  clock: clock.source
};

var st = {
  running: false,
  url: null,
  ws: null,
  timer: 0,
  rings: null,
  encoder: null,
  windowStart: 0,
  dueAt: 0, // when the pending tick timer should fire
  workMs: 0, // agent self-time in the current tick window
  totalWorkMs: 0,
  startedAt: 0,
  ticks: 0,
  framesSent: 0,
  framesSkipped: 0, // frames not sent because of backpressure or no open socket
  reconnects: 0,
  retry: 0, // pending reconnect timer
  retryMs: RETRY_MS,
  waitTicks: 0, // consecutive ticks the socket has been connecting or stalled
  quietTicks: 0, // consecutive ticks the open socket has heard nothing from the server
  awayTicks: 0, // consecutive ticks with no socket at all
  heardBeat: false, // this server beats, so a shorter silence means the link is dead
  openedAt: 0,
  resumed: false, // the server said what it holds of this page
  badge: false // show the mark on the device's screen
};

function addWork(ms) {
  st.workMs += ms;
  st.totalWorkMs += ms;
}

function noop() {}

// What the page calls back, each through guard() (safe.js), so a failure stays the agent's.
var onTick = guard(tick);
var reconnect = guard(connect);
var opened = guard(onOpen);
var closed = guard(onClose);
var heard = guard(onCommand);

// try/catch lives only in this helper: constructors can throw on bad URLs or blocked ports.
function openSocket(url) {
  try {
    return new WebSocket(url);
  } catch (e) {
    return null;
  }
}

// One reconnect timer at a time, with backoff, so a laptop that is away costs the device almost nothing.
function scheduleRetry() {
  if (!st.running || st.retry) return;
  st.reconnects++;
  st.retry = setTimeout(reconnect, st.retryMs);
  st.retryMs = st.retryMs * 2 > MAX_RETRY_MS ? MAX_RETRY_MS : st.retryMs * 2;
}

// Detaches the socket first, so its late events can't touch the one that replaces it.
function dropSocket() {
  var ws = st.ws;
  st.ws = null;
  st.waitTicks = 0;
  if (!ws) return;
  ws.onopen = ws.onclose = ws.onmessage = null;
  closeSocket(ws);
  samplers.setLive(false);
  safely(mark, false);
}

// try/catch lives only here: close() throws on some engines in odd states.
function closeSocket(ws) {
  try {
    ws.close();
  } catch (e) {}
}

function connect() {
  st.retry = 0;
  if (!st.running || !st.url || !features.websocket || st.ws) return;
  var ws = openSocket(st.url);
  // The constructor throws only for what no retry changes: a malformed address, a blocked port, an
  // insecure socket from a secure page, a Content-Security-Policy. The agent stops there: retrying
  // would only have the browser log the refusal in the page's console again and again.
  if (!ws) {
    halt();
    return;
  }
  ws.binaryType = 'arraybuffer';
  ws.onopen = opened;
  ws.onclose = closed;
  ws.onerror = noop;
  ws.onmessage = heard;
  st.ws = ws;
}

// try/catch lives only in this helper, so the functions that call it stay optimisable on old V8.
// send() throws on some engines when the socket closed between the readyState check and the call.
function trySend(ws, data) {
  try {
    ws.send(data);
    return true;
  } catch (e) {
    return false;
  }
}

function sendText(s) {
  if (st.ws && st.ws.readyState === 1) trySend(st.ws, s);
}

function sendName(id, name) {
  sendText('name ' + id + ' ' + name);
}

function onOpen() {
  if (this !== st.ws) return;
  st.retryMs = RELINK_MS;
  st.waitTicks = 0;
  st.quietTicks = 0;
  st.heardBeat = false;
  st.resumed = false;
  st.openedAt = now();
  // Positions only for a server that says what it holds: an older one can't read them.
  st.encoder.positions = false;
  samplers.setLive(true);
  safely(mark, true);
  samplers.eachName(sendName);
  errors.resend();
  ask.again(sendText);
}

// The server names its scripts by path. They load from the address this agent reached the server
// by, so they come through the same tunnel or proxy, never from a Host header one rewrote.
function fromRelay(src) {
  var m = src.charAt(0) === '/' && src.charAt(1) !== '/' && st.url ? /^wss?:\/\/[^\/?#]+/.exec(st.url) : null;
  return m ? m[0].replace(/^ws/, 'http') + src : src;
}

// The tag goes once the script has run, or failed to load: the app's document is left as it was.
function loadScript(src) {
  if (!src || typeof document === 'undefined') return;
  var s = document.createElement('script');
  s.onload = s.onerror = loaded;
  s.src = fromRelay(src);
  (document.head || document.documentElement).appendChild(s);
}

/** @this {HTMLScriptElement} */
function onLoaded() {
  this.onload = this.onerror = null;
  if (this.parentNode) this.parentNode.removeChild(this);
}

var loaded = guard(onLoaded);

var U32_MAX = 4294967295;

// Text commands from the server:
//   load <url>     load the inspector (someone opened DevTools; the baseline never pays for it)
//   reload         reload the page
//   ping <n>       clock sync; answered with `pong <n> <agent clock ms>`
//   capture <ms>   record animation frames for up to 10 s
//   eval <id> <0|1> <source>   a question, answered with `val` or `thr` (ask.js)
// Anything else, or anything malformed, is ignored.
function onCommand(e) {
  if (this !== st.ws) return;
  st.quietTicks = 0;
  var d = e.data;
  if (typeof d !== 'string') return;
  var t0 = now();
  // Commands without an argument, such as `reload`, have no space.
  var at = d.indexOf(' ');
  var cmd = at < 0 ? d : d.slice(0, at);
  var arg = at < 0 ? '' : d.slice(at + 1);
  // The laptop's code is the page's time, not the agent's.
  if (cmd === 'eval') return ask.ask(arg, sendText);
  if (cmd === 'load') loadScript(arg);
  else if (cmd === 'ping') sendText('pong ' + arg + ' ' + now());
  else if (cmd === 'beat') st.heardBeat = true;
  else if (cmd === 'resume') resume(arg);
  else if (cmd === 'capture') samplers.capture(+arg);
  else if (cmd === 'reload' && typeof location !== 'undefined') location.reload();
  addWork(now() - t0);
}

// The server says how many records of each stream it holds for this page, in schema order. The rings
// still hold what was sent after that and lost with the link, so it goes again; the server takes each
// record once by its position. With no numbers the server holds nothing of this page (it restarted):
// everything the rings hold goes. What the rings no longer hold is counted as dropped.
function resume(arg) {
  var has = arg ? arg.split(' ') : null;
  for (var k = 0; k < st.rings.length; k++) {
    var r = st.rings[k];
    var want = has ? r.total - +has[k] : r.size;
    if (!(want > 0)) continue;
    if (want > r.size) {
      r.dropped += want - r.size;
      want = r.size;
    }
    if (want > r.unsent) r.unsent = want;
  }
  st.resumed = true;
  st.encoder.positions = true;
  flush();
}

function onClose(e) {
  // A socket that was already replaced: its close says nothing about the current one.
  if (this !== st.ws) return;
  st.ws = null;
  st.waitTicks = 0;
  samplers.setLive(false);
  safely(mark, false);
  if (e && e.code === REPLACED) return;
  scheduleRetry();
}

// Runs once a tick. A socket that never opens, or whose send buffer never drains (a half-open
// link), is replaced, so the agent can't sit forever on a dead connection while its rings overflow.
function watchSocket() {
  var ws = st.ws;
  if (!ws) return;
  var quiet = ws.readyState === 1 && ++st.quietTicks >= (st.heardBeat ? BEAT_SILENT_TICKS : SILENT_TICKS);
  var stuck = ws.readyState === 0 ? CONNECT_TICKS : ws.readyState === 1 && ws.bufferedAmount > MAX_BUFFERED ? STALL_TICKS : 0;
  // CLOSING or CLOSED with no close event (some engines never send one), or silent.
  if (ws.readyState > 1 || quiet) {
    dropSocket();
    scheduleRetry();
    return;
  }
  if (stuck === 0) {
    st.waitTicks = 0;
    return;
  }
  if (++st.waitTicks >= stuck) {
    dropSocket();
    scheduleRetry();
  }
}

function flush() {
  var ws = st.ws;
  if (ws && ws.readyState === 1 && !st.resumed && now() - st.openedAt < RESUME_WAIT_MS) return;
  if (!ws || ws.readyState !== 1 || ws.bufferedAmount > MAX_BUFFERED) {
    st.framesSkipped++;
    return;
  }
  var len = enc.encodeFrame(st.encoder, st.rings);
  if (trySend(ws, new Uint8Array(st.encoder.buf, 0, len))) st.framesSent++;
  else st.framesSkipped++;
}

/** @type {any} performance.memory is non-standard */
var perfMem = typeof performance !== 'undefined' && performance ? performance : null;
// jsHeapSizeLimit is fixed for the life of the page, and each performance.memory read builds a new
// object on old Chromium, so it is read once at start rather than every tick.
var heapLimit = 0;

function readHeapLimit() {
  var m = perfMem && perfMem.memory;
  heapLimit = m && m.jsHeapSizeLimit ? (m.jsHeapSizeLimit > U32_MAX ? U32_MAX : m.jsHeapSizeLimit) : 0;
}

function writeLink(t0) {
  var r = st.rings[S.S_LINK];
  var i = ring.ringNext(r);
  var insp = root.__teleportInspector && root.__teleportInspector.stats;
  r.t[i] = t0;
  r.cols[0][i] = st.ws ? st.ws.bufferedAmount : 0;
  r.cols[1][i] = insp ? insp.buffered : 0;
  r.cols[2][i] = insp ? insp.costMs : 0;
  r.cols[3][i] = insp ? insp.level : 0;
  r.cols[4][i] = heapLimit;
}

function tick() {
  var t0 = now();
  // How late this tick is, against the deadline the last one set; read before setting the next.
  var late = t0 - st.dueAt;
  // Scheduled first: if anything below throws on an odd engine, the agent still ticks next second.
  st.awayTicks = st.ws ? 0 : st.awayTicks + 1;
  var period = st.awayTicks > IDLE_AFTER_TICKS ? IDLE_TICK_MS : TICK_MS;
  st.timer = setTimeout(onTick, period);
  st.dueAt = t0 + period;
  var r = st.rings[S.S_OVERHEAD];
  var i = ring.ringNext(r);
  r.t[i] = t0;
  r.cols[0][i] = st.workMs;
  r.cols[1][i] = t0 - st.windowStart;
  st.workMs = 0;
  st.windowStart = t0;
  st.ticks++;
  var lag = st.rings[S.S_LAG];
  var j = ring.ringNext(lag);
  lag.t[j] = t0;
  lag.cols[0][j] = late;
  watchSocket();
  safely(samplers.tick, t0);
  errors.tick();
  writeLink(t0);
  flush();
  // This tick's own cost is charged to the next window.
  addWork(now() - t0);
}

// The id outlives reloads of this tab, so an open DevTools reattaches instead of losing its target.
// try/catch lives only here: storage can be missing or throw (private mode, disabled storage), and
// then the server assigns an id per connection.
function tabId() {
  try {
    var store = window.sessionStorage;
    var id = store.getItem(ID_KEY);
    if (!id) {
      id = Math.random().toString(36).slice(2, 10);
      store.setItem(ID_KEY, id);
    }
    return id;
  } catch (e) {
    return '';
  }
}

function withPage(url) {
  if (typeof location === 'undefined') return url;
  var id = tabId();
  return url + (url.indexOf('?') < 0 ? '?' : '&') + 'href=' + encodeURIComponent(location.href) + (id ? '&id=' + id : '') + '&page=' + PAGE_ID + '&e=1';
}

// A mark in a corner of the device's screen for whoever holds the remote, shown only when asked for
// (data-badge="on" on the script tag, or init({ badge: true })); otherwise the agent puts nothing on
// the screen. A lit square while the laptop is connected, a hollow one while the agent waits for it
// to come back. It is touched only when the link changes, and sits on <html> so an app that replaces
// its <body> keeps it. On its own layer from the start: over a page animating transforms it
// otherwise cost about 1 ms/s (headless Chromium at 6x CPU throttle, 10 paired runs).
var MARK_CSS = '-webkit-transform:translateZ(0);transform:translateZ(0);position:fixed;right:3%;bottom:4%;z-index:2147483647;pointer-events:none;margin:0;padding:0;width:12px;height:12px;box-sizing:border-box;border:2px solid ';
var markEl = null;
var badgeAttr = null; // the script tag's data-badge: "on" shows the mark

// Called through safely(): an odd engine's DOM may throw, and that must cost only the mark.
function mark(on) {
  var html = typeof document !== 'undefined' && document.documentElement;
  // Nothing shows until the first connection, so a build whose laptop never comes stays clean.
  if (!st.badge || !html || (!on && !markEl)) return;
  markEl = markEl || document.createElement('div');
  markEl.setAttribute('data-teleport', on ? 'connected' : 'away');
  markEl.style.cssText = MARK_CSS + (on ? '#3fd4c0;background:#3fd4c0' : '#f2ad48;background:transparent');
  if (markEl.parentNode !== html) html.appendChild(markEl);
}

function unmark() {
  if (markEl && markEl.parentNode) markEl.parentNode.removeChild(markEl);
  markEl = null;
}

// try/catch lives only here: reading anything of a window from another origin throws.
function runsIn(w) {
  try {
    var t = w.teleport;
    return !!t && typeof t.status === 'function' && t.status().running === true;
  } catch (e) {
    return false;
  }
}

// One agent for a tab: a page in a frame leaves it to a page above it whose agent is running. Every
// page teleport serves gets the agent, a framed one too, and frames of one origin share the storage
// the tab's id is kept in. Two agents under one id read to the laptop as the tab loading another
// page: it took the frame for the tab and dropped the page above it, which never came back.
// `parent` may be read across origins; a top window is its own parent.
function agentAbove() {
  var w = root;
  for (var i = 0; i < 16 && w.parent && w.parent !== w; i++) {
    w = w.parent;
    if (runsIn(w)) return true;
  }
  return false;
}

// init, stop and status are the app's to call with whatever it passes, and never throw. A start
// that fails part way on an odd engine is undone, and the app carries on as if it had no agent.
function init(opts) {
  if (!st.running && features.typedArrays && !agentAbove() && !safely(start, opts)) safely(halt);
  return api;
}

function start(opts) {
  var t0 = now();
  st.running = true;
  var badge = opts ? opts.badge : undefined;
  st.badge = badge === true || (badge !== false && badgeAttr === 'on');
  st.url = opts && opts.url ? withPage(String(opts.url)) : null;
  // The frame buffer holds every ring in full, so one frame always drains the backlog after an
  // outage, and no stream starves behind the ones encoded before it. About 23 KB, allocated once.
  var rings = new Array(S.STREAM_COUNT);
  var frameBytes = S.HEADER_BYTES;
  for (var k = 0; k < S.STREAM_COUNT; k++) {
    rings[k] = ring.createRing(samplers.CAPS[k], S.STREAM_TYPES[k]);
    frameBytes += S.STREAM_HEADER_BYTES + samplers.CAPS[k] * S.STREAM_RECORD_BYTES[k];
  }
  st.rings = rings;
  st.encoder = enc.createEncoder(frameBytes);
  // Before anything else of the page runs: an app that throws as it starts is the one to hear.
  errors.to(sendText);
  safely(errors.start);
  st.startedAt = t0;
  st.windowStart = t0;
  st.retryMs = RETRY_MS;
  safely(readHeapLimit);
  // The tick and the socket come before the samplers: a sampler that throws on an odd engine then
  // costs only its own stream, not the whole agent.
  st.timer = setTimeout(onTick, TICK_MS);
  st.dueAt = t0 + TICK_MS;
  connect();
  // A socket the engine refused outright stopped the agent.
  if (!st.running) return;
  safely(samplers.start, st.rings, addWork, sendName);
  addWork(now() - t0);
}

function stop() {
  safely(halt);
  return api;
}

function halt() {
  st.running = false;
  clearTimeout(st.timer);
  clearTimeout(st.retry);
  st.retry = 0;
  safely(samplers.stop);
  safely(errors.stop);
  dropSocket();
  safely(unmark);
}

// Snapshot for tests and a console: teleport.status(). Not a hot path.
function status() {
  var elapsed = st.running ? now() - st.startedAt : 0;
  var dropped = 0;
  for (var k = 0; st.rings && k < st.rings.length; k++) dropped += st.rings[k].dropped;
  var s = samplers.stats();
  return {
    version: VERSION,
    running: st.running,
    features: features,
    samplers: samplers.features,
    names: s.names,
    namesDropped: s.namesDropped,
    capturing: s.capturing,
    ticks: st.ticks,
    framesSent: st.framesSent,
    framesSkipped: st.framesSkipped,
    reconnects: st.reconnects,
    dropped: dropped,
    errors: errors.total(),
    selfMs: st.totalWorkMs,
    elapsedMs: elapsed,
    overheadPct: elapsed > 0 ? (100 * st.totalWorkMs) / elapsed : 0
  };
}

var api = { version: VERSION, init: init, stop: stop, status: status };

// An app may have a global of this name of its own, even one that can't be assigned: it keeps it.
function publish() {
  if (!root.teleport) root.teleport = api;
}

// <script src="http://laptop:7070/teleport.js"> starts the agent against the server it came from.
// data-url overrides the relay address; data-url="" loads the agent without starting it.
// A <script> that loads the agent configures and starts it. Bundled into an app (tlpt/auto),
// currentScript is the app's own bundle, so that build starts nothing here; the app's entry does.
// An engine without currentScript, or a tag the agent can't read, leaves the agent asleep.
function boot() {
  var me = typeof document !== 'undefined' ? /** @type {HTMLScriptElement} */ (document.currentScript) : null;
  if (!me) return;
  var origin = /^(http|https):\/\/[^\/]+/.exec(me.src);
  var dataUrl = me.getAttribute('data-url');
  var focusAttr = me.getAttribute('data-focus');
  if (focusAttr !== null && focusAttr !== undefined) samplers.setFocusSelector(focusAttr);
  // data-key-phases="off" stops the per-key style/layout/paint probe.
  if (me.getAttribute('data-key-phases') === 'off') samplers.setKeyPhases(false);
  // data-badge="on" shows the mark on the device's screen; anything else, "off" included, leaves it out.
  badgeAttr = me.getAttribute('data-badge');
  if (dataUrl === null && origin) dataUrl = origin[0].replace(/^http/, 'ws') + '/ws/target';
  if (dataUrl) init({ url: dataUrl });
}

safely(publish);
if (typeof TELEPORT_BUNDLED === 'undefined') safely(boot);

module.exports = api;
