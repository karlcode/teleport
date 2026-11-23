// A durable channel over successive WebSockets. Each side counts the messages it has received and
// keeps the ones it sent that the other side hasn't acknowledged. A socket that drops is replaced:
// the side that reconnects says how many it got, the other answers with how many it got, and each
// sends only what the other missed. Whoever holds a Link sees one channel that never closed.
//
// The wire carries the application's own text messages unchanged. Control messages are JSON objects
// whose first key is "teleport" (CDP messages never have one) and are not counted:
//   {"teleport":"link","got":<n>,"kept":<bool>}  first message on each socket, from this server
//   {"teleport":"ack","got":<n>}                  either way, so the other side can drop what it kept
//   {"teleport":"bye"}                            from the client: it is closing for good, no grace
//   {"teleport":"gap","lost":<n>}                 from the client, right after "link": n messages this
//                                                 side never got are no longer kept, so they are
//                                                 counted as got and whoever reads the link is told
// A client asks to resume with `?link=<token>&got=<n>` on its WebSocket URL. A text message may carry
// several application messages, a line each: JSON never holds a raw newline. It counts as one.
import type { MessageHandler } from './ws.js';

/** What a Link needs from a socket. `Peer` is one. */
export interface Wire {
  readonly open: boolean;
  readonly bytesIn: number;
  send(data: string | Buffer | Uint8Array, binary?: boolean): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
  onMessage(fn: MessageHandler): void;
  onClose(fn: () => void): void;
}

export interface LinkLimits {
  /** How long the channel outlives a dropped socket, waiting for its client to come back. */
  graceMs: number;
  /** Most sent messages kept for resending, and their total size. The oldest go first. */
  keepCount: number;
  keepBytes: number;
}

const CONTROL = '{"teleport":';
const ACK_MS = 1000;
/** Messages held for handlers that aren't registered yet, as for a DevTools waiting for its tab. */
const QUEUE_MAX = 2000;

export function isControl(data: Buffer | string): boolean {
  return typeof data === 'string' ? data.startsWith(CONTROL) : data.length > CONTROL.length && data[0] === 0x7b && data.toString('latin1', 0, CONTROL.length) === CONTROL;
}

export class Link {
  wire: Wire | null = null;
  /** Messages received from the client, which it asks after when it reconnects. */
  got = 0;
  /** Messages the client says it received. */
  private acked = 0;
  private sent = 0;
  private kept: string[] = [];
  private keptBytes = 0;
  private gone = false;
  private priorBytesIn = 0;
  private grace: NodeJS.Timeout | null = null;
  private ackTimer: NodeJS.Timeout | null = null;
  private ackedGot = 0;
  private queue: Buffer[] = [];
  private messageHandlers: MessageHandler[] = [];
  private closeHandlers: (() => void)[] = [];
  private gapHandlers: (() => void)[] = [];
  /** Messages the client sent that never arrived and it no longer kept, over the life of the link. */
  missed = 0;
  /** Messages the client asked for that were no longer kept, over the life of the link. */
  lost = 0;
  /** Sockets this link has run on. */
  wires = 0;

  constructor(
    /** null for a client that doesn't speak this protocol: the link ends with its socket. */
    readonly token: string | null,
    private limits: LinkLimits,
  ) {}

  get open() {
    return !this.gone;
  }

  /** Whether a socket is carrying the link right now. */
  get connected() {
    return !!this.wire?.open;
  }

  get bytesIn() {
    return this.priorBytesIn + (this.wire?.bytesIn ?? 0);
  }

  /** Carries the link on `wire` from now on. `theirGot` is how many messages the client says it has.
   *  `kept` tells the client whether this side still had its state. */
  attach(wire: Wire, theirGot: number, kept: boolean) {
    if (this.gone) return void wire.close(1001, 'link ended');
    const old = this.wire;
    if (old) {
      this.priorBytesIn += old.bytesIn;
      this.wire = null;
      old.close(1000, 'replaced');
    }
    if (this.grace) clearTimeout(this.grace);
    this.grace = null;
    this.wire = wire;
    this.wires++;
    wire.onMessage((data, isBinary) => {
      if (this.wire === wire) this.receive(data, isBinary);
    });
    wire.onClose(() => {
      if (this.wire === wire) this.dropped();
    });
    if (!this.token) return;
    wire.send(`{"teleport":"link","got":${this.got},"kept":${kept}}`);
    this.trim(theirGot);
    const first = this.sent - this.kept.length + 1;
    if (theirGot + 1 < first) this.lost += first - theirGot - 1;
    for (let i = Math.max(0, theirGot + 1 - first); i < this.kept.length; i++) wire.send(this.kept[i]!);
  }

