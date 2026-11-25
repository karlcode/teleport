// `tlpt q`: what teleport measured, and the trials it can run, from a shell. One
// command per question, JSON out, so any AI agent with a shell and any person in a terminal use the
// same thing. It's a thin client of a running teleport's HTTP API, which is under this user's key.
// Each command declares its parameters once: the shell reads them from words and --flags, and the MCP
// server (mcp.ts) offers them as tool arguments. The help steers agents to prove a claim with numbers.

import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { keyFile, readKey } from './key.js';
import { PROBE_IDS } from './probes.js';
import { guide } from './guide.js';
import { wrap } from './text.js';
import { describeUa } from './ua.js';
import type { Caller } from './live.js';
import { PLAYBACK_SCRIPT, readManifest, risks } from './playback.js';
import type { Capabilities } from './probes.js';
import { survey } from './survey.js';
import { TOGGLES, tried } from './toggles.js';
import { ensureClips, verdicts, verifySpecs, type Verdict } from './verify.js';
import { advise, readRaw } from './advise.js';
import { reportMarkdown } from './report.js';
import { listSurveys, modelOf, readAdvice, surveyDir, writeReport } from './survey.js';
import { gist, journalFile, readJournal } from './journal.js';
import { listTapes, play, record } from './replay.js';
import { OWN } from './toggles.js';

type Query = Record<string, string | number | undefined>;
export type Args = Record<string, unknown>;

export interface Param {
  name: string;
  help: string;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  /** From the words after the command: the next one, or all that are left. */
  positional?: 'one' | 'rest';
  required?: true;
  enum?: readonly string[];
}

export interface Command {
  name: string;
  /** A few words, at most 26 characters: the palette's and the help's line for it. */
  brief: string;
  help: string;
  /** What running it costs the device, in words; absent when it answers from what the laptop already has. */
  cost?: string;
  /** Changes what runs on the device, rather than only reading or measuring. */
  acts?: true;
  /** For agents and scripts, not the console's list: `tlpt q` and the MCP tools still have it. */
  agents?: true;
  params: Param[];
  /** The API endpoint, its query and its JSON body, from the arguments. `cwd` resolves paths the caller gave. */
  call?(a: Args, cwd: string): { path: string; q?: Query; post?: true; body?: unknown } | Promise<{ path: string; q?: Query; post?: true; body?: unknown }>;
  /** Answers here, without teleport. */
  local?(a: Args): string;
  /** Answers here, as a client of teleport's API: commands that put several calls together. */
  run?(a: Args, port: number, id: string | undefined, cwd: string, by?: Caller): Promise<unknown>;
}

const seconds = (s: unknown, max: number) => (s === undefined ? undefined : Math.min(Math.max(Number(s) || 0, 1), max) * 1000);
const str = (v: unknown) => (v === undefined ? undefined : String(v));
const isUrl = (s: string) => /^https?:\/\//i.test(s);
const place = (cwd: string, x: string) => (isUrl(x) || isAbsolute(x) ? x : resolve(cwd, x));

