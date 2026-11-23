// `tlpt q styles`: what the device's engine drops from the app's CSS. The laptop takes the sheets
// apart and the device only says which selectors and declarations it refuses, so the reading here
// has to be right about where each one is, and has to step over everything that isn't a rule.
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { checkScript, distinct, droppedStyles, parseCss, sheetRefs, SHEETS_SCRIPT } from '../src/styles.js';

const CSS = `/* a { color: red } */
@charset "utf-8";
@import url("x.css");
.tile, .rail > .tile:focus-visible { color: red; margin: 0 4px !important; }

.a[data-x="}{;,"]::before { content: "; } /* not a comment */"; background: url(a;b.png) }
@media (min-width: 1px) {
  .grid { display: grid; gap: 4px }
  @supports (display: grid) { .deep:is(a, b) { inset: 0 } }
}
@keyframes spin { from { transform: none } to { transform: rotate(1turn) } }
@font-face { font-family: X; src: url(x.woff2) }
.last{color:red;;--gap: 2px;width:calc(100% - var(--gap))}
`;

describe('reading a style sheet on the laptop', () => {
  const rules = parseCss(CSS);

  it('finds each style rule with its selectors, declarations and lines, through at-rules that hold rules', () => {
    expect(rules.map((r) => [r.line, ...r.selectors])).toEqual([
      [4, '.tile', '.rail > .tile:focus-visible'],
      [6, '.a[data-x="}{;,"]::before'],
      [8, '.grid'],
      [9, '.deep:is(a, b)'],
      [13, '.last'],
    ]);
    expect(rules[0]!.decls).toEqual([{ prop: 'color', value: 'red', line: 4 }, { prop: 'margin', value: '0 4px', line: 4 }]);
    expect(rules[1]!.decls.map((d) => d.prop + '=' + d.value)).toEqual(['content="; } /* not a comment */"', 'background=url(a;b.png)']);
    expect(rules[4]!.decls.map((d) => d.prop)).toEqual(['color', '--gap', 'width']);
  });

  it('never loops or throws on a sheet that is cut off or isn\'t CSS', () => {
    for (const bad of ['', '}', '{', '.a {', '.a { color: ', '/* open', '"open', '.a { b { c: d } e: f }', '@media x { .a { b: c }', '<html>not css</html>', '}}}}{{{{', CSS.slice(0, 200), CSS.slice(37)]) {
      expect(() => parseCss(bad), bad).not.toThrow();
    }
    expect(parseCss('.a { b { c: d } e: f }')[0]!.decls).toEqual([{ prop: 'e', value: 'f', line: 1 }]);
  });

  it('asks about each distinct selector and declaration once, and counts its uses', () => {
    const d = distinct([{ name: 'app.css', rules }, { name: 'more.css', rules: parseCss('.tile { COLOR: red }') }]);
    expect(d.rules).toBe(6);
    expect(d.selectors.find((s) => s.text === '.tile')).toEqual({ text: '.tile', at: 'app.css:4', uses: 2 });
    expect(d.decls.find((x) => x.text === 'color: red')).toMatchObject({ at: 'app.css:4', uses: 3 });
  });
});

describe('asking the device', () => {
  // An engine like an old one: no :is() or :focus-visible, no grid, gap, inset or custom properties.
  const oldEngine = (supports: boolean) => {
    const known = /^(color|margin|content|background|width|transform)$/;
    const style = { cssText: '', get length() { const m = /^([^:]+):(.*)$/.exec(this.cssText); return m && known.test(m[1]!) && !/var\(|grid/.test(m[2]!) ? 1 : 0; } };
    const sheets = [
      { href: 'http://device.local:7070/css/app.css?v=3', ownerNode: {}, cssRules: [{ type: 1 }, { type: 4, cssRules: [{ type: 1 }] }] },
      { href: null, ownerNode: { textContent: '.inline { inset: 0 }' }, cssRules: [] },
      { href: 'http://cdn.example/other.css', ownerNode: {}, get cssRules(): never { throw new Error('SecurityError'); } },
    ];
    return {
      document: {
        styleSheets: sheets,
        createElement: () => ({ style }),
        querySelector: (s: string) => {
          if (/:is\(|:focus-visible/.test(s)) throw new SyntaxError('not a valid selector');
          return null;
        },
      },
      window: supports ? { CSS: { supports: (p: string, v: string) => known.test(p) && !/var\(|grid/.test(v) } } : {},
      CSS: supports ? { supports: (p: string, v: string) => known.test(p) && !/var\(|grid/.test(v) } : undefined,
      Date,
    };
  };

  it('names its sheets in one small answer', () => {
    expect(sheetRefs(runInNewContext(SHEETS_SCRIPT, oldEngine(true)))).toEqual([
      { href: 'http://device.local:7070/css/app.css?v=3', text: null, kept: 2 },
      { href: '', text: '.inline { inset: 0 }', kept: 0 },
      { href: 'http://cdn.example/other.css', text: null, kept: -1 },
    ]);
  });

  for (const supports of [true, false]) {
    it(`reports what the engine refuses, by file and line, most used first (${supports ? 'with' : 'without'} CSS.supports)`, async () => {
      const engine = oldEngine(supports);
      const asked: string[] = [];
      const r = await droppedStyles(
        async (script) => {
          asked.push(script);
          return JSON.parse(JSON.stringify(runInNewContext(script, engine)));
        },
        async (href) => {
          if (href.includes('cdn')) throw new Error('answered 403');
          return CSS;
        },
      );
      expect(r.selectors.map((s) => [s.text, s.at])).toEqual([['.rail > .tile:focus-visible', 'app.css:4'], ['.deep:is(a, b)', 'app.css:9']]);
      expect(r.properties.map((s) => [s.text, s.at, s.uses])).toEqual([
        ['inset: 0', 'app.css:9', 2],
        ['display: grid', 'app.css:8', 1],
        ['gap: 4px', 'app.css:8', 1],
        ['--gap: 2px', 'app.css:13', 1],
        ['width: calc(100% - var(--gap))', 'app.css:13', 1],
      ]);
      expect(r).toMatchObject({ sheets: 3, rules: 6, supports, unread: [{ href: 'http://cdn.example/other.css', why: 'answered 403' }], questions: 2 });
      // The device was sent the selectors and declarations, never a sheet.
      expect(asked.join('').length).toBeLessThan(1500);
    });
  }

  it('asks a few hundred at a time, and refuses an answer that names what it never asked about', async () => {
    const many = Array.from({ length: 900 }, (_, i) => `.c${i} { p${i}: v }`).join('\n');
    let questions = 0;
    const engine = { document: { styleSheets: [{ href: 'http://x/a.css', ownerNode: {}, cssRules: [] }], createElement: () => ({ style: { cssText: '', length: 1 } }), querySelector: () => null }, window: {}, Date };
    const r = await droppedStyles(async (s) => (questions++, JSON.parse(JSON.stringify(runInNewContext(s, engine)))), async () => many);
    expect(questions).toBe(4);
    expect(r).toMatchObject({ rules: 900, selectors: [], properties: [] });
    await expect(droppedStyles(async (s) => (s === SHEETS_SCRIPT ? ['http://x/a.css', 0, 1] : [5000, 1, 0]), async () => '.a { b: c }')).rejects.toThrow(/made no sense/);
    // A line separator in a sheet is JSON but not ES5: written raw it would be a syntax error on the device.
    const script = checkScript(['a"b\u2028'], ['x', 'y\u2029']);
    expect(script).toContain('"a\\"b\\u2028"');
    expect(script).not.toMatch(/[\u2028\u2029]/);
  });
});
