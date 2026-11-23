// `tlpt replay`: a journey through the app with the remote, kept and pressed again. `replay save` keeps
// the presses the device's page saw (from its own remote or from tlpt's) with the time between them, as
// a tape on this machine; `replay <name>` presses the tape again in the same rhythm while it captures,
// so the answer is a capture of that journey. Run it before and after a change and compare the two in
// `tlpt history`. Tapes are plain JSON in ~/.local/share/teleport/replays/, one file each.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Report } from './analyze.js';
import { keep } from './journal.js';
import type { Caller } from './live.js';
import { request } from './q.js';
import type { KeyId, RemoteRun } from './remote.js';
import { dataDir, modelOf } from './survey.js';

export interface Tape {
  name: string;
  savedAt: string;
  /** The kind of device it was recorded on. */
  model: string;
  /** Each press and the pause after it, as the keys endpoint takes them. */
  steps: { key: KeyId; delayMs: number }[];
  /** From the first press to the last. */
  ms: number;
}

export interface Pressed {
  t: number;
  keyCode: number;
  key: KeyId | null;
}

/** The pause after the last press, and the bounds every pause is kept within. */
const LAST_MS = 500;
const MIN_GAP_MS = 60;
const MAX_GAP_MS = 10_000;
/** A capture is at most this long, so a longer tape is measured for its first 10 s. */
const CAPTURE_MAX_MS = 10_000;

export const replayDir = () => join(dirname(dataDir()), 'replays');

const safeName = (s: string) => s.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

/** A tape from the presses a page saw: presses that are no remote key are left out. */
export function tapeOf(presses: Pressed[], name: string, ua: string, now = new Date()): Tape {
  const keys = presses.filter((p): p is Pressed & { key: KeyId } => !!p.key);
  const steps = keys.map((p, i) => ({ key: p.key, delayMs: i + 1 < keys.length ? Math.min(MAX_GAP_MS, Math.max(MIN_GAP_MS, Math.round(keys[i + 1]!.t - p.t))) : LAST_MS }));
  return { name: safeName(name) || 'journey', savedAt: now.toISOString(), model: modelOf(ua), steps, ms: keys.length > 1 ? Math.round(keys[keys.length - 1]!.t - keys[0]!.t) : 0 };
}

export function saveTape(t: Tape, dir = replayDir()): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${t.name}.json`);
  writeFileSync(file, JSON.stringify(t, null, 1) + '\n', { mode: 0o600 });
  return file;
}

/** The saved tapes, newest first. */
export function listTapes(dir = replayDir()): { name: string; steps: number; ms: number; model: string; savedAt: string }[] {
  if (!existsSync(dir)) return [];
  const out: { name: string; steps: number; ms: number; model: string; savedAt: string; mtime: number }[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const t = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Tape;
      out.push({ name: t.name, steps: t.steps.length, ms: t.ms, model: t.model, savedAt: t.savedAt, mtime: statSync(join(dir, f)).mtimeMs });
    } catch {
      // Not a tape: left alone.
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).map(({ mtime: _m, ...t }) => t);
}

export function loadTape(name: string, dir = replayDir()): Tape {
  const pick = name === 'last' ? listTapes(dir)[0]?.name : safeName(name);
  const file = pick ? join(dir, `${pick}.json`) : '';
  if (!pick || !existsSync(file)) {
    const have = listTapes(dir).map((t) => t.name);
    throw new Error(`no tape ${name}${have.length ? `: there are ${have.slice(0, 8).join(', ')}` : '; replay save <name> keeps the presses the device just saw'}`);
  }
  return JSON.parse(readFileSync(file, 'utf8')) as Tape;
}

interface LiveDevice {
  device: { id: string; ua: string; href: string };
}

async function deviceOf(port: number, id: string | undefined): Promise<LiveDevice['device']> {
  const live = (await request(port, 'live')) as LiveDevice[];
  const d = (id ? live.find((x) => x.device.id === id) : live[live.length - 1])?.device;
  if (!d) throw new Error(id ? `no device ${id}` : 'no device connected');
  return d;
}

/** `replay save`: the presses the device's page saw in the last `seconds`, kept as a tape. */
export async function record(port: number, id: string | undefined, name: string, seconds: number, by: Caller): Promise<{ saved: string; name: string; presses: number; ms: number; skipped: number }> {
  const d = await deviceOf(port, id);
  const seen = (await request(port, 'presses', { id: d.id, by, q: { seconds } })) as { presses: Pressed[] };
  const tape = tapeOf(seen.presses, name, d.ua);
  if (!tape.steps.length) throw new Error(`the page saw no remote key in the last ${seconds} s: press some on the device (or with r), then save`);
  return { saved: saveTape(tape), name: tape.name, presses: tape.steps.length, ms: tape.ms, skipped: seen.presses.length - tape.steps.length };
}

export interface ReplayAnswer {
  name: string;
  presses: number;
  ms: number;
  keys: RemoteRun;
  capture: Report;
  /** The capture covered only the first 10 s of a longer tape. */
  partial: boolean;
}

/** `replay <name>`: presses the tape again in its rhythm while capturing. */
export async function play(port: number, id: string | undefined, name: string, by: Caller): Promise<ReplayAnswer> {
  const tape = loadTape(name);
  const d = await deviceOf(port, id);
  const t0 = Date.now();
  const ms = Math.min(CAPTURE_MAX_MS, Math.max(1000, tape.ms + tape.steps[tape.steps.length - 1]!.delayMs + 500));
  const capture = request(port, 'capture', { id: d.id, by, q: { ms }, post: true, part: true }) as Promise<Report>;
  // The capture starts recording first, so the first press is in it.
  await new Promise((r) => setTimeout(r, 150));
  const keys = request(port, 'keys', { id: d.id, by, body: { steps: tape.steps }, part: true }) as Promise<RemoteRun>;
  const [k, c] = await Promise.all([keys, capture]);
  const out: ReplayAnswer = { name: tape.name, presses: tape.steps.length, ms: tape.ms, keys: k, capture: c, partial: tape.ms + 500 > CAPTURE_MAX_MS };
  keep({ id: d.id, ua: d.ua, href: d.href, by, kind: 'replay', what: `replay ${tape.name}`, ms: Date.now() - t0, result: out, error: k.error ?? undefined });
  return out;
}