/** A spec to send: functions become their source, and relative asset paths resolve against `dir`. */
function sendable(raw: unknown, dir: string, what: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${what} is not a trial spec`);
  const spec = { ...(raw as Record<string, unknown>) };
  const src = (v: unknown) => (typeof v === 'function' ? String(v) : v);
  spec.measure = src(spec.measure);
  if (Array.isArray(spec.variants)) spec.variants = spec.variants.map((v) => (v && typeof v === 'object' ? { ...v, before: src(v.before), setup: src(v.setup) } : v));
  if (spec.checks && typeof spec.checks === 'object') spec.checks = Object.fromEntries(Object.entries(spec.checks).map(([k, v]) => [k, typeof v === 'function' ? `(${String(v)})()` : v]));
  if (spec.assets && typeof spec.assets === 'object') spec.assets = Object.fromEntries(Object.entries(spec.assets).map(([k, v]) => [k, typeof v === 'string' ? place(dir, v) : v]));
  return spec;
}

/** A trial file: JSON, or a module whose default export is the spec. */
async function loadSpec(file: string): Promise<Record<string, unknown>> {
  const raw = /\.json$/i.test(file) ? JSON.parse(await readFile(file, 'utf8')) : ((m) => m.default ?? m.trial ?? m)(await import(pathToFileURL(file).href));
  return sendable(raw, dirname(file), file);
}

/** Plays the verify clips on the device, those whose names have one of the words, or all. */
async function verify(only: string[], port: number, id: string | undefined, by?: Caller): Promise<{ verdicts: Verdict[]; notMade: Record<string, string> }> {
  // Ask teleport first: with none running, the answer is one line at once, not after ffmpeg has made
  // every clip (minutes, the first time) for a device that isn't there.
  await request(port, 'live', { by });
  const { paths, failed } = ensureClips((s) => process.stderr.isTTY && process.stderr.write(`\r\x1b[K  ${s}`));
  const out: Verdict[] = [];
  for (const spec of verifySpecs(paths, only)) out.push(...verdicts((await request(port, 'trial', { id, by, body: { spec } })) as Parameters<typeof verdicts>[0]));
  if (process.stderr.isTTY) process.stderr.write('\r\x1b[K');
  return { verdicts: out, notMade: failed };
}

/** Names people say for the clips verify has. */
const CODEC_ALIAS: Record<string, string> = { avc: 'h264', h265: 'hevc', drm: 'clearkey', ac3: 'ac-3', eac3: 'e-ac-3' };

export const COMMANDS: Command[] = [
  {
    name: 'status',
    brief: "each device's last second",
    agents: true,
    help: 'One line per connected device: its id, engine, address, whether DevTools is open, and its latest second.',
    params: [],
    call: () => ({ path: 'live' }),
  },
  {
    name: 'devices',
    brief: "each device, link health",
    help: 'The connected devices, each with its latest 1 Hz sample and link health.',
    params: [],
    call: () => ({ path: 'live' }),
  },
  {
    name: 'device',
    brief: "one device's last minute",
    help: "One device in detail: the last minute of 1 Hz samples (timer lag, long tasks, heap, frames during a capture, key → frame, video, element count), key → frame per focused element, link health, and recent requests. null means the device's engine can't measure it.",
    params: [{ name: 'seconds', type: 'number', help: 'How much history, 60 by default.' }],
    call: (a) => ({ path: 'device', q: { seconds: str(a.seconds) } }),
  },
  {
    name: 'errors',
    brief: 'what the page threw',
    help: "What the device's page threw since it loaded, from its first script on, whether or not DevTools was open: uncaught errors, rejections nothing handled, and scripts or stylesheets that did not load. Each with where (in the code you wrote, when the build left a source map), how far into the page, the source around it when the file came through teleport, and what it most likely means on that engine. The first 8 and the last 8 are kept; the rest are counted.",
    params: [],
    call: () => ({ path: 'errors' }),
  },
  {
    name: 'network',
    brief: "its requests through tlpt",
    help: "The device's requests through teleport, oldest first: method, URL, status, bytes, start (page time), time to first byte and duration.",
    params: [
      { name: 'url', type: 'string', help: 'Only URLs containing this.' },
      { name: 'minMs', type: 'number', help: 'Only requests that took at least this long.' },
      { name: 'failed', type: 'boolean', help: 'Only failed requests.' },
      { name: 'limit', type: 'number', help: 'How many, 50 by default.' },
    ],
    call: (a) => ({ path: 'network', q: { url: str(a.url), minMs: str(a.minMs), failed: a.failed ? 1 : undefined, limit: str(a.limit) } }),
  },
  {
    name: 'capture',
    brief: "fps and key → frame",
    cost: "the agent records every frame while it runs; nothing else",
    help: 'Records every frame and key press for up to 10 s and returns fps, frame-time p50/p95/p99, slow frames, long tasks, timer lag, key → frame and the slowest resources. Ask the person to press keys on the device during it if input matters.',
    params: [{ name: 'seconds', type: 'number', positional: 'one', help: 'How long, 1 to 10; 10 by default.' }],
    call: (a) => ({ path: 'capture', q: { ms: seconds(a.seconds, 10) }, post: true }),
  },
  {
    name: 'probe',
    brief: "what the engine supports",
    cost: "one script, answered by the agent",
    help: "What the device's engine can do, asked on the device: identity (model, screen, memory), features (CSS, JavaScript syntax, APIs), media (MediaSource and canPlayType per codec, key systems with robustness, video APIs), graphics (WebGL limits and extensions), storage, dom, focus, and speed (how long four fixed pieces of work take: the yardstick to compare devices by).",
    params: [{ name: 'name', type: 'string', positional: 'one', required: true, enum: PROBE_IDS, help: 'Which probe.' }],
    call: (a) => ({ path: 'probe', q: { name: str(a.name) } }),
  },
  {
    name: 'styles',
    brief: "CSS the engine drops",
    cost: "a few small scripts, answered by the agent",
    help: "What this device's engine drops from the app's style sheets: selectors it can't parse, which lose the whole rule, and declarations it doesn't know, each with the file and line it is first on and how often it is used. The engine's own parser is asked; DevTools can't show these, because the engine never kept them.",
    params: [],
    call: () => ({ path: 'styles' }),
  },
  {
    name: 'guide',
    brief: "what to try on a device",
    agents: true,
    help: 'What is worth trying on a device, before a trial. Topics: startup, bundle and transpile target, polyfills, main thread, paint, compositing, layout, CSS support, images, fonts, video, DRM, punch-through, memory, garbage collection, timers, remote keys, network, caching, data, storage, graphics, workers and engine quirks. Each says why it matters on a device, which profile numbers show it, ES5 checks that ask the engine, and variants to try. Without words, the list.',
    params: [{ name: 'words', type: 'string', positional: 'rest', help: 'A topic or a question, in plain words.' }],
    local: (a) => JSON.stringify(guide(str(a.words) ?? ''), null, 1),
  },
  {
    name: 'trial',
    brief: "compare variants, measured",
    cost: "a frame over the app for each run; the inspector is held",
    help: "Tries things on the device several ways, several times, and compares them. Every run is profiled without being asked: load, frames, main-thread blocking, key → frame (when keys are pressed), JS heap, DOM size, forced layout, decoded images, requests and media; a measure adds numbers of its own. Each run gets a fresh blank frame over the page (or runs in the page), so nothing reaches the app. The report gives medians, 95% intervals against the first variant, and notes that say what a clear difference means on a device and what the engine couldn't measure. A trial is a file (.json, or .mjs whose default export is the spec) or a spec: variants (each with html, scripts, before, setup, vars), keys, observeMs, checks (ES5 expressions read once: the why), measure, runs, assets, better, where. All code runs on the device, so write ES5. Start with `guide`. It covers the screen while it runs.",
    acts: true,
    params: [
      { name: 'file', type: 'string', positional: 'one', help: 'A trial file (.json or .mjs), relative to where you run this.' },
      { name: 'spec', type: 'object', help: 'The trial itself, instead of a file. In a shell, --spec with JSON.' },
    ],
    call: async (a, cwd) => {
      if (a.spec !== undefined) return { path: 'trial', post: true, body: { spec: sendable(a.spec, cwd, 'spec') } };
      const file = str(a.file);
      if (!file) throw new Error('trial needs a file (.json or .mjs) or a spec');
      return { path: 'trial', post: true, body: { spec: await loadSpec(place(cwd, file)) } };
    },
  },
  {
    name: 'keys',
    brief: "press remote keys",
    cost: "key events in the page, sent by the agent; changes it",
    help: 'Presses remote keys on the device in order, such as right,right,down,ok or back. It changes the running page: say what you pressed.',
    acts: true,
    params: [{ name: 'sequence', type: 'array', positional: 'rest', required: true, help: 'Key names: up, down, left, right, ok, back, 0 to 9, red, green, yellow, blue, play, pause, stop, rewind, forward.' }],
    call: (a) => ({ path: 'keys', q: { seq: ((a.sequence as unknown[]) ?? []).map(String).join(',') }, post: true }),
  },
  {
    name: 'hear',
    brief: 'what the page hears',
    cost: 'a key listener in the page while it listens',
    acts: true,
    help: "Listens in the device's page and names every key press and controller button it hears: which remote key it is (OK is Enter 13 on most, gamepad A 195 from a controller on Windows), whether the device or teleport pressed it, and what the page did with it (cancelled it, moved focus, or a click followed). Press keys on the device's own remote meanwhile. A key the device sends differently from teleport is remembered for that kind of device, and the remote sends it from then on.",
    params: [
      { name: 'seconds', type: 'number', positional: 'one', help: 'How long to listen, 1 to 60; 10 by default.' },
      { name: 'forget', type: 'boolean', help: 'Forget the keys this kind of device was heard sending first.' },
    ],
    // 0 seconds hands over what was heard since the last read, at once: the console's remote mode asks so.
    call: (a) => ({ path: 'hear', q: { ms: String(Number(a.seconds) === 0 ? 0 : seconds(a.seconds ?? 10, 60)), forget: a.forget ? '1' : undefined }, post: true }),
  },
  {
    name: 'keymap',
    brief: 'what each remote key sends',
    help: "What each of the remote's keys sends on this kind of device (ok, back and the arrows), and which of those were set by hand or heard from the device's own remote. With a key and a code, the key sends that from now on, for every device of this kind: `keymap ok 195` or `keymap ok GamepadA`. `keymap ok reset` puts it back. Use it when the app answers a key the remote doesn't send, such as gamepad A for OK from a controller.",
    acts: true,
    params: [
      { name: 'key', type: 'string', positional: 'one', help: 'A remote key: ok, back, up, down, left, right, 0 to 9, a colour or a media key.' },
      { name: 'code', type: 'string', positional: 'one', help: 'A key code (195) or a key name (GamepadA), or reset.' },
    ],
    call: (a) => (a.key ? { path: 'keymap', q: { key: str(a.key), code: str(a.code ?? 'reset') }, post: true } : { path: 'keymap' }),
  },
  {
    name: 'eval',
    brief: "run ES5 in the page",
    cost: "your code runs in the page, by the agent; changes it",
    help: "Runs a JavaScript expression in the page on the device and returns the result. The engine may be years old (often ES5 only). It changes the running page: say what you ran.",
    acts: true,
    params: [{ name: 'expression', type: 'string', positional: 'rest', required: true, help: 'ES5 to run in the page.' }],
    // In the body: a long expression in a URL is refused before the server reads it.
    call: (a) => ({ path: 'eval', body: { expr: str(a.expression) } }),
  },
  {
    name: 'playback',
    brief: "what plays, its tracks",
    cost: "One script that reads the page's media elements and player; laptop fetches the manifest",
    help: "What the device is playing right now, read generically: each video and audio element (source, size, time, buffer, errors, tracks, dropped frames), the player library driving it (Shaka, hls.js, dash.js, video.js) with its variant tracks, stats and DRM, the content's title, and the manifest parsed on this laptop into its ladder (codecs, resolutions, bitrates, audio channels, languages, HDR, DRM systems). Then the risks: codecs in the manifest the device said no to, mixed codec families that need changeType, a ladder above the screen, DRM the device lacks.",
    params: [],
    run: async (_a, port, id, _cwd, by) => {
      const pb = (await request(port, 'eval', { id, by, body: { expr: PLAYBACK_SCRIPT } })) as { value: { players?: { manifestUri?: string | null }[]; manifests?: string[] } };
      const v = pb.value ?? {};
      const urls = [...new Set([...(v.players ?? []).map((p) => p.manifestUri), ...(v.manifests ?? [])].filter((u): u is string => !!u && /^https?:/.test(u)))].slice(0, 4);
      const manifests = await Promise.all(urls.map(readManifest));
      const media = await request(port, 'probe', { id, by, q: { name: 'media' } }).catch(() => null);
      const flat = Object.fromEntries((((media as Capabilities | null)?.groups) ?? []).flatMap((g) => g.items).map((i) => [i.k, i.v]));
      return { ...v, manifests, risks: risks(manifests.flatMap((m) => m.renditions), flat, null) };
    },
  },
  {
    name: 'survey',
    brief: "everything, saved locally",
    cost: "Every probe but speed, a 10 s capture and the playback read",
    help: "Everything about the device and what it plays, in one go, saved on this machine (~/.local/share/teleport/devices/<model>/<time>-<title>/): every probe, a capture, the last minute, the network log, the errors, the CSS the engine drops, the playback read with the manifest's ladder, and (with --verify) real clips played. Writes raw/*.json, summary.json, advice.json, README.md and report.html (the advice, most important first) and, when the model was surveyed before, diff.md. Storage values, tokens and signed URL parameters are never written.",
    params: [
      { name: 'label', type: 'string', positional: 'rest', help: 'A name for this run, such as the title playing; read from the page otherwise.' },
      { name: 'speed', type: 'boolean', help: 'Also run the speed probe (holds the page a second or more).' },
      { name: 'capture', type: 'number', help: 'Seconds of capture, 0 to skip; 10 by default.' },
      { name: 'verify', type: 'boolean', help: 'Also play the verify clips, so advice rests on what decoded, not on what the browser said.' },
      { name: 'out', type: 'string', help: 'A folder to write to instead.' },
    ],
    run: async (a, port, id, cwd, by) => {
      // Progress goes to the shell's terminal only: the console draws its own spinner, and a write to
      // its stderr would tear the screen.
      const shell = by === 'q' && process.stderr.isTTY;
      const r = await survey({ port, id, by, label: str(a.label), speed: !!a.speed, verify: !!a.verify, capture: a.capture === undefined ? 10 : Number(a.capture), out: a.out ? place(cwd, String(a.out)) : undefined, log: (s) => shell && process.stderr.write(`\r\x1b[K  ${s}`) });
      if (shell) process.stderr.write('\r\x1b[K');
      const report = join(r.dir, 'report.html');
      const reportUrl = pathToFileURL(report).href;
      // Piped output is JSON for a script; a person watching still gets where it went, on stderr.
      if (by === 'q' && process.stderr.isTTY && !process.stdout.isTTY) process.stderr.write(`  report  ${reportUrl}\n`);
      return { dir: r.dir, report, reportUrl, advice: readAdvice(r.dir), ...r.summary };
    },
  },
  {
    name: 'verify',
    brief: "play real clips on it",
    cost: "A frame over the app for each run, playing 2 s clips. It runs through the inspector, which stays loaded a minute after the last run.",
    acts: true,
    help: "Confirms what the media probe only says: plays real 2 s clips on the device through MediaSource, made once on this laptop with ffmpeg and cached in ~/.cache/teleport/media. H.264, HEVC (8 and 10-bit, 1080p and 2160p), VP9, AV1, AAC, AC-3, E-AC-3 and Opus; a switch from 720p to 1080p, 1080p to 2160p, H.264 to HEVC and back (changeType where the engine has it); and ClearKey DRM with a licence made on the device. Each plays only if frames decode and the clock moves. Answers per variant: plays, why not, time to first frame, dropped frames, and whether isTypeSupported had said yes.",
    params: [{ name: 'only', type: 'array', positional: 'rest', help: 'Words that pick variants, such as hevc or switch; all otherwise.' }],
    run: (a, port, id, _cwd, by) => verify((a.only as string[] | undefined) ?? [], port, id, by),
  },
  {
    name: 'try',
    brief: 'flip one thing, measured',
    cost: 'a frame over the app for each run; the inspector is held',
    help: `Flips one thing on the device and measures it both ways, with nothing to write. With no words, lists what there is to try. A toggle's name (${TOGGLES.map((t) => t.name).join(', ')}) runs a ready-made trial: the same rail of tiles moved with the remote's keys, without the thing and with it, so the differences in the report are what that one thing costs on this engine. \`css\` and some rules tries your own app, as it is against with the rules added (they are taken out after each run). \`js\` and some ES5 times your code on a blank page against the page without it; \`html\` and some markup draws it against the rail, the same keys pressed on both. \`codec\`, or a codec's name (hevc, av1, vp9, ac3, drm, switch), plays real clips, as verify does. The answer is a trial report: medians, the 95% interval and the run count for every profile metric.`,
    acts: true,
    params: [
      { name: 'what', type: 'array', positional: 'rest', help: `A toggle (${TOGGLES.map((t) => t.name).join(', ')}), or ${OWN.map((t) => t.name).join(', ')}; nothing lists them.` },
      { name: 'runs', type: 'number', help: 'Runs of each side, 5 by default.' },
      { name: 'keys', type: 'array', help: 'Remote keys to press in each run, such as down,down,up,up; right ×4 then left ×4 by default.' },
    ],
    run: async (a, port, id, _cwd, by) => {
      const t = tried((a.what as string[] | undefined) ?? [], { runs: a.runs === undefined ? undefined : Number(a.runs), keys: a.keys as string[] | undefined });
      if ('list' in t) return { toggles: t.list };
      if ('verify' in t) return verify(t.verify.map((w) => CODEC_ALIAS[w.toLowerCase().replace(/[.-]/g, '')] ?? w), port, id, by);
      return request(port, 'trial', { id, by, body: { spec: t.spec } });
    },
  },
  {
    name: 'replay',
    brief: 'a journey, pressed again',
    cost: 'key events in the page, and a capture while they play',
    acts: true,
    help: "Keeps a journey through the app with the remote, and presses it again in the same rhythm while capturing, so the answer is a capture of that journey: fps, frame times and key → frame. `replay save <name>` keeps the presses the device's page saw in the last minute (--seconds for more), from its own remote or from tlpt's, on this machine (~/.local/share/teleport/replays/). `replay <name>` plays one, `replay last` the newest; nothing lists them. A capture is at most 10 s, so a longer journey is measured for its first 10 s. Play it before and after a change and compare the two in history.",
    params: [
      { name: 'words', type: 'array', positional: 'rest', help: 'save and a name, a name to play, last, or nothing to list.' },
      { name: 'seconds', type: 'number', help: 'save: how far back, 60 by default.' },
    ],
    run: async (a, port, id, _cwd, by) => {
      const [first, ...rest] = ((a.words as string[] | undefined) ?? []).map(String);
      if (!first || first === 'list') return { tapes: listTapes() };
      if (first === 'save') return record(port, id, rest.join('-') || `journey-${new Date().toISOString().slice(5, 16).replace(/\D/g, '')}`, Number(a.seconds) || 60, by ?? 'q');
      if (rest.length) throw new Error(`replay plays one tape: replay ${first}`);
      return play(port, id, first, by ?? 'q');
    },
  },
  {
    name: 'shim',
    brief: 'fill in what it lacks',
    cost: 'a script ahead of the app on every page while on; the devices reload into it',
    acts: true,
    help: "A way past the errors an old engine throws on a modern app. `shim on` loads small polyfills on every page tlpt serves, after the agent and ahead of the app's own scripts, for the built-ins most often missing on old Chromium: Object.assign, entries and values, Array.from, find, includes and flat, String startsWith, includes and padStart, Number.isNaN, NodeList.forEach, Element.closest, Promise.prototype.finally, requestIdleCallback and CustomEvent, each only where the engine lacks it, and reloads the devices into it. `shim off` takes it out. With no word, says whether it is on and what the page filled. It is to see past one error to the next on a device, not a fix: give the build a target and polyfills of its own.",
    params: [{ name: 'state', type: 'string', positional: 'one', enum: ['on', 'off'], help: 'on or off; nothing says what the page filled.' }],
    call: (a) => (a.state ? { path: 'shim', q: { on: a.state === 'on' ? '1' : '0' }, post: true } : { path: 'shim' }),
  },
  {
    name: 'history',
    brief: 'every experiment, kept',
    help: "Every experiment run on this kind of device, newest first, from the journal this machine keeps (~/.local/share/teleport/journal.jsonl): captures, probes, trials and tries, styles, evals, key presses, replays and surveys, whoever ran them, each with when, the page, how long and a line of its answer. The journal keeps each answer whole. --all for every kind of device.",
    params: [
      { name: 'limit', type: 'number', help: 'How many, 20 by default.' },
      { name: 'all', type: 'boolean', help: 'Every kind of device, not only the one connected.' },
    ],
    run: async (a, port, id) => {
      let model: string | undefined;
      if (!a.all) {
        const live = (await request(port, 'live').catch(() => [])) as { device: { id: string; ua: string } }[];
        const d = (id ? live.find((x) => x.device.id === id) : live[live.length - 1])?.device;
        if (d) model = modelOf(d.ua);
      }
      const list = readJournal({ model, limit: Math.min(Math.max(Number(a.limit) || 20, 1), 500) });
      return { file: journalFile(), model: model ?? null, experiments: list.map(({ result: _r, ...e }) => ({ ...e, gist: gist({ ...e, result: _r }) })) };
    },
  },
  {
    name: 'advise',
    brief: "what to change, and how",
    cost: "With no survey: the probes, a 10 s capture, the playback read and the styles read",
    help: "Advice for the app on this device, most important first (must, should, could), each with what was measured, what to change and how to prove it: codecs to keep out of the ladder, whether codec or resolution switching is safe, slow DRM setup, slow key presses and which phase costs, frame rate under video, CSS the engine drops or animates badly, script and image weight, duplicate and failed requests, the build target. Reads a saved survey (a folder, or `latest` for the newest of any device), else measures the device now without saving.",
    params: [{ name: 'from', type: 'string', positional: 'one', help: "A survey folder, or latest; the live device otherwise." }],
    run: async (a, port, id, cwd, by) => {
      if (a.from) return advise(readRaw(surveyDir(String(a.from), cwd)));
      const ask = (path: string, opts: Parameters<typeof request>[2] = {}) => request(port, path, { id, by, ...opts }).catch((e: Error) => ({ error: e.message }));
      const raw: Record<string, unknown> = {};
      for (const p of ['identity', 'media', 'features', 'graphics', 'dom']) raw[p] = await ask('probe', { q: { name: p } });
      raw.capture = await ask('capture', { q: { ms: 10_000 }, post: true });
      raw.device = await ask('device', { q: { seconds: 60 } });
      raw.network = await ask('network', { q: { limit: 500 } });
      raw.styles = await ask('styles');
      const pb = await ask('eval', { body: { expr: PLAYBACK_SCRIPT } });
      raw.playback = pb && typeof pb === 'object' && 'value' in pb ? pb.value : pb;
      return advise(raw);
    },
  },
  {
    name: 'report',
    brief: "one file: facts and advice",
    help: "The report for a saved survey, as one file: the device's facts and the advice, most important first. Rewrites advice.json, README.md and report.html in the survey folder from its raw answers (so new advice rules apply to old surveys), then prints where. --md prints the Markdown instead; --list lists the surveys on this machine.",
    params: [
      { name: 'from', type: 'string', positional: 'one', help: 'A survey folder, or latest (the default).' },
      { name: 'md', type: 'boolean', help: 'Print the Markdown report.' },
      { name: 'list', type: 'boolean', help: 'List saved surveys, newest first.' },
    ],
    run: async (a, _port, _id, cwd) => {
      if (a.list) return listSurveys();
      const dir = surveyDir(String(a.from ?? 'latest'), cwd);
      const rep = writeReport(dir);
      if (a.md) return reportMarkdown(rep);
      return { html: join(dir, 'report.html'), markdown: join(dir, 'README.md'), must: rep.advice.filter((x) => x.level === 'must').length, should: rep.advice.filter((x) => x.level === 'should').length, could: rep.advice.filter((x) => x.level === 'could').length, advice: rep.advice.map((x) => `${x.level}: ${x.title}`) };
    },
  },
  {
    name: 'reserve',
    brief: 'hold a device for a run',
    agents: true,
    acts: true,
    cost: 'A thin frame on its screen while it is held; its errors and requests so far are forgotten',
    help: "Reserves a device for a test run: the one --id names, else the first nobody holds. Answers its id and a token. While it is held, calls that act on it without the token are refused (423), so two runs never drive one screen; set TLPT_HOLD to the token and every tlpt q call shows it. The hold ends at `release`, or when its holder makes no call for its time. `cdp` in the answer is a DevTools protocol socket for Playwright's connectOverCDP that shows this device alone.",
    params: [
      { name: 'as', type: 'string', help: "Who holds it, as the device's frame and the console say: a suite's name." },
      { name: 'seconds', type: 'number', help: 'How long the hold outlives the last call made with it, 120 by default, 600 at most.' },
      { name: 'noFrame', type: 'boolean', help: "Leaves the frame off the device's screen, for a run that measures frames." },
    ],
    call: (a) => ({ path: 'reserve', post: true, q: { as: str(a.as), ms: seconds(a.seconds, 600), frame: a.noFrame ? 0 : undefined } }),
  },
  {
    name: 'release',
    brief: 'let a held device go',
    agents: true,
    acts: true,
    help: 'Ends the hold TLPT_HOLD names, and takes the frame off the device.',
    params: [],
    call: () => ({ path: 'release', post: true }),
  },
  {
    name: 'clear',
    brief: 'forget errors and requests',
    agents: true,
    acts: true,
    help: "Forgets what the device's page threw and the requests it made so far, so `errors` and `network` answer for what comes next: between two suites, or two tests.",
    params: [],
    call: () => ({ path: 'clear', post: true }),
  },
];

/** The commands that only read or measure. */
export const READ_COMMANDS = COMMANDS.filter((c) => !c.acts).map((c) => c.name);

function json(v: string, flag: string): unknown {
  try {
    return JSON.parse(v);
  } catch (e) {
    throw new Error(`--${flag} is JSON: ${(e as Error).message}`);
  }
}

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const camel = (s: string) => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/** A parameter as usage writes it: `<name>` or `[name]`, `<name...>` for the rest, `--name n` for a flag. */
export function paramForm(p: Param): string {
  if (p.positional) {
    const word = p.positional === 'rest' ? `${p.name}...` : p.name;
    return p.required ? `<${word}>` : `[${word}]`;
  }
  return `--${kebab(p.name)}${p.type === 'boolean' ? '' : ` ${p.type === 'number' ? 'n' : p.type === 'object' ? 'json' : p.name}`}`;
}

export function usageOf(c: Command): string {
  const words = c.params.filter((p) => p.positional).map(paramForm);
  const flags = c.params.filter((p) => !p.positional).map((p) => `[${paramForm(p)}]`);
  return [c.name, ...words, ...flags].join(' ');
}

/**
 * What a command does to the device, which groups q's help: it reads what this laptop already has, it
 * measures on the device and leaves the page as it was, or it changes the page.
 */
export const groupOf = (c: Command): 'read' | 'measure' | 'change' => (c.acts ? 'change' : c.cost ? 'measure' : 'read');

/**
 * Examples, each with what it shows: help and Q_USAGE print these, so they can't drift apart. The
 * first six are q's own short help; each command's help shows those that start with its name.
 */
export const Q_EXAMPLES: [string, string][] = [
  ['status', "each device's last second"],
  ['capture 5', '5 s of frames; press keys on the device meanwhile'],
  ['network --failed', 'the requests that failed'],
  ['probe media', 'codecs, key systems, robustness'],
  ['trial examples/trials/focus-ring.mjs', 'variants, runs, 95% intervals'],
  ['keys right right ok', 'press remote keys'],
  ['devices --json', 'JSON, even in a terminal'],
  ['device --seconds 30', 'one device, the last 30 s'],
  ['network --url /api/ --min-ms 500', 'slow API calls'],
  ['probe storage --id k3x9q2ab --json > storage.json', "one device's storage, saved as JSON"],
  ['guide polyfills', 'what to try, and how to measure it'],
  ['trial --spec \'{"variants":[{"name":"a"},{"name":"b","scripts":["https://cdn/p.js"]}]}\'', 'a trial without a file'],
  ['eval "navigator.userAgent"', 'run ES5 in the page'],
];

/** The closest of `names` to `word`, when it is a likely typo (at most 2 edits); null otherwise. */
export function nearest(word: string, names: readonly string[]): string | null {
  let best: string | null = null;
  let bestD = 3;
  for (const n of names) {
    const d = distance(word.toLowerCase(), n.toLowerCase());
    if (d < bestD) [best, bestD] = [n, d];
  }
  return best;
}

/** Levenshtein distance, two rows. */
function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

/** Text wrapped for a 100-column page, which is how agents and pagers read the long help. */
const page = (text: string, indent = '') => wrap(text, 99 - indent.length).map((l) => indent + l).join('\n');

/** q's help in full, for agents: what a piped `tlpt q --help` prints, and what an unknown command shows. */
export const Q_USAGE = `tlpt q <command> [arguments] [--flags] [--id <device>] [--port 7070] [--json]

${page("Asks a device connected to the tlpt running on this machine. One command per question. Piped, or with --json, the answer is JSON, so a shell, a script or an AI agent reads it the same way; in a terminal it is printed for a person. Every number was measured on the device; where its engine can't measure something the value is null.")}

${COMMANDS.map((c) => `  ${usageOf(c)}\n${page(c.help, '      ')}`).join('\n')}

  --id <device>         which device, by the id status shows; the newest one otherwise
  --all                 every connected device at once, each answer under its id
  --port 7070       where tlpt listens, if not 7070 (or set TELEPORT_PORT)
  --json            JSON even in a terminal; piped output is always JSON
  --<name> v        a command's own flags, as listed; booleans take no value
  <command> --help  one command in full, and what it costs the device

EXAMPLES
${Q_EXAMPLES.map(([e]) => `  tlpt q ${e}`).join('\n')}

${page('A trial file is .json, or .mjs whose default export is the spec: variants (name, html, scripts, before, setup, vars), keys, keyGapMs, observeMs, checks, measure, runs, timeoutMs, assets, better, profile, where. All of it runs on the device, so write ES5. Start with guide.')}
A performance claim needs a trial behind it: medians, the 95% interval and the run count.`;

/** Splits `--name value` and bare `--flag` from positionals. */
export function parseQ(argv: string[]): { name: string; pos: string[]; flags: Record<string, string> } {
  const pos: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) pos.push(a);
    else if (a === '--all') flags.all = '';
    else if (i + 1 < argv.length && !argv[i + 1]!.startsWith('--')) flags[a.slice(2)] = argv[++i]!;
    else flags[a.slice(2)] = '';
  }
  return { name: pos.shift() ?? '', pos, flags };
}

