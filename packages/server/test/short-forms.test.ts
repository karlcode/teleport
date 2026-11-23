// The inspector sends its busiest messages in short, and the laptop writes the protocol's messages
// back out of them (src/expand.ts). What comes out must be what the device used to write itself, to
// the letter. Here today's inspector and the one from before the change (test/reference) answer the
// same requests about the same page, through hundreds of random changes to it, and every answer is
// compared whole. Then the ways a short message can go missing or arrive broken: each must end in
// an error for that one request and a fresh start, never in an answer that is wrong.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Expander, splitSelectors, type Cdp } from '../src/expand.js';

const require = createRequire(import.meta.url);
const g = globalThis as Record<string, unknown>;

// A seeded generator, so a failure names a sequence that can be run again.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Decl {
  name: string;
  value: string;
  imp: boolean;
}

/** A CSSStyleDeclaration as the engine keeps one: it drops what it can't parse, and writes its own text. */
function fakeStyle(decls: Decl[] = []) {
  const state = { decls };
  const text = () => state.decls.map((d) => `${d.name}: ${d.value}${d.imp ? ' !important' : ''};`).join(' ');
  const target = {
    getPropertyValue: (n: string) => state.decls.find((d) => d.name === n)?.value ?? '',
    getPropertyPriority: (n: string) => (state.decls.find((d) => d.name === n)?.imp ? 'important' : ''),
    set(next: Decl[]) {
      state.decls = next;
    },
  };
  return new Proxy(target as typeof target & Record<string, unknown>, {
    get(t, k) {
      if (k === 'length') return state.decls.length;
      if (k === 'cssText') return text();
      if (typeof k === 'string' && /^\d+$/.test(k)) return state.decls[+k]?.name;
      return (t as Record<string | symbol, unknown>)[k];
    },
    set(t, k, v) {
      if (k === 'cssText') {
        // Like the engine: a declaration without a value, or with a name it doesn't know, is dropped.
        state.decls = String(v)
          .replace(/\/\*.*?\*\//g, '')
          .split(';')
          .map((part) => /^\s*([a-z-]+)\s*:\s*(.+?)\s*$/.exec(part))
          .filter((m): m is RegExpExecArray => !!m && !/^x-/.test(m[1]!))
          .map((m) => ({ name: m[1]!, value: m[2]!.replace(/\s*!important$/, ''), imp: /!important$/.test(m[2]!) }));
      } else (t as Record<string | symbol, unknown>)[k] = v;
      return true;
    },
  });
}
type Style = ReturnType<typeof fakeStyle>;

interface El {
  nodeType: 1;
  nodeName: string;
  tagName: string;
  id: string;
  classes: string[];
  classList: { contains(c: string): boolean };
  parentNode: El | null;
  style: Style | undefined;
  attributes: { name: string; value: string }[];
  matches(sel: string): boolean;
  getAttribute(n: string): string | null;
  hasAttribute(n: string): boolean;
  getBoundingClientRect(): Record<string, number>;
  computed: string[];
  box: number[];
  [k: string]: unknown;
}

function element(tag: string, id: string, classes: string[], parent: El | null, withStyle = true): El {
  const e: El = {
    nodeType: 1,
    nodeName: tag.toUpperCase(),
    tagName: tag.toUpperCase(),
    id,
    classes,
    classList: { contains: (c) => e.classes.includes(c) },
    parentNode: parent,
    style: withStyle ? fakeStyle() : undefined,
    attributes: [],
    // What the engine would say: the rightmost compound's tag, classes and id all hold.
    matches: (sel) => {
      const last = sel.trim().split(/[\s>+~]+/).pop()!;
      const tagM = /^[a-z]+/.exec(last);
      if (tagM && tagM[0].toUpperCase() !== e.tagName) return false;
      for (const c of last.match(/\.[\w-]+/g) ?? []) if (!e.classes.includes(c.slice(1))) return false;
      const idM = /#([\w-]+)/.exec(last);
      return !idM || idM[1] === e.id;
    },
    getAttribute: (n) => (n === 'class' ? e.classes.join(' ') : null),
    hasAttribute: () => false,
    getBoundingClientRect: () => ({ left: e.box[0]!, top: e.box[1]!, right: e.box[2]!, bottom: e.box[3]!, width: e.box[2]! - e.box[0]!, height: e.box[3]! - e.box[1]! }),
    computed: [],
    box: [0.1, 0.2, 100.3, 50.7],
  };
  return e;
}

const NAMES = ['color', 'margin-top', 'margin-left', 'padding-top', 'border-left-width', 'transform', 'opacity', 'font-family', 'width', 'background-image'];
const VALUES = ['red', '0px', '12.5px', 'translate3d(220px, 0px, 0px)', '"Kode Mono", sans-serif', 'url("a;b.png")', 'rgb(0, 0, 0)', '0.3', 'auto', 'calc(100% - 2px)', 'naïve — “quoted”', ''];
const SELECTORS = ['.tile', '.rail .tile', 'div', '.tile.focused', '#hero', 'span.title, .tile, div.rail', '.a:not(.b), .tile', 'li', '.rail > .tile:hover', '[data-x="a,b"], .title', '*'];
const COMPUTED = Array.from({ length: 40 }, (_, i) => NAMES[i % NAMES.length]! + (i >= NAMES.length ? '-' + i : ''));

interface Rule {
  type: 1;
  selectorText: string;
  style: Style;
  parentRule: null;
}
interface Sheet {
  cssRules: Rule[];
  disabled: boolean;
  href: string;
  title: string;
  ownerNode: null;
  [k: string]: unknown;
}

describe('the short forms, against the inspector that wrote the protocol itself', () => {
  const had = { document: g.document, window: g.window, getComputedStyle: g.getComputedStyle, location: g.location };
  const sheets: Sheet[] = [];
  let cx: { handlers: Record<string, (p: object, id: number) => unknown>; setSocket(ws: object): void; linked(got: number, kept: boolean): void; newEpoch(): void; ASYNC: object };
  let dom: { idOf(n: object): number; boxModel(n: object): unknown };
  let before: Record<string, (p: object, id: number) => unknown>;
  const lines: string[] = [];

  beforeAll(() => {
    g.document = { styleSheets: sheets, contains: () => true };
    g.window = { matchMedia: () => ({ matches: true }) };
    g.location = { href: 'http://device.local/app', origin: 'http://device.local', protocol: 'http:', host: 'device.local' };
    g.getComputedStyle = (e: El) => {
      const decls = COMPUTED.map((name, i) => ({ name, value: e.computed[i] ?? 'auto', imp: false }));
      // The box model reads its widths through here too.
      const widths: Record<string, string> = { 'border-left-width': '1.5px', 'border-top-width': '0px', 'padding-left': '4.25px', 'margin-top': '-3px' };
      const style = fakeStyle(decls);
      const read = style.getPropertyValue;
      style.getPropertyValue = (n: string) => widths[n] ?? read(n);
      return style;
    };
    cx = require('../../inspector/src/cx.js');
    dom = require('../../inspector/src/dom.js');
    require('../../inspector/src/css.js');
    // The inspector from before, on the same page: its own table of handlers, and its own marks on
    // the page's sheets and styles so the two don't read each other's.
    const src = readFileSync(fileURLToPath(new URL('./reference/css-fe30687.js.txt', import.meta.url)), 'utf8')
      .replace("'__teleportSheet'", "'__referenceSheet'")
      .replace("'__teleportAuthored'", "'__referenceAuthored'");
    before = {};
    const refCx = Object.assign(Object.create(cx), { on: (t: Record<string, never>) => Object.assign(before, t), emit: () => {} });
    new Function('require', 'exports', src)((name: string) => (name === './cx.js' ? refCx : dom), {});
    cx.setSocket({ readyState: 1, bufferedAmount: 0, send: (s: string) => lines.push(...s.split('\n')) });
    cx.linked(0, false);
  });
  afterAll(() => Object.assign(g, had));

  /** Asks today's inspector, and returns what the laptop reads out of its answer. */
  async function ask(expander: Expander, method: string, params: object, id: number): Promise<Cdp> {
    lines.length = 0;
    // The inspector sends at the end of the task; here that is at once.
    const real = g.setTimeout;
    const queued: (() => void)[] = [];
    g.setTimeout = (fn: () => void) => (queued.push(fn), 0);
    let r: unknown;
    try {
      r = cx.handlers[method]!(params, id);
    } finally {
      g.setTimeout = real;
    }
    for (const fn of queued) fn();
    if (r !== cx.ASYNC) return { id, result: (r ?? {}) as Record<string, unknown> };
    const out = lines.flatMap((l) => {
      const m = JSON.parse(l);
      return Array.isArray(m) ? expander.expand(m) : [m as Cdp];
    });
    return out.find((m) => m.id === id) ?? { id, error: { code: 0, message: 'no answer' } };
  }
  const was = (method: string, params: object, id: number) => JSON.parse(JSON.stringify(before[method]!(params, id)));

  function page(random: () => number) {
    const pick = <T>(a: T[]) => a[Math.floor(random() * a.length)]!;
    const decl = (): Decl => ({ name: pick(NAMES), value: pick(VALUES.filter(Boolean)), imp: random() < 0.15 });
    const uniq = (d: Decl[]) => d.filter((x, i) => d.findIndex((y) => y.name === x.name) === i);
    const decls = () => uniq(Array.from({ length: Math.floor(random() * 5) }, decl));
    const rule = (): Rule => ({ type: 1, selectorText: pick(SELECTORS), style: fakeStyle(decls()), parentRule: null });
    const sheet = (): Sheet => ({ cssRules: Array.from({ length: 2 + Math.floor(random() * 8) }, rule), disabled: false, href: '', title: '', ownerNode: null });
    return { pick, decl, decls, rule, sheet };
  }

  it('gives the same matched styles, inline styles, computed style and box, whatever the page does between requests', async () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const random = rng(seed);
      const make = page(random);
      sheets.length = 0;
      sheets.push(make.sheet(), make.sheet());
      const root = element('div', 'hero', ['rail'], null);
      const els: El[] = [root];
      for (let i = 0; i < 14; i++) els.push(element(make.pick(['div', 'span', 'li']), i === 3 ? 'x' : '', [make.pick(['tile', 'title', 'a']), ...(random() < 0.4 ? ['focused'] : [])], make.pick(els), random() < 0.9));
      for (const e of els) e.computed = COMPUTED.map(() => make.pick(VALUES));
      const expander = new Expander();
      before['CSS.enable']!({}, 0);
      await ask(expander, 'CSS.enable', {}, 0);
      let id = 1;
      let short = 0;
      for (let step = 0; step < 400; step++) {
        // The page, or DevTools, changes something.
        const roll = random();
        const e = make.pick(els);
        const s = make.pick(sheets);
        if (roll < 0.15 && e.style) e.style.set(make.decls());
        else if (roll < 0.3) make.pick(s.cssRules).style.set(make.decls());
        else if (roll < 0.36) s.cssRules.splice(Math.floor(random() * (s.cssRules.length + 1)), 0, make.rule());
        else if (roll < 0.4 && s.cssRules.length > 1) s.cssRules.splice(Math.floor(random() * s.cssRules.length), 1);
        else if (roll < 0.43) sheets.push(make.sheet());
        else if (roll < 0.5) e.computed[Math.floor(random() * COMPUTED.length)] = make.pick(VALUES);
        else if (roll < 0.55) e.classes = [make.pick(['tile', 'title', 'a', 'focused'])];
        else if (roll < 0.6) e.box = [random() * 1920, random() * 1080, random() * 1920 + 0.1, random() * 1080 + 0.3];
        else if (roll < 0.66) cx.newEpoch(); // as after messages lost while the link was down
        else if (roll < 0.72) {
          // DevTools edits a rule or an inline style: both inspectors are told, and answer alike.
          const sheetIndex = sheets.indexOf(s);
          const line = Math.floor(random() * s.cssRules.length);
          const text = make.pick(['color: red; /* margin-top: 2px; */ width: 2', 'opacity: 0.5;', 'x-unknown: 1; color: blue !important', '']);
          const edit = random() < 0.6 || !e.style ? { styleSheetId: 's' + sheetIndex, range: { startLine: line }, text } : { styleSheetId: 'i' + dom.idOf(e), range: { startLine: 0 }, text };
          // Sheets are numbered as each inspector first saw them, which is the same order here.
          const want = was('CSS.setStyleTexts', { edits: [edit] }, id);
          const got = await ask(expander, 'CSS.setStyleTexts', { edits: [edit] }, id);
          expect(got.result ?? got.error, `seed ${seed} step ${step} edit`).toEqual(want);
          id++;
        }
        // Then DevTools asks, as it does on a click.
        const target = make.pick(els);
        const p = { nodeId: dom.idOf(target) };
        for (const method of ['CSS.getMatchedStylesForNode', 'CSS.getInlineStylesForNode', 'CSS.getComputedStyleForNode']) {
          const want = was(method, p, id);
          const got = await ask(expander, method, p, id);
          short += lines.join('').length;
          expect(got.error, `seed ${seed} step ${step} ${method}`).toBeUndefined();
          expect(got.result, `seed ${seed} step ${step} ${method}`).toEqual(want);
          id++;
        }
        const got = await ask(expander, 'DOM.getBoxModel', p, id++);
        expect(got.result, `seed ${seed} step ${step} box`).toEqual({ model: dom.boxModel(target) });
      }
      expect(expander.refused, `seed ${seed}`).toBe(0);
      expect(short).toBeGreaterThan(0);
    }
    // 12,800 answers compared whole: seconds on a busy machine, where the default would cut it off.
  }, 60_000);

  it('sends a rule once, and a computed style as what changed', async () => {
    const make = page(rng(42));
    sheets.length = 0;
    sheets.push(make.sheet());
    sheets[0]!.cssRules = [{ type: 1, selectorText: '.tile', style: fakeStyle([{ name: 'color', value: 'red', imp: false }]), parentRule: null }];
    const a = element('div', '', ['tile'], null);
    const b = element('div', '', ['tile'], null);
    a.computed = COMPUTED.map(() => 'auto');
    b.computed = COMPUTED.map((_, i) => (i === 7 ? '12px' : 'auto'));
    const expander = new Expander();
    await ask(expander, 'CSS.enable', {}, 0);
    const sent = async (method: string, e: El) => {
      await ask(expander, method, { nodeId: dom.idOf(e) }, 1);
      return lines.join('');
    };
    expect(await sent('CSS.getMatchedStylesForNode', a)).toContain('"color","red"');
    // The same rule for another element: only its number crosses.
    const again = await sent('CSS.getMatchedStylesForNode', b);
    expect(again).not.toContain('color');
    expect(again.length).toBeLessThan(40);
    // The page changes the rule: it crosses again, once.
    sheets[0]!.cssRules[0]!.style.set([{ name: 'color', value: 'blue', imp: false }]);
    expect(await sent('CSS.getMatchedStylesForNode', a)).toContain('"color","blue"');
    expect(await sent('CSS.getMatchedStylesForNode', b)).not.toContain('color');

    expect(await sent('CSS.getComputedStyleForNode', a)).toContain('"margin-top"');
    const delta = await sent('CSS.getComputedStyleForNode', b);
    expect(delta).not.toContain('margin-top');
    expect(JSON.parse(delta).slice(3)).toEqual([0, COMPUTED.length, 7, '12px']);
    expect(JSON.parse(await sent('CSS.getComputedStyleForNode', b)).slice(3)).toEqual([0, COMPUTED.length]);
  });

  it('refuses an answer it cannot follow, asks the device to start over, and is right again after', async () => {
    const make = page(rng(7));
    sheets.length = 0;
    sheets.push(make.sheet());
    const e = element('div', '', ['tile'], null);
    e.computed = COMPUTED.map(() => 'auto');
    const p = { nodeId: dom.idOf(e) };
    const device = new Expander();
    await ask(device, 'CSS.enable', {}, 0);
    await ask(device, 'CSS.getMatchedStylesForNode', p, 1);
    await ask(device, 'CSS.getComputedStyleForNode', p, 2);
    // A laptop that never saw those two (a new teleport, say) gets what comes next.
    const laptop = new Expander();
    e.computed[3] = '5px';
    for (const [method, id] of [['CSS.getComputedStyleForNode', 3], ['CSS.getMatchedStylesForNode', 4]] as const) {
      const got = await ask(laptop, method, p, id);
      expect(got.result).toBeUndefined();
      expect(got.error?.message).toMatch(/ask again/);
      expect(laptop.resync).toBe(true);
      laptop.resync = false;
    }
    // The server passes the request on; from then the answers are whole and right.
    cx.handlers['teleport.resync']!({}, 0);
    for (const method of ['CSS.getComputedStyleForNode', 'CSS.getMatchedStylesForNode']) {
      before['CSS.enable']!({}, 0);
      const got = await ask(laptop, method, p, 5);
      expect(got.result).toEqual(was(method, p, 5));
    }
    expect(laptop.refused).toBe(2);
  });

  it('never takes a broken message for an answer', () => {
    const x = new Expander();
    x.expand([2, 1, 1, 1, ['a', 'b'], ['1', '2']]);
    const bad: unknown[][] = [
      [2, 2, 1, 0, 3, 0, 'x'], // another length than the names it has
      [2, 2, 1, 0, 2, 5, 'x'], // an index outside the list
      [2, 2, 1, 0, 2, 0], // half a change
      [2, 2, 1, 0, 2, 0, 7], // a value that isn't text
      [2, 2, 2, 0, 2, 0, 'x'], // changes in an epoch it has nothing from
      [2, 2, 1, 1, ['a'], ['1', '2']], // more values than names
      [3, 2, 1, [], [0, 0, 0, 0]], // a rule it was never sent
      [3, 2, 1, [[0, 0, '.a', ['color', 'red']]], [0]], // declarations not in threes
      [3, 2, 1, [[0, 0, '.a', ['color', 'red', 0]]], [0, 0, 0, 4]], // a selector the rule doesn't have
      [5, 2, 1, 2, 3], // a box without its numbers
      [5, 2, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, null, 18], // a number that isn't one
      [99, 2],
    ];
    for (const m of bad) {
      x.expand([2, 1, 1, 1, ['a', 'b'], ['1', '2']]);
      const out = x.expand(m);
      expect(out, JSON.stringify(m)).toHaveLength(m[0] === 99 ? 0 : 1);
      if (out[0]) expect(out[0].error, JSON.stringify(m)).toBeDefined();
      expect(x.resync).toBe(true);
    }
    // A change that fails leaves nothing half applied: the next full reply is all there is.
    expect(x.expand([2, 9, 1, 1, ['a', 'b'], ['1', '2']])[0]!.result).toEqual({ computedStyle: [{ name: 'a', value: '1' }, { name: 'b', value: '2' }] });
  });

  it('splits a selector list where the device does', () => {
    const device = require('../../inspector/src/css.js') as { splitSelectors(s: string): string[] };
    const random = rng(9);
    const bits = ['a', '.b', '#c', ',', ', ', ' , ', '(', ')', '[', ']', ':is(', ':not(.x, .y)', '[d="e,f"]', ' ', '>', '*'];
    const made = Array.from({ length: 500 }, () => Array.from({ length: 1 + Math.floor(random() * 8) }, () => bits[Math.floor(random() * bits.length)]).join(''));
    for (const s of [...SELECTORS, 'a , b,c', ':is(a, b), c', '[x="],"] , d', '', ...made]) expect(splitSelectors(s), s).toEqual(device.splitSelectors(s));
  });

  it("reads a sheet again when the page rewrote a rule's selector, so the selectors shown are the rule's own", async () => {
    sheets.length = 0;
    const rule: Rule = { type: 1, selectorText: '.tile, .title', style: fakeStyle([{ name: 'color', value: 'red', imp: false }]), parentRule: null };
    sheets.push({ cssRules: [rule], disabled: false, href: '', title: '', ownerNode: null });
    const e = element('div', '', ['tile'], null);
    const x = new Expander();
    await ask(x, 'CSS.enable', {}, 0);
    const rules = async () => ((await ask(x, 'CSS.getMatchedStylesForNode', { nodeId: dom.idOf(e) }, 1)).result!.matchedCSSRules as { rule: { selectorList: { text: string; selectors: { text: string }[] } }; matchingSelectors: number[] }[]);
    expect((await rules())[0]!.matchingSelectors).toEqual([0]);
    rule.selectorText = 'div.tile';
    const after = await rules();
    expect(after[0]!.rule.selectorList).toEqual({ text: 'div.tile', selectors: [{ text: 'div.tile' }] });
    expect(after[0]!.matchingSelectors).toEqual([0]);
    expect(x.refused).toBe(0);
  });
});

