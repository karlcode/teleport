import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { accept, type Peer } from '../src/ws.js';
import { startDevServer } from '../src/server.js';

let http: Server | null = null;
afterEach(() => void http?.close());

/** A bare server on ws.ts that records what each socket receives. */
async function serve(deflate: boolean) {
  const got: { text: string; binary: boolean }[] = [];
  let peer: Peer | null = null;
  http = createServer();
  http.on('upgrade', (req, socket, head) => {
    peer = accept(req, socket, head, { deflate });
    peer?.onMessage((d, binary) => got.push({ text: d.toString(), binary }));
  });
  await new Promise<void>((r) => http!.listen(0, '127.0.0.1', () => r()));
  return { url: `ws://127.0.0.1:${(http.address() as { port: number }).port}/`, got, peer: () => peer };
}
const agreed = new WeakMap<WebSocket, string>();
const client = (url: string, headers: Record<string, string> = {}) =>
  new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url, { perMessageDeflate: { threshold: 0, clientMaxWindowBits: true }, headers });
    ws.once('upgrade', (res) => agreed.set(ws, String(res.headers['sec-websocket-extensions'] ?? '')));
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
};
const big = (k: number) => JSON.stringify({ method: 'Runtime.consoleAPICalled', params: { type: 'log', args: Array.from({ length: 50 }, (_, i) => ({ type: 'object', value: { row: k, col: i, title: 'Episode ' + i } })) } });

describe('permessage-deflate', () => {
  it("takes a device's compressed messages, in order with uncompressed ones, in a small window", async () => {
    const s = await serve(true);
    const ws = await client(s.url);
    expect(agreed.get(ws)).toBe('permessage-deflate; server_no_context_takeover; client_max_window_bits=11');
    const sent = [big(1), 'small', big(2), big(3)];
    for (const m of sent) ws.send(m);
    ws.send(Buffer.from([1, 2, 3]), { compress: true });
    await until(() => s.got.length === 5);
    expect(s.got.slice(0, 4).map((g) => g.text)).toEqual(sent);
    expect(s.got[4]!.binary).toBe(true);
    // The window carries from message to message: later ones shrink to a fraction on the wire.
    expect(s.peer()!.bytesIn).toBeLessThan(sent.join('').length / 5);
    ws.close();
  });

  it('is not offered where the server does not ask for it', async () => {
    const s = await serve(false);
    const ws = await client(s.url);
    expect(ws.extensions).toBe('');
    ws.send(big(1));
    await until(() => s.got.length === 1);
    expect(s.got[0]!.text).toBe(big(1));
    ws.close();
  });

  it("is used on an inspector's socket, through a tunnel or not, and never on the agent's", async () => {
    const dev = await startDevServer({ port: 0, host: '127.0.0.1' });
    const base = `ws://127.0.0.1:${(dev.http.address() as { port: number }).port}`;
    const dut = await client(`${base}/ws/target?id=z1&page=a`, { 'x-forwarded-for': '203.0.113.7' });
    const tunnelled = await client(`${base}/ws/cdp/z1?link=zinspector01&got=0`, { 'x-forwarded-for': '203.0.113.7' });
    const lan = await client(`${base}/ws/cdp/z1?link=zinspector02&got=0`);
    expect(dut.extensions).toBe('');
    expect(tunnelled.extensions).toContain('permessage-deflate');
    expect(lan.extensions).toContain('permessage-deflate');
    for (const ws of [dut, tunnelled, lan]) ws.close();
    await dev.close();
  });

  it('is not offered again to a browser whose compressed message did not inflate', async () => {
    const dev = await startDevServer({ port: 0, host: '127.0.0.1' });
    const port = (dev.http.address() as { port: number }).port;
    const ua = 'OddTV/1.0';
    const dut = await client(`ws://127.0.0.1:${port}/ws/target?id=odd&page=a`);
    // A handshake that offers deflate, then one message marked compressed that isn't deflate at all.
    const code = await new Promise<number>((resolve) => {
      const sock = connect(port, '127.0.0.1', () => {
        sock.write(
          ['GET /ws/cdp/odd?link=oddinspector1&got=0 HTTP/1.1', 'Host: 127.0.0.1', 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Extensions: permessage-deflate', 'X-Forwarded-For: 203.0.113.7', `User-Agent: ${ua}`, '', ''].join('\r\n'),
        );
      });
      let buf = Buffer.alloc(0);
      sock.on('data', (c) => {
        buf = Buffer.concat([buf, c]);
        const end = buf.indexOf('\r\n\r\n');
        if (end > 0 && !sock.readable) return;
        if (end > 0 && buf.toString('latin1', 0, end).includes('permessage-deflate') && !(sock as unknown as { sent?: boolean }).sent) {
          (sock as unknown as { sent: boolean }).sent = true;
          const junk = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02]);
          const mask = Buffer.from([1, 2, 3, 4]);
          const masked = Buffer.from(junk.map((b, i) => b ^ mask[i & 3]!));
          sock.write(Buffer.concat([Buffer.from([0xc1, 0x80 | junk.length]), mask, masked]));
        }
        const close = buf.indexOf(0x88, end + 4);
        if (end > 0 && close > 0 && buf.length >= close + 4) resolve(buf.readUInt16BE(close + 2));
      });
    });
    expect(code).toBe(1007);
    const again = await client(`ws://127.0.0.1:${port}/ws/cdp/odd?link=oddinspector2&got=0`, { 'x-forwarded-for': '203.0.113.7', 'user-agent': ua });
    expect(agreed.get(again)).toBe('');
    again.close();
    dut.close();
    await dev.close();
  });
});
