# teleport

Chrome DevTools for web apps on old embedded Chromium. Three documents, each with one job:

- `README.md`: what it is and how to start, for a person.
- `AGENTS.md`: the reference for using it (88 KB). Do not read it whole: find the section with
  `grep -n "^## \|^### " AGENTS.md`.
- `ARCHITECTURE.md`: each part of the code, what was done to make it cheap or safe, and what was
  measured. Read the part you are about to change.

## Working in this repository

- `npm install`, then `just all`: it builds (`npm run build`), checks types, ES5 and both size
  budgets (`npm run check`) and runs the tests (`npm test`), as CI does. `just check` alone is what
  a commit runs through lefthook (`lefthook install`, once), with a secret scan.
- On-device code (`packages/agent`, `packages/inspector`) is ES5 for Chromium 38, has a size
  budget, and must never throw into, log into or slow the host app: `try`/`catch` lives only in
  small helpers so hot functions stay optimisable on old V8, and a wrapped API falls back to the
  app's own. Read the comments before changing it, and measure a change on the real engine.
- The laptop side is TypeScript in `packages/server/src`; `ARCHITECTURE.md` has the file map.
  Everything a device sends is checked where it is parsed, and nothing it sends may end the
  process: a new message handler goes through `reading` in `server.ts`.
- What drives a device (the API, DevTools) lives under `/__teleport/<key>/` (`key.ts`). A new
  endpoint that runs anything on a device goes there.
- Anything a device says is passed through `printable` (`text.ts`) before it is printed.
- Terminal output is checked in a pseudo-terminal as well as by tests. Keep it to what the console
  has now: a two-line header with a card under it for each device, a window on the event log, two
  columns (five groups of commands on the left, every one open when the terminal has the rows, else
  one at a time with the closed ones naming what is in them; what is highlighted opened up on the
  right: what it does, its beam while it runs, its last answer, the remote, or with no device yet
  how to get one, centred), the device rows, the input line, which is always open, and under it
  the keys that act now: a person stays in this terminal, so everything is
  reachable by typing there or moving to it. There is one list of commands (`menu.ts`, in five
  groups): a new one goes there, so the input, `tlpt <name>` and `--help` all have it, and a letter
  is only a shorter way to type an entry. A thing to flip and measure goes in `toggles.ts`. An event
  line that repeats is counted on the line before it (`say` in `console.ts`), never printed again.
  Nothing on screen counts up after it is done: a time something ran is a clock time. Green, amber
  and red are states (a device's dot, the waiting line), never numbers within their limits.
- What a test runner needs (holding a device, the browser's side of the DevTools protocol, the
  frame a held device shows) is in `drive.ts`, and its client and Playwright fixtures in
  `client.ts`, published as `tlpt/drive`. It runs on the laptop: nothing for it is added to the
  agent or the inspector.
- Every experiment the API runs is kept in the journal (`journal.ts`); a new endpoint that runs
  one on a device calls `kept` in `server.ts`.
- A number in a comment or a document says where it was measured. Don't state one you didn't
  measure, and update `ARCHITECTURE.md` when a change makes one of its numbers wrong.

## Where to look in AGENTS.md

- Using the tool: "First run", "The console", "Asking the device: `tlpt q`", "Trials", "Probes".
- Network and install questions: "How the device reaches your laptop", "Install", "Troubleshooting".
- What may reach what: "Security", "The HTTP API".
