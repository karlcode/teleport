// What a device may ask of a folder, and what an app behind the proxy may do to its answers. None of
// it may end teleport, and a device's media stack must be able to seek.
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, request, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { byteRange, REWRITE_MAX, seenFrom } from '../src/app.js';
import { startDevServer, type DevServer } from '../src/server.js';

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  /** The connection ended before the answer did. */
  cut: boolean;
}

function ask(port: number, path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Answer> {
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path, headers, method }, (res) => {
      const chunks: Buffer[] = [];
      const done = (cut: boolean) => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), cut });
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => done(false));
      res.on('error', () => done(true));
      res.on('aborted', () => done(true));
    })
      .on('error', reject)
      .end();
  });
}
const portOf = (s: { http: Server } | Server) => (('http' in s ? s.http : s).address() as { port: number }).port;

describe('a range of a file', () => {
  it('is the span asked for, clipped to the file', () => {
    expect(byteRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
    expect(byteRange('bytes=900-', 1000)).toEqual({ start: 900, end: 999 });
    expect(byteRange('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 });
    expect(byteRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
    expect(byteRange('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 });
  });

  it('is the whole file with no header, or one this server answers in full', () => {
    for (const h of [undefined, '', 'bytes=-', 'bytes=0-1,5-6', 'items=0-1', 'bytes=a-b']) expect(byteRange(h, 1000)).toBe('all');
  });

  it('is nothing when it starts past the end', () => {
    for (const h of ['bytes=1000-', 'bytes=5-4', 'bytes=-0']) expect(byteRange(h, 1000)).toBeNull();
    expect(byteRange('bytes=0-', 0)).toBeNull();
  });
});

describe('a folder served to a device', () => {
  let server: DevServer;
  let port: number;
  const clip = Buffer.from(Array.from({ length: 5000 }, (_, i) => i & 255));

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tlpt-serve-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head></head><body>hi</body></html>');
    writeFileSync(join(dir, 'clip.mp4'), clip);
    writeFileSync(join(dir, 'empty.js'), '');
    writeFileSync(join(dir, 'locked.js'), 'secret');
    chmodSync(join(dir, 'locked.js'), 0o000);
    mkdirSync(join(dir, 'folder.js'));
    server = await startDevServer({ port: 0, host: '127.0.0.1', app: dir });
    port = portOf(server);
  });
  afterAll(() => server.close());

  it('says how long a file is and that it can be read in parts', async () => {
    const r = await ask(port, '/clip.mp4');
    expect(r.status).toBe(200);
    expect(r.headers['content-length']).toBe('5000');
    expect(r.headers['accept-ranges']).toBe('bytes');
    expect(r.body.equals(clip)).toBe(true);
  });

  it('answers the span a media stack asks for', async () => {
    const r = await ask(port, '/clip.mp4', { range: 'bytes=100-199' });
    expect(r.status).toBe(206);
    expect(r.headers['content-range']).toBe('bytes 100-199/5000');
    expect(r.headers['content-length']).toBe('100');
    expect(r.body.equals(clip.subarray(100, 200))).toBe(true);
    const tail = await ask(port, '/clip.mp4', { range: 'bytes=-10' });
    expect(tail.headers['content-range']).toBe('bytes 4990-4999/5000');
    expect(tail.body.equals(clip.subarray(4990))).toBe(true);
  });

  it('refuses a span past the end, with the length', async () => {
    const r = await ask(port, '/clip.mp4', { range: 'bytes=5000-' });
    expect(r.status).toBe(416);
    expect(r.headers['content-range']).toBe('bytes */5000');
  });

  it('answers HEAD with the headers and no body, for files and for the page', async () => {
    const file = await ask(port, '/clip.mp4', {}, 'HEAD');
    expect([file.status, file.headers['content-length'], file.body.length]).toEqual([200, '5000', 0]);
    const page = await ask(port, '/', {}, 'HEAD');
    const got = await ask(port, '/');
    expect([page.status, page.body.length]).toEqual([200, 0]);
    expect(page.headers['content-length']).toBe(String(got.body.length));
    expect(got.body.toString()).toContain('<script src="/teleport.js"></script>');
  });

  it('serves an empty file as one', async () => {
    const r = await ask(port, '/empty.js');
    expect([r.status, r.headers['content-length'], r.body.length]).toEqual([200, '0', 0]);
  });

  // Each of these was an error on a stream nobody listened to, which ended the process: one request
  // for one file took every device and DevTools window with it.
  it('answers 404 for a file it cannot open, and carries on', async (ctx) => {
    // Root reads any file, so there is nothing to refuse.
    if (process.getuid?.() === 0) return ctx.skip();
    expect((await ask(port, '/locked.js')).status).toBe(404);
    expect((await ask(port, '/folder.js/')).status).toBe(404);
    expect((await ask(port, '/gone.js')).status).toBe(404);
    expect((await ask(port, '/clip.mp4')).status).toBe(200);
  });
});

describe('an app behind the proxy that misbehaves', () => {
  let app: Server;
  let server: DevServer;
  let port: number;
  const BIG = REWRITE_MAX + 1024 * 1024;

  beforeAll(async () => {
    app = createServer((req, res) => {
      const half = (type: string) => {
        res.writeHead(200, { 'content-type': type, 'content-length': '100000' });
        res.write('var a = 1;');
        setTimeout(() => res.socket?.destroy(), 30);
      };
      if (req.url === '/half.js') return half('text/javascript');
      if (req.url === '/half.bin') return half('application/octet-stream');
      if (req.url === '/big.json') {
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(BIG) });
        const chunk = Buffer.alloc(1024 * 1024, 0x20);
        let left = BIG;
        const go = (): void => {
          while (left > 0) {
            const piece = left >= chunk.length ? chunk : chunk.subarray(0, left);
            left -= piece.length;
            if (!res.write(piece)) return void res.once('drain', go);
          }
          res.end();
        };
        return go();
      }
      res.writeHead(200, { 'content-type': 'text/html' }).end(`<html><head></head><body>http://127.0.0.1:${portOf(app)}/next</body></html>`);
    });
    await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
    server = await startDevServer({ port: 0, host: '127.0.0.1', app: `http://127.0.0.1:${portOf(app)}` });
    port = portOf(server);
  });
  afterAll(async () => {
    await server.close();
    app.closeAllConnections();
    app.close();
  });

  it("ends the device's request when the app drops its answer midway, held or streamed", async () => {
    // Held to be rewritten: nothing was sent yet, so the connection just ends.
    await expect(ask(port, '/half.js')).rejects.toThrow();
    // Streamed: the part that came, then the end.
    const streamed = await ask(port, '/half.bin');
    expect([streamed.cut, streamed.body.toString()]).toEqual([true, 'var a = 1;']);
  });

  it('passes a body too long to hold through as the app sent it', async () => {
    const r = await new Promise<{ status: number; length: string | undefined; bytes: number }>((resolve, reject) => {
      request({ host: '127.0.0.1', port, path: '/big.json' }, (res) => {
        let bytes = 0;
        res.on('data', (c: Buffer) => (bytes += c.length));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, length: res.headers['content-length'], bytes }));
      })
        .on('error', reject)
        .end();
    });
    expect(r).toEqual({ status: 200, length: String(BIG), bytes: BIG });
  });

  it('still rewrites and injects what it can hold', async () => {
    const r = await ask(port, '/');
    expect(r.body.toString()).toContain('<script src="/teleport.js"></script>');
    expect(r.body.toString()).toContain(`http://127.0.0.1:${port}/next`);
  });
});

