import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONSIDERATIONS, guide } from '../src/guide.js';
import { PROFILE } from '../src/profile.js';

const root = new URL('../../../', import.meta.url);

describe('the guide', () => {
  it('points every consideration at metrics the profile measures, with unique ids', () => {
    expect(new Set(CONSIDERATIONS.map((c) => c.id)).size).toBe(CONSIDERATIONS.length);
    for (const c of CONSIDERATIONS) {
      for (const m of c.shows) expect(PROFILE, `${c.id} shows ${m}`).toHaveProperty(m);
    }
  });

  it('asks the device only in ES5 expressions that parse (es-check)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'teleport-guide-es5-'));
    const files = CONSIDERATIONS.flatMap((c) =>
      c.ask.map((a, i) => {
        expect(() => new Function(`return (${a}\n)`), `${c.id}: ${a}`).not.toThrow();
        const f = join(dir, `${c.id}-${i}.js`);
        writeFileSync(f, `(${a}\n);\n`);
        return f;
      }),
    );
    expect(files.length).toBeGreaterThan(20);
    const out = execFileSync(new URL('node_modules/.bin/es-check', root).pathname, ['es5', ...files], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(out).toMatch(/no ES version matching errors|passed/i);
  });

  it('lists the topics without words, and finds the best ones for a question', () => {
    expect(guide('').topics!.map((t) => t.id)).toEqual(CONSIDERATIONS.map((c) => c.id));
    expect(guide('does hls or dash play, which codecs').matches![0]!.id).toBe('video');
    expect(guide('web fonts').matches![0]!.id).toBe('fonts');
    expect(guide('remote key presses feel slow').matches![0]!.id).toBe('input');
    expect(guide('zzzz qqqq').matches).toEqual([]);
  });
});