/** A command's arguments from shell words and --flags. Throws on a missing one or an unknown flag. */
export function argsFromWords(c: Command, pos: string[], flags: Record<string, string>): Args {
  const a: Args = {};
  const words = [...pos];
  for (const p of c.params) {
    if (p.positional === 'one' && words.length) a[p.name] = words.shift();
    else if (p.positional === 'rest' && words.length) a[p.name] = p.type === 'array' ? words.splice(0) : words.splice(0).join(' ');
  }
  // A word the command doesn't take is a mistake to say, not one to ignore: `capture 5 s` isn't 5 seconds.
  if (words.length) throw new Error(`${c.name} takes no word "${words[0]}"\n\n  ${usageOf(c)}`);
  for (const [k, v] of Object.entries(flags)) {
    if (k === 'id') continue;
    // A positional can also be given by name (`capture --seconds 5`), as it could before it was positional.
    const p = c.params.find((x) => x.name === camel(k));
    if (!p) throw new Error(`${c.name} takes no --${k}\n\n  ${usageOf(c)}`);
    a[p.name] = p.type === 'number' ? Number(v) : p.type === 'boolean' ? v !== 'false' : p.type === 'object' ? json(v, k) : p.type === 'array' ? v.split(/[\s,]+/).filter(Boolean) : v;
  }
  checkArgs(c, a);
  return a;
}

