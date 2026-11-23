'use strict';
var cx = require('./cx.js');

// XHR and fetch are wrapped only between Network.enable and detach. Response bodies go in a
// fixed ring (BODY_CAP entries, each at most BODY_MAX chars); older bodies are dropped.
// Requests that finished before DevTools opened come from Resource Timing, without bodies.
// Requests to the teleport server itself are skipped: the server records those, bodies included.
//
// The wrappers run inside the app's own calls, so they keep out of its way: the app's call always
// reaches the method it had, with the same this and arguments, and returns or throws just what that
// does. What the inspector notes on the side goes through cx.attempt(), and is skipped if it fails.

var BODY_CAP = 64;
var BODY_MAX = 1 << 20;
// Only bodies of these types are read for DevTools. A media segment or an image fetched by the app
// is never cloned and decoded: on a device that would double its memory for nothing DevTools can show.
var TEXTISH = /^\s*(text\/|application\/(json|javascript|ecmascript|xml|xhtml\+xml|x-www-form-urlencoded|[\w.-]+\+(json|xml)))/i;
var REQ = '__teleportReq';
var LIVE_TYPES = { xmlhttprequest: 1, fetch: 1 };
var RT_TYPES = { script: 'Script', link: 'Stylesheet', css: 'Stylesheet', img: 'Image', image: 'Image', video: 'Media', audio: 'Media', iframe: 'Document', navigation: 'Document' };

var enabled = false;
var seq = 0;
var bodyIds = new Array(BODY_CAP);
var bodies = new Array(BODY_CAP);
var bodyNext = 0;
// What enable() replaced (orig) and what it put there (mine), to put back on detach.
var orig = null;
var mine = null;
// Bumped by each enable(). A wrapper from an earlier one, which something else wrapped over so that
// detach left it in place, only passes calls on: it isn't the current one.
var gen = 0;
var observer = null;
var anchor = null;

function absolute(url) {
  if (!anchor) anchor = document.createElement('a');
  anchor.href = url;
  return anchor.href;
}

function served(url) {
  return cx.server !== '' && url.indexOf(cx.server + '/') === 0;
}

function keepBody(id, text) {
  if (typeof text !== 'string' || text.length > BODY_MAX) return;
  var i = bodyNext++ % BODY_CAP;
  bodyIds[i] = id;
  bodies[i] = text;
}

function parseHeaders(raw) {
  var out = {};
  var lines = raw.split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var at = lines[i].indexOf(':');
    if (at > 0) out[lines[i].slice(0, at)] = lines[i].slice(at + 1).replace(/^\s+/, '');
  }
  return out;
}

// The Network events, in short. Each stands alone, since the lane may drop any of them, and leaves
// out what never varies (the loader, the frame, the priority): expand.ts puts that back.
//   [6, id, method, url, headers, body or 0, type, timestamp, wall time, the document's URL]
//   [7, id, url, status, status text, headers, type, size, timestamp]   response and finished
//   [8, id, type, error text, timestamp]                                failed
function willBeSent(id, method, url, headers, body, type, ts) {
  cx.brief('net', [6, id, method, url, headers, typeof body === 'string' ? body : 0, type, ts, Date.now() / 1000, location.href]);
}

function finished(id, url, status, statusText, headers, type, size, ts) {
  cx.brief('net', [7, id, url, status, statusText, headers, type, size, ts]);
}

function failed(id, type, text) {
  cx.brief('net', [8, id, type, text, cx.now()]);
}

function onXhrEnd() {
  var r = this[REQ];
  if (!r || !enabled) return;
  this[REQ] = null;
  if (this.status === 0) return failed(r.id, 'XHR', 'net::ERR_FAILED');
  var t = this.responseType;
  var text = t === '' || t === 'text' ? this.responseText : t === 'json' ? JSON.stringify(this.response) : null;
  keepBody(r.id, text);
  finished(r.id, r.url, this.status, this.statusText, parseHeaders(this.getAllResponseHeaders()), 'XHR', text ? text.length : 0, cx.now());
}

