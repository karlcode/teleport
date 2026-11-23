// The laptop side of teleport: one HTTP server that serves the app to the device with the agent in it,
// relays the agent's frames and the inspector's CDP to Chrome's DevTools, and answers the API that
// `tlpt q` and `tlpt mcp` call. Everything a device sends is raw; what it means is computed here.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { AGENT_TAG, NO_APP_PAGE, WAITING, appTarget, entryPath, proxyApp, proxyUpgrade, seenAs, seenFrom, sendFile, serveDir, trustSystemStore, typeOf, upstreamTls, type AppTarget } from './app.js';
import { report, type NetRecord, type Report } from './analyze.js';
import { networkEvents } from './cdp.js';
import { DevtoolsBridge } from './devtools.js';
import { Expander } from './expand.js';
import { ensureKey } from './key.js';
import { inlineMap, mapUrlOf, originalOf, type Original } from './sourcemap.js';
import { errorLine, excerpt, insecureContext, PageErrors, type PageError } from './errors.js';
import { describeUa } from './ua.js';
import { serveFrontend } from './frontend.js';
import type { Caller, DeviceInfo, ServerEvent } from './live.js';
import { NetLog, serverNow, type NetEntry } from './netlog.js';
import { devtoolsTrace } from './perfpanel.js';
import { isProbe, PROBES, type ProbeId } from './probes.js';
import { HEAR_SCRIPT, KeyMemory, parseHeard, pressFrom, type Heard } from './hear.js';
import { KEY, KEYS, parseSteps, pressFor, pressScript, runRemote, type KeyId, type Press, type RemoteRun } from './remote.js';
import type { ExperimentInput } from './journal.js';
import { SHIM_NAMES, SHIM_PATH, SHIM_SCRIPT, SHIM_TAG, SHIMMED_SCRIPT } from './shim.js';
import { Session } from './session.js';
import { droppedStyles } from './styles.js';
import { Link, type LinkLimits } from './link.js';
import { parseSpec, runTrial, TRIAL_BASE, TrialFiles, type TrialControl, type TrialReport, type TrialSpec } from './trial.js';
import { accept, type Peer } from './ws.js';

// Installed from npm, the built agent and inspector sit in `assets/` beside this code (see
// packages/tlpt/build.mjs). In this repository they are in each package's own dist/. Built as a
// single executable (packages/tlpt/sea.mjs), they are inside the executable, read with node:sea; there
// import.meta is empty, so it is only read otherwise. getBuiltinModule keeps Node without node:sea working.
const sea = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule?.('node:sea') as typeof import('node:sea') | undefined;
const SEA = 'sea:';
const inSea = sea?.isSea() ?? false;
const packages = inSea ? '' : fileURLToPath(new URL('../../', import.meta.url));
const shipped = inSea ? '' : fileURLToPath(new URL('../assets/', import.meta.url));
const asset = (inRepo: string, name: string) => (inSea ? SEA + name : existsSync(shipped + name) ? shipped + name : packages + inRepo);

export const BASE = '/__teleport/';
const MAX_PENDING = 1000;
/** Errors of a page whose source is read back for the lines around them, and how much is read for it. */
const NEAR_ERRORS = 8;
const NEAR_TIMEOUT_MS = 3000;
const NEAR_MAX_BYTES = 16 * 1024 * 1024;
/** The address teleport reads the app's files from itself by. */
const SELF = '127.0.0.1';
/** Line `n` of a text, counting from 1; '' when it has fewer. */
const lineOf = (text: string, n: number) => text.split('\n', n)[n - 1] ?? '';
/** How often the console hears that the inspector counted messages instead of reporting them. */
const DROPPED_EVERY_MS = 10_000;
const DETACH = '{"method":"teleport.detach"}';
/** Asks the inspector to say again what its short messages lean on. The string id keeps its reply from DevTools. */
const RESYNC = '{"id":"resync","method":"teleport.resync"}';
/** What a request under teleport's address hears when it doesn't show the key. */
const NO_KEY = "this needs teleport's key. For DevTools, press d in tlpt's console or use the link it prints; for the API, use tlpt q or tlpt mcp, which read the key themselves.";
/** Messages one inspector may send that can't be read before it is let go. */
const UNREAD_MAX = 32;
const HISTORY = 300;
const HISTORY_MAX_CHARS = 16384;
/** Where the page's console went unrecorded: the inspector stops when the last DevTools closes. */
const unrecorded = () =>
  JSON.stringify({
    method: 'Runtime.consoleAPICalled',
    params: { type: 'info', args: [{ type: 'string', value: "teleport: DevTools closed here, so the page's console went unrecorded until it opened again." }], executionContextId: 1, timestamp: Date.now() },
  });
/** What Chrome tells DevTools when the inspected page navigates: drop the console contexts and the tree. */
const NAVIGATED = ['{"method":"Runtime.executionContextsCleared","params":{}}', '{"method":"DOM.documentUpdated","params":{}}'];
/** How long a page that went away is kept, session and all, for it to come back as the same page
 *  after a dropped link. While DevTools is open on it, it is kept as long as DevTools is. */
const AWAY_MS = 120000;
/** A DevTools window whose socket dropped (teleport restarting, the laptop waking) has this long to
 *  come back on the same link. It reconnects by itself within a second or two. */
const CLIENT_LINK: LinkLimits = { graceMs: 30000, keepCount: 4096, keepBytes: 16 * 1048576 };
/** The device's inspector, through tunnels that drop links now and then. */
const INSPECTOR_LINK: LinkLimits = { graceMs: AWAY_MS, keepCount: 2048, keepBytes: 8 * 1048576 };
/** Silence after which a device socket is taken for dead. The agent hears from the server every BEAT_MS. */
const DUT_DEAD_MS = 15000;
const BEAT_MS = 4000;
/** An inspector that kept DevTools' state but finds no DevTools waits this long for one before it
 *  is told to detach: after teleport restarts, DevTools may come back a moment after the device. */
const DETACH_WAIT_MS = 5000;
const LINK_TOKEN = /^[\w-]{8,64}$/;
const AWAY = '{"teleport":"away"}';
const HERE = '{"teleport":"here"}';
/** Close code telling an agent that another page connected under its tab id. */
const REPLACED = 4000;
const TAB_ID = /^[\w-]{1,64}$/;
const PING_BURST = 5;
const PING_EVERY_MS = 15000;
const MAX_CAPTURE_MS = 10000;
/** The longest the key reader listens in one call. */
const MAX_HEAR_MS = 60_000;
const TRACE_CHUNK = 1000;
/** How long after a capture ends to wait for its last frames to arrive. */
const CAPTURE_SETTLE_MS = 1500;
/** How long an API call keeps the inspector loaded after its last use, so a run of calls loads it once. */
const LEASE_MS = 60_000;
/** An API call that needs the inspector gives up after this, inspector load included. */
const INSPECTOR_CALL_MS = 15_000;
/** How long a question waits for its page to come back on a new link: the agent's first retries are 1 s and 2 s after a drop. */
const ASK_GRACE_MS = 6000;
/** A JSON body on the API is at most this long. */
const MAX_BODY = 200_000;
/** Requests `device` and `network` answer at most. */
const MAX_REQUESTS = 300;
/** Finished trial runs remembered for a waiter that hasn't asked yet. */
const MAX_FINISHED = 64;
/** A tab whose page comes back this soon after it went reads as a reload. */
const RELOAD_WINDOW_MS = 30_000;
/** Tabs remembered for that. */
const MAX_GONE = 256;

const FILES: Record<string, string> = {
  '/teleport.js': asset('agent/dist/teleport.min.js', 'teleport.min.js'),
  '/teleport.debug.js': asset('agent/dist/teleport.js', 'teleport.js'),
  [BASE + 'inspector.js']: asset('inspector/dist/inspector.js', 'inspector.js'),
  [BASE + 'frontend/teleport-link.js']: asset('server/client/devtools-link.js', 'devtools-link.js'),
};
/** Put into DevTools' start page: keeps DevTools attached through dropped links and restarts. */
const LINK_TAG = '<script src="./teleport-link.js"></script>';

/** This machine's address on the local network, the one a device can reach. */
export function lanAddress(): string {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return 'localhost';
}

export interface DevServerOptions {
  port: number;
  host?: string;
  /** The app to serve with the agent injected: a URL to proxy or a directory to serve. */
  app?: string;
  /** Called each time a page connects, including reloads of a tab already seen. */
  onDevice?: (d: DeviceInfo) => void;
  /** Everything that happens to a device, for the console. Called synchronously; keep it cheap. */
  onEvent?: (e: ServerEvent) => void;
  /** Called when a newer teleport on this machine asks this one to give up its port. */
  onStop?: () => void;
  /** Trust any certificate the proxied app presents, not just those this machine trusts. */
  insecure?: boolean;
  /** The path of a launcher's JSON manifest whose `files` list the agent is added to, such as `/app.json`. */
  manifest?: string;
  /** The key a caller shows to drive a device. This user's own (key.ts) unless given. */
  key?: string;
  /** The address the device opens, such as `https://device.example.com`, when it reaches teleport through
   *  a proxy or port forward that doesn't say so in its headers. The app's own address in what it
   *  serves is rewritten to this, and a page opened over https here is a secure context. */
  via?: string;
  /** A tab's page connected with no DevTools on it. `opening`: a DevTools link that was waiting for a
   *  screen is opening on it. Otherwise the CLI opens DevTools for each tab that hasn't had one. */
  onTab?: (id: string, opening: boolean) => void;
  /** Where the keys each kind of device was heard sending are kept (hear.ts): this user's config folder
   *  unless given, or null to keep them only while teleport runs. */
  keyMemory?: string | null;
  /** Keeps each experiment run through the API (journal.ts): captures, probes, trials, styles, evals,
   *  key presses. A caller that marks a call as part of its own experiment (a survey, a replay) keeps
   *  that one line itself. */
  journal?: (e: ExperimentInput) => void;
}

