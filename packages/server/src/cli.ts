import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { answers, appTarget, DEV_PORTS, entryPath, findDevServers, waitable, why, type AppTarget } from './app.js';
import { Console, type DevtoolsNote } from './console.js';
import { humanize } from './format.js';
import { commandHelp, handHelp, mainHelp, qHelp } from './help.js';
import { readKey } from './key.js';
import { AUTO_LINE } from './live.js';
import { findEndpoint, pointAt, tunnelCommand, type RunningTunnel, type TunnelEndpoint } from './tunnel.js';
import { serveMcp } from './mcp.js';
import { MENU, REMOTE_KEYS, RUNNABLE, runnable, type Entry } from './menu.js';
import { argsFromWords, COMMANDS, nearest, parseQ, Q_USAGE, request, runData, type Args, type Command } from './q.js';
import { BASE, inspectUrl, lanAddress, startDevServer, type DevServer, type DevServerOptions } from './server.js';
import { askBackground, ESC_WAIT_MS, KeyReader, PlainScreen, TermScreen, type Key, type Screen } from './term.js';
import { truncate, width } from './text.js';
import { G, header, helpView, lightBackground, lightReply, paint, setGlyphs, themeSaid, wantsAscii, type Color } from './tui.js';
import { VERSION } from './version.js';
import { keep } from './journal.js';

// A live console on a terminal; plain lines when piped or logged (TERM=dumb counts as piped). Colour
// follows each stream (https://no-color.org turns it off); glyphs and tones follow the terminal.
setGlyphs(wantsAscii());
let light = lightBackground();
const isTerminal = (s: NodeJS.WriteStream) => !!s.isTTY && process.env.TERM !== 'dumb';
const depth = (terminal: boolean): Color =>
  !terminal || process.env.NO_COLOR ? 'none' : /truecolor|24bit/i.test(process.env.COLORTERM ?? '') || process.env.TERM_PROGRAM === 'iTerm.app' || process.env.WT_SESSION ? 'truecolor' : '256';
const live = isTerminal(process.stdout);
const color = depth(live);
// stderr may be a terminal while stdout is piped (`tlpt q capture | jq`): errors and q's spinner go there.
const errLive = isTerminal(process.stderr);
let errPaint = paint(depth(errLive), light);
const cols = () => (live ? Math.max(40, process.stdout.columns ?? 80) : 100);
const print = (lines: string[]) => console.log(lines.join('\n'));
/** Prints and exits once stdout has taken it all: a pipe is written asynchronously, and exiting at
 *  once cut a large answer at 64 KB. A reader that closes early is not a crash. */
function finish(lines: string[]): Promise<never> {
  process.stdout.once('error', () => process.exit(0));
  process.stdout.write(lines.join('\n') + '\n', () => process.exit(0));
  return new Promise(() => {});
}
/** Over SSH a browser would open on the far machine, out of sight; the console prints the link instead. */
const SSH = !!process.env.SSH_CONNECTION;

/** The console's screen once it runs: closed first on any way out, so nothing lands inside its region. */
let screen: Screen | null = null;

/** A line on stderr after `tlpt:`. */
const say = (message: string) => console.error(`${errPaint.bad('tlpt:')} ${message}`);

function die(message: string): never {
  screen?.close();
  say(message);
  process.exit(1);
}

/** What tlpt owes on any way out, a crash included: the tunnel it took over goes back to the app. */
let owed: (() => Promise<unknown>) | null = null;

// A crash restores the terminal before the stack prints, rather than leaving Node to print it over
// the region, and gives a tunnel back before it leaves: one left pointing at a tlpt that is gone
// answers the device with nothing until someone restarts it.
function crash(e: unknown) {
  screen?.close();
  console.error(e instanceof Error ? (e.stack ?? e.message) : e);
  const pay = owed;
  owed = null;
  if (!pay) process.exit(1);
  setTimeout(() => process.exit(1), 2000).unref();
  void pay().finally(() => process.exit(1));
}
process.on('uncaughtException', crash);
process.on('unhandledRejection', crash);

/** Takes a flag and its value out of argv, returning the value. */
function takeFlag(argv: string[], name: string, hasValue: boolean): string | undefined {
  const at = argv.indexOf(name);
  if (at < 0) return undefined;
  return hasValue ? argv.splice(at, 2)[1] : (argv.splice(at, 1), '');
}

