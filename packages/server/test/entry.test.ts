import { createServer, request, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { appTarget, entryPath } from '../src/app.js';
import { startDevServer, type DevServer } from '../src/server.js';

const servers: { close(): unknown }[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

function get(port: number, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; location: string | undefined; body: string }>((resolve, reject) => {
    request({ host: '127.0.0.1', port, path, headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, location: res.headers.location, body }));
    })
      .on('error', reject)
      .end();
  });
}

/** An app whose only page is /chrome, like an app that serves one build per platform. */
async function app(): Promise<number> {
  const s: Server = createServer((req, res) => {
    if (req.url === '/chrome?device=1') res.writeHead(200, { 'content-type': 'text/html' }).end('<html><head></head><body>the app</body></html>');
    else res.writeHead(404).end('not here');
  });
  servers.push({ close: () => new Promise((r) => s.close(r)) });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return (s.address() as { port: number }).port;
}

describe("the app's entry point", () => {
  it('keeps the path, query and hash of a URL to proxy', () => {
    expect(entryPath(appTarget('https://app.example.com/chrome?device=1#home'))).toBe('/chrome?device=1#home');
    expect(entryPath(appTarget('https://app.example.com'))).toBe('/');
    expect(entryPath(appTarget('5173'))).toBe('/');
    expect(entryPath(appTarget('.'))).toBe('/');
  });

  it('sends a device that opens the bare address to the entry point, and proxies that page', async () => {
    const port = await app();
    const server: DevServer = await startDevServer({ port: 0, host: '127.0.0.1', app: `http://127.0.0.1:${port}/chrome?device=1` });
    servers.push(server);
    const own = (server.http.address() as { port: number }).port;
    const root = await get(own, '/', { accept: 'text/html,*/*' });
    expect(root.status).toBe(302);
    expect(root.location).toBe('/chrome?device=1');
    const page = await get(own, '/chrome?device=1', { accept: 'text/html' });
    expect(page.status).toBe(200);
    expect(page.body).toContain('<script src="/teleport.js"></script>');
    expect(page.body).toContain('the app');
  });

  it("leaves the root alone for requests that aren't a page", async () => {
    const port = await app();
    const server: DevServer = await startDevServer({ port: 0, host: '127.0.0.1', app: `http://127.0.0.1:${port}/chrome?device=1` });
    servers.push(server);
    expect((await get((server.http.address() as { port: number }).port, '/', { accept: 'application/json' })).status).toBe(404);
  });
});
