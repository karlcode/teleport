# How teleport is built

Each part of teleport, what it is for, where it lives, and what was done to make it cheap or safe,
with the number that was measured where there is one. [README.md](README.md) is for someone using
teleport and [AGENTS.md](AGENTS.md) is the full reference for using it; this is for someone reading
or changing the code.

## The idea

A web app runs on a slow device with an old browser engine (Chromium 38 is the floor) that nobody
can attach a debugger to. teleport splits the work between the two machines it has:

- **The device writes down what happened**, as raw timestamps and counters.
- **The laptop works out what it means.** Frame rates, percentiles, the DOM tree DevTools sees,
  the Network panel, trial statistics.

```
device (old Chromium)                        laptop
┌──────────────────────┐                 ┌─────────────────────────────┐
│ your app             │  binary frames  │ tlpt                        │
│  + agent             ├────────────────►│  timeline, report, trace    │
│  + inspector         │◄───────────────►│  DOM copy, CDP relay        │◄──► Chrome DevTools
│    (on demand)       │  CDP over ws    │  trials, probes, keys       │◄──► tlpt q · MCP
└──────────────────────┘                 └─────────────────────────────┘
```

## The parts

| Part | Folder | Runs on | Size | Its job |
|---|---|---|---|---|
| Agent | `packages/agent` | the device, in every page | 8.7 KB gzip (budget 15) | Record, and send one binary frame a second. Answer the laptop's questions. |
| Inspector | `packages/inspector` | the device, only while DevTools or a trial needs it | 19.6 KB gzip (budget 22) | Speak enough of the Chrome DevTools Protocol for the stock DevTools. |
| Protocol | `packages/protocol` | both | | The binary frame format, from one schema. |
| Server | `packages/server` | the laptop | | Serve the app, relay both sockets, answer DevTools and the API, draw the console. |
| Stats | `packages/stats` | the laptop | | Quantiles and bootstrap intervals for trials. |
| `tlpt` | `packages/tlpt` | the laptop | | What is published: the server bundled into one file, with the agent and inspector beside it. |

The agent and the inspector are hand-written ES5 with no dependencies. The laptop side is
TypeScript with no runtime dependencies either: the WebSocket server, the proxy and the terminal UI
are written here.

## Six rules the rest follows

1. **Never into the app.** Nothing teleport does on the device throws into the app, logs into its
   console, reaches its error reporting or shows on its screen. Every callback the page makes into
   teleport goes through `guard()`, and each served script is wrapped whole in `try`.
2. **The device records, the laptop computes.** If a number can be derived later from raw records,
   the device never derives it.
3. **Bounded by construction.** Every buffer on either side has a fixed size and counts what it
   drops. Nothing grows with how long a session runs.
4. **Measured on the real engine.** A device-side change is measured on Chromium 38 itself, x64
   and ARM, before it is kept. A number here says where it was measured; most are not from a device.
5. **Nothing a device sends ends teleport.** The laptop treats every message from a device as
   something an old engine, a cut link or another machine on the network might have sent.
6. **Driving a device needs the key.** The API, DevTools and DevTools' socket answer only a caller
   that shows a secret kept in a file on the laptop.

## The agent

`packages/agent/src`, about 1,600 lines.

| File | What it holds |
|---|---|
| `index.js` | The one-second tick, the socket and its reconnects, the commands the laptop sends, `init`/`stop`/`status`. |
| `samplers.js` | What is recorded: long tasks, resources, key presses and the frame after each, heap, video frame counts, frames during a capture. |
| `ring.js` | A fixed-size ring of records in typed arrays. |
| `encode.js` | Writes the pending records of every ring into one reused buffer. |
| `errors.js` | What the page threw, from its first script: the first 8 and last 8 kept, the rest counted. |
| `ask.js` | Runs the laptop's `eval` and answers with the value. |
| `safe.js` | `guard()` and `safely()`: the only two places `try`/`catch` lives. |
| `entry.cjs` | The form an app bundles (`@tlpt/agent`): asleep until the app calls `init`. |
| `generated/schema.js` | The frame layout, generated from the protocol's schema. |

### What keeps the agent cheap

