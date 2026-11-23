import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listTapes, loadTape, saveTape, tapeOf } from '../src/replay.js';

const ARM = 'Mozilla/5.0 (X11; Linux armv7l) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/63.0.3239.84 Safari/537.36';

describe('replay tapes', () => {
  it('keeps the presses that are remote keys, each with the pause before the next, within bounds', () => {
    const t = tapeOf(
      [
        { t: 1000, keyCode: 39, key: 'right' },
        { t: 1010, keyCode: 39, key: 'right' },
        { t: 1500, keyCode: 65, key: null },
        { t: 2400, keyCode: 40, key: 'down' },
        { t: 30_000, keyCode: 13, key: 'ok' },
      ],
      'Home → Rail!',
      ARM,
    );
    expect(t.name).toBe('home-rail');
    // 10 ms is held to 60, 27.6 s to 10 s, and the last press gets half a second.
    expect(t.steps).toEqual([
      { key: 'right', delayMs: 60 },
      { key: 'right', delayMs: 1390 },
      { key: 'down', delayMs: 10_000 },
      { key: 'ok', delayMs: 500 },
    ]);
    expect(t.ms).toBe(29_000);
  });

  it('saves, lists newest first, and loads a tape by name or as last', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tlpt-replays-'));
    saveTape(tapeOf([{ t: 0, keyCode: 39, key: 'right' }], 'one', ARM), dir);
    saveTape(tapeOf([{ t: 0, keyCode: 37, key: 'left' }, { t: 400, keyCode: 13, key: 'ok' }], 'two', ARM), dir);
    expect(listTapes(dir).map((t) => [t.name, t.steps])).toEqual(expect.arrayContaining([['one', 1], ['two', 2]]));
    expect(loadTape('two', dir).steps).toEqual([{ key: 'left', delayMs: 400 }, { key: 'ok', delayMs: 500 }]);
    expect(() => loadTape('three', dir)).toThrow(/no tape three: there are/);
    expect(() => loadTape('last', mkdtempSync(join(tmpdir(), 'tlpt-replays-')))).toThrow(/replay save <name>/);
  });
});