/** The inspector's answer to one of the server's own calls. */
interface CallResult {
  result?: { value?: unknown };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

/**
 * One browser tab running the agent. The id survives reloads of the tab, so DevTools stays attached
 * while each page load gets its own socket, session and inspector. `socket` is null between pages.
 * `cdp` is the inspector's link once DevTools or an API call has loaded it.
 */
export interface Device {
  id: string;
  socket: Peer | null;
  /** Server address as the device sees it, through any tunnel. */
  host: string;
  href: string;
  ua: string;
  ip: string;
  cdp: Link | null;
  clients: Set<Link>;
  /** DevTools messages that arrived before the inspector connected. */
  pending: string[];
  session: Session;
  /** DevTools clients that enabled the Network domain. */
  network: Set<Link>;
  /** Server-clock start of the page load this device belongs to. Earlier requests aren't its. */
  since: number;
  timers: NodeJS.Timeout[];
  /** Called when this page's socket closes: a capture on it ends with what it recorded. */
  ends: Set<() => void>;
  bridge: DevtoolsBridge;
  /** The last `<Domain>.enable` or `.disable` DevTools sent, per domain, replayed to each new page. */
  enabled: Map<string, string>;
  /** DevTools request ids sent to the inspector and not answered yet. */
  inflight: Set<number>;
  /** The server's own calls to the inspector, by their string ids, waiting for an answer. */
  calls: Map<string, { ok: (r: CallResult) => void; fail: (e: Error) => void }>;
  /** Whether this page's agent answers `eval` itself, so a question needs no inspector. */
  asks: boolean;
  /** Questions out to the agent, by id, waiting for its `val` or `thr`. */
  asked: Map<string, { ok: (v: unknown) => void; fail: (e: Error) => void; line: string }>;
  /** Trial runs waiting for the device to say they are done, by run id. */
  runs: Map<string, () => void>;
  /** Runs the device said were done before the laptop waited for them: the word can land in the same packet as the start's reply. */
  finished: Set<string>;
  governor: { level: number; reason: string };
  /** What this page load threw, as its agent reports it, whether or not DevTools was ever open. */
  errors: PageErrors;
  /** Console messages and network events the inspector has counted instead of reporting, and how many of them the console was told of, and when. */
  dropped: { console: number; network: number; toldConsole: number; toldNetwork: number; at: number };
  /** Agent-clock start of the Performance panel recording in progress, if any. */
  tracingFrom: number | null;
  /** An inspector has served the DevTools now open, so the next one starts from nothing and needs
   *  DevTools' state again, unless it says it kept it (the same page, back after a dropped link). */
  served: boolean;
  /** This page load, as the agent names it: the same one after a dropped link, another after a reload. */
  page: string;
  /** What this page logged to DevTools, oldest first, for DevTools opened later on it. */
  history: string[];
  /** DevTools clients that have the history. */
  heard: WeakSet<Link>;
}

export interface DevServer {
  http: Server;
  /** The key the API and DevTools ask for: they live under `/__teleport/<key>/`. */
  key: string;
  devices: Map<string, Device>;
  netlog: NetLog;
  /** Serves another app from now on: a port, an address or a folder. Throws for a folder that isn't there. */
  setApp(app: string): void;
  close(): Promise<void>;
}

type AppHandler = (req: IncomingMessage, res: ServerResponse, path: string) => void;

/** `head` is what goes into each page's head, read per page: the agent, and the shim while it is on. */
function appHandler(t: AppTarget, insecure: boolean, manifest = '', via: URL | null = null, head: () => string = () => AGENT_TAG): AppHandler {
  if (t.kind === 'proxy') {
    const trust = upstreamTls(t.origin, insecure);
    return (req, res) => proxyApp(t.origin, req, res, head(), trust, manifest, via);
  }
  if (!existsSync(t.dir) || !statSync(t.dir).isDirectory()) throw new Error(`${t.dir}: not a folder, a URL or a port`);
  return (req, res, path) => serveDir(res, t.dir, path, head(), req);
}

/**
 * The API and DevTools' socket drive the device. They take a caller that shows the key (key.ts), and
 * as a second lock only one that reads as this machine, by a name that means this machine. The
 * server listens on the LAN for the device, and the remote address keeps other machines there out.
 * The Host keeps out a website whose name was pointed at 127.0.0.1 (DNS rebinding). A tunnel also
 * connects from this machine, with the Host rewritten to localhost, so a request it
 * forwarded, which says so in its headers, is from elsewhere. So is one an app's dev server passed
 * on: its Host names the dev server's port, not this one. A tunnel or proxy that says nothing in
 * its headers and rewrites the Host passes all of this, which is why it is the second lock.
 */
export function fromThisMachine(req: IncomingMessage) {
  const [, host = '', port = '80'] = /^(.*?)(?::(\d+))?$/.exec((req.headers.host ?? '').toLowerCase())!;
  return (
    !forwarded(req) &&
    /^(127\.|::1$|::ffff:127\.)/.test(req.socket.remoteAddress ?? '') &&
    (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') &&
    Number(port) === req.socket.localPort
  );
}

/** Whether a request came through a proxy or tunnel, by the headers they add. */
export function forwarded(req: IncomingMessage) {
  const h = req.headers;
  return !!(h['x-forwarded-for'] || h['x-forwarded-host'] || h['x-original-host'] || h.forwarded || h.via);
}

/** Rejects after `ms`, so an API call can't hang on a device that never loads the inspector. */
/** What the page's own code threw when the laptop ran it there. */
class PageThrew extends Error {}

function within<T>(ms: number, p: Promise<T>, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, fail) => setTimeout(() => fail(new Error(`${what}: no answer from the device in ${ms / 1000} s`)), ms).unref())]);
}

/** Chrome's built-in DevTools, pointed at this server's relay for one device. */
// The frontend's Content Security Policy only allows `connect-src ws://127.0.0.1:*`, so the link
// must name the loopback address even when the device reached the server by LAN IP or `localhost`.
// DevTools runs on the machine running this server, so loopback always reaches it.
export function devtoolsUrl(port: number, key: string, id: string) {
  return `devtools://devtools/bundled/devtools_app.html?ws=${clientSocket(port, key, id)}`;
}

/** Where DevTools' socket for a device is, as DevTools' `ws=` takes it: no scheme. */
const clientSocket = (port: number, key: string, id: string) => `127.0.0.1:${port}${BASE}${key}/ws/${id}`;

/** The same DevTools from an http link, served by this server (see frontend.ts). No id: the newest
 *  device, or the next one to connect. The link carries the key, so it is for this machine's eyes. */
export function inspectUrl(port: number, key: string, id?: string) {
  return `http://localhost:${port}${BASE}${key}/d${id ? '/' + id : ''}`;
}

const WELL_KNOWN = '/.well-known/appspecific/com.chrome.devtools.json';

/** What Chrome's DevTools asks a localhost page for (Automatic Workspace Folders): the project's
 *  folder, which Sources offers to connect so edits save to disk. The id is the folder's, so DevTools
 *  remembers the connection across restarts. */
function workspace(root: string) {
  const h = createHash('sha1').update(root).digest('hex');
  return { workspace: { root, uuid: `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}` } };
}

function json(res: ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(body));
}

/** A request as the API shows it: no headers, no device ip. */
function netRecord(e: NetEntry): NetRecord {
  const { id, method, url, status, type, mimeType, start, ttfb, end, bytes, failed } = e;
  return failed ? { id, method, url, status, type, mimeType, start, ttfb, end, bytes, failed } : { id, method, url, status, type, mimeType, start, ttfb, end, bytes };
}

function parse(data: Buffer | string): { id?: unknown; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown> } | null {
  try {
    return JSON.parse(data.toString());
  } catch {
    return null;
  }
}

/** The request's JSON body as an object; {} when there is none or it isn't JSON. */
function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n <= MAX_BODY) chunks.push(c);
    });
    req.on('end', () => {
      const v = n <= MAX_BODY ? parse(Buffer.concat(chunks)) : null;
      resolve(v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
    });
    req.on('error', () => resolve({}));
  });
}

/** What the page threw, as one line. */
function exceptionText(d: CallResult['exceptionDetails']): string {
  if (!d) return 'the page threw';
  const what = d.exception?.description?.split('\n')[0] ?? '';
  return `${d.text && d.text !== 'Uncaught' ? d.text + ' ' : ''}${what}`.trim() || 'the page threw';
}