const OPTIONS = {
  port: { type: 'string', default: '7070' },
  // No default: the server then listens on every interface, IPv4 and IPv6 (server.ts).
  host: { type: 'string' },
  insecure: { type: 'boolean' },
  manifest: { type: 'string' },
  via: { type: 'string' },
  tunnel: { type: 'string' },
  'no-open': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const;

// The parsed flags and the app named, which dev() reads.
let values: { port: string; host?: string; insecure?: boolean; manifest?: string; via?: string; tunnel?: string; 'no-open'?: boolean; help?: boolean; version?: boolean };
let given: string | undefined;

// An async main rather than top-level await: the CLI then also bundles to one CommonJS file, which is
// what a Node single executable (packages/tlpt/sea.mjs) runs on Node 22 and 24.
async function main() {
  // A command by its name: `tlpt capture 5`, `tlpt survey`, `tlpt remote`. Commands take their own
  // flags, so they are handled before tlpt's are parsed. A folder that shares a command's name is
  // served as `./name`. `tlpt q <command>` is the same thing, as scripts and agents have written it.
  const first = process.argv[2] ?? '';
  if (first === 'q') return q(process.argv.slice(3));
  if (first === 'help' && process.argv[3]) return q([...process.argv.slice(3), '--help']);
  if (first === 'help') return print(helpView(mainHelp(), cols(), color, light));
  if (runnable(first)) return q(process.argv.slice(2));

  if (process.argv[2] === 'mcp') {
    const argv = process.argv.slice(3);
    await serveMcp(Number(takeFlag(argv, '--port', true) ?? process.env.TELEPORT_PORT) || 7070);
    process.exit(0);
  }

  let parsed;
  try {
    parsed = parseArgs({ allowPositionals: true, options: OPTIONS });
  } catch (e) {
    // Node's messages name the flag in quotes ('--prot', '-h, --help'); the rest is said here more plainly.
    const err = e as Error & { code?: string };
    const flag = /'(?:-\w, )?(-[^' ]+)/.exec(err.message)?.[1];
    if (!flag) die(`${err.message} (tlpt --help)`);
    if (err.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') die(`${flag} ${/missing|ambiguous/.test(err.message) ? 'needs a value' : 'takes no value'} (tlpt --help)`);
    const near = flag.startsWith('--') ? nearest(flag.slice(2), Object.keys(OPTIONS)) : null;
    die(`unknown option ${flag}${near ? `; did you mean --${near}?` : ''} (tlpt --help)`);
  }
  values = parsed.values;
  const { positionals } = parsed;
  given = positionals[0];

  if (values.version) {
    print([`tlpt ${VERSION}`]);
  } else if (values.help) {
    print(helpView(mainHelp(), cols(), color, light));
  } else if (positionals.length > 1) {
    die(`one app at a time (tlpt --help)`);
  } else {
    await dev();
  }
}

