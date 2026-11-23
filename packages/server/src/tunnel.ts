// Tunnels a developer already runs, of any vendor. A tunnel forwards a public address to a port on this
// machine; tlpt finds the one that forwards to the app it was named, points it at itself while it runs,
// and points it back when it stops, so the device keeps opening the address it always opens.
//
// Each vendor is an adapter with two jobs: list the tunnels running here (public address and the local
// address each forwards to), and re-point one. Adding a vendor is adding an adapter to VENDORS; the
// rest of tlpt only sees a TunnelEndpoint. A vendor that can't re-point a running tunnel has no adapter:
// `--tunnel <command>` (tunnelCommand below) runs any vendor's own command, pointed at tlpt instead.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { appTarget } from './app.js';

/** A tunnel running on this machine, and the app behind it. */
export interface TunnelEndpoint {
  /** Which adapter found it: agent, tailscale. */
  vendor: string;
  name: string;
  /** Its public address, the one the device opens. */
  url: string;
  /** The app's local address. Null when the endpoint already forwards to teleport and only its
   *  public address was given, so nothing says where the app is. */
  app: string | null;
  /** Makes it forward to `upstream`. False when the vendor refuses. */
  point(upstream: string): Promise<boolean>;
}

/** One tunnel as an adapter lists it: where it is reached, where it forwards, and how to move that. */
export interface Found {
  vendor: string;
  name: string;
  url: string;
  /** Where it forwards now, on this machine. */
  up: URL;
  point(upstream: string): Promise<boolean>;
}

/** A tunnel vendor: lists its tunnels on this machine that forward to a local port. Never throws. */
export interface Vendor {
  name: string;
  find(): Promise<Found[]>;
}

const ASK_MS = 500;
const CHANGE_MS = 5000;
const LOCAL = /^(localhost|127(\.\d+){3}|\[::1\])$/;
const portOf = (u: URL) => Number(u.port || (u.protocol === 'https:' ? 443 : 80));

/** An upstream as a vendor writes it ("54866", "localhost:54866", "http://127.0.0.1:54866"), when it is on this machine. */
export function local(addr: unknown): URL | null {
  if (typeof addr !== 'string') return null;
  try {
    const u = new URL(/^\d+$/.test(addr) ? `http://localhost:${addr}` : /^[\w+]+:\/\//.test(addr) ? addr.replace(/^https\+insecure:/, 'https:') : `http://${addr}`);
    return LOCAL.test(u.hostname) ? u : null;
  } catch {
    return null;
  }
}

// ---- A tunnel agent's local HTTP API -------------------------------------------------------------

/** Where a tunnel agent's API answers on this machine: port 4040, or the next ones when several agents run. */
export const AGENT_APIS = [4040, 4041, 4042, 4043, 4044].map((p) => `http://127.0.0.1:${p}/api`);

type Definition = { name: string; url: string; upstream: { url: string; [k: string]: unknown }; [k: string]: unknown };

export function agentApi(apis = AGENT_APIS): Vendor {
  const list = async (api: string): Promise<Found[]> => {
    try {
      const r = await fetch(`${api}/endpoints`, { signal: AbortSignal.timeout(ASK_MS) });
      const all = r.ok ? ((await r.json()) as { endpoints?: unknown }).endpoints : null;
      if (!Array.isArray(all)) return [];
      return all.flatMap((e: Record<string, unknown>) => {
        const { uri: _uri, metrics: _metrics, ...def } = e;
        const up = local((def.upstream as { url?: unknown } | undefined)?.url);
        if (!up || typeof def.name !== 'string' || typeof def.url !== 'string' || !URL.canParse(def.url)) return [];
        const d = def as Definition;
        // The update is PUT /api/endpoints with the whole definition, only the upstream changed; /endpoints/:name is 405.
        const point = (upstream: string) =>
          fetch(`${api}/endpoints`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...d, upstream: { ...d.upstream, url: upstream } }), signal: AbortSignal.timeout(CHANGE_MS) })
            .then((res) => res.ok)
            .catch(() => false);
        return [{ vendor: 'agent', name: d.name, url: d.url, up, point }];
      });
    } catch {
      return [];
    }
  };
  return { name: 'agent', find: async () => (await Promise.all(apis.map(list))).flat() };
}

// ---- Tailscale: serve and funnel, through its own CLI -----------------------------------------------

/** Where the CLI is: on the PATH, or inside the Mac app. */
const TAILSCALE = ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];

