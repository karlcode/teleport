// The help screens as data, laid out by tui.helpView for the terminal's width and colours. The
// commands' briefs, help, costs and examples come from q.ts, so `tlpt q --help`, the console's
// palette and the MCP tools never drift apart. `tlpt --help` fits one screen: the keys are in the
// console's ? panel and the commands in `tlpt q --help`.
import { PROBES, type ProbeId } from './probes.js';
import { COMMANDS, groupOf, paramForm, Q_EXAMPLES, usageOf, type Command } from './q.js';
import { GROUPS as MENU_GROUPS, MENU, type Entry } from './menu.js';
import { G, inGlyphs, type HelpDoc } from './tui.js';

/** The commands in the order q's help groups them: what reads, what measures, what changes the page. */
const GROUPS = [
  ['read', 'Read', 'free on the device: what this laptop already has'],
  ['measure', 'Measure', 'runs on the device, leaves the page as it is'],
  ['change', 'Change the page', 'say what you changed'],
] as const;
const grouped = (g: (typeof GROUPS)[number][0]) => COMMANDS.filter((c) => groupOf(c) === g);
/** The console's groups, in its order: the main help's grid follows it. */
const GROUPS_SAID = MENU_GROUPS.map((g) => g.id).join(', ');

/** How many of Q_EXAMPLES q's own short help shows. */
const Q_SHORT_EXAMPLES = 6;

/** What each command that costs the device something costs, written out for its own page. */
const DUT_COST: Record<string, string> = {
  capture: "The agent records every frame and key press while it runs, then waits 1.5 s for the last frames. Nothing else: the inspector isn't loaded.",
  probe: 'One script, run once by the agent, which answers on the socket it already has: nothing is loaded into the page for it. Each probe above says what its script does.',
  styles: 'A few small scripts, run by the agent. The first names the style sheets; the laptop reads those itself, and each script after asks the engine about a few hundred selectors and declarations, so none holds the page for long.',
  try: "Each run gets a blank frame over the app (your app's own page, for css), so the device's screen is covered until it ends. It runs through the inspector, which stays loaded a minute after the last run. A codec plays 2 s clips the same way.",
  trial: "Each run gets a blank frame over the app (or runs in the page, when the spec says so), so the device's screen is covered until the trial ends. It runs through the inspector, which stays loaded a minute after the last run.",
  keys: "Key events in the page, sent by the agent: nothing is loaded into the page for them. The page's own key handlers run, so it changes as it would for a remote.",
  hear: "A key listener on the page's window, put there by the agent, and where the engine has the Gamepad API a 50 ms poll of its buttons; each press is watched 150 ms for what the page did. Both leave by themselves 5 s after the last read. Nothing is pressed.",
  eval: 'Your code runs in the page, run by the agent: nothing is loaded into the page for it. The page changes as far as your code changes it. An app that bundles an agent from before this is asked through the inspector, which then stays loaded a minute.',
  replay: "The tape's key events in the page, sent by the agent as keys sends them, while the agent records every frame for a capture of up to 10 s. Saving a tape reads what this laptop already has.",
  shim: 'While it is on, one more script on every page tlpt serves, ahead of the app: it defines what the engine lacks of a fixed list and nothing else. Turning it on or off reloads each device.',
};
const FREE = 'Nothing: it answers from what this laptop already has.';
/** What a choice of word does, for a command whose word is one of a few (shim on, shim off). */
const ENUM_SAYS: Record<string, string> = {
  'shim on': 'every page tlpt serves loads the shim ahead of the app; the devices reload into it',
  'shim off': 'pages load without it; the devices reload',
};

export function mainHelp(): HelpDoc {
  return {
    title: 'Chrome DevTools and measured trials for web apps on devices',
    sections: [
      {
        heading: 'Usage',
        note: 'tp and teleport are the same command',
        rows: [
          ['tlpt [app] [flags]', 'serve an app to the device and watch it here'],
          ['tlpt <command> [args]', 'ask or drive the device, from any other shell'],
          ['tlpt mcp', 'the same commands as tools for an AI agent'],
        ],
      },
      // Every command, flat: the same names the console lists under / and runs by their keys.
      { heading: 'Commands', note: GROUPS_SAID, grid: MENU.map((e) => [e.name, inGlyphs(e.brief)] as [string, string]) },
      {
        heading: 'App',
        rows: [
          ['5173', 'a dev server here, and its tunnel if any'],
          ['https://app.example.com', 'a deployed app; a bare host means https'],
          ['./dist', 'a folder of built files'],
          ['(nothing)', 'a dev server found, else ./, else type its port'],
        ],
      },
      {
        heading: 'Flags',
        rows: [
          ['--port 7070, --host', 'where tlpt listens; --host picks one interface'],
          ['--via <address>', 'what the device opens, when a proxy is in between'],
          ['--tunnel "<command>"', 'any tunnel command, run pointed at tlpt'],
          ['--no-open', "don't open DevTools when a device connects; d does"],
          ['--insecure', "trust any certificate the app's server presents"],
          ['--manifest /app.json', "add the agent to a launcher's JSON manifest"],
        ],
      },
      {
        heading: 'Environment',
        rows: [
          ['TELEPORT_PORT', 'the port commands and mcp ask, if not 7070'],
          // Names the Unicode glyphs on purpose, whichever set is in use: they are what it replaces.
          ['NO_COLOR, TLPT_ASCII=1', 'no colour; ASCII in place of ● ⎿ ▁▂▃ and arrows'],
          ['NODE_EXTRA_CA_CERTS', 'a root to trust when your network re-signs https'],
          ['TELEPORT_JOURNAL=0', 'keep no journal of experiments on this machine'],
        ],
      },
    ],
    // Short on purpose: the keys are one press away while it runs, and q --help lists the commands.
    footer: `tlpt <command> --help: one in full ${G.sep} https://github.com/karlcode/teleport`,
  };
}

