import { afterEach, describe, expect, it } from 'vitest';
import { commandHelp, handHelp, mainHelp, qHelp } from '../src/help.js';
import { MENU } from '../src/menu.js';
import { COMMANDS } from '../src/q.js';
import { width } from '../src/text.js';
import { helpView, plain, setGlyphs } from '../src/tui.js';

const render = (lines: string[]) => lines.map(plain).join('\n');
const cmd = (name: string) => COMMANDS.find((c) => c.name === name)!;

// The spec's renders at 80 columns, line for line.
const MAIN_80 = `
  ◎ teleport  Chrome DevTools and measured trials for web apps on devices

  Usage  tp and teleport are the same command
    tlpt [app] [flags]       serve an app to the device and watch it here
    tlpt <command> [args]    ask or drive the device, from any other shell
    tlpt mcp                 the same commands as tools for an AI agent

  Commands  measure, experiment, video, input, inspect
    capture   fps and key → frame          verify    play real clips on it
    survey    everything, saved locally    remote    remote control, from here
    probe     what the engine supports     keys      press remote keys
    styles    CSS the engine drops         replay    a journey, pressed again
    advise    what to change, and how      hear      what the page hears
    report    one file: facts and advice   keymap    what each remote key sends
    history   every experiment, kept       devtools  open Chrome DevTools on it
    try       flip one thing, measured     errors    what the page threw
    trial     compare variants, measured   network   its requests through tlpt
    eval      run ES5 in the page          device    one device's last minute
    shim      fill in what it lacks        devices   each device, link health
    playback  what plays, its tracks       reload    reload its page

  App
    5173                     a dev server here, and its tunnel if any
    https://app.example.com  a deployed app; a bare host means https
    ./dist                   a folder of built files
    (nothing)                a dev server found, else ./, else type its port

  Flags
    --port 7070, --host      where tlpt listens; --host picks one interface
    --via <address>          what the device opens, when a proxy is in between
    --tunnel "<command>"     any tunnel command, run pointed at tlpt
    --no-open                don't open DevTools when a device connects; d does
    --insecure               trust any certificate the app's server presents
    --manifest /app.json     add the agent to a launcher's JSON manifest

  Environment
    TELEPORT_PORT            the port commands and mcp ask, if not 7070
    NO_COLOR, TLPT_ASCII=1   no colour; ASCII in place of ● ⎿ ▁▂▃ and arrows
    NODE_EXTRA_CA_CERTS      a root to trust when your network re-signs https
    TELEPORT_JOURNAL=0       keep no journal of experiments on this machine

  tlpt <command> --help: one in full · https://github.com/karlcode/teleport
`;

const Q_80 = `
  ◎ teleport  ask the device from a shell, a script or an AI agent

  In a terminal the answer is printed for a person; piped, or with --json, it
  is JSON. Every number was measured on the device; null means its engine
  can't measure it.

  Usage
    tlpt <command> [args] [--id device] [--port 7070] [--json]

  Read  free on the device: what this laptop already has
    status                           each device's last second
    devices                          each device, link health
    device [--seconds n]             one device's last minute
    errors                           what the page threw
    network [--url url] [--min-ms n] [--failed] [--limit n]
                                     its requests through tlpt
    guide [words...]                 what to try on a device; needs no device
    history [--limit n] [--all]      every experiment, kept
    report [from] [--md] [--list]    one file: facts and advice

  Measure  runs on the device, leaves the page as it is
    capture [seconds]                fps and key → frame, 1 to 10 s
    probe <name>                     what the engine supports
    styles                           CSS the engine drops
    playback                         what plays, its tracks
    survey [label...] [--speed] [--capture n] [--verify] [--out out]
                                     everything, saved locally
    advise [from]                    what to change, and how

  Change the page  say what you changed
    trial [file] [--spec json]       compare variants, measured
    keys <sequence...>               press remote keys
    hear [seconds] [--forget]        what the page hears
    keymap [key] [code]              what each remote key sends
    eval <expression...>             run ES5 in the page
    verify [only...]                 play real clips on it
    try [what...] [--runs n] [--keys keys]
                                     flip one thing, measured
    replay [words...] [--seconds n]  a journey, pressed again
    shim [state]                     fill in what it lacks
    reserve [--as as] [--seconds n] [--no-frame]
                                     hold a device for a run
    release                          let a held device go
    clear                            forget errors and requests

  Every command
    --id <device>                    which device, by its id in status; else
                                     the newest
    --port 7070                      where tlpt listens; or set TELEPORT_PORT
    --json                           JSON, even in a terminal
    <command> --help                 one command in full, and what it costs the
                                     device

  Examples
    tlpt status
    tlpt capture 5
    tlpt network --failed
    tlpt probe media
    tlpt trial examples/trials/focus-ring.mjs
    tlpt keys right right ok

  A performance claim needs a trial behind it: medians, the 95% interval and
  the run count.
`;