| What | Why | Measured |
|---|---|---|
| One timer a second. Every five seconds once the laptop has been away a minute. | The agent's cost is its wake-ups. | 0.07 % of the main thread on a 1,227-element page (desktop Chromium). |
| Records go into preallocated typed-array rings. The key path allocates nothing. | No garbage for an old collector to pause on. | |
| It computes nothing. Frame rate, percentiles and key → frame are worked out on the laptop. | The laptop is a thousand times faster and its time is free. | |
| Frames are recorded only during a capture. | A `requestAnimationFrame` callback on every frame is a cost on every frame. | |
| A stream with no new records is left out of the frame. Resource names are sent once and their own origin dropped. | A quiet second is a few dozen bytes. | 0.2 KB/s on the wire. |
| `try`/`catch` only in small helpers. | V8 before TurboFan never optimised a function that contained one. | |
| `DataView` stays for writing frames. | It is slower than typed arrays on old V8, but a few dozen values a second is microseconds either way, and one code path works on any byte order. | |
| A dropped link resumes by position: the server says how many records of each stream it holds, and the agent sends the rest from its rings. | Records sent into a socket that died were lost uncounted, and every reconnect looked like a new page. | No extra memory: the rings already held them. |
| A dead link is noticed in about 10 s (the server sends `beat` every 4 s), and reconnects back off to at most 10 s. | Some device WebSocket stacks never fire `onclose`. | Was 45 s. |
| The laptop's questions (`eval`, probes, keys, `styles`) are answered by the agent itself, on the socket it already has. | The first question used to load the whole inspector into the page. | First question 6.9 ms instead of 46.9, and 0 bytes loaded instead of 50,671 (Chromium 156, 6x throttle). |
| A question runs once. The last eight answers are kept and sent again after a dropped link. | An answer lost with the link would otherwise be asked, and run, twice. | 60 of 60 answered once with the socket cut around every other one (Chromium 38). |
| One agent for a tab: a page in a frame stays asleep when a page above it runs an agent. | Frames of one origin share the tab's id, so the laptop took the frame for the page and dropped the real one. | Checked on Chromium 38 (x64 and ARM) and Chrome 157. |
| The bundled agent starts only when the app calls `init`. | It runs what the laptop sends, so the page's address must not be able to wake it or point it somewhere. | |

## The inspector

`packages/inspector/src`, about 3,500 lines. It is loaded when DevTools opens or a trial runs, and
unloaded on detach, putting back every global it wrapped.

| File | What it holds |
|---|---|
| `index.js` | Loading, the socket to the laptop, pacing. |
| `cx.js` | The table of protocol methods, the outbox, and the short forms of the busiest messages. |
| `dom.js` | The element tree: what is sent, what is watched. |
| `css.js` | Stylesheets and matched styles for the Styles pane. |
| `runtime.js`, `remote.js` | `Runtime.evaluate`, and the objects DevTools holds by id, in fixed rings of slots. |
| `network.js` | XHR and fetch, wrapped only while the Network panel is on. |
| `page.js`, `overlay.js` | Sources for the page's own origin; the highlight boxes. |
| `governor.js` | Sheds work when the inspector costs the page too much. |

### What keeps the inspector cheap

