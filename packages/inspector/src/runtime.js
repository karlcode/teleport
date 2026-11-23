'use strict';
var cx = require('./cx.js');
var R = require('./remote.js');
var dom = require('./dom.js');
var gov = require('./governor.js');

// Indirect eval runs in global scope, so `var x = 1` typed in the console persists like in Chrome.
var globalEval = (0, eval);
var CONTEXT_ID = 1;
// DevTools has enabled Runtime since the last detach.
var enabled = false;
var FN_CACHE_MAX = 64;

// Console methods DevTools renders, mapped to Runtime.consoleAPICalled types.
var CONSOLE_TYPES = {
  log: 'log', info: 'info', warn: 'warning', error: 'error', debug: 'debug', dir: 'dir',
  dirxml: 'dirxml', table: 'table', trace: 'trace', clear: 'clear', group: 'startGroup',
  groupCollapsed: 'startGroupCollapsed', groupEnd: 'endGroup', assert: 'assert'
};

// Expressions that only read names and members. Eager preview and autocomplete send these with
// throwOnSideEffect; anything else is refused rather than run on every keystroke.
var READ_ONLY = /^[\s\w$.]*(\[\s*(\d+|'[^']*'|"[^"]*")\s*\][\s\w$.]*)*$/;
var USES_API = /\$|\bkeys\s*\(|\bvalues\s*\(/;

var installed = false;
var originals = {};
var wrappers = {};
var reporting = false;
var exceptionId = 0;
var fnCache = {};
var fnCacheSize = 0;
var withApi = null;
var threw = false;
var caught;

function $(sel, root) {
  return (root || document).querySelector(sel);
}

function $$(sel, root) {
  return Array.prototype.slice.call((root || document).querySelectorAll(sel));
}

function values(o) {
  var k = Object.keys(o);
  var out = [];
  for (var i = 0; i < k.length; i++) out.push(o[k[i]]);
  return out;
}

function run(src, api) {
  threw = false;
  try {
    if (api && USES_API.test(src)) {
      if (!withApi) withApi = new Function('$0', '$', '$$', 'keys', 'values', '__teleportExpr', 'return eval(__teleportExpr)');
      return withApi(dom.inspected(), $, $$, Object.keys, values, src);
    }
    return globalEval(src);
  } catch (e) {
    threw = true;
    caught = e;
  }
}

function apply(fn, self, args) {
  threw = false;
  try {
    return fn.apply(self, args);
  } catch (e) {
    threw = true;
    caught = e;
  }
}

function compile(decl) {
  var fn = fnCache[decl];
  if (fn) return fn;
  fn = run('(' + decl + ')', false);
  if (threw || typeof fn !== 'function') return null;
  if (fnCacheSize >= FN_CACHE_MAX) {
    fnCache = {};
    fnCacheSize = 0;
  }
  fnCache[decl] = fn;
  fnCacheSize++;
  return fn;
}

function details(e, text) {
  return {
    exceptionId: ++exceptionId,
    text: text || 'Uncaught',
    lineNumber: 0,
    columnNumber: 0,
    exception: R.remote(e)
  };
}

function thrown(e) {
  return { result: R.remote(e), exceptionDetails: details(e) };
}

function wrapResult(v, p) {
  return { result: p.returnByValue ? R.byValue(v) : R.remote(v, p.generatePreview) };
}

function resolved(id, p, x) {
  cx.reply(id, wrapResult(x, p));
  return true;
}

function rejected(id, e) {
  cx.reply(id, thrown(e));
  return true;
}

// The callbacks can't throw: one that did would leave a rejected promise nobody handles, which the
// page's unhandledrejection (and its error reporting) would hear of. A value that can't be read is
// answered with an error, so DevTools isn't left waiting.
function settle(id, v, p) {
  if (!p.awaitPromise || !v || typeof v.then !== 'function') return wrapResult(v, p);
  v.then(
    cx.guard(function (x) {
      if (!cx.attempt(resolved, id, p, x)) cx.fail(id, 'teleport: the value could not be read');
    }),
    cx.guard(function (e) {
      if (!cx.attempt(rejected, id, e)) cx.fail(id, 'teleport: the rejection could not be read');
    })
  );
  return cx.ASYNC;
}

function sideEffectRefused() {
  var e = new EvalError('Possible side-effect in debug-evaluate');
  return thrown(e);
}

// Called through cx.attempt() by the console wrappers: R.remote reads the app's values, and a
// revoked Proxy, a host object or one of the app's getters may throw there.
function report(type, args, from) {
  // What the app logs as an error goes with what it threw: kept while the rest is stopped.
  var urgent = type === 'error' || type === 'assert';
  if (!cx.accepting(urgent ? 'errors' : 'console') || (gov.level() >= 2 && !urgent)) {
    cx.dropConsole();
    return;
  }
  var t0 = cx.ms();
  // Runtime.consoleAPICalled, in short: [1, type, timestamp, argument, ...] (see R.brief).
  var out = [1, type, Date.now()];
  R.consoleStart();
  for (var i = from; i < args.length; i++) out.push(R.brief(args[i]));
  R.consoleEnd();
  cx.brief(urgent ? 'errors' : 'console', out);
  cx.work(t0);
}

// The app's own console method, with a copy of each message for DevTools. The copy is the
// inspector's business: if making it fails, the call still reaches the method the app had, with the
// same this and arguments, and returns or throws just what that does. A wrapper that is no longer
// the current one (DevTools closed, but something else had wrapped the console over it, so it was
// left in place) only passes calls on.
function makeWrapper(name, type) {
  var orig = originals[name];
  var from = type === 'assert' ? 1 : 0;
  var w = function () {
    // A console call made while teleport reads the app's values for DevTools (a Proxy's handler or a
    // getter that warns as it is read) is teleport's doing, so it reaches neither the app's console
    // nor its error reporting.
    if (reporting) return undefined;
    if (wrappers[name] === w && (!from || !arguments[0])) {
      reporting = true;
      cx.attempt(report, type, arguments, from);
      R.consoleEnd();
      reporting = false;
    }
    return orig.apply(this, arguments);
  };
  return w;
}

function onError(e) {
  var err = e.error;
  var d = {
    exceptionId: ++exceptionId,
    text: err !== undefined && err !== null ? 'Uncaught' : String(e.message),
    lineNumber: (e.lineno || 1) - 1,
    columnNumber: (e.colno || 1) - 1,
    url: e.filename || ''
  };
  if (err !== undefined && err !== null) d.exception = R.remote(err);
  cx.emit('Runtime.exceptionThrown', { timestamp: Date.now(), exceptionDetails: d });
}

function onRejection(e) {
  cx.emit('Runtime.exceptionThrown', { timestamp: Date.now(), exceptionDetails: details(e.reason, 'Uncaught (in promise)') });
}

// The page's errors are only read: neither listener stops them reaching the app's own handlers.
var errorListener = cx.guard(onError);
var rejectionListener = cx.guard(onRejection);

// Only methods the engine has are wrapped: one it lacks stays missing, as the app would find it.
function patch(name) {
  if (typeof console[name] !== 'function') return;
  originals[name] = console[name];
  wrappers[name] = makeWrapper(name, CONSOLE_TYPES[name]);
  console[name] = wrappers[name];
}

// Put back only where the wrapper is still the console's method: something that wrapped it since
// (an error reporter, say) keeps its wrapper, and ours inside it passes calls straight on.
function unpatch(name) {
  if (console[name] === wrappers[name]) console[name] = originals[name];
}

function install() {
  if (installed) return;
  installed = true;
  if (typeof console !== 'undefined' && console) {
    for (var name in CONSOLE_TYPES) cx.attempt(patch, name);
  }
  window.addEventListener('error', errorListener);
  window.addEventListener('unhandledrejection', rejectionListener);
}

exports.detach = function () {
  enabled = false;
  if (!installed) return;
  installed = false;
  for (var name in wrappers) cx.attempt(unpatch, name);
  wrappers = {};
  window.removeEventListener('error', errorListener);
  window.removeEventListener('unhandledrejection', rejectionListener);
  fnCache = {};
  fnCacheSize = 0;
  R.clear();
};


cx.on({
  'Runtime.enable': function () {
    // As in Chrome, enabling again reports nothing new: DevTools already has the context. A DevTools
    // that reconnected after teleport restarted sends it again.
    if (enabled) return {};
    enabled = true;
    install();
    cx.emit('Runtime.executionContextCreated', {
      context: {
        id: CONTEXT_ID,
        origin: cx.origin(),
        name: '',
        uniqueId: 'teleport-1',
        auxData: { isDefault: true, type: 'default', frameId: cx.FRAME_ID }
      }
    });
    return {};
  },

  'Runtime.evaluate': function (p, id) {
    if (p.throwOnSideEffect && !READ_ONLY.test(p.expression)) return sideEffectRefused();
    var v = run(p.expression, p.includeCommandLineAPI);
    return threw ? thrown(caught) : settle(id, v, p);
  },

  'Runtime.callFunctionOn': function (p, id) {
    var fn = compile(p.functionDeclaration);
    if (!fn) return thrown(caught || new SyntaxError('Could not compile function'));
    var self = p.objectId ? R.get(p.objectId) : window;
    var list = p.arguments || [];
    var args = [];
    for (var i = 0; i < list.length; i++) args.push(R.fromArg(list[i]));
    var v = apply(fn, self, args);
    return threw ? thrown(caught) : settle(id, v, p);
  },

  'Runtime.getProperties': function (p, id) {
    var o = R.get(p.objectId);
    if (o === undefined || o === null) {
      cx.fail(id, 'Could not find object with given id');
      return cx.ASYNC;
    }
    return R.properties(Object(o), p.ownProperties, p.accessorPropertiesOnly, p.generatePreview);
  },

  'Runtime.compileScript': function (p) {
    threw = false;
    try {
      new Function(p.expression);
    } catch (e) {
      return { exceptionDetails: details(e) };
    }
    return {};
  },

  'Runtime.getHeapUsage': function (p, id) {
    var m = performance && performance.memory;
    if (!m) {
      cx.fail(id, 'unavailable: performance.memory is not exposed on this engine');
      return cx.ASYNC;
    }
    return { usedSize: m.usedJSHeapSize, totalSize: m.totalJSHeapSize, embedderHeapUsedSize: 0, backingStorageSize: 0 };
  },

  'Runtime.releaseObject': function (p) {
    R.release(p.objectId);
    return {};
  },
  'Runtime.releaseObjectGroup': function (p) {
    if (p.objectGroup === 'console') R.clearConsole();
    return {};
  },
  'Runtime.discardConsoleEntries': function () {
    R.clearConsole();
    return {};
  },
  'Runtime.runIfWaitingForDebugger': function () {
    return {};
  },
  'Runtime.globalLexicalScopeNames': function () {
    return { names: [] };
  },
  'Runtime.getIsolateId': function () {
    return { id: 'teleport' };
  },
  'Runtime.addBinding': function () {
    return {};
  },
  'Debugger.enable': function () {
    return { debuggerId: 'teleport' };
  }
});
