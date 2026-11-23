'use strict';
// Shared plumbing: the method table every domain registers into, and the outbox.
//
// The outbox keeps a slow link from filling the device's memory. Replies and small events always go
// out, because DevTools is waiting on them. Console and Network events go through fixed lanes:
// while ws.bufferedAmount is over HIGH, or the link is down, they queue, and when a lane is full new
// messages are only counted. DOM changes are held by dom.js as a set of dirty nodes, read again when the link drains,
// so DevTools' copy of the tree stays exact without queueing every batch.
//
// Nothing the inspector does may throw into the page: not into the app's call stack (the console,
// XHR and fetch it wraps), not to its window.onerror or unhandledrejection, and so not to its error
// reporting. Everything the page calls back goes through guard(), and what may fail on an odd engine
// or an odd value through attempt(). try/catch lives only in these small helpers, so the functions
// they call stay optimisable on old V8.

/** fn(a, b, c), or undefined if it threw, which is then forgotten. */
function attempt(fn, a, b, c) {
  try {
    return fn(a, b, c);
  } catch (e) {
    return undefined;
  }
}

/** fn as a callback for the page to call: the same this and first argument, and it never throws. */
function guard(fn) {
  return function (arg) {
    try {
      fn.call(this, arg);
    } catch (e) {
      // The inspector's own failure: the page never hears of it.
    }
  };
}

// Odd values (a BigInt, an object that can't be serialised) and sockets in odd states can't throw.
function json(msg) {
  try {
    return JSON.stringify(msg);
  } catch (e) {
    return null;
  }
}

function sendRaw(s) {
  try {
    ws.send(s);
  } catch (e) {
    // Closed between the readyState check and the call.
  }
}

// The link to the laptop outlives its socket (packages/server/src/link.ts). Every message sent is
// numbered and kept until the server acknowledges it, so one sent into a socket that was already
// dead goes again on the next. Nothing goes out on a new socket until the server says what it got.
// What one task sends goes out as one WebSocket message, a line each: a send costs the device about as
// much as serializing a console message, however small the message.

var handlers = {};
var ws = null;

// Returned by a handler that replies later through reply()/fail().
var ASYNC = {};

var HIGH = 65536;
var LOW = 16384;
var DRAIN_MS = 100;
// Most sent messages kept for the server to acknowledge, and their total length. It acknowledges
// every second, so these only fill while the link is down; then the oldest go first.
var KEEP_MAX = 512;
var KEEP_CHARS = 1048576;

var sent = 0;
var keep = [];
var keepChars = 0;
var acked = 0;
// Messages received from the server, and the count last acknowledged to it.
var got = 0;
var gotAcked = 0;
// The server has said, on this socket, how much it got.
var linked = false;
// Messages sent in this task, sent together when it ends.
var batch = [];
var batchChars = 0;
var batchQueued = false;

function lane(cap) {
  return { cap: cap, items: [], dropped: 0 };
}
// While the link is down the console lane is what survives the outage, so it holds more. What the
// page threw, and what it logged as an error, has a lane of its own that a flood of logs can't fill
// and that the governor never closes: when the device is struggling is when those matter.
var lanes = { errors: lane(32), console: lane(256), net: lane(128) };
// Errors let through this second while the governor has console reporting stopped.
var URGENT_PER_TICK = 10;
var urgent = 0;
var drainers = [];
var drainTimer = 0;

var perf = typeof performance !== 'undefined' && performance && typeof performance.now === 'function' ? performance : null;

// Same clock as the agent's (clock.js), so marks line up with its records on the laptop.
function ms() {
  return perf ? perf.now() : Date.now();
}

// workMs is all of the inspector's main-thread time this second. hookMs is the part the page
// drives (its logs, DOM changes and requests, and sending them): the governor sheds on that, since
// only shedding lowers it. The rest is answering DevTools, which index.js paces instead.
var stats = { buffered: 0, workMs: 0, hookMs: 0, costMs: 0, level: 0, droppedConsole: 0, droppedNet: 0 };
// Page-driven work in one second past which the governor is told at once, not at its next tick.
var TRIP_MS = 100;
var overBudget = null;

function work(t0) {
  var d = ms() - t0;
  stats.workMs += d;
  stats.hookMs += d;
  if (stats.hookMs > TRIP_MS && stats.level < 2 && overBudget) overBudget(stats.hookMs);
}

function buffered() {
  return (ws ? ws.bufferedAmount : 0) + batchChars;
}

function open() {
  return ws && ws.readyState === 1 && linked;
}

function congested() {
  return buffered() > HIGH;
}