/** `tlpt q`: one command against the tlpt on this machine, for a person in a terminal or as JSON. */
async function q(argv: string[]) {
  // --name=value, as tlpt's own flags take it, is the same as --name value; q's own switches take none.
  const valued = argv.find((a) => /^--(json|help)=/.test(a));
  if (valued) die(`${valued.slice(0, valued.indexOf('='))} takes no value (tlpt --help)`);
  argv = argv.flatMap((a) => (/^--[^=]+=/.test(a) ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a]));
  const port = Number(takeFlag(argv, '--port', true) ?? process.env.TELEPORT_PORT) || 7070;
  const json = takeFlag(argv, '--json', false) !== undefined || !live;
  const wantsHelp = takeFlag(argv, '--help', false) !== undefined || takeFlag(argv, '-h', false) !== undefined;
  const { name, pos, flags } = parseQ(argv);
  const e = runnable(name);
  if (!name || (wantsHelp && !e)) {
    // A person at a terminal gets the short page; piped, an agent gets every command in full.
    return finish(live ? helpView(qHelp(), cols(), color, light) : [Q_USAGE]);
  }
  if (!e) {
    const near = nearest(name, RUNNABLE);
    die(`no command ${name}${near ? `; did you mean ${near}?` : `: ${MENU.map((x) => x.name).join(', ')}`} (tlpt --help)`);
  }
  if (!e.cmd) return wantsHelp ? finish(helpView(handHelp(e), cols(), color, light)) : byHand(e, pos, flags.id || undefined, port);
  const c = e.cmd;
  if (wantsHelp) return finish(helpView(commandHelp(c), cols(), color, light));
  let args: Args;
  try {
    args = argsFromWords(c, pos, flags);
  } catch (e) {
    die((e as Error).message);
  }
  let id = flags.id || undefined;
  let href: string | undefined;
  // A person reads which device answered. With no --id that is the newest, named before the call, so the
  // spinner and the answer agree. JSON is left as it was: the server picks the same device.
  if (!json && !c.local && c.name !== 'status' && c.name !== 'devices') {
    const duts = ((await request(port, 'live').catch(() => [])) as { device: { id: string; href: string } }[]).map((t) => t.device);
    const dut = id ? duts.find((t) => t.id === id) : duts[duts.length - 1];
    id ??= dut?.id;
    href = dut?.href;
  }
  const wait = waiting(c, args, id);
  let data: unknown;
  try {
    data = await runData(c, args, port, process.cwd(), id, 'q', wait.signal);
  } catch (e) {
    wait.done();
    die((e as Error).message);
  }
  wait.done();
  // Piped, or asked for: JSON, which scripts and AI agents read. In a terminal: for a person.
  return finish(json ? [JSON.stringify(data, null, 1)] : humanize(c.name, args, data, id, paint(color, light), cols(), { port, href }));
}

/**
 * remote, devtools and reload from a shell, against the tlpt that is running: what their keys do in
 * its console. Remote reads this terminal's keys until esc.
 */
async function byHand(e: Entry, pos: string[], id: string | undefined, port: number): Promise<never> {
  if (pos.length) die(`${e.name} takes no word "${pos[0]}" (tlpt ${e.name} --help)`);
  const duts = ((await request(port, 'live').catch((err: Error) => die(err.message))) as { device: { id: string; inspect: string } }[]).map((t) => t.device);
  const dut = id ? duts.find((t) => t.id === id) : duts[duts.length - 1];
  if (!dut) die(id ? `no device ${id}; connected: ${duts.map((t) => t.id).join(', ') || 'none'}` : 'no device connected yet');
  const c = (name: string) => COMMANDS.find((x) => x.name === name)!;
  if (e.name === 'devtools') {
    open(dut.inspect);
    return finish([`DevTools for ${dut.id}  ${dut.inspect}`]);
  }
  if (e.name === 'reload') {
    await runData(c('eval'), { expression: 'location.reload()' }, port, process.cwd(), dut.id, 'q').catch((err: Error) => die(err.message));
    return finish([`${dut.id} reloading`]);
  }
  if (!process.stdin.isTTY || !errLive) die('remote reads keys from a terminal; in a script use tlpt keys right ok');
  const inp = process.stdin;
  const reader = new KeyReader();
  const trail: string[] = [];
  const draw = (note = '') => {
    const keys = `arrows move ${G.sep} enter ok ${G.sep} backspace back ${G.sep} 0-9 ${G.sep} esc leaves`;
    const sent = trail.length ? `   sent ${trail.slice(-6).join(' ')}` : '';
    process.stderr.write('\r' + truncate(`${errPaint.bold('remote')} ${dut.id}  ${errPaint.muted(note || keys)}${sent}`, (process.stderr.columns ?? 80) - 1) + '\x1b[K');
  };
  const leave = (code: number): never => {
    inp.setRawMode(false);
    process.stderr.write('\r\x1b[K');
    process.exit(code);
  };
  // Presses go one request at a time, in order, all that wait together: a burst is one round trip.
  let waiting: string[] = [];
  let sending = false;
  const pump = async () => {
    if (sending) return;
    sending = true;
    while (waiting.length) {
      const run = (await runData(c('keys'), { sequence: waiting.splice(0) }, port, process.cwd(), dut.id, 'q').catch((err: Error) => ({ error: err.message }))) as { error?: string };
      if (run.error) {
        waiting = [];
        draw(run.error.split('\n')[0]);
      }
    }
    sending = false;
  };
  const onKeys = (keys: Key[]) => {
    for (const k of keys) {
      if (k.name === 'escape' || (k.ctrl && k.name === 'c') || k.text === 'q') leave(0);
      const press = k.ctrl || k.meta ? undefined : REMOTE_KEYS[k.name];
      if (!press) continue;
      waiting.push(press);
      trail.push(press);
      draw();
      void pump();
    }
  };
  let esc: NodeJS.Timeout | null = null;
  inp.setRawMode(true);
  inp.setEncoding('utf8');
  inp.on('data', (chunk: string) => {
    if (esc) clearTimeout(esc);
    esc = null;
    onKeys(reader.feed(chunk));
    if (reader.waiting) esc = setTimeout(() => onKeys(reader.flush()), ESC_WAIT_MS);
  });
  inp.resume();
  draw();
  return new Promise<never>(() => {});
}