// A device on another network opens an address of someone's own proxy or port forward, which passes
// the request on to teleport. One that terminates TLS or rewrites Host, and says neither in a header
// (nginx as it comes), leaves nothing in the request to read the device's address from.
describe('behind a proxy that says nothing', () => {
  let app: Server;
  const servers: DevServer[] = [];
  beforeAll(async () => {
    app = createServer((_req, res) => {
      const own = `http://127.0.0.1:${portOf(app)}`;
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'sid=1; Secure; SameSite=None' }).end(`<html><head></head><body><a href="${own}/next">next</a><script>var ws="ws://127.0.0.1:${portOf(app)}/live"</script></body></html>`);
    });
    await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
  });
  afterAll(async () => {
    for (const s of servers) await s.close();
    app.closeAllConnections();
    app.close();
  });
  const start = async (via?: string) => {
    const s = await startDevServer({ port: 0, host: '127.0.0.1', app: `http://127.0.0.1:${portOf(app)}`, via });
    servers.push(s);
    return s;
  };
  // As the proxy passes it on: its own name for teleport as the Host, and no word of where it came from.
  const asProxied = (s: DevServer) => ask(portOf(s), '/', { host: `localhost:${portOf(s)}` });

  it('sends the device to an address it cannot open, unless told the one it uses', async () => {
    const blind = await start();
    expect((await asProxied(blind)).body.toString()).toContain(`href="http://localhost:${portOf(blind)}/next"`);

    const told = await start('https://device.example.com');
    const page = await asProxied(told);
    expect(page.body.toString()).toContain('href="https://device.example.com/next"');
    // Its sockets too, and secure as the page is.
    expect(page.body.toString()).toContain('var ws="wss://device.example.com/live"');
    // The page is https to the device, so a cookie that needs that is kept.
    expect(page.headers['set-cookie']).toEqual(['sid=1; Secure; SameSite=None']);
    expect((await asProxied(blind)).headers['set-cookie']).toEqual(['sid=1']);
  });

  it("knows the device's files by that address: its requests, and what it may read back", async () => {
    const told = await start('https://device.example.com:8443');
    await asProxied(told);
    expect(told.netlog.entries.at(-1)!.url).toBe('https://device.example.com:8443/');
  });

  it('refuses an address that is not one', () => {
    expect(() => startDevServer({ port: 0, host: '127.0.0.1', via: 'device.example.com' })).toThrow(/via takes the address the device opens/);
  });
});

