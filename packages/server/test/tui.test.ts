import { afterEach, describe, expect, it } from 'vitest';
import { width } from '../src/text.js';
import { header, helpView, inGlyphs, paint, plain, setGlyphs, wantsAscii, type Color, type Header, type HelpDoc } from '../src/tui.js';

const h = (o: Partial<Header> = {}): Header => ({
  app: 'example.com',
  dut: 'http://192.168.1.20:7070/',
  snippet: "import teleport from '@tlpt/agent'",
  lan: '192.168.1.20:7070',
  color: 'truecolor',
  ...o,
});
const text = (o: Partial<Header> = {}) => header(h(o)).map(plain).join('\n');

describe('terminal output', () => {
  it('is the mark and the one address to open on the device, nothing else', () => {
    expect(header(h()).map(plain).filter((l) => l.trim())).toEqual(['  ◎ teleport  → example.com', '  open on the device  http://192.168.1.20:7070/']);
  });

  it('puts the same URL behind the link, and prints no escapes without colour', () => {
    expect(header(h()).join('\n')).toContain('\x1b]8;;http://192.168.1.20:7070/\x1b\\');
    expect(header(h({ color: 'none' })).join('\n')).not.toContain('\x1b');
  });

  it('draws in the phosphor ink when the terminal has true colour', () => {
    expect(header(h()).join('')).toContain('38;2;214;222;178');
  });

  it('says how to link the app only when teleport is not serving it', () => {
    expect(text()).not.toContain('@tlpt/agent');
    const linking = text({ dut: null, app: null });
    expect(linking).toContain("import teleport from '@tlpt/agent'");
    expect(linking).toContain("teleport.init({ url: 'ws://192.168.1.20:7070/ws/target' })");
  });
});

describe('glyphs and tones', () => {
  afterEach(() => setGlyphs(false));

  it('draws the mark in ASCII where the terminal lacks the glyphs', () => {
    setGlyphs(true);
    expect(text()).toContain('  @ teleport  -> example.com');
    expect(text({ app: null })).toContain('  @ teleport  no app yet');
  });

  it('draws ASCII when TLPT_ASCII is set to anything but 0, as NO_COLOR takes any value', () => {
    for (const v of ['1', 'true', 'yes']) expect(wantsAscii({ TLPT_ASCII: v }, 'linux'), v).toBe(true);
    for (const v of ['', '0', undefined]) expect(wantsAscii({ TLPT_ASCII: v }, 'linux'), String(v)).toBe(false);
  });

  it('turns text written with Unicode glyphs into the set in use', () => {
    const s = '↑↓ select · key → frame ✓ ▁▃█ ●';
    expect(inGlyphs(s)).toBe(s);
    setGlyphs(true);
    expect(inGlyphs(s)).toBe('up/down select - key -> frame + _-@ *');
  });

  it('on a light background, draws ink in the default foreground and dims faint text', () => {
    const p = paint('truecolor', true);
    expect([p.ink('a'), p.muted('a'), p.faint('a'), p.rule('a')]).toEqual(['a', 'a', '\x1b[2ma\x1b[22m', '\x1b[2ma\x1b[22m']);
    expect(header(h({ light: true })).join('')).not.toContain('38;2;');
    expect(helpView(doc({ intro: 'An intro.', sections: [{ heading: 'Head', note: 'a note', rows: [['a', 'b']] }] }), 80, 'truecolor', true).join('')).not.toContain('38;2;');
  });
});

const doc = (o: Partial<HelpDoc> = {}): HelpDoc => ({ title: 'a short title', sections: [], ...o });
const view = (d: HelpDoc, cols = 80, color: Color = 'none') => helpView(d, cols, color).map(plain);