/** Throws saying which required argument is missing or which value is not allowed. */
export function checkArgs(c: Command, a: Args) {
  for (const p of c.params) {
    const v = a[p.name];
    if (v === undefined || v === '' || (Array.isArray(v) && !v.length)) {
      if (p.required) throw new Error(`${c.name} needs ${p.name}: ${p.help}\n\n  ${usageOf(c)}`);
    } else if (p.enum && !p.enum.includes(String(v))) throw new Error(`${p.name} is one of ${p.enum.join(', ')}`);
  }
}

/** One entry of `api/live`, as far as `status` reads it. */
interface LiveDevice {
  device: { id: string; ua: string; ip: string; inspecting: boolean };
  latest: { lagMs: number | null; longTaskMs: number; longTasks: number; heapMB: number | null; heapLimitMB: number | null; domNodes: number | null; keyToFrameMs: number | null } | null;
}

const r1 = (x: number) => Math.round(x * 10) / 10;

/** The latest second on a device, in a few words; what the engine can't measure is left out. */
export function latestLine(p: LiveDevice['latest']): string {
  if (!p) return 'no sample yet';
  const out: string[] = [];
  if (p.lagMs !== null) out.push(`timer lag ${r1(p.lagMs)} ms`);
  out.push(p.longTasks ? `${p.longTasks} long task${p.longTasks === 1 ? '' : 's'}, ${Math.round(p.longTaskMs)} ms` : 'no long tasks');
  if (p.heapMB !== null) out.push(`heap ${r1(p.heapMB)} MB${p.heapLimitMB ? ` of ${Math.round(p.heapLimitMB)}` : ''}`);
  if (p.domNodes !== null) out.push(`${p.domNodes} nodes`);
  if (p.keyToFrameMs !== null) out.push(`key → frame ${r1(p.keyToFrameMs)} ms`);
  return out.join(' · ');
}

