// `import teleport from '@tlpt/agent'` puts teleport's agent in the build, asleep: no buffers, timers
// or sockets. Nothing outside the app wakes it: not the page's address, not its storage, not the
// kind of build. The app does, in its own code, behind whatever switch it likes:
//
//   teleport.init({ url: 'ws://192.168.1.20:7070/ws/target' })   the teleport at that address
//   teleport.init()                                              the one that served this page
//
// With no address the agent looks only at where the page itself came from. A page from this machine
// or a private network address reports to teleport there, on port 7070 (or window.TELEPORT_PORT).
// A page from anywhere else, such as the app's own tunnel, or any https page (which can open only a
// secure socket), reports to its own address under /__teleport/, which the dev server passes on to
// teleport. A page that came from no host (a file, a packaged app) has none to find and stays asleep.
//
// So the agent runs code for one of two hosts: the one the app named, or the one that served the
// app. A link someone crafted can't pick it. (An earlier form woke on `?tlpt=<address>` in any
// build, which let anyone on the same network who could get the page opened run script in it.)
//
// This runs inside the app's bundle, so nothing in it may throw: an odd address, a `window.teleport`
// of the app's own, or an engine the agent can't load on all leave the agent asleep, and the app
// carries on as if it weren't there.
var PORT = 7070;
var LOCAL = /^(localhost|127(\.\d+){3}|10(\.\d+){3}|192\.168(\.\d+){2}|172\.(1[6-9]|2\d|3[01])(\.\d+){2}|[\w-]+\.local)$/;

// What the app gets if the agent itself fails to load: the same calls, asleep.
var asleep = {
  version: '',
  init: idle,
  stop: idle,
  status: function () {
    return { running: false, overheadPct: 0, selfMs: 0 };
  }
};

function idle() {
  return asleep;
}

// try/catch lives only in these helpers.
function load() {
  try {
    return require('./index.js');
  } catch (e) {
    return asleep;
  }
}

function attempt(fn, a) {
  try {
    return fn(a);
  } catch (e) {
    return undefined;
  }
}

var agent = load();

/** teleport's relay on the host that served this page, or null when no host did. */
function home(w) {
  var host = location.hostname;
  if (!host) return null;
  var secure = location.protocol === 'https:';
  if (secure || !LOCAL.test(host)) return (secure ? 'wss' : 'ws') + '://' + location.host + '/__teleport/ws/target';
  return 'ws://' + host + ':' + (w.TELEPORT_PORT || PORT) + '/ws/target';
}

// Another agent already running here keeps the page, such as the one teleport injects. Asking is
// the app's code when the object is the app's, so a status() that throws counts as no agent.
function otherRuns(other) {
  return typeof other.status === 'function' && other.status().running === true;
}

function start(opts) {
  var w = /** @type {any} */ (window);
  var other = w.teleport && w.teleport !== agent && w.teleport !== teleport ? w.teleport : null;
  if (other && attempt(otherRuns, other)) return;
  var url = opts && opts.url ? String(opts.url) : home(w);
  if (url) agent.init({ url: url, badge: opts ? opts.badge : undefined });
}

var teleport = {
  version: agent.version,
  init: function (opts) {
    attempt(start, opts);
    return teleport;
  },
  stop: function () {
    agent.stop();
    return teleport;
  },
  status: function () {
    return agent.status();
  }
};

// The page's `teleport` is this one too, so a switch flipped from a console does the same as the app's.
function publish(w) {
  if (w.teleport === agent) w.teleport = teleport;
}

if (typeof window !== 'undefined') attempt(publish, window);

module.exports = teleport;
