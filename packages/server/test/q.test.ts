import { describe, expect, it } from 'vitest';
import { argsFromWords, COMMANDS, groupOf, latestLine, nearest, parseQ, Q_EXAMPLES, Q_USAGE, READ_COMMANDS, runQ, statusLines, usageOf } from '../src/q.js';
import { width } from '../src/text.js';
import { describeUa } from '../src/ua.js';

describe('teleport q', () => {
  it('reads --flags apart from the words of a command', () => {
    expect(parseQ(['network', 'rails', '--limit', '3', '--failed'])).toEqual({ name: 'network', pos: ['rails'], flags: { limit: '3', failed: '' } });
  });

  it('keeps what changes the page out of what an agent may run on its own', () => {
    expect(READ_COMMANDS).toEqual(['status', 'devices', 'device', 'errors', 'network', 'capture', 'probe', 'styles', 'guide', 'playback', 'survey', 'history', 'advise', 'report']);
  });

  it('says how to start teleport when none is running, and lists the commands for an unknown one', async () => {
    await expect(runQ(['status'], 1)).rejects.toThrow(/no teleport on port 1 .*Start it with `tlpt`/);
    await expect(runQ(['nope'], 1)).rejects.toThrow(/no command nope[\s\S]*trial \[file\]/);
  });

  it('prints status as one short entry per device', () => {
    expect(statusLines([], 7070)).toBe('teleport on port 7070: no device connected.');
    const ua = 'Mozilla/5.0 (X11; Linux armv7l) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/63.0.3239.84 Safari/537.36';
    const latest = { lagMs: 3.14, longTaskMs: 300, longTasks: 2, heapMB: 20.26, heapLimitMB: 512, domNodes: 400, keyToFrameMs: null };
    expect(statusLines([{ device: { id: 'ab12', ip: '10.0.0.5', ua, inspecting: true }, latest }], 7070)).toBe(
      `device ab12  ${describeUa(ua)}  10.0.0.5  DevTools open\n  now: timer lag 3.1 ms · 2 long tasks, 300 ms · heap 20.3 MB of 512 · 400 nodes`,
    );
  });

  it("leaves out what the engine can't measure", () => {
    expect(latestLine(null)).toBe('no sample yet');
    expect(latestLine({ lagMs: null, longTaskMs: 0, longTasks: 0, heapMB: null, heapLimitMB: null, domNodes: null, keyToFrameMs: 12 })).toBe('no long tasks · key → frame 12 ms');
  });
});

describe('q from shell words', () => {
  const cmd = (name: string) => COMMANDS.find((c) => c.name === name)!;
  it('takes capture seconds as a word, and refuses words a command does not take', () => {
    expect(argsFromWords(cmd('capture'), ['5'], {})).toEqual({ seconds: '5' });
    expect(cmd('capture').call!({ seconds: '5' }, '/')).toMatchObject({ q: { ms: 5000 } });
    expect(() => argsFromWords(cmd('capture'), ['5', 's'], {})).toThrow(/capture takes no word "s"/);
    expect(() => argsFromWords(cmd('status'), ['now'], {})).toThrow(/status takes no word "now"/);
  });

  it('also takes a positional by its name, as --seconds did before it was positional', () => {
    const { pos, flags } = parseQ(['capture', '--seconds', '5']);
    expect(argsFromWords(cmd('capture'), pos, flags)).toEqual({ seconds: 5 });
    expect(cmd('capture').call!({ seconds: 5 }, '/')).toMatchObject({ q: { ms: 5000 } });
    // A list by its name is still a list.
    const keys = parseQ(['keys', '--sequence', 'right,left ok']);
    expect(argsFromWords(cmd('keys'), keys.pos, keys.flags)).toEqual({ sequence: ['right', 'left', 'ok'] });
  });

  it('suggests the name a typo was likely meant to be, and nothing for a word that is far off', () => {
    const names = COMMANDS.map((c) => c.name);
    expect(nearest('cpature', names)).toBe('capture');
    expect(nearest('PROBE', names)).toBe('probe');
    expect(nearest('devics', names)).toBe('devices');
    expect(nearest('prot', ['port', 'host', 'no-open', 'insecure', 'help', 'version'])).toBe('port');
    expect(nearest('screenshot', names)).toBeNull();
  });

  it('runs every example as written, once the shell has had its part', () => {
    for (const [example] of Q_EXAMPLES) {
      // Quotes and the shell's redirects are the shell's; --json is taken out before the command, as cli.ts does.
      const words = (example.split(/ [>|] /)[0]!.match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map((w) => w.replace(/^(['"])(.*)\1$/, '$2')).filter((w) => w !== '--json');
      const { name, pos, flags } = parseQ(words);
      expect(() => argsFromWords(cmd(name), pos, flags), example).not.toThrow();
    }
  });
});

describe('q help', () => {
  it('groups commands by what they do to the device: read, measure, or change the page', () => {
    const names = (g: string) => COMMANDS.filter((c) => groupOf(c) === g).map((c) => c.name);
    expect([names('read'), names('measure'), names('change')]).toEqual([
      ['status', 'devices', 'device', 'errors', 'network', 'guide', 'history', 'report'],
      ['capture', 'probe', 'styles', 'playback', 'survey', 'advise'],
      ['trial', 'keys', 'hear', 'keymap', 'eval', 'verify', 'try', 'replay', 'shim'],
    ]);
  });

  it('writes usage as the help does', () => {
    expect(COMMANDS.map(usageOf)).toEqual([
      'status',
      'devices',
      'device [--seconds n]',
      'errors',
      'network [--url url] [--min-ms n] [--failed] [--limit n]',
      'capture [seconds]',
      'probe <name>',
      'styles',
      'guide [words...]',
      'trial [file] [--spec json]',
      'keys <sequence...>',
      'hear [seconds] [--forget]',
      'keymap [key] [code]',
      'eval <expression...>',
      'playback',
      'survey [label...] [--speed] [--capture n] [--verify] [--out out]',
      'verify [only...]',
      'try [what...] [--runs n] [--keys keys]',
      'replay [words...] [--seconds n]',
      'shim [state]',
      'history [--limit n] [--all]',
      'advise [from]',
      'report [from] [--md] [--list]',
    ]);
  });

  it('keeps the long form complete for agents, at 100 columns', () => {
    const flat = Q_USAGE.replace(/\s+/g, ' ');
    for (const c of COMMANDS) expect(flat).toContain(c.help);
    for (const [e] of Q_EXAMPLES) expect(Q_USAGE).toContain(`  tlpt q ${e}`);
    for (const line of Q_USAGE.split('\n')) expect(width(line)).toBeLessThanOrEqual(99);
  });

  it('keeps each brief short enough for the palette and the help grid', () => {
    for (const c of COMMANDS) expect(width(c.brief), c.name).toBeLessThanOrEqual(26);
  });
});
