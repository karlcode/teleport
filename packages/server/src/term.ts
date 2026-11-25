// The terminal under the console. Everything it shows is one region redrawn in place: the pinned
// header, a window on the last event lines, and the live rows and keys under it. Event lines are
// kept in a ring and seen through the window, which page up and page down move, so a long session
// never grows the terminal's scrollback. No alternate screen: on quit the region is erased and the
// last of the log is left behind as plain lines.
//
// Between frames the cursor waits at the top-left of the region. A frame returns there, erases
// down, writes the region, and moves back up to its first row. Erasing down from the region's top clears whatever the terminal made of the old
// region, reflowed after a resize or not, so a redraw never needs to know how tall the old one was.
// Each frame is one write inside a synchronized update (DEC 2026): terminals that know it never show
// a half-drawn frame, and the rest ignore it. Region lines are cut one column short of the width, so
// none wraps. Frames are coalesced, and one that changes nothing isn't written.
import { writeSync } from 'node:fs';
import { truncate } from './text.js';

export interface Key {
  /** The key's name: 'up', 'return', 'escape', 'tab', 'backspace', 'paste', a letter, ... */
  name: string;
  /** What was typed, for printable keys; the whole text, for a paste. */
  text: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
}

export interface Screen {
  readonly cols: number;
  readonly rows: number;
  /** Whether keys can arrive: stdin is a terminal. */
  readonly interactive: boolean;
  /** Adds lines to the log, seen through a window above the live region. Returns a mark for amend. */
  print(lines: string[]): number;
  /**
   * Puts `lines` in place of what the print that returned `mark` added, while that is still the
   * newest in the log: how a line that repeats becomes one line with a count. False when it can't
   * (something was printed since, or this is not a terminal), and nothing changes.
   */
  amend(mark: number, lines: string[]): boolean;
  /** Lines kept at the top of the region, above the log: the header. */
  pin(lines: string[]): void;
  /** Moves the log's window by `pages` of its own height: positive is older. 0 returns to the newest. */
  scroll(pages: number): void;
  /** Sets what the live region shows; drawn soon, once, however many times this is called. */
  live(lines: string[]): void;
  onKey(fn: (k: Key) => void): void;
  onResize(fn: () => void): void;
  /** Erases the live region and restores the terminal. Safe to call twice. */
  close(): void;
}

const SYNC_ON = '\x1b[?2026h';
const SYNC_OFF = '\x1b[?2026l';
const HIDE = '\x1b[?25l';
const SHOW = '\x1b[?25h';
const PASTE_ON = '\x1b[?2004h';
const PASTE_OFF = '\x1b[?2004l';
const ERASE_DOWN = '\x1b[J';
/** Leaves the terminal as it found it: no half frame, no live region, no paste mode, colours off, cursor shown. */
const RESTORE = SYNC_OFF + '\r' + ERASE_DOWN + PASTE_OFF + '\x1b[0m' + SHOW;

/**
 * One frame, from the top-left of the old region: erase down, print the event lines (which may wrap,
 * as a log line should), draw the region cut to the width, and return to the region's first row.
 */
export function frame(printed: string[], lines: string[], cols: number): string {
  let s = '\r' + ERASE_DOWN;
  for (const l of printed) s += l + '\x1b[0m\r\n';
  // A tab or other control character moves the cursor in a way width() can't count, and a line that
  // moved would put the redraw in the wrong place: they are blanked, whatever drew them. ESC stays,
  // since colours and links are made of it.
  s += lines.map((l) => truncate(l.replace(/[\x00-\x1a\x1c-\x1f\x7f]/g, ' '), cols - 1) + '\x1b[0m').join('\r\n');
  s += '\r';
  if (lines.length > 1) s += `\x1b[${lines.length - 1}A`;
  return s;
}

const CSI: Record<string, string> = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end', Z: 'tab' };
const TILDE: Record<string, string> = { '1': 'home', '2': 'insert', '3': 'delete', '4': 'end', '5': 'pageup', '6': 'pagedown', '7': 'home', '8': 'end' };
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const MAX_PASTE = 65536;
/** How long an escape sequence may arrive split across chunks before a lone ESC is the Escape key. */
export const ESC_WAIT_MS = 25;

