// Everything tlpt can do, as five groups of entries. The console's list, `tlpt --help` and
// `tlpt <name>` in a shell all read it, so there is one name for each thing and one place to find it.
// The console shows the five groups and opens one at a time, so the list stays small. Most entries are
// a command from q.ts; three (remote, devtools, reload) are things only a person at a keyboard does, so
// they are not MCP tools. A command q.ts marks as for agents (guide, status) is not listed here.
//
// The groups go from what the app does on the device as it is, to changing one thing and measuring
// both ways, then video, input and inspecting: a web app on constrained hardware first, video second.
import { COMMANDS, type Command } from './q.js';

export type Group = 'measure' | 'experiment' | 'video' | 'input' | 'inspect';

export interface Entry {
  name: string;
  /** A few words, at most 26 characters. */
  brief: string;
  /** The key that runs it in the console with its defaults. */
  key?: string;
  /** The q command behind it; absent for the three a person does by hand. */
  cmd?: Command;
  /** What it costs the device, for an entry with no command behind it. */
  cost?: string;
  group: Group;
}

/** The groups in the order a person meets them, each with what it is for. */
export const GROUPS: { id: Group; brief: string }[] = [
  { id: 'measure', brief: 'how the app runs on it, as it is' },
  { id: 'experiment', brief: 'change one thing, measure both ways' },
  { id: 'video', brief: 'what it plays, and what it can' },
  { id: 'input', brief: 'the remote, and what the page hears' },
  { id: 'inspect', brief: 'DevTools, errors, requests, the device' },
];

const KEY: Record<string, string> = { capture: 'c', try: 't', survey: 's', probe: 'p', history: 'h', remote: 'r', devtools: 'd', reload: 'l', errors: 'e', device: 'i', network: 'n' };

const HAND: Entry[] = [
  { name: 'remote', brief: 'remote control, from here', cost: "the page's key handlers run; nothing is loaded", group: 'input' },
  { name: 'devtools', brief: 'open Chrome DevTools on it', cost: 'loads the inspector while DevTools is open', group: 'inspect' },
  { name: 'reload', brief: 'reload its page', cost: 'a reload', group: 'inspect' },
];

const ORDER: [Group, string[]][] = [
  ['measure', ['capture', 'survey', 'probe', 'styles', 'advise', 'report', 'history']],
  ['experiment', ['try', 'trial', 'eval', 'shim']],
  ['video', ['playback', 'verify']],
  ['input', ['remote', 'keys', 'replay', 'hear', 'keymap']],
  ['inspect', ['devtools', 'errors', 'network', 'device', 'devices', 'reload']],
];

const entryOf = (name: string, group: Group): Entry | null => {
  const hand = HAND.find((h) => h.name === name);
  if (hand) return { ...hand, key: KEY[name] };
  const cmd = COMMANDS.find((c) => c.name === name);
  return cmd ? { name, brief: cmd.brief, key: KEY[name], cmd, group } : null;
};

const listed = ORDER.flatMap(([group, names]) => names.map((n) => entryOf(n, group)).filter((e): e is Entry => !!e));

/** Every entry, group by group. A command q.ts gains shows up under inspect until it is placed. */
export const MENU: Entry[] = [...listed, ...COMMANDS.filter((c) => !c.agents && !listed.some((e) => e.name === c.name)).map((c) => ({ name: c.name, brief: c.brief, cmd: c, group: 'inspect' as const }))];

export const entry = (name: string): Entry | undefined => MENU.find((e) => e.name === name.toLowerCase());

/** A group's entries, in order. */
export const entriesOf = (g: Group): Entry[] => MENU.filter((e) => e.group === g);

/** Laptop keys that drive the device in remote mode: only keys no hotkey uses, so r twice never sends red. */
export const REMOTE_KEYS: Record<string, string> = {
  up: 'up', down: 'down', left: 'left', right: 'right', return: 'ok', space: 'ok', backspace: 'back',
  ...Object.fromEntries('0123456789'.split('').map((d) => [d, d])),
};