/** The q commands that wait on the device, each with what its spinner says it is doing. */
const WAITS: Record<string, (a: Args) => string> = {
  capture: (a) => `capture ${Math.min(10, Math.max(1, Number(a.seconds ?? 10) || 1))} s`,
  probe: (a) => `probe ${a.name}`,
  trial: (a) => `trial${a.file ? ` ${basename(String(a.file))}` : ''}`,
  keys: (a) => `keys ${([] as string[]).concat(a.sequence as string[]).join(' ')}`,
  eval: (a) => `eval ${a.expression}`,
};
const HINTS: Record<string, string> = { capture: 'press keys on the device now', trial: 'ctrl+c stops it after the current run' };

/**
 * While a q command waits on the device: a spinner on stderr when it is a terminal, and ctrl+c stops
 * waiting. That aborts the request, and the server ends a trial after the run in progress.
 */
function waiting(c: Command, a: Args, id: string | undefined): { signal?: AbortSignal; done: () => void } {
  const what = WAITS[c.name];
  if (!what) return { done: () => {} };
  const stop = new AbortController();
  const since = Date.now();
  let frame = 0;
  const draw = () => {
    const max = (process.stderr.columns ?? 80) - 1;
    const s = Math.floor((Date.now() - since) / 1000);
    // One line however the expression was written: a newline would leave a copy of it every frame.
    const text = (on: string) => `${G.spin[frame % G.spin.length]} ${[what(a).replace(/\s+/g, ' ') + on, `${s} s`, HINTS[c.name]].filter(Boolean).join(` ${G.sep} `)}`;
    // On a narrow terminal the device is left out before the hint, which says how to stop.
    const full = text(` on ${id ?? 'the newest device'}`);
    const line = width(full) <= max ? full : text('');
    frame++;
    process.stderr.write('\r' + errPaint.muted(truncate(line, max)) + '\x1b[K');
  };
  let timer = errLive ? setInterval(draw, 100) : null;
  if (timer) draw();
  const done = () => {
    process.off('SIGINT', interrupt);
    if (!timer) return;
    clearInterval(timer);
    timer = null;
    process.stderr.write('\r\x1b[K');
  };
  const interrupt = () => {
    stop.abort();
    done();
    say(c.name === 'trial' ? 'stopped; the trial ends on the device after its current run' : 'stopped waiting');
    process.exit(130);
  };
  process.on('SIGINT', interrupt);
  return { signal: stop.signal, done };
}

function open(url: string) {
  if (SSH) return;
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

/** Asks a tlpt already on this port to stop, and waits for the port. False when it isn't one. */
async function retire(port: number): Promise<boolean> {
  const RETIRE_WAIT_MS = 3000;
  // It answers to this user's key, as every tlpt of this user's does; anything else on the port doesn't.
  const key = readKey();
  if (!key) return false;
  const asked = await fetch(`http://127.0.0.1:${port}${BASE}${key}/api/stop`, { method: 'POST', signal: AbortSignal.timeout(1000) })
    .then((r) => r.ok)
    .catch(() => false);
  if (!asked) return false;
  for (const end = Date.now() + RETIRE_WAIT_MS; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
    const free = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(200) }).then(() => false, () => true);
    if (free) return true;
  }
  return false;
}

/** The address `--via` names, or why it isn't one. */
function viaOf(given: string | undefined): URL | null {
  if (given === undefined) return null;
  const u = URL.canParse(given) ? new URL(given) : null;
  if (!u || !/^https?:$/.test(u.protocol)) die(`--via takes the address the device opens, such as https://device.example.com (tlpt --help)`);
  return u;
}

