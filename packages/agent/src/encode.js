'use strict';
// Encodes pending ring records into one reusable ArrayBuffer. Layout is defined by
// packages/protocol/schema.json; rings[k] must match the schema stream with index k.

var S = require('./generated/schema.js');
var ringStart = require('./ring.js').ringUnsentStart;

var IDS = S.STREAM_IDS;
var RECORD_BYTES = S.STREAM_RECORD_BYTES;
var MAX_COUNT = 65535;

// `positions` false writes version 2 frames, without stream positions, for a server older than them.
function createEncoder(maxBytes) {
  var buf = new ArrayBuffer(maxBytes);
  return { buf: buf, view: new DataView(buf), seq: 0, positions: true };
}

function writeValue(v, o, type, x) {
  if (type === S.T_F32) v.setFloat32(o, x, true);
  else if (type === S.T_F64) v.setFloat64(o, x, true);
  else if (type === S.T_U32) v.setUint32(o, x, true);
  else if (type === S.T_U16) v.setUint16(o, x, true);
  else v.setUint8(o, x);
}

function typeBytes(type) {
  return type === S.T_F64 ? 8 : type === S.T_U8 ? 1 : type === S.T_U16 ? 2 : 4;
}

// Returns the frame length in bytes. Records that do not fit stay unsent for the next frame.
// Streams with nothing pending are left out: the decoder finds each by its id, and a quiet second
// then costs a few dozen bytes on the wire, not a header per stream.
function encodeFrame(e, rings) {
  var v = e.view;
  var n = rings.length;
  var k, r, i, j, c, o, count;

  // baseTime: oldest pending timestamp, so record offsets are small and non-negative.
  var base = 0;
  var haveBase = false;
  for (k = 0; k < n; k++) {
    r = rings[k];
    if (r.unsent > 0) {
      var t0 = r.t[ringStart(r)];
      if (!haveBase || t0 < base) base = t0;
      haveBase = true;
    }
  }

  var streamHeader = e.positions ? S.STREAM_HEADER_BYTES : S.STREAM_HEADER_BYTES - 4;
  v.setUint16(0, S.MAGIC, true);
  v.setUint8(2, e.positions ? S.VERSION : S.VERSION - 1);
  v.setUint32(4, e.seq, true);
  v.setFloat64(8, base, true);
  o = S.HEADER_BYTES;
  var written = 0;

  for (k = 0; k < n; k++) {
    r = rings[k];
    if (r.unsent === 0) continue;
    written++;
    var rb = RECORD_BYTES[k];
    var room = Math.floor((e.buf.byteLength - o - streamHeader) / rb);
    count = r.unsent;
    if (count > room) count = room < 0 ? 0 : room;
    if (count > MAX_COUNT) count = MAX_COUNT;

    v.setUint8(o, IDS[k]);
    v.setUint8(o + 1, 0);
    v.setUint16(o + 2, count, true);
    v.setUint32(o + 4, r.dropped, true);
    // Position of the first record sent here: a resend repeats it, so the server takes it once.
    if (e.positions) v.setUint32(o + 8, r.total - r.unsent, true);
    o += streamHeader;

    i = ringStart(r);
    for (j = 0; j < count; j++) {
      v.setFloat32(o, r.t[i] - base, true);
      o += 4;
      for (c = 0; c < r.cols.length; c++) {
        writeValue(v, o, r.types[c], r.cols[c][i]);
        o += typeBytes(r.types[c]);
      }
      i = i + 1 === r.cap ? 0 : i + 1;
    }
    r.unsent -= count;
  }
  v.setUint8(3, written);

  e.seq = (e.seq + 1) >>> 0;
  return o;
}

exports.createEncoder = createEncoder;
exports.encodeFrame = encodeFrame;
