// Builds the inspector the agent loads on the device while DevTools or an API call needs it. ES5;
// `npm run check` holds the result to ES5.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { deviceGuard } from '../../scripts/device-guard.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));

await build({
  entryPoints: [here + 'src/index.js'],
  bundle: true,
  format: 'iife',
  target: 'es5',
  minify: true,
  logLevel: 'info',
  outfile: here + 'dist/inspector.js',
  ...deviceGuard,
});
