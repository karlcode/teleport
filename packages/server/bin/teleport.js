#!/usr/bin/env node
// From a source checkout, `tlpt` runs under a watcher that rebuilds and hot-reloads teleport
// itself (bin/watch.js). An installed copy, the watched child, `q` and `--help` run directly.
import { existsSync } from 'node:fs';

const fromSource = existsSync(new URL('../src/cli.ts', import.meta.url)) && existsSync(new URL('../../../node_modules/.bin/tsc', import.meta.url));
const direct = process.env.TELEPORT_CHILD || !fromSource || process.argv.slice(2).some((a) => a === 'q' || a === '--help' || a === '-h');
await import(direct ? '../dist/cli.js' : './watch.js');