/**
 * Turns terminal input into keys. It keeps state across chunks: an escape sequence cut between two
 * writes (a slow SSH link) is held until the rest comes, and a bracketed paste is gathered whole, so
 * a pasted newline never acts as Enter and the rest of a paste never fires as keys. A lone ESC is the
 * Escape key after ESC_WAIT_MS, not readline's half second, which also turned Esc then a key into Alt.
 */
export class KeyReader {
  private tail = '';
  private paste: string | null = null;

  /** Keys in the chunk, and whether an incomplete escape is held (call flush() if nothing follows). */
  feed(chunk: string): Key[] {
    let s = this.tail + chunk;
    this.tail = '';
    const out: Key[] = [];
    const key = (name: string, o: Partial<Key> = {}) => out.push({ name, text: '', ctrl: false, meta: false, shift: false, ...o });
    let i = 0;
    while (i < s.length) {
      if (this.paste !== null) {
        const end = s.indexOf(PASTE_END, i);
        if (end < 0) {
          // A paste end may itself be cut: keep anything that could be its start.
          const keep = partialSuffix(s.slice(i), PASTE_END);
          this.paste = (this.paste + s.slice(i, s.length - keep.length)).slice(0, MAX_PASTE);
          this.tail = keep;
          return out;
        }
        this.paste = (this.paste + s.slice(i, end)).slice(0, MAX_PASTE);
        out.push({ name: 'paste', text: this.paste, ctrl: false, meta: false, shift: false });
        this.paste = null;
        i = end + PASTE_END.length;
        continue;
      }
      const c = s[i]!;
      if (c === '\x1b') {
        const rest = s.slice(i + 1);
        if (s.startsWith(PASTE_START, i)) {
          this.paste = '';
          i += PASTE_START.length;
          continue;
        }
        // A terminal's answer to a question (its background colour, what it is), late or after a
        // resize: not a key. Without this an OSC reply would be typed into the input, letter by letter.
        if (rest[0] === ']') {
          const end = /\x07|\x1b\\/.exec(rest);
          if (!end) {
            this.tail = s.slice(i).slice(0, 256);
            return out;
          }
          i += 1 + end.index + end[0].length;
          continue;
        }
        const reply = /^\[\?[0-9;]*[A-Za-z]/.exec(rest);
        if (reply) {
          i += 1 + reply[0].length;
          continue;
        }
        const m = /^(?:\[|O)([0-9;]*)([A-Za-z~])/.exec(rest);
        if (m) {
          const name = m[2] === '~' ? TILDE[m[1]!.split(';')[0]!] : CSI[m[2]!];
          const mods = Number(m[1]!.split(';')[1] ?? 1) - 1;
          if (name) key(name, { shift: !!(mods & 1) || m[2] === 'Z', meta: !!(mods & 2), ctrl: !!(mods & 4) });
          i += 1 + m[0].length;
        } else if (rest === '' || /^(?:\[|O)[0-9;]*$/.test(rest)) {
          // Maybe the start of a sequence whose rest is in the next chunk.
          this.tail = s.slice(i);
          return out;
        } else if (rest[0] === '\x7f' || rest[0] === '\b') {
          // Alt+Backspace, which deletes a word, not Escape then Backspace.
          key('backspace', { meta: true });
          i += 2;
        } else if (rest[0]! >= ' ') {
          key(rest[0]!.toLowerCase(), { meta: true });
          i += 2;
        } else {
          key('escape');
          i += 1;
        }
        continue;
      }
      const code = c.charCodeAt(0);
      if (c === '\r' || c === '\n') key('return');
      else if (c === '\t') key('tab');
      else if (c === '\x7f' || c === '\b') key('backspace');
      else if (code === 0) key('space', { ctrl: true });
      else if (code < 27) key(String.fromCharCode(code + 96), { ctrl: true });
      else if (code < 32) key('unknown');
      else {
        const ch = String.fromCodePoint(s.codePointAt(i)!);
        key(ch === ' ' ? 'space' : ch.toLowerCase(), { text: ch, shift: ch !== ch.toLowerCase() });
        i += ch.length;
        continue;
      }
      i += 1;
    }
    return out;
  }

  /** Whether an incomplete escape is held, waiting for more. */
  get waiting() {
    return this.tail !== '';
  }

  /** What is held, as keys, when no more arrived in time: a lone ESC is Escape. */
  flush(): Key[] {
    if (this.paste !== null) return [];
    const t = this.tail;
    this.tail = '';
    if (!t) return [];
    const out: Key[] = [{ name: 'escape', text: '', ctrl: false, meta: false, shift: false }];
    return t.length > 1 ? [...out, ...this.feed(t.slice(1))] : out;
  }
}

/** The longest end of `s` that is a start of `of`. */
function partialSuffix(s: string, of: string) {
  for (let n = Math.min(s.length, of.length - 1); n > 0; n--) if (of.startsWith(s.slice(-n))) return s.slice(-n);
  return '';
}

/** Keys from one chunk, for callers without a stream: a held escape counts as Escape. */
export function parseKeys(chunk: string): Key[] {
  const r = new KeyReader();
  return [...r.feed(chunk), ...r.flush()];
}

interface Out {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  write(s: string): boolean;
  on(ev: 'resize' | 'error', fn: (...a: unknown[]) => void): unknown;
  fd?: number;
}
interface In {
  isTTY?: boolean;
  setRawMode?(on: boolean): unknown;
  setEncoding?(enc: BufferEncoding): unknown;
  on(ev: 'data', fn: (chunk: string | Buffer) => void): unknown;
  off?(ev: 'data', fn: (chunk: string | Buffer) => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

/** How long a terminal has to say its background colour. One that knows the question answers in a few ms. */
export const ASK_MS = 120;

/**
 * Asks the terminal its background colour (OSC 11) and what it is (DA1), and resolves with whatever
 * it answered. Every terminal answers the second, and answers in order, so one that doesn't know the
 * first is known at once, without waiting out `ms`. Run before the console takes the keyboard: the
 * reply arrives as input. A reply later than `ms` is dropped by KeyReader, never read as keys.
 */
export function askBackground(inp: In = process.stdin, out: Pick<Out, 'write'> = process.stdout, ms = ASK_MS): Promise<string> {
  return new Promise((resolve) => {
    if (!inp.isTTY || !inp.setRawMode) return resolve('');
    let got = '';
    const done = () => {
      clearTimeout(timer);
      inp.off?.('data', onData);
      inp.setRawMode!(false);
      inp.pause();
      resolve(got);
    };
    const onData = (chunk: string | Buffer) => {
      got += chunk.toString();
      if (/\x1b\[\?[0-9;]*c/.test(got)) done();
    };
    const timer = setTimeout(done, ms);
    inp.setRawMode(true);
    inp.setEncoding?.('utf8');
    inp.on('data', onData);
    inp.resume();
    out.write('\x1b]11;?\x1b\\\x1b[c');
  });
}

type Write = (chunk: unknown, ...rest: unknown[]) => boolean;

/** Log lines kept to scroll back through, and how many of them are left in the terminal on quit. */
const LOG_KEPT = 2000;
const LOG_LEFT = 200;
/** The log's window is never shorter than this when there is room, nor taller than half the terminal. */
const LOG_MIN = 6;

/**
 * The lines of a frame: the pinned header when it fits, a window on the log, then the live rows.
 * `back` is how many lines the window's bottom is above the newest; a line says so while it is.
 */
export function region(pinned: string[], log: string[], live: string[], back: number, cols: number, rows: number): { lines: string[]; window: number } {
  const room = rows - 1;
  // The bottom is kept, where the input and the keys are.
  const kept = live.length > room ? live.slice(live.length - room) : live;
  let left = room - kept.length;
  const head = left >= pinned.length + 1 ? pinned : [];
  left -= head.length;
  const window = Math.max(0, Math.min(log.length, left, Math.max(LOG_MIN, Math.floor(rows / 2))));
  const end = log.length - Math.min(back, Math.max(0, log.length - window));
  const shown = log.slice(end - window, end).map((l) => truncate(l, cols - 1));
  if (window && end < log.length) shown[window - 1] = `\x1b[2m  ${log.length - end} newer line${log.length - end === 1 ? '' : 's'} below \u00b7 page down\x1b[22m`;
  return { lines: [...head, ...shown, ...kept], window };
}

/** A live screen on a terminal. */
export class TermScreen implements Screen {
  private lines: string[] = [];
  private log: string[] = [];
  private pinned: string[] = [];
  /** How many lines the last print added, and which print that was: what amend may replace. */
  private tail = 0;
  private mark = 0;
  private back = 0;
  private window = 0;
  private drawnText = '';
  private timer: NodeJS.Timeout | null = null;
  private keys: ((k: Key) => void)[] = [];
  private resizes: (() => void)[] = [];
  private closed = false;
  private reader = new KeyReader();
  private escTimer: NodeJS.Timeout | null = null;
  private stray = '';
  private originals: { out: Write; err: Write } | null = null;
  private readonly restore = () => this.restoreSync();
  private readonly onData = (chunk: string | Buffer) => {
    if (this.escTimer) clearTimeout(this.escTimer);
    this.escTimer = null;
    this.emit(this.reader.feed(String(chunk)));
    if (this.reader.waiting) this.escTimer = setTimeout(() => this.emit(this.reader.flush()), ESC_WAIT_MS);
  };
  private readonly onCont = () => this.resume();

  constructor(
    private out: Out = process.stdout,
    private inp: In = process.stdin,
    private frameMs = 16,
    /** Capture other writes to stdout and stderr into scrollback, so nothing tears the region. */
    private captureStray = out === process.stdout,
  ) {
    this.enter();
    this.out.on('resize', () => {
      for (const fn of this.resizes) fn();
      this.drawnText = '';
      this.schedule();
    });
    // The terminal went away (EIO, EPIPE): nothing more can be drawn.
    this.out.on('error', () => this.close());
    // However the process ends, the terminal gets its cursor and its line mode back.
    process.on('exit', this.restore);
    process.on('SIGCONT', this.onCont);
  }

  get interactive() {
    return !!(this.inp.isTTY && this.inp.setRawMode);
  }

  get cols() {
    return Math.max(20, this.out.columns ?? 80);
  }

  get rows() {
    return Math.max(5, this.out.rows ?? 24);
  }

  print(lines: string[]) {
    if (!lines.length) return 0;
    if (this.closed) return this.raw(lines.join('\n') + '\n'), 0;
    this.log.push(...lines);
    this.tail = lines.length;
    this.mark++;
    if (this.log.length > LOG_KEPT) this.log.splice(0, this.log.length - LOG_KEPT);
    // Scrolled back, the window stays on what was being read.
    if (this.back) this.back = Math.min(this.back + lines.length, this.log.length);
    this.schedule();
    return this.mark;
  }

  amend(mark: number, lines: string[]) {
    // Anything may have printed since, the stray-output capture included: then the mark is stale.
    const count = this.tail;
    if (this.closed || !mark || mark !== this.mark || this.log.length < count) return false;
    this.log.splice(this.log.length - count, count, ...lines);
    this.tail = lines.length;
    if (this.back) this.back = Math.max(0, Math.min(this.back + lines.length - count, this.log.length));
    this.schedule();
    return true;
  }

  pin(lines: string[]) {
    this.pinned = lines;
    this.schedule();
  }

  scroll(pages: number) {
    const step = Math.max(1, this.window - 1);
    this.back = pages === 0 ? 0 : Math.max(0, Math.min(this.back + pages * step, Math.max(0, this.log.length - this.window)));
    this.schedule();
  }

  live(lines: string[]) {
    this.lines = lines;
    this.schedule();
  }

  onKey(fn: (k: Key) => void) {
    this.keys.push(fn);
  }

  onResize(fn: () => void) {
    this.resizes.push(fn);
  }

  /** Ctrl+Z: give the shell its terminal back and stop, as any program does. Not on Windows. */
  suspend() {
    if (process.platform === 'win32') return;
    this.leave();
    process.kill(process.pid, 'SIGTSTP');
  }

  close() {
    if (this.closed) return;
    this.draw();
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.escTimer) clearTimeout(this.escTimer);
    this.leave();
    // What happened stays in the terminal after quitting, as plain lines.
    const left = [...this.pinned, ...this.log.slice(-LOG_LEFT)];
    if (left.length) this.out.write(left.map((l) => l + '\x1b[0m').join('\n') + '\n');
    process.off('exit', this.restore);
    process.off('SIGCONT', this.onCont);
    this.inp.off?.('data', this.onData);
    this.inp.pause();
  }

  private enter() {
    this.raw(HIDE + (this.interactive ? PASTE_ON : ''));
    if (this.interactive) {
      this.inp.setRawMode!(true);
      this.inp.setEncoding?.('utf8');
      // Back from a suspend, the listener is still there: one more would read every key twice.
      this.inp.off?.('data', this.onData);
      this.inp.on('data', this.onData);
      this.inp.resume();
    }
    if (this.captureStray && !this.originals) {
      // Anything else that writes (a Node warning, a library's console.error) goes above the region.
      const out = process.stdout.write.bind(process.stdout) as Write;
      const err = process.stderr.write.bind(process.stderr) as Write;
      this.originals = { out, err };
      const take = (chunk: unknown) => {
        this.stray += typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
        const lines = this.stray.split('\n');
        this.stray = lines.pop()!;
        if (lines.length) this.print(lines);
        return true;
      };
      (process.stdout as unknown as { write: Write }).write = take;
      (process.stderr as unknown as { write: Write }).write = take;
    }
  }

  /** Back to the shell's terminal: region erased, line mode on, stray writes go where they went. */
  private leave() {
    this.raw(RESTORE);
    this.drawnText = '';
    if (this.interactive) this.inp.setRawMode!(false);
    if (this.originals) {
      (process.stdout as unknown as { write: Write }).write = this.originals.out;
      (process.stderr as unknown as { write: Write }).write = this.originals.err;
      this.originals = null;
      if (this.stray) this.raw(this.stray + '\n');
      this.stray = '';
    }
  }

  /** Back from a suspend: the terminal may be anything, so take it again and draw in full. */
  private resume() {
    if (this.closed) return;
    this.enter();
    this.drawnText = '';
    this.schedule();
  }

  private emit(keys: Key[]) {
    for (const k of keys) {
      if (k.ctrl && k.name === 'z') {
        this.suspend();
        continue;
      }
      for (const fn of this.keys) fn(k);
    }
  }

  /** Writes past the stray-output capture. */
  private raw(s: string) {
    if (this.originals) this.originals.out(s);
    else this.out.write(s);
  }

  private schedule() {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.draw();
    }, this.frameMs);
  }

  private draw() {
    if (this.closed) return;
    const cols = this.cols;
    // Never taller than the terminal: a region that scrolls can't be redrawn in place.
    const { lines, window } = region(this.pinned, this.log, this.lines, this.back, cols, this.rows);
    this.window = window;
    const text = lines.join('\n') + '\x00' + cols;
    if (text === this.drawnText) return;
    this.raw(SYNC_ON + frame([], lines, cols) + SYNC_OFF);
    this.drawnText = text;
  }

  private restoreSync() {
    if (this.closed) return;
    try {
      writeSync(this.out.fd ?? 1, RESTORE);
      if (this.interactive) this.inp.setRawMode!(false);
    } catch {
      // The terminal is gone; nothing to restore.
    }
  }
}

/**
 * Not a terminal (piped, logged, TERM=dumb): event lines as plain lines with the time, no escapes,
 * no live region, no keys. A log of a session reads top to bottom.
 */
export class PlainScreen implements Screen {
  readonly cols = 100;
  readonly rows = 1000;
  readonly interactive = false;
  constructor(
    private out: { write(s: string): unknown } = process.stdout,
    private clock: () => Date = () => new Date(),
  ) {}
  print(lines: string[]) {
    if (!lines.length) return 0;
    const d = this.clock();
    const stamp = [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':') + ' ';
    // The header and blank lines go as they are; an event's first line gets the time, its detail lines line up under it.
    const event = /^\S/.test(lines[0]!) && !lines[0]!.startsWith('  ');
    this.out.write(lines.map((l, i) => (event ? (i === 0 ? stamp : ' '.repeat(stamp.length)) + l : l)).join('\n') + '\n');
    return 0;
  }
  live() {}
  /** A log that is piped keeps every line. */
  amend() {
    return false;
  }
  pin(lines: string[]) {
    this.print(lines);
  }
  scroll() {}
  onKey() {}
  onResize() {}
  close() {}
}
