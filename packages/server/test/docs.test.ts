// Keeps the documents people and coding agents follow honest. Agents follow them to the letter, so
// a renamed script, a moved file or a heading that changed turns into a confident wrong instruction.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMANDS } from '../src/q.js';
import { REWRITE_MAX } from '../src/app.js';

const ROOT = join(import.meta.dirname, '../../..');
const DOCS = ['README.md', 'AGENTS.md', 'ARCHITECTURE.md', 'CLAUDE.md', 'packages/agent/README.md'];
const docs = DOCS.map((f) => ({ f, text: readFileSync(join(ROOT, f), 'utf8') }));
const scripts = Object.keys(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts);
const text = (f: string) => docs.find((d) => d.f === f)!.text;

/** A heading as GitHub names it in a link: lower case, punctuation gone, spaces as hyphens. */
const anchor = (heading: string) =>
  heading
    .toLowerCase()
    .replace(/[`*]/g, '')
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replace(/ /g, '-');
const anchors = (md: string) => new Set([...md.matchAll(/^#{1,6} (.+)$/gm)].map((m) => anchor(m[1]!)));
/** Without code, where a `](...)` or a path is an example and not a claim about this repository. */
const prose = (md: string) => md.replace(/```[\s\S]*?```/g, '');

describe.each(docs)('$f', ({ f, text: md }) => {
  it('links only to files and headings that exist', () => {
    const broken: string[] = [];
    for (const m of prose(md).matchAll(/\]\(([^)\s]+)\)/g)) {
      const [target, hash] = m[1]!.split('#') as [string, string | undefined];
      if (/^(https?:|mailto:)/.test(target)) continue;
      const file = target ? join(ROOT, f, '..', target) : join(ROOT, f);
      if (!existsSync(file)) broken.push(m[1]!);
      else if (hash && file.endsWith('.md') && !anchors(readFileSync(file, 'utf8')).has(hash)) broken.push(m[1]!);
    }
    expect(broken).toEqual([]);
  });

  it('names only npm scripts that exist', () => {
    const named = [...md.matchAll(/npm run ([a-z0-9:_-]+)/g)].map((m) => m[1]!);
    // `npm run device` is the reader's own script, in an example.
    expect(named.filter((s) => !scripts.includes(s) && s !== 'device')).toEqual([]);
  });

  it('names only files of this repository that exist', () => {
    const missing = [...prose(md).matchAll(/`((?:packages|scripts|examples|\.github)\/[^`\s*<>{}]+)`/g)].map((m) => m[1]!.replace(/:\d+$/, '')).filter((p) => !existsSync(join(ROOT, p)));
    expect(missing).toEqual([]);
  });
});

describe('what the documents say of the code', () => {
  it('lists every q command in the reference', () => {
    const reference = text('AGENTS.md');
    expect(COMMANDS.map((c) => c.name).filter((name) => !reference.includes(`\`${name}`))).toEqual([]);
  });

  it('names every file of the laptop side in the file map', () => {
    const map = text('ARCHITECTURE.md');
    const src = join(ROOT, 'packages/server/src');
    const files = ['aliens', 'analyze', 'app', 'cdp', 'cli', 'console', 'devtools', 'errors', 'expand', 'format', 'frontend', 'glyphs', 'guide', 'hear', 'help', 'journal', 'key', 'link', 'live', 'mcp', 'mirror', 'netlog', 'perfpanel', 'probes', 'profile', 'q', 'remote', 'replay', 'server', 'session', 'shim', 'sourcemap', 'styles', 'term', 'text', 'trial', 'tui', 'tunnel', 'ua', 'version', 'vitals', 'ws'];
    for (const name of files) expect(existsSync(join(src, `${name}.ts`)), `${name}.ts is listed here and gone`).toBe(true);
    expect(files.filter((name) => !map.includes(`\`${name}.ts\``))).toEqual([]);
  });

  it('states the limits the code has', () => {
    const map = text('ARCHITECTURE.md');
    expect(map).toContain(`A body over ${REWRITE_MAX / 1024 / 1024} MB passes through unrewritten`);
    const gate = readFileSync(join(ROOT, 'scripts/check-agent.mjs'), 'utf8');
    const kb = (name: string) => Number(new RegExp(`const ${name} = (\\d+) \\* 1024`).exec(gate)![1]);
    expect(map).toContain(`gzip (budget ${kb('BUDGET')})`);
    expect(map).toContain(`gzip (budget ${kb('INSPECTOR_BUDGET')})`);
    expect(map).toContain(`Size budgets: agent ${kb('BUDGET')} KB, inspector ${kb('INSPECTOR_BUDGET')} KB`);
  });
});
