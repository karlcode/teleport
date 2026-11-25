import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { askBackground, frame, KeyReader, parseKeys, PlainScreen, region, TermScreen } from '../src/term.js';
import { lightBackground, lightReply } from '../src/tui.js';

describe('the live region', () => {
  it('erases down from where it waits, prints log lines, draws the region and returns to its first row', () => {
    expect(frame([], ['a', 'b'], 80)).toBe('\r\x1b[Ja\x1b[0m\r\nb\x1b[0m\r\x1b[1A');
    expect(frame(['log'], ['x'], 80)).toBe('\r\x1b[Jlog\x1b[0m\r\nx\x1b[0m\r');
  });

  it('cuts region lines one column short of the width, so none wraps', () => {
    expect(frame([], ['abcdefghij'], 6)).toBe('\r\x1b[Jabcd…\x1b[0m\r');
  });

  it('blanks tabs, newlines and other control characters in the region, and keeps colours and links', () => {
    // A newline in a region line (an agent's multi-line eval on a busy line) would move every redraw down a row.
    const link = '\x1b]8;;http://x/\x1b\\x\x1b]8;;\x1b\\';
    expect(frame([], [`a\tb\nc\r\x07d\x1b[31me${link}`], 80)).toBe(`\r\x1b[Ja b c  d\x1b[31me${link}\x1b[0m\r`);
  });

  it('reads each key once after ctrl+z and fg', () => {
    const out = Object.assign(new EventEmitter(), { isTTY: true, columns: 40, rows: 10, write: () => true });
    const inp = Object.assign(new EventEmitter(), { isTTY: true, setRawMode() {}, setEncoding() {}, resume() {}, pause() {} });
    const screen = new TermScreen(out, inp, 5, false);
    const keys: string[] = [];
    screen.onKey((k) => keys.push(k.name));
    process.emit('SIGCONT');
    inp.emit('data', 'q');
    expect(keys).toEqual(['q']);
    expect(inp.listenerCount('data')).toBe(1);
    screen.close();
    expect(inp.listenerCount('data')).toBe(0);
  });

  function fake(columns = 40, rows = 10) {
    const writes: string[] = [];
    const out = Object.assign(new EventEmitter(), { isTTY: true, columns, rows, write: (s: string) => (writes.push(s), true) });
    const inp = Object.assign(new EventEmitter(), { isTTY: false, resume() {}, pause() {} });
    return { writes, out, inp, screen: new TermScreen(out, inp, 5, false) };
  }
  const tick = () => new Promise((r) => setTimeout(r, 20));

  it('draws once for many changes in a tick, skips a frame that changes nothing, and restores on close', async () => {
    const { writes, screen } = fake();
    screen.live(['one']);
    screen.live(['two']);
    screen.print(['event']);
    await tick();
    const frames = () => writes.filter((w) => w.includes('\x1b[?2026h'));
    expect(frames()).toHaveLength(1);
    expect(frames()[0]).toContain('event\x1b[0m\r\ntwo');
    expect(frames()[0]).not.toContain('one');
    screen.live(['two']);
    await tick();
    expect(frames()).toHaveLength(1);
    const before = writes.length;
    screen.close();
    const closing = writes.slice(before);
    expect(closing.some((w) => w.includes('\x1b[?25h') && w.includes('\x1b[J'))).toBe(true);
    screen.close();
    expect(writes).toHaveLength(before + closing.length);
  });

  const lines = (n: number, tag = 'e') => Array.from({ length: n }, (_, i) => `${tag}${i + 1}`);
  const rendered = (writes: string[]) => writes.filter((w) => w.includes('\x1b[?2026h')).at(-1)!;

  it('shows a window on the log inside the region, and prints a long log without growing the output', async () => {
    const { writes, screen } = fake(40, 20);
    screen.pin(['head']);
    screen.live(['live']);
    screen.print(lines(500));
    await tick();
    const f = rendered(writes);
    expect(f.split('\r\n')).toHaveLength(1 + 10 + 1);
    expect(f).toContain('e500');
    expect(f).not.toContain('e490');
    const size = writes.join('').length;
    screen.print(lines(500, 'f'));
    await tick();
    expect(writes.join('').length - size).toBeLessThan(size);
    expect(writes.join('')).not.toContain('\x1b[S');
    screen.close();
  });

  it('pages back through the log, says how many newer lines are below, and returns to the newest on 0', async () => {
    const { writes, screen } = fake(40, 20);
    screen.live(['live']);
    screen.print(lines(100));
    await tick();
    screen.scroll(1);
    await tick();
    const back = rendered(writes);
    expect(back).toContain('e82');
    expect(back).toContain('9 newer lines below');
    expect(back).not.toContain('e91');
    screen.scroll(-1);
    await tick();
    expect(rendered(writes)).toContain('e100');
    screen.scroll(2);
    await tick();
    screen.scroll(0);
    await tick();
    expect(rendered(writes)).toContain('e100');
    expect(rendered(writes)).not.toContain('newer line');
    screen.close();
  });

  it('keeps the window on what is being read while new lines arrive', async () => {
    const { writes, screen } = fake(40, 20);
    screen.print(lines(100));
    await tick();
    screen.scroll(1);
    await tick();
    const first = rendered(writes);
    const top = /e(\d+)/.exec(first)![1];
    screen.print(lines(5, 'n'));
    await tick();
    expect(rendered(writes)).toContain(`e${top}`);
    expect(rendered(writes)).toMatch(/\d+ newer lines below/);
    screen.close();
  });

  it('puts new lines in place of the last ones printed, only while they are still the newest', async () => {
    const { writes, screen } = fake(40, 20);
    const first = screen.print(['a', 'b']);
    expect(screen.amend(first, ['b x2'])).toBe(true);
    expect(screen.amend(first, ['b x3'])).toBe(true);
    const next = screen.print(['c']);
    expect(screen.amend(first, ['no'])).toBe(false);
    expect(screen.amend(next, ['c x2'])).toBe(true);
    await tick();
    const before = writes.length;
    screen.close();
    expect(writes.slice(before).join('').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').trim().split('\n')).toEqual(['b x3', 'c x2']);
    expect(new PlainScreen({ write: () => true }).amend()).toBe(false);
  });

  it('on close erases the region and leaves the pinned lines and the last 200 log lines as plain lines', async () => {
    const { writes, screen } = fake(40, 20);
    screen.pin(['head']);
    screen.print(lines(500));
    await tick();
    const before = writes.length;
    screen.close();
    const left = writes.slice(before).find((w) => w.includes('head'))!;
    const out = left.split('\n').map((l) => l.replace(/\x1b\[0m/g, ''));
    expect(out.slice(0, 2)).toEqual(['head', 'e301']);
    expect(out.filter(Boolean)).toHaveLength(1 + 200);
    expect(out.at(-2)).toBe('e500');
    expect(writes.slice(before).findIndex((w) => w.includes('\x1b[J'))).toBeLessThan(writes.slice(before).indexOf(left));
  });

  it('pins and scrolls as plain output when not on a terminal', () => {
    const got: string[] = [];
    const s = new PlainScreen({ write: (x: string) => got.push(x) }, () => new Date(2026, 0, 1, 14, 2, 11));
    s.pin(['  ◆ teleport', '  open on the device  http://x/']);
    s.scroll();
    expect(got).toEqual(['  ◆ teleport\n  open on the device  http://x/\n']);
  });

  it('keeps the bottom of a region taller than the terminal, where the input is', async () => {
    const { writes, screen } = fake(40, 5);
    screen.live(['1', '2', '3', '4', '5', '6', 'input']);
    await tick();
    const f = writes.find((w) => w.includes('\x1b[?2026h'))!;
    expect(f).toContain('input');
    expect(f).not.toContain('\r\n2');
    screen.close();
  });

  it('draws in full after a resize', async () => {
    const { writes, out, screen } = fake();
    screen.live(['row']);
    await tick();
    out.emit('resize');
    await tick();
    expect(writes.filter((w) => w.includes('\x1b[?2026h'))).toHaveLength(2);
    screen.close();
  });

  it('prints each event with the time when not on a terminal, details lined up under it', () => {
    const got: string[] = [];
    const s = new PlainScreen({ write: (x: string) => got.push(x) }, () => new Date(2026, 0, 1, 14, 2, 11));
    s.print(['● ab12 connected', '  ⎿ Linux · Chrome 63']);
    s.print(['', '  T E L E P O R T']);
    s.live();
    expect(got).toEqual(['14:02:11 ● ab12 connected\n           ⎿ Linux · Chrome 63\n', '\n  T E L E P O R T\n']);
  });
});

describe('keys from the terminal', () => {
  const names = (s: string) => parseKeys(s).map((k) => (k.ctrl ? 'ctrl+' : '') + (k.meta ? 'meta+' : '') + k.name);

  it('reads escape sequences whole, and a lone escape as Escape', () => {
    expect(names('\x1b')).toEqual(['escape']);
    expect(names('\x1b[A\x1b[B\x1b[C\x1b[D')).toEqual(['up', 'down', 'right', 'left']);
    expect(names('\x1bOA')).toEqual(['up']);
    expect(names('\x1b[3~')).toEqual(['delete']);
    expect(names('\x1b[1;5C')).toEqual(['ctrl+right']);
    expect(names('\x1b[Z')).toEqual(['tab']);
  });

  it('reads enter, tab, backspace, ctrl keys and alt keys', () => {
    expect(names('\r')).toEqual(['return']);
    expect(names('\t')).toEqual(['tab']);
    expect(names('\x7f')).toEqual(['backspace']);
    expect(names('\x03')).toEqual(['ctrl+c']);
    expect(names('\x15')).toEqual(['ctrl+u']);
    expect(names('\x1bx')).toEqual(['meta+x']);
    // Alt+Backspace (ESC DEL in VTE, kitty, iTerm2 with Option as Esc+) deletes a word; it isn't Escape.
    expect(names('\x1b\x7f')).toEqual(['meta+backspace']);
    expect(names('\x1b\b')).toEqual(['meta+backspace']);
  });

  it('gives printable keys their text, one by one', () => {
    expect(parseKeys('?')).toEqual([{ name: '?', text: '?', ctrl: false, meta: false, shift: false }]);
    expect(parseKeys('Q')[0]).toMatchObject({ name: 'q', text: 'Q', shift: true });
    expect(parseKeys(' ')[0]).toMatchObject({ name: 'space', text: ' ' });
    expect(names('ab\r')).toEqual(['a', 'b', 'return']);
    expect(parseKeys('é')[0]).toMatchObject({ text: 'é' });
  });

  it('holds an escape sequence split across chunks until the rest comes', () => {
    const r = new KeyReader();
    expect(r.feed('\x1b')).toEqual([]);
    expect(r.waiting).toBe(true);
    expect(r.feed('[A').map((k) => k.name)).toEqual(['up']);
    expect(r.feed('\x1b[1;')).toEqual([]);
    expect(r.feed('5C').map((k) => k.name)).toEqual(['right']);
    expect(r.feed('\x1b')).toEqual([]);
    expect(r.flush().map((k) => k.name)).toEqual(['escape']);
  });

  it('gathers a bracketed paste whole, across chunks, so its newline never acts as Enter', () => {
    const r = new KeyReader();
    expect(r.feed('\x1b[200~eval 1\rl')).toEqual([]);
    expect(r.feed('d\x1b[20')).toEqual([]);
    const keys = r.feed('1~x');
    expect(keys).toEqual([
      { name: 'paste', text: 'eval 1\rld', ctrl: false, meta: false, shift: false },
      { name: 'x', text: 'x', ctrl: false, meta: false, shift: false },
    ]);
  });
});

describe('region', () => {
  const log = (n: number) => Array.from({ length: n }, (_, i) => `e${i + 1}`);

  it('gives the log at most half the terminal, or six lines when that is more', () => {
    expect(region([], log(100), ['live'], 0, 80, 40).window).toBe(20);
    expect(region([], log(100), ['live'], 0, 80, 12).window).toBe(6);
    expect(region([], log(3), ['live'], 0, 80, 40).window).toBe(3);
  });

  it('never gives the log more than the room left under the header and above the live rows', () => {
    const r = region(['h1', 'h2'], log(100), ['a', 'b', 'c'], 0, 80, 10);
    expect(r.lines).toHaveLength(9);
    expect(r.window).toBe(9 - 2 - 3);
    expect(r.lines).toEqual(['h1', 'h2', 'e97', 'e98', 'e99', 'e100', 'a', 'b', 'c']);
  });

  it('drops the pinned lines when there is no room for them and a log line', () => {
    const r = region(['h1', 'h2'], log(10), ['a', 'b', 'c', 'd'], 0, 80, 7);
    expect(r.lines).toEqual(['e9', 'e10', 'a', 'b', 'c', 'd']);
    expect(r.lines).not.toContain('h1');
    const full = region(['h1'], [], Array.from({ length: 20 }, (_, i) => `l${i}`), 0, 80, 6);
    expect(full.lines).toEqual(['l15', 'l16', 'l17', 'l18', 'l19']);
  });

  it('shows an older view with the count of newer lines in the last row of the window', () => {
    const r = region([], log(100), ['live'], 30, 80, 20);
    expect(r.lines.slice(0, 9)).toEqual(log(100).slice(60, 69));
    expect(r.lines[9]).toContain('30 newer lines below');
    expect(r.lines.at(-1)).toBe('live');
    expect(region([], log(100), ['live'], 9, 80, 20).lines[9]).toContain('9 newer lines below');
    expect(region([], log(100), ['live'], 1, 80, 20).lines[9]).toContain('1 newer line below');
    expect(region([], log(100), ['live'], 1, 80, 20).lines[9]).not.toContain('lines');
  });

  it('stops at the oldest line however far back it is asked', () => {
    const r = region([], log(100), ['live'], 5000, 80, 20);
    expect(r.lines[0]).toBe('e1');
  });

  it('cuts long log lines one column short of the width', () => {
    const r = region([], ['x'.repeat(100)], [], 0, 20, 20);
    expect(r.lines[0]).toBe('x'.repeat(18) + '…');
  });
});

describe("the terminal's background", () => {
  // A stand-in for stdin and stdout: what is written is answered, as a terminal would.
  const terminal = (answer: (asked: string) => string | null) => {
    const inp = Object.assign(new EventEmitter(), { isTTY: true, raw: false, setRawMode(on: boolean) { inp.raw = on; }, setEncoding() {}, resume() {}, pause() {} });
    const out = { write: (s: string) => (setTimeout(() => { const a = answer(s); if (a !== null) inp.emit('data', a); }, 1), true) };
    return { inp, out };
  };

  it('is read from the answer to OSC 11, as light or dark', () => {
    expect(lightReply('\x1b]11;rgb:ffff/ffff/ffff\x1b\\')).toBe(true);
    expect(lightReply('\x1b]11;rgb:fdfd/f6f6/e3e3\x07')).toBe(true);
    expect(lightReply('\x1b]11;rgb:1e1e/1e1e/1e1e\x07')).toBe(false);
    expect(lightReply('\x1b]11;rgb:00/2b/36\x1b\\')).toBe(false);
    expect(lightReply('\x1b[?62;22c')).toBe(null);
    expect(lightReply('')).toBe(null);
  });

  it('is said outright by TLPT_THEME, ahead of COLORFGBG', () => {
    expect(lightBackground({ TLPT_THEME: 'light' })).toBe(true);
    expect(lightBackground({ TLPT_THEME: 'dark', COLORFGBG: '0;15' })).toBe(false);
    expect(lightBackground({ COLORFGBG: '0;15' })).toBe(true);
    expect(lightBackground({})).toBe(false);
  });

  it('is asked with a second question every terminal answers, so one that has no answer costs no wait', async () => {
    const knows = terminal(() => '\x1b]11;rgb:ffff/ffff/ffff\x1b\\\x1b[?62;22c');
    expect(lightReply(await askBackground(knows.inp, knows.out, 2000))).toBe(true);
    expect(knows.inp.raw).toBe(false);
    const started = Date.now();
    const knowsNot = terminal(() => '\x1b[?1;2c');
    expect(lightReply(await askBackground(knowsNot.inp, knowsNot.out, 2000))).toBe(null);
    expect(Date.now() - started).toBeLessThan(500);
    const silent = terminal(() => null);
    expect(await askBackground(silent.inp, silent.out, 20)).toBe('');
    expect(silent.inp.listenerCount('data')).toBe(0);
  });

  it('answers that come late are not keys', () => {
    expect(parseKeys('\x1b]11;rgb:ffff/ffff/ffff\x1b\\\x1b[?62;22cc').map((k) => k.name)).toEqual(['c']);
    const r = new KeyReader();
    expect(r.feed('\x1b]11;rgb:ffff/ff')).toEqual([]);
    expect(r.feed('ff/ffff\x07x').map((k) => k.name)).toEqual(['x']);
  });
});