var xhrEnded = cx.guard(onXhrEnd);

// The request's record rides on the app's XHR, not enumerable, so the app's own code never sees it.
function noteOpen(xhr, method, url) {
  var r = { id: '', method: String(method).toUpperCase(), url: absolute(String(url)), headers: {} };
  Object.defineProperty(xhr, REQ, { value: r, writable: true, configurable: true });
}

function noteHeader(xhr, k, v) {
  var r = xhr[REQ];
  if (r) r.headers[k] = v;
}

function noteSend(xhr, body) {
  var r = xhr[REQ];
  if (!r || served(r.url)) return;
  r.id = 'x' + ++seq;
  willBeSent(r.id, r.method, r.url, r.headers, body, 'XHR', cx.now());
  xhr.addEventListener('loadend', xhrEnded);
}

function wrapXhr() {
  var P = XMLHttpRequest.prototype;
  var g = gen;
  var open = (orig.open = P.open);
  var send = (orig.send = P.send);
  var setRequestHeader = (orig.setRequestHeader = P.setRequestHeader);
  P.open = mine.open = function (method, url) {
    if (enabled && g === gen) cx.attempt(noteOpen, this, method, url);
    return open.apply(this, arguments);
  };
  P.setRequestHeader = mine.setRequestHeader = function (k, v) {
    if (enabled && g === gen) cx.attempt(noteHeader, this, k, v);
    return setRequestHeader.apply(this, arguments);
  };
  // Noted before the call: a synchronous request ends inside it.
  P.send = mine.send = function (body) {
    if (enabled && g === gen) cx.attempt(noteSend, this, body);
    return send.apply(this, arguments);
  };
}

function fetchHeaders(h) {
  var out = {};
  if (h && typeof h.forEach === 'function') {
    h.forEach(function (v, name) {
      out[name] = v;
    });
  } else if (h) {
    for (var k in h) out[k] = h[k];
  }
  return out;
}

// Whether a response's body is worth reading for DevTools: text-like, and not known to be over the cap.
function bodyWanted(headers) {
  var type = '';
  var len = -1;
  for (var k in headers) {
    var lk = k.toLowerCase();
    if (lk === 'content-type') type = headers[k];
    else if (lk === 'content-length') len = +headers[k];
  }
  return TEXTISH.test(type) && !(len > BODY_MAX);
}

/** The request the app just started, as { id, url } for its outcome, or null if DevTools doesn't see it. */
function noteFetch(input, init) {
  var isReq = input && typeof input === 'object' && 'url' in input;
  var url = absolute(isReq ? input.url : String(input));
  if (served(url)) return null;
  var id = 'f' + ++seq;
  var method = String((init && init.method) || (isReq && input.method) || 'GET').toUpperCase();
  willBeSent(id, method, url, fetchHeaders((init && init.headers) || (isReq && input.headers)), init && init.body, 'Fetch', cx.now());
  return { id: id, url: url };
}

function fetched(r, res) {
  var headers = fetchHeaders(res.headers);
  var done = function (size) {
    finished(r.id, res.url || r.url, res.status, res.statusText, headers, 'Fetch', size, cx.now());
  };
  if (!bodyWanted(headers) || typeof res.clone !== 'function') return done(0);
  res
    .clone()
    .text()
    .then(
      cx.guard(function (text) {
        keepBody(r.id, text);
        done(text.length);
      }),
      cx.guard(function () {
        done(0);
      })
    );
}

function fetchFailed(r, e) {
  failed(r.id, 'Fetch', String(e && e.message ? e.message : e));
}

