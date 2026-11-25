# teleport: the reference

Everything teleport does for whoever uses it, a person or an AI agent. People start at
[README.md](README.md). Commands an agent runs: `tlpt q <command>` (JSON when piped) or the MCP
tools from `tlpt mcp`; both are described below.

Changing teleport itself: [ARCHITECTURE.md](ARCHITECTURE.md) explains each part and what was done
to make it cheap, and [CLAUDE.md](CLAUDE.md) has the rules for working in the repository.

## Requirements

- **Laptop**: Node.js 20 or later, and Chrome, Edge or any Chromium to run DevTools in. macOS,
  Linux and Windows.
- **Device**: anything that runs Chromium 38 or later and can open a WebSocket to your laptop.
  Any embedded browser or WebView built on Chromium 38 or later.
  The agent needs typed arrays and `WebSocket`; without them it stays asleep and does nothing.
- **Network**: the device must reach your laptop, on the same LAN or through a tunnel. Nothing on the
  laptop needs to reach the device.

### Install

```sh
npm install -g tlpt
```

That puts the command on your PATH under three names, `tlpt`, `tp` and `teleport`, the same way
`npm install -g @anthropic-ai/claude-code` gives you `claude`: npm links the package's `bin` into
its global bin folder. It needs no other
packages and starts in about 60 ms. To try it without installing, `npx tlpt` works the same, half a
second slower each time.

| Where | How | You type |
|---|---|---|
| Everywhere, once | `npm install -g tlpt` | `tlpt` |
| Everywhere, with another package manager | `bun add -g tlpt`, `pnpm add -g tlpt` or `yarn global add tlpt` | `tlpt` |
| Without Node, macOS or Linux | `curl -fsSL https://raw.githubusercontent.com/karlcode/teleport/main/install.sh \| sh` (once a release is out) | `tlpt` |
| One project | `npm install -D tlpt`, then a script such as `"device": "tlpt 5173"` | `npm run device` |
| Just once | nothing | `npx tlpt`, `bunx tlpt` or `pnpm dlx tlpt` |
| From a checkout | `npm install && npm run link` (builds, then links `packages/tlpt` globally) | `tlpt` |
| From a file someone sent | `npm install -g ./tlpt-<version>.tgz`, made in a checkout by `npm run pack` | `tlpt` |

The install script is how Claude Code installs itself: it downloads a single native executable for
your machine from the latest GitHub release (about 30–40 MB compressed: Node is inside it), checks it
against the release's `SHA256SUMS`, puts it in `~/.local/bin`, and adds that folder to your PATH in
your shell's startup file, once. Run it again to update; `sh -s 0.2.0` picks a version;
`TLPT_INSTALL_DIR` and `TLPT_NO_MODIFY_PATH=1` change where it goes and leave your startup file alone.
Windows and Alpine use npm. `tlpt --version` says which you have. To remove it, delete
`~/.local/bin/tlpt` and the `# tlpt` lines from your shell's startup file. With both an npm and a
native `tlpt` installed, whichever folder comes first on your PATH wins.

`npm install -g` fails with `EACCES` when npm's global folder belongs to root; use a Node version
manager (nvm, fnm, Volta) or set `npm config set prefix ~/.local`, rather than `sudo`. Update with
`npm install -g tlpt@latest`; remove with `npm uninstall -g tlpt`.

`tlpt`, `tp` and `teleport` are the same command. Two cautions about the long name: `npx teleport`
fetches an unrelated npm package (use `npx tlpt`), and Gravitational Teleport also installs a
`teleport` binary. Where that binary sits in npm's own global bin folder (Homebrew Node on an Intel
Mac, both in `/usr/local/bin`), npm refuses to install over it; use `install.sh`, which leaves a
name another program has alone, or `npx tlpt`. Elsewhere, whichever folder comes first in PATH
answers to `teleport`, and `tlpt` and `tp` are always this one.

## First run, step by step

1. Start teleport against your app. Any of these:

   ```sh
   tlpt 5173                       # a dev server on this machine, by port
   tlpt https://app.example.com    # a deployed app, by URL
   tlpt app.example.com            # a host: https is assumed
   tlpt ./dist                     # a folder of built files
   tlpt                            # find a dev server on a common port, or serve ./ if it has index.html;
                                   # else wait, and type the port in the console when you know it
   ```

   teleport serves or proxies the app with one `<script>` tag added to every HTML page, and prints
   the address to open on the device. Nothing changes in your app's code. Start it before or after your
   dev server: while nothing listens on a port on this machine, the console says so and the device gets
   a page that tries every 2 s and opens the app once it's up. A remote host that is wrong or down
   is said with its reason instead. `localhost` is tried on `127.0.0.1` and `::1`, whichever the
   server listens on. An app counts as up once it takes a connection, however slowly it renders.

   With no app at all, `tlpt` still starts. The device link opens a page that waits for an app, and
   two things end the wait: type the app's port (or an address, or a folder) in the console's input
   and press Enter, or start a dev server on a common port, which tlpt looks for every 2 s and serves
   on its own. Either way the device opens the app within 2 s, with nothing pressed on it. Typing
   another port later switches the app: devices reload into it, a tunnel taken for the old app goes
   back to it, and one already running for the new port is taken over, as `tlpt <port>` does.

