// A page that throws while it starts, on a device nobody has DevTools open on: the laptop hears it from
// the agent, says where with the source around it, answers `tlpt q errors`, and shows it in a
// DevTools opened afterwards.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KEY } from './keyed.js';
import WebSocket from 'ws';
import type { PageError } from '../src/errors.js';
import { formatErrors, type ErrorsAnswer } from '../src/format.js';
import type { ServerEvent } from '../src/live.js';
import { startDevServer, type DevServer } from '../src/server.js';
import { paint } from '../src/tui.js';

describe('what a page threw before anyone was looking', () => {
  let dev: DevServer;
  let base: string;
  const events: ServerEvent[] = [];

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tlpt-errors-'));
    writeFileSync(join(dir, 'index.html'), '<script src="app.js"></script><script>main()</script>');
    writeFileSync(join(dir, 'app.js'), 'var boot = 1;\nvar main = () => { start(); };\n');
    dev = await startDevServer({ port: 0, host: '127.0.0.1', app: dir, onEvent: (e) => events.push(e) });
    base = `127.0.0.1:${(dev.http.address() as { port: number }).port}`;
  });
  afterAll(() => dev.close());

  const until = async (fn: () => boolean) => {
    while (!fn()) await new Promise((r) => setTimeout(r, 5));
  };
  const agent = async (id: string, page: string) => {
    const ws = new WebSocket(`ws://${base}/ws/target?href=${encodeURIComponent(`http://${base}/`)}&id=${id}&page=${page}`, { headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux armv7l) AppleWebKit/538.1 (KHTML, like Gecko) Chrome/38.0 Safari/538.1' } });
    await new Promise((r) => ws.once('open', r));
    return ws;
  };
  const err = (n: number, kind: string, text: string, src = '', line = 0, col = 0) => `err ${JSON.stringify([n, 40 + n, kind, text, src, line, col, ''])}`;
  const errorsOf = (id: string) => events.filter((e): e is Extract<ServerEvent, { type: 'error' }> => e.type === 'error' && e.id === id);
  const api = async (id: string) => (await (await fetch(`http://${base}/__teleport/${KEY}/api/errors?id=${id}`)).json()) as ErrorsAnswer;

  it('says each error once with the source around it and what it means, and lists them for tlpt q errors', async () => {
    const ws = await agent('tv1', 'p1');
    ws.send(err(0, 'e', 'Uncaught SyntaxError: Unexpected token =>', `http://${base}/app.js`, 2, 12));
    ws.send(err(1, 'e', 'Uncaught ReferenceError: main is not defined', `http://${base}/`, 1, 40));
    ws.send(err(0, 'e', 'Uncaught SyntaxError: Unexpected token =>', `http://${base}/app.js`, 2, 12));
    ws.send('errs 2');
    await until(() => errorsOf('tv1').length === 2);
    // Said in the order thrown, though the first one's source takes a request to read and the second's none.
    expect(errorsOf('tv1').map((e) => e.error.n)).toEqual([0, 1]);
    const [syntax, missing] = errorsOf('tv1').map((e) => e.error) as [PageError, PageError];
    expect(syntax.near).toEqual({ text: 'var main = () => { start(); };', caret: 11 });
    expect(syntax.hint).toMatch(/The engine \(.*Chrome 38.*\) could not parse this file/);
    expect(missing.hint).toMatch(/^Probably because of error 1: SyntaxError: Unexpected token => · app\.js:2:12/);

    const answer = await api('tv1');
    expect(answer.total).toBe(2);
    expect(answer.errors.map((e) => e.n)).toEqual([0, 1]);
    const text = formatErrors(answer, paint('none'), 100).join('\n');
    expect(text).toContain('SyntaxError: Unexpected token => · app.js:2:12');
    expect(text).toContain('var main = () => { start(); };');
    expect(text).toMatch(/\n\s+-{11}\^\n/);
    const live = (await (await fetch(`http://${base}/__teleport/${KEY}/api/live`)).json()) as { device: { id: string; errors: number } }[];
    expect(live.find((d) => d.device.id === 'tv1')!.device.errors).toBe(2);
    ws.close();
  });

  it('counts what the agent only counted, and starts again when the page reloads', async () => {
    const ws = await agent('tv2', 'p1');
    ws.send(err(0, 'r', 'script', 'http://cdn.example/vendor.js'));
    ws.send('errs 40');
    await until(() => events.some((e) => e.type === 'errors' && e.id === 'tv2' && e.total === 40));
    expect((await api('tv2')).total).toBe(40);
    ws.close();
    await new Promise((r) => ws.once('close', r));
    const again = await agent('tv2', 'p2');
    await until(() => events.filter((e) => e.type === 'page' && e.id === 'tv2').length === 2);
    expect(await api('tv2')).toMatchObject({ total: 0, errors: [] });
    again.close();
  });

  it('shows a DevTools opened afterwards what the page threw while it started', async () => {
    const ws = await agent('tv3', 'p1');
    ws.send(err(0, 'e', 'Uncaught ReferenceError: main is not defined', `http://${base}/`, 1, 40));
    await until(() => errorsOf('tv3').length === 1);
    const got: { method?: string; params?: { exceptionDetails?: { text: string; url: string; lineNumber: number } } }[] = [];
    const devtools = new WebSocket(`ws://${base}/__teleport/${KEY}/ws/tv3?link=dttv300001&got=0`);
    devtools.on('message', (d: Buffer) => {
      for (const line of d.toString().split('\n')) if (line.startsWith('{') && !line.startsWith('{"teleport":')) got.push(JSON.parse(line));
    });
    await new Promise((r) => devtools.once('open', r));
    devtools.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }));
    // The inspector loads for DevTools and says the page's context exists: then DevTools is caught up.
    const inspector = new WebSocket(`ws://${base}/ws/cdp/tv3?link=intv300001&got=0`);
    await new Promise((r) => inspector.once('open', r));
    inspector.send(JSON.stringify({ method: 'Runtime.executionContextCreated', params: { context: { id: 1, origin: `http://${base}`, name: '' } } }));
    await until(() => got.some((m) => m.method === 'Runtime.exceptionThrown'));
    inspector.close();
    const d = got.find((m) => m.method === 'Runtime.exceptionThrown')!.params!.exceptionDetails!;
    expect(d).toMatchObject({ text: 'ReferenceError: main is not defined · the page:1:40', lineNumber: 0 });
    devtools.close();
    ws.close();
  });
});