describe('a console message in short', () => {
  // Two copies of the device's module, so each numbers the objects it keeps from 1.
  const load = () => {
    const path = require.resolve('../../inspector/src/remote.js');
    delete require.cache[path];
    return require(path) as { remote(v: unknown, preview: boolean): unknown; brief(v: unknown): unknown; consoleStart(): void; setDetail(level: number): void };
  };

  it('reads back as the object the device would have written, for every kind of value', async () => {
    const { remoteObject } = await import('../src/expand.js');
    class Tile {
      row = 1;
      get area() {
        return 4;
      }
    }
    const node = { nodeType: 1, nodeName: 'DIV', id: 'hero', className: ' tile  focused ' };
    const big: Record<string, unknown> = {};
    for (let i = 0; i < 9; i++) big['k' + i] = i;
    const values: unknown[] = [
      undefined, null, true, false, 0, -0, 1, -1.5, 1e21, 1e-7, 0.1 + 0.2, NaN, Infinity, -Infinity, 2 ** 53, '', 'tile', 'naïve — “q”\n ', 'x'.repeat(300),
      10n, Symbol('s'), Symbol.iterator, function named(a: number) { return a; }, () => 1, class A {},
      {}, { a: 1 }, { row: 3, title: 'Episode 12', focus: { x: 1 }, tags: ['hd'], f() {}, u: undefined, n: null, s: Symbol('p'), b: 5n }, big, new Tile(),
      [], [1, 'a', null, undefined, [2], {}], Array.from({ length: 30 }, (_, i) => i), new Uint8Array([1, 2, 3]), new Float64Array(40),
      new Date(0), /re/g, new Error('boom'), new TypeError('t'), new Map([[1, 2]]), new Set([1]), new WeakMap(), Promise.resolve(1), new ArrayBuffer(8),
      node, Object.create(null), Object.create({ inherited: 1 }), new Proxy({ a: 1 }, {}),
      { toString: 1, constructor: 2, __proto__: null, length: 3 }, { 'a,b': '[1]', '': 0, 0: 'zero' },
    ];
    for (const level of [0, 1]) {
      const a = load();
      const b = load();
      a.setDetail(level);
      b.setDetail(level);
      a.consoleStart();
      b.consoleStart();
      for (const v of values) {
        const want = JSON.parse(JSON.stringify(a.remote(v, true)));
        const got = JSON.parse(JSON.stringify(remoteObject(JSON.parse(JSON.stringify(b.brief(v))))));
        expect(got, String(typeof v === 'symbol' ? v.toString() : Object.prototype.toString.call(v))).toEqual(want);
      }
    }
  });

  it('is a fifth of the bytes for a logged object', () => {
    const a = load();
    const b = load();
    const v = { row: 3, col: 11, title: 'Episode 12 of a long running show', focus: { x: 2420, y: 990 }, tags: ['hd', 'new', 'resume'] };
    const protocol = JSON.stringify({ method: 'Runtime.consoleAPICalled', params: { type: 'log', args: [a.remote('tile', true), a.remote(v, true)], executionContextId: 1, timestamp: 1763110000000 } });
    const short = JSON.stringify([1, 'log', 1763110000000, b.brief('tile'), b.brief(v)]);
    expect(short.length * 3).toBeLessThan(protocol.length);
    const x = new Expander();
    expect(JSON.parse(JSON.stringify(x.expand(JSON.parse(short))[0]))).toEqual(JSON.parse(protocol));
  });
});

