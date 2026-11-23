'use strict';
// Keeps the inspector from being the reason the device runs out of time or memory. Once a second it
// looks at its own main-thread time, the bytes queued on its socket and the JS heap against the
// engine's limit, and picks a level:
//   0 normal   full detail
//   1 shed     shorter previews; console arguments are previewed but not kept for expanding
//   2 survive  console and network reporting stop and are only counted, and DOM changes are no
//              longer watched (dom.js); DevTools gets a fresh tree once the page is calm again.
//              What the page threw or logged as an error still goes, a few a second.
// The time it looks at is what the page drives: reporting its logs, DOM changes and requests, and
// sending them. Answering DevTools is paced by share() instead (index.js), so a busy second of
// DevTools' own questions never stops the console. A second that passes its whole budget steps up
// at once, without waiting for the tick.
// It steps up at once and back down one level after CALM_S quiet seconds. Each change is reported
// to the laptop and shown in DevTools' console. It also sends a timestamped mark, which tells the
// laptop how long messages spend queued on the device.
var cx = require('./cx.js');
var R = require('./remote.js');

var TICK_MS = 1000;
var CALM_S = 5;
var SHED = { costPct: 3, heap: 0.7, queuedTicks: 2 };
var SURVIVE = { costPct: 10, heap: 0.85, queued: 1048576 };
var NAMES = ['normal', 'shed', 'survive'];
// The most of the main thread that answering DevTools may take, by level.
var SHARE = [0.3, 0.15, 0.05];

var level = 0;
var listeners = [];
var calm = 0;
var fullTicks = 0;
var timer = 0;
var last = 0;
var perf = typeof performance !== 'undefined' && performance ? performance : null;

function heapRatio() {
  var m = perf && perf.memory;
  return m && m.jsHeapSizeLimit ? m.usedJSHeapSize / m.jsHeapSizeLimit : 0;
}

function decide(costPct, queued, heap) {
  if (costPct >= SURVIVE.costPct) return [2, 'the inspector used ' + costPct.toFixed(1) + '% of the main thread'];
  if (heap >= SURVIVE.heap) return [2, 'the JS heap is at ' + Math.round(heap * 100) + '% of its limit'];
  if (queued >= SURVIVE.queued) return [2, Math.round(queued / 1024) + ' KB are queued for the laptop'];
  if (costPct >= SHED.costPct) return [1, 'the inspector used ' + costPct.toFixed(1) + '% of the main thread'];
  if (heap >= SHED.heap) return [1, 'the JS heap is at ' + Math.round(heap * 100) + '% of its limit'];
  if (fullTicks >= SHED.queuedTicks) return [1, 'the link to the laptop has been full for ' + fullTicks + ' s'];
  return [0, ''];
}

function set(next, why) {
  if (next === level) return;
  level = next;
  cx.stats.level = level;
  R.setDetail(level);
  for (var i = 0; i < listeners.length; i++) cx.attempt(listeners[i], level);
  cx.send({ method: 'teleport.governor', params: { level: level, reason: why } });
  var text = level
    ? 'teleport: ' + NAMES[level] + ' mode, because ' + why + '. ' + (level === 1 ? 'Previews are shorter and logged objects are not kept.' : 'Console and network reporting are paused.')
    : 'teleport: back to full detail.';
  cx.send({ method: 'Runtime.consoleAPICalled', params: { type: level ? 'warning' : 'info', args: [{ type: 'string', value: text }], executionContextId: 1, timestamp: Date.now() } });
}

var tickCb = cx.guard(tick);

function tick() {
  // Scheduled first: if anything below fails on an odd engine, the governor still ticks.
  timer = setTimeout(tickCb, TICK_MS);
  var t = cx.ms();
  var span = t - last;
  last = t;
  var s = cx.stats;
  var costPct = span > 0 ? (100 * s.workMs) / span : 0;
  var hookPct = span > 0 ? (100 * s.hookMs) / span : 0;
  var queued = cx.buffered();
  s.buffered = queued;
  cx.newTick();
  fullTicks = queued > cx.HIGH ? fullTicks + 1 : 0;
  var d = decide(hookPct, queued, heapRatio());
  if (d[0] > level) {
    calm = 0;
    set(d[0], d[1]);
  } else if (d[0] < level && ++calm >= CALM_S) {
    calm = 0;
    set(level - 1, '');
  } else if (d[0] === level) {
    calm = 0;
  }
  // teleport.mark, in short.
  cx.send([9, t, queued, costPct, level, s.droppedConsole, s.droppedNet]);
  if (hook) hook();
  // The tick's own time is the inspector's too.
  cx.work(t);
}

// The page-driven work of this second passed its budget before the tick came.
cx.onOverBudget(function (ms) {
  if (!timer) return;
  calm = 0;
  set(2, 'the inspector used ' + Math.round(ms) + ' ms of one second reporting what the page did');
});

var hook = null;
/** Runs fn at each tick, after the mark. */
exports.onTick = function (fn) {
  hook = fn;
};

exports.start = function () {
  if (timer) return;
  last = cx.ms();
  timer = setTimeout(tickCb, TICK_MS);
};

exports.stop = function () {
  clearTimeout(timer);
  timer = 0;
  level = 0;
  calm = fullTicks = 0;
  cx.stats.level = 0;
  R.setDetail(0);
};

exports.level = function () {
  return level;
};

/** Registers fn(level), called at each change of level. */
exports.onLevel = function (fn) {
  listeners.push(fn);
};

/** The most of the main thread that answering DevTools may take now, 0 to 1. */
exports.share = function () {
  return SHARE[level];
};
