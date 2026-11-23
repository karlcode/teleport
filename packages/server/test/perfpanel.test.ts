import { describe, expect, it } from 'vitest';
import { emptyTimeline } from '../src/analyze.js';
import { devtoolsTrace } from '../src/perfpanel.js';
import { medianPhases } from '../src/session.js';

describe("DevTools' Performance panel from the agent's records", () => {
  const tl = () => {
    const t = emptyTimeline();
    Object.assign(t.input!, { t: [1000, 2000], keyCode: [39, 37], toFrameMs: [9, 30] });
    // Key 1 probed in full; key 2's handlers never ended (propagation stopped and no next task).
    Object.assign(t.keyphase!, {
      t: [1000, 2000],
      inputDelay: [2, 1], handlers: [3, -1], waitFrame: [6, -1], raf: [1, -1], style: [4, -1], layout: [5, -1], paint: [7, -1],
    });
    return t;
  };
  const trace = () => devtoolsTrace({ timeline: tl(), from: 0, to: 5000, names: [], network: [], offsetMs: 0, href: 'http://device/' });
  const x = (name: string) => trace().filter((e) => e.name === name && e.ph === 'X');

  it('draws a probed key as a handler task and a frame with style, layout and paint inside it', () => {
    expect(x('EventDispatch').map((e) => [e.ts, e.dur])).toEqual([[1_000_000, 3000]]);
    const frameStart = (1000 + 3 + 6) * 1000;
    expect(x('FireAnimationFrame').map((e) => [e.ts, e.dur])).toEqual([[frameStart, 1000]]);
    expect(x('UpdateLayoutTree').map((e) => [e.ts, e.dur])).toEqual([[frameStart + 1000, 4000]]);
    expect(x('Layout').map((e) => [e.ts, e.dur])).toEqual([[frameStart + 5000, 5000]]);
    expect(x('Paint').map((e) => [e.ts, e.dur])).toEqual([[frameStart + 10000, 7000]]);
    expect(x('RunTask').map((e) => [e.ts, e.dur])).toContainEqual([frameStart, 17000]);
  });

  it('gives the interaction its input delay and processing time, and falls back to key → frame', () => {
    const begins = trace().filter((e) => e.name === 'EventTiming' && e.ph === 'b').map((e) => (e.args as { data: Record<string, number> }).data);
    expect(begins[0]).toMatchObject({ timeStamp: 998, processingStart: 1000, processingEnd: 1003, duration: 28 });
    expect(begins[1]).toMatchObject({ timeStamp: 1999, processingStart: 2000, processingEnd: 2000, duration: 31 });
  });

  it('lays out the tracks the panel needs: a renderer main thread, a frame and a compositor', () => {
    const names = trace().map((e) => e.name);
    for (const n of ['TracingStartedInBrowser', 'SetLayerTreeId', 'thread_name', 'process_name']) expect(names).toContain(n);
  });

  it('takes medians per phase and leaves unmeasured phases empty', () => {
    const a = { inputDelay: 1, handlers: 2, waitFrame: 3, raf: 0, style: 1, layout: 2, paint: 9 };
    const b = { ...a, handlers: 4, paint: null };
    expect(medianPhases([a, b])).toMatchObject({ handlers: 3, paint: 9 });
    expect(medianPhases([{ ...b, paint: null }])!.paint).toBeNull();
    expect(medianPhases([])).toBeNull();
  });
});
