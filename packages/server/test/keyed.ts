// The key the tests' servers ask for. vitest.config.ts points XDG_CONFIG_HOME at a folder made for
// the run, so this is never the key of whoever runs the tests, and every server a test starts and
// every `tlpt q` call it makes reads the same one.
import { ensureKey } from '../src/key.js';

export const KEY = ensureKey();
