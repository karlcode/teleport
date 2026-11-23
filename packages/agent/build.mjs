// Builds the agent in the forms it ships in: teleport.min.js (served to the device as /teleport.js),
// teleport.js (the same, readable, as /teleport.debug.js) and agent.cjs (@tlpt/agent, for the app's
// own bundler). ES5 throughout; `npm run check` holds the result to ES5 and to the size budget.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deviceGuard } from '../../scripts/device-guard.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
// The one place the agent's version is written is its package.json; `teleport.version` says it.
const version = { TELEPORT_VERSION: JSON.stringify(JSON.parse(readFileSync(here + 'package.json', 'utf8')).version) };
const script = { entryPoints: [here + 'src/index.js'], bundle: true, format: 'iife', target: 'es5', logLevel: 'info', define: version, ...deviceGuard };

await build({ ...script, minify: true, outfile: here + 'dist/teleport.min.js' });
await build({ ...script, outfile: here + 'dist/teleport.js' });
await build({
  entryPoints: [here + 'src/entry.cjs'],
  bundle: true,
  format: 'cjs',
  platform: 'neutral',
  target: 'es5',
  minify: true,
  define: { TELEPORT_BUNDLED: 'true', ...version },
  logLevel: 'info',
  outfile: here + 'dist/agent.cjs',
});
