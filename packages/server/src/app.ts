import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { close as closeFd, createReadStream, existsSync, fstat, open, readFile, statSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as netConnect } from 'node:net';
import type { Duplex } from 'node:stream';
import * as tls from 'node:tls';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { extname, join, resolve, sep } from 'node:path';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';

export const AGENT_TAG = '<script src="/teleport.js"></script>';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
};

export const typeOf = (file: string) => MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';

/** Puts the agent (and anything that must follow it, such as snippets) first in <head>, before any app script. */
export function injectAgent(html: string, head = AGENT_TAG): string {
  const m = /<head(\s[^>]*)?>/i.exec(html) ?? /<html(\s[^>]*)?>/i.exec(html);
  if (!m) return head + html;
  const at = m.index + m[0].length;
  return html.slice(0, at) + head + html.slice(at);
}

function notFound(res: ServerResponse) {
  res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
}

/**
 * The bytes a `Range` header asks for of a file `size` long: `all` with no header or one this server
 * answers in full (several spans, another unit), null when the span starts past the end.
 */
export function byteRange(header: string | undefined, size: number): { start: number; end: number } | 'all' | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header ?? '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'all';
  if (m[1] === '') {
    // `-n`: the last n bytes.
    const n = Number(m[2]);
    return n > 0 && size > 0 ? { start: Math.max(0, size - n), end: size - 1 } : null;
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  return start < size && start <= end ? { start, end } : null;
}

/**
 * Sends a file. `head`: tags to put first in an HTML file's <head>; null serves it as it is.
 * Anything but a page with tags to add goes with its length and answers `Range`: a device's media
 * stack asks for a video a span at a time, and many refuse one they can't seek in. The file is opened
 * before anything is said, so one that can't be read (gone since it was looked up, as a build
 * cleaning its folder does, or not this user's to read) is a 404 for that request and nothing more.
 */
export function sendFile(res: ServerResponse, file: string, head: string | null, req?: IncomingMessage) {
  const type = typeOf(file);
  const headers: Record<string, string> = { 'content-type': type, 'cache-control': 'no-store' };
  const bodiless = req?.method === 'HEAD';
  if (head !== null && type.startsWith('text/html')) {
    readFile(file, 'utf8', (err, html) => {
      if (err) return notFound(res);
      const body = Buffer.from(injectAgent(html, head));
      res.writeHead(200, { ...headers, 'content-length': String(body.length) }).end(bodiless ? undefined : body);
    });
    return;
  }
  open(file, 'r', (err, fd) => {
    if (err) return notFound(res);
    fstat(fd, (failed, st) => {
      /** Answers without the file's bytes: the file is closed first. */
      const without = (answer: () => void) => closeFd(fd, answer);
      if (failed || !st.isFile()) return without(() => notFound(res));
      const range = byteRange(req?.headers.range, st.size);
      headers['accept-ranges'] = 'bytes';
      if (range === null) return without(() => void res.writeHead(416, { ...headers, 'content-range': `bytes */${st.size}` }).end());
      const span = range === 'all' ? { start: 0, end: st.size - 1 } : range;
      headers['content-length'] = String(st.size === 0 ? 0 : span.end - span.start + 1);
      if (range !== 'all') headers['content-range'] = `bytes ${span.start}-${span.end}/${st.size}`;
      res.writeHead(range === 'all' ? 200 : 206, headers);
      if (bodiless || st.size === 0) return without(() => void res.end());
      const stream = createReadStream(file, { fd, ...span });
      // A read that fails midway ends the response there; the device sees a request that failed.
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    });
  });
}

/** Serves `path` from `dir`, with index.html for directories. Never resolves outside `dir`. */
export function serveDir(res: ServerResponse, dir: string, path: string, head: string | null, req?: IncomingMessage) {
  let rel: string;
  try {
    rel = decodeURIComponent(path);
  } catch {
    return notFound(res);
  }
  let file = resolve(dir, '.' + rel);
  if (file !== dir && !file.startsWith(dir + sep)) return notFound(res);
  // Looked up without throwing: a file may go between one call and the next.
  if (statSync(file, { throwIfNoEntry: false })?.isDirectory()) file = join(file, 'index.html');
  sendFile(res, file, head, req);
}

