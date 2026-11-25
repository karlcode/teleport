// What `tlpt` prints: the mark and its links, pinned at the top; and the help screens. Phosphor ink
// (a pale sage) on the terminal's own background, labels faint and values in ink, with two accents:
// teal for the name, addresses and keys that do something on the device, blue for keys that only read. Links are printed whole, so any
// terminal opens them on a click, and carry an OSC 8 hyperlink to the same URL. Pure, so it is tested
// without a terminal.

import { initLine } from './live.js';
import { pad, truncate, width, wrap } from './text.js';

export type Color = 'none' | '256' | 'truecolor';

export interface Header {
  /** What teleport serves to the device: a dev server's host, a deployed host or a folder. */
  app: string | null;
  /** The app through teleport, when it serves one; with no app, the page that waits for one. */
  dut: string | null;
  /** What the first line says while there is no app; 'no app yet' unless given. */
  empty?: string;
  /** The line that adds teleport to an app's own bundle; shown when teleport isn't serving the app. */
  snippet: string;
  /** This laptop's address and port, which the app's `teleport.init` is given. */
  lan: string;
  color: Color;
  /** A light terminal background (lightBackground): plainer tones. */
  light?: boolean;
}

// The phosphor palette's ink, muted and faint, and its line; 256-colour stand-ins for terminals
// without true colour.
const TONES = {
  ink: [[214, 222, 178], 187],
  muted: [[184, 191, 151], 144],
  faint: [[149, 155, 121], 101],
  rule: [[107, 111, 89], 59],
} as const;
type Tone = keyof typeof TONES;

export type Paint = ReturnType<typeof paint>;

/**
 * The palette for a colour depth. On a light background (`light`, from COLORFGBG) phosphor sage is
 * unreadable, so ink and muted become the terminal's own foreground and faint and rule are dimmed.
 */
export function paint(mode: Color, light = false) {
  const tone = (t: Tone) => (s: string) => {
    if (mode === 'none') return s;
    if (light) return t === 'ink' || t === 'muted' ? s : `\x1b[2m${s}\x1b[22m`;
    const [rgb, n] = TONES[t];
    return `\x1b[${mode === 'truecolor' ? `38;2;${rgb.join(';')}` : `38;5;${n}`}m${s}\x1b[39m`;
  };
  return {
    ink: tone('ink'),
    muted: tone('muted'),
    faint: tone('faint'),
    rule: tone('rule'),
    bold: (s: string) => (mode === 'none' ? s : `\x1b[1m${s}\x1b[22m`),
    dim: (s: string) => (mode === 'none' ? s : `\x1b[2m${s}\x1b[22m`),
    inverse: (s: string) => (mode === 'none' ? s : `\x1b[7m${s}\x1b[27m`),
    /** The name, an address to open, and keys that act on the device. */
    accent: (s: string) => (mode === 'none' ? s : light ? `\x1b[1m${s}\x1b[22m` : `\x1b[${mode === 'truecolor' ? '38;2;63;212;192' : '38;5;79'}m${s}\x1b[39m`),
    /** Keys that only read what this laptop already has. */
    info: (s: string) => (mode === 'none' || light ? s : `\x1b[${mode === 'truecolor' ? '38;2;122;170;247' : '38;5;111'}m${s}\x1b[39m`),
    /** Status colours, kept to the few places that need a glance: good, warn, bad. */
    good: (s: string) => (mode === 'none' ? s : `\x1b[${mode === 'truecolor' ? '38;2;120;200;140' : '38;5;114'}m${s}\x1b[39m`),
    warn: (s: string) => (mode === 'none' ? s : `\x1b[${mode === 'truecolor' ? '38;2;242;173;72' : '38;5;215'}m${s}\x1b[39m`),
    bad: (s: string) => (mode === 'none' ? s : `\x1b[${mode === 'truecolor' ? '38;2;240;110;90' : '38;5;203'}m${s}\x1b[39m`),
    link: (url: string, text = url) => (mode === 'none' ? text : `\x1b]8;;${url}\x1b\\\x1b[4m${text}\x1b[24m\x1b]8;;\x1b\\`),
  };
}

/** TLPT_THEME=light or dark: the person says which, and nothing is asked or guessed. */
export const themeSaid = (env: NodeJS.ProcessEnv = process.env): boolean | null => (/^light$/i.test(env.TLPT_THEME ?? '') ? true : /^dark$/i.test(env.TLPT_THEME ?? '') ? false : null);

/**
 * A light terminal background, known without asking the terminal: what TLPT_THEME says, else what
 * rxvt, Konsole and some iTerm2 profiles say in COLORFGBG ("fg;bg"). Most terminals set neither, so
 * the console asks the terminal itself as it starts (term.askBackground, read by lightReply).
 */
export const lightBackground = (env: NodeJS.ProcessEnv = process.env) => themeSaid(env) ?? /(^|;)(7|15)$/.test(env.COLORFGBG ?? '');

