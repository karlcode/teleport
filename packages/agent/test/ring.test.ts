import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const ring = require('../src/ring.js');
const S = require('../src/generated/schema.js');

function push(r: any, t: number, a: number, b: number) {
  const i = ring.ringNext(r);
  r.t[i] = t;
  r.cols[0][i] = a;
  r.cols[1][i] = b;
}

describe('ring buffer', () => {
  it('pre-allocates typed columns of the requested types', () => {
    const r = ring.createRing(4, [S.T_U8, S.T_U16, S.T_U32, S.T_F32, S.T_F64]);
    expect(r.t).toBeInstanceOf(Float64Array);
    expect(r.t.length).toBe(4);
    expect(r.cols.map((c: any) => c.constructor)).toEqual([
      Uint8Array, Uint16Array, Uint32Array, Float32Array, Float64Array,
    ]);
    expect(r.cols.every((c: any) => c.length === 4)).toBe(true);
  });

  it('starts empty', () => {
    const r = ring.createRing(4, [S.T_F32, S.T_F32]);
    expect([r.size, r.unsent, r.dropped, r.total]).toEqual([0, 0, 0, 0]);
  });

  it('writes sequential slots and tracks size and unsent', () => {
    const r = ring.createRing(4, [S.T_F32, S.T_F32]);
    push(r, 10, 1, 2);
    push(r, 20, 3, 4);
    expect(r.size).toBe(2);
    expect(r.unsent).toBe(2);
    expect(ring.ringUnsentStart(r)).toBe(0);
    expect(Array.from(r.t.subarray(0, 2))).toEqual([10, 20]);
  });

  it('overwrites the oldest entry when full and counts unsent losses as dropped', () => {
    const r = ring.createRing(3, [S.T_F32, S.T_F32]);
    for (let k = 1; k <= 5; k++) push(r, k, k, k);
    expect(r.size).toBe(3);
    expect(r.unsent).toBe(3);
    expect(r.dropped).toBe(2);
    expect(r.total).toBe(5);
    // Oldest surviving unsent entry is t=3.
    expect(r.t[ring.ringUnsentStart(r)]).toBe(3);
  });

  it('does not count overwriting already-sent entries as dropped', () => {
    const r = ring.createRing(3, [S.T_F32, S.T_F32]);
    for (let k = 1; k <= 3; k++) push(r, k, k, k);
    ring.ringMarkSent(r, 3);
    expect(r.unsent).toBe(0);
    push(r, 4, 4, 4);
    push(r, 5, 5, 5);
    expect(r.dropped).toBe(0);
    expect(r.unsent).toBe(2);
    expect(r.t[ring.ringUnsentStart(r)]).toBe(4);
  });

  it('wraps the unsent start index around the end', () => {
    const r = ring.createRing(4, [S.T_F32, S.T_F32]);
    for (let k = 1; k <= 6; k++) {
      push(r, k, k, k);
      if (k === 4) ring.ringMarkSent(r, 4);
    }
    expect(r.unsent).toBe(2);
    expect(ring.ringUnsentStart(r)).toBe(0);
    expect(r.t[0]).toBe(5);
  });

  it('clamps markSent to the number of unsent entries', () => {
    const r = ring.createRing(2, [S.T_F32, S.T_F32]);
    push(r, 1, 1, 1);
    ring.ringMarkSent(r, 10);
    expect(r.unsent).toBe(0);
  });

  it('keeps sent history readable for bug reports (size stays full)', () => {
    const r = ring.createRing(2, [S.T_F32, S.T_F32]);
    push(r, 1, 1, 1);
    push(r, 2, 2, 2);
    ring.ringMarkSent(r, 2);
    expect(r.size).toBe(2);
    expect(ring.ringOldest(r)).toBe(0);
    push(r, 3, 3, 3);
    expect(r.t[ring.ringOldest(r)]).toBe(2);
  });
});
