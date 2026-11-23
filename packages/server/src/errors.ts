// What a device's page threw, as its agent reported it (packages/agent/src/errors.js): uncaught errors,
// rejections nothing handled, and scripts or stylesheets that did not load, from the page's first
// line. The agent holds the first 8 and the last 8 and counts the rest, so a page that throws while
// it starts is heard even though DevTools, and the inspector that feeds it, came later or never.
// Here each is taken once, and said in words: what it most likely means on an old engine.

export type PageErrorKind = 'error' | 'rejection' | 'resource';

export interface PageError {
  /** Which error of this page load it was, from 0. */
  n: number;
  /** Agent clock, ms: how far into the page it happened. */
  atMs: number;
  kind: PageErrorKind;
  /** The message; for a resource, `script` or `link`. */
  text: string;
  /** The file it was thrown in, or the resource that did not load. '' when the engine did not say. */
  src: string;
  line: number;
  col: number;
  stack: string;
  /** What it most likely means, in a sentence; null when the message says it all. */
  hint: string | null;
  /** The source around where it was thrown, when the file came through teleport. `caret` is where in `text`. */
  near: { text: string; caret: number } | null;
  /** Where that is in the code a person wrote, when the file came through teleport with a source map
   *  (sourcemap.ts). `src`, `line` and `col` stay as the engine said them: a place in the built file. */
  from: { src: string; line: number; col: number } | null;
}