describe('where a request came from', () => {
  const req = (remoteAddress: string, forwardedFor?: string | string[]) => ({ socket: { remoteAddress }, headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor } }) as unknown as IncomingMessage;

  it("is the connection's own address", () => {
    expect(seenFrom(req('192.168.1.40'))).toBe('192.168.1.40');
  });

  it('is the address a tunnel on this machine speaks for', () => {
    expect(seenFrom(req('127.0.0.1', '203.0.113.9'))).toBe('203.0.113.9');
    expect(seenFrom(req('::1', '203.0.113.9, 10.0.0.1'))).toBe('203.0.113.9');
    expect(seenFrom(req('::ffff:127.0.0.1', ['203.0.113.9']))).toBe('203.0.113.9');
  });

  it('is not what another machine claims', () => {
    expect(seenFrom(req('192.168.1.40', '203.0.113.9'))).toBe('192.168.1.40');
  });
});

describe('an app named while teleport runs', () => {
  it('shows a device a page that waits for an app, then serves the app named, with the agent in it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tlpt-later-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head></head><body>later</body></html>');
    const s = await startDevServer({ port: 0, host: '127.0.0.1', keyMemory: null });
    const port = (s.http.address() as { port: number }).port;
    try {
      const waiting = await ask(port, '/', { accept: 'text/html' });
      expect(waiting.status).toBe(200);
      expect(waiting.headers['x-teleport-waiting']).toBe('1');
      expect(waiting.body.toString()).toContain('<meta http-equiv="refresh"');
      expect(waiting.body.toString()).toContain('teleport has no app yet');
      expect(() => s.setApp(join(dir, 'missing'))).toThrow(/not a folder/);
      s.setApp(dir);
      const app = await ask(port, '/', { accept: 'text/html' });
      expect(app.body.toString()).toContain('later');
      expect(app.body.toString()).toContain('<script src="/teleport.js"></script>');
    } finally {
      await s.close();
    }
  });
});
