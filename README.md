# teleport

**Chrome DevTools for web apps on embedded devices and other old Chromium you can't attach a
debugger to.** Nothing to add to your app, nothing visible on the device.

Device browsers are five to ten years old and have no debug port. teleport puts a tiny DevTools
backend inside the page as it serves it, so the normal Chrome DevTools on your laptop works against
the device. It also measures what matters on a device, like how long a key press takes to reach the screen.

## Start

```sh
npm install -g tlpt     # gives tlpt, tp and teleport: the same command
tp 5173                 # the port your dev server runs on
```

Or just `tp`: it finds a dev server on a common port, or waits until you type the port in it.

```
  ◎ teleport  → localhost:5173
  open on the device  http://192.168.1.20:7070/
```

Open that address on the device. When it connects, Chrome DevTools opens on your laptop, a card for
the device appears at the top (its state, engine, screen and cores), and its main thread, memory and
key response run live at the bottom of the terminal. On the left are five groups: measure,
experiment, video, input and inspect; `→` or Enter opens one. The last line is an input, always open:
type a command or its letter, then Enter (`c` captures, `t` lists things to try, `r` is the remote,
`h` lists every experiment so far). Nothing needs a second terminal; `tlpt <command>` runs the same
thing from one if you want it. `?` explains what the colours and numbers mean.

Any package manager works, because tlpt has no dependencies: `bun add -g tlpt`, `pnpm add -g tlpt`
or `yarn global add tlpt`. To try it without installing: `npx tlpt`, `bunx tlpt` or `pnpm dlx tlpt`.
From a checkout instead: `npm install && npm run link`. To hand it to someone without publishing it,
`npm run pack` writes `tlpt-<version>.tgz` (about 300 KB); they install it with
`npm install -g ./tlpt-<version>.tgz`.

## Your setup

| You have | Run | On the device |
|---|---|---|
| A dev server on this laptop | `tlpt 5173` | open the address tlpt prints |
| A tunnel to it, whose agent on this laptop has a local API | `tlpt 5173` | keep opening your tunnel's address: tlpt routes it through itself while it runs, and back when it stops |
| A local proxy to a remote dev environment | `tlpt <the proxy's port>` | as above, tunnel or not |
| A deployed app | `tlpt https://app.example.com` | open the address tlpt prints |

- Start tlpt before or after your dev server. Until the port answers, the device shows a waiting page
  and loads the app by itself once it's up.
- A tunnel's free plan may show the device a warning page once. Press Visit Site.

## On the device

- **Nothing to install.** tlpt adds one script tag to pages as it serves them. Your code doesn't
  change.
- **Invisible.** No badge, nothing in the app's console, and it never throws into your app. When
  the laptop goes away, it waits quietly and reconnects.
- **Small.** A 9 KB ES5 agent for Chromium 38 and up. The DevTools part loads only
  while you use it.

## What you can do

- **DevTools**: Elements, Styles, Console, Network, Sources and Performance, against the device.
  Answering it takes at most 30 % of the device's main thread, so a slow device keeps drawing.
- **See why it broke**: `e` lists what the page threw from its first line, even before DevTools
  opened, with the place in your own source when the build left a source map, and what the error
  most likely means on that engine.
- **Watch it live** in the terminal, with a line when something goes wrong: a slow key, a blocked
  main thread, memory heading for the limit where the device kills the app.
- **Measure**: `c` records 10 s of frames and key presses, and `s` surveys the device and saves a
  report.
- **Try one thing**: `try shadow`, `try will-change`, `try css "…"` on your own app, `try js "…"`
  for your own code, `try html "…"` for your own markup: flipped on the device and measured both
  ways, with nothing to write. `trial file.mjs` compares variants of your own, with confidence
  intervals.
- **Keep every experiment**: each capture, probe, try, trial and survey is kept on this machine, one
  line each, whoever ran it. `h`, or `tlpt history`, lists them.
- **Replay a journey**: `replay save home` keeps the remote presses the device just saw;
  `replay home` presses them again in the same rhythm and captures it, so a change is measured on
  the same path before and after.
- **Get past an old engine's errors**: `shim on` fills in the built-ins an old engine lacks
  (`Object.assign`, `Array.from`, `includes`, `padStart`, `closest`, …) ahead of your app, so you
  see what breaks next without a rebuild.
- **Video**: `try hevc`, `verify` and `playback`: which codecs really play, and what is playing.
- **Drive it**: `r`, or `tlpt remote` in another shell, turns your keyboard into the remote.
- **Run your tests on it**: `import { fixtures } from 'tlpt/drive'` gives Playwright a device for
  each worker, so a suite runs on several devices at once; `connectOverCDP` works too. A device a
  run holds shows a thin frame, and nobody else's keys reach it.
- **Script it, or hand it to an AI agent**: `tlpt status`, `tlpt probe media`, and `tlpt mcp`.

## If something's off

- **The device says "teleport is waiting for your app".** Nothing answers on that port yet. Start your
  dev server.
- **The app throws or shows a blank screen.** Press `e`, or run `tlpt errors`. The first error is
  usually the cause. When it is a built-in the engine lacks, `tlpt shim on` gets you past it.
- **The app opens on the device but nothing appears in the terminal.** The device can't reach the laptop.
  Check they're on the same network and the laptop's firewall lets port 7070 in.
- **The device shows the tunnel's "You are about to visit" page.** That's the tunnel's free plan. Press Visit
  Site once.
- **`npx teleport` runs something else.** That's another npm package. Use `npx tlpt`, or install
  it, after which `teleport` works too.

- **Your DevTools extensions (React, Redux) aren't in teleport's DevTools.** It is Chrome's own
  DevTools frontend in a tab, not DevTools for one of your browser's tabs, and Chrome gives
  extension panels only to the latter.

- **A DevTools link says it needs teleport's key.** Press `d` in tlpt's terminal, or use the link
  it prints. Only links from your own tlpt open DevTools.

## More

- [AGENTS.md](AGENTS.md) is the full reference: every key and command, the HTTP API and MCP tools,
  trials and probes, security, and what it costs the device. It's written for AI agents, and
  works for anyone who wants the detail.
- [ARCHITECTURE.md](ARCHITECTURE.md) explains how it is built: each part, what was done to make it
  cheap on a device, and what was measured.

Needs Node.js 20+ and Chrome or Edge on the laptop. MIT licensed.