/** What teleport serves to the device: an app it proxies, or a folder of built files. */
export type AppTarget = { kind: 'proxy'; origin: URL } | { kind: 'dir'; dir: string };

/**
 * `5173`, `:5173` and `localhost:5173` are a dev server, a URL is proxied as it is, a host name that
 * isn't a folder here (`app.example.com`) is that site over https, anything else is a folder.
 */
export function appTarget(arg: string): AppTarget {
  if (/^:?\d{2,5}$/.test(arg)) return { kind: 'proxy', origin: new URL(`http://localhost:${arg.replace(':', '')}`) };
  if (/^https?:\/\//i.test(arg)) return { kind: 'proxy', origin: new URL(arg) };
  if (/^[\w.-]+:\d{2,5}(\/|$)/.test(arg)) return { kind: 'proxy', origin: new URL(`http://${arg}`) };
  if (/^[\w-]+(\.[\w-]+)*\.[a-z]{2,}([/?#]|$)/i.test(arg) && !existsSync(arg)) return { kind: 'proxy', origin: new URL(`https://${arg}`) };
  return { kind: 'dir', dir: resolve(arg) };
}

/**
 * Where the device should open the app: the path, query and hash of a URL to proxy, so
 * `teleport https://app.example.com/chrome` opens /chrome rather than the site's root.
 */
export function entryPath(t: AppTarget): string {
  if (t.kind !== 'proxy') return '/';
  return t.origin.pathname + t.origin.search + t.origin.hash;
}

/** Ports dev servers use by default, most common first. */
export const DEV_PORTS = [5173, 3000, 8080, 4200, 8000, 5000, 1234, 3001, 5174, 4173, 8081, 9000];
const PROBE_MS = 500;

/** The ports on `host` whose root answers with a web page, in the order given. */
export async function findDevServers(ports: number[], host = 'localhost'): Promise<URL[]> {
  const found = await Promise.all(
    ports.map(async (port) => {
      const url = new URL(`http://${host}:${port}`);
      const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_MS) }).catch(() => null);
      await res?.body?.cancel().catch(() => {});
      return res && (res.headers.get('content-type') ?? '').includes('text/html') ? url : null;
    }),
  );
  return found.filter((u): u is URL => u !== null);
}

const LOOPBACK = /^(localhost|127(\.\d+){3}|\[::1\]|0\.0\.0\.0)$/;

/** The address the device used to reach teleport. A tunnel says it in forwarded headers, and
 *  may have rewritten Host to the local address, which the device can't reach. */
export function seenAs(req: IncomingMessage, via: URL | null = null): { proto: 'http' | 'https'; host: string } {
  // Said outright (--via): a proxy or port forward that terminates TLS, or rewrites Host, and puts
  // none of this in a header leaves nothing in the request to read it from.
  if (via) return { proto: via.protocol === 'https:' ? 'https' : 'http', host: via.host };
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.split(',')[0]!.trim() || undefined;
  const secure = first(req.headers['x-forwarded-proto']) === 'https' || !!(req.socket as TLSSocket).encrypted;
  return { proto: secure ? 'https' : 'http', host: first(req.headers['x-forwarded-host']) ?? first(req.headers['x-original-host']) ?? req.headers.host ?? 'localhost' };
}

const FROM_HERE = /^(127\.|::1$|::ffff:127\.)/;

/** The address a request came from. A tunnel connects from this machine and says in a header who it
 *  speaks for, so each device behind one has its own address here; from any other machine the header
 *  is only a claim, and the connection's own address stands. */
export function seenFrom(req: IncomingMessage): string {
  const remote = req.socket.remoteAddress ?? '';
  const v = req.headers['x-forwarded-for'];
  const said = (Array.isArray(v) ? v[0] : v)?.split(',')[0]!.trim();
  return said && FROM_HERE.test(remote) ? said : remote;
}

/** The app's own address as it appears in what the app sends: any scheme, JSON's escaped slashes, and
 *  for an app on this machine, each name for this machine. Another port or a longer host isn't it. */
function ownAddress(origin: URL): RegExp {
  const port = origin.port ? ':' + origin.port : '';
  const hosts = LOOPBACK.test(origin.hostname) ? ['localhost', '127.0.0.1', '[::1]', '0.0.0.0'].map((h) => h + port) : [origin.host];
  const names = hosts.map((h) => h.replace(/[.[\]]/g, '\\$&')).join('|');
  return new RegExp(`\\b(https?|wss?):(\\\\?/\\\\?/)(?:${names})(?![\\w.:-])`, 'gi');
}

/** Points the app's own address at teleport's address as the device knows it, so every link, fetch and
 *  socket the app makes from its own address stays on the proxy, where pages get the agent. */
function toProxy(text: string, own: RegExp, dut: { proto: string; host: string }): string {
  return text.replace(own, (_m, scheme: string, slashes: string) => (/^http/i.test(scheme) ? dut.proto : dut.proto === 'https' ? 'wss' : 'ws') + ':' + slashes + dut.host);
}

/** Some apps start from a launcher page that reads a JSON manifest and injects each script in its
 *  `files`, so the page's HTML never passes through teleport. Listing the agent there, first, gets it
 *  injected with the app's own scripts. Which path is that manifest is said with `--manifest`. */
function addAgentToManifest(text: string, dut: { proto: string; host: string }): string {
  try {
    const m = JSON.parse(text) as { files?: unknown };
    if (!Array.isArray(m.files)) return text;
    const src = `${dut.proto}://${dut.host}/teleport.js`;
    if (!m.files.includes(src)) m.files.unshift(src);
    return JSON.stringify(m, null, 2);
  } catch {
    return text;
  }
}

/** Bodies that can carry the app's address and are worth holding whole to rewrite. Not event streams. */
const REWRITTEN = /^\s*(text\/(html|css|javascript|xml)|application\/((x-)?javascript|ecmascript|xml|xhtml\+xml|([\w.-]+\+)?json)|image\/svg\+xml)\s*(;|$)/i;
/** The longest body held to rewrite. A longer one passes through as the app sent it: its own address
 *  stays in it, and a page that long gets no agent. Held whole, text of 512 MB ended the process. */
export const REWRITE_MAX = 32 * 1024 * 1024;
/** A page's own Content-Security-Policy, which would refuse the agent's script and socket. */
const CSP_META = /<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy["'\s>][^>]*>/gi;

/** The body as the app meant it, if it compressed it although teleport asked for none. */
function unpack(body: Buffer, encoding: string | undefined): Buffer | null {
  const e = (encoding ?? '').trim().toLowerCase();
  try {
    return e === 'gzip' || e === 'x-gzip' ? gunzipSync(body) : e === 'br' ? brotliDecompressSync(body) : e === 'deflate' ? inflateSync(body) : null;
  } catch {
    return null;
  }
}

/** Adds this machine's certificate store, where a company's root goes, to the roots every https
 *  request from this process trusts. A network that inspects TLS re-signs each site with that root,
 *  so without it Node refuses both the app and the DevTools frontend fetched from Google
 *  (SELF_SIGNED_CERT_IN_CHAIN). Needs Node 22.19 or 24.5; before them, NODE_EXTRA_CA_CERTS does it. */
export function trustSystemStore() {
  const t = tls as { getCACertificates?: (kind: string) => string[]; setDefaultCACertificates?: (certs: string[]) => void };
  if (!t.getCACertificates || !t.setDefaultCACertificates) return;
  try {
    t.setDefaultCACertificates([...new Set([...t.getCACertificates('default'), ...t.getCACertificates('system')])]);
  } catch {
    // A store Node can't read leaves its own roots in place.
  }
}

/**
 * `localhost` as both loopbacks, IPv4 first, tried in turn: a dev server may listen on only one (Vite
 * takes ::1 where localhost names it first, as on macOS), and a hosts file may name only one.
 */
const bothLoopbacks = ((host: string, opts: { all?: boolean } | number, cb: (...a: unknown[]) => void) => {
  if (host !== 'localhost' || typeof opts !== 'object') return dnsLookup(host, opts as never, cb as never);
  const all: LookupAddress[] = [
    { address: '127.0.0.1', family: 4 },
    { address: '::1', family: 6 },
  ];
  return opts.all ? cb(null, all) : cb(null, all[0]!.address, all[0]!.family);
}) as unknown as typeof dnsLookup;

/** How to reach the app: an app on localhost on whichever loopback it listens on. */
export const reach = (origin: URL) => (origin.hostname === 'localhost' ? { lookup: bothLoopbacks, autoSelectFamily: true } : {});

/** A tunnel's free plan may answer a browser with a warning page before the app, skipped by a header
 *  named for the tunnel: `<name>-skip-browser-warning`, the name read off its address
 *  (x.<name>-free.app or x.<name>.io gives <name>). A device's browser can't send it; teleport, asking
 *  the app for the device, can. A host that isn't such a tunnel ignores a header it doesn't know. */
export const skipWarning = (origin: URL): Record<string, string> => {
  const labels = origin.hostname.toLowerCase().split('.');
  if (LOOPBACK.test(origin.hostname) || /^[\d.]+$/.test(origin.hostname) || labels.length < 3) return {};
  const label = labels[labels.length - 2]!;
  // Only an address shaped like a tunnel's: a -free name, or a name under a tunnel TLD. app.example.com is neither.
  if (!/-free$/.test(label) && !/^(app|dev|io|pizza)$/.test(labels[labels.length - 1]!)) return {};
  const name = label.replace(/-free$/, '');
  return /^[a-z][a-z0-9-]*$/.test(name) ? { [`${name}-skip-browser-warning`]: '1' } : {};
};

/** Why a connection failed, in words: with both loopbacks tried, Node's error is an AggregateError
 *  with no message of its own; the IPv4 attempt, tried first, says it. */
export const why = (e: Error & { code?: string; errors?: Error[] }) => e.message || e.errors?.[0]?.message || e.code || 'no reason given';

/** Nothing listening on this machine yet: a dev server not started, or still starting. */
const NOT_LISTENING = /^(ECONNREFUSED|EADDRNOTAVAIL)$/;
const notListening = (e: Error & { code?: string; errors?: (Error & { code?: string })[] }) =>
  NOT_LISTENING.test(e.code ?? '') || (!!e.errors?.length && e.errors.every((x) => NOT_LISTENING.test(x.code ?? '') || x.code === 'EAFNOSUPPORT'));

/** Whether the app's address takes a connection: null when it does, else the error. Only the
 *  connection is asked for, not a page, so an app slow to render (a dev server compiling) counts as
 *  up, and asking costs it nothing. */
export function answers(origin: URL, ms = 3000): Promise<Error | null> {
  return new Promise((done) => {
    const port = Number(origin.port) || (origin.protocol === 'https:' ? 443 : 80);
    const s = netConnect({ host: origin.hostname, port, ...reach(origin) });
    const end = (e: Error | null) => {
      clearTimeout(timer);
      s.destroy();
      done(e);
    };
    const timer = setTimeout(() => end(new Error(`no connection in ${ms / 1000} s`)), ms);
    s.once('connect', () => end(null)).once('error', end);
  });
}

/** Whether an app that doesn't answer is one on this machine that isn't listening yet, which the
 *  Device can wait for, rather than a host that is wrong or down. */
export const waitable = (origin: URL, e: Error) => LOOPBACK.test(origin.hostname) && notListening(e);

/** How teleport checks an https app's certificate: against the roots above. An app on this machine
 *  usually has a certificate its dev server made itself, so it is trusted as it is; `insecure`
 *  (--insecure) trusts any app. */
export function upstreamTls(origin: URL, insecure: boolean): { rejectUnauthorized: boolean } {
  return { rejectUnauthorized: !insecure && !LOOPBACK.test(origin.hostname) };
}

export const CERT_ERROR = /CERT|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)|ALTNAME/;

/** Rewrites what would take the device off the proxy: redirects to the app's own address, cookies tied to
 *  its domain, and a script policy that would keep the agent out. */
function stayOnProxy(h: IncomingHttpHeaders, origin: URL, own: RegExp, dut: { proto: string; host: string }): IncomingHttpHeaders {
  const out = { ...h };
  const secure = dut.proto === 'https';
  delete out['content-security-policy'];
  // A redirect to the app's own address, in its own scheme only: one from http to https made relative
  // would ask for http again.
  if (out.location?.toLowerCase().startsWith(`${origin.protocol}//`)) {
    const local = toProxy(out.location, own, dut);
    const at = `${dut.proto}://${dut.host}`;
    if (local !== out.location && local.startsWith(at)) out.location = local.slice(at.length) || '/';
  }
  for (const name of ['link', 'refresh'] as const) {
    const v = out[name];
    if (typeof v === 'string') out[name] = toProxy(v, own, dut);
  }
  // Over plain http a browser drops Secure cookies, and SameSite=None needs Secure.
  out['set-cookie'] = out['set-cookie']?.map((c) => {
    const kept = c.replace(/;\s*Domain=[^;]*/i, '');
    return secure ? kept : kept.replace(/;\s*Secure(?=;|$)/i, '').replace(/;\s*SameSite=None(?=;|$)/i, '');
  });
  if (!out['set-cookie']) delete out['set-cookie'];
  return out;
}

/** Marks tlpt's own waiting page, so the console doesn't take it for the app loading without its agent. */
export const WAITING = 'x-teleport-waiting';
/** How often the page a device gets while the app is down asks again. */
const RETRY_S = 2;
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** What the device shows while there is no app to show: plain HTML that reloads itself, no script, and
 *  no agent, so the console doesn't count each try as a device. */
const page = (first: string, then: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="${RETRY_S}"><title>waiting for the app</title></head>` +
  `<body style="margin:0;padding:8vh 8vw;background:#111;color:#ccc;font:4vh/1.5 sans-serif"><p>${first}</p><p>${then}</p></body></html>`;
const waitingPage = (origin: URL) =>
  page(`teleport is waiting for your app at <b style="color:#fff">${escapeHtml(origin.host)}</b>.`, `Start it on the laptop; this page tries again every ${RETRY_S} s and opens it once it answers.`);
/** While tlpt serves no app yet: this page opens the app as soon as one is named in tlpt or found running. */
export const NO_APP_PAGE = page('teleport has no app yet.', `Type your app's port in tlpt on the laptop, or start your dev server; this page opens it within ${RETRY_S} s.`);

/** Marks what teleport's proxy sends the app. One that arrives back here came through a tunnel that
 *  forwards to this teleport, given to it as the app, and proxying it again would never end. */
const HOP = 'x-teleport-proxy';
const LOOP = (origin: URL) => `teleport: ${origin.origin} forwards to teleport itself. Name your app's own address instead, such as teleport localhost:<its port>.`;

/** Forwards to the app. HTML gets the agent tag, and pages, styles, scripts and JSON get teleport's
 *  address for the app's own; everything else streams through. The app sees requests as its own. */
export function proxyApp(origin: URL, req: IncomingMessage, res: ServerResponse, head = AGENT_TAG, trust = upstreamTls(origin, false), manifest = '', via: URL | null = null) {
  if (req.headers[HOP]) return void res.writeHead(508, { 'content-type': 'text/plain' }).end(LOOP(origin));
  const headers = { ...req.headers, host: origin.host, [HOP]: '1', ...skipWarning(origin) };
  delete headers['accept-encoding'];
  for (const name of ['origin', 'referer'] as const) {
    const v = headers[name];
    if (typeof v === 'string') headers[name] = v.replace(/^https?:\/\/[^/]+/, origin.origin);
  }
  // Behind a tunnel the device's side is https on the tunnel's name, whatever this hop says.
  const dut = seenAs(req, via);
  const own = ownAddress(origin);
  const tlsOptions = origin.protocol === 'https:' ? trust : {};
  const send = origin.protocol === 'https:' ? httpsRequest : httpRequest;
  const upstream = send(new URL(req.url ?? '/', origin), { method: req.method, headers, ...tlsOptions, ...reach(origin) }, (up) => {
    const status = up.statusCode ?? 502;
    const out = stayOnProxy(up.headers, origin, own, dut);
    const type = up.headers['content-type'] ?? '';
    const html = type.includes('text/html');
    // An answer the app dropped midway (a dev server restarting) fails for the device there too, as it
    // would without teleport. Left alone, the device's request waited on an answer that never ended,
    // and a few of those hold every connection a device's browser opens to one host.
    up.on('close', () => void (up.complete || res.destroy()));
    if (req.method === 'HEAD' || status === 204 || status === 304 || !(html || REWRITTEN.test(type))) {
      res.writeHead(status, out);
      up.pipe(res);
      return;
    }
    let chunks: Buffer[] = [];
    let held = 0;
    up.on('data', (c: Buffer) => {
      if (held > REWRITE_MAX) return;
      chunks.push(c);
      held += c.length;
      if (held <= REWRITE_MAX) return;
      // Too long to hold: what is here goes as the app sent it, and the rest streams after it.
      res.writeHead(status, out);
      for (const k of chunks) res.write(k);
      chunks = [];
      up.pipe(res);
    });
    up.on('end', () => {
      if (held > REWRITE_MAX) return;
      let body: Buffer = Buffer.concat(chunks);
      if (out['content-encoding']) {
        const plain = unpack(body, out['content-encoding']);
        // An encoding teleport can't read: the body goes as the app sent it.
        if (!plain) return void res.writeHead(status, out).end(body);
        body = plain;
        delete out['content-encoding'];
      }
      // latin1 maps each byte to one character and back, so a page in any charset keeps every byte.
      const was = body.toString('latin1');
      let text = toProxy(was, own, dut);
      if (html) text = injectAgent(text.replace(CSP_META, ''), head);
      else if (manifest && (req.url ?? '').split('?')[0] === manifest) text = addAgentToManifest(text, dut);
      if (text !== was) delete out['etag'];
      const sent = Buffer.from(text, 'latin1');
      delete out['transfer-encoding'];
      out['content-length'] = String(sent.length);
      res.writeHead(status, out).end(sent);
    });
  });
  upstream.on('error', (e: NodeJS.ErrnoException) => {
    const cert = CERT_ERROR.test(e.code ?? '');
    // The device opened the page before the app on this machine was up: a page that tries again, so
    // nobody has to reload it with a remote once the dev server starts. Anything else says why.
    if (!res.headersSent && req.method === 'GET' && (req.headers.accept ?? '').includes('text/html') && waitable(origin, e))
      return void res.writeHead(502, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', [WAITING]: '1' }).end(waitingPage(origin));
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(
      cert
        ? `teleport: ${origin.origin} has a certificate Node doesn't trust (${e.code}). Run teleport with --insecure to trust it anyway, or set NODE_EXTRA_CA_CERTS to its CA's .pem file.`
        : `teleport: no answer from ${origin.origin} (${why(e)}). Is the app up?`,
    );
  });
  // A device that stopped waiting stops the app's work on its answer.
  res.on('close', () => void (res.writableFinished || upstream.destroy()));
  req.pipe(upstream);
}

/** Passes a WebSocket the app opens, such as a dev server's hot reload, through to the app. */
export function proxyUpgrade(origin: URL, req: IncomingMessage, socket: Duplex, head: Buffer, trust = upstreamTls(origin, false)) {
  if (req.headers[HOP]) return void socket.end(`HTTP/1.1 508 Loop Detected\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\n${LOOP(origin)}`);
  const secure = origin.protocol === 'https:';
  const port = Number(origin.port) || (secure ? 443 : 80);
  const up = secure ? tlsConnect({ host: origin.hostname, port, servername: origin.hostname, ...trust, ...reach(origin) }) : netConnect({ port, host: origin.hostname, ...reach(origin) });
  up.once(secure ? 'secureConnect' : 'connect', () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i]!;
      lines.push(`${name}: ${/^host$/i.test(name) ? origin.host : /^origin$/i.test(name) ? origin.origin : req.rawHeaders[i + 1]}`);
    }
    for (const [k, v] of Object.entries(skipWarning(origin))) lines.push(`${k}: ${v}`);
    up.write(lines.join('\r\n') + `\r\n${HOP}: 1\r\n\r\n`);
    if (head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  // Either side ending ends the other: a socket left half open holds tlpt's exit.
  const end = () => (up.destroy(), socket.destroy());
  for (const s of [up, socket]) s.on('error', end).on('close', end);
}
