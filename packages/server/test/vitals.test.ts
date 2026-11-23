import { describe, expect, it } from 'vitest';
import { emptyTimeline } from '../src/analyze.js';
import type { Point } from '../src/live.js';
import { alarms, heapTrend, keyName, mainWindow, presses, vitalsOf, watch, type Recording } from '../src/vitals.js';

const point = (t: number, o: Partial<Point> = {}): Point => ({
  t, overheadPct: 0.05, lagMs: 2, longTaskMs: 0, longTasks: 0, heapMB: 40, heapTotalMB: 50, videoDroppedPerS: null, videoDecodedPerS: null,
  resources: 0, resourceKB: 0, keys: 0, keyToFrameMs: null, fps: null, frameP95Ms: null, wireBytes: 90, agentQueuedKB: 0, inspectorQueuedKB: null,
  inspectorPct: null, level: 0, heapLimitMB: 512, domNodes: 400, devtoolsLagMs: null, ...o,
});

describe('what the console derives about a device', () => {
  it('names remote keys by their codes', () => {
    expect([37, 38, 39, 40, 13, 27, 166, 48, 57, 403, 999].map(keyName)).toEqual(['left', '↑', 'right', '↓', 'ok', 'back', 'back', '0', '9', 'red', '#999']);
  });

  it('lists the last presses newest first, with frame time, handler time and where focus landed', () => {
    const tl = emptyTimeline();
    Object.assign(tl.input!, { t: [100, 200, 300], keyCode: [39, 39, 40], toFrameMs: [20, -1, 183], delayMs: [1, 1, 1] });
    Object.assign(tl.keyphase!, { t: [300], inputDelay: [1], handlers: [120], waitFrame: [5], raf: [1], style: [3], layout: [9], paint: [4] });
    Object.assign(tl.keytarget!, { t: [300], target: [0], landing: [1], x: [0], y: [0], w: [10], h: [10], moved: [1] });
    const out = presses(tl, ['div.rail', 'div.tile in #rail'], 2);
    expect(out).toEqual([
      { t: 300, key: '↓', toFrameMs: 183, handlersMs: 120, target: 'div.tile in #rail' },
      { t: 200, key: 'right', toFrameMs: null, handlersMs: null, target: null },
    ]);
  });

  it("reads a heap whose floor climbs as a trend with a time to full, and ignores garbage that comes and goes", () => {
    // Floor climbs 2 MB a minute; every other sample has 30 MB of garbage on top.
    const rising = Array.from({ length: 120 }, (_, i) => point(i * 1000, { heapMB: 100 + (i / 60) * 2 + (i % 2 ? 30 : 0), heapLimitMB: 200 }));
    const t = heapTrend(rising)!;
    expect(t.mbPerMin).toBeGreaterThan(1.8);
    expect(t.mbPerMin).toBeLessThan(2.2);
    expect(t.fullInMin).toBeGreaterThan(30);
    const flat = Array.from({ length: 120 }, (_, i) => point(i * 1000, { heapMB: 100 + (i % 7) * 5 }));
    expect(Math.abs(heapTrend(flat)!.mbPerMin)).toBeLessThan(1);
    expect(heapTrend(rising.slice(0, 30))).toBeNull();
    expect(heapTrend([point(0, { heapMB: null })])).toBeNull();
  });

  it('takes the worst lag and all long-task time over the window', () => {
    const ps = [point(0, { lagMs: 300, longTaskMs: 500, longTasks: 2 }), ...Array.from({ length: 10 }, (_, i) => point(i + 1, { lagMs: i, longTaskMs: i === 5 ? 80 : 0, longTasks: i === 5 ? 1 : 0 }))];
    expect(mainWindow(ps)).toEqual({ lagMs: 9, longTaskMs: 80, longTasks: 1 });
    expect(mainWindow([point(0, { lagMs: null })])).toEqual({ lagMs: null, longTaskMs: 0, longTasks: 0 });
  });
});

/** A page's recording with these points, the last frame at `at` (epoch ms). */
function recording(points: Point[], at = 1_000_000, names: string[] = []): Recording {
  return { points, timeline: emptyTimeline(), lastFrameAt: at, meta: { rttMs: 12, names } };
}

