// Every non-ASCII character tlpt draws, in one place, so a terminal whose font lacks them gets ASCII
// in their place. Leaf module: text.ts reads the ellipsis from here, and tui.ts re-exports it all.

/** Every non-ASCII character teleport draws, so a terminal without them gets ASCII in their place. */
export interface Glyphs {
  /** The mark beside the name. */
  mark: string;
  /** An event's bullet, and a live device's state dot. */
  dot: string;
  /** A device that went away, or none yet. */
  ring: string;
  /** The selected row. */
  sel: string;
  /** Under an event's head, before its first detail line. */
  nest: string;
  /** Between parts of a line. */
  sep: string;
  /** Eight bar heights, low to high. */
  bars: string;
  /** Spinner frames, each one cell. */
  spin: string;
  right: string;
  left: string;
  up: string;
  down: string;
  back: string;
  yes: string;
  no: string;
  /** An event that wants a look: with yes and no, an event's tone without its colour. */
  alert: string;
  /** Unknown: the engine can't say. */
  none: string;
  /** Rounded box corners and edges: top-left, top-right, bottom-left, bottom-right, across, down. */
  box: [string, string, string, string, string, string];
  /** Where a rule meets the list's divider: from below, from above. */
  tee: [string, string];
  /** A portal opening and closing, one cell a frame: what marks something running. */
  portal: string;
  /** A teleport beam, one cell each: what has arrived, the track still to go, a mote on it, and the head's two sparkles. */
  beam: string;
  /** A horizontal rule. */
  rule: string;
  ellipsis: string;
}

export const UNICODE: Glyphs = {
  mark: '◎', dot: '●', ring: '○', sel: '›', nest: '⎿', sep: '·', bars: '▁▂▃▄▅▆▇█', spin: '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏',
  right: '→', left: '←', up: '↑', down: '↓', back: '⌫', yes: '✓', no: '✗', alert: '▲', none: '–',
  box: ['╭', '╮', '╰', '╯', '─', '│'], rule: '─', ellipsis: '…', tee: ['┬', '┴'], portal: '◌○◎◉◎○', beam: '━┈·✦✧',
};

export const ASCII: Glyphs = {
  mark: '@', dot: '*', ring: 'o', sel: '>', nest: '`-', sep: '-', bars: '_.-=+*#@', spin: '|/-\\',
  right: '->', left: '<-', up: 'up', down: 'down', back: 'bksp', yes: '+', no: 'x', alert: '!', none: '-',
  box: ['+', '+', '+', '+', '-', '|'], rule: '-', ellipsis: '...', tee: ['+', '+'], portal: '.oO@Oo', beam: '=-.*+',
};

/**
 * ASCII where the font likely lacks ⎿ and box glyphs: the Linux console, legacy Windows conhost
 * (neither Windows Terminal nor another emulator), or when asked with TLPT_ASCII set to anything but
 * 0, as NO_COLOR takes any value.
 */
export const wantsAscii = (env: NodeJS.ProcessEnv = process.env, platform: string = process.platform) =>
  (!!env.TLPT_ASCII && env.TLPT_ASCII !== '0') || env.TERM === 'linux' || (platform === 'win32' && !env.WT_SESSION && !env.TERM_PROGRAM);

/** The glyphs in use. A live binding: setGlyphs at startup (or in a test) changes it everywhere. */
export let G: Glyphs = UNICODE;
export const setGlyphs = (ascii: boolean) => void (G = ascii ? ASCII : UNICODE);

// Each one-cell Unicode glyph and its ASCII stand-in. The spinner and the portal are left out: their frames don't pair up.
const TO_ASCII = new Map<string, string>([
  ...(['dot', 'ring', 'sel', 'nest', 'sep', 'right', 'left', 'up', 'down', 'back', 'yes', 'no', 'alert', 'none', 'rule', 'ellipsis'] as const).map((k) => [UNICODE[k], ASCII[k]] as const),
  ...[...UNICODE.bars].map((ch, i) => [ch, ASCII.bars[i]!] as const),
  ...UNICODE.box.map((ch, i) => [ch, ASCII.box[i]!] as const),
  ...UNICODE.tee.map((ch, i) => [ch, ASCII.tee[i]!] as const),
  // The beam's mote is the separator's dot, which stays the separator's.
  ...[...UNICODE.beam].map((ch, i) => [ch, ASCII.beam[i]!] as const).filter(([ch]) => ch !== UNICODE.sep),
  [UNICODE.mark, ASCII.mark],
]);

/**
 * Text written once with the Unicode glyphs (shortcut keys, briefs, help), in the glyphs in use. The
 * key '↑↓' becomes 'up/down', since 'updown' would read as one word.
 */
export const inGlyphs = (s: string) => (G === UNICODE ? s : s.replace(/↑↓/g, `${G.up}/${G.down}`).replace(/[^\x00-\x7f]/gu, (ch) => TO_ASCII.get(ch) ?? ch));
