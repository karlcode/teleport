// A survey as one file to read or send: the device, what it played, how it ran, and the advice,
// most important first. Markdown for a repo or a ticket, HTML (one self-contained file, no
// scripts or external assets) to open in a browser. Built from a survey folder alone.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { advise, flat, readRaw, type Advice, type Raw } from './advise.js';

export interface Report {
  dir: string;
  title: string;
  facts: [string, string][];
  advice: Advice[];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const at = (v: unknown, ...p: string[]): unknown => p.reduce<unknown>((x, k) => (isObj(x) ? x[k] : undefined), v);
const s = (v: unknown) => (v === null || v === undefined || v === '' ? '?' : String(v));

/** The facts worth a line in a report, from the raw answers and the summary. */
function facts(r: Raw, summary: unknown): [string, string][] {
  const id = flat(r.identity);
  const g = flat(r.graphics);
  const m = flat(r.media);
  const p = at(summary, 'player');
  const active = at(p, 'active');
  const yes = (keys: string[]) => keys.filter((k) => m[k] === true).join(', ') || 'none';
  const out: [string, string][] = [
    ['Device', s(at(summary, 'device', 'name') ?? at(summary, 'device', 'model'))],
    ...(at(summary, 'device', 'os') ? [['OS', [at(summary, 'device', 'os'), at(summary, 'device', 'osVersion'), at(summary, 'device', 'source') ? `· from ${s(at(summary, 'device', 'source'))}` : null].filter(Boolean).map(String).join(' ')] as [string, string]] : []),
    ['Engine', s(at(summary, 'device', 'ua'))],
    ['Screen', `${s(id.screen)} · dpr ${s(id.dpr)}`],
    ['GPU', `${s(g.gpuRenderer)} · WebGL ${g.webgl2 ? '2' : g.webgl ? '1' : 'none'}`],
    ['Video codecs (browser says)', yes(['h264High', 'h264High51', 'hevcHvc1', 'hevcMain10', 'dolbyVision', 'vp9p0', 'vp9p2', 'av1'])],
    ['Audio codecs (browser says)', yes(['aac', 'heaac', 'ac3', 'eac3', 'opusMp4', 'flac'])],
    ['DRM', ['widevine', 'playready', 'clearkey', 'fairplay'].map((k) => `${k} ${s(m[k])}`).join(' · ')],
    ['Codec switch (changeType)', m.changeType === true ? 'yes' : m.changeType === false ? 'no' : '?'],
  ];
  const title = at(summary, 'content', 'title');
  if (title) out.push(['Playing', s(title)]);
  if (isObj(p)) out.push(['Player', `${s(p.lib)} ${s(p.version)} · ${isObj(active) ? `${s(active.w)}×${s(active.h)} ${s(active.v)} + ${s(active.a)} @ ${Math.round(Number(active.bw) / 1000)} kb/s` : ''}`]);
  const f = at(r.capture, 'frames');
  if (isObj(f)) out.push(['Capture', `${s(f.fps)} fps · frame p95 ${s(f.p95Ms)} ms · p99 ${s(f.p99Ms)} ms · timer lag p95 ${s(at(r.capture, 'lag', 'p95Ms'))} ms`]);
  return out;
}

/** Reads a survey folder and works out its report. */
export function buildReport(dir: string): Report {
  const r = readRaw(dir);
  const sp = join(dir, 'summary.json');
  const summary = existsSync(sp) ? JSON.parse(readFileSync(sp, 'utf8')) : {};
  const model = s(at(summary, 'device', 'name') ?? at(summary, 'device', 'model'));
  const when = s(at(summary, 'at')).slice(0, 16).replace('T', ' ');
  return { dir, title: `${model} · ${when}`, facts: facts(r, summary), advice: advise(r) };
}

const LEVEL_WORD = { must: 'Must', should: 'Should', could: 'Could' } as const;

export function reportMarkdown(rep: Report): string {
  const L = [`# ${rep.title}`, '', '| | |', '|---|---|', ...rep.facts.map(([k, v]) => `| ${k} | ${v.replace(/\|/g, '\\|')} |`), ''];
  L.push(`## Advice (${rep.advice.length})`, '');
  for (const a of rep.advice) {
    L.push(`### ${LEVEL_WORD[a.level]} · ${a.area} · ${a.title}`, '', `- **Seen:** ${a.evidence}`, `- **Do:** ${a.action}`);
    if (a.examples?.length) L.push('- **Examples:**', ...a.examples.map((x) => `  - \`${x.replace(/`/g, "'")}\``));
    if (a.patch) L.push('', '```js', a.patch, '```');
    if (a.check) L.push(`- **Prove it:** ${a.check}`);
    L.push('');
  }
  L.push(`From \`${rep.dir}\`. Advice is drawn from measurements; until a trial shows a change helps, it is a lead.`, '');
  return L.join('\n');
}

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
/** `code` in advice text → <code>. */
const rich = (t: string) => esc(t).replace(/`([^`]+)`/g, '<code>$1</code>');

export function reportHtml(rep: Report): string {
  const counts = (['must', 'should', 'could'] as const).map((l) => `<span class="pill ${l}">${rep.advice.filter((a) => a.level === l).length} ${l}</span>`).join(' ');
  const items = rep.advice
    .map((a) => `<article class="${a.level}"><header><span class="pill ${a.level}">${a.level}</span> <span class="area">${a.area}</span><h3>${rich(a.title)}</h3></header><p><b>Seen</b> ${rich(a.evidence)}</p>${a.examples?.length ? `<ul class="ex">${a.examples.map((x) => `<li><code>${esc(x)}</code></li>`).join('')}</ul>` : ''}<p><b>Do</b> ${rich(a.action)}</p>${a.patch ? `<pre><code>${esc(a.patch)}</code></pre>` : ''}${a.check ? `<p class="check"><b>Prove it</b> ${rich(a.check)}</p>` : ''}</article>`)
    .join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(rep.title)}</title><style>
body{font:15px/1.5 system-ui,sans-serif;max-width:60rem;margin:2rem auto;padding:0 1rem;color:#1d1d1f;background:#fafafa}
h1{font-size:1.6rem;margin-bottom:.2rem}table{border-collapse:collapse;width:100%;margin:1rem 0 2rem}td{padding:.35rem .6rem;border-bottom:1px solid #e3e3e3;vertical-align:top}td:first-child{color:#666;white-space:nowrap;width:14rem}
article{background:#fff;border:1px solid #e3e3e3;border-left:5px solid #999;border-radius:6px;padding:.8rem 1rem;margin:.8rem 0}
article.must{border-left-color:#d70015}article.should{border-left-color:#c93400}article.could{border-left-color:#0071e3}
article h3{display:inline;font-size:1.05rem;margin-left:.4rem}article p{margin:.4rem 0}.check{color:#555}
.pill{font-size:.75rem;text-transform:uppercase;font-weight:600;padding:.1rem .5rem;border-radius:1rem;color:#fff;background:#999}.pill.must{background:#d70015}.pill.should{background:#c93400}.pill.could{background:#0071e3}
.area{color:#666;font-size:.85rem}code{background:#f0f0f0;padding:0 .25rem;border-radius:3px}footer{color:#888;margin-top:2rem;font-size:.85rem}
pre{background:#f0f0f0;padding:.6rem .8rem;border-radius:4px;overflow:auto}pre code{padding:0}.ex{margin:.3rem 0;padding-left:1.2rem;font-size:.85rem}
@media (prefers-color-scheme:dark){body{background:#111;color:#eee}article{background:#1c1c1e;border-color:#333}td{border-color:#333}code{background:#2c2c2e}}
</style></head><body><h1>${esc(rep.title)}</h1><div>${counts}</div>
<table>${rep.facts.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>
<h2>Advice</h2>${items || '<p>Nothing to advise from these measurements.</p>'}
<footer>From ${esc(rep.dir)}. Advice is drawn from measurements; until a trial shows a change helps, it is a lead.</footer></body></html>
`;
}