const KINDS: Record<string, PageErrorKind> = { e: 'error', p: 'rejection', r: 'resource' };
/** A file the engine could not parse: nothing in it ran. */
const PARSE = /SyntaxError|Unexpected (token|identifier|reserved word|strict mode reserved word|string|number|end of input)|Invalid or unexpected token|missing \) after argument list/i;
/** What code says when something an earlier script should have defined is not there. */
const MISSING = /is not defined|is not a function|is not a constructor|undefined is not|Cannot read propert(y|ies) .* of undefined|of undefined \(reading/i;
/** All an engine says of an error in a script from another origin loaded without CORS. */
const OPAQUE = /^Script error\.?$/i;
/** What an engine keeps from a page that is not a secure context: DRM (since Chromium 58), service
 *  workers and the Cache API, crypto.subtle (since 60), the camera and microphone. */
const SECURE_ONLY = /requestMediaKeySystemAccess|serviceWorker|\bcaches\b|\bsubtle\b|mediaDevices|['"](register|importKey|digest|generateKey|getUserMedia)['"]/;

/** A page at this address is not a secure context: plain http, from another machine than the one that
 *  serves it. https is one, and so is this machine by a loopback name. An address that can't be read
 *  is taken for one, so nothing is said that might not be so. */
export function insecureContext(href: string): boolean {
  try {
    const u = new URL(href);
    return u.protocol === 'http:' && !/^(localhost|127(\.\d+){3}|\[::1\]|.+\.localhost)$/.test(u.hostname);
  } catch {
    return false;
  }
}

/** What to do about a page that isn't a secure context, for an error or a probe that ran into it. */
export const OPEN_SECURELY = 'Open the app over https to get them: through a tunnel, or your own https proxy in front of tlpt, named with --via.';

function parseLine(json: string): PageError | null {
  let a: unknown;
  try {
    a = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(a) || typeof a[0] !== 'number' || !KINDS[String(a[2])]) return null;
  const s = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return { n: a[0], atMs: n(a[1]), kind: KINDS[String(a[2])]!, text: s(a[3], 300), src: s(a[4], 300), line: n(a[5]), col: n(a[6]), stack: s(a[7], 600), hint: null, near: null, from: null };
}

/** The last part of a URL's path, which is what a person recognises. An inline script's file is the page itself. */
export function fileOf(src: string): string {
  const path = src.replace(/[?#].*$/, '');
  return path.slice(path.lastIndexOf('/') + 1) || 'the page';
}

/** `app.js:3:9`, or '' when the engine gave no place. */
export function placeOf(e: Pick<PageError, 'src' | 'line' | 'col'>): string {
  if (!e.src) return '';
  return fileOf(e.src) + (e.line ? `:${e.line}${e.col ? `:${e.col}` : ''}` : '');
}

/**
 * teleport's own files as an error names them: the tag teleport serves (`/teleport.js`), anything else
 * under `/__teleport/` but a trial's frame (which runs the trial's code), and `@tlpt/agent` where a
 * build's source map names the bundled agent.
 */
const OWN = /\/teleport(?:\.min|\.debug)?\.js(?:[?#:]|$)|\/__teleport\/(?!trial\/)|@tlpt\/agent|node_modules\/tlpt\//m;

/** The error is in teleport's own code, not the app's: its file, its stack, or where a source map put it. */
export const ownCode = (e: Pick<PageError, 'src' | 'stack' | 'from'>) => OWN.test([e.src, e.stack, e.from?.src ?? ''].join('\n'));

/** One line for an error: what was thrown and where, and that it was teleport's code when it was. */
export function errorLine(e: PageError): string {
  if (e.kind === 'resource') return `${e.text === 'link' ? 'stylesheet' : 'script'} did not load: ${e.src || 'unknown address'}`;
  const text = e.text.replace(/^Uncaught\s+/, '') || 'an error with no message';
  // The place in the code a person wrote, where the build's source map gave one.
  const place = placeOf(e.from ?? e);
  return (e.kind === 'rejection' ? 'unhandled rejection: ' : '') + text + (place ? ` · ${place}` : '') + (ownCode(e) ? " · in teleport's own code" : '');
}

/** What an error most likely means, given the ones before it in the same page and the engine. */
export function hintFor(e: PageError, earlier: PageError[], engine = '', insecure = false): string | null {
  const on = engine ? ` (${engine})` : '';
  if (ownCode(e) && e.kind !== 'resource')
    return `This is teleport's code, not your app's: it must never throw into a page${on}. Please report it with this line; your app's own code ran as it would without teleport.`;
  if (insecure && e.kind !== 'resource' && MISSING.test(e.text) && SECURE_ONLY.test(e.text))
    return `Probably because this page is not a secure context (plain http from another machine): an engine keeps DRM, service workers and crypto.subtle from one. ${OPEN_SECURELY}`;
  if (e.kind === 'resource') return e.text === 'script' ? 'Nothing this script defines exists, so code that uses it will throw next. Check that the device can reach that address.' : null;
  if (OPAQUE.test(e.text) && !e.src)
    return 'A script from another origin threw, and the engine hides what and where. Load it through tlpt, or add crossorigin to its tag and CORS headers to its response.';
  if (PARSE.test(e.text)) return `The engine${on} could not parse this file, so none of it ran and nothing it defines exists. Most often syntax newer than the engine: tlpt probe features says what it has.`;
  if (MISSING.test(e.text)) {
    const causes = earlier.filter((x) => (x.kind === 'resource' ? x.text === 'script' : PARSE.test(x.text))).slice(0, 3);
    if (causes.length === 1) return `Probably because of error ${causes[0]!.n + 1}: ${errorLine(causes[0]!)}. That script never ran, so what it defines is missing.`;
    if (causes.length) return `Probably because an earlier script never ran, so what it defines is missing: ${causes.map((c) => `error ${c.n + 1} (${errorLine(c)})`).join(', ')}.`;
  }
  return null;
}

/** The errors of one page load. */
export class PageErrors {
  private readonly held = new Map<number, PageError>();
  /** How many the page threw in all; the agent holds only the first and last few. */
  total = 0;

  /** `engine` names the page's engine; `insecure` says whether the page is outside a secure context. */
  constructor(
    private readonly engine: () => string = () => '',
    private readonly insecure: () => boolean = () => false,
  ) {}

  /** Takes the argument of an agent's `err` line. The error, or null when it was held already or isn't one. */
  take(arg: string): PageError | null {
    const e = parseLine(arg);
    if (!e || this.held.has(e.n)) return null;
    e.hint = hintFor(e, this.list().filter((x) => x.n < e.n), this.engine(), this.insecure());
    this.held.set(e.n, e);
    if (this.held.size > 64) this.held.delete(this.held.keys().next().value!);
    if (e.n + 1 > this.total) this.total = e.n + 1;
    return e;
  }

  /** Takes the argument of an agent's `errs` line: its count. True when it grew. */
  count(arg: string): boolean {
    const n = Number(arg);
    if (!Number.isFinite(n) || n <= this.total) return false;
    this.total = n;
    return true;
  }

  list(): PageError[] {
    return [...this.held.values()].sort((a, b) => a.n - b.n);
  }

  /** A new page load starts with none. */
  clear() {
    this.held.clear();
    this.total = 0;
  }
}

/** `column` is 1-based. The source around it on that line, at most `width` characters, with where the column fell. */
export function excerpt(source: string, line: number, column: number, width = 80): { text: string; caret: number } | null {
  if (line < 1) return null;
  let start = 0;
  for (let i = 1; i < line; i++) {
    start = source.indexOf('\n', start) + 1;
    if (start === 0) return null;
  }
  const nl = source.indexOf('\n', start);
  const text = source.slice(start, nl < 0 ? undefined : nl).replace(/\r$/, '');
  const col = Math.min(Math.max(column - 1, 0), text.length);
  const from = Math.max(0, Math.min(col - Math.floor(width / 2), text.length - width));
  const cut = text.slice(from, from + width).replace(/\t/g, ' ');
  return cut.trim() ? { text: cut, caret: col - from } : null;
}