export function startDevServer(opts: DevServerOptions): Promise<DevServer> {
  /** Tabs with a page connected now. */
  const devices = new Map<string, Device>();
  /** Tabs whose page went away: kept AWAY_MS for the page to come back, or while DevTools is open. */
  const detached = new Map<string, { d: Device; timer: NodeJS.Timeout | null; at: number }>();
  /** DevTools windows open on a tab teleport doesn't know yet, as after it restarts, with the page
   *  each last showed. They attach when the tab connects. */
  const waitingClients = new Map<string, Map<Link, string | null>>();
  /** Links that outlive their sockets, by kind and the token their client chose. */
  const links = new Map<string, Link>();
  /** User agents whose permessage-deflate sent something that didn't inflate. */
  const badDeflate = new Set<string>();
  /** When each tab's page last went away, so a page that comes back soon after reads as a reload. */
  const lastGone = new Map<string, number>();
  const emit = (e: ServerEvent) => opts.onEvent?.(e);
  /** Tabs whose inspector an API call holds, released LEASE_MS after the last call. */
  const leases = new Map<string, NodeJS.Timeout>();
  /** The key sequence running on each tab. A new run replaces the slot, so a stopped run's last word never overwrites it. */
  const remotes = new Map<string, { run: RemoteRun; stop: boolean }>();
  /** What each kind of device's own remote was heard sending, which the remote sends in its place. */
  const heardKeys = new KeyMemory(opts.keyMemory);
  trustSystemStore();
  if (opts.via && !/^https?:\/\/./.test(opts.via)) throw new Error(`${opts.via}: via takes the address the device opens, such as https://device.example.com`);
  const via = opts.via ? new URL(opts.via) : null;
  // The app can change while teleport runs (setApp): a port typed in the console, or a dev server found.
  let target: AppTarget | null = null;
  let serveApp: AppHandler | null = null;
  let entry = '/';
  let appDir: string | null = null;
  /** `tlpt shim on`: pages load the shim (shim.ts) after the agent, ahead of the app's own scripts. */
  let shimOn = false;
  const head = () => AGENT_TAG + (shimOn ? SHIM_TAG : '');
  /** Serves `app` from now on. Throws, changing nothing, for a folder that isn't there. */
  const useApp = (app: string | undefined) => {
    const t = app ? appTarget(app) : null;
    const handler = t ? appHandler(t, !!opts.insecure, opts.manifest ? '/' + opts.manifest.replace(/^\/+/, '') : '', via, head) : null;
    [target, serveApp, entry, appDir] = [t, handler, t ? entryPath(t) : '/', t?.kind === 'dir' ? t.dir : null];
  };
  useApp(opts.app);
  const netlog = new NetLog(via);
  let seq = 0;

  /**
   * How every socket's messages are read. What a device, its inspector or a DevTools window sends is
   * checked where it is parsed; this is for what no check foresaw. Such a message is dropped, counted
   * on its device (`unread`, which `tlpt q devices` shows) and answered by `lost`: it costs that one
   * message, never the session of every device, which an exception thrown from here would end.
   * A count above zero is a check that is missing: the fuzz test holds it at zero.
   */
  const reading =
    <A extends unknown[]>(d: Device, read: (...a: A) => void, lost: (...a: A) => void = () => {}) =>
    (...a: A) => {
      try {
        read(...a);
      } catch (e) {
        d.session.unread++;
        // TELEPORT_DEBUG=1 says where, for whoever is asked why a device shows messages not read.
        if (process.env.TELEPORT_DEBUG) console.error(e);
        lost(...a);
      }
    };

  /**
   * Whether a request is this device's. Devices are told apart by address, and where several share
   * one (behind a router, or a tunnel that names one address for a whole network) by browser. A
   * request from that address in no device's browser, as a device's own media player makes, is shown to each.
   */
  const owns = (d: Device, e: NetEntry) => {
    if (e.ip !== d.ip || e.start < d.since) return false;
    const ua = e.requestHeaders['user-agent'] ?? '';
    if (ua === d.ua) return true;
    for (const x of devices.values()) if (x !== d && x.ip === d.ip && x.ua === ua) return false;
    return true;
  };
  /** This page load's requests through teleport, oldest first. */
  const requestsOf = (d: Device) => netlog.entries.filter((e) => owns(d, e));

  netlog.onEntry((e: NetEntry) => {
    let from: string | null = null;
    for (const d of devices.values()) {
      if (!owns(d, e)) continue;
      from = d.id;
      for (const msg of networkEvents(e, d.href, (ms) => d.session.agentTime(ms))) for (const c of d.network) c.send(msg);
    }
    // tlpt's own waiting page isn't the app loading: it has no agent, and the console mustn't wait for one.
    const document = e.type === 'Document' && !e.responseHeaders[WAITING];
    emit({ type: 'request', id: from, ip: e.ip, method: e.method, url: e.url, status: e.status, ms: Math.round(e.end - e.start), failed: e.failed, document });
  });

  const port = () => (http.address() as { port: number }).port;
  const key = opts.key ?? ensureKey();
  /** Where everything that drives a device lives: the API, DevTools' page and DevTools' socket. */
  const KEYED = `${BASE}${key}/`;
  const frontendPath = (id: string) => `${BASE}frontend/devtools_app.html?ws=${clientSocket(port(), key, id)}`;
  /** DevTools links opened before any screen connected; the next screen to connect answers them. */
  const awaiting = new Set<ServerResponse>();
  const trialFiles = new TrialFiles();
  const trialing = new Set<string>();

  /** What is under the key: the API (`api/...`) and DevTools for a device (`d/<id>`, or `d` for the newest). */
  function keyed(rest: string, req: IncomingMessage, res: ServerResponse) {
    if (!fromThisMachine(req)) return json(res, { error: 'teleport answers this only on the machine it runs on' }, 403);
    if (rest.startsWith('api/')) return void api(rest.slice(4), new URL(req.url ?? '/', 'http://x'), req, res).catch((e: Error) => json(res, { error: e.message }, 409));
    if (rest !== 'd' && !rest.startsWith('d/')) return json(res, { error: 'unknown endpoint' }, 404);
    const id = rest.slice(2) || [...devices.keys()].pop();
    if (id) return void res.writeHead(302, { location: frontendPath(id), 'cache-control': 'no-store' }).end();
    // No screen yet: the tab loads until one connects, then opens as its DevTools.
    awaiting.add(res);
    res.on('close', () => awaiting.delete(res));
  }

  const http = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    const file = FILES[path];
    if (path === SHIM_PATH) {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' }).end(SHIM_SCRIPT);
    } else if (file) {
      if (file.startsWith(SEA)) res.writeHead(200, { 'content-type': typeOf(file), 'cache-control': 'no-store' }).end(Buffer.from(sea!.getRawAsset(file.slice(SEA.length)) as ArrayBuffer));
      else if (existsSync(file)) sendFile(res, file, null, req);
      else res.writeHead(404, { 'content-type': 'text/plain' }).end('not built: run `npm run build`');
    } else if (path === WELL_KNOWN && fromThisMachine(req)) {
      json(res, workspace(appDir ?? process.cwd()));
    } else if (path.startsWith(KEYED)) {
      keyed(path.slice(KEYED.length), req, res);
    } else if (path.startsWith(BASE + 'frontend/')) {
      void serveFrontend(res, path.slice((BASE + 'frontend/').length), undefined, LINK_TAG);
    } else if (path.startsWith(TRIAL_BASE)) {
      void trialFiles.serve(path.slice(TRIAL_BASE.length), req, res);
    } else if (!serveApp && !path.startsWith(BASE) && req.method === 'GET' && /text\/html/.test(req.headers.accept ?? '')) {
      // No app yet: a page that tries again, so a device opened now gets the app once one is named.
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', [WAITING]: '1' }).end(NO_APP_PAGE);
    } else if (path.startsWith(BASE) || path === BASE.slice(0, -1) || (!serveApp && path === '/')) {
      // Under teleport's own address without the key: a link from before the key, or a guess.
      json(res, { error: NO_KEY }, 403);
    } else if (serveApp && path === '/' && entry !== '/' && req.method === 'GET' && /text\/html/.test(req.headers.accept ?? '')) {
      // A device opening the bare address gets the page the app was given as, such as /chrome.
      res.writeHead(302, { location: entry, 'cache-control': 'no-store' }).end();
    } else if (serveApp) {
      netlog.record(req, res);
      serveApp(req, res, path);
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    }
  });

  const info = (d: Device): DeviceInfo => ({
    id: d.id,
    href: d.href,
    ua: d.ua,
    ip: d.ip,
    inspecting: d.clients.size > 0,
    inspect: inspectUrl(port(), key, d.id),
    devtools: devtoolsUrl(port(), key, d.id),
    started: d.session.meta.started,
    governor: d.governor,
    errors: d.errors.total,
  });

  const ping = (d: Device) => d.socket?.send(`ping ${serverNow()}`);

  /** Sends to the device's inspector, or queues until it connects. */
  const toInspector = (d: Device, msg: string) => {
    if (d.cdp) d.cdp.send(msg);
    else if (d.pending.length < MAX_PENDING) d.pending.push(msg);
  };

  // By path: the agent loads it from the address it reached teleport by, through any tunnel.
  const inspectorUrl = (d: Device) => `load ${BASE}inspector.js?id=${d.id}`;

  /** An API call needs the inspector: load it if it isn't, and hold it for LEASE_MS past the last call. */
  function lease(d: Device) {
    const held = leases.get(d.id);
    if (held) clearTimeout(held);
    else if (!d.cdp) d.socket?.send(inspectorUrl(d));
    leases.set(
      d.id,
      setTimeout(() => {
        leases.delete(d.id);
        const x = devices.get(d.id) ?? detached.get(d.id)?.d;
        // Nobody else uses it: the inspector lets go of the page.
        if (x?.cdp && !x.clients.size) x.cdp.send(DETACH);
      }, LEASE_MS),
    );
  }

  /**
   * A style sheet's text, for `styles`. The device names the address, and a device is whoever
   * connects, so the laptop never fetches what it is told to: it reads only a sheet on the address
   * the device reached teleport by, and reads it from this server itself, by path. That is the
   * app's own file, which the device could fetch anyway. teleport's own routes are not the app's.
   */
  async function readSheet(d: Device, href: string): Promise<string> {
    const u = new URL(href);
    if (u.host !== d.host) throw new Error("another origin's sheet; only the ones that come through tlpt are read");
    if (u.pathname.startsWith(BASE)) throw new Error('not a style sheet');
    const at = http.address();
    const host = at && typeof at === 'object' && at.address !== '::' && at.address !== '0.0.0.0' ? (at.family === 'IPv6' ? `[${at.address}]` : at.address) : '127.0.0.1';
    const r = await fetch(`http://${host}:${at && typeof at === 'object' ? at.port : opts.port}${u.pathname}${u.search}`, { signal: AbortSignal.timeout(5000), redirect: 'error' });
    if (!r.ok) throw new Error(`answered ${r.status}`);
    return r.text();
  }

  /** One of the server's own calls to the inspector. String ids keep them apart from DevTools' numbers. */
  function call(d: Device, method: string, params: Record<string, unknown>, what: string, ms = INSPECTOR_CALL_MS): Promise<CallResult> {
    if (!d.socket) return Promise.reject(new Error('the page went away'));
    lease(d);
    const id = `q:${++seq}`;
    const p = new Promise<CallResult>((ok, fail) => d.calls.set(id, { ok, fail }));
    toInspector(d, JSON.stringify({ id, method, params }));
    return within(ms, p, what).finally(() => d.calls.delete(id));
  }

  /** Runs ES5 on the device and resolves with its value; rejects with what the page threw. The
   *  agent answers it itself where it can: one message each way on the socket that is already
   *  open, and no inspector loaded. `viaInspector` is for code that needs the inspector in the page. */
  async function evaluate(d: Device, expression: string, what: string, awaitPromise = false, viaInspector = false, ms = INSPECTOR_CALL_MS): Promise<unknown> {
    if (d.asks && !viaInspector) {
      const id = (++seq).toString(36);
      const line = `eval ${id} ${awaitPromise ? 1 : 0} ${expression}`;
      const p = new Promise<unknown>((ok, fail) => d.asked.set(id, { ok, fail, line }));
      // Between links the question waits: the page asks for what it missed when it is back. One
      // that stays away is gone.
      if (d.socket) d.socket.send(line);
      else if (!d.page) d.asked.get(id)!.fail(new Error('the page went away'));
      else setTimeout(() => d.socket === null && d.asked.get(id)?.fail(new Error('the page went away')), ASK_GRACE_MS).unref();
      try {
        return await within(ms, p, what);
      } catch (e) {
        throw e instanceof PageThrew ? new Error(`${what}: ${e.message}`) : e;
      } finally {
        d.asked.delete(id);
      }
    }
    const r = await call(d, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, what, ms);
    if (r.exceptionDetails) throw new Error(`${what}: ${exceptionText(r.exceptionDetails)}`);
    return r.result?.value;
  }

  /** A remote step's script: it answers '' when done, else what went wrong. */
  async function step(d: Device, script: string, what: string) {
    const v = await evaluate(d, script, what);
    if (typeof v === 'string' && v) throw new Error(v);
  }
  const press = (d: Device, p: Press, ok: boolean) => step(d, pressScript(p, ok), `key ${p.key || p.keyCode}`);

  /**
   * What the page hears for `ms` (none: what it heard since the last read), named, and the keys the
   * device was heard to send differently from the remote, which the remote sends from now on.
   */
  async function hear(d: Device, ms: number, forget: boolean) {
    if (forget) heardKeys.forget(d.ua);
    const read = async () => parseHeard(await evaluate(d, HEAR_SCRIPT, 'hear'));
    const heard: Heard[] = await read();
    const end = Date.now() + ms;
    // Read at least every second, so the listener in the page, which leaves after 5 s unread, stays.
    while (Date.now() < end && d.socket) {
      await new Promise((r) => setTimeout(r, Math.min(1000, end - Date.now())));
      heard.push(...(await read()));
    }
    const t0 = heard[0]?.t ?? 0;
    for (const h of heard) h.t = Math.max(0, h.t - t0);
    const learned = heardKeys.learn(d.ua, heard, (id) => pressFor(KEY[id]));
    return { heard, learned, sends: sendsOf(d) };
  }

  /** What each of the remote's main keys sends on this device now. */
  function sendsOf(d: Device) {
    const mine = heardKeys.of(d.ua);
    return Object.fromEntries((['ok', 'back', 'up', 'down', 'left', 'right'] as const).map((id) => [id, pressFor(KEY[id], mine)]));
  }

  /** Sets, or with no press resets, what a remote key sends on this kind of device. Answers what it sends now, or what was wrong. */
  function keymap(d: Device, id: string | null, said: string | null): { platform: string; sends: Record<string, Press>; mapped: string[] } | { error: string } {
    if (id !== null) {
      if (!(id in KEY)) return { error: `no remote key ${id}: one of ${Object.keys(KEY).join(', ')}` };
      const press = said === null || said === 'reset' ? null : pressFrom(said);
      if (said !== null && said !== 'reset' && !press) return { error: `${said} is not a key code or a key name teleport knows (GamepadA, Enter, ...)` };
      heardKeys.set(d.ua, id as KeyId, press);
    }
    return { platform: describeUa(d.ua).split(' · ')[0] || 'unknown', sends: sendsOf(d), mapped: Object.keys(heardKeys.of(d.ua)) };
  }

  function capture(d: Device, ms: number): Promise<Report> {
    const dur = Math.min(Math.max(ms, 500), MAX_CAPTURE_MS);
    const s = d.session;
    const from = s.agentTime(serverNow());
    d.socket?.send(`capture ${dur}`);
    // Not in d.timers, which a reload clears. A page that goes away (a reload, a link, the device) ends
    // the capture then, with what the session it started on recorded, and says it was cut short.
    return new Promise((done) => {
      const end = (gone: boolean) => {
        clearTimeout(timer);
        d.ends.delete(left);
        const at = Math.min(from + dur, s.agentTime(serverNow()));
        const cut = gone && at < from + dur;
        const r = report(s.timeline, from, cut ? at : from + dur, s.meta.names);
        done(cut ? { ...r, cutShort: { askedS: dur / 1000, why: 'the page went away' } } : r);
      };
      const left = () => end(true);
      const timer = setTimeout(() => end(false), dur + CAPTURE_SETTLE_MS);
      d.ends.add(left);
    });
  }

  const trialControl = (d: Device, stopped: () => boolean = () => false): TrialControl => ({
    stopped,
    // A trial's runner tells the laptop it is done through the inspector, and reads the laptop's address from it.
    start: async (script) => {
      const v = await evaluate(d, script, 'trial', false, true);
      if (typeof v === 'string' && v) throw new Error(v);
    },
    poll: (script) => evaluate(d, script, 'trial', false, true),
    wait: (id, ms) =>
      new Promise((r) => {
        if (d.finished.delete(id)) return r();
        const done = () => {
          clearTimeout(timer);
          d.runs.delete(id);
          r();
        };
        const timer = setTimeout(done, ms);
        d.runs.set(id, done);
      }),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    alive: () => d.socket !== null,
  });

  /** A trial from the API. Answers the report, or what was wrong with the spec. */
  async function trial(d: Device, body: Record<string, unknown>, by: Caller, stopped: () => boolean): Promise<TrialReport | { error: string }> {
    let spec: TrialSpec;
    let paths: Record<string, string>;
    try {
      spec = parseSpec(body.spec);
      paths = Object.fromEntries(Object.entries(spec.assets).map(([k, v]) => [k, trialFiles.register(v)]));
    } catch (e) {
      return { error: (e as Error).message };
    }
    trialing.add(d.id);
    const total = spec.variants.length * spec.runs;
    const tell = (done: number, phase: 'start' | 'run' | 'end') => emit({ type: 'trial', id: d.id, by, name: spec.name, done, total, phase });
    tell(0, 'start');
    let done = 0;
    try {
      return await runTrial(trialControl(d, stopped), spec, { id: d.id, ua: d.ua }, { paths, onProgress: (n) => tell((done = n), 'run') });
    } finally {
      trialing.delete(d.id);
      tell(done, 'end');
    }
  }

  /** A probe's raw answer from the device, parsed here. Throws with what went wrong on the device. */
  async function probe<K extends ProbeId>(d: Device, id: K) {
    const p = PROBES[id];
    return p.parse(await evaluate(d, p.script, `probe ${id}`, true, false, p.waitMs));
  }

  /** Starts a key sequence on the device; a run already going is stopped first. Resolves when the run ends. */
  function startRemote(d: Device, steps: ReturnType<typeof parseSteps>): Promise<RemoteRun> {
    const old = remotes.get(d.id);
    if (old) old.stop = true;
    const run: RemoteRun = { steps, loop: false, phase: 'running', step: 0, press: 0, presses: 0, error: null };
    const slot = { run, stop: false };
    remotes.set(d.id, slot);
    if (!steps.length) {
      run.phase = 'failed';
      run.error = 'nothing to press';
      return Promise.resolve(run);
    }
    return runRemote(
      { press: (p, ok) => press(d, p, ok), evaluate: (script, what) => step(d, script, what), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), update: () => {}, stopped: () => slot.stop || d.socket === null },
      run,
      heardKeys.of(d.ua),
    );
  }

  /** The device's requests, newest last, filtered. Times are page time. */
  function networkOf(d: Device, urlPart: string, minMs: number, failedOnly: boolean, limit: number) {
    const offsetMs = d.session.meta.offsetMs;
    const out = requestsOf(d)
      .map(netRecord)
      .filter((r) => (!urlPart || r.url.includes(urlPart)) && r.end - r.start >= minMs && (!failedOnly || !!r.failed || r.status >= 400))
      .map((r) => ({ ...r, start: r.start + offsetMs, ttfbMs: r.ttfb - r.start, durMs: r.end - r.start, ttfb: undefined, end: undefined }));
    return out.slice(-Math.min(Math.max(limit, 1), MAX_REQUESTS));
  }

  /** What a device looks like right now, for the HTTP API and the MCP tools built on it. */
  function snapshot(d: Device, seconds: number) {
    const ps = d.session.points;
    return {
      device: info(d),
      latest: d.session.lastPoint(),
      points: ps.slice(-Math.max(1, Math.min(seconds, ps.length))),
      keyTargets: d.session.targets(),
      stats: d.session.stats(d.cdp?.bytesIn),
      requests: requestsOf(d).slice(-50).map(netRecord),
    };
  }

  /**
   * The presses the device's page saw in the last `seconds`, oldest first, each with the remote key it
   * is (by what that key sends on this kind of device), so `tlpt replay` can press them again.
   */
  function pressesOf(d: Device, seconds: number) {
    const inp = d.session.timeline.input!;
    const t = inp.t ?? [];
    const codes = inp.keyCode ?? [];
    const now = d.session.lastPoint()?.t ?? (t.length ? t[t.length - 1]! : 0);
    const learned = heardKeys.of(d.ua);
    const idOf = (code: number) => KEYS.find((k) => pressFor(k, learned).keyCode === code)?.id ?? KEYS.find((k) => k.press.keyCode === code)?.id ?? null;
    const from = now - Math.min(Math.max(seconds, 1), 600) * 1000;
    const out: { t: number; keyCode: number; key: KeyId | null }[] = [];
    for (let i = 0; i < t.length; i++) if (t[i]! >= from) out.push({ t: t[i]!, keyCode: codes[i]!, key: idOf(codes[i]!) });
    return { id: d.id, from, to: now, presses: out };
  }

  /**
   * `tlpt shim`: GET says whether it is on and what the device's page filled; POST with on=1 or on=0
   * turns it on or off for every page from now, and reloads the devices into it.
   */
  async function shim(d: Device | undefined, req: IncomingMessage, res: ServerResponse, by: Caller) {
    const url = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'POST') {
      const on = url.searchParams.get('on') === '1';
      const reloaded = on === shimOn ? [] : [...devices.values()].filter((x) => x.socket);
      shimOn = on;
      for (const x of reloaded) {
        x.socket!.send('reload');
        emit({ type: 'call', id: x.id, by, what: `shim ${on ? 'on' : 'off'}: reloading`, phase: 'end', ms: 0 });
      }
      return json(res, { on, reloaded: reloaded.map((x) => x.id), names: SHIM_NAMES });
    }
    let filled: string[] | null = null;
    if (d) {
      try {
        const v = await evaluate(d, SHIMMED_SCRIPT, 'shim');
        filled = typeof v === 'string' ? (JSON.parse(v) as string[] | null) : null;
      } catch {
        filled = null;
      }
    }
    return json(res, { on: shimOn, id: d?.id ?? null, filled, names: SHIM_NAMES });
  }

  /** The API under the key: `rest` is the endpoint. The `x-teleport` header only names the caller for the console. */
  async function api(rest: string, url: URL, req: IncomingMessage, res: ServerResponse) {
    const q = (k: string) => url.searchParams.get(k);
    // A device whose link dropped a moment ago is still there to ask: its page is likely on its way back.
    const d = q('id') ? (devices.get(q('id')!) ?? backSoon(q('id')!)) : [...devices.values()].pop();
    const asked = req.headers['x-teleport'];
    const by: Caller = asked === 'console' || asked === 'q' || asked === 'mcp' ? asked : 'other';
    /** Keeps an experiment in the journal, unless the caller keeps it as part of its own. */
    const part = req.headers['x-teleport-part'] === '1';
    const kept = (kind: string, what: string, t0: number, result?: unknown, error?: string) => {
      if (!part && d && opts.journal) opts.journal({ id: d.id, ua: d.ua, href: d.href, by, kind, what: what.replace(/\s+/g, ' '), ms: Date.now() - t0, result, error });
    };
    /** Runs something on the device, telling the console when it starts and how it ended. */
    const traced = async <T>(said: string, fn: () => Promise<T>): Promise<T> => {
      // One line: an agent's eval is often several, and a newline in a live region breaks its redraw.
      const what = said.replace(/\s+/g, ' ');
      const t0 = Date.now();
      emit({ type: 'call', id: d!.id, by, what, phase: 'start' });
      try {
        const v = await fn();
        emit({ type: 'call', id: d!.id, by, what, phase: 'end', ms: Date.now() - t0 });
        return v;
      } catch (e) {
        emit({ type: 'call', id: d!.id, by, what, phase: 'end', ms: Date.now() - t0, error: (e as Error).message });
        throw e;
      }
    };
    // A newer tlpt of this user's asks this one to leave the port.
    if (rest === 'stop') {
      if (req.method !== 'POST' || !opts.onStop) return json(res, { error: 'not allowed' }, 403);
      json(res, { stopping: true });
      return void setImmediate(opts.onStop);
    }
    if (rest === 'live') return json(res, [...devices.values()].map((x) => ({ ...snapshot(x, 0), points: undefined, requests: undefined })));
    if (rest === 'shim') return shim(d, req, res, by);
    if (!d) return json(res, { error: q('id') ? 'no such device' : 'no device connected' }, 404);
    if (rest === 'presses') return json(res, pressesOf(d, Number(q('seconds')) || 60));
    if (rest === 'device') return json(res, snapshot(d, Number(q('seconds')) || 60));
    if (rest === 'errors') return json(res, { id: d.id, href: d.href, engine: describeUa(d.ua), total: d.errors.total, errors: d.errors.list() });
    if (rest === 'network') return json(res, networkOf(d, q('url') ?? '', Number(q('minMs')) || 0, q('failed') === '1', Number(q('limit')) || 50));
    const t0 = Date.now();
    if (rest === 'styles') {
      try {
        const r = await traced('styles', () => droppedStyles((script) => evaluate(d, script, 'styles'), (href) => readSheet(d, href)));
        kept('styles', 'styles', t0, r);
        return json(res, r);
      } catch (e) {
        kept('styles', 'styles', t0, undefined, (e as Error).message);
        return json(res, { error: (e as Error).message }, 502);
      }
    }
    if (rest === 'probe') {
      const name = q('name') ?? '';
      if (!isProbe(name)) return json(res, { error: `name must be one of ${Object.keys(PROBES).join(', ')}` }, 400);
      try {
        const r = await traced(`probe ${name}`, () => probe(d, name));
        kept('probe', `probe ${name}`, t0, r);
        return json(res, r);
      } catch (e) {
        kept('probe', `probe ${name}`, t0, undefined, (e as Error).message);
        return json(res, { error: (e as Error).message }, 502);
      }
    }
    if (rest === 'keymap' && req.method !== 'POST') return json(res, keymap(d, null, null));
    // What follows changes the page or holds the device for a while.
    if (req.method !== 'POST') return json(res, { error: 'use POST' }, 405);
    if (rest === 'keymap') {
      const r = keymap(d, q('key'), q('code'));
      return json(res, r, 'error' in r ? 400 : 200);
    }
    if (rest === 'eval') {
      try {
        // In the body, so its length isn't a URL's: past about 10 KB a URL is refused before it is read.
        const said = (await jsonBody(req)).expr;
        const expr = typeof said === 'string' ? said : (q('expr') ?? '');
        const one = expr.replace(/\s+/g, ' ').trim();
        const what = `eval ${one.length > 60 ? one.slice(0, 59) + '…' : one}`;
        try {
          const value = await traced(what, () => evaluate(d, expr, 'eval'));
          kept('eval', what, t0, { value });
          return json(res, { value });
        } catch (e) {
          kept('eval', what, t0, undefined, (e as Error).message);
          throw e;
        }
      } catch (e) {
        return json(res, { error: (e as Error).message }, 502);
      }
    }
    if (rest === 'keys') {
      const body = await jsonBody(req);
      const steps = parseSteps(q('seq') ?? body.steps);
      const what = `keys ${q('seq') ?? `${steps.length} steps`}`;
      const run = await traced(what, () => startRemote(d, steps));
      kept('keys', what, t0, run, run.error ?? undefined);
      return json(res, run);
    }
    if (rest === 'hear') {
      const ms = Math.min(Math.max(Number(q('ms')) || 0, 0), MAX_HEAR_MS);
      try {
        return json(res, await traced(`hear ${Math.round(ms / 1000)} s`, () => hear(d, ms, q('forget') === '1')));
      } catch (e) {
        return json(res, { error: (e as Error).message }, 502);
      }
    }
    if (rest === 'capture') {
      const ms = Math.min(Math.max(Number(q('ms')) || MAX_CAPTURE_MS, 500), MAX_CAPTURE_MS);
      const what = `capture ${Math.round(ms / 100) / 10} s`;
      const r = await traced(what, () => capture(d, ms));
      kept('capture', what, t0, r);
      return json(res, r);
    }
    if (rest === 'trial') {
      if (trialing.has(d.id)) return json(res, { error: 'a trial is already running on this device' }, 409);
      // A caller that stops waiting (ctrl+c in q, esc esc in the console) stops the trial after its current run.
      let stopped = false;
      res.on('close', () => void (res.writableEnded || (stopped = true)));
      const r = await trial(d, await jsonBody(req), by, () => stopped);
      kept('trial', `trial ${'error' in r ? '' : r.name}`.trim(), t0, 'error' in r ? undefined : r, 'error' in r ? r.error : r.truncated ? 'stopped before every run' : undefined);
      return json(res, r, 'error' in r ? 400 : 200);
    }
    json(res, { error: 'unknown endpoint' }, 404);
  }

  /** Turns the inspector's DevTools side off. A lease keeps it loaded for the API's calls. */
  function devtoolsDone(d: Device) {
    d.cdp?.send(DETACH);
    if (d.history.length && !leases.has(d.id)) remember(d, unrecorded());
    d.served = false;
    d.pending = [];
    d.enabled.clear();
    d.inflight.clear();
    d.bridge.reset();
  }

  type Page = Pick<Device, 'socket' | 'host' | 'href' | 'ua' | 'ip' | 'session' | 'since' | 'timers' | 'page' | 'asks'>;

  /** A page error as DevTools' Console shows an uncaught exception, with what it most likely means. */
  function asException(e: PageError): string {
    const text = errorLine(e) + (e.hint ? `\n${e.hint}` : '');
    const exception = e.stack ? { type: 'object', subtype: 'error', className: 'Error', description: e.stack } : undefined;
    const details = { exceptionId: 1_000_000 + e.n, text: exception ? 'Uncaught' : text, lineNumber: Math.max(0, e.line - 1), columnNumber: Math.max(0, e.col - 1), url: e.src, exception };
    return JSON.stringify({ method: 'Runtime.exceptionThrown', params: { timestamp: Date.now(), exceptionDetails: details } });
  }

  /** The inspector's running counts of what it did not report. The console hears of new ones, not more often than every 10 s. */
  function droppedSoFar(d: Device, con: number, net: number) {
    d.dropped.console = Math.max(d.dropped.console, con);
    d.dropped.network = Math.max(d.dropped.network, net);
    const c = d.dropped.console - d.dropped.toldConsole;
    const n = d.dropped.network - d.dropped.toldNetwork;
    if ((!c && !n) || Date.now() - d.dropped.at < DROPPED_EVERY_MS) return;
    d.dropped.toldConsole = d.dropped.console;
    d.dropped.toldNetwork = d.dropped.network;
    d.dropped.at = Date.now();
    emit({ type: 'dropped', id: d.id, console: c, network: n });
  }

  /** An agent's `err` or `errs` line: what the page threw, from its first script on. */
  function pageError(d: Device, line: string) {
    if (line.startsWith('errs ')) {
      if (d.errors.count(line.slice(5))) emit({ type: 'errors', id: d.id, total: d.errors.total });
      return;
    }
    const e = line.startsWith('err ') ? d.errors.take(line.slice(4)) : null;
    if (!e) return;
    // With no inspector on the page nothing else tells DevTools, so a DevTools opened later still
    // shows what the page threw while it started. A script that did not load is never an exception
    // to the inspector, so that always goes.
    if (!d.cdp || e.kind === 'resource') {
      const msg = asException(e);
      remember(d, msg);
      for (const c of d.clients) if (d.heard.has(c)) c.send(msg);
    }
    // In the order they were thrown, though reading the source around one takes longer than another.
    const before = said.get(d) ?? Promise.resolve();
    said.set(
      d,
      before
        .then(() => locate(d, e))
        .then((at) => {
          e.near = at.near;
          e.from = at.from;
          emit({ type: 'error', id: d.id, error: e, total: d.errors.total });
        }),
    );
  }

  /** Each device's errors still being said, so the next waits its turn. */
  const said = new WeakMap<Device, Promise<void>>();

  /** A file of the app's as text, read through teleport itself by its path: only one on the address
   *  the device reached teleport by, and never one of teleport's own. Null when it can't be read. */
  const sources = new Map<string, Promise<string | null>>();
  function ownFile(d: Device, href: string): Promise<string | null> {
    let u: URL;
    try {
      u = new URL(href);
    } catch {
      return Promise.resolve(null);
    }
    if (u.host !== d.host || u.pathname.startsWith(BASE)) return Promise.resolve(null);
    const key = `${d.id} ${d.page} ${u.pathname}${u.search}`;
    let text = sources.get(key);
    if (!text) {
      text = fetch(`http://${SELF}:${port()}${u.pathname}${u.search}`, { signal: AbortSignal.timeout(NEAR_TIMEOUT_MS) })
        .then(async (r) => (r.ok && Number(r.headers.get('content-length') ?? 0) <= NEAR_MAX_BYTES ? await r.text() : null))
        .catch(() => null);
      sources.set(key, text);
      if (sources.size > 16) sources.delete(sources.keys().next().value!);
    }
    return text;
  }

  /**
   * Where an error is, for a person: the code around it, and the place in the code they wrote when
   * the build left a source map. Both are read through teleport itself, so only for a file that
   * came through it, and only for the first few errors of a page.
   */
  async function locate(d: Device, e: PageError): Promise<Pick<PageError, 'near' | 'from'>> {
    if (e.kind !== 'error' || !e.src || e.line < 1 || e.n >= NEAR_ERRORS) return { near: null, from: null };
    const body = await ownFile(d, e.src);
    if (body === null) return { near: null, from: null };
    const near = excerpt(body, e.line, e.col);
    const o = await original(d, e, body);
    // The map's own text for the line where it has it: what was written, not what the build made of it.
    return o ? { from: { src: o.source, line: o.line, col: o.col }, near: (o.text !== null ? excerpt(o.text, 1, o.col) : null) ?? near } : { near, from: null };
  }

  async function original(d: Device, e: PageError, body: string): Promise<Original | null> {
    const named = mapUrlOf(body);
    if (!named) return null;
    // Through the proxy, the app's own address in a file was rewritten to the address of whoever
    // asked for it: the device's in its copy, this laptop's in the one read here. The two copies
    // are the same up to the first such place on a line, so past one the device's column may be
    // another character here, and the map isn't asked: no place, never the wrong one.
    if (target?.kind === 'proxy' && lineOf(body, e.line).slice(0, e.col).includes(`${SELF}:${port()}`)) return null;
    try {
      const text = inlineMap(named) ?? (await ownFile(d, new URL(named, e.src).href));
      return text === null ? null : originalOf(JSON.parse(text), e.line, e.col);
    } catch {
      return null;
    }
  }

  function remember(d: Device, msg: string) {
    if (msg.length > HISTORY_MAX_CHARS) return;
    d.history.push(msg);
    if (d.history.length > HISTORY) d.history.shift();
  }

  /** Gives a DevTools client what the page logged before it came, once, after the page's context. */
  function catchUp(d: Device, c: Link) {
    if (d.heard.has(c)) return;
    d.heard.add(c);
    for (const msg of d.history) c.send(msg);
  }

  function newDevice(id: string, page: Page): Device {
    const d: Device = {
      id,
      ...page,
      cdp: null,
      clients: new Set(),
      pending: [],
      network: new Set(),
      bridge: new DevtoolsBridge(
        (msg) => toInspector(d, msg),
        (msg) => {
          for (const c of d.clients) c.send(msg);
        },
      ),
      enabled: new Map(),
      inflight: new Set(),
      ends: new Set(),
      calls: new Map(),
      asked: new Map(),
      runs: new Map(),
      finished: new Set(),
      governor: { level: 0, reason: '' },
      errors: new PageErrors(() => describeUa(d.ua), () => insecureContext(d.href)),
      dropped: { console: 0, network: 0, toldConsole: 0, toldNetwork: 0, at: 0 },
      tracingFrom: null,
      served: false,
      history: [],
      heard: new WeakSet(),
    };
    return d;
  }

  /** Disconnects the inspector, failing the requests it will never answer. */
  function dropInspector(d: Device) {
    const cdp = d.cdp;
    d.cdp = null;
    cdp?.close();
    for (const id of d.inflight) {
      const msg = JSON.stringify({ id, error: { code: -32000, message: 'The page went away' } });
      for (const c of d.clients) c.send(msg);
    }
    d.inflight.clear();
    failCalls(d);
    d.bridge.reset();
  }

  /** Fails the server's own calls to a page that went away: an API caller hears now, not at a timeout. */
  /** A tab whose page answers questions and went away within the wait a question is given. */
  function backSoon(id: string): Device | undefined {
    const k = detached.get(id);
    return k && k.d.asks && k.d.page !== '' && Date.now() - k.at < ASK_GRACE_MS ? k.d : undefined;
  }

  function failAsked(d: Device) {
    for (const a of d.asked.values()) a.fail(new Error('the page went away'));
    d.asked.clear();
  }

  /** An agent's `val` or `thr` line: the answer to a question. False for any other line. */
  function answered(d: Device, line: string): boolean {
    const isValue = line.startsWith('val ');
    if (!isValue && !line.startsWith('thr ')) return false;
    const at = line.indexOf(' ', 4);
    const a = d.asked.get(line.slice(4, at < 0 ? undefined : at));
    if (!a) return true;
    const rest = at < 0 ? '' : line.slice(at + 1);
    if (!isValue) a.fail(new PageThrew(rest || 'the page threw'));
    else if (rest === '') a.ok(undefined);
    else {
      try {
        a.ok(JSON.parse(rest));
      } catch {
        a.fail(new Error("the device's answer wasn't JSON"));
      }
    }
    return true;
  }

  function failCalls(d: Device) {
    for (const c of d.calls.values()) c.fail(new Error('the page went away'));
    d.calls.clear();
    for (const done of [...d.runs.values()]) done();
  }

  function addDevice(ws: Peer, req: IncomingMessage, query: URLSearchParams) {
    const asked = query.get('id') ?? '';
    const id = TAB_ID.test(asked) ? asked : randomBytes(4).toString('hex');
    devices.get(id)?.socket?.close(REPLACED, 'another page connected with this tab id');
    const kept = detached.get(id);
    if (kept) {
      if (kept.timer) clearTimeout(kept.timer);
      detached.delete(id);
    }
    const href = query.get('href') ?? '';
    const ua = req.headers['user-agent'] ?? '';
    const ip = seenFrom(req);
    const pageId = query.get('page') ?? '';
    // The same page, back after its link dropped: it carries on in its session, and DevTools keeps
    // what it has. The agent is told how much of each stream the session holds and sends the rest.
    const relink = !!kept && pageId !== '' && kept.d.page === pageId;
    const resumed = relink && Date.now() - kept!.at < AWAY_MS ? kept!.d : null;
    if (resumed) resumed.session.reopen();
    // A tab kept only for its page to come back had nobody waiting on it.
    const waited = !!kept && kept.d.clients.size > 0;
    const page: Page = {
      socket: ws,
      host: seenAs(req, via).host,
      href,
      ua,
      ip,
      session: resumed?.session ?? new Session({ device: id, href, ua, ip }),
      since: resumed?.since ?? netlog.navigationStart(ip, serverNow()),
      timers: [],
      page: pageId,
      asks: query.get('e') === '1',
    };
    const d = kept ? Object.assign(kept.d, page) : newDevice(id, page);
    // Another page in the tab: the one that was asked is gone.
    if (kept && !relink) failAsked(kept.d);
    if (kept && !relink) {
      d.history = [];
      d.heard = new WeakSet();
      d.errors.clear();
      d.dropped = { console: 0, network: 0, toldConsole: 0, toldNetwork: 0, at: 0 };
    }
    const replaced = devices.has(id);
    devices.set(id, d);
    const goneAt = lastGone.get(id);
    lastGone.delete(id);
    const kind = relink ? 'relink' : waited || replaced || (goneAt !== undefined && Date.now() - goneAt < RELOAD_WINDOW_MS) ? 'reload' : 'new';
    ws.onMessage(
      reading(d, (data, isBinary) => {
        if (!isBinary) {
          const line = data.toString();
          if (!answered(d, line) && !d.session.text(line)) pageError(d, line);
          return;
        }
        if (d.session.frame(data)) emit({ type: 'sample', id: d.id });
      }),
    );
    ws.onClose(() => {
      if (d.socket !== ws) return;
      d.socket = null;
      devices.delete(d.id);
      for (const t of d.timers) clearTimeout(t);
      d.timers = [];
      for (const f of [...d.ends]) f();
      lastGone.set(d.id, Date.now());
      if (lastGone.size > MAX_GONE) lastGone.delete(lastGone.keys().next().value!);
      emit({ type: 'gone', id: d.id, waiting: d.clients.size > 0 });
      // Kept for the page to come back on a new link: its session carries on, and DevTools, which
      // stays open on the tab, carries on. An inspector nobody is using goes now.
      detached.set(d.id, { d, timer: d.clients.size ? null : setTimeout(() => expire(d), AWAY_MS), at: Date.now() });
      if (!d.clients.size && !leases.has(d.id)) dropInspector(d);
      else failCalls(d);
      // Questions to the agent wait a little: if this page comes back on a new link they are asked
      // again, and the agent, which runs each once, answers from what it kept. A page that says no
      // name for itself can't be known again, and one that stays away is gone.
      if (!d.page) failAsked(d);
      else if (d.asked.size) setTimeout(() => d.socket === null && failAsked(d), ASK_GRACE_MS).unref();
      for (const c of d.clients) c.control(AWAY);
    });
    for (let i = 0; i < PING_BURST; i++) d.timers.push(setTimeout(() => ping(d), i * 100));
    d.timers.push(setInterval(() => ping(d), PING_EVERY_MS));
    // Page scripts can't see WebSocket pings, so the agent hears this to know the link is alive.
    d.timers.push(setInterval(() => d.socket?.send('beat'), BEAT_MS));
    // What this session holds of the page, so the agent resends only what the dropped link lost.
    const holds = resumed ? d.session.holds() : null;
    ws.send(holds ? `resume ${holds.join(' ')}` : 'resume');
    // The same page on a new link: what it was asked and hasn't answered is asked again. It runs each once.
    if (relink) for (const a of d.asked.values()) ws.send(a.line);
    if (relink) {
      // An inspector whose socket is gone, or stuck on a dead one, reconnects now.
      if (!d.cdp?.connected && (d.clients.size || leases.has(id))) ws.send(inspectorUrl(d));
    } else if (d.clients.size) reattach(d);
    else {
      if (kept) dropInspector(d);
      if (leases.has(id)) ws.send(inspectorUrl(d));
      for (const r of awaiting) r.writeHead(302, { location: frontendPath(id), 'cache-control': 'no-store' }).end();
      opts.onTab?.(id, awaiting.size > 0 || waitingClients.has(id));
      awaiting.clear();
    }
    for (const c of d.clients) {
      c.control(pageControl(d));
      c.control(HERE);
    }
    const waiting = waitingClients.get(id);
    waitingClients.delete(id);
    for (const [c, shown] of waiting ?? []) if (c.open) addClient(c, d, shown);
    emit({ type: 'page', id, kind, href, ua, ip });
    opts.onDevice?.(info(d));
  }

  /** A new page for a tab DevTools is open on: same as a navigation in Chrome, then restore DevTools' state. */
  function reattach(d: Device) {
    if (d.cdp) dropInspector(d);
    resume(d);
    d.served = false;
    d.socket!.send(inspectorUrl(d));
  }

  /** Tells DevTools its page changed, as Chrome does on a navigation, and queues what DevTools had
   *  enabled for the next inspector. Calling it again before that inspector comes adds nothing. */
  function resume(d: Device) {
    for (const c of d.clients) for (const msg of NAVIGATED) c.send(msg);
    // Replays use string ids, which DevTools never sends, so their replies can be dropped.
    const replay = [...d.enabled.values()]
      .filter((msg) => !d.pending.includes(msg))
      .map((msg) => {
        const m = JSON.parse(msg);
        return JSON.stringify({ ...m, id: `teleport:${m.method}` });
      })
      .filter((msg) => !d.pending.includes(msg));
    d.pending = [...replay, ...d.pending];
  }

  /** Gives up on a page that didn't come back. DevTools stays open on the tab, waiting for one. */
  function expire(d: Device) {
    detached.delete(d.id);
    failAsked(d);
    dropInspector(d);
  }

  const pageControl = (d: Device) => `{"teleport":"page","page":${JSON.stringify(d.page)}}`;

  /** The link a socket carries: the one it asks to resume, or a new one. */
  function linkFor(kind: string, ws: Peer, q: URLSearchParams, limits: LinkLimits): { link: Link; resumed: boolean } {
    const token = q.get('link');
    const key = token && LINK_TOKEN.test(token) ? `${kind} ${token}` : null;
    const got = Math.max(0, Number(q.get('got')) || 0);
    const old = key ? links.get(key) : undefined;
    if (old?.open) {
      old.attach(ws, got, true);
      return { link: old, resumed: true };
    }
    const link = new Link(key ? token : null, limits);
    if (key) {
      links.set(key, link);
      link.onClose(() => links.get(key) === link && links.delete(key));
    }
    link.attach(ws, got, false);
    return { link, resumed: false };
  }

  /** A DevTools socket. One that resumes its link carries on unnoticed. A new link joins its tab, or
   *  waits for it if teleport doesn't know the tab (it restarted, or the tab never connected). */
  function clientLink(ws: Peer, id: string, q: URLSearchParams) {
    const { link, resumed } = linkFor('client', ws, q, CLIENT_LINK);
    if (resumed) return;
    // The page this DevTools showed before its link was lost, from a teleport that has forgotten it.
    const shown = q.get('page');
    const d = devices.get(id) ?? detached.get(id)?.d;
    if (d) return addClient(link, d, shown);
    // A client on this protocol waits for the tab; any other is told there is no such tab.
    if (!link.token) return link.close(1008, 'unknown device');
    let set = waitingClients.get(id);
    if (!set) waitingClients.set(id, (set = new Map()));
    set.set(link, shown);
    link.control(AWAY);
    link.onClose(() => {
      const now = waitingClients.get(id);
      if (now?.delete(link) && !now.size) waitingClients.delete(id);
    });
  }

  function inspectorLink(ws: Peer, id: string, q: URLSearchParams) {
    const { link, resumed } = linkFor('cdp', ws, q, INSPECTOR_LINK);
    // A tab whose agent is still away keeps its inspector: DevTools carries on through it.
    if (!resumed) addInspector(link, devices.get(id) ?? detached.get(id)?.d, q.has('kept'));
  }

  function addClient(ws: Link, d: Device, shown: string | null = null) {
    d.clients.add(ws);
    emit({ type: 'devtools', id: d.id, open: d.clients.size });
    const read = (data: Buffer) => {
      const msg = data.toString();
      const parsed = parse(msg);
      // Anything but a request with a method goes on to the page as it is.
      const m = parsed !== null && typeof parsed === 'object' && typeof parsed.method === 'string' ? parsed : null;
      const toggle = m?.method!.match(/^(\w+)\.(?:en|dis)able$/);
      if (toggle) d.enabled.set(toggle[1]!, msg);
      if (m?.method === 'Network.enable') {
        sendClientRequest(d, m.id, msg);
        d.network.add(ws);
        for (const e of requestsOf(d)) for (const ev of networkEvents(e, d.href, (ms) => d.session.agentTime(ms))) ws.send(ev);
        return;
      }
      if (m?.method === 'Network.disable') d.network.delete(ws);
      const rid = m?.params?.requestId;
      if (m?.method === 'Network.getResponseBody' && typeof rid === 'string' && rid.startsWith('p')) {
        const r = netlog.body(rid);
        ws.send(JSON.stringify(typeof r === 'string' ? { id: m.id, error: { code: -32000, message: r } } : { id: m.id, result: r }));
        return;
      }
      if (m?.method!.startsWith('Tracing.') && tracing(ws, d, m)) return;
      if (m && d.bridge.fromClient(ws, m as never)) return;
      sendClientRequest(d, m?.id, msg);
    };
    // A request that can't be followed is answered as one that failed, so DevTools doesn't wait on it.
    const lost = (data: Buffer) => {
      const id = (parse(data) as { id?: unknown } | null)?.id;
      if (typeof id === 'number') ws.send(JSON.stringify({ id, error: { code: -32603, message: "teleport couldn't follow this request" } }));
    };
    ws.onMessage(reading(d, read, lost));
    ws.onClose(() => {
      d.clients.delete(ws);
      d.network.delete(ws);
      emit({ type: 'devtools', id: d.id, open: d.clients.size });
      if (d.clients.size === 0) {
        devtoolsDone(d);
        const away = detached.get(d.id);
        if (away && !away.timer) away.timer = setTimeout(() => expire(d), AWAY_MS);
      }
    });
    // A DevTools that had this tab open before teleport lost track of it: its element ids are from a
    // copy of the tree this teleport doesn't have, and the page may be another one since.
    if (shown !== null) for (const msg of shown === d.page ? NAVIGATED.slice(1) : NAVIGATED) ws.send(msg);
    ws.control(pageControl(d));
    ws.control(d.socket ? HERE : AWAY);
    if (!d.cdp) d.socket?.send(inspectorUrl(d));
    // An inspector an API call loaded now serves DevTools too.
    else d.served = true;
  }

  /** The Performance panel's Record button: the agent records frames, the laptop builds the trace. */
  function tracing(ws: Link, d: Device, m: { id?: unknown; method?: string }): boolean {
    const reply = (result: object) => ws.send(JSON.stringify({ id: m.id, result }));
    if (m.method === 'Tracing.start') {
      d.tracingFrom = d.session.agentTime(serverNow());
      d.socket?.send(`capture ${MAX_CAPTURE_MS}`);
      reply({});
      return true;
    }
    if (m.method !== 'Tracing.end') return false;
    reply({});
    const from = d.tracingFrom ?? d.session.agentTime(serverNow()) - MAX_CAPTURE_MS;
    const to = d.session.agentTime(serverNow());
    d.tracingFrom = null;
    d.socket?.send('capture 0');
    // The agent ships what it recorded at its next 1 Hz tick.
    d.timers.push(
      setTimeout(() => {
        const events = devtoolsTrace({
          timeline: d.session.timeline,
          from,
          to,
          names: d.session.meta.names,
          network: requestsOf(d).map(netRecord),
          offsetMs: d.session.meta.offsetMs,
          href: d.href,
        });
        for (let i = 0; i < events.length; i += TRACE_CHUNK) ws.send(JSON.stringify({ method: 'Tracing.dataCollected', params: { value: events.slice(i, i + TRACE_CHUNK) } }));
        ws.send(JSON.stringify({ method: 'Tracing.tracingComplete', params: { dataLossOccurred: false } }));
      }, CAPTURE_SETTLE_MS),
    );
    return true;
  }

  function sendClientRequest(d: Device, id: unknown, msg: string) {
    if (d.cdp && typeof id === 'number') d.inflight.add(id);
    toInspector(d, msg);
  }

  function addInspector(ws: Link, d: Device | undefined, kept: boolean) {
    if (!d) return ws.close(1008, 'unknown device');
    // A page holds one inspector: an older socket from it is a link that died without a close.
    const older = d.cdp;
    d.cdp = ws;
    older?.close();
    // A later inspector in the same DevTools session is a fresh one, after a dropped link or two
    // connecting at once: DevTools gets the page's state again from it.
    if (d.clients.size) {
      if (d.served && !kept) resume(d);
      // The inspector kept DevTools' state, but the server let go of its link and its copy of the
      // tree: DevTools' element ids name nodes nobody has now, so it asks for the document again.
      else if (kept && !older) for (const c of d.clients) c.send(NAVIGATED[1]!);
      d.served = true;
    } else if (kept && !leases.has(d.id)) {
      // DevTools closed while the link was down. Or, for an inspector on this protocol, teleport
      // restarted and DevTools hasn't come back yet: it gets a moment.
      if (!ws.token) ws.send(DETACH);
      else d.timers.push(setTimeout(() => d.cdp === ws && !d.clients.size && !leases.has(d.id) && ws.send(DETACH), DETACH_WAIT_MS));
    }
    for (const msg of d.pending) {
      const id = parse(msg)?.id;
      if (typeof id === 'number' && id >= 0) d.inflight.add(id);
      ws.send(msg);
    }
    d.pending = [];
    // The inspector's short messages become the protocol's again here, so nothing below knows of them.
    const expander = new Expander();
    ws.onGap(() => expander.reset());
    const fromInspector = (raw: string, m: ReturnType<typeof parse>) => {
      if (typeof m?.id === 'string') {
        // The server's own call, or a replay DevTools never sent.
        const c = d.calls.get(m.id);
        if (c) {
          d.calls.delete(m.id);
          const err = (m as { error?: { message?: string } }).error;
          if (err) c.fail(new Error(err.message ?? 'the inspector refused'));
          else c.ok((m.result ?? {}) as CallResult);
        }
        return;
      }
      if (m?.method === 'teleport.mark') {
        if (typeof m.params?.t === 'number') d.session.mark(m.params.t);
        return void droppedSoFar(d, Number(m.params?.droppedConsole) || 0, Number(m.params?.droppedNet) || 0);
      }
      // A trial's run says it is done, so the laptop reads the result now instead of at its next slow poll.
      if (m?.method === 'teleport.trial') {
        const id = String(m.params?.id);
        const waiting = d.runs.get(id);
        if (waiting) return waiting();
        d.finished.add(id);
        if (d.finished.size > MAX_FINISHED) d.finished.delete(d.finished.values().next().value!);
        return;
      }
      // The inspector stopped watching the DOM under pressure and is calm again: the copy here is
      // stale, and DevTools asks for the document afresh, as it does when a page navigates.
      if (m?.method === 'teleport.stale') {
        d.bridge.reset();
        for (const c of d.clients) c.send(NAVIGATED[1]!);
        return;
      }
      if (m?.method === 'teleport.governor') {
        d.governor = { level: Number(m.params?.level) || 0, reason: String(m.params?.reason ?? '') };
        emit({ type: 'governor', id: d.id, ...d.governor });
        return;
      }
      if (typeof m?.id === 'number') d.inflight.delete(m.id);
      const out = d.bridge.fromDevice(raw, m as never);
      if (!out) return;
      if (m?.method === 'Runtime.consoleAPICalled' || m?.method === 'Runtime.exceptionThrown') remember(d, out);
      for (const c of d.clients) c.send(out);
      if (m?.method === 'Runtime.executionContextCreated') for (const c of d.clients) catchUp(d, c);
    };
    const read = (data: Buffer) => {
      const raw = data.toString();
      const m = parse(raw);
      if (!Array.isArray(m)) return fromInspector(raw, m !== null && typeof m === 'object' ? m : null);
      for (const out of expander.expand(m)) fromInspector(JSON.stringify(out), out as ReturnType<typeof parse>);
      if (expander.resync) {
        expander.resync = false;
        ws.send(RESYNC);
      }
    };
    // The fresh start a short message that can't be read gets, for any message: the copy of the tree
    // goes, DevTools asks for the document again, and the inspector says again what its short
    // messages lean on. An inspector that keeps at it is let go, and DevTools told its page went.
    let unread = 0;
    const startOver = () => {
      if (++unread > UNREAD_MAX) return ws.close(1008, 'unreadable');
      expander.reset();
      d.bridge.reset();
      for (const c of d.clients) c.send(NAVIGATED[1]!);
      ws.send(RESYNC);
    };
    ws.onMessage(reading(d, read, startOver));
    // If the page is still there with only this link gone (a tunnel restart), its inspector
    // reconnects by itself, with what DevTools had switched on.
    ws.onClose(() => {
      if (d.cdp === ws) dropInspector(d);
    });
  }

  /** Whose socket this is and what takes it. `dut`: the device's own, the agent's or its inspector's. */
  function route(req: IncomingMessage, url: URL): { dut: 'target' | 'cdp' | null; take: (ws: Peer) => void } | null {
    // DevTools' socket is under the key, and only for this machine.
    if (url.pathname.startsWith(KEYED + 'ws/')) {
      const id = url.pathname.slice(KEYED.length + 3);
      return TAB_ID.test(id) && fromThisMachine(req) ? { dut: null, take: (ws) => clientLink(ws, id, url.searchParams) } : null;
    }
    // The device's own sockets also answer under BASE, so an app's dev server that passes BASE on to
    // teleport carries everything the device opens.
    const under = url.pathname.startsWith(BASE + 'ws/');
    const [, root, kind, id] = (under ? url.pathname.slice(BASE.length - 1) : url.pathname).split('/');
    if (root !== 'ws') return null;
    if (kind === 'target') return id ? null : { dut: 'target', take: (ws) => addDevice(ws, req, url.searchParams) };
    if (kind === 'cdp') return id ? { dut: 'cdp', take: (ws) => inspectorLink(ws, id, url.searchParams) } : null;
    return null;
  }

  // Every upgraded socket, ours and the app's (a dev server's HMR): http.close() waits for them all.
  const upgraded = new Set<Duplex>();
  http.on('upgrade', (req, socket, head) => {
    upgraded.add(socket);
    socket.once('close', () => upgraded.delete(socket));
    const url = new URL(req.url ?? '/', 'http://x');
    const to = route(req, url);
    const handler = to?.take;
    if (handler) {
      const dut = to.dut;
      const ua = req.headers['user-agent'] ?? '';
      // The inspector's socket is compressed wherever the device's browser offers it. The browser
      // compresses off the page's main thread: measured, the page's main thread is no busier for it
      // and the socket carries a seventeenth of the bytes. The agent's frames are too small to bother.
      const deflate = dut === 'cdp' && !badDeflate.has(ua);
      const peer = accept(req, socket, head, dut ? { deadMs: DUT_DEAD_MS, deflate } : undefined);
      // A browser whose compressed message didn't inflate isn't offered it again, so it can't loop.
      if (deflate) peer?.onClose(() => peer.badDeflate && badDeflate.size < 64 && badDeflate.add(ua));
      if (peer) handler(peer);
    } else if (target?.kind === 'proxy') proxyUpgrade(target.origin, req, socket, head, upstreamTls(target.origin, !!opts.insecure));
    else socket.destroy();
  });

  return new Promise((resolve, reject) => {
    // Both IPv4 and IPv6 by default: a tunnel agent that resolves `localhost` to ::1 would otherwise be refused.
    const dual = !opts.host;
    const onError = (e: NodeJS.ErrnoException) => {
      if (dual && (e.code === 'EAFNOSUPPORT' || e.code === 'EADDRNOTAVAIL')) return void http.listen(opts.port, '0.0.0.0');
      reject(e);
    };
    http.on('error', onError);
    http.listen(opts.port, opts.host ?? '::', () => {
      http.off('error', onError);
      resolve({
        http,
        key,
        devices,
        netlog,
        setApp: useApp,
        close: () =>
          new Promise<void>((done) => {
            for (const l of leases.values()) clearTimeout(l);
            for (const d of devices.values()) {
              for (const t of d.timers) clearTimeout(t);
              d.socket?.terminate();
              d.cdp?.terminate();
              for (const c of d.clients) c.terminate();
            }
            for (const { d, timer } of detached.values()) {
              if (timer) clearTimeout(timer);
              for (const t of d.timers) clearTimeout(t);
              d.cdp?.terminate();
              for (const c of d.clients) c.terminate();
            }
            for (const set of waitingClients.values()) for (const c of set.keys()) c.terminate();
            for (const l of links.values()) l.terminate();
            http.close(() => done());
            http.closeAllConnections();
            for (const s of upgraded) s.destroy();
          }),
      });
    });
  });
}