// Adds one message to this task's batch.
function transmit(s) {
  batch.push(s);
  batchChars += s.length;
  if (batchQueued) return;
  batchQueued = true;
  // After the task that filled it, on every engine.
  setTimeout(flushCb, 0);
}

// Numbers, keeps and sends the batch as one message. While the link is down it is only kept.
function flushBatch() {
  batchQueued = false;
  if (!batch.length) return;
  var t0 = ms();
  var s = batch.length === 1 ? batch[0] : batch.join('\n');
  batch = [];
  batchChars = 0;
  sent++;
  keep.push(s);
  keepChars += s.length;
  while (keep.length > KEEP_MAX || (keepChars > KEEP_CHARS && keep.length > 1)) keepChars -= keep.shift().length;
  if (open()) sendRaw(s);
  work(t0);
}

var flushCb = guard(flushBatch);

function send(msg) {
  var s = json(msg);
  if (s !== null) transmit(s);
}

// Forgets kept messages the server has.
function trim(theirGot) {
  if (theirGot <= acked) return;
  acked = theirGot < sent ? theirGot : sent;
  var drop = acked - (sent - keep.length);
  while (drop-- > 0 && keep.length) keepChars -= keep.shift().length;
}

// Some of what the inspector sends is short for something the laptop already has: a rule's
// declarations it was sent before, a computed style as the values that changed since the last one
// (css.js). That holds only while the laptop has received every message in order. Each such message
// carries the epoch it was written in. A new epoch starts whenever the laptop may have missed one or
// let go of what it had, and its first messages say everything again.
var epoch = 1;
var epochers = [];

function newEpoch() {
  epoch++;
  for (var i = 0; i < epochers.length; i++) attempt(epochers[i]);
}

// The server's first word on a socket: how many of ours it got, and whether it still had the link.
// A server without it (teleport restarted) numbers from 1 again, and gets everything still kept.
// Messages it never got that are no longer kept (the link was down for longer than `keep` holds) are
// a gap: the server is told how many, so its count stays in step with this one, before anything else.
function onLinked(theirGot, kept) {
  if (kept) {
    trim(theirGot);
    var gap = sent - keep.length - theirGot;
    if (gap > 0) {
      acked = sent - keep.length;
      sendRaw('{"teleport":"gap","lost":' + gap + '}');
      newEpoch();
    }
  } else {
    got = gotAcked = 0;
    sent = keep.length;
    acked = 0;
    newEpoch();
  }
  linked = true;
  for (var i = 0; i < keep.length; i++) sendRaw(keep[i]);
  schedule();
}

function laneOf(method, asError) {
  if (method.lastIndexOf('Network.', 0) === 0) return lanes.net;
  if (method === 'Runtime.exceptionThrown' || asError) return lanes.errors;
  if (method === 'Runtime.consoleAPICalled') return lanes.console;
  return null;
}

var drainCb = guard(drain);

function schedule() {
  if (!drainTimer) drainTimer = setTimeout(drainCb, DRAIN_MS);
}

function flushLane(l) {
  while (l.items.length && !congested()) transmit(l.items.shift());
}

function drain() {
  drainTimer = 0;
  if (!open()) return;
  var t0 = ms();
  for (var i = 0; i < drainers.length && !congested(); i++) drainers[i]();
  if (!congested()) flushLane(lanes.errors);
  if (!congested()) flushLane(lanes.console);
  if (!congested()) flushLane(lanes.net);
  var pending = lanes.errors.items.length || lanes.console.items.length || lanes.net.items.length || buffered() > LOW;
  if (!pending) {
    for (i = 0; i < drainers.length; i++) if (drainers[i].pending()) pending = true;
  }
  if (pending) schedule();
  else reportDrops();
  work(t0);
}

function reportDrops() {
  var c = lanes.console.dropped + lanes.errors.dropped;
  var n = lanes.net.dropped;
  if (!c && !n) return;
  lanes.console.dropped = lanes.net.dropped = lanes.errors.dropped = 0;
  send({
    method: 'Runtime.consoleAPICalled',
    params: {
      type: 'warning',
      args: [{ type: 'string', value: 'teleport: the link to the laptop was full or down, so ' + c + ' console messages and ' + n + ' network events were dropped on the device.' }],
      executionContextId: 1,
      timestamp: Date.now()
    }
  });
}

/** Whether a message for this lane would be kept. Lets callers skip serializing what would be dropped. */
function accepting(name) {
  var l = lanes[name];
  if (l === lanes.errors && stats.level >= 2 && urgent >= URGENT_PER_TICK) return false;
  return open() && !congested() && !l.items.length ? true : l.items.length < l.cap;
}