/** q's short help, for a person at a terminal. Piped, q prints Q_USAGE, the long form, instead. */
export function qHelp(): HelpDoc {
  // Beyond the brief: that guide needs no device, and how long a capture may be.
  const more = (c: Command) => (c.local ? '; needs no device' : c.name === 'capture' ? ', 1 to 10 s' : '');
  return {
    title: 'ask the device from a shell, a script or an AI agent',
    intro: "In a terminal the answer is printed for a person; piped, or with --json, it is JSON. Every number was measured on the device; null means its engine can't measure it.",
    sections: [
      { heading: 'Usage', code: [['tlpt <command> [args] [--id device] [--port 7070] [--json]']] },
      ...GROUPS.map(([g, heading, note]) => ({ heading, note, rows: grouped(g).map((c) => [usageOf(c), inGlyphs(c.brief) + more(c)] as [string, string]) })),
      {
        heading: 'Every command',
        rows: [
          ['--id <device>', 'which device, by its id in status; else the newest'],
          ['--port 7070', 'where tlpt listens; or set TELEPORT_PORT'],
          ['--json', 'JSON, even in a terminal'],
          ['<command> --help', 'one command in full, and what it costs the device'],
        ],
      },
      { heading: 'Examples', code: Q_EXAMPLES.slice(0, Q_SHORT_EXAMPLES).map(([e]) => [`tlpt ${e}`]) },
    ],
    footer: 'A performance claim needs a trial behind it: medians, the 95% interval and the run count.',
  };
}

/** One command in full: what it does, its arguments and flags, what it costs the device, and examples. */
export function commandHelp(c: Command): HelpDoc {
  const words = c.params.filter((p) => p.positional);
  const flags = c.params.filter((p) => !p.positional);
  const examples = Q_EXAMPLES.filter(([e]) => e.split(' ')[0] === c.name);
  return {
    title: `${c.name} ${G.sep} ${inGlyphs(c.brief)}`,
    sections: [
      // guide answers here, so no device to pick; status and devices list every device.
      { heading: 'Usage', code: [[`tlpt ${usageOf(c)}${c.local || c.name === 'status' || c.name === 'devices' ? '' : ' [--id device]'} [--json]`]] },
      { heading: 'What it does', text: inGlyphs(c.help) },
      ...(words.some((p) => !p.enum) ? [{ heading: 'Arguments', rows: words.filter((p) => !p.enum).map((p) => [paramForm(p), p.help] as [string, string]) }] : []),
      // A choice of names (only probe's) lists each one, with what it answers and what its script does on the device.
      ...words.filter((p) => p.enum).map((p) => ({ heading: paramForm(p), rows: p.enum!.map((v) => [v, inGlyphs(v in PROBES ? probeLine(v) : (ENUM_SAYS[`${c.name} ${v}`] ?? p.help))] as [string, string]) })),
      ...(flags.length ? [{ heading: 'Flags', rows: flags.map((p) => [paramForm(p), p.help] as [string, string]) }] : []),
      { heading: 'Costs the device', text: c.cost ? (DUT_COST[c.name] ?? c.cost) : FREE },
      ...(examples.length ? [{ heading: 'Examples', code: examples.map(([e]) => [`tlpt ${e}`] as [string]) }] : []),
    ],
  };
}

/** remote, devtools or reload: what it does from a shell, and its key in the console. */
export function handHelp(e: Entry): HelpDoc {
  const does: Record<string, string> = {
    remote: "This terminal's keys drive the device until esc: arrows move, enter or space is OK, backspace is Back, digits are digits. For a script, tlpt keys right ok presses the same keys.",
    devtools: 'Opens Chrome DevTools for the device in your browser and prints its link.',
    reload: "Reloads the device's page.",
  };
  return {
    title: `${e.name} ${G.sep} ${e.brief}`,
    sections: [
      { heading: 'Usage', code: [[`tlpt ${e.name} [--id device]`]] },
      { heading: 'What it does', text: `${does[e.name]} In the console that is running, ${e.key} does the same.` },
      { heading: 'Costs the device', text: `${e.cost![0]!.toUpperCase()}${e.cost!.slice(1)}.` },
    ],
  };
}

const probeLine = (id: string) => {
  const p = PROBES[id as ProbeId];
  return `${p.about}. On the device: ${p.cost}`;
};
