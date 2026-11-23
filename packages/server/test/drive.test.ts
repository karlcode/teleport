import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { KEY } from './keyed.js';
import { devices, fixtures, reserve } from '../src/client.js';
import { frameScript, holderName, Holds, inputScript } from '../src/drive.js';
import { runQ } from '../src/q.js';
import { startDevServer, type DevServer } from '../src/server.js';

const received = new WeakMap<WebSocket, string[]>();
const open = (url: string) =>
  new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url);
    received.set(ws, []);
    ws.on('message', (data: Buffer, isBinary) => void (isBinary || received.get(ws)!.push(data.toString())));
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
const next = (ws: WebSocket, match: (s: string) => boolean) =>
  new Promise<string>((resolve) => {
    const poll = () => {
      const texts = received.get(ws)!;
      const i = texts.findIndex(match);
      if (i < 0) return void setTimeout(poll, 5);
      resolve(texts.splice(i, 1)[0]!);
    };
    poll();
  });
const nextJson = async (ws: WebSocket, match: (m: any) => boolean) => JSON.parse(await next(ws, (s) => s.startsWith('{') && match(JSON.parse(s))));

/** A device whose agent answers every question with '', and keeps what it was asked. */
async function device(base: string, id: string) {
  const ws = await open(`ws://${base}/ws/target?id=${id}&page=${id}&e=1&href=${encodeURIComponent(`http://${base}/`)}`);
  const asked: string[] = [];
  ws.on('message', (data: Buffer, isBinary) => {
    const m = isBinary ? null : /^eval (\S+) [01] ([\s\S]*)$/.exec(data.toString());
    if (!m) return;
    asked.push(m[2]!);
    ws.send(`val ${m[1]} ""`);
  });
  return { ws, asked };
}

describe('holds', () => {
  it('lets the holder act and nobody else, until it lets go or its time runs out', async () => {
    const ended: string[] = [];
    const holds = new Holds((h) => ended.push(h.id));
    const h = holds.take('a', 'suite', 1000, true);
    expect(holds.free('a', h.token)).toBe(true);
    expect(holds.free('a', undefined)).toBe(false);
    expect(holds.free('b', undefined)).toBe(true);
    expect(holds.held(h.token)).toBe(h);
    expect(holds.held('')).toBeUndefined();
    await new Promise((r) => setTimeout(r, 1100));
    expect(holds.of('a')).toBeUndefined();
    expect(ended).toEqual(['a']);
    holds.take('b', 'suite', 0, true);
    holds.drop('b');
    expect(ended).toEqual(['a', 'b']);
  });

  it("keeps a holder's name to one printable line, and puts it on the frame as text", () => {
    expect(holderName('  nightly\n\x1b[31m suite ')).toBe('nightly[31m suite');
    expect(holderName('')).toBe('a test run');
    expect(holderName('x'.repeat(99))).toHaveLength(40);
    const script = frameScript('a "quoted" </script> name');
    expect(script).toContain('textContent="◎ teleport · a \\"quoted\\" </script> name"');
    expect(script).toContain('pointer-events:none');
    expect(frameScript(null)).toContain('removeChild');
    // On-device code is ES5.
    expect(script + frameScript(null)).not.toMatch(/=>|\b(?:let|const)\b|`/);
  });

  it('turns protocol input into what the remote sends: a press whole on key down, a character typed', () => {
    expect(inputScript('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 })).toContain("k=\"ArrowRight\",c=\"ArrowRight\",n=39");
    expect(inputScript('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight' })).toBeNull();
    expect(inputScript('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', text: 'a' })).toContain('var s="a"');
    expect(inputScript('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', text: '\r', windowsVirtualKeyCode: 13 })).toContain('act(t)');
    expect(inputScript('Input.insertText', { text: 'hi' })).toContain('var s="hi"');
    expect(inputScript('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 10, y: 20 })).toContain('elementFromPoint');
    expect(inputScript('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 10, y: 20 })).toBeNull();
  });
});

describe('driving devices from a test run', () => {
  let dev: DevServer;
  let base: string;
  let port: number;
  const events: string[] = [];
  beforeAll(async () => {
    dev = await startDevServer({ port: 0, host: '127.0.0.1', onEvent: (e) => e.type === 'hold' && events.push(`${e.id} ${e.as}`) });
    port = (dev.http.address() as { port: number }).port;
    base = `127.0.0.1:${port}`;
  });
  afterAll(() => dev.close());
  const api = (path: string, headers: Record<string, string> = {}) => fetch(`http://${base}/__teleport/${KEY}/api/${path}`, { method: 'POST', headers });
  const settle = () => new Promise((r) => setTimeout(r, 30));

  it('reserves a device each for two runs, refuses a third, and frees them on release', async () => {
    const one = await device(base, 'tv-1');
    const two = await device(base, 'tv-2');
    while ((await devices({ port })).length < 2) await settle();
    const a = await reserve({ port, as: 'suite a' });
    const b = await reserve({ port, as: 'suite b' });
    expect([a.id, b.id].sort()).toEqual(['tv-1', 'tv-2']);
    await expect(reserve({ port })).rejects.toThrow('every device is reserved');
    await settle();
    // Each device shows who holds it.
    expect(one.asked.concat(two.asked).filter((s) => s.includes('__tlpt_hold')).map((s) => /teleport · ([^"]+)/.exec(s)?.[1]).sort()).toEqual(['suite a', 'suite b']);
    expect(events).toEqual(expect.arrayContaining(['tv-1 suite a', 'tv-2 suite b']));

    // Anyone else is refused what acts on it; the holder isn't, and its calls go to its own device.
    const refused = await api(`clear?id=${a.id}`);
    expect(refused.status).toBe(423);
    expect(((await refused.json()) as { error: string }).error).toContain('reserved by suite a');
    expect((await api(`eval?id=${a.id}&expr=1`)).status).toBe(423);
    expect(await a.clear()).toEqual({ cleared: { errors: 0, requests: 0 } });
    expect(await b.eval('1+1')).toBe('');
    expect((await b.errors()).total).toBe(0);
    // Reading is never refused.
    expect((await fetch(`http://${base}/__teleport/${KEY}/api/errors?id=${a.id}`)).status).toBe(200);
    // The console is the person at the keyboard: it may act, and let any device go.
    expect((await api(`clear?id=${a.id}`, { 'x-teleport': 'console' })).status).toBe(200);

    await a.release();
    await settle();
    expect(events).toContain('tv-1 null');
    expect(one.asked.at(-1)).toContain('removeChild');
    expect((await api(`clear?id=${a.id}`)).status).toBe(200);
    const again = await reserve({ port, frame: false });
    expect(again.id).toBe(a.id);
    await again.release();
    await b.release();
    one.ws.close();
    two.ws.close();
  });

  it('runs a command on every device at once with --all', async () => {
    const one = await device(base, 'all-1');
    const two = await device(base, 'all-2');
    while ((await devices({ port })).length < 2) await settle();
    const out = JSON.parse(await runQ(['eval', '--all', '1+1'], port)) as Record<string, unknown>;
    expect(out).toEqual({ 'all-1': { value: '' }, 'all-2': { value: '' } });
    one.ws.close();
    two.ws.close();
    while ((await devices({ port })).length) await settle();
  });

  it("answers a browser's side of the protocol: pages to attach to, keys that go as the remote's do", async () => {
    const tv = await device(base, 'cdp-1');
    while (!(await devices({ port })).length) await settle();
    expect((await fetch(`http://${base}/__teleport/nope/json/version`)).status).toBe(403);
    const version = (await (await fetch(`http://${base}/__teleport/${KEY}/json/version/`)).json()) as { webSocketDebuggerUrl: string };
    expect(version.webSocketDebuggerUrl).toBe(`ws://${base}/__teleport/${KEY}/cdp`);
    const list = (await (await fetch(`http://${base}/__teleport/${KEY}/json/list`)).json()) as { id: string; webSocketDebuggerUrl: string }[];
    expect(list.map((t) => t.id)).toEqual(['cdp-1']);

    const ws = await open(version.webSocketDebuggerUrl);
    const ask = async (id: number, method: string, params: object = {}, sessionId?: string) => {
      ws.send(JSON.stringify({ id, method, params, sessionId }));
      return nextJson(ws, (m) => m.id === id);
    };
    expect((await ask(1, 'Browser.getVersion')).result.product).toMatch(/^teleport\//);
    expect((await ask(2, 'Target.getTargets')).result.targetInfos).toEqual([expect.objectContaining({ targetId: 'cdp-1', type: 'page', attached: false })]);
    ws.send(JSON.stringify({ id: 3, method: 'Target.setAutoAttach', params: { autoAttach: true, flatten: true } }));
    const attached = await nextJson(ws, (m) => m.method === 'Target.attachedToTarget');
    const sessionId = attached.params.sessionId as string;
    expect(attached.params.targetInfo).toMatchObject({ targetId: 'cdp-1', type: 'page', browserContextId: 'devices' });
    // The agent is told to load the inspector: a session is a DevTools client of the device.
    await next(tv.ws, (s) => s.startsWith('load '));

    expect(await ask(4, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 }, sessionId)).toEqual({ id: 4, result: {}, sessionId });
    expect(tv.asked.at(-1)).toContain('n=40');
    expect(await ask(5, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown' }, sessionId)).toEqual({ id: 5, result: {}, sessionId });
    // A world asked for by name is the page's own, announced on the page's frame, which is the target's id.
    const world = ask(6, 'Page.createIsolatedWorld', { frameId: 'cdp-1', worldName: 'util' }, sessionId);
    const created = await nextJson(ws, (m) => m.method === 'Runtime.executionContextCreated');
    expect(created.params.context).toMatchObject({ name: 'util', auxData: { frameId: 'cdp-1', isDefault: false } });
    expect((await world).result.executionContextId).toBe(created.params.context.id);
    expect((await ask(7, 'Target.createTarget', { url: 'about:blank' })).error.message).toContain('open the app on a device');
    expect((await ask(8, 'Runtime.evaluate', {}, 'nope')).error.message).toBe('no such session');

    // A device another run holds is not this socket's to see; the holder's socket shows it alone.
    const mine = await reserve({ port, as: 'held' });
    expect((await ask(9, 'Target.getTargets')).result.targetInfos).toEqual([]);
    const held = await open(mine.endpoint);
    held.send(JSON.stringify({ id: 1, method: 'Target.getTargets' }));
    expect((await nextJson(held, (m) => m.id === 1)).result.targetInfos).toHaveLength(1);
    held.close();
    await mine.release();
    ws.close();
    tv.ws.close();
  });

  it('gives Playwright a device for each worker, cleared before each test', async () => {
    const tv = await device(base, 'pw-1');
    while (!(await devices({ port })).some((d) => d.device.id === 'pw-1')) await settle();
    const f = fixtures({ port, ids: ['pw-1'] }) as any;
    expect(f.device[1]).toEqual({ scope: 'worker' });
    expect(f.deviceFresh[1]).toEqual({ auto: true });
    let used = '';
    await f.device[0]({}, async (d: { id: string; keys(s: string): Promise<unknown> }) => {
      used = d.id;
      const info = { annotations: [] as { type: string }[] };
      await f.deviceFresh[0]({ device: d }, async () => void (await d.keys('right,ok')), info);
      expect(info.annotations).toEqual([]);
      expect(events).toContain('pw-1 playwright #1');
    }, { parallelIndex: 0 });
    expect(used).toBe('pw-1');
    expect(tv.asked.filter((s) => s.includes('keydown')).length).toBe(2);
    await settle();
    expect(events.at(-1)).toBe('pw-1 null');
    tv.ws.close();
  });
});
