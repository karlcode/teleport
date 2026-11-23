import type { Caller } from './live.js';
// `tlpt survey`: everything teleport can learn about a device and what it is playing, in one go,
// saved on this machine under ~/.local/share/teleport/devices/<model>/<run>/ and never in a repo.
// It is a client of the running tlpt's API, like `tlpt q`: probes, a capture, the last minute, the
// network log, the playback read (playback.ts) and the manifests the player loaded, parsed here.
// Secrets stay off disk: storage values are dropped and anything token-shaped is redacted.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { Advice } from './advise.js';
import { PLAYBACK_SCRIPT, PLAYER_CONFIG_SCRIPT, playerConfig, readManifest, resources, RESOURCES_SCRIPT, risks, type ManifestInfo, type Rendition } from './playback.js';
import { request } from './q.js';
import { buildReport, reportHtml, reportMarkdown, type Report } from './report.js';
import { ensureClips, verdicts, verifySpecs, type Verdict } from './verify.js';
import { fromUa, identify, identityName } from './ua.js';
import { keep } from './journal.js';

/** Where surveys are kept: `$XDG_DATA_HOME/teleport/devices`, by default `~/.local/share/teleport/devices`. */
export const dataDir = () => join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'teleport', 'devices');

const JWT = /eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g;

/** Every saved survey, newest first: folder, model, when, title, how much advice. */
export function listSurveys(): { dir: string; model: string; at: string; title: string | null; must: number | null }[] {
  const root = dataDir();
  if (!existsSync(root)) return [];
  const out = [];
  for (const model of readdirSync(root))
    for (const run of existsSync(join(root, model)) ? readdirSync(join(root, model)) : []) {
      const dir = join(root, model, run);
      if (!existsSync(join(dir, 'raw'))) continue;
      const adv = readAdvice(dir);
      out.push({ dir, model, at: run.slice(0, 17), title: run.length > 18 ? run.slice(18) : null, must: adv ? adv.filter((x) => x.level === 'must').length : null });
    }
  return out.sort((a, b) => (a.at < b.at ? 1 : -1));
}

/** A survey folder from what was typed: a path, or `latest`. */
export function surveyDir(from: string, cwd: string): string {
  if (from === 'latest') {
    const l = listSurveys()[0];
    if (!l) throw new Error('no surveys yet: run tlpt survey');
    return l.dir;
  }
  const dir = isAbsolute(from) ? from : resolve(cwd, from);
  if (!existsSync(join(dir, 'raw'))) throw new Error(`${dir} is not a survey (no raw/ in it)`);
  return dir;
}

/** A survey's saved advice, or null before it has any. */
export function readAdvice(dir: string): Advice[] | null {
  const f = join(dir, 'advice.json');
  try {
    return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
  } catch {
    return null;
  }
}
const SECRET_KEY = /token|auth|session|secret|password|jwt|cookie|signature|credential|apikey|api_key/i;
const SECRET_QS = /([?&](?:token|auth|access_token|sig|signature|key|hdnts|hdnea|policy|Key-Pair-Id|Expires|X-Amz-[\w-]+)=)[^&#"\s]+/gi;

/** A copy with token-shaped strings, secret-named fields and signed URL parameters redacted. */
export function scrub(v: unknown, key = ''): unknown {
  if (typeof v === 'string') return SECRET_KEY.test(key) && v.length > 8 ? '[redacted]' : v.replace(JWT, '[jwt]').replace(SECRET_QS, '$1[redacted]');
  if (Array.isArray(v)) return v.map((x) => scrub(x, key));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x, k)]));
  return v;
}

