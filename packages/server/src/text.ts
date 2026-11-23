// Text measured as a terminal draws it: escape sequences take no columns, wide characters (CJK,
// most emoji) take two, combining marks none. Everything the console prints is fitted with these, so
// a line never wraps by surprise and breaks the redraw.
import { G } from './glyphs.js';

const ESC = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/y;

/**
 * `v` with nothing in its strings a terminal acts on: no escape, no control character but tab and
 * newline. Everything a device says (what its page threw, its addresses, what an eval answered) goes
 * through here before it is styled and printed, so a page can't retitle the window, clear the
 * screen or write the clipboard of whoever is watching it. Only teleport's own styling reaches the
 * terminal as escapes.
 */
export function printable<T>(v: T): T {
  if (typeof v === 'string') return v.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '') as T;
  if (Array.isArray(v)) return v.map(printable) as T;
  if (v === null || typeof v !== 'object') return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[printable(k)] = printable(x);
  return out as T;
}

/** The text without escape sequences. */
export const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');

// Emoji drawn two wide (East Asian Width W) outside the wide blocks below: symbols, dingbats and
// transport. The rest of those blocks stays one wide, as tlpt's own ✓ ✗ → ● are.
const WIDE = new Set(
  '231a-231b 2329-232a 23e9-23ec 23f0 23f3 25fd-25fe 2614-2615 2648-2653 267f 2693 26a1 26aa-26ab 26bd-26be 26c4-26c5 26ce 26d4 26ea 26f2-26f3 26f5 26fa 26fd 2705 270a-270b 2728 274c 274e 2753-2755 2757 2795-2797 27b0 27bf 2b1b-2b1c 2b50 2b55 1f004 1f0cf 1f18e 1f191-1f19a 1f200-1f265'
    .split(' ')
    .flatMap((r) => {
      const [a, b = a] = r.split('-').map((h) => parseInt(h, 16)) as [number, number?];
      return Array.from({ length: b - a + 1 }, (_, i) => a + i);
    }),
);

/** Columns one code point takes. */
export function charWidth(cp: number): number {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  // Combining marks, zero-width joiners and variation selectors.
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0x20e3) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1f7e0 && cp <= 0x1f7eb) ||
    (cp >= 0x1f900 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd) ||
    WIDE.has(cp)
  )
    return 2;
  return 1;
}

/** Columns the text takes. */
export function width(s: string): number {
  let w = 0;
  for (const ch of strip(s)) w += charWidth(ch.codePointAt(0)!);
  return w;
}

/**
 * The text cut to `max` columns, with the glyph set's ellipsis (`…`, or `...` in ASCII) where it was cut. Escape sequences are kept whole, and an
 * open colour or hyperlink is closed after the cut, so nothing bleeds into the next line.
 */
export function truncate(s: string, max: number): string {
  if (max <= 0) return '';
  if (width(s) <= max) return s;
  const mark = width(G.ellipsis) <= max ? G.ellipsis : '';
  let out = '';
  let w = 0;
  let i = 0;
  let styled = false;
  let linked = false;
  while (i < s.length) {
    ESC.lastIndex = i;
    const m = ESC.exec(s);
    if (m) {
      out += m[0];
      if (m[0].startsWith('\x1b]8;;')) linked = m[0].length > 6 && !/^\x1b\]8;;(?:\x07|\x1b\\)$/.test(m[0]);
      else styled = !/^\x1b\[0?m$/.test(m[0]) || styled;
      i += m[0].length;
      continue;
    }
    const cp = s.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const cw = charWidth(cp);
    if (w + cw > max - width(mark)) break;
    out += ch;
    w += cw;
    i += ch.length;
  }
  return out + mark + (linked ? '\x1b]8;;\x1b\\' : '') + (styled ? '\x1b[0m' : '');
}

/** The text padded with spaces to `n` columns (never cut). */
export const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - width(s)));

/**
 * Plain text wrapped at word boundaries to lines of at most `max` columns. A word longer than a line
 * is broken. Existing newlines are kept.
 */
export function wrap(text: string, max: number): string[] {
  // A narrow console can ask for 0 columns or less, or for fewer than a wide character takes: every
  // line still takes at least one character, so the loop below always ends.
  max = Math.max(1, max);
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/ +/)) {
      if (!word) continue;
      let w = word;
      while (width(w) > max) {
        if (line) {
          out.push(line);
          line = '';
        }
        let cut = '';
        for (const ch of w) {
          if (cut && width(cut + ch) > max) break;
          cut += ch;
        }
        // A character wider than the line is a line of its own.
        if (cut === w) break;
        out.push(cut);
        w = w.slice(cut.length);
      }
      if (!line) line = w;
      else if (width(line) + 1 + width(w) <= max) line += ' ' + w;
      else {
        out.push(line);
        line = w;
      }
    }
    out.push(line);
  }
  return out;
}
