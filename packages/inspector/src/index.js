'use strict';
// teleport inspector: a hand-written subset of the Chrome DevTools Protocol, enough for the stock
// DevTools frontend's Elements, Styles, Console, Network, Sources and Application panels, and for
// the server's own calls (trials, probes, remote keys). The agent loads it only when something
// needs it. The server sends `teleport.detach` when the last user closes, which restores every
// patched global and drops all state. A link that drops keeps that state: the page is still the one
// DevTools has, so it reconnects saying so, and what it logged meanwhile waits.
//
// Messages are handled in slices of SLICE_MS of main-thread time, then the page gets its turn, for
// long enough that answering takes no more than the governor's share of the main thread however
// slow the device. DevTools opening sends forty-odd calls at once and a reconnect can replay hundreds;
// on a device that burst would otherwise be one long task in the middle of whatever the app was doing.
//
// Like the agent, it stays out of the app's way: whatever the server sends, whatever the page does,
// nothing here throws into the app or reaches its window.onerror, unhandledrejection or console
// (cx.js has the helpers). The bundle as a whole is wrapped too (scripts/device-guard.mjs).

var cx = require('./cx.js');
var gov = require('./governor.js');
var domains = [
  require('./runtime.js'),
  require('./dom.js'),
  require('./css.js'),
  require('./overlay.js'),
  require('./page.js'),
  require('./network.js')
];

var RETRY_MS = 1000;
var MAX_RETRY_MS = 8000;
// The server acknowledges this inspector's once-a-second marks, so this much silence on an open
// socket means the link died without a close, as through a tunnel that restarted.
var SILENT_MS = 10000;
var CONTROL = '{"teleport":';
var SLICE_MS = 8;
// The longest rest after one slice, and the most messages held while resting: past that they are
// answered as they come, since holding more would cost the device memory instead of time.
var MAX_REST_MS = 2000;
var MAX_INBOX = 512;
// Domains DevTools probes that have nothing to do on a device page. Any method in them answers {}.
var QUIET = {
  Log: 1, Emulation: 1, Target: 1, Autofill: 1, Audits: 1, ServiceWorker: 1, Inspector: 1,
  Animation: 1, DOMDebugger: 1, Security: 1, Accessibility: 1, Debugger: 1, Profiler: 1
};
var BENIGN = /\.(enable|disable|set[A-Z]\w*)$/;
// These run the page's own code (an eval, a remote press through its key handlers): its time is the
// page's, so it is neither counted as the inspector's nor rested for.
var PAGE = { 'Runtime.evaluate': 1, 'Runtime.callFunctionOn': 1 };

var existing = window.__teleportInspector;
// Whether anything has been asked of this inspector since the last detach. The governor ticks, and
// the inspector costs the page anything at all, only while this is true.
var attached = false;
var inbox = [];
var drainTimer = 0; // pending while the rest of the inbox waits its turn
var restUntil = 0;
var heardAt = 0;
var retryMs = RETRY_MS;

// Each domain lets go on its own: one that fails can't keep the others patched in.
function detach() {
  attached = false;
  inbox = [];
  clearTimeout(drainTimer);
  drainTimer = 0;
  restUntil = 0;
  for (var i = 0; i < domains.length; i++) cx.attempt(domains[i].detach);
  gov.stop();
  cx.reset();
}

function call(h, params, id, method) {
  try {
    return h(params, id);
  } catch (e) {
    cx.fail(id, method + ': ' + (cx.attempt(errorText, e) || 'failed'));
    return cx.ASYNC;
  }
}

// What a handler threw may be anything, even a value with no string form.
function errorText(e) {
  return e && e.message ? String(e.message) : String(e);
}

function parse(data) {
  try {
    return JSON.parse(data);
  } catch (e) {
    return null;
  }
}

var has = Object.prototype.hasOwnProperty;

// A message that isn't a call (not JSON, not an object, no method, a method nobody registered, even
// `__proto__`) gets an error reply at most.
function handle(msg) {
  if (!msg || typeof msg.method !== 'string') return;
  var method = msg.method;
  if (method === 'teleport.detach') return detach();
  var h = has.call(cx.handlers, method) ? cx.handlers[method] : null;
  if (typeof h !== 'function') {
    if (BENIGN.test(method) || QUIET[method.slice(0, method.indexOf('.'))] === 1) cx.reply(msg.id, {});
    else cx.unknown(msg.id, method);
    return;
  }
  if (!attached) {
    attached = true;
    gov.start();
  }
  var p = msg.params;
  var r = call(h, p && typeof p === 'object' ? p : {}, msg.id, method);
  if (r !== cx.ASYNC) cx.reply(msg.id, r || {});
}

