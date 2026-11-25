import { describe, expect, it } from 'vitest';
import { COMMANDS } from '../src/q.js';
import { cssSpec, TOGGLES, toggleSpec, tried } from '../src/toggles.js';
import { humanize } from '../src/format.js';
import { parseSpec } from '../src/trial.js';
import { paint, plain } from '../src/tui.js';

describe('try', () => {
  it('makes a valid two-sided trial of every toggle, the sides differing by the toggle alone', () => {
    for (const t of TOGGLES) {
      const spec = parseSpec(toggleSpec(t));
      expect(spec.variants.map((v) => v.name)).toEqual([t.off, t.on]);
      expect(spec.keys).toHaveLength(8);
      // One style element a side, so the DOM is the same size but for what the toggle adds.
      for (const v of spec.variants) expect(v.setup.match(/createElement\('style'\)/g)).toHaveLength(1);
      expect(spec.variants[0]!.setup).not.toBe(spec.variants[1]!.setup + spec.variants[1]!.html);
      // ES5 only: it runs on the device.
      for (const v of spec.variants) expect(v.setup).not.toMatch(/=>|\blet\b|\bconst\b|`/);
      expect(t.brief.length).toBeLessThanOrEqual(34);
    }
  });

  it('tries css on the app itself and takes the rules out after each run', () => {
    const spec = parseSpec(cssSpec('* { box-shadow: none !important }', { runs: 3, keys: ['down', 'up'] }));
    expect([spec.where, spec.runs, spec.keys]).toEqual(['page', 3, ['down', 'up']]);
    // The baseline adds an empty style element, so the page differs by the rules alone.
    expect(spec.variants[0]!.setup).toContain('s.textContent=""');
    expect(spec.variants[0]!.setup).toContain('T.cleanup(');
    expect(spec.variants[1]!.setup).toContain('"* { box-shadow: none !important }"');
    expect(spec.variants[1]!.setup).toContain('T.cleanup(');
  });

  it('reads its words: nothing lists, a codec goes to the clips, anything else is said with what there is', () => {
    const t = tried([]);
    expect('list' in t && t.list.map((x) => x.name)).toEqual([...TOGGLES.map((x) => x.name), 'css <rules>', 'js <es5>', 'html <markup>', 'codec [name]']);
    expect(tried(['codec'])).toEqual({ verify: [] });
    expect(tried(['codec', 'hevc'])).toEqual({ verify: ['hevc'] });
    expect(tried(['av1'])).toEqual({ verify: ['av1'] });
    expect(() => tried(['shadwo'])).toThrow(/nothing to try called shadwo: transform, /);
    expect(() => tried(['css'])).toThrow(/needs the rules/);
    expect(() => tried(['shadow', 'x'])).toThrow('try shadow takes no word "x"');
    expect(COMMANDS.find((c) => c.name === 'try')!.acts).toBe(true);
  });

  it('prints the list and what played for a person', () => {
    const say = (data: unknown) => humanize('try', {}, data, 'ab12', paint('none'), 100).map(plain);
    const list = say({ toggles: [{ name: 'shadow', brief: 'box-shadow on every tile' }] });
    expect(list[0]).toBe('● try');
    expect(list[1]).toMatch(/shadow +box-shadow on every tile$/);
    const played = say({ verdicts: [{ name: 'hevc 1080p', plays: true, firstFrameMs: 120.4, dropped: 0, why: null, saidYes: true }, { name: 'av1 1080p', plays: false, firstFrameMs: null, dropped: null, why: 'no frames decoded', saidYes: true }], notMade: {} });
    expect(played).toEqual(['▲ clips played ab12 · 1 of 2 play', '  ⎿ hevc 1080p  plays · first frame 120 ms', "    av1 1080p   doesn't play · no frames decoded · though the engine said yes"]);
  });
});
