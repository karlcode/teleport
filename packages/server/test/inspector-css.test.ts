// The inspector's CSS matcher runs on the device; here it runs in Node against a fake document, so the
// selector prefilter is held to the engine's own answer: it may skip selectors, never drop a match.
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

interface FakeEl {
  tagName: string;
  id: string;
  classList: { contains(c: string): boolean };
  matches(sel: string): boolean;
  getAttribute(name: string): string | null;
  parentRule?: undefined;
}

/** An element that matches the selectors it is told to, like the engine would. */
function el(tag: string, id: string, classes: string[], matching: string[]): FakeEl {
  return {
    tagName: tag.toUpperCase(),
    id,
    classList: { contains: (c) => classes.includes(c) },
    matches: (sel) => matching.includes(sel),
    getAttribute: (n) => (n === 'class' ? classes.join(' ') : null),
  };
}

const style = { length: 0, getPropertyValue: () => '', getPropertyPriority: () => '' };
const rule = (selectorText: string) => ({ type: 1, selectorText, style, parentRule: null });

describe("the inspector's selector prefilter", () => {
  let css: { refresh(): void; matching(el: FakeEl): { i: number; matching: number[] }[]; keyOf(sel: string): { id: string | null; cls: string | null; tag: string | null } };
  const sheet = { cssRules: [] as unknown[], disabled: false, href: '', ownerNode: null };
  const g = globalThis as Record<string, unknown>;
  const had = { document: g.document, window: g.window };

  beforeAll(() => {
    g.document = { styleSheets: [sheet] };
    g.window = {};
    css = require('../../inspector/src/css.js');
  });
  afterAll(() => {
    g.document = had.document;
    g.window = had.window;
  });

  it('keys a selector on what its rightmost compound demands of the element', () => {
    const key = (id: string | null, cls: string | null, tag: string | null) => ({ id, cls, tag });
    expect(css.keyOf('#rail .tile')).toEqual(key(null, 'tile', null));
    expect(css.keyOf('.rail > li#first')).toEqual(key('first', null, 'LI'));
    expect(css.keyOf('.a:not(.b)')).toEqual(key(null, 'a', null));
    expect(css.keyOf('ul li[data-x=".fake"]')).toEqual(key(null, null, 'LI'));
    expect(css.keyOf('span.tile')).toEqual(key(null, 'tile', 'SPAN'));
    expect(css.keyOf('.tile::before')).toEqual(key(null, 'tile', null));
    expect(css.keyOf('*')).toEqual(key(null, null, null));
    expect(css.keyOf('[hidden]')).toEqual(key(null, null, null));
    expect(css.keyOf(':focus')).toEqual(key(null, null, null));
    expect(css.keyOf('.we\\:ird')).toEqual(key(null, null, null));
    expect(css.keyOf('svg path')).toEqual(key(null, null, 'PATH'));
  });

  it('finds every rule the engine says matches, in cascade order, and asks it about fewer', () => {
    const selectors = ['.tile', '#rail .tile.focused', 'div', '*', '.other', '#nope', 'li', '[data-focused]', '.tile:not(.off)', 'span.tile', '.a, .tile, .b'];
    sheet.cssRules = selectors.map(rule);
    // A div.tile.focused inside #rail with data-focused set: the engine says these match.
    const yes = ['.tile', '#rail .tile.focused', 'div', '*', '[data-focused]', '.tile:not(.off)'];
    let asked = 0;
    const tile = el('div', '', ['tile', 'focused'], yes);
    const engine = tile.matches;
    tile.matches = (sel) => (asked++, engine(sel));
    css.refresh();
    const hits = css.matching(tile);
    const matchedSelectors = hits.flatMap((h) => h.matching.map((k) => selectors[h.i]!.split(', ')[k]!));
    expect(new Set(matchedSelectors)).toEqual(new Set(yes));
    // Never asked about #nope, li, .other, .a, .b or span.tile: their keys ruled them out. The
    // `.tile` inside the group is asked once more, as its own selector.
    expect(asked).toBe(yes.length + 1);
    // Cascade order: specificity ascending, then document order.
    expect(hits.map((h) => selectors[h.i])).toEqual(['*', 'div', '.tile', '[data-focused]', '.a, .tile, .b', '.tile:not(.off)', '#rail .tile.focused']);
  });

  it('matches by tag however the engine spells it, and by class without classList', () => {
    sheet.cssRules = [rule('path'), rule('.glyph')];
    css.refresh();
    const svgPath = { ...el('path', '', ['glyph'], ['path', '.glyph']), tagName: 'path', classList: undefined as unknown as FakeEl['classList'] };
    expect(css.matching(svgPath).map((h) => h.i)).toEqual([0, 1]);
  });
});
