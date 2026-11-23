// Run from a source checkout, `tlpt` rebuilds itself as you edit and reloads what changed:
//   protocol schema       → regenerate the constants (the rest follows)
//   agent, inspector      → rebuild, then connected devices reload
//   server (TypeScript)   → TypeScript's watch builder, then the server process restarts
// Builds are each package's own `npm run build`, so this file holds no build config. The server
// runs as a child process; this one only watches, builds and restarts it, and reports build
// results to it over IPC to print.
import { spawn } from 'node:child_process';
import { existsSync, statSync, readdirSync, watch } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const at = (...p) => join(root, ...p);
const DEBOUNCE_MS = 120;

/** Newest modification time under a file or folder. */
function newest(path) {
  if (!existsSync(path)) return 0;
  const s = statSync(path);
  if (!s.isDirectory()) return s.mtimeMs;
  return readdirSync(path).reduce((m, n) => Math.max(m, newest(join(path, n))), s.mtimeMs);
}

const PACKAGES = [
  { name: 'protocol', run: ['node', [at('scripts/gen-protocol.mjs')]], watch: [at('packages/protocol/schema.json')], out: at('packages/agent/src/generated/schema.js') },
  { name: 'agent', run: ['npm', ['run', 'build', '-w', '@tlpt/agent']], watch: [at('packages/agent/src')], out: at('packages/agent/dist/teleport.min.js'), reload: 'devices' },
  { name: 'inspector', run: ['npm', ['run', 'build', '-w', '@teleport/inspector']], watch: [at('packages/inspector/src')], out: at('packages/inspector/dist/inspector.js'), reload: 'devices' },
].filter((pkg) => existsSync(pkg.watch[0]));

let child = null;
let restarting = false;
let quitting = false;
const tell = (msg) => child?.connected && child.send(msg);

function build(pkg) {
  if (pkg.busy) return void (pkg.again = true);
  pkg.busy = true;
  pkg.seen = Math.max(...pkg.watch.map(newest));
  let out = '';
  const p = spawn(pkg.run[0], pkg.run[1], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  p.on('close', (code) => {
    pkg.busy = false;
    const error = code ? out.split('\n').find((l) => /error/i.test(l))?.trim() || `${pkg.name} build failed` : null;
    tell({ type: 'build', name: pkg.name, error, reload: code ? null : pkg.reload ?? null });
    if (pkg.again) (pkg.again = false), build(pkg);
  });
}

for (const pkg of PACKAGES) {
  if (Math.max(...pkg.watch.map(newest)) > newest(pkg.out)) build(pkg);
  let timer;
  for (const path of pkg.watch) {
    if (!existsSync(path)) continue;
    watch(path, { recursive: statSync(path).isDirectory() }, () => {
      clearTimeout(timer);
      // File watchers report more than edits (macOS especially); build only when an input really changed.
      timer = setTimeout(() => Math.max(...pkg.watch.map(newest)) > (pkg.seen ?? 0) && build(pkg), DEBOUNCE_MS);
    });
  }
}

// TypeScript packages: TypeScript's own watch builder, in this process so nothing outlives it. A pass
// that wrote newer server output restarts the server; a pass with errors keeps the old server running
// and shows the first error.
const serverOut = at('packages/server/dist');
/** Newest server output when the running server started; newer output means restart. */
let startedOn = 0;
let firstError = null;
let tscReady = false;
const ts = (await import('typescript')).default;
const shown = { getCanonicalFileName: (f) => f, getCurrentDirectory: () => root, getNewLine: () => '\n' };
const host = ts.createSolutionBuilderWithWatchHost(
  ts.sys,
  ts.createEmitAndSemanticDiagnosticsBuilderProgram,
  (d) => (firstError ??= ts.formatDiagnostic(d, shown).trim()),
  () => {},
  (status) => {
    // The solution builder passes no error count; its "Found N errors" message (6193/6194) has it.
    const found = /Found (\d+) errors?/.exec(ts.flattenDiagnosticMessageText(status.messageText, ' '));
    if (!found) return;
    const errors = Number(found[1]);
    tell({ type: 'build', name: 'server', error: errors ? firstError : null, reload: null });
    firstError = null;
    if (!tscReady) {
      tscReady = true;
      if (!child) start();
    } else if (!errors && newest(serverOut) > startedOn) restart();
  },
);
const tsc = ts.createSolutionBuilderWithWatch(host, ['protocol', 'stats', 'server'].map((p) => at('packages', p)), { preserveWatchOutput: true });

const args = process.argv.slice(2);
/** Tabs that have had DevTools. The device reconnects to a restarted server, which mustn't open them again. */
const opened = new Set();
function start() {
  if (child) return;
  startedOn = newest(serverOut);
  child = spawn(process.execPath, [fileURLToPath(new URL('./teleport.js', import.meta.url)), ...args], {
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    env: { ...process.env, TELEPORT_CHILD: '1', TELEPORT_OPENED: [...opened].join(',') },
  });
  child.on('message', (m) => m?.type === 'opened' && opened.add(m.id));
  child.on('exit', (code) => {
    child = null;
    if (restarting) return void ((restarting = false), start());
    stop(code ?? 0);
  });
}

function restart() {
  if (!child) return start();
  restarting = true;
  child.kill('SIGTERM');
}

function stop(code) {
  if (quitting) return;
  quitting = true;
  process.exit(code);
}

// The server child also exits on its own if this process dies without a signal it can catch.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => (child ? child.kill('SIGTERM') : stop(0)));

// Start at once when the server's build is current; otherwise the first TypeScript pass starts it.
if (newest(at('packages/server/src')) <= newest(serverOut) && existsSync(join(serverOut, 'cli.js'))) start();
tsc.build();