describe('help layout', () => {
  it('puts the intro under the title, a note beside its heading, and the footer last', () => {
    const d = doc({ intro: 'An intro.', sections: [{ heading: 'Head', note: 'a note', text: 'Some text.' }], footer: 'The end, https://example.com/x' });
    expect(view(d)).toEqual(['', '  ◎ teleport  a short title', '', '  An intro.', '', '  Head  a note', '    Some text.', '', '  The end, https://example.com/x', '']);
    const painted = helpView(d, 80, 'truecolor');
    expect(painted[1]).toBe('  \x1b[38;2;63;212;192m◎\x1b[39m \x1b[1m\x1b[38;2;214;222;178mteleport\x1b[39m\x1b[22m  \x1b[38;2;184;191;151ma short title\x1b[39m');
    expect(painted[3]).toContain('38;2;184;191;151m'); // the intro is muted
    expect(painted[5]).toBe('  \x1b[1mHead\x1b[22m  \x1b[38;2;149;155;121ma note\x1b[39m'); // bold in the default colour, the note faint
    expect(painted[8]).toContain('\x1b]8;;https://example.com/x\x1b\\');
  });

  it('moves the title under the mark below 72 columns', () => {
    expect(view(doc(), 72).slice(1, 3)).toEqual(['  ◎ teleport  a short title', '']);
    expect(view(doc(), 71).slice(1, 4)).toEqual(['  ◎ teleport', '  a short title', '']);
  });

  it('lines up every row section on one column, two past the widest term that takes at most 40%', () => {
    const d = doc({
      sections: [
        { heading: 'One', rows: [['a', 'first']] },
        { heading: 'Two', rows: [['a longer term', 'second'], ['x'.repeat(40), 'its own line']] },
      ],
    });
    expect(view(d)).toEqual(['', '  ◎ teleport  a short title', '', '  One', `    a${' '.repeat(14)}first`, '', '  Two', '    a longer term  second', `    ${'x'.repeat(40)}`, `${' '.repeat(19)}its own line`, '']);
  });

  it('stacks descriptions under their terms below 60 columns', () => {
    expect(view(doc({ sections: [{ heading: 'Flags', rows: [['--port 7070', 'where it listens']] }] }), 59).slice(5, 7)).toEqual(['    --port 7070', '        where it listens']);
    // A term too long for the line breaks at spaces like code, rather than losing its end.
    expect(view(doc({ sections: [{ heading: 'Read', rows: [['network [--url url] [--min-ms n] [--failed] [--limit n]', 'its requests']] }] }), 50).slice(5, 8)).toEqual([
      '    network [--url url] [--min-ms n] [--failed]',
      '      [--limit n]',
      '        its requests',
    ]);
  });

  it('lays a grid out column by column, in as many columns as fit and at most 3', () => {
    const pairs = 'abcdefg'.split('').map((k) => [k, `does ${k}`] as [string, string]);
    expect(view(doc({ sections: [{ heading: 'Keys', grid: pairs }] })).slice(4, 7)).toEqual(['    a  does a   d  does d   g  does g', '    b  does b   e  does e', '    c  does c   f  does f']);
    // Cells of 2 + 3 + 16 + 3: three fit in 80 columns, two in 60 and 50, one in 40.
    const keys = Array.from({ length: 11 }, (_, i) => [`k${i}`, 'a sixteen-letter'] as [string, string]);
    const columns = (cols: number) => Math.max(...view(doc({ sections: [{ heading: 'Keys', grid: keys }] }), cols).map((l) => l.match(/k\d+ /g)?.length ?? 0));
    expect([100, 80, 60, 50, 40].map(columns)).toEqual([3, 3, 2, 2, 1]);
  });

  it('keeps code notes beside their code while they all fit, else under each, and breaks a long line at spaces', () => {
    const code: [string, string?][] = [['tlpt 5173', 'your dev server'], ['tlpt q capture 5', 'a capture']];
    expect(view(doc({ sections: [{ heading: 'Examples', code }] }), 80).slice(4, 6)).toEqual(['    tlpt 5173          your dev server', '    tlpt q capture 5   a capture']);
    expect(view(doc({ sections: [{ heading: 'Examples', code: [['x'.repeat(30), 'a note too long to sit beside it']] }] }), 60).slice(5, 7)).toEqual([`    ${'x'.repeat(30)}`, '      a note too long to sit beside it']);
    // A note on its own line wraps under itself rather than being cut.
    expect(view(doc({ sections: [{ heading: 'Examples', code: [['x'.repeat(30), 'the commands as tools in Claude Code']] }] }), 40).slice(5, 8)).toEqual([`    ${'x'.repeat(30)}`, '      the commands as tools in Claude', '      Code']);
    expect(view(doc({ sections: [{ heading: 'Usage', code: [['tlpt q network [--url url] [--min-ms n] [--failed] [--limit n] [--id device] [--json]']] }] }), 80).slice(4, 6)).toEqual([
      '    tlpt q network [--url url] [--min-ms n] [--failed] [--limit n] [--id',
      '      device] [--json]',
    ]);
  });

  it('never draws a line as wide as the terminal, whatever the content, and stops at 100 columns', () => {
    const d = doc({
      title: 'a title long enough that it has to wrap under the mark on any narrow terminal at all',
      intro: '漢字の説明 '.repeat(20),
      sections: [
        { heading: 'A heading', note: 'a note that is long enough not to fit beside its heading at fifty', rows: [['term', 'word '.repeat(40)], ['x'.repeat(70), 'y']] },
        { heading: 'Grid', grid: [['k', 'a description of thirty chars!']] },
        { heading: 'Code', code: [['z'.repeat(120), 'note']] },
      ],
      footer: 'see https://github.com/karlcode/teleport/blob/main/README.md for more',
    });
    for (const cols of [120, 100, 80, 60, 50, 40]) for (const l of helpView(d, cols, 'truecolor')) expect(width(l)).toBeLessThanOrEqual(Math.min(cols, 100) - 1);
  });
});

describe('state colours on a light background', () => {
  it('are darker ones, since the dark theme\'s are 2 to 1 against white', () => {
    const dark = paint('truecolor');
    const light = paint('truecolor', true);
    expect(dark.warn('x')).toBe('\x1b[38;2;242;173;72mx\x1b[39m');
    expect(light.warn('x')).toBe('\x1b[38;2;122;82;0mx\x1b[39m');
    expect(light.good('x')).toBe('\x1b[38;2;30;123;58mx\x1b[39m');
    expect(light.bad('x')).toBe('\x1b[38;2;179;38;30mx\x1b[39m');
    expect(paint('256', true).bad('x')).toBe('\x1b[38;5;124mx\x1b[39m');
    expect(paint('none', true).bad('x')).toBe('x');
  });
});
