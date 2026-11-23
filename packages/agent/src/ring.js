'use strict';
// Fixed-capacity ring of records stored as one Float64Array time column plus typed value columns.
// Writers call ringNext() and fill r.t[i] / r.cols[c][i] directly, so pushing allocates nothing.
// History stays readable after sending (for bug reports); `unsent` tracks what the encoder still owes.

var S = require('./generated/schema.js');

function column(type, cap) {
  if (type === S.T_U8) return new Uint8Array(cap);
  if (type === S.T_U16) return new Uint16Array(cap);
  if (type === S.T_U32) return new Uint32Array(cap);
  if (type === S.T_F64) return new Float64Array(cap);
  return new Float32Array(cap);
}

function createRing(cap, types) {
  var cols = new Array(types.length);
  for (var c = 0; c < types.length; c++) cols[c] = column(types[c], cap);
  return {
    cap: cap,
    head: 0, // next slot to write
    size: 0, // valid entries, <= cap
    unsent: 0, // entries not yet encoded, <= cap
    dropped: 0, // cumulative unsent entries lost to overwrite
    total: 0, // cumulative pushes
    t: new Float64Array(cap),
    types: types,
    cols: cols
  };
}

// Returns the slot to write and advances the ring.
function ringNext(r) {
  var i = r.head;
  r.head = i + 1 === r.cap ? 0 : i + 1;
  if (r.size < r.cap) r.size++;
  if (r.unsent === r.cap) r.dropped++;
  else r.unsent++;
  r.total++;
  return i;
}

function ringUnsentStart(r) {
  var i = r.head - r.unsent;
  return i < 0 ? i + r.cap : i;
}

function ringOldest(r) {
  var i = r.head - r.size;
  return i < 0 ? i + r.cap : i;
}

function ringMarkSent(r, n) {
  r.unsent = n >= r.unsent ? 0 : r.unsent - n;
}

exports.createRing = createRing;
exports.ringNext = ringNext;
exports.ringUnsentStart = ringUnsentStart;
exports.ringOldest = ringOldest;
exports.ringMarkSent = ringMarkSent;