| What | Why | Measured |
|---|---|---|
| The device sends the top of the tree (up to a thousand nodes, breadth first), then each subtree when DevTools expands it. It watches only the nodes the laptop has, one by one. | A rail of a thousand tiles re-rendering under a collapsed node should cost nothing. | A 1,227-element page is an 853-byte document; a change under a collapsed tile sends one count. |
| DOM changes go as flat arrays, each tag and attribute name sent once. | Fewer bytes to write and send. | 20 to 28 % fewer bytes. About 15 % less main thread under DOM churn on x64 Chromium 38; no change on ARM. |
| The busiest messages go in short: flat arrays of what varies. A rule's declarations cross once; a computed style crosses as the values that changed. The laptop writes the protocol back out. | With no optimising compiler, `JSON.stringify` of a small flat array is the cheapest way to write a message, and sending costs more than writing. | A click in Elements sends 1.9 KB instead of 58.0 KB, in 1.63 ms of main thread instead of 3.66. A page logging 50 objects a second sends 9.3 KB/s instead of 27.4 (Chromium 156, 6x throttle). |
| Everything one task produces goes out as one WebSocket message. | `WebSocket.send` itself was more than half of what the inspector added. | 15.92 to 12.45 ms/s of main thread (10 paired runs, 6x throttle). |
| The socket is compressed by the browser (`permessage-deflate`, one context for the socket, a 2 KB window). The laptop never compresses what it sends. | The browser compresses off the main thread, and CDP's JSON repeats itself. | A seventeenth of the bytes, with the main thread no busier. The small window matches a 32 KB one (23.6x against 23.8x). |
| Answering DevTools is paced: 8 ms of work, then a rest, so it takes at most 30 % of the main thread. | DevTools sends a hundred or more requests when it opens or you click. | 59.7 frames a second instead of 12.0 during 180 requests at once (Chromium 156, 20x throttle). |
| A governor sheds detail, then stops console and network reporting and DOM watching, when the work the page drives costs too much or the heap nears its limit. | A page that logs in a loop must not be slowed further by being watched. | |
| Console and network events go through fixed lanes: when the link is full they are counted, not queued. Errors have a lane of their own. | Memory stays bounded, and what the page threw always arrives. | |
| A fetch body is cloned only for a text-like response under 1 MB. | Never copy a media segment. | |

What pacing buys, in headless Chromium 156 at 20x CPU throttle (not a device): a page of animated
rails with DevTools attached, then 180 requests at once. Median (p95) of 10 runs.

| During the burst | Unpaced | Paced |
|---|---|---|
| Main thread busy, ms/s | 776.0 (789.6) | 461.1 (512.8) |
| Frames drawn, fps | 12.0 (13.2) | 59.7 (59.8) |
| Longest gap between frames, ms | 391.6 (433.3) | 33.4 (50.1) |
| First request to last answer, ms | 1179.5 (1319.4) | 4672.5 (5254.6) |

The same answers take four times as long, and in exchange the page keeps drawing.

The governor has two levels above normal:

| Level | Enters at | What changes |
|---|---|---|
| 1, shedding | 3 % of the main thread, 70 % of the heap's limit, or a link full for 2 s | Shorter previews; logged objects aren't kept for expanding. Pacing drops to 15 %. |
| 2, surviving | 10 %, 85 % of the heap, or 1 MB queued. At once past 100 ms of page-driven work in a second. | Console and network reporting stop and are only counted; the DOM is no longer watched. Pacing drops to 5 %. |

After five calm seconds it steps down one level. Leaving level 2, DevTools fetches the tree again.
Code the laptop asks the page to run (`eval`, a trial, a remote key) is the page's time: it is not
counted against the inspector and not rested for, so a trial measures the page and not the pacing.

## The protocol

`packages/protocol`. One file, `schema.json`, lists the streams (long tasks, resources, input,
heap, video, frames, and so on) and the type of each column. `scripts/gen-protocol.mjs` writes
the agent's ES5 constants and the laptop's TypeScript from it, and CI fails when the generated
files are stale, so the two sides can't disagree.

A frame is one binary WebSocket message: a header, then for each stream with new records a stream
header and its columns. Since version 3 a stream header carries the position of its first record,
which is how a link resumes (`positions.ts`).

## The laptop: `packages/server/src`

