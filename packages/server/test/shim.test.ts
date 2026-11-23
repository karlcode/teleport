import { parse } from 'acorn';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { SHIM_NAMES, SHIM_SCRIPT } from '../src/shim.js';

describe('the shim', () => {
  it('is ES5, for the oldest engine it is for', () => {
    expect(() => parse(SHIM_SCRIPT, { ecmaVersion: 5 })).not.toThrow();
  });

  it('fills what an engine lacks, only that, and works as the built-in would', () => {
    // An engine without the ES2015+ built-ins: they are taken away before the shim runs.
    const out = runInNewContext(
      `var gone=['assign','entries','values','fromEntries'];for(var i=0;i<gone.length;i++)delete Object[gone[i]];
       delete Array.from;delete Array.of;delete Array.prototype.find;delete Array.prototype.includes;delete Array.prototype.flat;
       delete String.prototype.padStart;delete String.prototype.startsWith;delete Number.isNaN;delete Math.trunc;
       var window=this;${SHIM_SCRIPT}
       JSON.stringify({filled:window.__teleportShimmed,assign:Object.assign({a:1},{b:2}),entries:Object.entries({x:1}),from:Array.from('ab'),
         find:[1,2,3].find(function(x){return x>1}),includes:[NaN].includes(NaN),flat:[1,[2,[3]]].flat(),pad:'5'.padStart(3,'0'),
         starts:'abc'.startsWith('b',1),nan:Number.isNaN(NaN),trunc:Math.trunc(-4.7),fromEntries:Object.fromEntries([['k',1]])})`,
      {},
    );
    const r = JSON.parse(out);
    expect(r.filled).toEqual(expect.arrayContaining(['Object.assign', 'Array.from', 'Array.prototype.includes', 'String.prototype.padStart', 'Math.trunc']));
    // What the engine had is left alone.
    expect(r.filled).not.toContain('String.prototype.endsWith');
    expect(r).toMatchObject({ assign: { a: 1, b: 2 }, entries: [['x', 1]], from: ['a', 'b'], find: 2, includes: true, flat: [1, 2, [3]], pad: '005', starts: true, nan: true, trunc: -4, fromEntries: { k: 1 } });
    for (const n of r.filled) expect(SHIM_NAMES).toContain(n);
  });
});
