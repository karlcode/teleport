// `tlpt mcp`: the same commands as `tlpt q`, as Model Context Protocol tools over stdio, for an
// agent that takes MCP servers rather than a shell (Claude Desktop, Cursor, Claude Code, Codex). One
// JSON-RPC message per line; nothing else goes to stdout. Each tool is a command from q.ts with its
// parameters as the input schema, so the two never drift. It needs a running teleport.
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { checkArgs, COMMANDS, runCommand, type Args, type Command, type Param } from './q.js';
import { VERSION } from './version.js';

const VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18'];

export const INSTRUCTIONS = `teleport measures a web app on a device (any old embedded Chromium or WebView) from the device itself.
Start with \`status\`. \`device\` has the last minute of samples; \`probe\` says what the engine can do (media, features, graphics, identity, storage, dom, focus) and how fast it is (speed).
To find out whether something works on this device, or which of two ways is better, run a \`trial\`. Describe only what to try: variants with html, scripts and setup, and keys to press. Every run is profiled without being asked: load, frames, main-thread blocking, key → frame, heap, DOM, layout, images, requests, media. Add checks (ES5 expressions read once on the device) for the why. \`guide\` lists what is worth trying on a device and how to ask the engine about it.
Code that runs on the device must be ES5: no arrow functions, let or const, template strings, classes or spread.
Never claim a difference without the numbers a trial returned: medians, the 95% interval and the run count.`;

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
}

function schemaOf(p: Param): Record<string, unknown> {
  const s: Record<string, unknown> = { type: p.type, description: p.help };
  if (p.type === 'array') s.items = { type: 'string' };
  if (p.enum) s.enum = p.enum;
  return s;
}

const ID: Param = { name: 'id', type: 'string', help: 'Which device, from status; the newest one otherwise.' };

export const toolOf = (c: Command): Tool => ({
  name: c.name,
  description: c.help,
  inputSchema: {
    type: 'object',
    properties: Object.fromEntries([...c.params, ...(c.local || c.name === 'status' || c.name === 'devices' ? [] : [ID])].map((p) => [p.name, schemaOf(p)])),
    required: c.params.filter((p) => p.required).map((p) => p.name),
  },
  annotations: { readOnlyHint: !c.acts, destructiveHint: false, openWorldHint: false },
});

type Message = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
export type Run = (c: Command, a: Args, id: string | undefined) => Promise<string>;

/** The answer to one message, or null for a notification. */
export async function answer(m: Message, run: Run): Promise<Record<string, unknown> | null> {
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: m.id ?? null, result });
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: m.id ?? null, error: { code, message } });
  if (m.id === undefined || m.id === null) return null;
  const p = m.params ?? {};
  switch (m.method) {
    case 'initialize': {
      const asked = typeof p.protocolVersion === 'string' ? p.protocolVersion : '';
      return reply({ protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[VERSIONS.length - 1], capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'teleport', version: VERSION }, instructions: INSTRUCTIONS });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: COMMANDS.map(toolOf) });
    case 'tools/call': {
      const c = COMMANDS.find((x) => x.name === p.name);
      if (!c) return fail(-32602, `no tool ${String(p.name)}`);
      const args = { ...((p.arguments as Args | undefined) ?? {}) };
      const id = typeof args.id === 'string' && args.id ? args.id : undefined;
      delete args.id;
      try {
        checkArgs(c, args);
        return reply({ content: [{ type: 'text', text: await run(c, args, id) }] });
      } catch (e) {
        return reply({ content: [{ type: 'text', text: (e as Error).message }], isError: true });
      }
    }
    default:
      return fail(-32601, `no method ${String(m.method)}`);
  }
}

/** Serves MCP on `input` and `output` until the input ends. */
export function serveMcp(port: number, input: Readable = process.stdin, output: Writable = process.stdout, cwd = process.cwd()): Promise<void> {
  const run: Run = (c, a, id) => runCommand(c, a, port, cwd, id, 'mcp');
  const lines = createInterface({ input, crlfDelay: Infinity });
  const pending = new Set<Promise<void>>();
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let m: Message;
    try {
      m = JSON.parse(line) as Message;
    } catch {
      return void output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'not JSON' } }) + '\n');
    }
    // Calls answer as they finish, so a long trial doesn't hold a quick status behind it.
    const job = answer(m, run).then((r) => void (r && output.write(JSON.stringify(r) + '\n')));
    pending.add(job);
    void job.finally(() => pending.delete(job));
  });
  return new Promise((done) => lines.on('close', () => void Promise.all(pending).then(() => done())));
}