/**
 * What a terminal answered when asked its background colour (OSC 11), as light or not; null when
 * there is no answer in `reply`. Light is where black text has more contrast on it than white text
 * would: a relative luminance above 0.18. Phosphor sage on a white background is 1.4:1.
 */
export function lightReply(reply: string): boolean | null {
  const m = /\x1b\]11;rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})/i.exec(reply);
  if (!m) return null;
  const lin = (h: string) => {
    const c = parseInt(h, 16) / (16 ** h.length - 1);
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(m[1]!) + 0.7152 * lin(m[2]!) + 0.0722 * lin(m[3]!) > 0.18;
}

// The glyph set lives in glyphs.ts, which text.ts reads too; re-exported here, where it is drawn.
import { G } from './glyphs.js';
export { ASCII, G, inGlyphs, setGlyphs, UNICODE, wantsAscii, type Glyphs } from './glyphs.js';

/** The text of a printed line, without escape sequences. */
export const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, '');

const PAD = '  ';
const LABEL_W = 16;
const NAME = 'teleport';
/** The mark: a portal and the name, the same wherever it is drawn. */
const mark = (p: Paint) => PAD + p.accent(G.mark) + ' ' + p.bold(p.ink(NAME));

/** The header, kept at the top of the console: the mark with the app it serves, then the one address to open on the device. */
export function header(h: Header): string[] {
  const p = paint(h.color, h.light);
  const pair = (label: string, value: string) => PAD + p.faint(label.padEnd(LABEL_W + 4)) + value;
  // A folder shows as its last two names: the whole path says nothing more and pushes the rest off the line.
  const app = h.app && /^(\/|[A-Za-z]:\\)/.test(h.app) ? G.ellipsis + '/' + h.app.split(/[\\/]/).filter(Boolean).slice(-2).join('/') : h.app;
  const lines = [mark(p) + '  ' + (app ? p.faint(G.right + ' ') + p.muted(app) : p.faint(h.empty ?? 'no app yet'))];
  // The one thing to do: open this address on the device, by hand or as the app's URL in its manifest.
  // DevTools opens by itself when a device connects, and says where it is then.
  if (h.dut) lines.push(pair('open on the device', p.accent(p.link(h.dut))));
  else lines.push(pair('add to the app', p.ink(h.snippet)), pair('and start it', p.ink(initLine(h.lan))));
  return lines;
}

// ---- Help ----------------------------------------------------------------------------------------

/** A help screen as data: a title, an intro, and sections of rows, grids, paragraphs or code. */
export interface HelpSection {
  heading: string;
  /** A few faint words on the heading's line. */
  note?: string;
  /** A paragraph, wrapped. */
  text?: string;
  /** Terms in ink with their descriptions wrapped beside them, in the column the whole page shares. */
  rows?: [string, string][];
  /** Short pairs laid out column-major, in as many columns as fit (at most 3): keys, commands. */
  grid?: [string, string][];
  /** Lines printed as they are (usage, examples), in ink, each with an optional faint note. */
  code?: [string, string?][];
}

export interface HelpDoc {
  /** Beside the mark, or under it on a narrow terminal: what this page is about. */
  title: string;
  /** A muted paragraph under the title. */
  intro?: string;
  sections: HelpSection[];
  /** A last faint paragraph. */
  footer?: string;
}

/** Help is no wider than this on a wide terminal, so a line stays easy to read. */
const HELP_W = 100;
/** Below this width the title goes under the mark. */
const TITLE_BESIDE = 72;
/** Below this width descriptions go under their terms. */
const STACK_BELOW = 60;
/** More grid columns than this make the eye travel too far from one key to the next. */
const GRID_MAX = 3;
const GAP = 3;

/**
 * A help screen laid out for the terminal's width: at most 100 columns, and every line at least one
 * short of the width, so none wraps. Row descriptions share one column across the page, so every
 * section lines up: two past the widest term that takes at most 40% of the width. A longer term
 * gets a line of its own, with its description under the column.
 */