async function dev() {
  const port = Number(values.port);
  const via = viaOf(values.via);
  // A tunnel already running for the app, named by its address or the app's: tlpt serves the
  // app it forwards to and takes the tunnel over while it runs, so the device keeps opening that address.
  const tunnel = given ? await findEndpoint(given, port) : null;
  if (tunnel && !tunnel.app) die(`${tunnel.url} already forwards to tlpt's port; name your app instead, such as tlpt localhost:<its port>`);
  // Nothing named: link the dev server running here, else serve this folder if it is a built site.
  const found = given ? null : ((await findDevServers(DEV_PORTS.filter((p) => p !== port)))[0] ?? null);
  const app = tunnel?.app ?? given ?? found?.origin ?? (existsSync('index.html') ? '.' : undefined);
  if (given) {
    const t = appTarget(given);
    if (t.kind === 'dir' && !existsSync(t.dir)) {
      // A bare word that is nearly a command's name was most likely meant as one.
      const near = /^[a-z-]+$/i.test(given) ? nearest(given, RUNNABLE) : null;
      die(near ? `no command ${given}; did you mean ${near}? (tlpt --help)` : `${given} is not a command, a folder here, a port or an address (tlpt --help)`);
    }
  }

  // The console starts once the server listens; until then nothing can happen to a device.
  let con: Console | null = null;

  /** Tabs that have had DevTools, in this run and, under bin/watch.js, the runs before a restart. */
  const opened = new Set((process.env.TELEPORT_OPENED ?? '').split(',').filter(Boolean));
  /** When DevTools last opened on its own. Anyone with a tunnel's address can connect screens, so past a
   *  few a minute d in the console is the way to open one. */
  const OPENS_PER_MINUTE = 3;
  const recent: number[] = [];
  /** What became of DevTools for each tab, which the console says when the tab connects. */
  const notes = new Map<string, DevtoolsNote>();
  /** What tlpt opens: DevTools, once for each tab, when it connects with none on it. A tab whose
   *  DevTools was closed stays closed; d in the console opens it again. */
  function onTab(id: string, opening: boolean) {
    // Back after a while: nothing opens this time, so the note says where DevTools is.
    if (opened.has(id)) return void notes.set(id, opening ? 'tab' : 'link');
    opened.add(id);
    process.send?.({ type: 'opened', id });
    notes.set(id, opening ? 'tab' : 'link');
    if (opening || !live || values['no-open'] || SSH) return;
    const now = Date.now();
    while (recent.length && now - recent[0]! > 60_000) recent.shift();
    if (recent.length >= OPENS_PER_MINUTE) return;
    recent.push(now);
    open(inspectUrl(port, server.key, id));
    notes.set(id, 'opened');
  }

  const options: DevServerOptions = {
    port,
    host: values.host,
    app,
    insecure: values.insecure,
    manifest: values.manifest,
    via: via?.href,
    onStop: () => quit(`a newer tlpt took over port ${port}`),
    onTab,
    onEvent: (e) => con?.event(e),
    // Every experiment, whoever runs it, is kept on this machine (journal.ts); TELEPORT_JOURNAL=0 keeps none.
    journal: (e) => void keep(e),
  };
  let server: DevServer;
  let retired = false;
  try {
    server = await startDevServer(options).catch(async (e: NodeJS.ErrnoException) => {
      // An older tlpt still on the port is asked to step aside; anything else is left alone.
      if (e.code !== 'EADDRINUSE') throw e;
      retired = await retire(port);
      if (!retired) throw e;
      return startDevServer(options);
    });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    die(err.code === 'EADDRINUSE' ? `port ${port} is in use by something else, try --port ${port + 1}` : err.message);
  }

  // What tlpt serves can change while it runs: a port typed in the console, or a dev server found.
  const took = !!tunnel && (await pointAt(tunnel, `http://localhost:${port}`));
  if (took) owed = () => pointAt(tunnel!, tunnel!.app!);
  let current: { target: AppTarget | null; tunnel: TunnelEndpoint | null; took: boolean; named: string | undefined } = { target: app ? appTarget(app) : null, tunnel, took, named: given };
  // The app's local address, as a person would name it to tlpt.
  const appHost = () => (current.tunnel ? new URL(current.tunnel.app!).host : '');

  const lan = `${lanAddress()}:${port}`;
  // What an app's own teleport.init is given: this laptop on the network, or the address said with --via.
  const relay = via ? `${via.protocol === 'https:' ? 'wss' : 'ws'}://${via.host}` : lan;
  // Sage ink on a white terminal is 1.4:1, and few terminals say they are light in COLORFGBG: ask this
  // one, before the console takes the keyboard. TLPT_THEME settles it without asking.
  if (live && color !== 'none' && themeSaid() === null) {
    const said = lightReply(await askBackground());
    if (said !== null && said !== light) {
      light = said;
      errPaint = paint(depth(errLive), light);
    }
  }
  screen = live ? new TermScreen() : new PlainScreen();
  // --tunnel: any vendor's tunnel command, which tlpt runs pointed at itself; its address is the device link.
  const ownTunnel: { run: RunningTunnel | null; url: string | null } = { run: null, url: null };
  if (values.tunnel !== undefined) {
    try {
      ownTunnel.run = tunnelCommand(values.tunnel, port);
    } catch (e) {
      die((e as Error).message);
    }
  }
  /** Pins the header for what tlpt serves now, and says where the device opens it. With no app, the
   *  device link opens a page that waits for one. */
  let head: string[] = [];
  const show = (): string => {
    const { target, tunnel: t, took: over, named } = current;
    const link = ownTunnel.url ? ownTunnel.url + (target ? entryPath(target) : '/') : over ? t!.url + entryPath(appTarget(named!)) : via ? via.origin + (target ? entryPath(target) : '/') : `http://${lan}${target ? entryPath(target) : '/'}`;
    head = header({
      app: !target ? null : target.kind === 'proxy' ? target.origin.host : target.dir === process.cwd() ? '.' : target.dir,
      empty: screen!.interactive ? 'no app yet · type its port below' : 'no app yet',
      dut: link,
      snippet: AUTO_LINE,
      lan: relay,
      color,
      light,
    });
    // The console pins it with a card for each device under it, once it runs.
    if (con) con.setHeader(head);
    else screen!.pin(head);
    return link;
  };
  const dutLink = show();
  con = new Console({
    screen,
    color,
    light,
    port,
    key: server.key,
    duts: () => server.devices.values(),
    openDevtools: (id) => open(inspectUrl(port, server.key, id)),
    reload: (id) => server.devices.get(id)?.socket?.send('reload'),
    quit: () => quit(),
    dutLink,
    appless: !app,
    connect: (what) => serve(what, false),
    lan: relay,
    devtoolsNote: (id) => notes.get(id),
    header: head,
  });
  if (retired) con.note({ type: 'retired', port });
  const tunnelNote = () => {
    const { target, tunnel: t, took: over } = current;
    if (t) con?.note({ type: 'tunnel', url: t.url, app: appHost(), took: over, port, lan: target ? `http://${lan}${entryPath(target)}` : undefined });
  };
  tunnelNote();
  if (ownTunnel.run) {
    const r = ownTunnel.run;
    r.onExit((why) => {
      ownTunnel.url = null;
      con?.setApp(show(), !current.target);
      con?.note({ type: 'app', app: 'the tunnel', up: false, why });
    });
    void r.url.then((url) => {
      if (!url) return void con?.note({ type: 'app', app: 'the tunnel', up: false, why: 'it printed no https address in 30 s' });
      ownTunnel.url = url;
      con?.setApp(show(), !current.target);
      con?.note({ type: 'own-tunnel', url });
    });
  }

  // An app that doesn't take a connection: one on this machine that isn't listening yet is said, and
  // said again once it is, so a device on the waiting page isn't a mystery; any other says why, once.
  let watching: NodeJS.Timeout | null = null;
  const APP_POLL_MS = 2000;
  function watchApp(target: AppTarget | null) {
    if (watching) clearInterval(watching);
    watching = null;
    if (target?.kind !== 'proxy') return;
    const origin = target.origin;
    void answers(origin).then((no) => {
      if (no === null || current.target !== target) return;
      if (!waitable(origin, no)) return void con?.note({ type: 'app', app: origin.host, up: false, why: why(no) });
      con?.note({ type: 'app', app: origin.host, up: false });
      const poll = (watching = setInterval(
        () =>
          void answers(origin).then((still) => {
            if (still !== null || watching !== poll) return;
            clearInterval(poll);
            watching = null;
            con?.note({ type: 'app', app: origin.host, up: true });
          }),
        APP_POLL_MS,
      ));
      poll.unref();
    });
  }
  watchApp(current.target);

  /**
   * Serves another app from now on, as `tlpt <what>` would have at start: a tunnel already running for
   * it is taken over, the one taken before goes back to its app, and the devices on the old app reload
   * into the new one. Resolves with why not, changing nothing.
   */
  async function serve(what: string, found: boolean): Promise<string | null> {
    const t = await findEndpoint(what, port);
    if (t && !t.app) return `${t.url} already forwards to tlpt's port; type your app's own port instead`;
    const next = t?.app ?? what;
    const target = appTarget(next);
    if (target.kind === 'dir' && !existsSync(target.dir)) return `${what} is not a port, an address or a folder here`;
    try {
      server.setApp(next);
    } catch (e) {
      return (e as Error).message;
    }
    seeking = null;
    // The tunnel taken for the last app goes back to it first.
    if (owed) {
      const pay = owed;
      const was = current.tunnel!;
      owed = null;
      if (!(await pay())) con?.note({ type: 'app', app: was.url, up: false, why: `it still forwards here; point it back at ${new URL(was.app!).host}` });
    }
    const over = !!t && (await pointAt(t, `http://localhost:${port}`));
    if (over) owed = () => pointAt(t!, t!.app!);
    current = { target, tunnel: t, took: over, named: what };
    con?.setApp(show());
    // Devices on the old app, or on the waiting page's next try, open the new one.
    const duts = [...server.devices.values()].filter((d) => d.socket);
    for (const d of duts) d.socket!.send('reload');
    con?.note({ type: 'serving', app: target.kind === 'proxy' ? target.origin.host : target.dir, found, reloaded: duts.length });
    tunnelNote();
    watchApp(target);
    return null;
  }

  // Nothing named and nothing found: keep looking on the common ports, and serve the first dev server
  // that starts. Each look is a dozen requests to this machine, every 2 s, only until there is an app.
  const SEEK_MS = 2000;
  let seeking: boolean | null = !app;
  if (seeking) {
    const look = setInterval(() => {
      if (!seeking) return void clearInterval(look);
      void findDevServers(DEV_PORTS.filter((p) => p !== port)).then((list) => {
        if (!seeking || !list[0]) return;
        seeking = null;
        clearInterval(look);
        void serve(list[0].origin, true);
      });
    }, SEEK_MS);
    look.unref();
  }

  // Builds reported by bin/watch.js when tlpt runs from source.
  process.on('message', (m: { type: string; name: string; error: string | null; reload: 'devices' | null }) => {
    if (m.type !== 'build') return;
    if (m.error) return con?.note({ type: 'build-failed', name: m.name, error: m.error });
    if (m.reload !== 'devices') return;
    const duts = [...server.devices.values()].filter((d) => d.socket);
    for (const d of duts) d.socket!.send('reload');
    con?.note({ type: 'build', name: m.name, reloaded: duts.length });
  });

  let quitting = false;
  /** How long quitting may take: the tunnel going back to the app, then the server closing. */
  const QUIT_WAIT_MS = 5000;
  function quit(why?: string) {
    if (quitting) return;
    quitting = true;
    ownTunnel.run?.stop();
    con?.close();
    screen?.close();
    if (why) say(why);
    // Whatever still holds the server open, tlpt still leaves.
    setTimeout(() => process.exit(0), QUIT_WAIT_MS).unref();
    // The tunnel goes back to the app first, so it never points at a tlpt that has gone.
    const back = owed ? (owed() as Promise<boolean>) : Promise.resolve(true);
    owed = null;
    void back
      .then((ok) => ok || say(`${current.tunnel!.url} still forwards here; run tlpt ${appHost()} again, or restart the tunnel`))
      .then(() => server.close())
      .then(() => process.exit(0));
  }
  // Under bin/watch.js: if that process dies, however it dies, this one goes too and frees the port.
  if (process.send) process.on('disconnect', () => quit());
  // A second ctrl+c while quitting leaves at once.
  process.on('SIGINT', () => (quitting ? process.exit(130) : quit()));
  for (const sig of ['SIGTERM', 'SIGHUP'] as const) process.on(sig, () => quit());
}

// Last, so every table above is initialised before main reads it.
main().catch(crash);
