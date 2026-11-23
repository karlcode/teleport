import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { decodeFrame, DecodeError, HEADER_BYTES, MAGIC, STREAMS, STREAM_HEADER_BYTES } from '../src/index.js';

const require = createRequire(import.meta.url);
const ring = require('../../agent/src/ring.js');
const enc = require('../../agent/src/encode.js');
const S = require('../../agent/src/generated/schema.js');

function overheadRing(cap: number) {
  return ring.createRing(cap, S.S_OVERHEAD_TYPES);
}
function push(r: any, t: number, work: number, win: number) {
  const i = ring.ringNext(r);
  r.t[i] = t;
  r.cols[0][i] = work;
  r.cols[1][i] = win;
}
function frameBytes(e: any, len: number) {
  return new Uint8Array(e.buf, 0, len).slice();
}

describe('codec', () => {
  it('agent constants match the protocol package', () => {
    expect(S.MAGIC).toBe(MAGIC);
    expect(S.HEADER_BYTES).toBe(HEADER_BYTES);
    expect(S.STREAM_HEADER_BYTES).toBe(STREAM_HEADER_BYTES);
    expect(STREAMS[S.S_OVERHEAD].id).toBe(S.S_OVERHEAD_ID);
    expect(STREAMS[S.S_OVERHEAD].recordBytes).toBe(S.S_OVERHEAD_BYTES);
  });

  it('round-trips records, sequence numbers and drop counts', () => {
    const r = overheadRing(8);
    push(r, 1000.5, 0.25, 1000);
    push(r, 2000.25, 1.5, 1000);
    const e = enc.createEncoder(1024);
    const rings = [r];
    const len = enc.encodeFrame(e, rings);
    const f = decodeFrame(frameBytes(e, len));
    expect(f.seq).toBe(0);
    expect(f.baseTime).toBe(1000.5);
    expect(f.streams).toHaveLength(1);
    const s = f.streams[0];
    expect(s.name).toBe('overhead');
    expect(s.count).toBe(2);
    expect(s.dropped).toBe(0);
    expect(Array.from(s.columns.t)).toEqual([1000.5, 2000.25]);
    expect(Array.from(s.columns.workMs)).toEqual([0.25, 1.5]);
    expect(Array.from(s.columns.windowMs)).toEqual([1000, 1000]);
    expect(r.unsent).toBe(0);

    push(r, 3000, 2, 1000);
    const f2 = decodeFrame(frameBytes(e, enc.encodeFrame(e, rings)));
    expect(f2.seq).toBe(1);
    expect(Array.from(f2.streams[0].columns.t)).toEqual([3000]);
  });

  it('reports cumulative drops', () => {
    const r = overheadRing(2);
    for (let k = 0; k < 5; k++) push(r, k, k, 1);
    const e = enc.createEncoder(1024);
    const f = decodeFrame(frameBytes(e, enc.encodeFrame(e, [r])));
    expect(f.streams[0].dropped).toBe(3);
    expect(Array.from(f.streams[0].columns.t)).toEqual([3, 4]);
  });

  it('leaves out a stream with nothing pending, so a quiet second is just the header', () => {
    const e = enc.createEncoder(64);
    const len = enc.encodeFrame(e, [overheadRing(4)]);
    expect(len).toBe(HEADER_BYTES);
    const f = decodeFrame(frameBytes(e, len));
    expect(f.streams).toEqual([]);
  });

  it('sends only what fits and leaves the rest unsent', () => {
    const r = overheadRing(16);
    for (let k = 0; k < 10; k++) push(r, k, k, 1);
    const fits = 3;
    const e = enc.createEncoder(HEADER_BYTES + STREAM_HEADER_BYTES + fits * S.S_OVERHEAD_BYTES);
    const f = decodeFrame(frameBytes(e, enc.encodeFrame(e, [r])));
    expect(f.streams[0].count).toBe(fits);
    expect(r.unsent).toBe(10 - fits);
    expect(Array.from(f.streams[0].columns.t)).toEqual([0, 1, 2]);
  });

  it('handles records that wrap around the ring end', () => {
    const r = overheadRing(4);
    for (let k = 0; k < 4; k++) push(r, k, k, 1);
    ring.ringMarkSent(r, 3);
    push(r, 4, 4, 1);
    push(r, 5, 5, 1);
    const e = enc.createEncoder(1024);
    const f = decodeFrame(frameBytes(e, enc.encodeFrame(e, [r])));
    expect(Array.from(f.streams[0].columns.t)).toEqual([3, 4, 5]);
  });

  it('rejects bad magic, unknown versions, unknown streams and truncation', () => {
    const r = overheadRing(4);
    push(r, 1, 1, 1);
    const e = enc.createEncoder(1024);
    const good = frameBytes(e, enc.encodeFrame(e, [r]));

    const badMagic = good.slice();
    badMagic[0] ^= 0xff;
    expect(() => decodeFrame(badMagic)).toThrow(DecodeError);

    const badVersion = good.slice();
    badVersion[2] = 99;
    expect(() => decodeFrame(badVersion)).toThrow(/version/);

    const badStream = good.slice();
    badStream[HEADER_BYTES] = 250;
    expect(() => decodeFrame(badStream)).toThrow(/stream/);

    expect(() => decodeFrame(good.slice(0, good.length - 1))).toThrow(/truncated/);
    expect(() => decodeFrame(good.slice(0, 4))).toThrow(/truncated/);
  });
});
