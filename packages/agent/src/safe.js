'use strict';
// Nothing teleport does on the device may throw into the app: not into its call stack, not to its
// window.onerror, not to its error reporting (Sentry and the like). Everything of the agent's that
// the page calls back (timers, socket events, listeners, frames, observers) goes through guard(),
// and everything that may fail on an odd engine through safely().
// try/catch lives only in these two helpers, so the functions they call stay optimisable on old V8,
// which never optimises a function that holds a try/catch.

/** Calls fn(a, b, c). False if it threw, which is then forgotten. */
function safely(fn, a, b, c) {
  try {
    fn(a, b, c);
    return true;
  } catch (e) {
    return false;
  }
}

/** fn as a callback for the page to call: the same this and first argument, and it never throws. */
function guard(fn) {
  return function (arg) {
    try {
      fn.call(this, arg);
    } catch (e) {
      // teleport's own failure: the page never hears of it.
    }
  };
}

exports.safely = safely;
exports.guard = guard;
