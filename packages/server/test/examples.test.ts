import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { argsFromWords, COMMANDS, parseQ } from '../src/q.js';
import { parseSpec } from '../src/trial.js';

const dir = fileURLToPath(new URL('../../../examples/trials/', import.meta.url));
const trial = COMMANDS.find((c) => c.name === 'trial')!;

describe('the example trials', () => {
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.mjs'))) {
    it(`${file} loads as a trial whose code parses`, async () => {
      const { pos, flags } = parseQ(['trial', file]);
      const { body } = await trial.call!(argsFromWords(trial, pos, flags), dir);
      const spec = parseSpec((body as { spec: unknown }).spec);
      expect(spec.variants.length).toBeGreaterThan(1);
      // What runs on the device must at least be JavaScript; the device's engine checks the rest.
      for (const v of spec.variants) for (const code of [v.before, v.setup]) expect(() => new Function('T', code)).not.toThrow();
      expect(() => new Function('T', spec.measure)).not.toThrow();
      for (const check of Object.values(spec.checks)) expect(() => new Function(`return (${check}\n)`)).not.toThrow();
    });
  }
});