describe('help', () => {
  afterEach(() => setGlyphs(false));

  it('prints tlpt --help as the spec draws it at 80 columns', () => {
    expect(render(helpView(mainHelp(), 80, 'none'))).toBe(MAIN_80);
  });

  it('prints tlpt q --help as the spec draws it at 80 columns', () => {
    expect(render(helpView(qHelp(), 80, 'none'))).toBe(Q_80);
  });

  it('keeps every line of every page inside the width, in colour too', () => {
    const docs = [mainHelp(), qHelp(), ...COMMANDS.map(commandHelp)];
    for (const cols of [100, 80, 60, 50, 40]) for (const doc of docs) for (const l of helpView(doc, cols, 'truecolor')) expect(width(l)).toBeLessThanOrEqual(Math.min(cols, 100) - 1);
  });

  it('fits tlpt --help on one screen, with every command in one flat list', () => {
    const lines = helpView(mainHelp(), 80, 'none');
    expect(lines.length).toBeLessThanOrEqual(44);
    const text = render(lines).replace(/\s+/g, ' ');
    for (const e of MENU) expect(text).toContain(` ${e.name} ${e.brief}`);
    expect(text).toContain('tlpt <command> --help: one in full');
    expect(text).not.toContain('tlpt q');
  });

  it('writes out the three a person does by hand, with the key that does the same in the console', () => {
    const remote = render(helpView(handHelp(MENU.find((e) => e.name === 'remote')!), 80, 'none')).replace(/\s+/g, ' ');
    expect(remote).toContain(' tlpt remote [--id device] ');
    expect(remote).toContain('r does the same.');
    for (const e of MENU.filter((x) => !x.cmd)) expect(render(helpView(handHelp(e), 80, 'none'))).toMatch(/Costs the device\n {4}[A-Z]/);
  });

  it('takes the commands of tlpt q --help from q, so they never drift', () => {
    // A long usage wraps, so the brief may sit on the line after its command.
    const text = render(helpView(qHelp(), 100, 'none')).replace(/\s+/g, ' ');
    for (const c of COMMANDS) {
      expect(text).toContain(` ${c.name} `);
      expect(text).toContain(c.brief);
    }
  });

  it("writes one command out in full: usage, what it does, its names, what it costs, examples", () => {
    const probe = render(helpView(commandHelp(cmd('probe')), 80, 'none'));
    expect(probe).toContain('  ◎ teleport  probe · what the engine supports');
    expect(probe).toContain('    tlpt probe <name> [--id device] [--json]');
    expect(probe).toContain('  <name>\n    identity  ');
    expect(probe).toMatch(/identity +model, screen, memory, network\. On the device:\s+reads properties/);
    expect(probe).toContain('  Costs the device\n    One script, run once by the agent, which answers on the socket it already');
    expect(probe).toContain('  Examples\n    tlpt probe media\n    tlpt probe storage --id k3x9q2ab --json > storage.json');
    const network = render(helpView(commandHelp(cmd('network')), 80, 'none'));
    expect(network).toMatch(/Flags\n {4}--url url +Only URLs containing this\.\n {4}--min-ms n +/);
    expect(network).toContain('  Costs the device\n    Nothing: it answers from what this laptop already has.');
    expect(render(helpView(commandHelp(cmd('guide')), 80, 'none'))).toContain('tlpt guide [words...] [--json]');
    // status and devices list every device, so they take no --id.
    for (const name of ['status', 'devices']) expect(render(helpView(commandHelp(cmd(name)), 80, 'none'))).toContain(`tlpt ${name} [--json]`);
  });

  it('says what every command that costs the device costs, and where the inspector is held', () => {
    for (const c of COMMANDS.filter((c) => c.cost)) {
      const text = render(helpView(commandHelp(c), 100, 'none')).replace(/\s+/g, ' ');
      expect(text).toMatch(/Costs the device [A-Z]/);
      if (/inspector/.test(c.cost!)) expect(text).toContain('stays loaded a minute after the last');
    }
  });

  it('draws in ASCII when the terminal lacks the glyphs, except where it names them', () => {
    setGlyphs(true);
    const text = render(helpView(mainHelp(), 80, 'none'));
    expect(text).toContain('tlpt <command> --help: one in full - https');
    expect(render(helpView(qHelp(), 80, 'none'))).toMatch(/capture.* +fps and key -> frame/);
    expect(text.replace('ASCII in place of ● ⎿ ▁▂▃ and arrows', '')).toMatch(/^[\x00-\x7f]*$/);
  });

  it('links the project page', () => {
    expect(helpView(mainHelp(), 80, '256').join('\n')).toContain('\x1b]8;;https://github.com/karlcode/teleport\x1b\\');
  });
});
