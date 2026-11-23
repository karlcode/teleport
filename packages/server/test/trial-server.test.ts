import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KEY } from './keyed.js';
import WebSocket from 'ws';
import { startDevServer, type DevServer } from '../src/server.js';
import type { TrialReport } from '../src/trial.js';

describe('trials over the API', () => {
  let server: DevServer | null = null;
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const s of sockets) s.terminate();
    sockets.length = 0;
    await server?.close();
    server = null;
  });

  const inbox = new Map<WebSocket, string[]>();
  const open = async (url: string) => {
    const ws = new WebSocket(url);
    sockets.push(ws);
    inbox.set(ws, []);
    ws.on('message', (d: Buffer, binary: boolean) => {
      if (!binary) inbox.get(ws)!.push(d.toString());
    });
    await new Promise((r) => ws.once('open', r));
    return ws;
  };
  const next = async <T>(ws: WebSocket, test: (m: T) => boolean): Promise<T> => {
    for (;;) {
      const box = inbox.get(ws)!;
      for (let i = 0; i < box.length; i++) {
        let m: T;
        try {
          m = JSON.parse(box[i]!);
        } catch {
          continue;
        }
        if (!test(m)) continue;
        box.splice(0, i + 1);
        return m;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  const text = async (ws: WebSocket, prefix: string) => {
    for (;;) {
      const box = inbox.get(ws)!;
      const i = box.findIndex((s) => s.startsWith(prefix));
      if (i >= 0) return box.splice(0, i + 1)[i]!;
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  type Eval = { id: string; method: string; params: { expression: string } };

  it('runs a spec on the device in order, serves its files with CORS, and refuses a bad spec or a second trial', async () => {
    server = await startDevServer({ port: 0, host: '127.0.0.1' });
    const base = `127.0.0.1:${(server.http.address() as { port: number }).port}`;
    const agent = await open(`ws://${base}/ws/target?id=tv3&href=${encodeURIComponent('http://device/')}&ua=${encodeURIComponent('Chrome/56')}`);
    while (!server.devices.has('tv3')) await new Promise((r) => setTimeout(r, 10));
    const post = (body: unknown) => fetch(`http://${base}/__teleport/${KEY}/api/trial`, { method: 'POST', headers: { 'x-teleport': 'test', 'content-type': 'application/json' }, body: JSON.stringify(body) });

    expect((await post({ spec: { name: 't', variants: [] } })).status).toBe(400);
    const noKey = await fetch(`http://${base}/__teleport/api/trial`, { method: 'POST', headers: { 'x-teleport': 'test' }, body: '{}' });
    expect(noKey.status).toBe(403);

    const dir = mkdtempSync(join(tmpdir(), 'teleport-trial-server-'));
    writeFileSync(join(dir, 'poly.js'), 'window.x = 1;');
    const load = text(agent, 'load ');
    const res = post({ spec: { name: 'two', assets: { poly: join(dir, 'poly.js') }, variants: [{ name: 'a' }, { name: 'b', scripts: ['poly'] }], measure: 'T.done({ms: 1})', runs: 2, timeoutMs: 1000 } });
    await load;
    const inspector = await open(`ws://${base}/ws/cdp/tv3`);
    expect((await post({ spec: { name: 'x', variants: [{ name: 'a' }], measure: 'T.done()' } })).status).toBe(409);

    const ran: string[] = [];
    let file = '';
    for (let n = 0; n < 4; n++) {
      const start = await next<Eval>(inspector, (m) => m.method === 'Runtime.evaluate' && m.params.expression.includes('__teleportTrials||'));
      const config = JSON.parse(/\)\((\{[\s\S]*\})\)$/.exec(start.params.expression)![1]!) as { id: string; variant: string; scripts: string[] };
      ran.push(config.variant);
      if (config.scripts.length) file = config.scripts[0]!;
      inspector.send(JSON.stringify({ id: start.id, result: { result: { type: 'string', value: '' } } }));
      // The device says the run is done; the laptop reads the result at once instead of polling for it.
      const asked = Date.now();
      inspector.send(JSON.stringify({ method: 'teleport.trial', params: { id: config.id } }));
      const poll = await next<Eval>(inspector, (m) => m.method === 'Runtime.evaluate' && m.params.expression.includes('delete R['));
      expect(Date.now() - asked).toBeLessThan(1000);
      inspector.send(JSON.stringify({ id: poll.id, result: { result: { type: 'object', value: { done: true, metrics: { ms: n + 1 }, error: null, errors: [], ms: 2 } } } }));
    }
    const report = (await (await res).json()) as TrialReport;
    expect(ran).toEqual(['a', 'b', 'b', 'a']);
    expect(report.samples.map((s) => [s.variant, s.metrics.ms])).toEqual([['a', 1], ['b', 2], ['b', 3], ['a', 4]]);
    expect(report.device).toMatchObject({ id: 'tv3' });

    expect(file).toMatch(/^\/__teleport\/trial\/[0-9a-f]{16}\/poly\.js$/);
    const served = await fetch(`http://${base}${file}`);
    expect(served.headers.get('access-control-allow-origin')).toBe('*');
    expect(served.headers.get('content-type')).toMatch(/javascript/);
    expect(await served.text()).toBe('window.x = 1;');
    const part = await fetch(`http://${base}${file}`, { headers: { range: 'bytes=0-5' } });
    expect(part.status).toBe(206);
    expect(await part.text()).toBe('window');
  }, 20_000);
});
