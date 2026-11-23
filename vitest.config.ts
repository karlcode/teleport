import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The packages this repository builds, by name: a folder that is only on someone's disk isn't run.
    include: ['packages/{agent,inspector,protocol,server,stats,tlpt}/test/**/*.test.ts', 'test/**/*.test.ts'],
    // teleport keeps its key under the config folder. The tests get a folder of their own, so they
    // never read or write the key of whoever runs them.
    // The same for its data: surveys, the journal of experiments and replay tapes.
    env: { XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), 'tlpt-test-config-')), XDG_DATA_HOME: mkdtempSync(join(tmpdir(), 'tlpt-test-data-')) },
  },
});