/** `status`'s lines: short enough to load into an agent's context every time. */
export function statusLines(devices: LiveDevice[], port: number): string {
  if (!devices.length) return `teleport on port ${port}: no device connected.`;
  return devices.map(({ device: d, latest }) => `device ${d.id}  ${describeUa(d.ua)}  ${d.ip}  ${d.inspecting ? 'DevTools open' : 'DevTools closed'}\n  now: ${latestLine(latest)}`).join('\n');
}

/** Aborts when either does; AbortSignal.any where Node has it. */
function anySignal(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([a, b]);
  const c = new AbortController();
  for (const s of [a, b]) s.addEventListener('abort', () => c.abort(s.reason), { once: true });
  return c.signal;
}

/** One call to the API of the teleport on `port`: the parsed answer, or an error saying why not. */
export async function request(port: number, path: string, opts: { q?: Query; post?: boolean; body?: unknown; id?: string; by?: Caller; signal?: AbortSignal; part?: boolean } = {}): Promise<unknown> {
  // The API lives under this user's key, which the teleport that is running made or read (key.ts).
  const key = readKey();
  if (!key) throw new Error(`no teleport has run on this machine as this user (no key in ${keyFile()}). Start it with \`tlpt\`.`);
  const url = new URL(`http://127.0.0.1:${port}/__teleport/${key}/api/${path}`);
  for (const [k, v] of Object.entries({ ...opts.q, id: opts.id })) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    method: opts.post || opts.body !== undefined ? 'POST' : 'GET',
    // A call that is part of a bigger experiment (a survey, a replay) is kept in the journal as that one.
    // A run that reserved a device shows its hold on every call (TLPT_HOLD), which also picks that device.
    headers: { 'x-teleport': opts.by ?? 'q', ...(process.env.TLPT_HOLD ? { 'x-teleport-hold': process.env.TLPT_HOLD } : null), ...(opts.part ? { 'x-teleport-part': '1' } : null), ...(opts.body !== undefined ? { 'content-type': 'application/json' } : null) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal ? anySignal(opts.signal, AbortSignal.timeout(300_000)) : AbortSignal.timeout(300_000),
  }).catch((e: Error) => {
    if (opts.signal?.aborted) throw new Error('stopped');
    // It was there and said nothing in time; "no teleport" would send the person to start one.
    if (e.name === 'TimeoutError') throw new Error(`tlpt on port ${port} gave no answer in 300 s`);
    throw new Error(`no teleport on port ${port} (${(e.cause as Error | undefined)?.message ?? e.message}). Start it with \`tlpt\`.`);
  });
  // What answers may not be teleport, or may refuse before it reads the request: said as it is.
  const text = await res.text();
  let out: { error?: string } | null = null;
  try {
    out = JSON.parse(text) as { error?: string };
  } catch {
    throw new Error(`port ${port} answered ${res.status}${res.statusText ? ` ${res.statusText}` : ''}, not as tlpt does. Is that tlpt, and this version of it?`);
  }
  if (!res.ok) throw new Error(out?.error ?? res.statusText);
  return out;
}

