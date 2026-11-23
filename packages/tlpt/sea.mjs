// Builds tlpt as one native executable that runs with no Node installed: a Node single executable
// application (https://nodejs.org/api/single-executable-applications.html). The CLI is bundled into
// one CommonJS file, the agent and inspector ride along as assets, and the bundle is injected into a
// copy of a Node binary. Run `npm run build` at the repository root first.
//
//   node packages/tlpt/sea.mjs                     this machine's platform, with this Node
//   node packages/tlpt/sea.mjs --target linux-x64  another platform: downloads the same Node version for it
//
// Targets: linux-x64, linux-arm64, darwin-x64, darwin-arm64, win-x64. The bundle has no code cache or
// snapshot, so one built here runs on every target. A macOS executable is re-signed ad hoc, which
// needs macOS (codesign); the release workflow builds every target on a macOS runner for that reason.
// Out: packages/tlpt/sea/tlpt-<target>[.exe]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = fileURLToPath(new URL('.', import.meta.url));
const repo = fileURLToPath(new URL('../../', import.meta.url));
const out = here + 'sea/';
const require = createRequire(import.meta.url);
const { version } = JSON.parse(readFileSync(here + 'package.json', 'utf8'));

const at = process.argv.indexOf('--target');
const hostArch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : process.arch;
const host = `${process.platform === 'win32' ? 'win' : process.platform}-${hostArch}`;
const target = at >= 0 ? process.argv[at + 1] : host;
const TARGETS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win-x64'];
if (!TARGETS.includes(target)) throw new Error(`--target is one of ${TARGETS.join(', ')}`);
const windows = target.startsWith('win');
const darwin = target.startsWith('darwin');

const ASSETS = {
  'teleport.min.js': repo + 'packages/agent/dist/teleport.min.js',
  'teleport.js': repo + 'packages/agent/dist/teleport.js',
  'inspector.js': repo + 'packages/inspector/dist/inspector.js',
};
for (const f of Object.values(ASSETS)) if (!existsSync(f)) throw new Error(`${f} is missing: run npm run build at the repository root first`);

mkdirSync(out, { recursive: true });
const work = out + 'work/';
rmSync(work, { recursive: true, force: true });
mkdirSync(work);

// 1. The CLI as one CommonJS file. import.meta is empty there; server.ts reads it only outside an executable.
await build({
  entryPoints: [repo + 'packages/server/src/cli.ts'],
  outfile: work + 'tlpt.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  define: { TLPT_VERSION: JSON.stringify(version) },
  logOverride: { 'empty-import-meta': 'silent' },
  logLevel: 'warning',
});

// 2. The preparation blob: the bundle and the assets.
writeFileSync(
  work + 'sea-config.json',
  JSON.stringify({ main: work + 'tlpt.cjs', output: work + 'sea.blob', disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false, assets: ASSETS }, null, 2),
);
execFileSync(process.execPath, ['--experimental-sea-config', work + 'sea-config.json'], { stdio: 'inherit' });

// 3. A Node binary of the same version for the target: this one, or the official build downloaded and checked.
const exe = out + `tlpt-${target}${windows ? '.exe' : ''}`;
if (target === host) copyFileSync(process.execPath, exe);
else copyFileSync(await download(target), exe);
chmodSync(exe, 0o755);

// 4. Inject. macOS refuses a binary whose signature no longer matches, so it is removed first and redone after.
if (darwin) codesign(['--remove-signature', exe]);
const { inject } = require('postject');
await inject(exe, 'NODE_SEA_BLOB', readFileSync(work + 'sea.blob'), {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  machoSegmentName: darwin ? 'NODE_SEA' : undefined,
});
if (darwin) codesign(['--sign', '-', exe]);
rmSync(work, { recursive: true, force: true });
console.log(`sea: ${exe.slice(repo.length)} (${(readFileSync(exe).length / 1048576).toFixed(1)} MB, Node ${process.version}, tlpt ${version})`);

function codesign(args) {
  if (process.platform !== 'darwin') return console.warn(`sea: not on macOS, so ${exe.slice(repo.length)} is left unsigned; macOS will refuse to run it`);
  execFileSync('codesign', args, { stdio: 'inherit' });
}

/** The official Node binary for `t`, the version running this script, checked against SHASUMS256. */
async function download(t) {
  const v = process.version;
  const name = `node-${v}-${t}`;
  const file = `${name}${t.startsWith('win') ? '.zip' : '.tar.gz'}`;
  const base = `https://nodejs.org/dist/${v}/`;
  const get = async (url) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  };
  const archive = await get(base + file);
  const sums = (await get(base + 'SHASUMS256.txt')).toString();
  const want = sums.split('\n').find((l) => l.endsWith(`  ${file}`))?.split(' ')[0];
  const have = createHash('sha256').update(archive).digest('hex');
  if (!want || want !== have) throw new Error(`${file}: checksum does not match SHASUMS256.txt`);
  const dir = work + 'node/';
  mkdirSync(dir);
  writeFileSync(dir + file, archive);
  // tar reads zip files too on macOS and Windows (bsdtar); elsewhere unzip does.
  if (file.endsWith('.zip') && process.platform === 'linux') execFileSync('unzip', ['-q', dir + file, '-d', dir]);
  else execFileSync('tar', ['-xf', dir + file, '-C', dir]);
  const bin = t.startsWith('win') ? `${dir}${name}/node.exe` : `${dir}${name}/bin/node`;
  if (!existsSync(bin)) throw new Error(`no node binary in ${file}: ${readdirSync(dir).join(', ')}`);
  return bin;
}
