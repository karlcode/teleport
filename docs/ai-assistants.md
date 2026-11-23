# AI assistants

teleport doesn't run a model of its own. It hands what it measured on the device to the AI agent you
already use (Claude Code, Codex, or anything else with a shell), in three ways:

- **`tlpt q`**: one shell command per question, JSON when piped. Every command is in
  [AGENTS.md](../AGENTS.md#asking-the-device-tlpt-q).
- **`tlpt mcp`**: the same commands as MCP tools, for an agent that takes MCP servers. Setting it up
  is in [AGENTS.md](../AGENTS.md#for-ai-agents-mcp).
- **The teleport plugin**: a skill for Claude Code and Codex that knows when to ask teleport and how
  to prove a performance claim. It lives only in this checkout, and is described here.

All three reach teleport's API, which is under teleport's key
([AGENTS.md](../AGENTS.md#security)): they read the key themselves, so they must run on the laptop
running `tlpt`, as the same user.

## The plugin

The plugin is one skill, in [`plugin/skills/teleport/SKILL.md`](../plugin/skills/teleport/SKILL.md).
When you ask why the app is slow or broken on the device, it loads with the connected devices, has
the agent read what the page threw and the device's numbers before it reads code, and asks for a
trial or a capture before and after any change it claims made a difference. It pre-approves the
`q` commands that only read or measure (`status`, `devices`, `device`, `errors`, `network`,
`capture`, `probe`, `styles`, `guide`). Everything else still asks: `trial`, `try`, `verify`,
`keys` and `eval`, which change what runs on the device, and `playback`, `survey`, `advise` and
`report`, which run a script in the page or write files on the laptop. It has no hooks, no
MCP server and nothing to download.

Install it in Claude Code from this repository's marketplace, with `/plugin` and then **Add
marketplace**. In Codex, add the repository as a plugin source; the skill is `$teleport`.

## What teleport runs on your laptop

[`test/capabilities.test.ts`](../test/capabilities.test.ts) pins it, and fails when a change adds to
it: your browser, to open DevTools for each new device, and `ffmpeg`, with fixed arguments, to
make the short clips `verify` and `try <codec>` play, only when you run one of those; `tailscale`,
with fixed arguments, to find and re-point a Tailscale tunnel to your app; and the command you give
`--tunnel`, split into words. Nothing runs
through a shell, and the server
has no runtime dependencies. Code is built only to run on the device: probes, trials and the guide's
checks. The speed probe also times two of its own fixed loops on the laptop, from the same text
the device runs. A trial serves only the files it names, under unguessable paths.

## Things to ask

- "The app shows a blank screen on the device. What did it throw?"
- "What is making the device slow right now?"
- "Capture 10 seconds while I press right along the home row, and tell me what the slowest frames had in common."
- "Which requests failed in the last minute?"
- "Does our HLS stream play on this device, natively or with hls.js, and if not, why?"
- "Is the Promise polyfill dead weight on this device? Run a trial."
- "Which of our CSS does this engine drop?"
- "Does the box-shadow focus ring cost us anything when I press right along the rail?"