2. Open that address on the device, in its browser or as your app's URL. The agent in the page
   connects back. Nothing shows on the device's screen: the agent is invisible, and it never throws into
   the app or writes to its console. (`data-badge="on"` on the script tag adds a small square in a
   corner, lit while the laptop is connected; see [bundling](#bundle-the-agent-into-your-app).)

3. The device appears in the [console](#the-console) at the bottom of your terminal, with its main
   thread, heap and key → frame live. Chrome DevTools opens on your laptop, attached to that page.
   Elements, Styles, Console, Network, Sources and Performance work. `d` opens it again, for
   whichever device ↑↓ picks. Each device's line in the console has its own DevTools link.

4. The bottom line of the console is an input, always open: type a command's name, or its letter,
   then Enter. `r` drives the device from your keyboard, `c` captures, `t` lists things to
   [try](#try), `s` surveys the device and saves a report, `d` opens DevTools, `e` lists what the
   page threw, `h` lists every experiment run so far. The list on the left is five groups:
   measure, experiment, video, input and inspect; `→` or Enter opens one. Every experiment is kept
   in a [journal](#every-experiment-is-kept-the-journal). Nothing needs a second terminal, though
   the same commands run by name from one:

   ```sh
   tlpt status
   tlpt errors
   tlpt probe media
   tlpt capture 10
   tlpt survey
   tlpt remote
   tlpt trial examples/trials/promise-polyfill.mjs
   ```

   `tlpt q <command>` is the same thing, as scripts and AI agents have written it. A folder that
   shares a command's name is served as `./name`.

Try it with no device: `npm run dev` in a checkout serves `examples/hello-device`, a small ES5 app
that moves focus with the arrow keys. Open its device link in a desktop browser.

### Flags

`tlpt --help` fits one screen: the usage, every command in one list, the forms an app can take, the
flags and the environment variables. `tlpt <command> --help` explains one command in full.

| Flag | Default | |
|---|---|---|
| `--port <n>` | `7070` | Where tlpt listens. The device link, `tlpt q` and `tlpt mcp` use it; `TELEPORT_PORT` sets it for those two. |
| `--host <address>` | every interface, IPv4 and IPv6 | One interface to listen on instead. `127.0.0.1` keeps every device out. |
| `--via <address>` | | The address the device opens, such as `https://device.example.com`, when it reaches tlpt through your own proxy or port forward. See [your own proxy](#behind-your-own-proxy-or-port-forward). |
| `--no-open` | | Don't open DevTools when a device connects; `d` opens it. |
| `--insecure` | | Trust any certificate the app's https server presents. |
| `--manifest <path>` | | A launcher's JSON manifest, such as `/app.json`: tlpt adds the agent first in its `files`. See [Apps started from a manifest](#apps-started-from-a-manifest). |
| `-v`, `--version` | | The version. |
| `-h`, `--help` | | The help screen. |

## The console

The terminal `tlpt` runs in is a console. It draws one region in place, with no alternate screen,
from top to bottom:

- **The header**, pinned: `◎ teleport → <app>`, then `open on the device <url>`, the one address to
  open on the device. When tlpt serves no app, it shows the line to add to the app instead. Under
  it, a card for each device (three at most): a dot for its state, green while it samples, amber
  while it is quiet a few seconds, connecting or reloading, red once it has stopped or gone; its
  id and state (`live`, `quiet 4 s`, `reloading 7 s`, `gone 12 s`); its platform and engine; its
  screen, cores, memory and heap limit; and its address. The screen and cores are read once for
  each kind of device, 3 s after it connects, with one small script.
- **A window on the event log.** Lines about what happened go into a log kept on the laptop (the
  last 2,000), and the console shows the newest of them in the rows the region leaves. It never
  grows the terminal's scrollback, however long the session runs. Page Up and Page Down scroll it
  (while no long answer is open on the right), a line says how many newer lines are below while you
  are scrolled back, and Esc returns to the newest. On quit the region is erased and the last 200
  log lines are left in the terminal as plain text.
- **Two columns.** On the left, everything tlpt can do, as five groups. On a terminal with the
  rows for it (43 or more) every group stays open, so each entry and its letter is on screen; on a
  shorter one a single group is open and each closed one names what is in it. The groups:
  **measure** (how the app runs on the device as it is), **experiment** (change one thing and
  measure both ways), **video**, **input** (the remote) and **inspect** (DevTools, errors,
  requests, the device). A closed group names its entries, or what needs a look in it: the page's
  errors, the last key pressed, DevTools open, a portal while something in it runs. The open
  group's entries each have their letter, and beside them what they show now: a portal turning
  while it runs on a device, whoever started it; the clock time it last ran (`14:02`), with `✗`
  when that run failed, which stays put rather than counting up; the last key pressed on the
  device beside remote (amber when nothing drew after it); the page's error count beside errors.
  On the right, an explorer of what is highlighted, never a manual: for a group, its entries and
  its latest runs; for an entry, while it runs, a beam between two portals filling with its
  progress (a capture's seconds and live fps, a trial's runs); its runs this session, whoever
  asked (this console, `q` or an AI agent over MCP); and what it shows now (see below). Page Up
  and Page Down scroll a long answer. `?` adds what the entry does, how to type it and what it
  costs. The list scrolls with the highlight on a short terminal, and drops what each shows below
  80 columns.
- **The device rows**, one per device, under the columns.
- **The input**, always open, with what Enter does next on the right. When the first device
  connects the highlight moves to `remote`, so Enter drives it: driving the device to the screen
  you came to look at is what comes first. Once a key has been pressed the highlight is yours, and
  nothing moves it.
- **The keys**, on the last line: the ones that act now, each on a plate with a word for what it
  does. With nothing typed they are the list's and the letters most used, in the order a session
  goes (remote, capture, try, errors, DevTools); while a line is typed,
  the input's; in remote mode, the remote's. A narrow terminal keeps the first of them and `?`
  and `^C`; under 20 rows the line is left out.

Until a device connects, the right side says how to get one, in its middle: what is waited for,
the address to open, and the keys that work meanwhile. The line under the list says it instead
while something else is open on the right.

```
  ◎ teleport  → localhost:5173
  open on the device  http://192.168.1.20:7070/
  devices             ● k3x9q2ab live  Linux · Chrome 63  1920×1080 · 4 cores · heap 512 MB  192.168.1.42
                      ● p7m2d4cf quiet 4 s  Android · Chrome 53  1280×720 · heap 512 MB  192.168.1.43
● k3x9q2ab connected · Linux · Chrome 63 · 192.168.1.42
  ⎿ DevTools opening in your browser · http://localhost:7070/__teleport/Kq3xT9b2Lm/d/k3x9q2ab
▲ p7m2d4cf key ↓ took 612 ms to the next frame
  ⎿ 540 ms in the page's key handlers · focus landed on div.tile in #rail-trending
───────────────────────────────┬───────────────────────────────────────────────────────────────────
  measure                      │ capture  fps and key → frame                           on k3x9q2ab
  › c capture  ◉               │
    s survey     14:02         │ ◎━━━━━━━━━━━━✦┈┈┈·┈┈┈·┈┈┈·┈◎  4 s of 10 · 58 fps
    p probe                    │ on k3x9q2ab · press keys on the device now
      styles                   │
      advise                   │ 14:02 ✓ capture 10 · 10.4 s
      report                   │
    h history                  │
  experiment   try trial eval… │
  video        playback verify │
  input        ↓               │
  inspect      2 errors        │
───────────────────────────────┴───────────────────────────────────────────────────────────────────
› ● k3x9q2ab Linux     main ▁▁▂▁▁▁▁▁▁▃▁▁▁▁▁▁   0 ms   heap 212/512 MB   key ↓ 41 ms   DevTools
  ● p7m2d4cf Android   main ▃▅█▆▂▇█▅▃▆█▇▅▆█▇ 640 ms   heap 446/512 MB   2 errors   key ↓ 180 ms
  > ▏  enter captures 10 s                                                        on ● k3x9q2ab
```

A notice (`a capture is running on k3x9q2ab`) shows on the input's line for a moment. Quitting is
Ctrl+C, as everywhere.

What the right side shows of each entry:

| Entry | Shows |
|---|---|
| a group | Its entries, each with its letter, what it does and when it last ran, and the group's latest runs. |
| `probe` | Every probe, `✓` with the clock time once it has run (by anyone), `·` until then, and the last answer. |
| `capture` | The last capture; before one, the device's main thread, heap and last key now, from its samples. |
| `remote`, `keys`, `hear`, `keymap` | The remote: the presses the page saw, newest first, each with how long it took to a frame and where focus went, or `nothing drew` in amber when the app did nothing with it; and what each key sends here. See [Remote mode](#remote-mode). |
| `errors`, `network`, `device`, `devices`, `history` | Their answers, read again every 2 s while highlighted. They cost the device nothing: the laptop has it all. |
| `devtools`, `reload` | Each device: DevTools open or closed with its link; the page each has open. |
| the rest | Their runs this session and the last answer. |

**Each line in the log** starts with a mark that is its tone in a shape as well as a colour, so it
reads with `NO_COLOR` and to someone who sees red and green alike: `✓` (green) something came or got
better, `▲` (amber) something wants a look, `✗` (red) something failed, `●` anything else, and a
faint `·` for the routine.

**Each device's row** updates as its samples arrive, about once a second. All of it is data the laptop
already has, so watching costs the device nothing. Colour means something only when it appears: amber
past the first threshold, red past the second. Green is only a state, never a number: a device's dot
while it samples, and an app that answers.

| Shown | What it is | Amber / red |
|---|---|---|
| `›` | The selected device, when there are several. Keys and commands act on it; `↑` `↓` select. | |
| `●` | Green while the device is sampling. | silent 3 s / 10 s |
| `reloading 7 s` | A reload was asked for (`l`, a rebuild, `shim`, another app): the seconds it has left to come back. A device not back in 10 s is said in the log. | amber |
| `Linux` | The platform from the user agent, from 100 columns wide. The engine (`Chrome 63`) is the row's last cell. | |
| `main ▁▂█ 0 ms` | Main-thread time blocked in each of the last 16 seconds (8 below 100 columns): long tasks, or timer lag on engines without them. The number is the last second. | 50 ms / 200 ms |
| `heap 212/512 MB` | JS heap used, of the engine's limit. A page that runs out is ended with no error. | 70 % / 85 % |
| `key ↓ 41 ms` | The last key press (`left` and `right` in words, so they don't read as an arrow) and how long it took to reach the screen; `–` when no frame came. Faint after 10 s. | 50 ms / 100 ms |
| `DevTools`, `DevTools ×2`, `inspector on` | DevTools is open on it, or a command holds the inspector loaded. | |

Alert cells appear only while something is wrong, ahead of the rest:

| Alert | Means |
|---|---|
| `no sample for 7 s` | The device stopped sending. Its row would otherwise keep showing its last healthy second. |
| `full in 31 min` | The heap's floor is rising; at this rate it reaches the limit then. Red at 15 min or less. |
| `2 errors` | What the page threw since it loaded. `e` lists them. See [When the app throws](#when-the-app-throws). |
| `inspector shedding`, `inspector paused` | DevTools is costing the device enough that its inspector cut detail to protect it. See [What DevTools costs the device](#how-it-works-and-what-the-device-pays). |
| `DevTools 2 s behind` | DevTools messages are late: the link, not the app. |
| `rtt 180 ms`, `backlog 96 KB` | A slow or backed-up link to the device. |
| `video 4 dropped/s` | Frames dropped during playback. |

What doesn't fit the terminal's width is dropped from the end, the engine name first. A device that went
away shows `○ … gone 12 s` in red for a minute, with `DevTools waits 48 s more` counting down while
DevTools waits for it; one that is reloading shows `reloading · back within 6 s` in amber instead.

With no device, the line above the input is a status too: amber `waiting for a device` with the
address to open, amber `waiting for an app` while tlpt serves none, and red when something is plainly
wrong: `nothing answers at localhost:5173` (start the app), or `nothing has opened the link yet`
after a minute (same network? the port?). The device at the right of the input has the same dot.

**What is running** on a device, whoever started it (a capture, a trial's runs, a probe from an AI
agent), turns a portal beside its entry in the list, and opens as a beam on the right when that
entry is highlighted.

**The log** says what happened: a device connecting, reloading (`k3x9q2ab reloading · 10 s to come
back` when asked, then `reloaded in 1.6 s`), coming back after its link dropped,
or going away; DevTools closing (the row shows while it is open); the inspector shedding and
recovering; and every call from another shell or an AI agent over MCP that does something on the
device, with what it was and how long it took. The same thing again takes the
place of the line before it, with a count (`reloaded ×3`, `mcp probe media · 420 ms ×3`), so a device
that reloads in a loop or an agent that asks the same thing ten times stays one line. A command that
takes several steps (survey, advise) is one line. A few lines appear only past a
threshold, so the log stays readable:

- the first three errors of each page load, with the source at the column and a hint; past three, a
  page that keeps throwing gets one line a minute with its count;
- console messages or network events the inspector left out, and how many;
- a failed request (status 400 or more, or no response), at most one per path a minute;
- a key that took 300 ms or more to reach the screen, with where the time went;
- the main thread blocked 1 s or more, and a device that stalled for 5 s;
- the heap at 85 % of its limit;
- a page that loaded through teleport but whose agent never connected (a firewall or a content
  security policy).

### Keys

The arrows move through the list. On a group, `↑` `↓` move between groups and `→` or Enter opens it
onto its first entry; in a group, `↑` `↓` move through its entries and on to the next group, and
`←` backs up to the group. Enter on an entry that takes a word (probe, try, keys, trial, replay,
shim, eval) starts its line in the input and lists the values on the right; the rest run with
their defaults on the selected device, or the only one. Typing works as well: a letter alone, then
Enter, runs its entry, and as a name is typed the list shows only the entries it matches, under
their groups.

| Type, then Enter | Does | Costs the device |
|---|---|---|
| `t` | Lists what there is to [try](#try): one thing flipped, measured both ways. A toggle's own name (`shadow`) or a codec's (`hevc`) tries it. | A frame over the app for each run |
| `c` | Captures 10 s, then opens fps, frame times, long tasks, timer lag, key → frame, heap and requests on the right. Press keys on the device meanwhile. | Records every animation frame for 10 s |
| `s` | Surveys the device: the probes, a 10 s capture, playback and styles, saved with a report and advice. | The probes and a 10 s capture |
| `r` | Remote mode: the keyboard is the remote. Arrows move, Enter or Space is OK, Backspace is Back, digits are digits. `c` captures the presses you make, `m` maps a key. Esc or `r` leaves. See [Remote mode](#remote-mode). | The page's key handlers run; a key listener while the mode is on |
| `d` | Opens DevTools for the device and prints its link. | Loads the inspector while DevTools is open |
| `l` | Reloads the device's page. | A reload |
| `p` | Lists the probes, each with what it answers and costs. | The probe you pick |
| `e` | What the page threw since it loaded. | Nothing |
| `i` | The device's last minute: main thread, heap and key → frame as sparklines, the heap's trend, key → frame by focused element, link and requests. | Nothing |
| `n` | Its last 20 requests through tlpt. | Nothing |
| `h` | Every experiment kept for this kind of device, newest first. See [the journal](#every-experiment-is-kept-the-journal). | Nothing |
| any command | `capture 5`, `probe media`, `try css "…"`, `trial file.mjs`: the line runs as `tlpt <line>` does in a shell. | What the right side says |

| Key | Does |
|---|---|
| `↑` `↓` | With nothing typed, move through the list, round at the ends. Typing, move through the matches or the values on the right. |
| `→` `←` | Open the highlighted group; back up from an entry to its group. On an entry, `→` says arrows drive the device in remote mode. |
| Enter | Opens the highlighted entry, or runs the line typed. |
| `?` | With nothing typed, the keys and what each cell of a row means, on the right. |
| Tab, Shift+Tab | With nothing typed, select the next or the previous device. Typing, Tab completes the word. |
| Page Up, Page Down | Scroll a long answer on the right; with none open, the log's window. |
| Esc | Clears what is typed, closes the `?` side or leaves remote mode, and returns the log and the answer to their top. Twice stops a trial you started here, after its current run. |
| Ctrl+C | Clears what is typed; with nothing typed, quits (a second Ctrl+C doesn't wait for anything). A tunnel tlpt took over goes back to your app first. |
| Ctrl+Z | Suspends to the shell; `fg` resumes. |

Colour and media keys aren't in remote mode; type `keys red` or `keys play`. Presses from the
laptop, in remote mode, `keys` or a trial, run the page's key handlers from the agent rather than
through the device's own key input, so their key → frame reads a little lower than a real press on
the device.

### Remote mode

The right side becomes the remote: a d-pad with the last key lit, the presses sent, and what the
page heard, a line each, named. The page is listened to while the mode is on (`hear`, below), so a
press on the device's own remote or controller shows too:

```
remote  this keyboard is the remote                                              on k3x9q2ab

      ↑         arrows move · enter ok
   ←  ok  →     ⌫ back · 0-9 digits
      ↓         c captures · esc leaves

sent   → → ok
  ⎿ sent    Enter       Enter 13      ok    clicked
    sent    arrow left  ArrowLeft 37  left  focus → div.tile
    device  gamepad A   GamepadA 195  ok    taken · page changed

ok sends GamepadA 195 · back Escape 27
```

Each line says who pressed (`device`, or `sent` from here), what the key is, the key and key code the
page got, the remote key it stands for, and what the page did: `taken` (it cancelled the key),
`clicked`, `focus → …`, `page changed` (its DOM changed within 150 ms), or `nothing changed`.

A sent key is not trusted, so the browser does nothing of its own with it. OK therefore does what a
real Enter does by default: keypress, then a click on a focused button, link, summary or submit,
unless the page cancelled the key. An app that waits for its buttons to be clicked works from the
laptop as it does from the remote.

A device whose own remote sends a key differently (a controller's A on Windows is `GamepadA` 195, not
Enter 13) is heard doing so, and the remote sends that key from then on, for every device of that
platform: `ab12 sends ok as gamepad A` says when it learns one. A controller the page reads through
the Gamepad API types no keys at all: its buttons show as `button A` with `Gamepad API: no key event`.

To map a key by hand, press `m` in remote mode, then the key to change (Enter for OK), then either
the button the app answers to on the device's own remote, or its key code typed and Enter. From a
shell, `tlpt keymap ok 195` or `tlpt keymap ok GamepadA`; `tlpt keymap ok reset` undoes it, and
`tlpt keymap` lists what each key sends. What is learned or mapped is kept per platform in
`~/.config/teleport/keys.json`; `hear --forget` forgets a platform's. When OK does nothing on the
app, the remote side says so (`nothing drew`): either the app needs another key (map it), or its
OK handler is what to fix.

### The list

Everything is in five groups: `name` here is `tlpt name` in a shell and the `name` tool over MCP
(remote, devtools and reload are for a person, so they are not MCP tools; `status` and `guide` are
for agents and scripts, so they are not in the list). Typing a command's words lists its values on
the right: probe names with what each answers, remote keys, what to try, replay's tapes, shim's on
and off, trial files under this folder, `--flags`, and device ids after `--id`. `↑` `↓` move; Tab completes
the word at the caret; Enter takes the highlighted value, and when it needs one completes it and
lists the values. Of the capture lengths offered (10, 5, 3), Enter runs the one you typed or moved
to, and with neither the default. The last line on the right says what the highlighted command
costs the device before you run it. Ctrl+W or Alt+Backspace deletes a word.

A mistake keeps your text in the input and puts the reason beside it (`✗ no command cpature · did
you mean capture?`, `✗ no device zzz · connected: k3x9q2ab`). A paste goes into the input as it
is, so a `tlpt …` line copied from here or from an agent runs. An answer opens on the right under
its entry; the log gets its first line.

### Not a terminal

Piped to a file or another program, or with `TERM=dumb`, tlpt prints the same event lines with the
time in front, no live region and no keys, so a log of a session reads top to bottom. DevTools
doesn't open on its own then; each device's DevTools link is printed instead.

`NO_COLOR` turns colour off and keeps the live console. `TLPT_ASCII=1` draws `*`, `` `- `` and
ASCII bars in place of `●`, `⎿` and `▁▂▃`, for fonts that lack them (it is on by default for the
Linux console and legacy Windows consoles). On a light background tlpt uses the terminal's own
foreground instead of its sage, which white would hide: the console asks the terminal its
background colour as it starts (OSC 11, at most 120 ms), and a command that prints and exits reads
`COLORFGBG` (rxvt, Konsole, some iTerm2 profiles). `TLPT_THEME=light` or `dark` settles it when
either is wrong.

Over SSH, tlpt doesn't try to open a browser on the far machine, and DevTools answers only on that
machine's localhost: forward the port (`ssh -L 7070:localhost:7070 …`) and open the link `d` prints.

## When the app throws

An app that throws while it starts often throws before DevTools opens, and the inspector that feeds
DevTools isn't loaded yet. So the agent listens itself, from its first line, with no DevTools: two
listeners on `window` (`error`, capturing, and `unhandledrejection`), which do nothing until the page
throws. It hears:

- uncaught errors;
- promise rejections nothing handled;
- scripts and stylesheets that fail to load.

It keeps the first 8 of a page load for good, since the first is usually the cause, and the last 8
after them, and counts the rest. Each is sent to the laptop when it happens and again when a link
opens, numbered, so the laptop takes each once. A reload starts a new count; a dropped link that
comes back doesn't.

The console prints the first three of each page load as they happen: what was thrown, where, and how
far into the page. When the file came through teleport, the line under it is the source at the
column, then a dashed line ending in `^` under the column. Then a hint, when the message alone
doesn't say what it means. Past three, the device's row counts them (`5 errors`) and the log says
the count once a minute. A DevTools opened later shows them too.

When the script's build left a source map (a `sourceMappingURL` comment naming a file beside it,
or holding the map itself), the place is the one in the code you wrote: `rail.ts:42:7` where the
engine said `app.js:1:48213`, with that line of your source under it. The laptop reads the map;
the device does nothing more. Only the place the error was thrown at is mapped, not each line of
its stack.

An error in teleport's own code (the tag it serves, anything else under `/__teleport/`, or
`@tlpt/agent` where a build's source map names the bundled agent) ends its line with `in teleport's
own code`, and its hint says so: then it is ours, not your app's, and your app's own code ran as it
would without teleport. The agent is ES5 with no dependencies, checked on every commit (`es-check`,
ESLint's `es-x` rules, and the compiler with only the ES5 and DOM libraries), and it loaded and
connected with no error, bundled as `@tlpt/agent` and as the tag, in real Chromium 38, 53, 64 and 68
(measured 2026-11-19 in a lab of those engines; a page that also ran a script none of them parse
had its error caught, so the check can see one).

To list them: `e` or `errors` in the console, `tlpt errors` in a shell, the `errors`
MCP tool (read-only), or `GET errors` in the [HTTP API](#the-http-api). The answer has the device's
`id`, `href`, `engine`, the `total` the page threw, and `errors`, each with:

| Field | What it is |
|---|---|
| `n` | Which error of this page load, from 0. A gap between two `n` is errors counted and not kept. |
| `atMs` | How far into the page, in ms on the agent's clock. |
| `kind` | `error`, `rejection` or `resource`. |
| `text` | The message, up to 300 characters; for a resource, `script` or `link`. |
| `src`, `line`, `col` | The file it was thrown in, or the address that didn't load. `''` and `0` when the engine didn't say. |
| `stack` | The engine's `error.stack` text, up to 600 characters. |
| `near` | `{ text, caret }`: the source around the column, when the file came through teleport; else `null`. Your own source's line when a source map gave it. |
| `from` | `{ src, line, col }`: the place in the code you wrote, from the build's source map; `null` without one. `src`, `line` and `col` above stay as the engine said them. |
| `hint` | What it most likely means, in a sentence; `null` when the message says it all. |

The hints:

| When | The hint says |
|---|---|
| A `SyntaxError` or another message that means the engine couldn't parse the file | None of the file ran and nothing it defines exists; most often syntax newer than the engine, and `tlpt q probe features` says what it has. |
| `is not defined`, `is not a function`, a read of `undefined`, after a script that never ran | Probably because of that earlier error (a script that didn't load or didn't parse), named by its number. |
| A script that didn't load | Nothing it defines exists, so code that uses it throws next; check that the device can reach that address. |
| `Script error.` with no file | A script from another origin threw and the engine hides what and where; load it through tlpt, or add `crossorigin` to its tag and CORS headers to its response. |
| A missing `requestMediaKeySystemAccess`, `serviceWorker`, `caches` or `crypto.subtle`, on a page opened over plain http from another machine | Probably because the page is not a [secure context](#secure-contexts-drm-and-service-workers), which an engine keeps those from; open the app over https. |

What it can't hear:

- errors before the agent's script runs, so teleport puts it first in the page;
- errors the app catches itself, and what it only logs with `console.error` (DevTools shows those);
- images that fail to load, which an app handles itself;
- rejections on engines without the `unhandledrejection` event (Chromium before 49);
- what and where, for a script from another origin loaded without CORS: only `Script error.`.

When the first error is a built-in the engine lacks (`Object.assign is not a function`), `shim on`
fills the common ones in ahead of the app, so you can see what it throws next without a rebuild.
See [Shim](#shim-past-the-errors-an-old-engine-throws).

## How the device reaches your laptop

The device only ever opens two WebSockets to teleport: the agent's, and the inspector's while DevTools
or a trial needs it.

**Which to run.** The app needs nothing added for the first three.

| Your setup | Run | The device opens |
|---|---|---|
| A dev server on this laptop, the device on the same network | `tlpt 5173` (its port) | the device link tlpt prints |
| The device must open your tunnel's address, and its tunnel agent has a local API on this laptop (port 4040), or it is a Tailscale serve or funnel | `tlpt 5173`, or `tlpt https://x.tunnel-free.app` | the same tunnel address: tlpt points the tunnel at itself while it runs, then back |
| Any other tunnel: cloudflared, localtunnel, bore, zrok, an `ssh -R` service | `tlpt 5173 --tunnel "cloudflared tunnel --url http://localhost:{port}"` | the address the command prints: tlpt runs it pointed at itself, and stops it on quit |
| A tunnel address tlpt can't take over (its agent elsewhere, or with no local API) | `tlpt https://x.tunnel-free.app` | the device link tlpt prints; tlpt fetches the tunnel address for it |
| An app you can't proxy (a packaged build, a fixed origin) | `tlpt`, with [the agent bundled](#bundle-the-agent-into-your-app) and started by the app | the app's own address, as usual |
| The device is on another network, behind your own proxy or port forward | `tlpt 5173 --via https://device.example.com` | the address you gave; see [your own proxy](#behind-your-own-proxy-or-port-forward) |
| An app started by a launcher page that reads a JSON manifest of scripts | `tlpt <app> --manifest /app.json` | the device link tlpt prints; see [launcher manifests](#apps-started-from-a-manifest) |

A tunnel's free plan may put a warning page in front of a browser. When tlpt fetches a tunnel address, it
sends the header that skips it, `<name>-skip-browser-warning`, named for the tunnel from its address
(x.<name>-free.app), which a device's browser can't. When the device opens the tunnel address itself, the
page comes from the tunnel before tlpt sees the request: press Visit Site once on the device, or, when
the device is on your network, open the LAN address the console's tunnel line gives.

Five ways to get there:

**Same network.** The default. teleport listens on port 7070 of every interface and prints its LAN
address. The device opens that address. Change the port with `--port`; `--host` names one interface.

**Through a tunnel.** If the device must open a public address (a packaged app that points at a
tunnel, a device on another network), point the tunnel at teleport's port and name the app's local
address: `tlpt localhost:5173`. The pages, scripts and JSON the app serves have their own
addresses rewritten to the one the device used, so the device keeps the tunnel's address throughout. With a
tunnel agent that has a local API running on your laptop, name either the tunnel's address or the app's and
teleport points the tunnel at itself for as long as it runs, then back.

**Any tunnel vendor.** Two ways cover them all. A vendor whose running tunnel can be re-pointed in place,
keeping its address, has an adapter: a tunnel agent's local API (port 4040) and Tailscale (`serve` and
`funnel`, through its CLI). An adapter lists the tunnels on this machine and moves one; each is about
30 lines in `tunnel.ts`, and tlpt asks them all at once, so naming the app's port is enough whichever
runs. Any other vendor runs through `--tunnel "<its command>"`: tlpt starts the command with `{port}`
replaced by its own port (or the port added last), takes the first `https://` address it prints as
the device link, and stops it when tlpt quits. No shell runs it; the words are split as a shell would,
quotes grouping. Examples:

```sh
tlpt 5173 --tunnel "cloudflared tunnel --url http://localhost:{port}"
tlpt 5173 --tunnel "npx localtunnel --port"
tlpt 5173 --tunnel "ssh -R 80:localhost:{port} serveo.net"
```

A quick tunnel's address is new each run; a named tunnel's command keeps one.

**Through your dev server.** If your dev server proxies `/__teleport/` to teleport's port, the device
needs only the dev server's address: the agent and inspector connect under `/__teleport/ws/`, and
teleport still serves them. DevTools and the API stay on teleport's own address, under its
[key](#security), which nothing the dev server passes on can have.

**Bundled into your app.** See [Bundle the agent into your app](#bundle-the-agent-into-your-app). The
app starts the agent itself, with your laptop's address or with none.

**From a launcher manifest.** See [Apps started from a manifest](#apps-started-from-a-manifest).

### Behind your own proxy or port forward

A device on another network reaches tlpt through something of yours: a reverse proxy, an ssh or
TCP port forward, a cloud load balancer. Point it at tlpt's port, and name the address the device
opens:

```sh
tlpt 5173 --via https://device.example.com
```

The device then opens `https://device.example.com/`, and everything it loads and both of its sockets
go through your proxy to tlpt. Pass WebSockets through, as the agent and the inspector each open
one. Nothing else changes: DevTools and `tlpt q` stay on the laptop.

`--via` is what tlpt needs when the proxy doesn't say where a request came from. A tunnel
says it in headers (`X-Forwarded-Host`, `X-Forwarded-Proto`), and tlpt reads them. A proxy
that ends TLS or rewrites `Host` and adds no such header, as nginx does until told otherwise,
leaves nothing in the request to read: tlpt would take the device to be at `http://localhost:7070`
and rewrite your app's own links to that. With `--via`, the address is the one you gave, for every
request. The proxy adds latency to each request the device makes, so compare a trial's or a
capture's numbers with others taken through the same route.

### Secure contexts: DRM and service workers

An engine keeps some APIs for a secure context: a page over https, or one on the machine itself.
A device that opens `http://192.168.1.20:7070/` is in neither. What it loses depends on the engine:
service workers and the Cache API always, DRM (`requestMediaKeySystemAccess`) since Chromium 58,
`crypto.subtle` since 60. In Chrome 157, the same page reads `secure context: no` with no key
system to ask over the LAN address, and `yes` with ClearKey over loopback. On Chromium 38 none of
this applies: it has no unprefixed DRM to keep back.

tlpt says so where it matters. `tlpt q probe media` notes when the key systems read as unknown
because the page isn't a secure context, so "no DRM here" isn't taken for the device's answer, and
an error for one of those APIs gets a hint naming the cause.

To give the device a secure context, it has to open an https address. tlpt serves plain http, and
a certificate of its own would be one no device trusts. So https comes from in front of it: a
tunnel (`tlpt 5173` takes yours over), or your own https proxy with `--via`.

### Bundle the agent into your app

```sh
npm install @tlpt/agent
```

```js
import teleport from '@tlpt/agent';

teleport.init({ url: 'ws://192.168.1.20:7070/ws/target' });   // the teleport at this address
teleport.init();                                              // or the one that served this page
```

It ships asleep: no buffers, timers or sockets. Importing it does nothing, in any build, and
nothing in the page's address or storage wakes it. Your app starts it, behind whatever switch you
like: a debug menu, a build flag, a key sequence. Then run `tlpt` with nothing else: it waits for
the app, and its header shows the `init` line with your laptop's address filled in.

With no address, `init()` looks only at where the page came from:

| The page came from | It reports to |
|---|---|
| this machine or a private network address, over http | teleport on that host, port 7070 (or `window.TELEPORT_PORT`) |
| anywhere else, such as your app's own tunnel, or any https page | the page's own address under `/__teleport/`, which your dev server passes on to teleport |
| no host (a file, a packaged app) | nowhere: it stays asleep, so pass `url` |

The agent runs what teleport sends it, which is how `eval` and DevTools work. So it listens only
to a host your code named or the host that served your app, never to one a link names.
`teleport.stop()` puts it back to sleep.

The script tag teleport injects takes the same shape by hand:

```html
<script src="http://192.168.1.20:7070/teleport.js"
        data-focus=".focused,[aria-selected=true]"   <!-- how your app marks the focused element -->
        data-key-phases="off"                          <!-- skip the per-key style/layout/paint probe -->
        data-badge="on"></script>                      <!-- a square on the device's screen while connected -->
```

`data-focus` matters: an app driven by arrow keys often marks focus with a class, not DOM focus, so
without it key → frame is grouped by whatever `document.activeElement` is, usually `body`. The default selector is
`.focused,.focus,.is-focused,.selected,[data-focused="true"]`.

### Apps started from a manifest

Some apps start from a launcher page that fetches a JSON manifest and injects each script in its
`files` list, so the HTML teleport could add its script tag to never passes through it. Name the
manifest's path with `--manifest`:

```sh
tlpt 5173 --manifest /app.json
```

When the device fetches that path through teleport, teleport adds the agent's address first in
`files`, so the launcher loads the agent before the app's own scripts. A manifest that isn't JSON or
has no `files` array passes through unchanged. This works when tlpt proxies the app (a port or a
URL), not when it serves a folder.

## What works in DevTools

| Panel | Works | Doesn't |
|---|---|---|
| Elements | Tree, select, edit attributes and text, move and delete nodes, search, hover highlight on the device, pick on the device with Enter on the remote, `$0` in the console | Shadow DOM, pseudo-elements |
| Styles | Matched rules in cascade order with specificity, inherited, inline, computed; edits apply live on the device | Keyframes, `@property`, font listing, animation inspection |
| Console | Everything the page logs with object previews and expansion, uncaught errors and rejections, the REPL with `$`, `$$`, `$0`, `keys`, `values`, autocomplete | Stack traces (the engine's `error.stack` text is shown as is) |
| Network | Requests the page makes while open (XHR and fetch, with bodies up to 1 MB), earlier ones from Resource Timing, every request teleport served with bodies and timing | WebSockets, requests over 1 MB, binary bodies |
| Sources | The page's scripts and stylesheets as resources; DevTools' workspace question is answered with the served folder, so edits can save to disk | Breakpoints, stepping (no Debugger domain) |
| Performance | Record gives a trace built from the agent's records: frames, long tasks, timer lag, key presses with input delay, handlers, rAF, style, layout and paint, requests | Chrome's internal tracing, flame charts of your functions |
| Application | localStorage, sessionStorage | IndexedDB, cookies, service workers (the `storage` probe reads those) |
| Memory | `Runtime.getHeapUsage` where the engine has `performance.memory` | Heap snapshots |

This is Chrome's own DevTools frontend, served by tlpt from this machine and opened as a tab in your
default browser. It is not DevTools for one of your browser's own tabs, so the panels your DevTools
extensions add (React Developer Tools, Redux DevTools, Vue Devtools) don't appear in it: Chrome gives
extension panels only to the DevTools it opens for its own tabs.

DevTools stays attached when the device reloads, when the tab navigates, when a tunnel drops the link
for a minute, and when the laptop sleeps. A reload is a new page, as in Chrome; a dropped link that
comes back is the same page, and nothing is lost. The console is recorded only while DevTools is
open, and a line in it says where the gap was.

## Asking the device: `tlpt q`

`tlpt <command>` and `tlpt q <command>` are the same; this section writes the `q` form, which
scripts, the plugin's skill and AI agents use. One command per question. In a terminal the answer is printed for a person, as in the console;
piped, or with `--json`, it is JSON, which is what scripts and AI agents read. `tlpt q <command>
--help` explains one command, with what it costs the device. The same commands are MCP tools and the
console's list. `--id <device>` picks a device when several are connected (ids from `status`); the
newest otherwise, and a person's answer names the device it came from. `--port` names teleport's port,
or set `TELEPORT_PORT`. A flag's value can follow it or an `=` (`--port 7070`, `--port=7070`).

In a terminal, the commands that wait on the device (`capture`, `probe`, `styles`, `trial`, `keys`, `hear`, `eval`) show a
spinner on stderr. Ctrl+C stops waiting; a trial then stops on the device after its current run. A
mistyped command or flag gets a suggestion (`tlpt: no command cpature; did you mean capture?`).

| Command | What it answers |
|---|---|
| `status` | Each device: id, engine (from the user agent), address, whether DevTools is open, the latest second. |
| `devices` | The connected devices, each with its latest 1 Hz sample and link health. |
| `device [--seconds n]` | One device: the last `n` seconds of samples (60 by default), key → frame per focused element, link health, the last 50 requests. |
| `errors` | What the page threw since it loaded, with no DevTools needed. See [When the app throws](#when-the-app-throws). |
| `network [--url part] [--min-ms n] [--failed] [--limit n]` | The device's requests through teleport: method, URL, status, bytes, start (page time), time to first byte, duration. |
| `capture [seconds]` | Records every animation frame and key for up to 10 s and reports: fps, frame-time p50/p95/p99, frames over 33 and 50 ms, long tasks, timer lag, key → frame, the slowest resources, a vsync lattice. Press keys on the device during it if input matters. If the page goes away during it (a reload, a link), it ends then and says it was cut short. |
| `probe <name>` | What the engine can do, asked on the device. See [Probes](#probes). |
| `styles` | What the device's engine drops from the app's style sheets: selectors it can't parse, which lose the whole rule, and declarations it doesn't know, each with the file and line it is first on and how often it is used. The laptop reads the sheets itself and asks the engine only about each distinct selector and declaration. |
| `guide [words]` | What is worth trying on a device, for agents. See [The guide](#the-guide). Answers without a device. |
| `trial <file>` or `trial --spec <json>` | Runs a trial and compares its variants. See [Trials](#trials). |
| `keys <k> <k> ...` | Presses remote keys on the device in order: `up down left right ok back 0-9 red green yellow blue play pause stop rewind forward`. Key codes follow the device's platform, read from its user agent, or what its own remote was heard sending. `ok` does what a real Enter does by default: a keypress, then a click on a focused button or link the page didn't cancel. |
| `keymap [key] [code]` | What each remote key sends on this kind of device, and which were set by hand or heard. With a key and a code (`keymap ok 195`, `keymap ok GamepadA`), that key sends it from now on, for every device of the platform; `reset` puts it back. |
| `hear [seconds] [--forget]` | Listens in the page (10 s by default, up to 60) and names every key press and controller button it hears: which remote key it is, whether the device or teleport pressed it, and what the page did with it. A key the device sends differently from teleport (a controller's `GamepadA` 195 for OK) is kept for that platform and sent from then on; `--forget` forgets them first. See [Remote mode](#remote-mode). |
| `eval <es5>` | Runs an expression in the page and returns its value. The engine may be ES5 only. |
| `playback` | What is playing now: each video and audio element, the player library (Shaka, hls.js, dash.js, video.js) with its tracks, stats and DRM, the title, and the manifest's ladder, read on the laptop. Then the risks: codecs the device refused, codec switches it can't make, a ladder above the screen. |
| `survey [label] [--verify] [--speed]` | Everything at once, saved under `~/.local/share/teleport/devices/<model>/<time>-<title>/`: every probe, a capture, the network log, errors, dropped CSS, the playback read, the player's live configuration (licence servers and headers reduced to names), and every request the page made according to the engine's resource timing (query values dropped). Writes `raw/*.json`, `advice.json`, `README.md` and `report.html`. Storage values, tokens and signed URLs are blanked. |
| `try [what...] [--runs n] [--keys k,k]` | Flips one thing and measures it both ways, with nothing to write; see [Try](#try). |
| `replay [save name \| name \| last] [--seconds n]` | Keeps a journey through the app with the remote, and presses it again in its rhythm while capturing. See [Replay](#replay-a-journey-pressed-again). |
| `shim [on \| off]` | Fills in the built-ins an old engine lacks, ahead of the app's own scripts, to see past one error to the next. See [Shim](#shim-past-the-errors-an-old-engine-throws). |
| `history [--limit n] [--all]` | Every experiment kept for this kind of device, newest first: when, what ran, who asked, how long, a line of its answer. See [the journal](#every-experiment-is-kept-the-journal). |
| `verify [only...]` | Plays short real clips in a frame over the app: which codecs actually play, not just what the engine says, and whether codec and resolution switches survive. Each clip is 2 s with the clip's name in its corner, so a switch shows on screen: three pixel aliens trudge to a portal in grainy black and white, then it floods the screen with colour and they dance in sunglasses at a disco. Audio is a warbling tone. |
| `advise [from]` | Advice for the app on this device: must, should, could. Each item has what was measured, examples (the requests, settings or elements), what to change, a patch where one applies (for example a `player.configure` call), and how to prove it. Reads a saved survey, or measures live. |
| `report [from] [--md] [--list]` | Rebuilds `report.html` and `README.md` for a survey from its raw answers, so new advice rules apply to old surveys. |

Every sample value is `null` where the device's engine can't measure it (no `performance.memory`, no
`longtask` observer, no Resource Timing sizes), never guessed.

A sample, as `device` returns it, once a second:

```
t              agent clock, ms           lagMs          how late the 1 Hz timer fired: the main thread was busy
longTasks      tasks over 50 ms          longTaskMs     their total
heapMB         JS heap used              heapLimitMB    the engine's limit; running out ends the app silently
keys           presses this second       keyToFrameMs   slowest press → next frame
fps            during a capture only     frameP95Ms     during a capture only
resources      Resource Timing entries   resourceKB     their transfer size
videoDecodedPerS / videoDroppedPerS      per video element, where the engine counts frames
domNodes       elements, every 5 s       overheadPct    the agent's own share of the main thread
inspectorPct   the inspector's share     inspectorQueuedKB / agentQueuedKB   bytes waiting on the device's sockets
level          inspector governor: 0 normal, 1 shed, 2 survive
```

## Try

`try` flips one thing on the device and measures it both ways. There is no file to write.

```sh
tlpt try                 # what there is to try
tlpt try shadow          # box-shadow on every tile, against none
tlpt try transform       # the rail moved with transform, against with left
tlpt try css "* { box-shadow: none !important }"    # your own app, with and without these rules
tlpt try js "for(var i=0,a=[];i<1e5;i++)a.push({i:i})"   # your own code on a blank page, timed
tlpt try html "<div style='-webkit-filter:blur(4px)'>card</div>"   # your markup, keys pressed
tlpt try hevc            # play real HEVC clips; codec plays them all
```

A toggle (`transform`, `will-change`, `layers`, `shadow`, `radius`, `gradient`, `blur`, `opacity`,
`scale`, `dom`) is a ready-made trial: a rail of 40 tiles moved with the remote's keys, once without
the thing and once with it, 5 runs each, alternating. Both sides are the same page but for the
toggle, so the report's clear differences are what that one thing costs on this engine. `css` runs
in your app's own page: as it is, then with the rules added, pressing the same keys; the rules are
taken out after each run. `js` runs your ES5 on a blank page in a fresh frame each run, against
the blank page alone: what the code itself costs this engine, with nothing of the app in the way.
`html` draws your markup on a blank page against the rail of tiles, the same keys pressed on both:
what drawing and moving it costs. `--keys down,down,up,up` presses other keys, and `--runs` changes
the count. A codec's name (`hevc`, `h264`, `vp9`, `av1`, `aac`, `ac3`, `drm`, `switch`), or `codec` for
all of them, plays the clips `verify` plays. The answer is a trial report, read the same way. In the
console, `t` then Enter lists the toggles, and a toggle's name alone (`shadow`) tries it.

## Trials

A trial tries a few variants on the device, several times each, and compares them. Each run gets a
fresh blank frame over your app (or runs in the page, with `where: 'page'`), so a polyfill or a
player loaded for one variant never reaches the app or the next run. Runs alternate A B, B A, ... so
a drift in the page never reads as a difference. Every run is profiled the same way without being
asked, and a `measure` adds numbers of its own. The report gives each variant's medians, p95, min
and max; every metric's difference against the first variant with a bootstrap 95% interval; and
notes in words: what a clear difference means on a device, what the engine couldn't measure, a heap
that grew in every run, uncaught errors.

```sh
tlpt q trial examples/trials/focus-ring.mjs
tlpt q trial examples/trials/promise-polyfill.mjs
tlpt q trial --spec '{"variants":[{"name":"a"},{"name":"b","html":"<img src=\"/poster.avif\">"}]}'
```

A trial is a `.json` file, or a `.mjs` file whose default export is the spec. Functions in a `.mjs`
spec are sent as their source. Everything inside runs on the device, so it is ES5.

### The spec

| Field | Type | Default | Meaning |
|---|---|---|---|
| `name` | string | `"trial"` | Shown in the report. |
| `variants` | array, 1 to 8 | required | What to try. Each: `name`, `html`, `scripts`, `before`, `setup`, `vars`. |
| `html` | string | `""` | Written into the frame's body first. Variant `html` is appended to the trial's. |
| `scripts` | string[] | `[]` | Loaded in order before `setup`: asset names (see `assets`), paths on the app's server, or http(s) URLs. Trial scripts come before a variant's. |
| `before` | ES5 | `""` | Runs in the frame before its scripts load, such as deleting a native global so a polyfill installs. |
| `setup` | ES5 | `""` | Runs after the scripts, before the window and the measure. Both receive `T`. |
| `vars` | object | `{}` | What the measure reads as `T.vars`. |
| `measure` | ES5 function body or `function (T) {}` | none | Your own numbers. Ends with `T.done({ metric: value })` or `T.fail(why)`. Without one, each run is watched for `observeMs`. |
| `observeMs` | 0 to 30000 | 2000 without a measure, 0 with | How long each run is watched after setup, while keys are pressed and the profile runs. Stretched to cover the keys. |
| `keys` | key names, up to 100 | `[]` | Remote keys pressed in turn during the window, as the device's platform sends them. |
| `keyGapMs` | 50 to 5000 | 400 | Between presses. |
| `checks` | `{ name: ES5 expression }`, up to 64 | `{}` | Read once on the device in a blank frame before the runs: the facts that say why. A Promise is waited for. |
| `runs` | 1 to 30 | 5 | Runs of each variant. |
| `timeoutMs` | 1000 to 60000 | 10000 | Per run; stretched past `observeMs`. |
| `assets` | `{ name: path or URL }` | `{}` | Files, folders and URLs the laptop serves to the device for this trial under unguessable paths, with CORS and byte ranges. A trailing slash serves a folder or URL prefix. Relative paths resolve against the trial file. |
| `better` | `{ metric: "lower" or "higher" }` | from the profile | Which way is better, for your own metrics. |
| `profile` | boolean | `true` | Measure the profile in every run. |
| `where` | `"frame"` or `"page"` | `"frame"` | A fresh blank frame over the page, or the page itself. |

The whole trial has 270 s to answer; past that it stops and says so. Variant `before`, `setup` and
`html` are added to the trial-level ones, so what every variant shares is written once.

### What `T` offers inside `before`, `setup` and `measure`

```
T.vars, T.variant, T.round     the variant's vars, its name, which round this is
T.now()                        performance.now() or Date.now()
T.heap()                       usedJSHeapSize, or null
T.asset(name[, path])          the URL the laptop serves an asset at (path under a folder asset)
T.load(url, cb)                adds a <script>; cb(null) or cb(reason)
T.frame(cb)                    cb(t) after the next painted frame
T.frames(ms, cb)               watches ms of animation frames; cb({ frames, fps, p95Ms, worstMs, over50 })
T.set(metric, value)           a number for the report, without ending the run
T.done([metrics])              the run is measured (the window may still be running)
T.fail(why)                    the run failed
T.cleanup(fn)                  runs when the run ends, before the frame is removed
T.log(text)                    up to 50 lines, returned with the sample
```

### The profile: what every run measures

| Metric | Unit | What a difference means on a device |
|---|---|---|
| `loadMs` | ms | Blank frame to variant loaded: its HTML, scripts and setup. |
| `scriptsMs` | ms | Fetching, parsing, compiling and running its scripts. Old engines compile slowly: bundle size and transpile target show here. |
| `frames`, `fps`, `frameP95Ms`, `frameWorstMs`, `slowFrames` | | Frames drawn while watched; over 16.7 ms a 60 Hz screen skips; the worst gap is the hitch a person sees. |
| `lagP95Ms`, `lagMaxMs` | ms | How late a 50 ms timer fired: keys wait as long. Works on every engine. |
| `longTaskMs`, `longTasks` | | Tasks over 50 ms, where the engine has a `longtask` observer. |
| `heapKB`, `heapDeltaKB` | KB | JS heap after the run, and what the run added. A device gives the browser far less than a desktop. |
| `domNodes` | | More elements make style and layout slower, and old engines most. |
| `layoutMs` | ms | One forced style and layout of the whole document: what each reflowing change costs. |
| `images`, `imageKB`, `imagesBroken` | | Image elements, their decoded size (width × height × 4), and ones that didn't decode (a format the engine lacks). |
| `resources`, `resourceKB`, `resourceMaxMs` | | Requests the variant made, bytes transferred, the slowest request. |
| `media`, `mediaDecoded`, `mediaDropped`, `mediaErrors`, `mediaError` | | Video and audio elements, decoded and dropped frames, errors (a codec the device refuses is `MEDIA_ERR_SRC_NOT_SUPPORTED`). |
| `keyHandlerMs`, `keyFrameMs`, `keyFrameMaxMs` | ms | Time in the page's key handlers, and key press → painted frame: what a person feels. With `keys`. |
| `errors` | | Uncaught errors the variant threw. |
| `profilerMs` | ms | Main-thread time teleport's own profiling took, so it is never mistaken for yours. |

### The report

```json
{
  "name": "promise polyfill",
  "device": { "id": "ab12", "ua": "...", "engine": "Linux · Chrome 63" },
  "checks": { "nativePromise": true, "microtasks": false },
  "variants": [{ "name": "native", "runs": 7, "ok": 7, "numbers": { "chainMs": { "n": 7, "median": 3.1, "p95": 3.4, "min": 2.9, "max": 3.5 }, "...": {} } }, { "name": "polyfill", "...": {} }],
  "compare": [{ "metric": "scriptsMs", "variant": "polyfill", "baseline": "native", "diff": 41, "lo": 33, "hi": 52, "better": "no", "text": "polyfill's scriptsMs median is 41 higher than native's (95% CI 33 to 52, 7 and 7 runs): worse" }],
  "notes": ["polyfill against native: scripts higher by 41 ms (95% CI 33 to 52, 7 and 7 runs), worse. Fetching, parsing, ...", "Not measured on this engine: long tasks (it has no longtask PerformanceObserver)."],
  "samples": [{ "variant": "native", "round": 0, "ok": true, "metrics": { "...": 0 }, "error": null, "uncaught": [], "ms": 2210 }]
}
```

`better` is `"yes"` or `"no"` when the interval excludes zero and which way is better is known,
`null` otherwise. `compare` needs at least 3 runs of each variant.

## Probes

`tlpt q probe <name>` runs ES5 on the device once and parses the answer on the laptop. Each probe says
what it costs the device.

| Probe | Answers | Costs the device |
|---|---|---|
| `identity` | Platform and user agent, screen and device pixel ratio, memory and cores where exposed, connection type, the page's address and referrer | Property reads and media queries |
| `features` | CSS features via `CSS.supports`, JavaScript syntax via `new Function` (arrow functions, `let`, classes, `async`, spread, optional chaining, template strings), APIs (`Promise`, `fetch`, `IntersectionObserver`, `requestIdleCallback`, Performance entry types, workers, WebAssembly, ...) and whether each is native or a polyfill | One forced layout |
| `media` | `MediaSource.isTypeSupported` and `canPlayType` per codec and container (H.264 levels, HEVC, VP9, AV1, AAC, AC-3, E-AC-3, Opus, FLAC), key systems with robustness levels (Widevine L1 to L3, PlayReady SL150 to SL3000), `getVideoPlaybackQuality`, picture-in-picture, HDR media queries | Key system requests wait on the device |
| `graphics` | WebGL and WebGL2 limits and extensions, the renderer string, AVIF and WebP decode, measured frame rate over 14 frames | Makes and frees two contexts, two 1 px decodes |
| `storage` | localStorage and sessionStorage entries with sizes, cookies, IndexedDB databases and stores, Cache Storage, service workers, quota | Reads every stored value, opens each database read-only |
| `dom` | Element count, depth, counts by tag, the largest and the widest subtree | Walks every node once |
| `focus` | The focused element, by DOM focus and by the focus class, with its box | Two selector queries and one box read |
| `speed` | How long four fixed pieces of work take, each the median of up to five runs: `js` (arithmetic and array work), `json` (stringify and parse of a 2,000-item list), `dom` (2,000 elements made, attached and removed), `layout` (200 forced layouts of 500 boxes). With `laptop`: the same `js` and `json` work timed on this laptop | Holds the page for a second or more, in a hidden frame of its own |

### How fast is this device: `probe speed`

`tlpt q probe speed` is a yardstick: the same four pieces of work on every device, so two devices,
or a device and an emulator standing in for it, can be compared by number.

```
● probe speed k3x9q2ab · 3581 ms on the device
  ⎿ js          15.7 ms · arithmetic and array work in script · 9.4 times this laptop
    json        13.1 ms · stringify and parse of a 2,000-item list · 18 times this laptop
    dom         27.9 ms · 2,000 elements made, attached and removed
    layout      3.2 s · 200 forced layouts of 500 boxes · 1 run
```

Each number is the median of five runs. Work that takes long gets fewer, and the line says how
many, so slow work doesn't hold the page for a minute. `times this laptop` is the device's time over
the same source timed in Node on the laptop as the probe is asked: how much longer your code takes
there than here, engine and chip together. The work runs in a hidden frame of its own, so the
app's styles don't reach it and its document is left as it was.

What it measured here, as somewhere to start from. An Apple M2 Pro; the Chromium 38 rows are the
real engine in a container under CPU emulation, not on a device:

| | js | json | dom | layout |
|---|---|---|---|---|
| Chrome 157 on the laptop | 2.1 ms | 0.8 ms | 1.5 ms | 28 ms |
| Chromium 38, x64 build, 1 CPU | 2.9 ms | 1.7 ms | 2.8 ms | 260 ms |
| Chromium 38, ARM build, 1 CPU | 15.7 ms | 13.1 ms | 27.9 ms | 3.2 s |

Medians of five probes each. A second run of the same differed by up to 0.6 ms on the numbers
under 4 ms and by under 3 % on the rest. Layout under ARM
emulation is far out of proportion to script; don't read a device's layout from it. To make an
emulator as slow as a device you have, run the probe on the device and turn the emulator's CPU
share down until its `js` matches. Hold that share in short periods: under Docker's own `--cpus`,
which deals time 100 ms at a go, the same work at half a CPU read 21 ms in one run and 31 in the
next.

## Every experiment is kept: the journal

Every experiment run on a device is kept on this machine, in one file beside the surveys:
`~/.local/share/teleport/journal.jsonl` (under `$XDG_DATA_HOME` when it is set). Captures, probes,
trials and tries, styles, evals, key presses, replays and surveys all land there, whoever ran them:
the console, `tlpt <command>` in another shell, or an AI agent over MCP. Each is one line of JSON:
when, the device's id, model and engine, the page's path (no query), who asked, what ran, how long it
took, the first line of an error, and the whole answer, scrubbed as a survey is (tokens, signed URL
parameters and secret-named fields blanked). An answer over 256 KB is kept as its size. A survey is
one line pointing to its folder, not a line for each step it took. Past 32 MB the file moves to
`journal.1.jsonl` and a new one starts.

```sh
tlpt history              # this kind of device, newest first
tlpt history --all       # every kind of device
tlpt history --json       # with the file and each line's fields
```

In the console, `h` lists them. `TELEPORT_JOURNAL=0` keeps none. Nothing in it leaves the machine.

## Replay: a journey, pressed again

`replay` keeps a journey through the app with the remote and presses it again later, in the same
rhythm, while it captures. The answer is a capture of that journey: fps, frame times, long tasks and
key → frame for each press, so a change can be measured on the same path before and after.

```sh
tlpt replay save home-to-player   # the presses the page saw in the last minute (--seconds for more)
tlpt replay home-to-player        # press them again and capture
tlpt replay last                  # the newest tape
tlpt replay                       # the tapes on this machine
```

A tape is the presses the device's page saw, from its own remote or from tlpt's (`r`, `keys`), each
with the pause before the next (held between 60 ms and 10 s), as remote keys: a press that is no
remote key is left out. Tapes are plain JSON in `~/.local/share/teleport/replays/`. A capture is at
most 10 s, so a longer journey is measured for its first 10 s, and says so. Each replay is a line in
the journal; `history` lists them side by side.

## Shim: past the errors an old engine throws

A modern app often throws on an old engine before it draws anything: `Object.assign is not a
function`, `undefined is not a function` from `Array.prototype.includes`. `shim on` loads small
polyfills on every page tlpt serves, right after the agent and ahead of the app's own scripts, and
reloads the devices into it:

`Object.assign`, `entries`, `values`, `fromEntries`, `Array.from`, `of`, `find`, `findIndex`,
`includes`, `fill`, `flat`, `flatMap`, `String` `includes`, `startsWith`, `endsWith`, `repeat`,
`padStart`, `padEnd`, `trimStart`, `trimEnd`, `Number.isNaN`, `isFinite`, `isInteger`, `EPSILON`,
`Math.trunc`, `sign`, `NodeList.forEach`, `Element` `matches`, `closest`, `remove`,
`Promise.prototype.finally`, `requestIdleCallback` and the `CustomEvent` constructor.

Each is defined only where the engine lacks it, and nothing else is changed. `tlpt shim` says
whether it is on and what the device's page filled; `shim off` takes it out and reloads. It is a way
to see past one error to the next on a device without a rebuild, not a fix: give the build a target
and polyfills of its own. Syntax the engine can't parse (an arrow function on Chromium 38) is not
something a shim can fill; `tlpt probe features` says what the engine has.

## The guide

`tlpt q guide [words]` is for AI agents and scripts, so it is not in the console's list. It is a catalogue of what matters on low-end devices and old engines, read
before designing a trial. Each entry says why it matters on a device, which profile metrics move when it does, ES5
checks that ask the engine directly (ready to paste into a trial's `checks`), and variants worth
trying. Without words, the list; with words, the entries that match best.

Topics: `startup` `bundle` `polyfills` `main-thread` `paint` `compositing` `layout` `css-support`
`images` `fonts` `video` `drm` `video-plane` `memory` `gc` `timers` `input` `network` `caching`
`data` `storage` `graphics` `workers` `quirks`.

```sh
tlpt q guide                  # every topic, one line each
tlpt q guide drm robustness   # the entries about key systems
```

## For AI agents: MCP

`tlpt mcp` serves every `q` command as an MCP tool over stdio, with the same parameters as its
input schema, so an agent can measure the app on a device and is told, in the server's instructions, to write
ES5 and to never claim a difference without the numbers a trial returned. It needs a running
`tlpt`.

Claude Code:

```sh
claude mcp add teleport -- tlpt mcp
```

Cursor, Claude Desktop, Codex and others, in their MCP server configuration:

```json
{ "mcpServers": { "teleport": { "command": "tlpt", "args": ["mcp"] } } }
```

Tools that only read or measure are marked read-only: `status`, `devices`, `device`, `errors`,
`network`, `capture`, `probe`, `styles`, `guide`, `playback`, `survey`, `history`, `advise`,
`report`. `trial`, `try`, `keys`, `hear`, `keymap`, `eval`, `verify`, `replay`, `shim`, `reserve`,
`release` and `clear` change what runs on the device.

## Driving devices from tests

A test runner can hold a device, drive it, read what it threw, and let it go. With several devices
connected, several runs go at once, one on each.

### Reserving a device

`tlpt reserve --as nightly` answers `{ id, token, cdp, … }`: the device named with `--id`, else the
first nobody holds. While the hold lasts:

- A call that acts on the device (`keys`, `eval`, `capture`, `trial`, `clear`, …) without the
  token is refused with 423 and `reserved by nightly`. Reading (`errors`, `network`, `device`) is
  never refused. The console may still act and may let the device go: the person at the keyboard
  decides.
- The device shows a thin frame in teleport's colour with `◎ teleport · nightly` in a corner, so
  whoever walks past sees it is being driven. `--no-frame` leaves it off, for a run that measures
  frames: what the frame costs a device has not been measured.
- The console says `reserved by nightly` in its log and shows `◎ nightly` on the device's row.

The hold ends with `tlpt release`, or when its holder makes no call for 120 s (`--seconds`, 600 at
most), so a run that died frees its device. Set `TLPT_HOLD` to the token and every `tlpt q` call
shows it and goes to that device:

```sh
export TLPT_HOLD=$(tlpt q reserve --as nightly --json | jq -r .token)
tlpt q keys right,right,ok
tlpt q errors
tlpt q release
```

`tlpt clear` forgets what the page threw and the requests it made so far, so `errors` and `network`
answer for what comes next. Reserving does it too.

`--all` runs a command on every connected device at once and answers with an object keyed by
device id: `tlpt q trial focus-ring.mjs --all`, `tlpt q eval --all "document.title"`.

### From a test file: `tlpt/drive`

```js
import { reserve } from 'tlpt/drive';

const device = await reserve({ as: 'smoke', wait: 30_000 });
await device.keys('right,right,ok');                      // or steps, as POST keys takes them
const title = await device.eval('document.title');         // ES5 on an old engine
const { total, errors } = await device.errors();
const slow = await device.network({ minMs: 500 });
await device.clear();                                      // between tests
const report = await device.capture(5000);
await device.release();
```

It is a client of the HTTP API and nothing else, so it works under any runner (`node --test`,
vitest, Playwright). `reserve` takes `{ id, as, ms, frame, wait, keep, port, key }`; `wait` is how
long to wait for a device to be free.

### Playwright

`fixtures()` is the same thing shaped for `test.extend`, with no Playwright of its own, so it uses
yours:

```js
import { test as base } from '@playwright/test';
import { fixtures } from 'tlpt/drive';
export const test = base.extend(fixtures());

test('the remote moves focus', async ({ device }) => {
  await device.keys('right,right,down');
  expect((await device.errors()).total).toBe(0);
});
```

| Fixture | Scope | Is |
|---|---|---|
| `device` | worker | This worker's own device, reserved as `<project> #<worker>` and released when the worker ends. With `workers: 3` and three devices, three files run at once. |
| `devicePage` | test | The device as a Playwright `Page`, over `connectOverCDP`. |
| `deviceBrowser` | worker | The `Browser` behind it. |

Before each test the device's errors and requests are forgotten, and what the page threw during a
test is put on it as a `device errors` annotation. `fixtures({ ids: ['k3x9q2ab', 'p7m2d4cf'] })`
names the devices, a worker each. `examples/playwright` is a suite to copy.

### connectOverCDP, and other protocol clients

`chromium.connectOverCDP('http://localhost:7070/__teleport/<key>')` works, and so does Puppeteer's
`connect({ browserURL })`: `json/version` there names a browser-level socket, `cdp`, on which each
device is a page. `device.endpoint` is that socket for one held device alone. What goes through it:

- `Target.*`: `getTargets`, `setDiscoverTargets`, `setAutoAttach`, `attachToTarget`,
  `attachToBrowserTarget`, `detachFromTarget`, `getTargetInfo`. A page can't be made or closed
  from the laptop: `createTarget` and `closeTarget` are refused with why.
- `Input.dispatchKeyEvent` presses the key as the remote does, whole on key down (a printable key
  types its character); `Input.insertText` types; `Input.dispatchMouseEvent` clicks what is at the
  point on release.
- `Page.*`, `Runtime.*`, `DOM.*`, `CSS.*`, `Network.*`: what [DevTools has](#what-works-in-devtools),
  since a session is a DevTools client of the device.

Checked with Playwright 1.65 against Chrome 158 as the device: `page.title()`, `evaluate`,
`locator`, `keyboard.press`, a `CDPSession`. Playwright's `evaluate` and locators run a script of
Playwright's own that an ES5 engine can't parse, so on an old device use `device.keys` and
`device.eval`, or `Runtime.evaluate` on a session, which need nothing but the agent.
`page.goto`, screenshots and emulation are not there: a device opens its own app, and the
laptop can't see its pixels.

## The HTTP API

`q` and `mcp` are thin clients of this, and the easier way in: they find the key themselves.

The API lives under teleport's key: `http://localhost:7070/__teleport/<key>/api/`. The key is ten
characters in `~/.config/teleport/key` (`$XDG_CONFIG_HOME/teleport/key` where that is set), made
the first time teleport starts on this machine and kept. Without it every path under
`/__teleport/` answers 403, and so does a request that doesn't come from this machine. See
[Security](#security) for why. `?id=<device>` picks a device.

```sh
key=$(cat ~/.config/teleport/key)
curl "http://localhost:7070/__teleport/$key/api/live"
```

| Method and path | Answers |
|---|---|
| `GET live` | Every connected device: `device`, `latest` sample, `keyTargets`, `stats`. |
| `GET device?seconds=60` | One device with its recent `points` and `requests`. 404 with no device. |
| `GET errors` | What the page threw since it loaded: `id`, `href`, `engine`, `total`, `errors`. See [When the app throws](#when-the-app-throws). |
| `GET network?url=&minMs=&failed=1&limit=50` | The device's requests through teleport. |
| `GET probe?name=dom` | A probe's parsed answer. 502 with the error when the page threw or didn't answer in 15 s. |
| `POST eval` with a JSON body `{ expr }`, or `?expr=1%2B1` for a short one | `{ value }`, or 502 with what the page threw. |
| `POST keys?seq=right,right,ok` or a JSON body `{ steps: [...] }` | The run: `phase`, `presses`, `error`. Steps may also be `{ kind: 'text', text }`, `{ kind: 'wait', ms }`, `{ kind: 'focus' or 'click', selector }`, and a key step may `repeat` with a `delayMs`. |
| `POST capture?ms=10000` | The capture's report, after the window and 1.5 s to settle. |
| `POST trial` with a JSON body `{ spec }` | The trial's report; 400 with what is wrong with the spec; 409 while one is running on that device. |
| `GET presses?seconds=60` | The presses the page saw in the last `seconds`, oldest first: `t` (page time), `keyCode`, and `key`, the remote key it is, or null. |
| `POST reserve?as=nightly` (`id`, `ms`, `frame=0`, `keep=1`) | `{ id, token, as, ms, ua, href, cdp }`: the device is this caller's until `release` or `ms` with no call. 423 when it, or every device, is held. See [Driving devices from tests](#driving-devices-from-tests). |
| `POST release` | `{ released }`: ends the hold the `x-teleport-hold` header names. |
| `POST clear` | `{ cleared: { errors, requests } }`: forgets both, so the next reads start from now. |
| `GET shim` | `{ on, filled, names }`: whether the shim is on, what the device's page filled, and what it can. |
| `POST shim?on=1` or `?on=0` | Turns the shim on or off for every page from now, and reloads the devices: `{ on, reloaded }`. |

An `x-teleport-hold` header carries a hold's token: it is what lets a call act on a held device,
and with no `id` it picks that device. An `x-teleport` header (`q`, `mcp` or `console`) only names the caller in the console's log. An
`x-teleport-part: 1` header says the call is a step of a bigger experiment (a survey, a replay),
which keeps its own line in the journal, so the step isn't kept on its own.
DevTools for a device is `http://localhost:7070/__teleport/<key>/d/<id>`; each device's `inspect`
field in `live` is that link. Beside `api/` under the key are `json/version` and `json/list`, as a
browser's debugging port answers them, and the browser-level socket `cdp`.

From a script in the same process, `import { startDevServer } from 'tlpt'` starts the server with
`{ port, host, app, insecure, manifest, key, via, journal }` and returns `{ http, key, close() }`;
`journal` is called with each experiment as it ends, and nothing is kept without it.

## How it works, and what the device pays

Three pieces. [ARCHITECTURE.md](ARCHITECTURE.md) goes through each, with what was measured.

**The agent (9 KB, ES5), in every page.** One timer a second. It records raw timestamps and
counters into fixed-size buffers and ships them as one binary frame. It computes nothing: frame
rate, percentiles and key → frame are the laptop's job, so the device pays about 0.1 % of a core.
It also keeps what the page throws, from its first script, and answers the laptop's questions
(`eval`, a probe, a remote key, `styles`) on the socket it already has.

**The inspector (20 KB), only while DevTools or a trial needs it.** A hand-written Chrome DevTools
Protocol backend: DOM, CSS, Runtime, Network, Page and Overlay, enough for the stock frontend's
panels. It sends the laptop only what DevTools looks at, paces its answers to at most 30 % of the
main thread, and sheds detail when the page is busy or short of memory. It unloads when DevTools
closes.

**The server, on the laptop.** Serves or proxies your app with the agent's tag added, relays both
sockets, keeps the copy of the element tree DevTools reads, answers the Network panel from the
requests it served, and builds the Performance panel's trace from the agent's records.

```
device (old Chromium)                        laptop
┌──────────────────────┐                 ┌─────────────────────────────┐
│ your app             │  binary frames  │ tlpt                        │
│  + agent (9 KB)      ├────────────────►│  timeline, report, trace    │
│  + inspector (20 KB) │◄───────────────►│  DOM copy, CDP relay        │◄──► Chrome DevTools
│    on demand         │  CDP over ws    │  trials, probes, keys       │◄──► tlpt q · MCP
└──────────────────────┘                 └─────────────────────────────┘
```

**Never into the app.** Nothing teleport does reaches the app's `window.onerror`,
`unhandledrejection` or console, or its error reporting (Sentry and the like), and nothing shows
on the screen unless `data-badge="on"` asks for it. A console, `fetch` or XHR method teleport
wraps while DevTools is open always calls the app's own with the same `this` and arguments, and
returns or throws exactly what that does. Tests and build gates hold each of these.
Known limits:

- While the laptop is away, the browser itself logs "WebSocket connection … failed" at each retry
  (at most 10 s apart). That is the browser's network log, which page code can't see or stop.
- While the DevTools Network panel is open, a failed `fetch` the app leaves unhandled counts as
  handled, so its `unhandledrejection` doesn't fire then. Returning a different promise to keep it
  would break apps that rely on the one they get.
- Previewing a logged Proxy object runs the app's Proxy handlers, as reading it must.

**What DevTools costs.** DevTools asks a lot when it opens and when you click around: often a
hundred or more requests at once. The inspector answers in 8 ms slices and rests between them, so
the page keeps drawing and the answers take longer to arrive. Measured in headless Chromium 156 at
20x CPU throttle, not on a device, with 180 requests at once: 59.7 frames a second instead of
12.0, and the answers in 4.7 s instead of 1.2. When the work the page itself drives (its logs,
DOM changes and requests) costs too much, a governor sheds:

- At 3 % of the main thread, 70 % of the heap's limit or a link full for 2 s: shorter previews,
  and logged objects aren't kept for expanding. The device's row says `inspector shedding`.
- At 10 %, 85 % of the heap or 1 MB queued: console and network reporting stop and are only
  counted, and the DOM is no longer watched. The row says `inspector paused`. After 5 calm
  seconds it steps back, and DevTools fetches the tree again.
- What the page threw, and what it logged with `console.error`, still arrives at every level.
- What was left out is said: `k3x9q2ab inspector left out 40 console messages and 12 network
  events`.

## Security

teleport listens on your network, because the device has to reach it. What can be reached there,
and by whom:

- **Driving a device needs the key.** The API, DevTools' page and DevTools' socket live under
  `/__teleport/<key>/` and nowhere else. The key is ten random characters in
  `~/.config/teleport/key`, readable only by you, made the first time teleport starts and kept.
  `tlpt q`, `tlpt mcp` and the console's DevTools links read it; a request without it gets 403.
  The DevTools links the console prints carry the key, so treat them as you would a password.
- **And it must come from this machine**: a loopback address, a `Host` that names this machine,
  and no forwarded-for headers. A tunnel's traffic arrives with those headers and is refused; a
  website whose name points at `127.0.0.1` (DNS rebinding) is refused by the `Host` check. On its
  own this is not enough, which is why the key exists: an ssh or TCP tunnel, a reverse proxy, or a
  dev server's proxy that rewrites `Host` passes a stranger's request on looking like your own.
- **The device's sockets need no key**, as the device has none. Anyone who can reach teleport's
  port can connect as a device or as a device's inspector. What arrives there is data: counters,
  answers to this laptop's own questions and, while DevTools is open, what DevTools asked. It
  can't drive DevTools or the API, it is checked before it is used, and teleport never fetches an
  address a device names. A machine on your network can still pose as a device and show you
  made-up numbers, or take a real device's place in the list by connecting under its id.
- **The agent runs what teleport sends it**, on the socket the page opened. The injected agent
  connects to the server its script came from. The bundled one starts only when your app calls
  `init`, and reports only to the address your code gives or the host that served the page.
- **What a device says is printed as text.** Escape and control characters are removed from
  everything a page throws, logs or names before it reaches your terminal.
- **Proxied https apps** are checked against this machine's certificate store; `--insecure`
  trusts any certificate, for a dev server with a self-signed one.

## Limits

Honest ones. The inspector is a subset of CDP: no Debugger (breakpoints), no Profiler, no
Memory snapshots; the Performance panel shows what the agent can observe, not Chrome's internal
tracing. Trials measure what `performance.now()`, `requestAnimationFrame` and the engine's own
APIs expose, which on an old embedded engine is less than on a laptop, and the report says which numbers an
engine couldn't give. Only requests that go through teleport appear in the Network panel with
bodies; the rest come from Resource Timing. Search in Elements stops at 1000 hits. The agent's
name table holds 1024 distinct resource names per page load. A trial has 270 s to finish.

A source map is read for a script that came through teleport, when the map is a file beside it on
the same address or inside the script. Maps in sections aren't read. Through the proxy, a place
past the app's own address on its line isn't mapped, since rewriting that address moved the
columns after it; `--via` has no such gap. The answer is then the place in the bundle.

A request is matched to its device by address, and where several devices share one (behind a
router, or a tunnel that names one address for a network) by browser. Two devices of the same
model behind one address see each other's requests in Network. A page in a frame is part of the
page above it: one device, the top page. Through the proxy, a page, script, style or JSON body
over 32 MB passes as the app sent it, without the agent's tag or the app's address rewritten, and
those bodies reach the device only once the app has sent the whole of each.

## Troubleshooting

**The device shows "teleport is waiting for your app".** Nothing answers at the port you gave tlpt yet.
Start the dev server; the page opens the app by itself within 2 s of it answering.

**The app throws while it starts, or shows a blank screen.** Press `e` in the console, or run
`tlpt q errors`. The agent hears what the page threw from its first line, with no DevTools open. The
first error is usually the cause: a file the engine couldn't parse (syntax newer than the engine;
`tlpt q probe features` says what it has), or a script that didn't load. The errors after it often
name what that script should have defined. See [When the app throws](#when-the-app-throws).

**DevTools makes a slow device crawl.** Answering DevTools is already paced to at most 30 % of the
main thread, and less while the governor sheds. If the row says `inspector shedding` or `inspector
paused`, the work the page drives (its logs, DOM changes and requests) is what costs: a page that
logs in a loop, or re-renders large parts of the DOM, costs more while DevTools is open. Collapse
large subtrees in Elements, since the inspector watches only the nodes DevTools has, or close
DevTools while you measure with `c` or a trial. See [What DevTools costs the device](#how-it-works-and-what-the-device-pays).

**The device shows the tunnel's "You are about to visit" page.** A tunnel's free plan shows it to a
browser that opens the tunnel address. Press Visit Site once, or open the LAN address the console's
tunnel line gives.
See [which to run](#how-the-device-reaches-your-laptop).

**`npx teleport` runs something else.** `teleport` on npm is an unrelated package. Use `npx tlpt`, or
install it (`npm install -g tlpt`), after which `tlpt`, `tp` and `teleport` all work.

**The device link opens the app but no device appears in the console.** The device can't open a WebSocket to the
laptop. Check that both are on the same network and that the laptop's firewall allows port 7070
in. Behind a tunnel, point the tunnel at teleport's port, not the app's. `tlpt q status` says
whether any device is connected.

**DevTools opens but shows nothing.** The inspector didn't load or connect. In the device's own
console, `window.__teleportInspector` should exist after DevTools opens. A content security policy
on the app can block it: teleport lifts `script-src` on pages it proxies, but not on pages a
tunnel serves directly.

**DevTools shows "teleport: DevTools closed here, so the page's console went unrecorded".** As it
says: the console is wrapped only while DevTools is open, so there is a gap. Keep it open.

**`tlpt q` says "no teleport on port 7070".** Start `tlpt` first, or pass `--port` / set
`TELEPORT_PORT` to where it runs.

**A DevTools link or the API answers "this needs teleport's key".** The link is from before the
key, was typed without it, or is for another user's tlpt. Press `d` in the console, or use the
link it prints. `tlpt q` and `tlpt mcp` read the key themselves, so they must run as the same user
as `tlpt`; a script of your own reads it from `~/.config/teleport/key`. See [Security](#security).

**A device shows "N messages not read" in `tlpt q devices`.** teleport dropped messages from that
device that it couldn't follow, and carried on. It should be zero: start `tlpt` with
`TELEPORT_DEBUG=1` to see where, and report it.

**DRM, a service worker or `crypto.subtle` is missing on the device, and works on your laptop.**
The device opened the app over plain http, which is not a secure context; your laptop opened it on
`localhost`, which is. `tlpt q probe media` says so when it is the cause. See
[Secure contexts](#secure-contexts-drm-and-service-workers).

**Behind your own proxy, links in the app lead to `localhost:7070`.** The proxy doesn't tell tlpt
the address the device used. Start tlpt with `--via` and that address. See
[your own proxy](#behind-your-own-proxy-or-port-forward).

**The app has an iframe, and the device listed isn't the page you expected.** The device is the top
page: a framed page leaves the tab to the page above it. To inspect the framed page on its own,
open its address directly.

**A trial says "The device's engine couldn't parse some of the code".** Your `measure`, `setup` or
`checks` used syntax the engine lacks. Write ES5: `var`, `function`, no arrows, template strings,
classes or spread. `tlpt q probe features` says what the engine has.

**The DevTools frontend won't load.** It is fetched once from Google's hosting of Chrome's
frontend and cached under `~/.cache/teleport`. On a network that re-signs https, start teleport
with `NODE_EXTRA_CA_CERTS` pointing at that root certificate. The `devtools` field of
`tlpt q devices --json` is a `devtools://` link to Chrome's built-in frontend, which needs no
download: paste it into Chrome's address bar.

**Port 7070 is in use.** If it is an older teleport, the new one asks it to step aside. Otherwise
`--port 7071`.

## Packages

| Package | |
|---|---|
| `tlpt` | The command and the server, with the agent and inspector it serves. No runtime dependencies. |
| `@tlpt/agent` | The agent alone, for your app's build. |

Building, testing and releasing them is in [ARCHITECTURE.md](ARCHITECTURE.md#working-on-it).

## License

MIT
