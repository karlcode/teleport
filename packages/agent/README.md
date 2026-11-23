# @tlpt/agent

teleport's on-device agent on its own: ES5, no dependencies, about 9 KB gzipped. Nothing shows on
the device's screen, and it never throws into or logs into your app. Put it in your app's
build; run [`tlpt`](https://www.npmjs.com/package/tlpt) on your laptop to see what it reports.

```sh
npm install @tlpt/agent
```

It ships asleep: no buffers, timers or sockets, only its code. Importing it does nothing, in any
build, and nothing in the page's address wakes it. Your app starts it, behind whatever switch you
like (a debug menu, a build flag, a key sequence):

```js
import teleport from '@tlpt/agent';

// The teleport at an address you name:
teleport.init({ url: 'ws://192.168.1.20:7070/ws/target' });

// Or the teleport on the machine that served the page:
teleport.init();
```

With no address the agent looks only at where the page came from:

| The page came from | It reports to |
|---|---|
| this machine or a private network address, over http | teleport on that host, port 7070 (or `window.TELEPORT_PORT`) |
| anywhere else, such as your app's own tunnel, or any https page | the page's own address under `/__teleport/` |
| no host (a file, a packaged app) | nowhere: it stays asleep, so pass `url` |

For the second row, have your dev server pass `/__teleport/` on to teleport, WebSockets included,
and the device keeps opening your app's usual address. With Vite:

```js
// vite.config.js
export default {
  server: { proxy: { '/__teleport': { target: 'http://localhost:7070', ws: true } } },
};
```

The agent runs what teleport sends it (that is how `tlpt q eval` and DevTools work), so it only
ever listens to a host your code named or the host that served your app. Keep the switch out of
anything a visitor can flip: `init()` in a build you ship reports to your own site's `/__teleport/`.

`teleport.stop()` puts it back to sleep; `teleport.status()` says whether it is running and what it
costs. For a plain `<script>` tag, `@tlpt/agent/script` is the same agent as one file that starts
itself against the server it was loaded from.