describe('messages lost for good while the link was down', () => {
  it('are said by the device first on the new socket, with a new epoch, and both ends count them', async () => {
    const path = require.resolve('../../inspector/src/cx.js');
    delete require.cache[path];
    const cx = require(path) as { setSocket(ws: object | null): void; linked(got: number, kept: boolean): void; send(m: unknown): void; epoch(): number };
    const real = g.setTimeout;
    const queued: (() => void)[] = [];
    g.setTimeout = (fn: () => void) => (queued.push(fn), 0);
    try {
      const first: string[] = [];
      cx.setSocket({ readyState: 1, bufferedAmount: 0, send: (s: string) => first.push(s) });
      cx.linked(0, false);
      const run = () => {
        for (const fn of queued.splice(0)) fn();
      };
      for (let i = 0; i < 3; i++) (cx.send([9, i, 0, 0, 0, 0, 0]), run());
      expect(first).toHaveLength(3);
      // The link drops, and more is sent than the device keeps: the oldest go.
      cx.setSocket(null);
      for (let i = 0; i < 600; i++) (cx.send([9, 100 + i, 0, 0, 0, 0, 0]), run());
      const epoch = cx.epoch();
      const second: string[] = [];
      cx.setSocket({ readyState: 1, bufferedAmount: 0, send: (s: string) => second.push(s) });
      // The laptop got the first three and nothing since.
      cx.linked(3, true);
      expect(second[0]).toBe('{"teleport":"gap","lost":88}');
      expect(second).toHaveLength(1 + 512);
      expect(JSON.parse(second[1]!)[1]).toBe(100 + 88);
      expect(cx.epoch()).toBe(epoch + 1);

      // The laptop's end of the same link: it counts the lost ones as got, tells whoever reads it, and the next reconnect asks for nothing twice.
      const { Link } = await import('../src/link.js');
      const link = new Link('t', { graceMs: 1000, keepCount: 10, keepBytes: 1e6 });
      const wire = () => {
        const w = { open: true, bytesIn: 0, sent: [] as string[], handler: (_d: Buffer, _b: boolean) => {}, send: (d: string) => void w.sent.push(d), close: () => {}, onMessage: (fn: (d: Buffer, b: boolean) => void) => void (w.handler = fn), onClose: () => {} };
        return w;
      };
      const w1 = wire();
      link.attach(w1 as never, 0, false);
      const got: string[] = [];
      let gaps = 0;
      link.onMessage((d) => got.push(d.toString()));
      link.onGap(() => gaps++);
      for (const s of first) w1.handler(Buffer.from(s), false);
      const w2 = wire();
      link.attach(w2 as never, 0, true);
      expect(w2.sent[0]).toBe('{"teleport":"link","got":3,"kept":true}');
      for (const s of second) w2.handler(Buffer.from(s), false);
      expect(gaps).toBe(1);
      expect(got).toHaveLength(3 + 512);
      expect(link.got).toBe(603);
      expect(link.missed).toBe(88);
      link.close();
    } finally {
      g.setTimeout = real;
    }
  });
});