// Handles what has arrived until the slice is spent, then yields and comes back for the rest once
// the page has had its turn: `mine` ms of answering earn a rest that keeps it to the governor's share.
function drain() {
  drainTimer = 0;
  var t0 = cx.ms();
  var t = t0;
  var mine = 0;
  while (inbox.length) {
    var msg = parse(inbox.shift());
    handle(msg);
    var t1 = cx.ms();
    if (!msg || PAGE[msg.method] !== 1) mine += t1 - t;
    t = t1;
    if (t - t0 >= SLICE_MS) break;
  }
  cx.asked(mine);
  var rest = mine * (1 / gov.share() - 1);
  if (rest > MAX_REST_MS) rest = MAX_REST_MS;
  restUntil = t + rest;
  if (inbox.length) drainTimer = setTimeout(drainCb, Math.ceil(rest));
}

function control(c) {
  if (!c) return;
  if (c.teleport === 'link') {
    retryMs = RETRY_MS;
    cx.linked(c.got, c.kept);
  } else if (c.teleport === 'ack') cx.trim(c.got);
}

// The link's own words are read at once. A lone call is handled at once too, so it costs no extra
// turn; a burst queues behind it, and one that arrives during a rest waits the rest out.
function onMessage(e) {
  var t0 = cx.ms();
  heardAt = t0;
  var data = e.data;
  if (typeof data === 'string' && data.lastIndexOf(CONTROL, 0) === 0) {
    control(parse(data));
    cx.asked(cx.ms() - t0);
    return;
  }
  cx.received();
  inbox.push(data);
  if (inbox.length > MAX_INBOX) {
    clearTimeout(drainTimer);
    drain();
  } else if (!drainTimer) {
    if (t0 < restUntil) drainTimer = setTimeout(drainCb, Math.ceil(restUntil - t0));
    else drain();
  }
}

var drainCb = cx.guard(drain);
var heard = cx.guard(onMessage);
var opened = cx.guard(onOpen);
var closed = cx.guard(onClose);
var reconnect = cx.guard(connect);

var url = null;
var ws = null;
// Chosen per page load: the server knows the link by it across sockets.
var token = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);

function newSocket(u) {
  return new WebSocket(u);
}

function closeSocket(s) {
  s.close();
}

function connect(fresh) {
  if (!url || (ws && (ws.readyState === 0 || (ws.readyState === 1 && !fresh)))) return;
  if (ws) {
    ws.onopen = ws.onclose = ws.onmessage = null;
    cx.attempt(closeSocket, ws);
  }
  // The constructor throws only for what no retry changes (a blocked port, an insecure socket from
  // a secure page, a Content-Security-Policy): then there is no link, and no retry.
  ws = cx.attempt(newSocket, url + '?link=' + token + '&got=' + cx.got() + (attached ? '&kept=1' : '')) || null;
  cx.setSocket(ws);
  if (!ws) return;
  ws.onmessage = heard;
  ws.onopen = opened;
  ws.onclose = closed;
}

// Nothing goes out until the server says what it got (control), which is also what resets the backoff.
function onOpen() {
  heardAt = cx.ms();
  if (attached) gov.start();
}

// Once a second, while something is attached: say what arrived, and replace a socket gone silent.
function onTick() {
  cx.ack();
  if (ws && ws.readyState === 1 && cx.ms() - heardAt > SILENT_MS) connect(true);
}
gov.onTick(onTick);

// Retries back off while the laptop is away, so a page left running costs it almost nothing.
function onClose() {
  setTimeout(reconnect, retryMs);
  retryMs = retryMs * 2 > MAX_RETRY_MS ? MAX_RETRY_MS : retryMs * 2;
}

function notify(what, params) {
  cx.send({ method: 'teleport.' + what, params: params || {} });
}

// A second load comes only when the server holds no socket from this page, so an open one here is a
// link that died without a close (a tunnel restart): replace it. One still connecting is new.
if (existing) {
  existing.connect(true);
} else {
  var me = document.currentScript;
  var m = /^(http|https):\/\/([^\/]+)\/.*[?&]id=([^&#]+)/.exec(me ? me.src : '');
  url = m ? (m[1] === 'https' ? 'wss' : 'ws') + '://' + m[2] + '/__teleport/ws/cdp/' + m[3] : null;
  if (m) cx.server = m[1] + '://' + m[2];

  // The agent reads `stats` at its 1 Hz tick and sends them on its own socket, so the laptop still
  // hears about this socket's queue when it is the thing that's stuck. `notify` lets code the server
  // put in the page (a trial's runner) tell the laptop something without being polled for it.
  // `server` is the laptop's address, which a trial's runner needs: the inspector's tag is gone by
  // then, and the app may be on another origin.
  window.__teleportInspector = {
    connect: reconnect,
    server: cx.server,
    stats: cx.stats,
    notify: function (what, params) {
      cx.attempt(notify, what, params);
    }
  };
  connect();
}