| Job | Files |
|---|---|
| The command | `cli.ts` (flags, start, quit), `menu.ts` (every command, in five groups), `toggles.ts` (what `try` flips, each a trial spec made here), `tunnel.ts` (a tunnel vendor is an adapter: an agent's local API and Tailscale re-pointed in place; any other run with `--tunnel`), `help.ts`, `version.ts` |
| The terminal | `console.ts` (the UI, a pure `view()` of its state), `term.ts` (the region it redraws), `tui.ts` (header, help and the beam), `format.ts` (how answers read), `text.ts` (width, wrapping, and `printable`), `glyphs.ts` |
| Serving the app | `app.ts` (folder or proxy, the agent's tag), `netlog.ts` (the request log), `frontend.ts` (DevTools' frontend, fetched once and cached), `tunnel.ts` (a tunnel agent's local API) |
| What the page threw | `errors.ts` (each error, and what it likely means), `sourcemap.ts` (where it is in the code someone wrote) |
| Sockets | `ws.ts` (the WebSocket server), `link.ts` (a channel that outlives its sockets) |
| Devices | `server.ts` (routes, devices, the API), `session.ts` (one page's timeline), `analyze.ts`, `vitals.ts`, `live.ts`, `ua.ts` |
| DevTools | `devtools.ts` (the bridge), `mirror.ts` (the copy of the tree), `expand.ts` (short forms back to the protocol), `cdp.ts`, `perfpanel.ts` |
| Test runs | `drive.ts` (holds, the frame a held device shows, the browser's side of the protocol), `client.ts` (what `tlpt/drive` exports: a held device, and Playwright fixtures) |
| Asking | `q.ts` (the commands), `mcp.ts`, `probes.ts`, `remote.ts` (sending keys), `hear.ts` (reading them, and the keys each platform was heard to send), `replay.ts` (a journey's presses kept as a tape, and pressed again under a capture), `shim.ts` (the built-ins an old engine lacks, filled ahead of the app), `styles.ts`, `trial.ts`, `profile.ts`, `guide.ts`, `verify.ts` and `aliens.ts` (the clips, and the crew drawn in them) |
| Keeping | `journal.ts` (every experiment, one JSON line each, beside the surveys), `survey.ts`, `report.ts`, `advise.ts` |
| Access | `key.ts` |

### Sockets (`ws.ts`, `link.ts`)

`ws.ts` is RFC 6455 written here: handshake, framing, masking, fragments, ping and close.

| What | Why | Measured |
|---|---|---|
| A frame that arrives in pieces is joined once, when its last piece is in. | Joined at every piece, each copy took all that came before. | A 60 MB frame in 16 KB pieces: peak 271 MB of memory instead of 3.9 GB. |
| A compressed message stops inflating at the size limit (64 MB). | A megabyte of zeros inflates to a gigabyte, and the size used to be looked at afterwards. | 47 MB added instead of 1,050 MB. |
| Every socket is pinged every 5 s, and one silent for 15 s (a device's) or 45 s is dropped. A beat that came late means the laptop slept, so that silence isn't counted. | A tunnel drops links without a close frame. A laptop waking from sleep must not drop every device. | |

`link.ts` puts a channel on top of sockets. Each side counts what it received and keeps what it
sent until it is acknowledged. A socket that drops is replaced, and each side resends only what
the other missed. DevTools' socket and the inspector's both ride one, which is why DevTools stays
attached through a dropped link or a restarted teleport. After a 70 s outage, a restart and a
half-open tunnel, DevTools' lines were back 5.5, 1.8 and 10 s after the link was, none missing.

### The boundary (`server.ts`, `reading`)

Every message from a device, its inspector or a DevTools window is checked where it is parsed: a
short form against its shape and counts (`expand.ts`), a node against what a node is
(`mirror.ts`), a frame against the schema. A message that fails is refused: the copy of the tree
is dropped, DevTools asks for the document again, and the inspector is told to say again what its
short messages lean on.

Behind those checks is one last-resort wrapper, `reading`, around every socket's handler. An
exception there drops that message and adds one to the device's `unread` count, which `tlpt q
devices` shows. Without it, an exception ended the process and every device's session with it.
A count above zero means a check is missing: `packages/server/test/hostile.test.ts` sends
thousands of malformed messages and holds it at zero. `TELEPORT_DEBUG=1` prints where one was caught.

### Serving the app (`app.ts`)

| What | Why |
|---|---|
| The agent's `<script>` goes first in `<head>` of every HTML page, in a folder or through the proxy. | It must run before the app to hear what the app throws as it starts. |
| Through the proxy, the app's own address in pages, scripts, styles and JSON is rewritten to the address the device used. Bodies are read as latin1, so every byte of any charset survives. | The device stays on teleport, where pages get the agent. |
| A body over 32 MB passes through unrewritten. | Held whole, text of 512 MB ended the process. |
| An answer the app drops midway ends the device's request too. | It used to wait forever, and a few of those hold every connection a device's browser opens to one host. |
| A file is opened before anything is said, and goes with its length and `Range` support. | A file that couldn't be read ended the process. A device's media stack asks for a video a span at a time. |
| A request teleport's own proxy sent, arriving back, is refused with 508. | A tunnel pointed at teleport and named as the app would loop forever. |

`--via` covers the proxy teleport can't see past. The address the device used is read off each
request: its `Host`, or the forwarded headers a tunnel adds. A proxy of the user's own that ends
TLS or rewrites `Host` and adds no header leaves nothing to read, so the address is said once on
the command line and used for every request. Checked behind a TLS-terminating, `Host`-rewriting
proxy with no forwarded headers: the page's links, the device's sockets, the request log and the
code read back around an error all carried the address given.

### What the page threw (`errors.ts`, `sourcemap.ts`)

The agent reports an error as the engine gave it: a message and a place in the built file. The
laptop does the rest. It reads the script through its own server for the code around the place,
and when the script names a source map, reads that too and finds the place in the code someone
wrote. The decoder is about a hundred lines: source map v3 is one string of base64 numbers, and a
lookup walks it only as far as the line and column asked for, which in a minified bundle is one
line of up to a million segments.

Two cases are refused: a map in sections, and a place past a rewritten address on its line
through the proxy, where the laptop's copy of the file and the device's may differ in length. The
answer is then the place in the bundle.

An error also gets a hint where the message alone misleads. One of them is for a page that is not
a secure context: over plain http from another machine an engine keeps DRM, service workers and
`crypto.subtle` from the page, which on a device reads as "this device has none". In Chrome 157 the
same page had no key system to ask over the LAN address and ClearKey over loopback. The media
probe says so too, and https comes from a tunnel or the user's own proxy: a certificate of
teleport's own is one no device would trust.

### The request log (`netlog.ts`)

Every request the device makes through teleport is recorded on the laptop, so the Network panel
and `tlpt q network` cost the device nothing. It holds 5,000 requests, 16 MB a body and 256 MB of
bodies in all; the oldest go first. A request belongs to the device at its address. Where several
devices share one (behind a router, or a tunnel that names one address for a network), it goes by
browser, and a request in no device's browser, as a device's own media player makes, is shown to each.

### The copy of the tree (`mirror.ts`, `devtools.ts`)

DevTools reads the element tree far more often than the page changes it. The laptop keeps a copy
and answers tree reads from it; only what the copy lacks is asked of the page, a level at a time.
The copy also tracks which nodes DevTools has been told about, because sending a level twice
makes DevTools build new node objects and orphan the ones its panels hold.

### Asking the device (`q.ts`, `trial.ts`, `probes.ts`)

Each command is declared once in `q.ts` with its parameters. `tlpt <command>` (and `tlpt q
<command>`, the same thing) reads them from shell words, `tlpt mcp` offers them as tool arguments,
and the console's list shows them, so the three can't drift. `menu.ts` puts them in five groups in
the one order a person sees everywhere (measure, experiment, video, input, inspect: a web app on
constrained hardware first, video after), with the three things only a person does (remote,
devtools, reload) and the key each has in the console. A command for agents (`guide`, `status`)
stays out of it. All of them are thin clients of the HTTP API in `server.ts`.

Every experiment the API runs (capture, probe, trial, styles, eval, keys) is handed to
`journal.ts` as it ends, whoever asked, and kept as one line in `journal.jsonl` with its answer
scrubbed. A command made of several calls (a survey, a replay) marks them as its parts, and keeps
one line of its own instead.

A trial runs each variant several times in a fresh frame over the page, profiles every run, and
compares medians with bootstrap 95 % intervals (`packages/stats`). The device says when a run is
done; the laptop polls only every 2 s as a fallback, so the thing being measured isn't asked how
it is doing every few frames.

The `speed` probe is the yardstick for comparing devices, and a device with an emulator standing
in for it: four fixed pieces of work (script, JSON, DOM, layout), each the median of up to five
runs, in a hidden frame of its own so the app's styles and document stay out of it. A piece of
work that has taken 1.5 s gets no further run, so slow work costs one run and not five. The laptop
times the same script and JSON source in Node, so the answer also says how many times longer the
device takes than the machine the code was written on. Measured on an M2 Pro: Chromium 38's ARM
build under emulation at one CPU takes 15.7 ms for the script work, 9.4 times the laptop; its x64
build 2.9 ms.

### The console (`console.ts`, `term.ts`, `text.ts`)

The console is a pure function from its state to lines, so it is tested without a terminal.
`term.ts` redraws one region in place, under the pinned header, which the console gives a card for
each device (its state, platform, screen, cores and heap limit; the screen and cores read once per
kind of device with one small script). The region is two columns over the device rows: the five
groups of commands (`menu.ts`) on the left, and what is highlighted opened up on the right. Every
group stays open when the terminal has the rows for all of them (the entries, the groups and 14
more); on a shorter one a single group is open and each closed one names its entries. The last
line names the keys that act now (the list's, the input's while a line is typed, the remote's in
remote mode), dropped from the middle as the width shrinks and left out under 20 rows. Enter is not
among them: what it does is said once, on the input line, on an accent plate where there is colour.
A list or an answer cut off by the height says so at the end that is cut, above as well as below. With no
device, the right side says how to get one, centred. Nothing beside an entry counts up: the time it last ran is a clock time, since a count of
seconds since read as a timer still running. A reload asked for counts down the 10 s it has to come
back, on the device's row and its card, and is said in the log when it comes back or doesn't. An answer is
kept as data and drawn at the right side's width when it is shown, so a resize redraws it rather
than cutting what was printed for another width; the log gets its first line. The right side is an
explorer of the entry: its runs this session, whoever asked; for what only reads (errors, requests,
the last minute, what each key sends) the answer asked again every 2 s while it is on screen, which
the laptop answers without the device; and for the remote, the presses the device's samples already
hold. While something runs, the region redraws every 120 ms for its beam and its portal, and only then. Everything a device says passes through `printable`
before it is styled: no escape or control character of the page's reaches the terminal, so a
page can't retitle the window, clear the screen or write the clipboard of whoever is watching.

### Test runs (`drive.ts`, `client.ts`)

A test runner needs three things the rest did not have, and all three are on the laptop: the agent
and the inspector are unchanged, so a device pays nothing for them.

- **Holds.** `POST reserve` gives a run a device and a token. While the hold lasts, a `POST` that
  acts on the device without the token is answered 423, and a browser-level protocol socket without
  it doesn't list the device. Reading (`errors`, `network`, `device`) is never refused, and neither
  is the console: the person at the keyboard decides. A hold ends at `release`, when its device is
  gone for good, or when its holder makes no call for its time (120 s, 600 at most), so a runner
  that died frees its device. `clear` forgets the page's errors and moves the start of its request
  log to now, which is what "between two tests" means here.
- **The frame.** A held device shows a 3 px border in teleport's accent and the holder's name in a
  corner: one fixed element that takes no input, put there and taken away by the agent's `eval`.
  It is shown again after a reload. Its cost on a device has not been measured; `frame=0` leaves it off.
- **The browser's side of the protocol.** A device's own socket (`ws/<id>`) speaks the page's side.
  Playwright's `connectOverCDP` and Puppeteer's `connect` begin with a browser: `json/version`
  names the socket (`cdp`), and on it `Target.*` lists each device as a page and attaches to it.
  A session is a DevTools client of the device with no socket of its own, so everything DevTools
  can do, a session can. Four things are answered here instead of on the device. `Input.*` runs
  the scripts the remote's keys run (`remote.ts`), through the agent. A request's id is replaced
  by one no other client uses, since a device's reply goes to every client of it. The inspector's
  one frame, `main`, is renamed to the target's id, which is where a client looks for a page's
  main frame. And an isolated world asked for by name is announced as a context and is the page's
  own world: an old engine has the one.

Checked with Playwright 1.65 against headless Chrome 158 as the device, on this laptop: the
handshake, `page.title()`, `evaluate`, `locator`, `keyboard.press`, a raw `CDPSession`, and four
tests on two workers, each worker on its own device (2.9 s). Not checked on Chromium 38: Playwright
evaluates through a script of its own that an ES5 engine can't parse, so there `device.keys`,
`device.eval` and a raw session are the way, and `page.evaluate` is not.

### Access (`key.ts`)

The server listens on the network, because the device must reach it. So "this request is from
this laptop" can only be read off the request: its address and its `Host`. A tunnel or proxy on
the laptop that passes connections on without saying so makes a stranger's request read the same.

So what drives a device lives under `/__teleport/<key>/`: the API, DevTools' page and DevTools'
socket. The key is ten random characters in `~/.config/teleport/key`, readable only by its owner,
made the first time teleport starts and kept. `tlpt q`, `tlpt mcp` and the console's DevTools
links read it; nothing else has it. The address checks stay as a second lock.

The device's own sockets (`/ws/target`, `/ws/cdp/<id>`) need no key, as the device has none. What
arrives on them is data: it can't drive DevTools or the API, and the laptop never fetches an
address a device names.

## What holds all this

| Check | What it holds | Run by |
|---|---|---|
| `tsc` on the agent with only the ES5 and DOM libraries | No ES2015 built-in in device code | `npm run check` |
| `es-check es5` on the built agent and inspector | No ES2015 syntax | `npm run check` |
| ESLint with `eslint-plugin-es-x`, and `no-shadow` | Built-ins `tsc` misses (`TypedArray#fill`); `var x = x()` is a silent `undefined` in function scope | `npm run check` |
| Size budgets: agent 15 KB, inspector 22 KB, gzipped | Growth is a decision someone makes | `npm run check` |
| The ring and encoder on Node 4 (V8 4.5) | An early warning for engine-era problems | CI |
| The test suite | Both sides, and the relay end to end with a fake device | `npm test` |
| 12,800 Styles answers against the inspector from before the short forms | The short forms write back exactly what the long ones said | `npm test` |
| Thousands of malformed messages on all three sockets | Nothing a device sends ends teleport | `npm test` |
| The package installed into a fresh project with npm, bun, pnpm and yarn | What is published runs | CI |
| A real Chromium, driven end to end | The real DevTools frontend against the real inspector | `node scripts/e2e-chromium.mjs` |

Chromium 38 itself, x64 and ARM, in a container held to a device's memory and CPU, is where
device-side changes are measured. That lab is not in this repository. On 2026-11-19 it loaded the
agent, bundled as `@tlpt/agent` (wrapped as a bundler wraps CommonJS, then `init`) and as the tag,
in Chromium 38, 53, 64 and 68: each connected, and none of the pages threw. A control page that ran a
script none of them parse had its error caught by both the page and teleport.

## Working on it

```sh
npm install
npm run build      # the protocol, the server, the agent, the inspector, the tlpt package
npm run check      # types, ES5, size budgets
npm test           # vitest
npm run dev        # serves examples/hello-device and rebuilds as you edit
```

`just build`, `just check`, `just test` and `just all` are the same scripts by shorter names.
With lefthook installed (`lefthook install`, once), a commit runs the check and a secret scan.

On-device code must stay ES5 and inside its budget, and must never throw into, log into or slow
the app: keep `try`/`catch` in the small helpers, and make a wrapped API fall back to the app's
own. Read the comments at the top of a file before changing it; most say what was measured.

### Releasing

Both packages publish from GitHub Actions when a version tag is pushed
(`.github/workflows/release.yml`), with npm provenance. Once,
before the first release:

1. Create the npm organization `tlpt` (the free plan is enough); `@tlpt/agent` lives in it.
2. Publish each package once by hand, with two-factor authentication:
   `npm run build && npm publish -w packages/agent && npm publish -w packages/tlpt`.
3. On npmjs.com, in each package's settings, add a Trusted Publisher: GitHub Actions, repository
   `karlcode/teleport`, workflow `release.yml`, and allow direct publishing.

For each release, set the same version in `packages/tlpt/package.json` and
`packages/agent/package.json` (the only two places a version is written), commit, and push the
tag `v<version>`. The workflow checks the tag matches, builds the native executables for
`install.sh` (`packages/tlpt/sea.mjs`), runs each one on its own platform, and only then
publishes to npm and attaches the executables with their `SHA256SUMS` to a GitHub release. A
version already on npm is skipped, so the first tag can be the one published by hand.
`prepublishOnly` in both packages rebuilds and runs the checks, so a hand publish can't ship a
stale build.
