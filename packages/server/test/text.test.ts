import { describe, expect, it } from 'vitest';
import { pad, printable, strip, truncate, width, wrap } from '../src/text.js';

const ink = (s: string) => `\x1b[38;2;214;222;178m${s}\x1b[39m`;
const link = (url: string) => `\x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\`;

describe('text as the terminal draws it', () => {
  it('measures columns without escapes, with wide characters as two and combining marks as none', () => {
    expect(width(ink('teleport'))).toBe(8);
    expect(width(link('http://device/'))).toBe(14);
    expect(width('テレビ')).toBe(6);
    expect(width('é')).toBe(1);
    expect(width('── ● ▁▂█ ⎿ → ·')).toBe(14);
    // Emoji are two wide, as terminals draw them; tlpt's own marks stay one.
    expect(width('🚀✅❌⭐⚡⌛☕🛑🟢🪄')).toBe(20);
    expect(width('✓✗–⌫')).toBe(4);
    expect(strip(ink('a') + link('b'))).toBe('ab');
  });

  it('cuts to a width with an ellipsis, keeping escapes whole and closing what it cut open', () => {
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(truncate('abc', 4)).toBe('abc');
    const cut = truncate(ink('abcdef'), 4);
    expect(strip(cut)).toBe('abc…');
    expect(cut.endsWith('\x1b[0m')).toBe(true);
    const cutLink = truncate(link('http://example.com/long'), 10);
    expect(strip(cutLink)).toBe('http://ex…');
    expect(cutLink).toContain('\x1b]8;;\x1b\\');
    expect(width(truncate('テレビテレビ', 5))).toBeLessThanOrEqual(5);
    expect(truncate('x', 0)).toBe('');
  });

  it('pads to a width measured the same way', () => {
    expect(width(pad(ink('ab'), 5))).toBe(5);
    expect(pad('abcdef', 3)).toBe('abcdef');
  });

  it('wraps words, breaks words longer than a line, and keeps newlines', () => {
    expect(wrap('the quick brown fox jumps', 10)).toEqual(['the quick', 'brown fox', 'jumps']);
    expect(wrap('aaaaaaaaaaaa bb', 5)).toEqual(['aaaaa', 'aaaaa', 'aa bb']);
    expect(wrap('one\ntwo three', 20)).toEqual(['one', 'two three']);
  });

  it('always ends, however narrow: at least one character a line', () => {
    expect(wrap('abc def', 0)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(wrap('abc', -2)).toEqual(['a', 'b', 'c']);
    expect(wrap('東京', 1)).toEqual(['東', '京']);
    expect(wrap('a 東京', 3)).toEqual(['a', '東', '京']);
  });
});

describe("a device's words, before they are printed", () => {
  it('keeps the text and drops what a terminal would act on', () => {
    // A window title, a clear screen, a clipboard write, a bell, an 8-bit CSI: all of it from a page.
    expect(printable('boom \x1b]0;pwned\x07\x1b[2J\x1b]52;c;cHduZWQ=\x1b\\ \x9b31m end')).toBe('boom ]0;pwned[2J]52;c;cHduZWQ=\\ 31m end');
    expect(printable('tab\tand\nnewline stay, \r and \x00 go')).toBe('tab\tand\nnewline stay,  and  go');
    expect(printable('テレビ ✓ é 😀')).toBe('テレビ ✓ é 😀');
  });

  it('reaches every string in an answer, keys included, and leaves the rest as it was', () => {
    const said = { id: 7, ok: true, none: null, list: ['a\x1b[0m', 2, { 'k\x1b[1m': 'v\x07' }], nested: { text: '\x1b[31mred' } };
    expect(printable(said)).toEqual({ id: 7, ok: true, none: null, list: ['a[0m', 2, { 'k[1m': 'v' }], nested: { text: '[31mred' } });
    expect(printable(undefined)).toBeUndefined();
    expect(printable(1.5)).toBe(1.5);
  });
});
