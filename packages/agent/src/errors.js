'use strict';
// What the page threw, from the first script after the agent. An app that throws while it starts
// never gets as far as DevTools, and the inspector, which reports errors to DevTools, is not loaded
// yet; so the agent keeps them itself. Two listeners on window, and nothing runs until the page
// throws. The first HEAD errors are kept for good, as the first is usually the cause, and the last
// TAIL after them; the rest are only counted. Each is sent as text when it happens and again when
// a link opens, numbered so the laptop takes each once.

var HEAD = 8;
var TAIL = 8;
var MAX_TEXT = 300;
var MAX_STACK = 600;

var clock = require('./clock.js');

var head = [];
var tail = [];
var total = 0;
var told = 0; // the total the laptop was last sent
var sink = null;
var listening = false;

function clip(v, max) {
  var s = v === undefined || v === null ? '' : String(v);
  return s.length > max ? s.slice(0, max) : s;
}

// kind: 'e' an uncaught error, 'p' a rejection nothing handled, 'r' a script or stylesheet that
// did not load.
function record(kind, text, src, line, col, stack) {
  var e = [total++, Math.round(clock.now()), kind, clip(text, MAX_TEXT), clip(src, MAX_TEXT), +line || 0, +col || 0, clip(stack, MAX_STACK)];
  if (head.length < HEAD) head.push(e);
  else {
    if (tail.length >= TAIL) tail.shift();
    tail.push(e);
  }
  // Past the head, a page throwing in a loop is told once a tick, not once a throw.
  if (sink && e[0] < HEAD) say(e);
}

function read(ev) {
  var t = ev.target;
  var tag = t && t !== window && t.tagName ? String(t.tagName).toLowerCase() : '';
  if (tag) {
    // Images fail all day on a device app, and an app handles those itself.
    if (tag === 'script' || tag === 'link') record('r', tag, t.src || t.href, 0, 0, '');
    return;
  }
  var err = ev.error;
  record('e', ev.message || (err && err.message) || err, ev.filename, ev.lineno, ev.colno, err && err.stack);
}

function readRejection(ev) {
  var r = ev.reason;
  record('p', r && r.message ? r.message : r, '', 0, 0, r && r.stack);
}

// try/catch lives only in these: whatever an odd engine puts on the event, nothing reaches the app.
function onError(ev) {
  try {
    read(ev);
  } catch (x) {}
}

function onRejection(ev) {
  try {
    readRejection(ev);
  } catch (x) {}
}

function say(e) {
  try {
    sink('err ' + JSON.stringify(e));
  } catch (x) {}
}

/** Listens from now on. Capturing, so a script or stylesheet that fails to load is heard too. */
exports.start = function () {
  if (listening || typeof window === 'undefined' || !window.addEventListener) return;
  listening = true;
  window.addEventListener('error', onError, true);
  window.addEventListener('unhandledrejection', onRejection);
};

exports.stop = function () {
  if (!listening) return;
  listening = false;
  window.removeEventListener('error', onError, true);
  window.removeEventListener('unhandledrejection', onRejection);
  sink = null;
};

/** Where errors go: fn(text) sends one line to the laptop. */
exports.to = function (fn) {
  sink = fn;
};

/** Everything held, for a link that just opened. */
exports.resend = function () {
  var i;
  if (!sink || !total) return;
  for (i = 0; i < head.length; i++) say(head[i]);
  for (i = 0; i < tail.length; i++) say(tail[i]);
  told = total;
  sink('errs ' + total);
};

/** Once a tick: the errors past the head since the last one, and how many there were in all. */
exports.tick = function () {
  if (total === told || !sink) return;
  for (var i = 0; i < tail.length; i++) if (tail[i][0] >= told) say(tail[i]);
  told = total;
  sink('errs ' + total);
};

exports.total = function () {
  return total;
};
