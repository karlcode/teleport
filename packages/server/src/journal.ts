// Every experiment run on a device, kept on this machine in one file beside the surveys:
// $XDG_DATA_HOME/teleport/journal.jsonl (by default ~/.local/share/teleport/journal.jsonl), one line of
// JSON each: when, which device, what ran, who asked, how long, and its answer, scrubbed as a survey
// is. Captures, probes, trials and tries, styles, evals, key presses, replays and surveys all land
// here, whoever ran them: the console, `tlpt <command>` or an agent. `tlpt history` reads it back.
// Nothing here leaves the machine, and a write that fails costs the experiment nothing.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Caller } from './live.js';
import { dataDir, modelOf, scrub } from './survey.js';
import { describeUa } from './ua.js';

/** An experiment as the server knows it when it ends. */
export interface ExperimentInput {
  id: string;
  ua: string;
  href: string;
  by: Caller;
  /** capture, probe, trial, styles, eval, keys, replay, survey. */
  kind: string;
  /** The line, as the console's log says it: `probe media`, `trial shadow`. */
  what: string;
  ms: number;
  error?: string;
  result?: unknown;
}

/** One line of the journal. */
export interface Experiment {
  at: string;
  id: string;
  model: string;
  engine: string;
  /** The page's path, without its query: what was on screen. */
  page: string;
  by: Caller;
  kind: string;
  what: string;
  ms: number;
  error?: string;
  result?: unknown;
  /** The answer was too long to keep, so only its size is. */
  cut?: number;
}

/** Answers longer than this are kept as their size: a trial's report is about 20 KB. */
const MAX_RESULT = 256 * 1024;
/** The journal moves to journal.1.jsonl past this, so it never grows without end. */
const MAX_FILE = 32 * 1024 * 1024;

export const journalFile = () => join(dirname(dataDir()), 'journal.jsonl');

const pathOf = (href: string) => {
  try {
    return new URL(href).pathname;
  } catch {
    return '';
  }
};

/** The line kept for an experiment. */
export function entryOf(e: ExperimentInput, now = new Date()): Experiment {
  const out: Experiment = { at: now.toISOString(), id: e.id, model: modelOf(e.ua), engine: describeUa(e.ua), page: pathOf(e.href), by: e.by, kind: e.kind, what: e.what, ms: Math.round(e.ms) };
  if (e.error) out.error = e.error.split('\n')[0]!.slice(0, 500);
  if (e.result !== undefined) {
    const kept = scrub(e.result);
    const size = JSON.stringify(kept)?.length ?? 0;
    if (size <= MAX_RESULT) out.result = kept;
    else out.cut = size;
  }
  return out;
}

/** Adds an experiment to the journal. Never throws: a full disk costs the record, not the run. */
export function keep(e: ExperimentInput, file = journalFile()): Experiment | null {
  if (process.env.TELEPORT_JOURNAL === '0') return null;
  try {
    const line = entryOf(e);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    if (existsSync(file) && statSync(file).size > MAX_FILE) renameSync(file, file.replace(/\.jsonl$/, '.1.jsonl'));
    appendFileSync(file, JSON.stringify(line) + '\n', { mode: 0o600 });
    return line;
  } catch {
    return null;
  }
}

/** The journal's experiments, newest first: of one model when given, at most `limit`. */
export function readJournal(o: { model?: string; limit?: number } = {}, file = journalFile()): Experiment[] {
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: Experiment[] = [];
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0 && out.length < (o.limit ?? 50); i--) {
    if (!lines[i]) continue;
    try {
      const e = JSON.parse(lines[i]!) as Experiment;
      if (!o.model || e.model === o.model) out.push(e);
    } catch {
      // A line cut short by a crash is skipped; the rest still read.
    }
  }
  return out;
}

/** An experiment's answer in a few words: what a list of them shows beside each line. */
export function gist(e: Pick<Experiment, 'kind' | 'result' | 'error'>): string {
  if (e.error) return e.error;
  const r = e.result as Record<string, unknown> | null | undefined;
  if (!r || typeof r !== 'object') return '';
  const n = (v: unknown, unit = '') => (typeof v === 'number' && Number.isFinite(v) ? `${Math.round(v * 10) / 10}${unit}` : null);
  if (e.kind === 'capture' || e.kind === 'replay') {
    const c = (e.kind === 'replay' ? r.capture : r) as { frames?: { fps?: number; p95Ms?: number | null } | null; input?: { p95Ms?: number | null } | null } | undefined;
    return [n(c?.frames?.fps, ' fps'), c?.frames?.p95Ms != null ? `frame p95 ${n(c.frames.p95Ms, ' ms')}` : null, c?.input?.p95Ms != null ? `key p95 ${n(c.input.p95Ms, ' ms')}` : null].filter(Boolean).join(' · ');
  }
  if (e.kind === 'trial') {
    const vs = r.variants as { name?: string }[] | undefined;
    return vs?.length ? vs.map((v) => v.name).join(' vs ') : '';
  }
  if (e.kind === 'probe') {
    const groups = (r.groups as { items?: unknown[] }[] | undefined) ?? [];
    const items = groups.reduce((s, g) => s + (g.items?.length ?? 0), 0);
    return items ? `${items} answers` : '';
  }
  if (e.kind === 'survey') return typeof r.dir === 'string' ? r.dir : '';
  if (e.kind === 'eval') return typeof r.value === 'string' ? r.value.slice(0, 60) : JSON.stringify(r.value ?? null).slice(0, 60);
  return '';
}
