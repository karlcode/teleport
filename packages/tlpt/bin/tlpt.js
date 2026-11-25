#!/usr/bin/env node
// The command as npm installs it. `tlpt --version` answers from package.json, which is where the
// bundle's version came from, before the bundle (about 690 KB) is loaded: loading it is two thirds
// of what a command that prints one line takes (68 ms to 22, Node 22 on Linux x64).
import { readFileSync } from 'node:fs';

const flag = process.argv[2];
if ((flag === '--version' || flag === '-v') && process.argv.length === 3) {
  let version = '';
  try {
    version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    // The bundle knows it too.
  }
  if (version) {
    console.log(`tlpt ${version}`);
    process.exit(0);
  }
}
await import('../dist/cli.js');