/** Runs a vendor's CLI with fixed arguments, never through a shell: its stdout, or null. */
export type Run = (bin: string[], args: string[], ms: number) => Promise<string | null>;
const run: Run = async (bins, args, ms) => {
  for (const bin of bins) {
    const out = await new Promise<string | null | 'missing'>((done) =>
      execFile(bin, args, { timeout: ms, maxBuffer: 1 << 20 }, (e, stdout) => done(e ? ((e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : null) : stdout)),
    );
    if (out !== 'missing') return out;
  }
  return null;
};

interface ServeConfig {
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
  AllowFunnel?: Record<string, boolean>;
}

/**
 * Tailscale serves a local port on this machine's tailnet name (serve), or on the internet (funnel),
 * and `serve status --json` lists each name:port and path with the address it proxies. Running the
 * same command again with another target replaces it in place, so the address stays.
 */
export function tailscale(exec: Run = run): Vendor {
  return {
    name: 'tailscale',
    find: async () => {
      const out = await exec(TAILSCALE, ['serve', 'status', '--json'], ASK_MS * 4);
      let cfg: ServeConfig;
      try {
        cfg = JSON.parse(out ?? '{}') as ServeConfig;
      } catch {
        return [];
      }
      return Object.entries(cfg.Web ?? {}).flatMap(([hostPort, web]) =>
        Object.entries(web.Handlers ?? {}).flatMap(([path, h]) => {
          const up = local(h.Proxy);
          const m = /^(.+):(\d+)$/.exec(hostPort);
          if (!up || !m) return [];
          const [, host, port] = m as unknown as [string, string, string];
          const funnel = !!cfg.AllowFunnel?.[hostPort];
          const url = `https://${host}${port === '443' ? '' : `:${port}`}${path === '/' ? '' : path}`;
          const point = (upstream: string) =>
            exec(TAILSCALE, [funnel ? 'funnel' : 'serve', '--bg', `--https=${port}`, ...(path === '/' ? [] : [`--set-path=${path}`]), upstream], CHANGE_MS).then((o) => o !== null);
          return [{ vendor: 'tailscale', name: hostPort + path, url, up, point }];
        }),
      );
    },
  };
}

/** Every vendor tlpt can re-point, asked together. */
export const VENDORS: Vendor[] = [agentApi(), tailscale()];

/**
 * The tunnel for what teleport was given: its public address, or the local address it forwards to.
 * One already forwarding to `ownPort`, teleport's, was pointed there by a teleport that never pointed
 * it back.
 */
export async function findEndpoint(given: string, ownPort: number, vendors: Vendor[] = VENDORS): Promise<TunnelEndpoint | null> {
  const t = appTarget(given);
  if (t.kind !== 'proxy') return null;
  const want = t.origin;
  const all = (await Promise.all(vendors.map((v) => v.find().catch(() => [])))).flat();
  const found = (c: Found, app: string | null): TunnelEndpoint => ({ vendor: c.vendor, name: c.name, url: c.url, app, point: c.point });
  if (!LOCAL.test(want.hostname)) {
    const c = all.find((c) => new URL(c.url).host === want.host);
    return c ? found(c, portOf(c.up) === ownPort ? null : c.up.origin) : null;
  }
  const exact = all.find((c) => portOf(c.up) === portOf(want));
  if (exact) return found(exact, exact.up.origin);
  const stale = all.find((c) => portOf(c.up) === ownPort);
  return stale ? found(stale, want.origin) : null;
}

/** Makes the tunnel forward to `upstream`. False when the vendor refuses. */
export const pointAt = (e: TunnelEndpoint, upstream: string): Promise<boolean> => e.point(upstream).catch(() => false);

// ---- Any vendor: its own command, pointed at tlpt ----------------------------------------------------

/** The first public https address a tunnel command prints, as quick tunnels do once they are up. */
export const URL_IN_OUTPUT = /https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(?=[\s"'|>)\]]|$)/i;

export interface RunningTunnel {
  /** The public address, once the command printed one; null until then. */
  url: Promise<string | null>;
  /** Ends the command. */
  stop(): void;
  /** Called with the reason when the command ends on its own. */
  onExit(fn: (why: string) => void): void;
}

/**
 * Runs a tunnel command of any vendor pointed at tlpt's port: `{port}` in the command is the port,
 * else the port is the last word. Words split as a shell would, quotes grouping, but no shell runs.
 * The address it prints (stdout or stderr) is the device link.
 */
export function tunnelCommand(command: string, port: number, waitMs = 30_000): RunningTunnel {
  if (!command.trim()) throw new Error('--tunnel needs a command, such as "cloudflared tunnel --url http://localhost:{port}"');
  const words = splitWords(command.includes('{port}') ? command.replaceAll('{port}', String(port)) : `${command} ${port}`);
  if (!words.length) throw new Error('--tunnel needs a command, such as "cloudflared tunnel --url http://localhost:{port}"');
  const child: ChildProcess = spawn(words[0]!, words.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
  const exits: ((why: string) => void)[] = [];
  let seen = '';
  let stopped = false;
  const url = new Promise<string | null>((done) => {
    const timer = setTimeout(() => done(null), waitMs);
    timer.unref?.();
    const read = (chunk: Buffer) => {
      seen = (seen + chunk.toString()).slice(-8192);
      const m = URL_IN_OUTPUT.exec(seen);
      if (m) {
        clearTimeout(timer);
        done(m[0].replace(/\/$/, ''));
      }
    };
    child.stdout?.on('data', read);
    child.stderr?.on('data', read);
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      done(null);
      for (const fn of exits) fn(e.code === 'ENOENT' ? `${words[0]} is not installed` : e.message);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      done(null);
      if (!stopped) for (const fn of exits) fn(`${words[0]} ended (${signal ?? `exit ${code}`})${seen.trim() ? `: ${seen.trim().split('\n').pop()}` : ''}`);
    });
  });
  return {
    url,
    stop: () => {
      stopped = true;
      if (child.exitCode === null) child.kill('SIGTERM');
    },
    onExit: (fn) => void exits.push(fn),
  };
}

function splitWords(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]!);
  return out;
}
