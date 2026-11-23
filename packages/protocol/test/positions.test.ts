import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { decodeFrame, HEADER_BYTES, MAGIC, Positions, STREAMS } from '../src/index.js';

const require = createRequire(import.meta.url);
const ring = require('../../agent/src/ring.js');
const enc = require('../../agent/src/encode.js');
const S = require('../../agent/src/generated/schema.js');

function push(r: any, t: number) {
  const i = ring.ringNext(r);
  r.t[i] = t;
  r.cols[0][i] = t / 1000;
  r.cols[1][i] = 1000;
}
const bytes = (e: any, len: number) => new Uint8Array(e.buf, 0, len).slice();
const times = (f: ReturnType<typeof decodeFrame>) => Array.from(f.streams[0]!.columns.t!);

describe('stream positions', () => {
  it('say where each frame starts in its stream', () => {
    const r = ring.createRing(8, S.S_OVERHEAD_TYPES);
    const e = enc.createEncoder(1024);
    for (let k = 1; k <= 3; k++) push(r, k * 1000);
    expect(decodeFrame(bytes(e, enc.encodeFrame(e, [r]))).streams[0]).toMatchObject({ first: 0, count: 3 });
    push(r, 4000);
    push(r, 5000);
    expect(decodeFrame(bytes(e, enc.encodeFrame(e, [r]))).streams[0]).toMatchObject({ first: 3, count: 2 });
  });

  it('take a record sent twice once, and count those that never arrived', () => {
    const r = ring.createRing(16, S.S_OVERHEAD_TYPES);
    const e = enc.createEncoder(1024);
    const p = new Positions();
    for (let k = 1; k <= 3; k++) push(r, k * 1000);
    expect(times(p.admit(decodeFrame(bytes(e, enc.encodeFrame(e, [r])))))).toEqual([1000, 2000, 3000]);
    // A reconnect: the agent is told the server has 2 records, though 3 went out, and resends from there.
    push(r, 4000);
    r.unsent = 3;
    const again = p.admit(decodeFrame(bytes(e, enc.encodeFrame(e, [r]))));
    expect(times(again)).toEqual([4000]);
    expect(again.streams[0]!.count).toBe(1);
    // Records 5 and 6 are lost on the way; 7 arrives.
    push(r, 5000);
    push(r, 6000);
    enc.encodeFrame(e, [r]);
    push(r, 7000);
    expect(times(p.admit(decodeFrame(bytes(e, enc.encodeFrame(e, [r])))))).toEqual([7000]);
    expect(p.missed(S.S_OVERHEAD_ID)).toBe(2);
    expect(p.at(S.S_OVERHEAD_ID)).toBe(7);
  });

  it('start wherever a page already is, counting nothing missed before the first frame', () => {
    const r = ring.createRing(4, S.S_OVERHEAD_TYPES);
    const e = enc.createEncoder(1024);
    for (let k = 1; k <= 3; k++) push(r, k * 1000);
    enc.encodeFrame(e, [r]);
    const p = new Positions();
    expect(p.list()).toBeNull();
    push(r, 4000);
    expect(times(p.admit(decodeFrame(bytes(e, enc.encodeFrame(e, [r])))))).toEqual([4000]);
    expect(p.missed(S.S_OVERHEAD_ID)).toBe(0);
  });

  it('still read a frame from an agent older than positions (version 2)', () => {
    const def = STREAMS[S.S_LAG]!;
    const v = new DataView(new ArrayBuffer(HEADER_BYTES + 8 + def.recordBytes));
    v.setUint16(0, MAGIC, true);
    v.setUint8(2, 2);
    v.setUint8(3, 1);
    v.setUint32(4, 7, true);
    v.setFloat64(8, 500, true);
    v.setUint8(HEADER_BYTES, def.id);
    v.setUint16(HEADER_BYTES + 2, 1, true);
    v.setUint32(HEADER_BYTES + 4, 3, true);
    v.setFloat32(HEADER_BYTES + 8, 10, true);
    v.setFloat32(HEADER_BYTES + 12, 42, true);
    const f = decodeFrame(v);
    expect(f.version).toBe(2);
    expect(f.streams[0]).toMatchObject({ name: 'lag', count: 1, dropped: 3, first: null });
    expect(Array.from(f.streams[0]!.columns.lagMs!)).toEqual([42]);
    const p = new Positions();
    expect(p.admit(f).streams[0]!.count).toBe(1);
    expect(p.admit(f).streams[0]!.count).toBe(1);
  });
});
