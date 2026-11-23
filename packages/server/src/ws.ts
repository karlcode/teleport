import { createHash } from 'node:crypto';
import { constants, createInflateRaw, type InflateRaw } from 'node:zlib';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';

// RFC 6455 server side: handshake, framing, masking, fragmentation, ping/pong and close. No
// subprotocols. permessage-deflate (RFC 7692) only where the caller asks, and only for what the other
// side sends: see DEFLATE_RESPONSE.

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 64 * 1024 * 1024;
/** Every open socket is pinged this often, so a tunnel or router never sees a quiet link to close. */
export const PING_MS = 5000;
/** A socket that sends nothing back for this long, not even a pong, died without a close (a tunnel
 *  restarted, the device lost power): it is dropped, so its page reconnects instead of hanging on it. */
export const DEAD_MS = 45000;
/** After sending a close frame, how long the other side gets to finish the close before the socket
 *  is destroyed. A dead link never finishes it, and the socket would stay half-closed for good. */
export const CLOSE_MS = 2000;

export interface PeerOptions {
  /** Silence after which this socket is taken for dead. A device's link through a tunnel asks for less. */
  deadMs?: number;
  /** Let the other side compress what it sends, if it offers to. */
  deflate?: boolean;
  /** The longest message taken, in bytes, as sent and as inflated. 64 MB unless said. */
  maxMessage?: number;
}

/** What inflate answers for a message that outgrew the limit while it inflated. */
const TOO_BIG = Symbol('too big');

/** The other side compresses with one context for the whole socket, which shrinks CDP's repetitive
 *  JSON about 20x, in a 2 KB window: as small as it gets before the ratio falls, and the device keeps
 *  less memory for it. This side never compresses (what it sends a device is small), so the other side
 *  needn't keep a context to read it. */
const DEFLATE_RESPONSE = 'permessage-deflate; server_no_context_takeover';
const CLIENT_WINDOW_BITS = 11;
const DEFLATE_PARAMS = new Set(['client_max_window_bits', 'server_max_window_bits', 'client_no_context_takeover', 'server_no_context_takeover']);
/** What each compressed message lacks at its end (RFC 7692 7.2.2). */
const DEFLATE_TAIL = Buffer.from([0x00, 0x00, 0xff, 0xff]);

