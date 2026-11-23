import { build } from 'esbuild';
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureKey, keyFile, readKey } from '../src/key.js';
import { request } from '../src/q.js';
import { startDevServer } from '../src/server.js';

describe("teleport's key", () => {
  const was = process.env.XDG_CONFIG_HOME;
  beforeEach(() => {
    process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'tlpt-key-'));
  });
  afterEach(() => {
    process.env.XDG_CONFIG_HOME = was;
  });

  it('is made on first use, kept in a file only this user reads, and the same from then on', (ctx) => {
    expect(readKey()).toBeNull();
    const key = ensureKey();
    expect(key).toMatch(/^[\w-]{10}$/);
    expect(readFileSync(keyFile(), 'utf8')).toBe(key + '\n');
    expect(ensureKey()).toBe(key);
    expect(readKey()).toBe(key);
    // Windows has no such modes.
    if (process.platform === 'win32') return ctx.skip();
    expect(statSync(keyFile()).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(keyFile())).mode & 0o777).toBe(0o700);
  });

  // Two tlpt starting at once, or a tlpt and its tests: each must end with the key the other has.
  // Made by opening the file and then writing it, one read the file empty and made up its own.
  it('is one key for every process that starts at the same moment', async () => {
    const built = join(mkdtempSync(join(tmpdir(), 'tlpt-key-src-')), 'key.mjs');
    await build({ entryPoints: [fileURLToPath(new URL('../src/key.ts', import.meta.url))], outfile: built, format: 'esm', platform: 'node', logLevel: 'error' });
    for (let round = 0; round < 4; round++) {
      const home = mkdtempSync(join(tmpdir(), 'tlpt-key-race-'));
      const script = `import(${JSON.stringify(built)}).then((m) => console.log(m.ensureKey()))`;
      const one = () => new Promise<string>((resolve, reject) => void execFile('node', ['-e', script], { env: { ...process.env, XDG_CONFIG_HOME: home } }, (e, out) => (e ? reject(e) : resolve(out.trim()))));
      const keys = await Promise.all(Array.from({ length: 12 }, one));
      expect(new Set(keys).size, `round ${round}: ${[...new Set(keys)].join(' ')}`).toBe(1);
      expect(readFileSync(join(home, 'teleport', 'key'), 'utf8')).toBe(keys[0] + '\n');
      // And nothing is left beside it.
      expect(readdirSync(join(home, 'teleport'))).toEqual(['key']);
    }
  });

  it('is different on every machine: ten characters of 64, from the system', () => {
    const keys = new Set(Array.from({ length: 50 }, () => ((process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'tlpt-key-'))), ensureKey())));
    expect(keys.size).toBe(50);
  });

  it('is for this run only where it cannot be saved, and never a file that is not a key', (ctx) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return ctx.skip();
    mkdirSync(dirname(keyFile()), { recursive: true });
    writeFileSync(keyFile(), 'not a key\n');
    expect(readKey()).toBeNull();
    expect(ensureKey()).toMatch(/^[\w-]{10}$/);
    expect(readFileSync(keyFile(), 'utf8')).toBe('not a key\n');
    const locked = mkdtempSync(join(tmpdir(), 'tlpt-key-'));
    chmodSync(locked, 0o500);
    process.env.XDG_CONFIG_HOME = locked;
    expect(ensureKey()).toMatch(/^[\w-]{10}$/);
    expect(readKey()).toBeNull();
  });

  it('is what a server asks for and what tlpt q sends, without either being told', async () => {
    const server = await startDevServer({ port: 0, host: '127.0.0.1' });
    const port = (server.http.address() as { port: number }).port;
    try {
      expect(server.key).toBe(readKey());
      expect(await request(port, 'live')).toEqual([]);
      // Another user's tlpt, or one on a machine whose key this isn't: refused, and said plainly.
      process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'tlpt-key-'));
      await expect(request(port, 'live')).rejects.toThrow(/no teleport has run on this machine as this user/);
      ensureKey();
      await expect(request(port, 'live')).rejects.toThrow(/this needs teleport's key/);
    } finally {
      await server.close();
    }
  });

  it('can be given, for a server started from a script', async () => {
    const server = await startDevServer({ port: 0, host: '127.0.0.1', key: 'given-key-1' });
    const at = `http://127.0.0.1:${(server.http.address() as { port: number }).port}/__teleport`;
    try {
      expect(server.key).toBe('given-key-1');
      expect((await fetch(`${at}/given-key-1/api/live`)).status).toBe(200);
      expect(readKey()).toBeNull();
    } finally {
      await server.close();
    }
  });
});

describe('an answer that is not tlpt', () => {
  it('is said as what it is, not as a parse error', async () => {
    ensureKey();
    const { createServer } = await import('node:http');
    const other = createServer((_req, res) => res.writeHead(431).end());
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
    try {
      await expect(request((other.address() as { port: number }).port, 'live')).rejects.toThrow(/answered 431 .*not as tlpt does/);
    } finally {
      other.close();
    }
  });
});
