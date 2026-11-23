import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { KEY } from './keyed.js';
import { answer, serveMcp } from '../src/mcp.js';
import { argsFromWords, COMMANDS, parseQ, runCommand, type Command } from '../src/q.js';

const cmd = (name: string) => COMMANDS.find((c) => c.name === name)!;
const words = (argv: string[]) => {
  const { name, pos, flags } = parseQ(argv);
  return argsFromWords(cmd(name), pos, flags);
};

describe('commands from shell words', () => {
  it('reads positionals and --flags into named arguments', () => {
    expect(words(['device', '--seconds', '30'])).toEqual({ seconds: 30 });
    expect(words(['network', '--min-ms', '200', '--failed'])).toEqual({ minMs: 200, failed: true });
    expect(words(['keys', 'right', 'right', 'ok'])).toEqual({ sequence: ['right', 'right', 'ok'] });
  });

  it('says what is missing, and refuses a flag a command does not take', () => {
    expect(() => words(['keys'])).toThrow(/keys needs sequence/);
    expect(() => words(['probe', 'moon'])).toThrow(/name is one of identity, features, media/);
    expect(() => words(['status', '--nope', '1'])).toThrow(/status takes no --nope/);
  });

  it('takes a spec as JSON from the shell, and makes its relative asset paths absolute', async () => {
    const a = words(['trial', '--spec', '{"variants":[{"name":"a","scripts":["p"]}],"assets":{"p":"vendor/p.js"}}']);
    expect(await cmd('trial').call!(a, '/work')).toEqual({ path: 'trial', post: true, body: { spec: { variants: [{ name: 'a', scripts: ['p'] }], assets: { p: '/work/vendor/p.js' } } } });
    expect(() => words(['trial', '--spec', '{nope'])).toThrow(/--spec is JSON/);
  });

  it('answers the guide here, without teleport', async () => {
    const out = JSON.parse(await runCommand(cmd('guide'), { words: 'web fonts' }, 1));
    expect(out.matches[0].id).toBe('fonts');
  });

  it('loads a trial file: a function measure becomes its source, assets resolve against the file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'teleport-trial-file-'));
    writeFileSync(join(dir, 'fonts.mjs'), "export default { name: 'fonts', assets: { f: 'f.woff2' }, variants: [{ name: 'a' }], measure: function (T) { T.done({ ok: true }); } };\n");
    const r = await cmd('trial').call!(words(['trial', 'fonts.mjs']), dir);
    expect(r.body).toMatchObject({ spec: { name: 'fonts', assets: { f: join(dir, 'f.woff2') }, measure: expect.stringMatching(/^function \(T\) \{ T\.done\(\{ ok: true \}\); \}$/) } });
  });
});

describe('the MCP server', () => {
  const never = async () => 'not run';

  it('negotiates a version and offers every command as a tool, with its parameters as the schema', async () => {
    const init = await answer({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, never);
    expect(init!.result).toMatchObject({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'teleport' } });
    expect((init!.result as { instructions: string }).instructions).toMatch(/ES5/);
    const old = await answer({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } }, never);
    expect((old!.result as { protocolVersion: string }).protocolVersion).toBe('2025-06-18');
    const list = (await answer({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, never))!.result as { tools: { name: string; inputSchema: { properties: Record<string, { type: string }>; required: string[] }; annotations: { readOnlyHint: boolean } }[] };
    expect(list.tools.map((t) => t.name)).toEqual(COMMANDS.map((c) => c.name));
    const trial = list.tools.find((t) => t.name === 'trial')!;
    expect(Object.keys(trial.inputSchema.properties)).toEqual(['file', 'spec', 'id']);
    expect(Object.keys(list.tools.find((t) => t.name === 'guide')!.inputSchema.properties)).toEqual(['words']);
    expect(trial.inputSchema.properties.spec!.type).toBe('object');
    expect(list.tools.filter((t) => !t.annotations.readOnlyHint).map((t) => t.name)).toEqual(['trial', 'keys', 'hear', 'keymap', 'eval', 'verify', 'try', 'replay', 'shim']);
    expect(list.tools.find((t) => t.name === 'keys')!.inputSchema.required).toEqual(['sequence']);
  });

  it('answers a call with the text, a bad one with isError, and a notification with nothing', async () => {
    const seen: [string, unknown, unknown][] = [];
    const run = async (c: Command, a: unknown, id: unknown) => (seen.push([c.name, a, id]), 'ok');
    const ok = await answer({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'keys', arguments: { sequence: ['ok'], id: 'tv1' } } }, run);
    expect(ok!.result).toEqual({ content: [{ type: 'text', text: 'ok' }] });
    expect(seen).toEqual([['keys', { sequence: ['ok'] }, 'tv1']]);
    const missing = await answer({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'keys', arguments: {} } }, run);
    expect(missing!.result).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/keys needs sequence/) }] });
    expect((await answer({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope' } }, run))!.error).toMatchObject({ code: -32602 });
    expect((await answer({ jsonrpc: '2.0', id: 7, method: 'nope' }, run))!.error).toMatchObject({ code: -32601 });
    expect(await answer({ jsonrpc: '2.0', method: 'notifications/initialized' }, run)).toBeNull();
  });

  let api: Server | null = null;
  afterEach(() => void api?.close());

  it('speaks JSON-RPC lines on stdio against a running teleport', async () => {
    const posted: unknown[] = [];
    api = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.url?.startsWith(`/__teleport/${KEY}/api/live`)) return void res.writeHead(200, { 'content-type': 'application/json' }).end('[]');
        posted.push({ url: req.url, header: req.headers['x-teleport'], body: JSON.parse(body) });
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"name":"t","notes":[]}');
      });
    });
    const port = await new Promise<number>((r) => api!.listen(0, '127.0.0.1', () => r((api!.address() as { port: number }).port)));
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: Record<string, unknown>[] = [];
    output.on('data', (b: Buffer) => lines.push(...b.toString().split('\n').filter(Boolean).map((l) => JSON.parse(l))));
    const done = serveMcp(port, input, output, '/work');
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'status' } }) + '\n');
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'trial', arguments: { spec: { name: 't', variants: [{ name: 'a' }], measure: 'T.done()' } } } }) + '\n');
    input.end();
    await done;
    expect(lines.find((l) => l.id === 1)!.result).toEqual({ content: [{ type: 'text', text: `teleport on port ${port}: no device connected.` }] });
    expect(lines.find((l) => l.id === 2)!.result).toMatchObject({ content: [{ text: expect.stringContaining('"name": "t"') }] });
    expect(posted).toEqual([{ url: `/__teleport/${KEY}/api/trial`, header: 'mcp', body: { spec: { name: 't', variants: [{ name: 'a' }], measure: 'T.done()' } } }]);
  });
});