describe('the DOM in flat batches', () => {
  it('reads names once and by number after, and starts the list again with a new epoch', async () => {
    const { DomWire } = await import('../src/devtools.js');
    const w = new DomWire();
    expect(w.read([10, 1, 1, 5, 2, 7, 1, 'DIV', 1, 'class', 'tile', -3, -4])).toEqual([['k', 5, [[7, 1, 'DIV', ['class', 'tile'], 2], 4]]]);
    expect(w.read([10, 1, 1, 5, 3, 8, 1, 0, 2, 1, 'a b', 'id', 'x', -1, 9, 3, 'text', 11, 10, 'html', '', ''])).toEqual([
      ['k', 5, [[8, 1, 'DIV', ['class', 'a b', 'id', 'x'], 0], [9, 3, 'text'], [11, 10, 'html', '', '']]],
    ]);
    expect(w.read([10, 1, 2, 8, 1, 'tile focused', 2, 8, 2, null, 3, 9, 'new', 4, 5, 12])).toEqual([['a', 8, 'class', 'tile focused'], ['a', 8, 'id', null], ['c', 9, 'new'], ['n', 5, 12]]);
    expect(w.read([10, 1])).toEqual([]);
    // A new epoch: the device forgot its list, so number 0 is whatever it says next.
    expect(w.read([10, 2, 2, 8, 'style', 'x'])).toEqual([['a', 8, 'style', 'x']]);
    expect(w.read([10, 2, 2, 8, 0, 'y'])).toEqual([['a', 8, 'style', 'y']]);
  });

  it('refuses a batch it cannot follow, whole', async () => {
    const { DomWire } = await import('../src/devtools.js');
    const bad: unknown[][] = [
      [10, 1, 2, 8, 5, 'x'], // a name's number never sent
      [10, 1, 1, 5, 2, 7, 1, 'DIV', 0, -1], // fewer children than it says
      [10, 1, 1, 5, 1, 7, 1, 'DIV', 2, 'class', 'a'], // cut off inside a node
      [10, 1, 1, 5, 1, 7, 2, 'x'], // no such kind of node
      [10, 1, 9, 5], // no such op
      [10, 1, 2, 8, 'class', 7], // a value that is neither text nor null
      [10, 1, 3, 9], // a text change without its text
      [10, 1, 1, 5, 1, 7, 1, 'DIV', 0, 4], // children given as a count that is no count
      [10, 'x', 4, 5, 1],
      [11, 1],
    ];
    for (const b of bad) {
      const w = new DomWire();
      w.read([10, 1, 2, 8, 'class', 'ok']);
      expect(w.read(b), JSON.stringify(b)).toBeNull();
    }
  });

  it('makes the copy stale and asks the page to start over, rather than apply a batch it cannot follow', async () => {
    const { DevtoolsBridge } = await import('../src/devtools.js');
    const toDevice: string[] = [];
    const toClients: string[] = [];
    const bridge = new DevtoolsBridge((m) => toDevice.push(m), (m) => toClients.push(m));
    const client = { send: (m: string) => toClients.push(m) };
    bridge.fromClient(client, { id: 1, method: 'DOM.getDocument', params: {} });
    const snap = JSON.parse(toDevice[0]!) as { id: number };
    bridge.fromDevice('', { id: snap.id, result: { root: [1, 9, 'http://x/', 'CSS1Compat', [[2, 1, 'HTML', [], [[3, 1, 'BODY', [], 0]]]]] } });
    expect(JSON.parse(toClients.at(-1)!).result.root.children[0].nodeName).toBe('HTML');
    // A good batch is applied; DevTools hears of the attribute.
    bridge.fromDevice('', { method: 'teleport.mutations', params: [10, 1, 2, 3, 'class', 'on'] as never });
    expect(toClients.at(-1)).toContain('"DOM.attributeModified"');
    // One that names a name it was never sent.
    toClients.length = 0;
    toDevice.length = 0;
    bridge.fromDevice('', { method: 'teleport.mutations', params: [10, 1, 2, 3, 9, 'x'] as never });
    expect(toClients).toEqual(['{"method":"DOM.documentUpdated","params":{}}']);
    expect(toDevice).toEqual(['{"id":"resync","method":"teleport.resync"}']);
    expect(bridge.mirror.ready).toBe(false);
  });
});

