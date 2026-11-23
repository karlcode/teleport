import { createServer, request, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { answers, appTarget, findDevServers, reach, skipWarning, waitable, why } from '../src/app.js';
import { startDevServer, type DevServer } from '../src/server.js';

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));
}

function get(port: number, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    request({ host: '127.0.0.1', port, path, headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    })
      .on('error', reject)
      .end();
  });
}

const target = (arg: string) => {
  const t = appTarget(arg);
  return t.kind === 'proxy' ? t.origin.href : `folder ${t.dir}`;
};

describe('what teleport serves to the device', () => {
  it('reads a bare port as the dev server on this machine', () => {
    expect(target('5173')).toBe('http://localhost:5173/');
    expect(target(':5173')).toBe('http://localhost:5173/');
    expect(target('localhost:3000')).toBe('http://localhost:3000/');
    expect(target('192.168.1.5:8080')).toBe('http://192.168.1.5:8080/');
  });

  it('keeps a full URL, including https', () => {
    expect(target('https://device.example.com/app')).toBe('https://device.example.com/app');
  });

  it('reads a bare host name as an https site', () => {
    expect(target('app.example.com')).toBe('https://app.example.com/');
    expect(target('app.example.com/device?x=1')).toBe('https://app.example.com/device?x=1');
  });

  it('reads anything else as a folder', () => {
    expect(target('dist')).toMatch(/^folder .*dist$/);
  });
});

describe('finding a dev server on this machine', () => {
  const page = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<html></html>'));
  const api = createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{}'));
  let pagePort = 0;
  let apiPort = 0;
  beforeAll(async () => {
    [pagePort, apiPort] = await Promise.all([listen(page), listen(api)]);
  });
  afterAll(() => {
    page.close();
    api.close();
  });

  it('finds the ports that answer with a web page, and only those', async () => {
    const closed = createServer();
    const free = await listen(closed);
    closed.close();
    const found = await findDevServers([apiPort, pagePort, free], '127.0.0.1');
    expect(found.map((u) => u.port)).toEqual([String(pagePort)]);
  });
});

describe('proxying an app', () => {
  let upstream: Server;
  let wss: WebSocketServer;
  let up = 0;
  let teleport: DevServer;
  let port = 0;
  beforeAll(async () => {
    upstream = createServer((req, res) => {
      if (req.url === '/login') {
        return void res
          .writeHead(302, { location: `http://127.0.0.1:${up}/home`, 'set-cookie': ['sid=1; Domain=device.example.com; Path=/; Secure; SameSite=None; HttpOnly'] })
          .end();
      }
      res.writeHead(200, { 'content-type': 'text/html', 'x-seen-origin': req.headers.origin ?? '' }).end('<html><head></head><body></body></html>');
    });
    wss = new WebSocketServer({ server: upstream });
    wss.on('connection', (ws) => ws.on('message', (m) => ws.send(`echo ${m}`)));
    up = await listen(upstream);
    teleport = await startDevServer({ port: 0, host: '127.0.0.1', app: `http://127.0.0.1:${up}` });
    port = (teleport.http.address() as { port: number }).port;
  });
  afterAll(async () => {
    await teleport.close();
    wss.close();
    upstream.close();
  });

  it("keeps the device on the proxy when the app redirects to its own address", async () => {
    const res = await get(port, '/login');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/home');
  });

  it("keeps the app's cookies working on teleport's address", async () => {
    const plain = (await get(port, '/login')).headers['set-cookie']!;
    expect(plain).toEqual(['sid=1; Path=/; HttpOnly']);
    const tunnelled = (await get(port, '/login', { 'x-forwarded-proto': 'https' })).headers['set-cookie']!;
    expect(tunnelled).toEqual(['sid=1; Path=/; Secure; SameSite=None; HttpOnly']);
  });

  it("tells the app the request came from its own origin", async () => {
    const res = await get(port, '/', { origin: `http://192.168.1.20:${port}` });
    expect(res.headers['x-seen-origin']).toBe(`http://127.0.0.1:${up}`);
  });

  it("passes the app's own WebSockets through, such as a dev server's hot reload", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/hmr`);
    const reply = await new Promise<string>((resolve, reject) => {
      ws.once('open', () => ws.send('ping'));
      ws.once('message', (m) => resolve(String(m)));
      ws.once('error', reject);
    });
    ws.close();
    expect(reply).toBe('echo ping');
  });

  it("closes with an app's WebSocket still open, so quitting tlpt never hangs on one", async () => {
    const other = await startDevServer({ port: 0, host: '127.0.0.1', app: `http://127.0.0.1:${up}` });
    const ws = new WebSocket(`ws://127.0.0.1:${(other.http.address() as { port: number }).port}/hmr`);
    await new Promise((resolve, reject) => ws.once('open', resolve).once('error', reject));
    const closing = other.close().then(() => 'closed');
    expect(await Promise.race([closing, new Promise((r) => setTimeout(() => r('hung'), 2000))])).toBe('closed');
  });
});

