'use strict';
// The laptop's questions. `eval <id> <0|1> <source>` runs the source in the page's global scope and
// answers with the value alone, as JSON:
//   val <id> <json>    its value; nothing after the id when it has no JSON (undefined, a function,
//                      NaN, an object that can't be written)
//   thr <id> <text>    it threw, or the promise it gave was rejected: the error's first line
// With 1 a promise is waited for. This is all a question costs the page: no inspector is loaded for
// it and nothing is watched. The code is the laptop's, so its time is the page's and is not counted
// as the agent's. What it throws is answered, never thrown into the app.
//
// A question runs once, whatever the link does. The last few answers are kept: when the link comes
// back they are sent again (the laptop takes each once, by its id), and a question that arrives a
// second time, because the laptop never heard its answer, is answered from what was kept and not run
// again.
var safe = require('./safe.js');

// Called by another name it is an indirect eval: the source runs in the global scope, not this one.
var globalEval = eval;
var send = null;
var threw = false;
var caught;
// The last KEPT questions, oldest first: each id, and its answer once there is one.
var KEPT = 8;
var KEPT_CHARS = 65536;
var ids = [];
var lines = [];
var chars = 0;

function keep(id, line) {
  var i = ids.lastIndexOf(id);
  if (i < 0) return;
  // An answer too long to keep is still sent; asked again, the laptop is told it was lost.
  lines[i] = line.length > KEPT_CHARS ? 'thr ' + id + ' the answer was lost with the link, and was too long to keep' : line;
  chars += lines[i].length;
  while (chars > KEPT_CHARS && ids.length > 1) drop();
}

function drop() {
  ids.shift();
  var l = lines.shift();
  if (l) chars -= l.length;
}

function say(id, line) {
  keep(id, line);
  send(line);
}

function run(src) {
  threw = false;
  try {
    return globalEval(src);
  } catch (e) {
    threw = true;
    caught = e;
    return undefined;
  }
}

function json(v) {
  try {
    var s = JSON.stringify(v);
    return typeof s === 'string' ? s : '';
  } catch (e) {
    return '';
  }
}

// What was thrown may be anything, even a value that throws when read.
function firstLine(e) {
  try {
    var s = e && typeof e === 'object' ? e.stack || e.name + ': ' + e.message : '';
    return typeof s === 'string' ? s.split('\n')[0] : '';
  } catch (x) {
    return '';
  }
}

function thenable(v) {
  try {
    return !!v && typeof v.then === 'function';
  } catch (e) {
    return false;
  }
}

function answer(id, v) {
  // JSON has no NaN, infinity or -0, and would write them as another value.
  var none = typeof v === 'number' && (v !== v || v === Infinity || v === -Infinity || (v === 0 && 1 / v < 0));
  say(id, 'val ' + id + ' ' + (none ? '' : json(v)));
}

function refuse(id, e) {
  say(id, 'thr ' + id + ' ' + firstLine(e));
}

function later(id, p) {
  try {
    p.then(
      safe.guard(function (x) {
        answer(id, x);
      }),
      safe.guard(function (e) {
        refuse(id, e);
      })
    );
  } catch (e) {
    refuse(id, e);
  }
}

/** arg is `<id> <0|1> <source>`; sendText sends one line to the laptop. */
exports.ask = function (arg, sendText) {
  send = sendText;
  var at = arg.indexOf(' ');
  if (at < 1) return;
  var id = arg.slice(0, at);
  var had = ids.lastIndexOf(id);
  if (had >= 0) {
    // Asked before: its answer again, or nothing yet while its promise is still out.
    if (lines[had]) send(lines[had]);
    return;
  }
  ids.push(id);
  lines.push('');
  if (ids.length > KEPT) drop();
  var v = run(arg.slice(at + 3));
  if (threw) {
    var e = caught;
    caught = undefined;
    refuse(id, e);
  } else if (arg.charAt(at + 1) === '1' && thenable(v)) later(id, v);
  else answer(id, v);
};

/** The link is back: the kept answers go again, in case one was lost with it. */
exports.again = function (sendText) {
  send = sendText;
  for (var i = 0; i < lines.length; i++) if (lines[i]) send(lines[i]);
};