/** Runs one command and resolves with its answer as data; a local command (guide) answers here. */
export async function runData(c: Command, a: Args, port: number, cwd = process.cwd(), id?: string, by: Caller = 'q', signal?: AbortSignal): Promise<unknown> {
  if (c.local) return JSON.parse(c.local(a));
  if (c.run) return c.run(a, port, id, cwd, by);
  const { path, q, post, body } = await c.call!(a, cwd);
  return request(port, path, { q, post, body, id, by, signal });
}

/** Runs one command with its arguments against teleport on `port`; resolves with what to print, or rejects with why. */
export async function runCommand(c: Command, a: Args, port: number, cwd = process.cwd(), id?: string, by: Caller = 'q'): Promise<string> {
  if (c.local) return c.local(a);
  const out = await runData(c, a, port, cwd, id, by);
  return c.name === 'status' ? statusLines(out as LiveDevice[], port) : JSON.stringify(out, null, 1);
}

/** Runs one command from shell words against teleport on `port`. */
export async function runQ(argv: string[], port: number, cwd = process.cwd()): Promise<string> {
  const { name, pos, flags } = parseQ(argv);
  const c = COMMANDS.find((x) => x.name === name);
  if (!c) throw new Error(name ? `no command ${name}${((n) => (n ? `; did you mean ${n}?` : ''))(nearest(name, COMMANDS.map((x) => x.name)))}\n\n${Q_USAGE}` : Q_USAGE);
  // --all: the same thing on every connected device at once, each answer under its device's id.
  if ('all' in flags && !c.params.some((p) => p.name === 'all')) {
    delete flags.all;
    const a = argsFromWords(c, pos, flags);
    const ids = ((await request(port, 'live')) as LiveDevice[]).map((d) => d.device.id);
    if (!ids.length) throw new Error('no device connected');
    const out = await Promise.all(ids.map((id) => runData(c, a, port, cwd, id).catch((e: Error) => ({ error: e.message }))));
    return JSON.stringify(Object.fromEntries(ids.map((id, i) => [id, out[i]])), null, 1);
  }
  return runCommand(c, argsFromWords(c, pos, flags), port, cwd, flags.id || undefined);
}