/** The extension response to an offer this server can take, or null. */
export function deflateResponse(offer: string | undefined): string | null {
  for (const ext of (offer ?? '').split(',')) {
    const [name, ...params] = ext.split(';').map((p) => p.trim());
    if (name !== 'permessage-deflate') continue;
    const values = new Map(params.map((p) => [p.split('=')[0]!.trim(), p.split('=')[1]?.trim().replace(/"/g, '')]));
    if ([...values.keys()].some((k) => !DEFLATE_PARAMS.has(k))) continue;
    let out = DEFLATE_RESPONSE;
    // An offer that limits this side's window must hear it accepted, though nothing is compressed here.
    if (values.has('server_max_window_bits')) out += `; server_max_window_bits=${values.get('server_max_window_bits') ?? 15}`;
    if (values.has('client_no_context_takeover')) out += '; client_no_context_takeover';
    if (values.has('client_max_window_bits')) out += `; client_max_window_bits=${CLIENT_WINDOW_BITS}`;
    return out;
  }
  return null;
}

const live = new Set<Peer>();
let beat: NodeJS.Timeout | null = null;
let lastBeat = 0;

function heartbeat() {
  const now = Date.now();
  // A beat this late means the laptop slept or the event loop stalled. Nobody was listening, so the
  // silence says nothing about the far side: it counts from now.
  const unheard = lastBeat > 0 && now - lastBeat > 2 * PING_MS;
  lastBeat = now;
  for (const peer of live) peer.check(now, unheard);
}

const enum Op {
  Continuation = 0,
  Text = 1,
  Binary = 2,
  Close = 8,
  Ping = 9,
  Pong = 10,
}

function unmask(p: Buffer, mask: Buffer) {
  const m = mask.readUInt32LE(0);
  const words = p.length & ~3;
  let i = 0;
  for (; i < words; i += 4) p.writeUInt32LE((p.readUInt32LE(i) ^ m) >>> 0, i);
  for (; i < p.length; i++) p[i]! ^= mask[i & 3]!;
}

export type MessageHandler = (data: Buffer, isBinary: boolean) => void;

export class Peer {
  open = true;
  /** The code in the other side's close frame. null when the connection ended without one, which is
   *  what a crashed or killed page looks like (a clean unload sends 1001). */
  remoteCode: number | null = null;
  /** Bytes received on the socket, framing included. */
  bytesIn = 0;
  /** Set when this side ended the connection, which is never a crash of the other side. */
  closedLocally = false;
  /** Set when a message the other side compressed didn't inflate: its browser's deflate is broken. */
  badDeflate = false;
  /** When anything last arrived, a pong included. */
  private heardAt = Date.now();
  /** What has arrived of a frame that isn't whole yet, joined once when its last piece is in.
   *  Joined at every piece, each copied all that came before it: a 60 MB frame in 16 KB pieces
   *  took this process from 82 MB to 3.9 GB. */
  private pieces: Buffer[] = [];
  private piecesLen = 0;
  /** How many bytes the frame being read needs before more of it can be read. */
  private need = 2;
  private maxMessage: number;
  private parts: Buffer[] = [];
  private partsLen = 0;
  private partsOp: Op = Op.Text;
  private messageHandlers: MessageHandler[] = [];
  private closeHandlers: (() => void)[] = [];
  private deadMs: number;
  private partsCompressed = false;
  /** Set when the other side compresses: messages then pass through it, one at a time, in order. */
  private inflater: InflateRaw | null = null;
  private inbox: Promise<void> = Promise.resolve();

  constructor(
    private socket: Duplex,
    opts: PeerOptions = {},
  ) {
    this.deadMs = opts.deadMs ?? DEAD_MS;
    this.maxMessage = opts.maxMessage ?? MAX_MESSAGE;
    if (opts.deflate) this.inflater = createInflateRaw({ windowBits: 15 });
    (socket as Socket).setNoDelay?.(true);
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('close', () => this.finish());
    socket.on('error', () => socket.destroy());
    // The HTTP server keeps sockets half-open, so a link that ends with no close frame (a tunnel
    // dropping it) would otherwise never close here.
    socket.on('end', () => socket.destroy());
    live.add(this);
    if (!beat) {
      lastBeat = Date.now();
      beat = setInterval(heartbeat, PING_MS).unref();
    }
  }

  /** Pings the other side, or drops it if it has said nothing for its dead limit. */
  check(now: number, unheard = false) {
    if (unheard) this.heardAt = now;
    if (now - this.heardAt >= this.deadMs) this.terminate();
    else this.write(Op.Ping, Buffer.alloc(0));
  }

  onMessage(fn: MessageHandler) {
    this.messageHandlers.push(fn);
  }

  onClose(fn: () => void) {
    if (this.open) this.closeHandlers.push(fn);
    else fn();
  }

  send(data: string | Buffer | Uint8Array, binary = typeof data !== 'string') {
    if (!this.open) return;
    const payload = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    this.write(binary ? Op.Binary : Op.Text, payload);
  }

  close(code = 1000, reason = '') {
    if (!this.open) return;
    if (this.remoteCode === null) this.closedLocally = true;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    this.write(Op.Close, body);
    this.socket.end();
    setTimeout(() => this.socket.destroy(), CLOSE_MS).unref();
    this.finish();
  }

  terminate() {
    this.closedLocally = true;
    this.socket.destroy();
    this.finish();
  }

  private finish() {
    if (!this.open) return;
    this.open = false;
    live.delete(this);
    this.inflater?.close();
    if (!live.size && beat) {
      clearInterval(beat);
      beat = null;
    }
    for (const fn of this.closeHandlers) fn();
    this.closeHandlers = [];
  }

  private write(op: Op, payload: Buffer) {
    const len = payload.length;
    const head = Buffer.allocUnsafe(len < 126 ? 2 : len < 65536 ? 4 : 10);
    head[0] = 0x80 | op;
    if (len < 126) head[1] = len;
    else if (len < 65536) {
      head[1] = 126;
      head.writeUInt16BE(len, 2);
    } else {
      head[1] = 127;
      head.writeUInt32BE(Math.floor(len / 0x100000000), 2);
      head.writeUInt32BE(len >>> 0, 6);
    }
    this.socket.cork();
    this.socket.write(head);
    this.socket.write(payload);
    this.socket.uncork();
  }

  private onData(chunk: Buffer) {
    this.bytesIn += chunk.length;
    this.heardAt = Date.now();
    this.pieces.push(chunk);
    this.piecesLen += chunk.length;
    if (this.piecesLen < this.need) return;
    let b = this.pieces.length === 1 ? chunk : Buffer.concat(this.pieces, this.piecesLen);
    this.pieces = [];
    this.piecesLen = 0;
    /** Keeps what is left until `bytes` of it are in. */
    const wait = (bytes: number) => {
      this.need = bytes;
      if (!b.length) return;
      this.pieces = [b];
      this.piecesLen = b.length;
    };
    while (this.open) {
      if (b.length < 2) return wait(2);
      const fin = (b[0]! & 0x80) !== 0;
      const rsv1 = (b[0]! & 0x40) !== 0;
      const op = (b[0]! & 0x0f) as Op;
      const masked = (b[1]! & 0x80) !== 0;
      let len = b[1]! & 0x7f;
      let at = 2;
      if (len === 126) {
        if (b.length < 4) return wait(4);
        len = b.readUInt16BE(2);
        at = 4;
      } else if (len === 127) {
        if (b.length < 10) return wait(10);
        len = b.readUInt32BE(2) * 0x100000000 + b.readUInt32BE(6);
        at = 10;
      }
      if (!masked || len > this.maxMessage || (rsv1 && (!this.inflater || op >= Op.Close || op === Op.Continuation))) return this.close(1002, 'protocol error');
      if (b.length < at + 4 + len) return wait(at + 4 + len);
      const mask = b.subarray(at, at + 4);
      const payload = Buffer.from(b.subarray(at + 4, at + 4 + len));
      unmask(payload, mask);
      b = b.subarray(at + 4 + len);
      this.frame(fin, op, payload, rsv1);
    }
  }

  private frame(fin: boolean, op: Op, payload: Buffer, rsv1: boolean) {
    if (op === Op.Ping) return this.write(Op.Pong, payload);
    if (op === Op.Pong) return;
    if (op === Op.Close) {
      this.remoteCode = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      return this.close(this.remoteCode === 1005 ? 1000 : this.remoteCode);
    }
    if (op !== Op.Continuation) {
      this.partsOp = op;
      this.partsCompressed = rsv1;
    }
    if (!fin || this.parts.length) {
      this.parts.push(payload);
      this.partsLen += payload.length;
      if (this.partsLen > this.maxMessage) return this.close(1009, 'message too big');
      if (!fin) return;
      payload = Buffer.concat(this.parts, this.partsLen);
      this.parts = [];
      this.partsLen = 0;
    }
    const isBinary = this.partsOp === Op.Binary;
    if (!this.inflater) return this.deliver(payload, isBinary);
    const compressed = this.partsCompressed;
    this.inbox = this.inbox.then(async () => {
      const data = compressed ? await this.inflate(payload) : payload;
      if (!this.open) return;
      if (data === TOO_BIG) return this.close(1009, 'message too big');
      if (!data) {
        this.badDeflate = true;
        return this.close(1007, 'bad compressed message');
      }
      this.deliver(data, isBinary);
    });
  }

  private deliver(data: Buffer, isBinary: boolean) {
    for (const fn of this.messageHandlers) fn(data, isBinary);
  }

  /** One message through the socket's inflate context. null if it doesn't inflate. One that outgrows
   *  the limit stops there: a megabyte of zeros inflates to a gigabyte, so the size is counted as it
   *  grows, never after. */
  private inflate(payload: Buffer): Promise<Buffer | typeof TOO_BIG | null> {
    const z = this.inflater!;
    return new Promise((resolve) => {
      let out: Buffer[] = [];
      let n = 0;
      let done = false;
      const onData = (c: Buffer) => {
        n += c.length;
        if (n <= this.maxMessage) return void out.push(c);
        out = [];
        finish(false);
      };
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        z.off('data', onData);
        z.off('error', onError);
        resolve(n > this.maxMessage ? TOO_BIG : ok ? Buffer.concat(out, n) : null);
      };
      const onError = () => finish(false);
      z.on('data', onData);
      z.once('error', onError);
      z.write(payload);
      z.write(DEFLATE_TAIL);
      z.flush(constants.Z_SYNC_FLUSH, () => finish(true));
    });
  }
}

/** Completes the HTTP upgrade. Returns null (and destroys the socket) if the request isn't a valid handshake. */
export function accept(req: IncomingMessage, socket: Duplex, head: Buffer, opts?: PeerOptions): Peer | null {
  const key = req.headers['sec-websocket-key'];
  if (req.headers.upgrade?.toLowerCase() !== 'websocket' || typeof key !== 'string' || req.headers['sec-websocket-version'] !== '13') {
    socket.destroy();
    return null;
  }
  const digest = createHash('sha1').update(key + GUID).digest('base64');
  const offer = req.headers['sec-websocket-extensions'];
  const deflate = opts?.deflate ? deflateResponse(Array.isArray(offer) ? offer.join(',') : offer) : null;
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${digest}\r\n${deflate ? `Sec-WebSocket-Extensions: ${deflate}\r\n` : ''}\r\n`);
  const peer = new Peer(socket, { ...opts, deflate: !!deflate });
  if (head.length) socket.unshift(head);
  return peer;
}