describe('vitalsOf: a device row, derived once per sample', () => {
  it('is nothing before the first sample', () => {
    expect(vitalsOf(recording([]))).toBeNull();
  });

  it('keeps the last 16 s of blocking, the heap and its trend, the last press, video drops, the link and fps', () => {
    const ps = Array.from({ length: 120 }, (_, i) =>
      point(i * 1000, {
        lagMs: i,
        longTaskMs: i === 119 ? 300 : 0,
        heapMB: 100 + i / 30,
        heapLimitMB: 200,
        videoDecodedPerS: i > 116 ? 25 : i > 100 ? 0 : null,
        videoDroppedPerS: i > 100 ? i - 100 : null,
        agentQueuedKB: 10,
        inspectorQueuedKB: 60,
        fps: 58,
        devtoolsLagMs: 1200,
      }),
    );
    const r = recording(ps);
    Object.assign(r.timeline.input!, { t: [118_000, 119_000], keyCode: [39, 40], toFrameMs: [20, 41], delayMs: [1, 1] });
    const v = vitalsOf(r)!;
    expect(v.t).toBe(119_000);
    expect(v.blocked).toHaveLength(16);
    expect(v.blocked[0]).toBe(104);
    expect(v.blocked.at(-1)).toBe(300);
    expect(v.heapMB).toBeCloseTo(103.97, 1);
    expect(v.trend!.mbPerMin).toBeCloseTo(2, 1);
    expect(v.press).toMatchObject({ key: '↓', toFrameMs: 41 });
    // Only seconds with playback count: drops while nothing decoded are a paused video's leftovers.
    expect(v.videoDroppedPerS).toBe(19);
    expect(v).toMatchObject({ rttMs: 12, backlogKB: 70, devtoolsLagMs: 1200, fps: 58 });
  });

  it('has no video, press or backlog where the device sent none', () => {
    const v = vitalsOf(recording([point(0, { agentQueuedKB: null })]))!;
    expect(v).toMatchObject({ press: null, videoDroppedPerS: null, backlogKB: null, trend: null });
  });
});

describe('alarms: the samples worth a line in the log', () => {
  /** Feeds samples to one watch, each frame `gap` ms after the last, and returns what each raised. */
  function feed(samples: Partial<Point>[], gap = 1000) {
    const w = watch();
    const ps: Point[] = [];
    return samples.map((o, i) => {
      ps.push(point(i * 1000, o));
      const r = recording(ps, 1_000_000 + i * gap);
      return alarms(w, r, vitalsOf(r)!);
    });
  }

  it('says a stall on the first frame after 5 s without one, and why: the page blocked, or the link', () => {
    const w = watch();
    const ps = [point(0)];
    alarms(w, recording(ps, 1000), vitalsOf(recording(ps))!);
    ps.push(point(9000, { lagMs: 8900 }));
    const out = alarms(w, recording(ps, 10_000), vitalsOf(recording(ps))!);
    // The block that caused the stall is in this sample too; the stall says it, once.
    expect(out).toEqual([{ type: 'stall', gapMs: 9000, lagMs: 8900 }]);
    expect(feed([{}, {}], 4000).flat()).toEqual([]);
  });

  it('says a blocked main thread at most once in 10 s', () => {
    const out = feed([{ longTaskMs: 1380, lagMs: 1210 }, { lagMs: 1500 }, ...Array(8).fill({}), { lagMs: 1100 }]);
    expect(out[0]).toEqual([{ type: 'blocked', longTaskMs: 1380, lagMs: 1210 }]);
    expect(out[1]).toEqual([]);
    expect(out[10]).toEqual([{ type: 'blocked', longTaskMs: 0, lagMs: 1100 }]);
  });

  it('says a heap at 85% of its limit once, and again only after it falls below 75%', () => {
    const out = feed([{ heapMB: 446 }, { heapMB: 450 }, { heapMB: 400 }, { heapMB: 450 }, { heapMB: 380 }, { heapMB: 440 }]);
    expect(out.map((a) => a.map((x) => x.type))).toEqual([['heap'], [], [], [], [], ['heap']]);
    expect(out[0]![0]).toMatchObject({ mb: 446, limitMB: 512 });
  });

  it('says a slow key at most once in 30 s, with the slowest press of the second', () => {
    const w = watch();
    const ps: Point[] = [];
    const r = recording(ps, 1_000_000, ['div.tile in #rail-trending']);
    Object.assign(r.timeline.input!, { t: [500, 700], keyCode: [39, 40], toFrameMs: [90, 612], delayMs: [1, 1] });
    Object.assign(r.timeline.keyphase!, { t: [700], inputDelay: [1], handlers: [540], waitFrame: [5], raf: [1], style: [3], layout: [9], paint: [4] });
    Object.assign(r.timeline.keytarget!, { t: [700], target: [0], landing: [65535], x: [0], y: [0], w: [10], h: [10], moved: [1] });
    ps.push(point(1000, { keys: 2, keyToFrameMs: 612 }));
    expect(alarms(w, r, vitalsOf(r)!)).toEqual([{ type: 'slow-key', press: { t: 700, key: '↓', toFrameMs: 612, handlersMs: 540, target: 'div.tile in #rail-trending' } }]);
    ps.push(point(2000, { keys: 1, keyToFrameMs: 400 }));
    r.lastFrameAt += 1000;
    expect(alarms(w, r, vitalsOf(r)!)).toEqual([]);
    expect(feed([{ keys: 1, keyToFrameMs: 299 }]).flat()).toEqual([]);
  });
});