/** Storage without its values: names and sizes are enough to profile a device. */
function storageShape(s: unknown): unknown {
  const strip = (a: unknown) => (a && typeof a === 'object' && Array.isArray((a as { entries?: unknown }).entries) ? { ...(a as object), entries: (a as { entries: { key?: string; name?: string; bytes?: number }[] }).entries.map((e) => ({ key: e.key ?? e.name, bytes: e.bytes })) } : a);
  if (!s || typeof s !== 'object') return s;
  const o = s as Record<string, unknown>;
  return { ...o, local: strip(o.local), session: strip(o.session), cookies: strip(o.cookies) };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'unknown';

/** A model name from the user agent: the vendor and model it names, else the platform. */
export function modelOf(ua: string): string {
  const u = fromUa(ua);
  if (u.model) return [u.brand, u.model].filter(Boolean).join(' ');
  return /Android|Linux|Windows|Macintosh/.exec(ua)?.[0] ?? 'device';
}

type Items = { groups?: { items?: { k: string; v: unknown }[] }[] };
const flat = (c: unknown): Record<string, unknown> => Object.fromEntries(((c as Items)?.groups ?? []).flatMap((g) => g.items ?? []).map((i) => [i.k, i.v]));

export interface SurveyOptions {
  port: number;
  /** Who asked, so the console that ran it doesn't also list each step it takes. */
  by?: Caller;
  id?: string;
  out?: string;
  speed?: boolean;
  capture?: number;
  label?: string;
  /** Also play the verify clips and keep their verdicts with the survey. */
  verify?: boolean;
  log?: (line: string) => void;
}

export interface SurveyResult {
  dir: string;
  summary: Record<string, unknown>;
}

/** Runs the whole survey and writes it; resolves with where it went. */
export async function survey(o: SurveyOptions): Promise<SurveyResult> {
  const log = o.log ?? (() => {});
  // Each step is part of the survey: the journal keeps the survey as one line, written below.
  const ask = (path: string, opts: Parameters<typeof request>[2] = {}) => request(o.port, path, { id: o.id, by: o.by, part: true, ...opts }).catch((e: Error) => ({ error: e.message }));
  const t0 = Date.now();
  const live = (await request(o.port, 'live')) as { device: { id: string; ua: string; href: string; ip: string } }[];
  const dev = (o.id ? live.find((d) => d.device.id === o.id) : live[live.length - 1])?.device;
  if (!dev) throw new Error(o.id ? `no device ${o.id}` : 'no device connected');
  const id = dev.id;
  const raw: Record<string, unknown> = {};
  const probes = ['identity', 'media', 'features', 'graphics', 'storage', 'dom', 'focus', ...(o.speed ? ['speed'] : [])];
  for (const p of probes) {
    log(`probe ${p}`);
    raw[p] = await request(o.port, 'probe', { id, by: o.by, part: true, q: { name: p } }).catch((e: Error) => ({ error: e.message }));
  }
  raw.storage = storageShape(raw.storage);
  const who = identify(dev.ua);
  raw.device_identity = who;
  log('playback');
  const pb = (await ask('eval', { id, body: { expr: PLAYBACK_SCRIPT } })) as { value?: Record<string, unknown>; error?: string };
  raw.playback = pb.value ?? pb;
  log('player config');
  raw.playerConfig = playerConfig(await ask('eval', { id, body: { expr: PLAYER_CONFIG_SCRIPT } }));
  log('requests the page made');
  raw.resources = resources(await ask('eval', { id, body: { expr: RESOURCES_SCRIPT } }));
  const seconds = o.capture ?? 10;
  if (seconds > 0) {
    log(`capture ${seconds} s`);
    raw.capture = await ask('capture', { id, q: { ms: seconds * 1000 }, post: true });
  }
  raw.device = await ask('device', { id, q: { seconds: 60 } });
  raw.network = await ask('network', { id, q: { limit: 500 } });
  raw.errors = await ask('errors', { id });
  log('styles');
  raw.styles = await ask('styles', { id });
  if (o.verify) {
    log('verify: playing clips');
    const { paths, failed } = ensureClips(log);
    const verdictsOut: Verdict[] = [];
    for (const spec of verifySpecs(paths)) {
      const rep = await ask('trial', { id, body: { spec }, post: true });
      verdictsOut.push(...verdicts(rep as Parameters<typeof verdicts>[0]));
    }
    raw.verify = { verdicts: verdictsOut, notMade: failed };
  }

  // Manifests: the player's own word first, then whatever the page fetched that looks like one.
  const play = (raw.playback ?? {}) as { players?: { manifestUri?: string | null }[]; manifests?: string[]; title?: string | null; contentId?: string | null; elements?: { w: number | null; h: number | null; src: string | null }[] };
  const urls = [...new Set([...(play.players ?? []).map((p) => p.manifestUri), ...(play.manifests ?? [])].filter((u): u is string => !!u && /^https?:/.test(u)))].slice(0, 4);
  const manifests: ManifestInfo[] = [];
  for (const u of urls) {
    log(`manifest ${u.slice(0, 60)}`);
    manifests.push(await readManifest(u));
  }
  raw.manifests = manifests;

  const media = flat(raw.media);
  const ident = flat(raw.identity);
  const scr = typeof ident.screen === 'string' ? /^(\d+)\D+(\d+)/.exec(ident.screen) : null;
  const renditions: Rendition[] = manifests.flatMap((m) => m.renditions);
  const warn = risks(renditions, media, scr ? { w: +scr[1]!, h: +scr[2]! } : null);

  const model = identityName(who) ?? modelOf(dev.ua);
  const when = new Date().toISOString().replace(/[:]/g, '').replace(/\..*/, '');
  const title = o.label ?? play.title ?? null;
  const dir = o.out ?? join(dataDir(), slug(model), `${when}${title ? '-' + slug(title).slice(0, 40) : ''}`);
  mkdirSync(join(dir, 'raw'), { recursive: true, mode: 0o700 });
  for (const [k, v] of Object.entries(raw)) writeFileSync(join(dir, 'raw', `${k}.json`), JSON.stringify(scrub(v), null, 1));

  const shaka = (raw.playback as { players?: Record<string, unknown>[] })?.players?.[0] ?? null;
  const summary = scrub({
    at: new Date().toISOString(),
    device: { id, name: model, ...who, model: who.model ?? model, ua: dev.ua, ip: dev.ip, href: dev.href },
    content: { title, contentId: play.contentId ?? null, label: o.label ?? null },
    player: shaka ? { lib: shaka.lib, version: shaka.version, type: shaka.type, live: shaka.live, drm: shaka.drm, stats: shaka.stats, active: ((shaka.tracks as { active?: boolean }[]) ?? []).find((t) => t.active) ?? null } : null,
    elements: play.elements ?? [],
    manifests: manifests.map((m) => ({ url: m.url, type: m.type, error: m.error, live: m.live, durationS: m.durationS, renditions: m.renditions.length })),
    ladder: renditions,
    risks: warn,
    support: media,
  }) as Record<string, unknown>;
  writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 1));
  const prev = previous(dir);
  writeReport(dir);
  if (prev) writeFileSync(join(dir, 'diff.md'), diff(prev.summary, summary, prev.dir));
  keep({ id, ua: dev.ua, href: dev.href, by: o.by ?? 'q', kind: 'survey', what: `survey${title ? ` ${title}` : ''}`, ms: Date.now() - t0, result: { dir, report: join(dir, 'report.html'), must: readAdvice(dir)?.filter((x) => x.level === 'must').length ?? null } });
  return { dir, summary };
}

