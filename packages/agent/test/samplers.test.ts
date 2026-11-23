// The agent's samplers run on the device; here they run in Node against a fake window and document, so
// the key path (the one that runs inside every remote key press) is held to what it must do and to
// what it must not cost: one selector query per focus move, never one per key.
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

type Listener = (e: { keyCode: number; timeStamp: number }) => void;

interface FakeEl {
  tagName: string;
  id: string;
  className: string;
  parentNode: FakeEl | null;
  matches(sel: string): boolean;
  contains(other: FakeEl): boolean;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
}

function element(tagName: string, id: string, className: string, parentNode: FakeEl | null): FakeEl {
  const self: FakeEl = {
    tagName,
    id,
    className,
    parentNode,
    // `.a,.b,[x]` matches when one of the class selectors names a class this element has.
    matches: (sel) => sel.split(',').some((s) => s.trim().startsWith('.') && self.className.split(' ').includes(s.trim().slice(1))),
    contains: (other) => {
      for (let n: FakeEl | null = other; n; n = n.parentNode) if (n === self) return true;
      return false;
    },
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 200, height: 300 }),
  };
  return self;
}

describe("the agent's key path", () => {
  const g = globalThis as Record<string, unknown>;
  const had = { window: g.window, document: g.document };
  const listeners: Record<string, Listener[]> = {};
  const frames: (() => void)[] = [];
  let queries = 0;
  const html = element('HTML', '', '', null);
  const body = element('BODY', '', '', html);
  const rail = element('DIV', 'rail', '', body);
  const tiles = [element('DIV', '', 'tile focused', rail), element('DIV', '', 'tile', rail)];
  let focusedTile = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let samplers: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let S: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ring: any;
  const names: string[] = [];
  let work = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rings: any[];

  beforeAll(() => {
    g.window = {
      addEventListener: (type: string, fn: Listener) => (listeners[type] ??= []).push(fn),
      removeEventListener: () => {},
      requestAnimationFrame: (fn: () => void) => frames.push(fn),
      getComputedStyle: () => ({ zIndex: 'auto' }),
      Element: { prototype: { matches: function (this: FakeEl, sel: string) { return this.matches(sel); } } },
    };
    g.document = {
      documentElement: { ...html, contains: () => true },
      body: { ...body, offsetHeight: 1080 },
      activeElement: body,
      querySelector: (sel: string) => {
        queries++;
        return sel.includes('.focused') ? tiles[focusedTile] : null;
      },
      getElementsByTagName: () => [],
    };
    S = require('../src/generated/schema.js');
    ring = require('../src/ring.js');
    samplers = require('../src/samplers.js');
    rings = S.STREAM_TYPES.map((types: number[]) => ring.createRing(16, types));
    samplers.start(rings, (ms: number) => (work += ms), (_id: number, name: string) => names.push(name));
  });

  it('does nothing for a key while no laptop is connected: no frame, no lookup', () => {
    press(39, -100);
    expect(frames).toHaveLength(0);
    expect(queries).toBe(0);
    expect(rings[S.S_INPUT].size).toBe(0);
    samplers.setLive(true);
  });
  afterAll(() => {
    samplers.stop();
    g.window = had.window;
    g.document = had.document;
  });

  const press = (keyCode: number, t: number) => {
    for (const fn of listeners.keydown ?? []) fn({ keyCode, timeStamp: t });
  };
  const frame = () => {
    const due = frames.splice(0);
    for (const fn of due) fn();
  };

  it('records a key, the frame after it and the element that had focus, naming it once', () => {
    press(39, 0);
    expect(queries).toBe(1);
    frame();
    samplers.tick(1000);
    const input = rings[S.S_INPUT];
    expect(input.size).toBe(1);
    expect(input.cols[0][0]).toBe(39);
    expect(input.cols[1][0]).toBeGreaterThanOrEqual(0);
    const target = rings[S.S_KEYTARGET];
    expect(target.size).toBe(1);
    expect(names).toEqual(['div.tile in #rail']);
    expect(target.cols[4][0]).toBe(200);
  });

  it('asks the document for the focused element again only when the last one lost the class', () => {
    press(39, 1100);
    frame();
    // The tile that had focus still carries the class: no query at all.
    expect(queries).toBe(1);
    tiles[0]!.className = 'tile';
    tiles[1]!.className = 'tile focused';
    focusedTile = 1;
    press(39, 1200);
    frame();
    expect(queries).toBe(2);
    samplers.tick(2000);
    expect(rings[S.S_KEYTARGET].size).toBe(3);
  });

  it("charges its own time to the agent's overhead and nothing throws without a frame", () => {
    press(40, 2100);
    samplers.tick(4000);
    // A key no frame followed is written with no frame time.
    const input = rings[S.S_INPUT];
    expect(input.cols[1][input.size - 1]).toBe(-1);
    expect(work).toBeGreaterThanOrEqual(0);
  });
});
