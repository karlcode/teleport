// Plain ES5 smoke test that runs the agent's ring + encoder on old V8 (Node 0.12 / 4.x) where
// Vitest cannot run. Usage: node packages/agent/test-es5/run.js
'use strict';
var assert = require('assert');
var S = require('../src/generated/schema.js');
var ring = require('../src/ring.js');
var enc = require('../src/encode.js');

var failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log('ok   ' + name);
  } catch (e) {
    failures++;
    console.log('FAIL ' + name + '\n     ' + (e && e.stack ? e.stack : e));
  }
}

function push(r, t, a, b) {
  var i = ring.ringNext(r);
  r.t[i] = t;
  r.cols[0][i] = a;
  r.cols[1][i] = b;
}

test('ring overwrites oldest and counts drops', function () {
  var r = ring.createRing(3, S.S_OVERHEAD_TYPES);
  for (var k = 1; k <= 5; k++) push(r, k, k, k);
  assert.strictEqual(r.size, 3);
  assert.strictEqual(r.unsent, 3);
  assert.strictEqual(r.dropped, 2);
  assert.strictEqual(r.t[ring.ringUnsentStart(r)], 3);
});

test('encoder writes header, stream header and records', function () {
  var r = ring.createRing(8, S.S_OVERHEAD_TYPES);
  push(r, 1000.5, 0.25, 1000);
  push(r, 2000.25, 1.5, 1000);
  var e = enc.createEncoder(256);
  var len = enc.encodeFrame(e, [r]);
  assert.strictEqual(len, S.HEADER_BYTES + S.STREAM_HEADER_BYTES + 2 * S.S_OVERHEAD_BYTES);
  var v = new DataView(e.buf);
  assert.strictEqual(v.getUint16(0, true), S.MAGIC);
  assert.strictEqual(v.getUint8(2), S.VERSION);
  assert.strictEqual(v.getFloat64(8, true), 1000.5);
  var o = S.HEADER_BYTES;
  assert.strictEqual(v.getUint8(o), S.S_OVERHEAD_ID);
  assert.strictEqual(v.getUint16(o + 2, true), 2);
  o += S.STREAM_HEADER_BYTES;
  assert.strictEqual(v.getFloat32(o, true), 0);
  assert.strictEqual(v.getFloat32(o + 4, true), 0.25);
  assert.strictEqual(v.getFloat32(o + 12, true), 999.75);
  assert.strictEqual(r.unsent, 0);
});

test('hot push loop stays stable (run with --trace-deopt to inspect)', function () {
  var r = ring.createRing(1024, S.S_OVERHEAD_TYPES);
  for (var k = 0; k < 200000; k++) push(r, k, k & 7, 1);
  assert.strictEqual(r.total, 200000);
  assert.strictEqual(r.dropped, 200000 - 1024);
});

console.log(failures ? failures + ' failure(s)' : 'all passed (node ' + process.version + ')');
process.exit(failures ? 1 : 0);
