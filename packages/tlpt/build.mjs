// Builds `tlpt`: the CLI and server bundled with esbuild (no runtime dependencies), next to the
// built agent and inspector. The agent alone is @tlpt/agent. Run `npm run build` at the repository
// root first; this only gathers and bundles what it built.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = fileURLToPath(new URL('.', import.meta.url));
const repo = fileURLToPath(new URL('../../', import.meta.url));
for (const dir of ['dist', 'assets']) rmSync(here + dir, { recursive: true, force: true });

await build({
  entryPoints: { cli: repo + 'packages/server/src/cli.ts', index: repo + 'packages/server/src/index.ts', drive: repo + 'packages/server/src/client.ts' },
  outdir: here + 'dist',
  bundle: true,
  splitting: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  define: { TLPT_VERSION: JSON.stringify(JSON.parse(readFileSync(here + 'package.json', 'utf8')).version) },
  logLevel: 'warning',
});

const copy = (from, to) => {
  if (!existsSync(from)) throw new Error(`${from} is missing: run npm run build at the repository root first`);
  mkdirSync(to.slice(0, to.lastIndexOf('/')), { recursive: true });
  copyFileSync(from, to);
};
copy(repo + 'packages/agent/dist/teleport.min.js', here + 'assets/teleport.min.js');
copy(repo + 'packages/agent/dist/teleport.js', here + 'assets/teleport.js');
copy(repo + 'packages/inspector/dist/inspector.js', here + 'assets/inspector.js');
copy(repo + 'packages/server/client/devtools-link.js', here + 'assets/devtools-link.js');
copy(here + 'src/index.d.ts', here + 'dist/index.d.ts');
copy(here + 'src/drive.d.ts', here + 'dist/drive.d.ts');
copy(repo + 'README.md', here + 'README.md');
// The full reference, so an agent in a project that installs tlpt finds it in node_modules/tlpt.
copy(repo + 'AGENTS.md', here + 'AGENTS.md');
// And how it is built, which the reference points to.
copy(repo + 'ARCHITECTURE.md', here + 'ARCHITECTURE.md');
copy(repo + 'LICENSE', here + 'LICENSE');
