// teleport's key: what a caller shows to drive a device. The server listens on the network, as the
// device must reach it, so "from this machine" can only be read off a request: its address and its
// Host. Anything on this machine that passes connections on (an ssh or TCP tunnel, a reverse proxy,
// a dev server's proxy that rewrites Host) makes a stranger's request read the same. The key is what
// such a request can't have: ten random characters in a file only this user can read. The API,
// DevTools and DevTools' socket live under /__teleport/<key>/ and nowhere else.
//
// One key for this user on this machine, made the first time teleport starts and kept, so a DevTools
// window left open finds the teleport that restarted, and `tlpt q` finds whichever one is running.
import { randomBytes } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const KEY = /^[\w-]{10,64}$/;

/** Where the key is kept: `$XDG_CONFIG_HOME/teleport/key`, by default `~/.config/teleport/key`. */
export const keyFile = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'teleport', 'key');

/** This user's key, or null when no teleport has started here yet. */
export function readKey(): string | null {
  try {
    const key = readFileSync(keyFile(), 'utf8').trim();
    return KEY.test(key) ? key : null;
  } catch {
    return null;
  }
}

/** A new key: 60 bits, enough against guessing over a network, short enough for a link in a terminal. */
export const newKey = () => randomBytes(8).toString('base64url').slice(0, 10);

/**
 * This user's key, made and saved on first use. Where it can't be saved (a home that can't be
 * written), a key for this run only: DevTools' links carry it, and `tlpt q` has none to read.
 */
export function ensureKey(): string {
  const had = readKey();
  if (had) return had;
  const file = keyFile();
  const draft = `${file}.${process.pid}.${randomBytes(4).toString('hex')}`;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    // Written whole beside its place, then given its name only if nothing has it: two teleports
    // starting at the same moment end up with one key, and neither ever reads half of one. Opened
    // in place and then written, the other read an empty file and made up a key for itself.
    writeFileSync(draft, newKey() + '\n', { mode: 0o600 });
    try {
      linkSync(draft, file);
    } catch (e) {
      // A filesystem without links: its name is taken the other way, unless a key is there by now.
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' && !existsSync(file)) renameSync(draft, file);
    }
  } catch {
    // It can't be written: what is there, if anything, is read next.
  }
  rmSync(draft, { force: true });
  return readKey() ?? newKey();
}