  send(msg: string) {
    if (this.gone) return;
    if (this.token) {
      this.sent++;
      this.kept.push(msg);
      this.keptBytes += msg.length;
      while (this.kept.length > this.limits.keepCount || (this.keptBytes > this.limits.keepBytes && this.kept.length > 1)) this.keptBytes -= this.kept.shift()!.length;
    }
    if (this.wire?.open) this.wire.send(msg);
  }

  /** A control message for a client that speaks this protocol, never kept or counted. */
  control(msg: string) {
    if (this.token && this.wire?.open) this.wire.send(msg);
  }

  onMessage(fn: MessageHandler) {
    this.messageHandlers.push(fn);
    const queued = this.queue;
    this.queue = [];
    for (const data of queued) fn(data, false);
  }

  /** fn runs when the client says messages were lost for good: what follows can't lean on them. */
  onGap(fn: () => void) {
    this.gapHandlers.push(fn);
  }

  onClose(fn: () => void) {
    if (this.gone) fn();
    else this.closeHandlers.push(fn);
  }

  /** Ends the link for good: the client is told, and won't resume it. */
  close(code = 1000, reason = '') {
    const wire = this.wire;
    this.wire = null;
    wire?.close(code, reason);
    this.finish();
  }

  /** Ends the link at once, sending nothing, as when the server shuts down. */
  terminate() {
    const wire = this.wire;
    this.wire = null;
    if (wire?.terminate) wire.terminate();
    else wire?.close();
    this.finish();
  }

  private receive(data: Buffer, isBinary: boolean) {
    if (!isBinary && isControl(data)) {
      const m = parse(data.toString());
      if (m?.teleport === 'ack' && typeof m.got === 'number') this.trim(m.got);
      else if (m?.teleport === 'bye') this.close();
      else if (m?.teleport === 'gap' && typeof m.lost === 'number' && m.lost > 0) {
        this.got += m.lost;
        this.missed += m.lost;
        for (const fn of this.gapHandlers) fn();
      }
      return;
    }
    this.got++;
    if (this.token && !this.ackTimer) this.ackTimer = setTimeout(() => this.ack(), ACK_MS);
    for (const part of isBinary || !data.includes(0x0a) ? [data] : lines(data)) {
      if (!this.messageHandlers.length) {
        if (this.queue.length < QUEUE_MAX) this.queue.push(part);
        continue;
      }
      for (const fn of this.messageHandlers) fn(part, isBinary);
    }
  }

  private ack() {
    this.ackTimer = null;
    if (this.got === this.ackedGot || !this.wire?.open) return;
    this.ackedGot = this.got;
    this.wire.send(`{"teleport":"ack","got":${this.got}}`);
  }

  /** Forgets kept messages the client has. */
  private trim(theirGot: number) {
    if (theirGot <= this.acked) return;
    this.acked = Math.min(theirGot, this.sent);
    const first = this.sent - this.kept.length + 1;
    let n = this.acked - first + 1;
    while (n-- > 0 && this.kept.length) this.keptBytes -= this.kept.shift()!.length;
  }

  private dropped() {
    if (this.wire) this.priorBytesIn += this.wire.bytesIn;
    this.wire = null;
    if (!this.token || this.limits.graceMs <= 0) return this.finish();
    this.grace = setTimeout(() => this.finish(), this.limits.graceMs);
  }

  private finish() {
    if (this.gone) return;
    this.gone = true;
    if (this.grace) clearTimeout(this.grace);
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.kept = [];
    this.queue = [];
    for (const fn of this.closeHandlers) fn();
    this.closeHandlers = [];
  }
}

function lines(data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let at = 0; at < data.length; ) {
    const end = data.indexOf(0x0a, at);
    const stop = end < 0 ? data.length : end;
    if (stop > at) out.push(data.subarray(at, stop));
    at = stop + 1;
  }
  return out;
}

function parse(s: string): { teleport?: string; got?: number; lost?: number } | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
