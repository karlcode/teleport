// A tripwire for what teleport can do on the laptop. teleport starts programs (the browser, the
// clipboard, git, the person's own AI agent), and its plugin hands an agent a shell, so each of those is
// pinned here and a change has to say so. If a change below is intended, update this file and
// docs/ai-assistants.md together.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { READ_COMMANDS } from '../packages/server/src/q.js';

const ROOT = join(import.meta.dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const json = (p: string) => JSON.parse(read(p)) as Record<string, unknown>;
const SERVER = 'packages/server/src';
const code = (dir: string) => readdirSync(join(ROOT, dir)).filter((f) => /\.(ts|js)$/.test(f)).map((f) => ({ f, lines: read(`${dir}/${f}`).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)) }));
const UPDATE = 'If this is intended, update test/capabilities.test.ts and docs/ai-assistants.md together.';

describe('what teleport runs on the laptop', () => {
  it('starts programs only from these files, and never through a shell', () => {
    const starts: Record<string, number> = {};
    for (const { f, lines } of code(SERVER)) {
      const n = lines.filter((l) => /\b(spawn|execFile|execFileSync|spawnSync)\(/.test(l)).length;
      if (n) starts[f] = n;
      expect(lines.filter((l) => /\b(execSync|exec)\(\s*['"`]|shell:\s*true/.test(l)), `${f}: shell. ${UPDATE}`).toEqual([]);
    }
    // cli.ts: the browser opener, for DevTools on each new screen.
    // verify.ts: ffmpeg, with fixed arguments, to make the test clips verify and try play; only when one of those is run.
    // tunnel.ts: tailscale, with fixed arguments, to list and re-point a tunnel to the app; and the tunnel
    // command the person gave with --tunnel, split into words, never through a shell.
    expect(starts, UPDATE).toEqual({ 'cli.ts': 1, 'tunnel.ts': 2, 'verify.ts': 1 });
  });

  it('compiles code only in what it sends to the device', () => {
    const dynamic = code(SERVER).filter(({ lines }) => lines.some((l) => /new Function\(|\beval\(/.test(l))).map(({ f }) => f);
    // Each builds ES5 that runs in the device's page: probe scripts, the trial runner's checks, and the guide's checks.
    // probes.ts also times two of its own fixed loops on the laptop (the speed probe's), from the same text the device runs.
    expect(dynamic, UPDATE).toEqual(['guide.ts', 'probes.ts', 'trial.ts']);
  });

  it('has no runtime dependencies to install', () => {
    for (const p of ['packages/server/package.json', 'packages/tlpt/package.json', 'packages/agent/package.json']) {
      const deps = Object.keys((json(p).dependencies as Record<string, string> | undefined) ?? {}).filter((d) => !d.startsWith('@teleport/'));
      expect(deps, `${p}. ${UPDATE}`).toEqual([]);
    }
  });
});

describe("what an AI agent may do through teleport", () => {
  it("lets the Oracle's agent measure, never change the page", () => {
    expect(READ_COMMANDS).not.toContain('eval');
    expect(READ_COMMANDS).not.toContain('toggle');
  });

  it('pre-approves only the read commands in the skill', () => {
    const skill = read('plugin/skills/teleport/SKILL.md');
    const allowed = [...skill.matchAll(/^ {2}- Bash\(npx --no-install teleport q (\w+)/gm)].map((m) => m[1]);
    // Named one by one, never derived: a command q.ts gains is not pre-approved until it is added here.
    // playback, survey, advise and report read or measure too, but run a script in the page or write
    // files on the laptop, so they ask first, as trial, try, verify, keys and eval do.
    // history reads only the journal on this laptop.
    expect(allowed).toEqual(['status', 'devices', 'device', 'errors', 'network', 'capture', 'probe', 'styles', 'guide', 'history']);
    for (const name of allowed) expect(READ_COMMANDS, name).toContain(name);
    expect(skill.split('---')[1]).not.toMatch(/\b(eval|toggle|claude-md)\b/);
  });

  it('ships the plugin as a skill only: no hooks, MCP servers or downloads', () => {
    // plugin/ is the plugin's root, apart from the repository's own .mcp.json for its maintainers.
    for (const f of ['hooks', 'hooks.json', '.mcp.json', '.lsp.json', '.claude-plugin/hooks.json']) expect(existsSync(join(ROOT, 'plugin', f)), `plugin/${f}. ${UPDATE}`).toBe(false);
    expect(Object.keys(json('plugin/.claude-plugin/plugin.json')).sort(), UPDATE).toEqual(['author', 'description', 'keywords', 'license', 'name', 'version']);
    expect((json('.claude-plugin/marketplace.json').plugins as { source: string }[]).map((p) => p.source)).toEqual(['./plugin']);
    expect((json('.agents/plugins/marketplace.json').plugins as { source: { path: string } }[]).map((p) => p.source.path)).toEqual(['./plugin']);
    expect(json('plugin/.codex-plugin/plugin.json').skills).toBe('./skills/');
    expect(read('plugin/skills/teleport/SKILL.md')).not.toMatch(/npx (?!--no-install )teleport q/);
  });
});
