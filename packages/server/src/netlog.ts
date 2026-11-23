// Every app request that passes through the teleport server, recorded on the laptop. The device pays
// nothing for this: DevTools' Network panel and the trace get these requests from here instead of
// from wrappers inside the page. Bounded by entry count and by total body bytes.
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import type { NetRecord } from './analyze.js';
import { seenAs, seenFrom } from './app.js';

export interface NetEntry extends NetRecord {
  seq: number;
  ip: string;
  statusText: string;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
}

interface Body {
  chunks: Buffer[];
  size: number;
  /** Set when the body outgrew BODY_MAX and was dropped. */
  tooLarge: boolean;
}

const ENTRY_CAP = 5000;
const BODY_MAX = 16 << 20;
const BODY_TOTAL = 256 << 20;
const TEXT = /^(text\/|application\/(json|javascript|xml|x-www-form-urlencoded)|image\/svg)|\+json|\+xml/;

export const serverNow = () => performance.timeOrigin + performance.now();

function flat(h: Record<string, string | string[] | number | undefined> | OutgoingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) if (v !== undefined) out[k] = Array.isArray(v) ? v.join(', ') : String(v);
  return out;
}

function resourceType(req: IncomingMessage, mime: string): string {
  switch (req.headers['sec-fetch-dest']) {
    case 'document': case 'iframe': return 'Document';
    case 'script': return 'Script';
    case 'style': return 'Stylesheet';
    case 'image': return 'Image';
    case 'font': return 'Font';
    case 'video': case 'audio': case 'track': return 'Media';
    case 'empty': return 'XHR';
  }
  if (mime === 'text/html') return 'Document';
  if (/javascript/.test(mime)) return 'Script';
  if (mime === 'text/css') return 'Stylesheet';
  if (mime.startsWith('image/')) return 'Image';
  if (mime.startsWith('font/')) return 'Font';
  if (mime.startsWith('video/') || mime.startsWith('audio/')) return 'Media';
  if (/json|xml/.test(mime)) return 'XHR';
  return 'Other';
}

export class NetLog {
  readonly entries: NetEntry[] = [];
  private bodies = new Map<number, Body>();
  bodyBytes = 0;
  private seq = 0;
  private listeners = new Set<(e: NetEntry) => void>();

  /** `via`: the address the device opens, when it was said outright (app.ts `seenAs`). */
  constructor(private via: URL | null = null) {}

  onEntry(fn: (e: NetEntry) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Start of the last HTML document `ip` loaded at or before `at`, so a device's log starts at its page load. */
  navigationStart(ip: string, at: number) {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i]!;
      if (e.ip === ip && e.type === 'Document' && e.start <= at) return e.start;
    }
    return at;
  }

  /** The CDP getResponseBody result, or why there is none. */
  body(id: string): { body: string; base64Encoded: boolean } | string {
    const e = this.entries.find((x) => x.id === id);
    const b = e && this.bodies.get(e.seq);
    if (!e || !b) return 'No body kept for this request (evicted, or the log was full)';
    if (b.tooLarge) return `Body not kept: larger than ${BODY_MAX >> 20} MB`;
    const data = Buffer.concat(b.chunks);
    return TEXT.test(e.mimeType) ? { body: data.toString('utf8'), base64Encoded: false } : { body: data.toString('base64'), base64Encoded: true };
  }

  /** The first `max` bytes of a kept body, for reading an image header without copying the whole file. */
  head(id: string, max = 64 * 1024): Buffer | null {
    const e = this.entries.find((x) => x.id === id);
    const b = e && this.bodies.get(e.seq);
    if (!b || b.tooLarge) return null;
    const out: Buffer[] = [];
    let n = 0;
    for (const c of b.chunks) {
      out.push(c);
      n += c.length;
      if (n >= max) break;
    }
    return Buffer.concat(out).subarray(0, max);
  }

  /** Records `req` by watching what the handler writes to `res`. */
  record(req: IncomingMessage, res: ServerResponse) {
    const start = serverNow();
    const { proto, host } = seenAs(req, this.via);
    const seq = ++this.seq;
    const e: NetEntry = {
      seq,
      id: 'p' + seq,
      ip: seenFrom(req),
      method: req.method ?? 'GET',
      url: `${proto}://${host}${req.url ?? '/'}`,
      status: 0,
      statusText: '',
      type: 'Other',
      mimeType: '',
      requestHeaders: flat(req.headers),
      responseHeaders: {},
      start,
      ttfb: start,
      end: start,
      bytes: 0,
    };
    const body: Body = { chunks: [], size: 0, tooLarge: false };
    const keep = (chunk: unknown, encoding?: unknown) => {
      if (chunk === undefined || chunk === null || typeof chunk === 'function') return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string, typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8');
      e.bytes += buf.length;
      if (body.tooLarge) return;
      if (body.size + buf.length > BODY_MAX) {
        body.tooLarge = true;
        body.chunks = [];
        return;
      }
      body.chunks.push(buf);
      body.size += buf.length;
    };

    const writeHead = res.writeHead;
    res.writeHead = function (this: ServerResponse, ...args: unknown[]) {
      const r = writeHead.apply(this, args as Parameters<typeof writeHead>);
      const headers = args.find((a, i) => i > 0 && a && typeof a === 'object' && !Array.isArray(a)) as OutgoingHttpHeaders | undefined;
      e.ttfb = serverNow();
      e.status = this.statusCode;
      e.statusText = this.statusMessage ?? '';
      e.responseHeaders = flat({ ...this.getHeaders(), ...(headers ?? {}) });
      e.mimeType = (e.responseHeaders['content-type'] ?? '').split(';')[0]!.trim();
      e.type = resourceType(req, e.mimeType);
      return r;
    } as typeof res.writeHead;
    const write = res.write;
    res.write = function (this: ServerResponse, chunk: unknown, ...rest: unknown[]) {
      keep(chunk, rest[0]);
      return write.call(this, chunk, ...(rest as [BufferEncoding, () => void]));
    } as typeof res.write;
    const end = res.end;
    res.end = function (this: ServerResponse, chunk?: unknown, ...rest: unknown[]) {
      keep(chunk, rest[0]);
      return end.call(this, chunk, ...(rest as [BufferEncoding, () => void]));
    } as typeof res.end;

    const done = (failed?: string) => {
      e.end = serverNow();
      if (failed) e.failed = failed;
      this.add(e, body);
    };
    res.once('finish', () => done());
    res.once('close', () => {
      if (!res.writableFinished) done('net::ERR_ABORTED');
    });
  }

  private add(e: NetEntry, body: Body) {
    this.entries.push(e);
    this.bodies.set(e.seq, body);
    this.bodyBytes += body.size;
    while (this.entries.length > ENTRY_CAP) this.drop(this.entries.shift()!);
    while (this.bodyBytes > BODY_TOTAL && this.bodies.size > 1) {
      const oldest = this.bodies.keys().next().value!;
      this.bodyBytes -= this.bodies.get(oldest)!.size;
      this.bodies.delete(oldest);
    }
    for (const fn of this.listeners) fn(e);
  }

  private drop(e: NetEntry) {
    const b = this.bodies.get(e.seq);
    if (b) this.bodyBytes -= b.size;
    this.bodies.delete(e.seq);
  }
}