// The app gets its own promise back, the very object, so whatever it or its other wrappers put on it
// (a cancel(), a subclass) stays. The outcome is noted on the side. The cost: while the Network panel
// is open, a failed request the app leaves unhandled counts as handled, so its unhandledrejection
// doesn't fire then. Handing back a different promise instead could break the app.
function follow(p, r) {
  p.then(
    function (res) {
      cx.attempt(fetched, r, res);
    },
    function (e) {
      cx.attempt(fetchFailed, r, e);
    }
  );
}

function track(p, input, init) {
  if (!p || typeof p.then !== 'function') return p;
  var r = noteFetch(input, init);
  if (r) follow(p, r);
  return p;
}

// The app's fetch runs first, untouched; what it returns or throws is the app's.
function wrapFetch() {
  var g = gen;
  var fetch = (orig.fetch = window.fetch);
  window.fetch = mine.fetch = function (input, init) {
    var p = fetch.apply(this, arguments);
    return enabled && g === gen ? cx.attempt(track, p, input, init) || p : p;
  };
}

function replayEntry(e) {
  if (LIVE_TYPES[e.initiatorType] === 1 || served(e.name)) return;
  var id = 't' + ++seq;
  var type = RT_TYPES[e.initiatorType] || 'Other';
  var status = typeof e.responseStatus === 'number' ? e.responseStatus : 0;
  willBeSent(id, 'GET', e.name, {}, null, type, e.startTime / 1000);
  finished(id, e.name, status, status ? '' : '(unknown: from Resource Timing)', {}, type, e.transferSize || 0, e.responseEnd / 1000);
}

function replayTimings() {
  var p = window.performance;
  if (!p || typeof p.getEntriesByType !== 'function') return;
  var nav = p.getEntriesByType('navigation');
  var list = p.getEntriesByType('resource');
  var i;
  for (i = 0; i < nav.length; i++) replayEntry(nav[i]);
  for (i = 0; i < list.length; i++) replayEntry(list[i]);
}

function onEntries(entries) {
  var list = entries.getEntries();
  for (var i = 0; i < list.length; i++) replayEntry(list[i]);
}

function observeResources() {
  var o = new PerformanceObserver(cx.guard(onEntries));
  o.observe({ entryTypes: ['resource'] });
  observer = o;
}

function enable() {
  if (enabled) return;
  enabled = true;
  gen++;
  orig = {};
  mine = {};
  if (typeof XMLHttpRequest === 'function' || typeof XMLHttpRequest === 'object') cx.attempt(wrapXhr);
  if (typeof window.fetch === 'function') cx.attempt(wrapFetch);
  cx.attempt(replayTimings);
  if (typeof window.PerformanceObserver === 'function') cx.attempt(observeResources);
}

// Each method goes back only if ours is still the one there: something that wrapped it since (an
// error reporter, say) keeps its wrapper, and ours inside it passes calls straight on.
function restore(target, name) {
  if (orig[name] && target[name] === mine[name]) target[name] = orig[name];
}

exports.detach = function () {
  if (!enabled) return;
  enabled = false;
  if (typeof XMLHttpRequest !== 'undefined') {
    var P = XMLHttpRequest.prototype;
    cx.attempt(restore, P, 'open');
    cx.attempt(restore, P, 'send');
    cx.attempt(restore, P, 'setRequestHeader');
  }
  cx.attempt(restore, window, 'fetch');
  if (observer) observer.disconnect();
  observer = null;
  for (var i = 0; i < BODY_CAP; i++) {
    bodyIds[i] = null;
    bodies[i] = null;
  }
};

cx.on({
  'Network.enable': function () {
    enable();
    return {};
  },
  'Network.disable': function () {
    exports.detach();
    return {};
  },
  'Network.getResponseBody': function (p, id) {
    for (var i = 0; i < BODY_CAP; i++) {
      if (bodyIds[i] === p.requestId) return { body: bodies[i], base64Encoded: false };
    }
    cx.fail(id, 'No body kept for this request (finished before DevTools opened, binary, over 1 MB, or evicted)');
    return cx.ASYNC;
  }
});