// Sends msg through lane l, or at once when l is null.
function through(l, msg) {
  // The governor's stop is for the page's chatter. A few errors a second still go.
  var stopped = stats.level >= 2 && (l !== lanes.errors || ++urgent > URGENT_PER_TICK);
  if (!l || (open() && !l.items.length && !congested() && !stopped)) return send(msg);
  if (l.items.length >= l.cap || stopped) {
    l.dropped++;
    if (l === lanes.net) stats.droppedNet++;
    else stats.droppedConsole++;
  } else {
    var s = json(msg);
    if (s !== null) l.items.push(s);
  }
  schedule();
}

// asError: an error the page logged, which goes with what it threw.
function emit(method, params, asError) {
  through(laneOf(method, asError), { method: method, params: params });
}

exports.ASYNC = ASYNC;
exports.attempt = attempt;
exports.guard = guard;
exports.handlers = handlers;
exports.FRAME_ID = 'main';
exports.HIGH = HIGH;
exports.stats = stats;
exports.ms = ms;
exports.work = work;
exports.buffered = buffered;
exports.congested = congested;
exports.accepting = accepting;
exports.schedule = schedule;

exports.setSocket = function (s) {
  ws = s;
  linked = false;
};

exports.linked = onLinked;
exports.trim = trim;
exports.received = function () {
  got++;
};
exports.got = function () {
  return got;
};
/** Tells the server how many of its messages arrived, when that changed. */
exports.ack = function () {
  if (got === gotAcked || !ws || ws.readyState !== 1) return;
  gotAcked = got;
  sendRaw('{"teleport":"ack","got":' + got + '}');
};

/** Registers fn, called when the link drains. fn.pending() says whether it still has work. */
exports.onDrain = function (fn) {
  drainers.push(fn);
};

/** Time spent answering DevTools: counted in the inspector's cost, but nothing shedding would lower. */
exports.asked = function (d) {
  stats.workMs += d;
};

/** fn(ms) runs when the page-driven work of this second passes the budget. */
exports.onOverBudget = function (fn) {
  overBudget = fn;
};

/** A new second for the governor: what it read is cleared. */
exports.newTick = function () {
  stats.costMs = stats.workMs;
  stats.workMs = stats.hookMs = 0;
  urgent = 0;
};

exports.reset = function () {
  newEpoch();
  lanes.errors.items = [];
  lanes.console.items = [];
  lanes.net.items = [];
  lanes.console.dropped = lanes.net.dropped = lanes.errors.dropped = 0;
  urgent = 0;
  clearTimeout(drainTimer);
  drainTimer = 0;
};

// Origin of the teleport server the inspector came from. Requests to it are recorded by the server
// itself, so the page doesn't spend time reporting them.
exports.server = '';

exports.on = function (table) {
  for (var k in table) handlers[k] = table[k];
};

exports.emit = emit;

// The short forms (packages/server/src/expand.ts turns each back into the protocol's message). They
// are arrays of numbers and strings, written by the engine's own JSON.stringify: on a slow engine
// that is several times cheaper than any encoder written in script, and a quarter of the bytes of
// the protocol's shape, measured with the optimising compilers off.

/** A short event through a lane: 'console', 'errors' or 'net'. What a lane drops must stand alone. */
exports.brief = function (laneName, msg) {
  through(lanes[laneName], msg);
};

/** A short reply. Returns ASYNC, so a handler can end with it. */
exports.answer = function (msg) {
  send(msg);
  return ASYNC;
};

exports.epoch = function () {
  return epoch;
};
exports.newEpoch = newEpoch;
/** fn runs when a new epoch starts: whatever was sent in short is forgotten. */
exports.onEpoch = function (fn) {
  epochers.push(fn);
};

/** Counts a console message the caller chose not to serialize. */
exports.dropConsole = function () {
  lanes.console.dropped++;
  stats.droppedConsole++;
  schedule();
};
exports.send = send;

// A result that can't be serialised (a BigInt in a by-value result, say) is answered with an error,
// so the caller isn't left waiting.
exports.reply = function (id, result) {
  var s = json({ id: id, result: result });
  transmit(s !== null ? s : json({ id: id, error: { code: -32000, message: 'teleport: the result could not be serialised' } }));
};

exports.fail = function (id, message) {
  send({ id: id, error: { code: -32000, message: message } });
};

exports.unknown = function (id, method) {
  send({ id: id, error: { code: -32601, message: "'" + method + "' wasn't found" } });
};

// CDP timestamps are monotonic seconds.
exports.now = function () {
  return ms() / 1000;
};

exports.origin = function () {
  return location.origin || location.protocol + '//' + location.host;
};
