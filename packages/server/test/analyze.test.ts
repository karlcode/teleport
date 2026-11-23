import { describe, expect, it } from 'vitest';
import { emptyTimeline, report } from '../src/analyze.js';

function timeline() {
  const tl = emptyTimeline();
  // 60 frames at 16 ms, then one 50 ms frame, inside [0, 2000).
  for (let i = 0; i < 60; i++) tl.frame!.t!.push(100 + i * 16);
  tl.frame!.t!.push(100 + 59 * 16 + 50);
  tl.longtask!.t!.push(500, 900);
  tl.longtask!.durMs!.push(60, 120);
  tl.input!.t!.push(300, 600, 700);
  tl.input!.keyCode!.push(39, 39, 13);
  tl.input!.toFrameMs!.push(10, 30, -1);
  for (let s = 0; s < 3; s++) {
    tl.video!.t!.push(s * 1000);
    tl.video!.el!.push(0);
    tl.video!.decoded!.push(s * 25);
    tl.video!.dropped!.push(s * 5);
    tl.heap!.t!.push(s * 1000);
    tl.heap!.used!.push((10 + s) * 1048576);
    tl.heap!.total!.push(32 * 1048576);
    tl.overhead!.t!.push(s * 1000);
    tl.overhead!.workMs!.push(1);
    tl.overhead!.windowMs!.push(1000);
    tl.lag!.t!.push(s * 1000);
    tl.lag!.lagMs!.push(s * 2);
  }
  tl.resource!.t!.push(50, 80);
  tl.resource!.durMs!.push(200, 20);
  tl.resource!.ttfbMs!.push(150, -1);
  tl.resource!.bytes!.push(1000, 24);
  tl.resource!.name!.push(0, 1);
  tl.resource!.kind!.push(2, 6);
  return tl;
}

describe('report', () => {
  it('keeps the capture’s raw vsync record: frame times, long tasks and presses, from its start', () => {
    const v = report(timeline(), 0, 2001).vsync!;
    expect(v.frames).toHaveLength(61);
    expect(v.frames.slice(0, 2)).toEqual([100, 116]);
    expect(v.tasks).toEqual([[500, 60], [900, 120]]);
    expect(v.keys).toEqual([300, 600, 700]);
    expect(report(timeline(), 5000, 6000).vsync).toBeNull();
  });

  const r = report(timeline(), 0, 2001, ['http://device/app.js', 'http://device/items.json']);

  it('derives frame timing from raw rAF timestamps', () => {
    expect(r.frames!.count).toBe(61);
    expect(r.frames!.p50Ms).toBe(16);
    expect(r.frames!.maxMs).toBe(50);
    expect(r.frames!.over33Ms).toBe(1);
    expect(r.frames!.over50Ms).toBe(0);
  });

  it('sums long tasks and keeps keys that never saw a frame apart', () => {
    expect(r.longTasks).toMatchObject({ count: 2, totalMs: 180, maxMs: 120 });
    expect(r.input).toMatchObject({ keys: 3, maxMs: 30, noFrame: 1 });
  });

  it('turns cumulative video counters into rates', () => {
    expect(r.video).toEqual([{ el: 0, decodedPerS: 25, droppedPerS: 5, dropPct: 16.67 }]);
  });

  it('reports heap trend, agent overhead and the slowest resources by name', () => {
    expect(r.heap).toMatchObject({ usedMB: 12, minMB: 10, maxMB: 12, mbPerMin: 60 });
    expect(r.overhead!.pct).toBe(0.1);
    expect(r.resources.slowest[0]).toEqual({ name: 'http://device/app.js', durMs: 200, ttfbMs: 150 });
    expect(r.resources.slowest[1]!.ttfbMs).toBeNull();
  });

  it('only counts records inside the window', () => {
    const early = report(timeline(), 0, 400);
    expect(early.longTasks.count).toBe(0);
    expect(early.input!.keys).toBe(1);
  });
});