describe('a port given as the app', () => {
  it('reaches a dev server on localhost whichever loopback it listens on', async (ctx) => {
    // Vite takes ::1 where localhost names it first (macOS); a hosts file may not name ::1 at all.
    const v6 = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/plain' }).end('on ::1'));
    const port = await new Promise<number | null>((resolve) => {
      v6.once('error', () => resolve(null));
      v6.listen(0, '::1', () => resolve((v6.address() as { port: number }).port));
    });
    // A machine without IPv6 has no ::1 to listen on.
    if (port === null) return ctx.skip();
    const tlpt = await startDevServer({ port: 0, host: '127.0.0.1', app: `http://localhost:${port}` });
    const res = await get((tlpt.http.address() as { port: number }).port, '/');
    expect([res.status, res.body]).toEqual([200, 'on ::1']);
    expect(await answers(new URL(`http://localhost:${port}`))).toBeNull();
    await tlpt.close();
    v6.close();
  });

  it('tries both loopbacks for localhost, IPv4 first, whatever the hosts file names', async () => {
    const r = reach(new URL('http://localhost:5173')) as { lookup: (h: string, o: object, cb: (e: unknown, a: unknown) => void) => void; autoSelectFamily: boolean };
    expect(r.autoSelectFamily).toBe(true);
    const all = await new Promise((resolve) => r.lookup('localhost', { all: true }, (_e, a) => resolve(a)));
    expect(all).toEqual([
      { address: '127.0.0.1', family: 4 },
      { address: '::1', family: 6 },
    ]);
    expect(reach(new URL('http://192.168.1.20:5173'))).toEqual({});
  });

  it('gives a device that opens it before the app is up a page that tries again, and says so', async () => {
    const closed = createServer();
    const free = await listen(closed);
    closed.close();
    const no = await answers(new URL(`http://localhost:${free}`));
    expect(no).not.toBeNull();
    expect(waitable(new URL(`http://localhost:${free}`), no!)).toBe(true);
    const tlpt = await startDevServer({ port: 0, host: '127.0.0.1', app: `http://localhost:${free}` });
    const at = (tlpt.http.address() as { port: number }).port;
    const page = await get(at, '/', { accept: 'text/html,application/xhtml+xml' });
    expect(page.status).toBe(502);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('<meta http-equiv="refresh" content="2">');
    expect(page.body).toContain(`waiting for your app at <b style="color:#fff">localhost:${free}</b>`);
    // No agent: each try isn't a device connecting.
    expect(page.body).not.toContain('teleport.js');
    // A script or an API call still gets the reason as text.
    const api = await get(at, '/api/items', { accept: 'application/json' });
    expect([api.status, api.headers['content-type']]).toEqual([502, 'text/plain']);
    // The reason survives both loopbacks being tried.
    expect(api.body).toMatch(/no answer from http:\/\/localhost:\d+ \(connect ECONNREFUSED 127\.0\.0\.1:\d+\)/);
    await tlpt.close();
  });

  it('counts an app slow to render as up: only its connection is asked for', async () => {
    const slow = createServer((_req, res) => setTimeout(() => res.end('late'), 5000));
    const port = await listen(slow);
    const t0 = Date.now();
    expect(await answers(new URL(`http://localhost:${port}`))).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
    slow.closeAllConnections();
    slow.close();
  });

  it('says why a host that is wrong or down fails, rather than wait for it', async () => {
    // Not on this machine: nothing to start here, so no waiting page.
    const e = Object.assign(new Error('getaddrinfo ENOTFOUND app.exmaple.com'), { code: 'ENOTFOUND' });
    expect(waitable(new URL('https://app.exmaple.com'), e)).toBe(false);
    expect(waitable(new URL('https://app.example.com'), Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))).toBe(false);
    // On this machine, but not a refusal: something is there and failing.
    expect(waitable(new URL('http://localhost:5173'), Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))).toBe(false);
    const both = Object.assign(new AggregateError([Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5173'), { code: 'ECONNREFUSED' }), Object.assign(new Error('connect EAFNOSUPPORT ::1:5173'), { code: 'EAFNOSUPPORT' })], ''), { code: 'ECONNREFUSED' });
    expect(waitable(new URL('http://localhost:5173'), both)).toBe(true);
    expect(why(both)).toBe('connect ECONNREFUSED 127.0.0.1:5173');
  });

  it("asks a tunnel to skip its free plan's warning page, by the header named for it", () => {
    for (const host of ['abc.tunnel-free.app', 'abc.tunnel-free.dev', 'abc.tunnel.app', 'abc.tunnel.io']) expect(skipWarning(new URL(`https://${host}`))).toEqual({ 'tunnel-skip-browser-warning': '1' });
    expect(skipWarning(new URL('https://abc.othertunnel-free.app'))).toEqual({ 'othertunnel-skip-browser-warning': '1' });
    expect(skipWarning(new URL('https://example.com'))).toEqual({});
    expect(skipWarning(new URL('http://192.168.1.20:5173'))).toEqual({});
    expect(skipWarning(new URL('https://app.example.com'))).toEqual({});
    expect(skipWarning(new URL('http://localhost:5173'))).toEqual({});
  });
});
