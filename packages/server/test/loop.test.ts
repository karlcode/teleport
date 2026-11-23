import { createServer, request, type Server } from 'node:http';
import { connect } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startDevServer, type DevServer } from '../src/server.js';

// Any tunnel, pointed at teleport, then given to teleport as the app: teleport would proxy itself.
describe('a tunnel that forwards to teleport, given to teleport as the app', () => {
  let s: DevServer;
  let tunnel: Server;
  let base = '';
  beforeAll(async () => {
    let port = 0;
    tunnel = createServer((req, res) => {
      const up = request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers: { ...req.headers, 'x-forwarded-for': '203.0.113.5' } }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      });
      up.on('error', () => res.destroy());
      req.pipe(up);
    });
    tunnel.on('upgrade', (req, socket, head) => {
      const up = connect(port, '127.0.0.1', () => {
        up.write([`${req.method} ${req.url} HTTP/1.1`, ...Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`)].join('\r\n') + '\r\n\r\n');
        if (head.length) up.write(head);
        up.pipe(socket);
        socket.pipe(up);
      });
      up.on('error', () => socket.destroy());
      socket.on('error', () => up.destroy());
    });
    await new Promise<void>((r) => tunnel.listen(0, '127.0.0.1', r));
    const tunnelUrl = `http://127.0.0.1:${(tunnel.address() as { port: number }).port}`;
    s = await startDevServer({ port: 0, host: '127.0.0.1', app: tunnelUrl });
    port = (s.http.address() as { port: number }).port;
    base = `127.0.0.1:${port}`;
  });
  afterAll(async () => {
    await s.close();
    tunnel.closeAllConnections();
    tunnel.close();
  });

  it('answers at once that the app address leads back to teleport, instead of proxying itself', async () => {
    const res = await fetch(`http://${base}/`, { signal: AbortSignal.timeout(3000) });
    expect(res.status).toBe(508);
    expect(await res.text()).toMatch(/forwards to teleport itself.*teleport localhost:/);
  });

  it("refuses the app's WebSockets the same way", async () => {
    const ws = new WebSocket(`ws://${base}/hmr`);
    const outcome = await new Promise<string>((resolve) => {
      ws.once('open', () => resolve('open'));
      ws.once('unexpected-response', (_req, res) => resolve(String(res.statusCode)));
      ws.once('error', () => resolve('error'));
      setTimeout(() => resolve('hung'), 3000);
    });
    ws.terminate();
    expect(outcome).toBe('508');
  });
});