/** advice.json, README.md (the report) and report.html, from what is in the folder. */
export function writeReport(dir: string): Report {
  const rep = buildReport(dir);
  writeFileSync(join(dir, 'advice.json'), JSON.stringify(rep.advice, null, 1));
  writeFileSync(join(dir, 'README.md'), reportMarkdown(rep));
  writeFileSync(join(dir, 'report.html'), reportHtml(rep));
  return rep;
}

/** The run before this one on the same model, if there is one. */
function previous(dir: string): { dir: string; summary: Record<string, unknown> } | null {
  const parent = join(dir, '..');
  const name = dir.split(/[\\/]/).pop()!;
  const runs = existsSync(parent) ? readdirSync(parent).filter((d) => d < name && existsSync(join(parent, d, 'summary.json'))).sort() : [];
  const last = runs.pop();
  return last ? { dir: join(parent, last), summary: JSON.parse(readFileSync(join(parent, last, 'summary.json'), 'utf8')) } : null;
}

const yn = (v: unknown) => (v === true ? 'yes' : v === false ? 'no' : v === null || v === undefined ? '?' : String(v));


/** What changed in what the device says it supports, and in the content, since the last run. */
export function diff(a: Record<string, unknown>, b: Record<string, unknown>, from: string): string {
  const sa = (a.support ?? {}) as Record<string, unknown>;
  const sb = (b.support ?? {}) as Record<string, unknown>;
  const lines = Object.keys({ ...sa, ...sb })
    .filter((k) => !k.startsWith('__') && JSON.stringify(sa[k]) !== JSON.stringify(sb[k]))
    .map((k) => `- ${k}: ${yn(sa[k])} → ${yn(sb[k])}`);
  const ua = (x: Record<string, unknown>) => (x.device as { ua?: string })?.ua;
  if (ua(a) !== ua(b)) lines.unshift(`- user agent: \`${ua(a)}\` → \`${ua(b)}\``);
  return [`# Since ${from}`, '', ...(lines.length ? lines : ['- no change in support']), ''].join('\n');
}
