// Chrome's own DevTools frontend, served from this server so DevTools opens from a plain http link.
// A `devtools://` link can't be clicked: pages can't link to it and Chrome ignores it on its command
// line. Google hosts the same frontend per Chromium revision, but Chrome's local-network checks block
// that https origin from reaching the relay on loopback. Served from localhost, it connects.
// Files are fetched once and cached on disk, so DevTools opens offline after the first time.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CERT_ERROR } from './app.js';

/** Chromium revision of Chrome 156.0.8078.48. Any recent frontend works: the backend is ours. */
export const FRONTEND_REVISION = 'd0c02bfad08ec92a6ffcf989e53cd995e6381a4c';
const UPSTREAM = `https://chrome-devtools-frontend.appspot.com/serve_rev/@${FRONTEND_REVISION}/`;
const SAFE_PATH = /^[\w.-]+(?:\/[\w.-]+)*$/;

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  avif: 'image/avif',
  wasm: 'application/wasm',
};

function cacheRoot() {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(base, 'teleport', 'devtools-frontend', FRONTEND_REVISION);
}

/** The page DevTools starts from, which teleport gives its own script ahead of DevTools'. */
export const FRONTEND_PAGE = 'devtools_app.html';

/** Puts `tag` ahead of DevTools' own module script, so it runs before DevTools opens its socket. */
export function injectFrontend(html: string, tag: string): string {
  const at = html.indexOf('<script type="module"');
  return at < 0 ? html : html.slice(0, at) + tag + '\n' + html.slice(at);
}

/** Serves `path` (relative to the frontend root), fetching and caching it on first use. The start
 *  page gets `tag` ahead of DevTools' script and is never cached, so a new teleport's script loads. */
export async function serveFrontend(res: ServerResponse, path: string, root = cacheRoot(), tag = '') {
  if (!SAFE_PATH.test(path) || path.split('/').some((p) => p.startsWith('.'))) {
    return void res.writeHead(400, { 'content-type': 'text/plain' }).end('bad path');
  }
  const file = join(root, path);
  const type = TYPES[path.slice(path.lastIndexOf('.') + 1)] ?? 'application/octet-stream';
  const page = path === FRONTEND_PAGE && tag !== '';
  const send = (body: Buffer, cache: boolean) =>
    page
      ? void res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }).end(injectFrontend(body.toString('utf8'), tag))
      : void res.writeHead(200, cache ? { 'content-type': type, 'cache-control': 'max-age=31536000, immutable' } : { 'content-type': type }).end(body);
  if (existsSync(file)) return send(readFileSync(file), true);
  let up: Response;
  try {
    up = await fetch(UPSTREAM + path);
  } catch (e) {
    const cause = (e as Error & { cause?: NodeJS.ErrnoException }).cause;
    const why = cause?.code ?? cause?.message ?? (e as Error).message;
    const certs = CERT_ERROR.test(why)
      ? `\nSomething on your network re-signs https with a root Node doesn't trust. Start teleport with NODE_EXTRA_CA_CERTS set to that root's .pem file.`
      : '';
    return void res
      .writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      .end(`teleport fetches Chrome's DevTools frontend once and caches it, and the fetch failed (${why}).${certs}`);
  }
  if (!up.ok) return void res.writeHead(up.status, { 'content-type': 'text/plain' }).end(`upstream ${up.status}`);
  const body = Buffer.from(await up.arrayBuffer());
  mkdirSync(dirname(file), { recursive: true });
  // Write then rename, so two requests for one file never leave a half-written copy.
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, body);
  renameSync(tmp, file);
  send(body, false);
}
