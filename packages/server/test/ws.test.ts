import { createServer, type Server } from 'node:http';
import { PassThrough } from 'node:stream';
import { deflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { accept, Peer, type PeerOptions } from '../src/ws.js';

let http: Server;
let url: string;

// An echo server: every message comes back with its text/binary flag intact.
beforeAll(async () => {
  http = createServer();
  http.on('upgrade', (req, socket, head) => {
    const peer = accept(req, socket, head)!;
    peer.onMessage((data, isBinary) => peer.send(data, isBinary));
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  url = `ws://127.0.0.1:${(http.address() as { port: number }).port}/`;
});
afterAll(() => {
  http.closeAllConnections();
  http.close();
});

const connect = () =>
  new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });

const echo = (ws: WebSocket) =>
  new Promise<{ data: Buffer; isBinary: boolean }>((resolve) => ws.once('message', (data: Buffer, isBinary) => resolve({ data, isBinary })));

describe('websocket server', () => {
  it('echoes text and binary at every length encoding', async () => {
    const ws = await connect();
    for (const len of [0, 125, 126, 65535, 65536, 300_000]) {
      const text = 'x'.repeat(len);
      const back = echo(ws);
      ws.send(text);
      const r = await back;
      expect(r.isBinary).toBe(false);
      expect(r.data.toString()).toBe(text);
    }
    const bytes = Buffer.from([0, 1, 2, 250, 255]);
    const back = echo(ws);
    ws.send(bytes);
    const r = await back;
    expect(r.isBinary).toBe(true);
    expect([...r.data]).toEqual([...bytes]);
    ws.close();
  });

  it('reassembles fragmented messages', async () => {
    const ws = await connect();
    const back = echo(ws);
    ws.send('hello ', { fin: false });
    ws.send('frag', { fin: false });
    ws.send('ments', { fin: true });
    expect((await back).data.toString()).toBe('hello fragments');
    ws.close();
  });

  it('answers ping and completes the close handshake', async () => {
    const ws = await connect();
    const pong = new Promise<Buffer>((r) => ws.once('pong', r));
    ws.ping('p1');
    expect((await pong).toString()).toBe('p1');
    const closed = new Promise<number>((r) => ws.once('close', r));
    ws.close(4001);
    expect(await closed).toBe(4001);
  });
});

// What a socket takes in, byte by byte, with no client library between the test and the parser.
describe('frames that arrive in pieces', () => {
  /** A Peer on a stream the test writes to, and what it delivered. */
  function wired(opts: PeerOptions = {}) {
    const socket = new PassThrough();
    const got: Buffer[] = [];
    const peer = new Peer(socket, opts);
    peer.onMessage((d) => got.push(d));
    return { socket, got, peer };
  }
  /** One masked frame, as a browser sends it. */
  function frame(payload: Buffer, op = 2, rsv1 = false): Buffer {
    const n = payload.length;
    const head = n < 126 ? Buffer.from([0, 0x80 | n]) : n < 65536 ? Buffer.from([0, 0x80 | 126, n >> 8, n & 255]) : Buffer.from([0, 0x80 | 127, 0, 0, 0, 0, n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
    head[0] = 0x80 | (rsv1 ? 0x40 : 0) | op;
    const mask = Buffer.from([1, 2, 3, 4]);
    const body = Buffer.from(payload);
    for (let i = 0; i < body.length; i++) body[i]! ^= mask[i & 3]!;
    return Buffer.concat([head, mask, body]);
  }
  const bytes = (n: number) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 7) & 255));

  it('reads the same messages wherever the pieces are cut', () => {
    const messages = [bytes(0), bytes(5), bytes(125), bytes(126), bytes(300), bytes(70000)];
    const wire = Buffer.concat(messages.map((m) => frame(m)));
    for (const cut of [1, 2, 3, 7, 13, 1000, wire.length]) {
      const s = wired();
      for (let at = 0; at < wire.length; at += cut) s.socket.write(wire.subarray(at, at + cut));
      expect(s.got.map((g) => g.length), `cut every ${cut}`).toEqual(messages.map((m) => m.length));
      expect(Buffer.concat(s.got).equals(Buffer.concat(messages)), `cut every ${cut}`).toBe(true);
      s.peer.terminate();
    }
  });

  it('joins a frame once, however many pieces it came in', () => {
    const s = wired();
    const wire = frame(bytes(2_000_000));
    const joins = vi.spyOn(Buffer, 'concat');
    for (let at = 0; at < wire.length; at += 4096) s.socket.write(wire.subarray(at, at + 4096));
    const calls = joins.mock.calls.length;
    joins.mockRestore();
    expect(s.got[0]!.length).toBe(2_000_000);
    // 489 pieces: joined at each one, that is 489 copies of all that came before.
    expect(calls).toBeLessThanOrEqual(2);
    s.peer.terminate();
  });

  it('refuses a frame longer than the limit before any of it is kept', () => {
    const s = wired({ maxMessage: 1000 });
    s.socket.write(frame(bytes(1001)).subarray(0, 8));
    expect(s.peer.open).toBe(false);
    expect(s.got).toEqual([]);
  });

  it('stops inflating at the limit: a small message that inflates to a large one is refused, not read', async () => {
    const s = wired({ deflate: true, maxMessage: 1_000_000 });
    const closed = new Promise<void>((r) => s.peer.onClose(r));
    // 64 MB of zeros in about 64 KB: read to its end, it was held whole before its size was looked at.
    const bomb = deflateRawSync(Buffer.alloc(64 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(100_000);
    const before = process.memoryUsage().arrayBuffers;
    s.socket.write(frame(bomb, 1, true));
    await closed;
    expect(s.got).toEqual([]);
    // Too big is not a browser whose compression is broken, which is never offered it again.
    expect(s.peer.badDeflate).toBe(false);
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(16 * 1024 * 1024);
  });

  it('still reads a compressed message under the limit', async () => {
    const s = wired({ deflate: true, maxMessage: 1_000_000 });
    const text = JSON.stringify({ rows: Array.from({ length: 2000 }, (_, i) => ({ i, title: 'Episode ' + i })) });
    s.socket.write(frame(deflateRawSync(Buffer.from(text)), 1, true));
    for (let i = 0; i < 100 && !s.got.length; i++) await new Promise((r) => setTimeout(r, 5));
    expect(s.got[0]!.toString()).toBe(text);
    s.peer.terminate();
  });
});
