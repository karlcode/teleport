'use strict';
// Monotonic clock: performance.now() where present, Date.now() otherwise. Both functions are
// created once at load so calling now() allocates nothing.

var perf = typeof performance !== 'undefined' && performance && typeof performance.now === 'function'
  ? performance
  : null;

function perfNow() {
  return perf.now();
}

function dateNow() {
  return Date.now();
}

exports.source = perf ? 'performance.now' : 'Date.now';
exports.now = perf ? perfNow : dateNow;
