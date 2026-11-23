---
name: teleport
description: Debug and speed up a web app running on a low-end device (any old embedded browser or WebView) with measurements from the device itself, through a running teleport. Use whenever the user asks why their app is slow, janky, laggy, blank or crashing on a device, what blocks key presses, what costs memory, whether a change made it faster on the device, whether a stream, codec, key system, image format, polyfill or API works on a device and why not, or wants a capture or a trial on a device, even if they don't say "teleport".
argument-hint: "[question about the app on the device]"
allowed-tools:
  - Bash(npx --no-install teleport q status*)
  - Bash(npx --no-install teleport q devices*)
  - Bash(npx --no-install teleport q device*)
  - Bash(npx --no-install teleport q errors*)
  - Bash(npx --no-install teleport q network*)
  - Bash(npx --no-install teleport q capture*)
  - Bash(npx --no-install teleport q probe *)
  - Bash(npx --no-install teleport q styles*)
  - Bash(npx --no-install teleport q guide*)
  - Bash(npx --no-install teleport q history*)
---

# teleport

teleport runs on the laptop and reports what the app's page does on the device: frames, long tasks,
key → frame per focused element, requests, what the page threw. You read it with
`npx --no-install teleport q <command>`, which prints JSON.

Devices now: !`npx --no-install teleport q status 2>&1 || true`
Question: $ARGUMENTS

**In Codex** (or any agent that left the two lines above unfilled): run `npx --no-install teleport q status`
yourself first.

## If teleport isn't running

`q status` says "no teleport on port". Ask the user to start it in their app's folder with `npx tlpt`
(it needs `npm install -D tlpt` once) and to open the app on the device. Don't start it yourself: it takes
over the terminal as a live console and keeps running. If no device is connected, its header shows how to
link one.

## Work from measurements

1. `q history` lists the experiments already run on this kind of device, by anyone, newest first, each
   with a line of its answer: start from what is known. `q errors` says what the page threw since it loaded: uncaught errors, rejections, scripts that did not
   load, each with where, the source around it and what it likely means on that engine. `q device`
   has the last minute of 1 Hz samples; `q network` the requests.
2. Read the app's code the facts point at: an error names the file, line and column, a key press names
   the focused element and where its time went.
3. To prove a cause, `q trial` runs the variants on the device, several times each, and returns the change
   with a 95% interval.
4. After you change the code, the dev server reloads the page on the device through teleport. Measure again (`q capture` while the user presses
   keys, or the same trial) and report before and after with the numbers. Never say something is
   faster on the device without them.

## Try things on the device

- `q probe speed` says how fast the device is: four fixed pieces of work timed on it, and how many
  times longer its script takes than this laptop's. Start a performance question with it.
- `q probe media` (or `features`, `graphics`, `identity`) says what the engine can do: MediaSource and
  `canPlayType` per codec, key systems with robustness, CSS and syntax support, WebGL limits.
- `q styles` says what this engine drops from the app's CSS: selectors it can't parse, which lose
  the whole rule, and declarations it doesn't know, each with its file and line. DevTools can't show
  these, because the engine never kept them.
- `q guide <words>` says what is worth trying for a question and why it matters on a device: which profile
  numbers show it, ES5 checks that ask the engine, variants to try. `q guide` alone lists the topics.
- `q trial <file.mjs>` runs variants on the device, several times each, in a fresh blank frame over the page
  (or `where: 'page'` in the app, undone with `T.cleanup`). Every run is profiled without being asked:
  load, frames, long tasks, timer lag, key → frame, heap, DOM, forced layout, decoded images, requests,
  media, errors. The report has medians, 95% intervals against the first variant, and `notes` saying
  what each clear difference means on a device.
- A trial file's default export: `variants` (each with `html`, `scripts`, `before`, `setup`, `vars`),
  `keys` (remote keys pressed during each run), `checks` (ES5 expressions read once: the why), and
  optionally `measure` (ES5 that ends with `T.done({metric: value})` for numbers of its own), `runs`,
  `observeMs`, `assets` (name → path or URL; `T.asset(name)` on the device), and `where`.
- Everything that runs on the device is **ES5**: no arrow functions, `let`/`const`, template strings,
  classes or spread.

- `q shim on` fills in the built-ins an old engine lacks (`Object.assign`, `Array.from`, `includes`,
  `padStart`, `closest`, …) ahead of the app and reloads it, to see past the first error to the next;
  `q shim` says what it filled. It is not a fix: the build's target and polyfills are.
- `q replay save <name>` keeps the remote presses the page just saw; `q replay <name>` presses them
  again in their rhythm while capturing: the same journey, measured before and after a change.

`q trial`, `q keys`, `q eval <js>`, `q replay` and `q shim` change what is on the device, so they ask
first; say what you ran. A trial covers the screen while it runs.
`npx --no-install teleport q` lists every command.
