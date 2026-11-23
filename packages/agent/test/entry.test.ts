import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const ENTRY = fileURLToPath(new URL('../src/entry.cjs', import.meta.url));

interface Agent {
  init(o?: unknown): Agent;
  stop(): Agent;
  status(): { running: boolean };
}

/** The app's bundle with `import teleport from '@tlpt/agent'` in its entry, kept as `app` for the test
 *  to call as the app would; the agent is a stub that records where it reports. */
async function bundle(mode: string) {
  const out = await build({
    stdin: { contents: "import teleport from '@tlpt/agent'; globalThis.app = teleport;", resolveDir: process.cwd() },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    logLevel: 'error',
    define: { 'process.env.NODE_ENV': JSON.stringify(mode) },
    plugins: [
      {
        name: 'tlpt',
        setup(b) {
          b.onResolve({ filter: /^@tlpt\/agent$/ }, () => ({ path: ENTRY }));
          b.onResolve({ filter: /^\.\/index\.js$/ }, () => ({ path: 'agent', namespace: 'agent' }));
          b.onLoad({ filter: /.*/, namespace: 'agent' }, () => ({
            contents:
              'var api = { version: "9.9.9", init: function (o) { reported.push(o.url); badges.push(o.badge); return api; }, stop: function () { stops.push(1); return api; }, status: function () { return { running: reported.length > 0 }; } };' +
              'if (typeof window !== "undefined" && !window.teleport) window.teleport = api; module.exports = api;',
          }));
        },
      },
    ],
  });
  return out.outputFiles[0]!.text;
}

/** Loads the bundle on a page at `href`; `extra` is what else the page's window holds. */
function load(js: string, href: string | null, extra: Record<string, unknown> = {}) {
  const reported: string[] = [];
  const badges: unknown[] = [];
  const stops: number[] = [];
  const store: Record<string, string> = { tlpt: '192.168.1.66' };
  const page: Record<string, unknown> = { reported, badges, stops, ...extra };
  if (href) {
    const u = new URL(href);
    page.location = { href: u.href, protocol: u.protocol, host: u.host, hostname: u.hostname };
    page.sessionStorage = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => (store[k] = v), removeItem: (k: string) => delete store[k] };
    page.window = page;
  }
  runInNewContext(js, page);
  return { reported, badges, stops, app: page.app as Agent, page };
}

describe.each(['production', 'development'])("import '@tlpt/agent' in a %s build", async (mode) => {
  const js = await bundle(mode);

  it('stays asleep until the app starts it, whatever the address or the tab says', () => {
    for (const href of ['https://device.example.com/app/', 'http://192.168.1.20:5173/', 'http://device.example.com/?tlpt=192.168.1.20', 'http://device.example.com/#/home?tlpt=10.0.0.5', 'http://localhost:5173/?tlpt=localhost']) {
      expect(load(js, href).reported, href).toEqual([]);
    }
  });

  it('reports to the address the app names', () => {
    const p = load(js, 'https://device.example.com/app/');
    expect(p.app.init({ url: 'ws://192.168.1.20:7070/ws/target', badge: true })).toBe(p.app);
    expect(p.reported).toEqual(['ws://192.168.1.20:7070/ws/target']);
    expect(p.badges).toEqual([true]);
  });

  it('with no address, reports to teleport on the machine that served the page', () => {
    const at = (href: string, extra?: Record<string, unknown>) => {
      const p = load(js, href, extra);
      p.app.init();
      return p.reported;
    };
    expect(at('http://192.168.1.20:5173/')).toEqual(['ws://192.168.1.20:7070/ws/target']);
    expect(at('http://localhost:5173/home')).toEqual(['ws://localhost:7070/ws/target']);
    expect(at('http://laptop.local:3000/')).toEqual(['ws://laptop.local:7070/ws/target']);
    expect(at('http://10.0.0.5:8080/', { TELEPORT_PORT: 7071 })).toEqual(['ws://10.0.0.5:7071/ws/target']);
  });

  it("reports to the page's own address when it came from elsewhere, for the dev server to pass on to teleport", () => {
    const at = (href: string) => {
      const p = load(js, href);
      p.app.init();
      return p.reported;
    };
    expect(at('https://device-app.tunnel.example/home')).toEqual(['wss://device-app.tunnel.example/__teleport/ws/target']);
    expect(at('http://dev.example:8080/')).toEqual(['ws://dev.example:8080/__teleport/ws/target']);
    // A secure page can open only a secure socket, which teleport's own port doesn't speak.
    expect(at('https://192.168.1.20:5173/')).toEqual(['wss://192.168.1.20:5173/__teleport/ws/target']);
  });

  it('never reports where the address says: only the app, or the host that served it, picks', () => {
    const p = load(js, 'http://192.168.1.20:5173/?tlpt=evil.example.com&tlpt=10.6.6.6');
    p.app.init();
    expect(p.reported).toEqual(['ws://192.168.1.20:7070/ws/target']);
  });

  it('has nowhere to report from a page no host served, and stays asleep', () => {
    const p = load(js, 'https://device.example.com/');
    (p.page.location as { hostname: string }).hostname = '';
    expect(p.app.init()).toBe(p.app);
    expect(p.reported).toEqual([]);
  });

  it('leaves the page to an agent that is already running there, such as one teleport injected', () => {
    const p = load(js, 'http://192.168.1.20:7070/', { teleport: { status: () => ({ running: true }) } });
    p.app.init();
    p.app.init({ url: 'ws://192.168.1.20:7070/ws/target' });
    expect(p.reported).toEqual([]);
    // An object of the app's own by that name, or one that throws when asked, is no agent.
    for (const teleport of [{ name: 'the app' }, { status: () => { throw new Error('mine'); } }]) {
      const mine = load(js, 'http://192.168.1.20:5173/', { teleport });
      mine.app.init();
      expect(mine.page.teleport).toBe(teleport);
    }
  });

  it("is the page's `teleport` too, so a switch flipped from a console does what the app's does", () => {
    const p = load(js, 'http://192.168.1.20:5173/');
    expect(p.page.teleport).toBe(p.app);
    (p.page.teleport as Agent).init();
    expect(p.reported).toEqual(['ws://192.168.1.20:7070/ws/target']);
    expect(p.app.status()).toEqual({ running: true });
    expect(p.app.stop()).toBe(p.app);
    expect(p.stops).toEqual([1]);
  });

  it('never throws, whatever it is passed and wherever it runs', () => {
    const p = load(js, 'http://192.168.1.20:5173/');
    for (const odd of [5, 'x', null, [], { url: {} }, { url: 7 }]) expect(() => p.app.init(odd)).not.toThrow();
    // Outside a browser, as in server-side rendering: the same calls, and nothing happens.
    const ssr = load(js, null);
    expect(() => ssr.app.init()).not.toThrow();
    expect(ssr.reported).toEqual([]);
  });
});
