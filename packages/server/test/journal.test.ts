import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { entryOf, gist, keep, readJournal } from '../src/journal.js';

const ARM = 'Mozilla/5.0 (X11; Linux armv7l) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/63.0.3239.84 Safari/537.36';
const STICK = 'Mozilla/5.0 (Linux; Android 9; Acme-Stick Build/ABC123) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/53.0.2785.34 Safari/537.36';
const base = { id: 'ab12', ua: ARM, href: 'http://192.168.1.20:7070/home?token=abc', by: 'console' as const, ms: 10_400 };

describe('the journal of experiments', () => {
  it('keeps one line each, newest first, of one kind of device when asked', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'tlpt-journal-')), 'journal.jsonl');
    keep({ ...base, kind: 'capture', what: 'capture 10 s', result: { frames: { fps: 58.2, p95Ms: 18.4 }, input: { p95Ms: 41 } } }, file);
    keep({ ...base, ua: STICK, id: 'cd34', kind: 'probe', what: 'probe media', result: { groups: [{ items: [1, 2, 3] }] } }, file);
    keep({ ...base, kind: 'trial', what: 'trial shadow', error: 'stopped before every run\nmore', result: { variants: [{ name: 'no shadow' }, { name: 'box-shadow' }] } }, file);
    const all = readJournal({}, file);
    expect(all.map((e) => e.what)).toEqual(['trial shadow', 'probe media', 'capture 10 s']);
    expect(readJournal({ model: all[0]!.model }, file).map((e) => e.what)).toEqual(['trial shadow', 'capture 10 s']);
    // The page without its query, the first line of an error, and a line of each answer.
    expect(all[2]).toMatchObject({ page: '/home', by: 'console', ms: 10_400, engine: expect.stringContaining('Chrome 63') });
    expect(all[0]!.error).toBe('stopped before every run');
    expect(all.map(gist)).toEqual(['stopped before every run', '3 answers', '58.2 fps · frame p95 18.4 ms · key p95 41 ms']);
  });

  it('scrubs secrets as a survey does, keeps a long answer as its size, and reads past a line cut short', () => {
    // A token's shape, made here so no token sits in the source.
    const jwt = ['eyJ' + 'a'.repeat(12), 'b'.repeat(12), 'c'.repeat(12)].join('.');
    const e = entryOf({ ...base, kind: 'eval', what: 'eval x', result: { value: { token: jwt, url: 'https://cdn.example.com/a.m3u8?sig=abcdef&x=1' } } });
    expect(JSON.stringify(e.result)).not.toMatch(/eyJ|abcdef/);
    const big = entryOf({ ...base, kind: 'eval', what: 'eval big', result: { value: 'x'.repeat(300_000) } });
    expect(big.result).toBeUndefined();
    expect(big.cut).toBeGreaterThan(300_000);
    const file = join(mkdtempSync(join(tmpdir(), 'tlpt-journal-')), 'journal.jsonl');
    keep({ ...base, kind: 'keys', what: 'keys ok' }, file);
    writeFileSync(file, readFileSync(file, 'utf8') + '{"at":"cut sh');
    expect(readJournal({}, file).map((x) => x.what)).toEqual(['keys ok']);
  });

  it('keeps nothing with TELEPORT_JOURNAL=0', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'tlpt-journal-')), 'journal.jsonl');
    process.env.TELEPORT_JOURNAL = '0';
    try {
      expect(keep({ ...base, kind: 'keys', what: 'keys ok' }, file)).toBeNull();
    } finally {
      delete process.env.TELEPORT_JOURNAL;
    }
    expect(readJournal({}, file)).toEqual([]);
  });
});