export function helpView(doc: HelpDoc, cols: number, color: Color, light = false): string[] {
  const p = paint(color, light);
  const w = Math.min(HELP_W, Math.max(40, cols));
  const max = w - 1;
  const links = (s: string) => s.replace(/https?:\/\/[^\s)]+/g, (u) => p.link(u));
  // Paragraphs wrap to one measure, whether they sit at the margin or under a heading.
  const para = (s: string, indent: string, tone: (s: string) => string) => wrap(s, w - 5).map((l) => indent + tone(links(l)));

  const name = mark(p);
  const beside = w >= TITLE_BESIDE && width(name) + 2 + width(doc.title) <= max;
  const out = ['', ...(beside ? [name + '  ' + p.muted(doc.title)] : [name, ...para(doc.title, PAD, p.muted)]), ''];
  if (doc.intro) out.push(...para(doc.intro, PAD, p.muted), '');

  const at = PAD + PAD;
  const terms = doc.sections.flatMap((s) => s.rows ?? []).map(([t]) => width(t));
  const column = ' '.repeat(at.length + 2 + Math.max(0, ...terms.filter((t) => t <= w * 0.4)));
  const stacked = w < STACK_BELOW;

  // A code line that doesn't fit breaks at spaces, its continuation indented like a synopsis in a man page.
  const codeLines = (c: string) => (at.length + width(c) <= max ? [at + p.ink(c)] : wrap(c, max - at.length - PAD.length).map((l, i) => (i ? at + PAD : at) + p.ink(l)));

  for (const sec of doc.sections) {
    const heading = PAD + p.bold(sec.heading);
    if (!sec.note) out.push(heading);
    else if (width(heading) + 2 + width(sec.note) <= max) out.push(heading + '  ' + p.faint(links(sec.note)));
    else out.push(heading, ...wrap(sec.note, max - at.length).map((l) => at + p.faint(links(l))));
    if (sec.text) out.push(...para(sec.text, at, p.muted));
    for (const [term, desc] of sec.rows ?? []) {
      // A term on a line of its own breaks like code, so a long synopsis keeps its last flags.
      if (stacked) {
        out.push(...codeLines(term), ...wrap(desc, max - 2 * at.length).map((l) => at + at + p.muted(l)));
        continue;
      }
      const fits = at.length + width(term) + 2 <= column.length;
      if (!fits) out.push(...codeLines(term));
      wrap(desc, max - column.length).forEach((l, i) => out.push((i === 0 && fits ? pad(at + p.ink(term), column.length) : column) + p.muted(l)));
    }
    if (sec.grid?.length) out.push(...grid(sec.grid, max - at.length, p).map((l) => at + l));
    if (sec.code?.length) {
      const codeW = Math.max(...sec.code.map(([c]) => width(c)));
      // Notes sit beside their code when every one fits, else each goes under its own: one way per section.
      const inline = sec.code.every(([, note]) => !note || at.length + codeW + GAP + width(note) <= max);
      for (const [c, note] of sec.code) {
        if (note && inline) out.push(pad(at + p.ink(c), at.length + codeW + GAP) + p.faint(note));
        else out.push(...codeLines(c), ...(note ? wrap(note, max - at.length - PAD.length).map((l) => at + PAD + p.faint(l)) : []));
      }
    }
    out.push('');
  }
  if (doc.footer) out.push(...para(doc.footer, PAD, p.faint), '');
  return out.map((l) => truncate(l, max));
}

/** Pairs in columns, filled top to bottom and then left to right, every cell as wide as the widest pair. */
function grid(pairs: [string, string][], room: number, p: Paint): string[] {
  const termW = 2 + Math.max(...pairs.map(([t]) => width(t)));
  const cell = termW + Math.max(...pairs.map(([, d]) => width(d))) + GAP;
  // The last column needs no gap after it.
  const n = Math.max(1, Math.min(GRID_MAX, Math.floor((room + GAP) / cell)));
  const rows = Math.ceil(pairs.length / n);
  return Array.from({ length: rows }, (_, r) => {
    const cells = Array.from({ length: n }, (_, j) => pairs[j * rows + r]).filter((x) => x !== undefined);
    return cells.map(([t, d], j) => pad(p.ink(t), termW) + (j < cells.length - 1 ? pad(p.muted(d), cell - termW) : p.muted(d))).join('');
  });
}

// ---- The beam -------------------------------------------------------------------------------------

/** How often a beam's motes, head and far portal move on, ms. */
export const BEAM_MS = 120;

/**
 * A teleport beam `n` cells wide between two portals, for something under way: the near portal open,
 * what has arrived as a solid line with a sparkling head, the track still to go with motes drifting
 * along it to the far portal, which opens and closes. With no fraction (work of unknown length) a
 * short pulse crosses from one portal to the other, over and over.
 */
export function beam(p: Paint, frac: number | null, n: number, now: number): string {
  const [fill, track, mote, h1, h2] = [...G.beam] as [string, string, string, string, string];
  const inner = Math.max(1, n - 2);
  const tick = Math.floor(now / BEAM_MS);
  const head = p.ink(tick % 2 ? h1 : h2);
  const rest = (i: number) => ((((i - tick) % 4) + 4) % 4 === 0 ? p.faint(mote) : p.rule(track));
  let cells = '';
  if (frac !== null) {
    const got = Math.round(Math.min(1, Math.max(0, frac)) * inner);
    for (let i = 0; i < inner; i++) cells += got === inner || i < got - 1 ? p.accent(fill) : i === got - 1 ? head : rest(i);
  } else {
    const len = 3;
    const at = (tick % (inner + len)) - len;
    for (let i = 0; i < inner; i++) cells += i >= at && i < at + len ? (i === at + len - 1 ? head : p.accent(fill)) : rest(i);
  }
  return p.accent(G.portal[2]!) + cells + p.info(G.portal[tick % G.portal.length]!);
}
