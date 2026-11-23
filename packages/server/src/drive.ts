// Driving devices from a test runner. Two things live here, both on the laptop, so the device pays
// nothing for them until they are used:
//
// - Holds. A runner reserves a device for a suite and gets a token; while it holds the device, calls
//   that act on it from anyone else are refused, so two suites never press keys on one screen. A hold
//   ends when it is released, or when its holder says nothing for its time: a runner that died frees
//   its device. The device shows a thin frame while it is held (`frameScript`).
// - The browser's side of the DevTools protocol. A device's own socket speaks the page's side; Playwright's
//   `connectOverCDP` and Puppeteer's `connect` first ask a browser for its pages (`Target.*`) and then talk
//   to each over one socket, a `sessionId` on every message. `cdpBrowser` answers that: each device is a
//   page, a session is a DevTools client of it, and `Input.*` goes the way the remote's keys go.
import { randomBytes } from 'node:crypto';
import { pressScript, textScript, type Press } from './remote.js';
import { VERSION } from './version.js';

/** How long a hold lasts past its holder's last call, unless it asks for another time. */
export const HOLD_MS = 120_000;
export const MAX_HOLD_MS = 600_000;
const MAX_NAME = 40;

export interface Hold {
  id: string;
  token: string;
  /** Who holds it, in their words: a suite's name. */
  as: string;
  /** The device shows the frame. */
  frame: boolean;
  ms: number;
  timer: NodeJS.Timeout;
}

/** A holder's name as it is shown: one line, printable ASCII, short. */
export const holderName = (said: unknown) => String(said ?? '').replace(/[^\x20-\x7e]/g, '').trim().slice(0, MAX_NAME) || 'a test run';

/** Which devices are held, by whom, and until when. `ended` is told of a hold that ran out or was released. */
export class Holds {
  private byId = new Map<string, Hold>();

  constructor(private ended: (h: Hold) => void) {}

  of(id: string): Hold | undefined {
    return this.byId.get(id);
  }

  /** The hold a token names. */
  held(token: unknown): Hold | undefined {
    if (typeof token !== 'string' || !token) return undefined;
    for (const h of this.byId.values()) if (h.token === token) return h;
    return undefined;
  }

  /** Whether a caller showing `token` may act on device `id`: it is free, or theirs. */
  free(id: string, token: unknown): boolean {
    const h = this.byId.get(id);
    return !h || h.token === token;
  }

  take(id: string, as: string, ms: number, frame: boolean): Hold {
    const h: Hold = { id, token: randomBytes(12).toString('base64url'), as, frame, ms: Math.min(Math.max(ms || HOLD_MS, 1000), MAX_HOLD_MS), timer: setTimeout(() => {}, 0) };
    this.byId.set(id, h);
    this.touch(h);
    return h;
  }

  /** The holder was heard from: its time starts again. */
  touch(h: Hold) {
    clearTimeout(h.timer);
    h.timer = setTimeout(() => this.drop(h.id), h.ms);
    h.timer.unref();
  }

  drop(id: string): Hold | undefined {
    const h = this.byId.get(id);
    if (!h) return undefined;
    clearTimeout(h.timer);
    this.byId.delete(id);
    this.ended(h);
    return h;
  }

  clear() {
    for (const h of this.byId.values()) clearTimeout(h.timer);
    this.byId.clear();
  }
}

const FRAME_ID = '__tlpt_hold';
/** teleport's accent, as the console draws its name. */
const ACCENT = '#3fd4c0';

/**
 * ES5 that shows the frame on the device: a 3px border around the screen and the holder's name in a
 * corner, one fixed element that takes no input. With no name, it takes the frame away. Not measured
 * on a device: a held run that measures frames says `frame: false`.
 */
export function frameScript(as: string | null): string {
  const find = `var d=document,e=d.getElementById('${FRAME_ID}');`;
  if (as === null) return `(function(){${find}if(e&&e.parentNode){e.parentNode.removeChild(e);}return '';})()`;
  return (
    `(function(){${find}if(!e){e=d.createElement('div');e.id='${FRAME_ID}';e.setAttribute('aria-hidden','true');` +
    `e.style.cssText='position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483646;pointer-events:none;box-sizing:border-box;border:3px solid ${ACCENT}';` +
    `var l=d.createElement('div');l.style.cssText='position:absolute;right:0;bottom:0;padding:2px 10px;background:${ACCENT};color:#06110f;font:bold 13px/1.5 monospace;white-space:nowrap';e.appendChild(l);}` +
    `e.firstChild.textContent=${JSON.stringify(`◎ teleport · ${as}`)};if(!e.parentNode){(d.body||d.documentElement).appendChild(e);}return '';})()`
  );
}

/** ES5 that clicks whatever is at a point, as a pointer would: it takes focus, then mousedown, mouseup, click. */
export function clickScript(x: number, y: number): string {
  return (
    `(function(){var x=${Number(x) || 0},y=${Number(y) || 0},el=document.elementFromPoint(x,y);if(!el){return 'nothing at '+x+','+y;}` +
    "function ev(t){var e=document.createEvent('MouseEvents');e.initMouseEvent(t,true,true,window,1,x,y,x,y,false,false,false,false,0,null);return el.dispatchEvent(e);}" +
    "var f=el;while(f&&f!==document.body&&!(f.tabIndex>=0)){f=f.parentNode;}if(f&&f.focus&&f!==document.body){f.focus();}ev('mousedown');ev('mouseup');ev('click');return '';})()"
  );
}

/**
 * The script an `Input.*` call runs on the page, or null when it has nothing to do (a key going up:
 * the press is whole when it goes down, as the remote's is). A printable key types its character.
 */
export function inputScript(method: string, p: Record<string, unknown>): string | null {
  if (method === 'Input.insertText') return typeof p.text === 'string' && p.text ? textScript(p.text.slice(0, 2000)) : null;
  if (method === 'Input.dispatchMouseEvent') return p.type === 'mouseReleased' && (p.button ?? 'left') === 'left' ? clickScript(Number(p.x), Number(p.y)) : null;
  if (method !== 'Input.dispatchKeyEvent' || (p.type !== 'keyDown' && p.type !== 'rawKeyDown')) return null;
  const key = typeof p.key === 'string' ? p.key : '';
  const text = typeof p.text === 'string' ? p.text : '';
  if (text && text !== '\r' && text !== '\n' && key.length <= 1) return textScript(text);
  const press: Press = { key, code: typeof p.code === 'string' ? p.code : '', keyCode: Number(p.windowsVirtualKeyCode ?? p.nativeVirtualKeyCode) || 0 };
  return pressScript(press, key === 'Enter');
}

export interface CdpTarget {
  id: string;
  url: string;
  title: string;
}

export interface CdpSession {
  send(msg: string): void;
  close(): void;
}

/** What the browser's side needs of the server. */
export interface CdpHost {
  targets(): CdpTarget[];
  /** A DevTools client of a device, whose messages come out of `out`; null with why when there is none to have. */
  open(id: string, out: (msg: string) => void): CdpSession | string;
  /** Runs an input script on a device. */
  run(id: string, script: string, what: string): Promise<void>;
  /** Called with a device as it comes or goes, until the returned function is called. */
  watch(fn: (t: CdpTarget, here: boolean) => void): () => void;
}

export interface CdpSocket {
  send(msg: string): void;
  onMessage(fn: (data: Buffer, isBinary: boolean) => void): void;
  onClose(fn: () => void): void;
}

interface Msg {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
  result?: Record<string, unknown>;
}

const BROWSER_TARGET = 'teleport';
const CONTEXT = 'devices';
/** Execution context ids at and above this are worlds a client asked for, which are the page's own. */
const WORLD = 1000;
/** The inspector's name for the page's one frame (packages/inspector/src/cx.js). */
const MAIN = '"main"';
const MAIN_FRAME = /("(?:frameId|parentId)":|"frame":\{"id":)"main"/g;

const targetInfo = (t: CdpTarget, attached: boolean) => ({ targetId: t.id, type: 'page', title: t.title, url: t.url, attached, canAccessOpener: false, browserContextId: CONTEXT });

function read(data: Buffer | string): Msg | null {
  try {
    const m = JSON.parse(data.toString()) as unknown;
    return m !== null && typeof m === 'object' && !Array.isArray(m) ? (m as Msg) : null;
  } catch {
    return null;
  }
}

interface Attached {
  target: string;
  session: CdpSession;
  /** Worlds made for this page by name, each with the context id its client knows it by. */
  worlds: Map<string, number>;
  frameId: string;
  /** Requests out to the device, by the id they went under, each with the id its client gave. */
  asked: Map<number, number>;
}

/** Ids for requests sent on to a device: above any a DevTools window counts up to, and unlike any other session's. */
let nextAsk = 1_000_000_000;

/**
 * Answers one browser-level socket. A client that takes one device at a time needs nothing here: this
 * is for the ones that begin with the browser. A page can't be made or closed from the laptop, and an
 * isolated world is the page's own world under another name: a device's engine has the one.
 */
export function cdpBrowser(ws: CdpSocket, host: CdpHost) {
  const sessions = new Map<string, Attached>();
  const browsers = new Set<string>();
  let auto = false;
  let discover = false;
  let seq = 0;
  let worldSeq = WORLD;
  const send = (m: object) => ws.send(JSON.stringify(m));
  const reply = (m: Msg, result: object) => send({ id: m.id, result, ...(m.sessionId ? { sessionId: m.sessionId } : null) });
  const refuse = (m: Msg, message: string) => send({ id: m.id, error: { code: -32000, message }, ...(m.sessionId ? { sessionId: m.sessionId } : null) });
  const attachedTo = (id: string) => [...sessions.values()].some((s) => s.target === id);

  const world = (sid: string, a: Attached, name: string) => {
    const id = a.worlds.get(name) ?? ++worldSeq;
    a.worlds.set(name, id);
    send({ sessionId: sid, method: 'Runtime.executionContextCreated', params: { context: { id, origin: '', name, uniqueId: `teleport-${id}`, auxData: { isDefault: false, type: 'isolated', frameId: a.frameId } } } });
    return id;
  };

  /** What a device's inspector says, on its session: after the page's own world, the worlds asked for by name. */
  const fromDevice = (sid: string, a: Attached, raw: string) => {
    // A device's replies go to every client of it: this session takes its own, under the id its client gave.
    const m = read(raw);
    if (!m) return;
    if (m.id !== undefined) {
      const id = typeof m.id === 'number' ? a.asked.get(m.id) : undefined;
      if (id === undefined) return;
      a.asked.delete(m.id);
      raw = JSON.stringify({ ...m, id });
    }
    // A page's main frame is known by its target's id, which is how a client finds it.
    const out = raw.includes(MAIN) ? raw.replace(MAIN_FRAME, `$1${JSON.stringify(a.target)}`) : raw;
    ws.send(`{"sessionId":${JSON.stringify(sid)},${out.slice(1)}`);
    if (m.method !== 'Runtime.executionContextCreated') return;
    for (const name of [...a.worlds.keys()]) {
      a.worlds.delete(name);
      world(sid, a, name);
    }
  };

  const attach = (id: string, said = true): string | { error: string } => {
    const sid = `${id}.${++seq}`;
    const a: Attached = { target: id, session: null as never, worlds: new Map(), frameId: id, asked: new Map() };
    const s = host.open(id, (raw) => raw.startsWith('{') && fromDevice(sid, a, raw));
    if (typeof s === 'string') return { error: s };
    a.session = s;
    sessions.set(sid, a);
    const t = host.targets().find((x) => x.id === id) ?? { id, url: '', title: id };
    if (said) send({ method: 'Target.attachedToTarget', params: { sessionId: sid, targetInfo: targetInfo(t, true), waitingForDebugger: false } });
    return sid;
  };

  const detach = (sid: string) => {
    const a = sessions.get(sid);
    if (!a) return;
    sessions.delete(sid);
    a.session.close();
    send({ method: 'Target.detachedFromTarget', params: { sessionId: sid, targetId: a.target } });
  };

  const unwatch = host.watch((t, here) => {
    if (here) {
      if (discover) send({ method: attachedTo(t.id) ? 'Target.targetInfoChanged' : 'Target.targetCreated', params: { targetInfo: targetInfo(t, attachedTo(t.id)) } });
      if (auto && !attachedTo(t.id)) attach(t.id);
    }
  });

  const browser = (m: Msg) => {
    const p = m.params ?? {};
    switch (m.method) {
      case 'Browser.getVersion':
        return reply(m, { protocolVersion: '1.3', product: `teleport/${VERSION}`, revision: '', userAgent: `teleport/${VERSION}`, jsVersion: '' });
      case 'Target.getBrowserContexts':
        return reply(m, { browserContextIds: [] });
      case 'Target.getTargets':
        return reply(m, { targetInfos: host.targets().map((t) => targetInfo(t, attachedTo(t.id))) });
      case 'Target.getTargetInfo': {
        const t = host.targets().find((x) => x.id === p.targetId);
        return reply(m, { targetInfo: t ? targetInfo(t, attachedTo(t.id)) : { targetId: BROWSER_TARGET, type: 'browser', title: 'teleport', url: '', attached: true, canAccessOpener: false } });
      }
      case 'Target.setDiscoverTargets':
        discover = !!p.discover;
        if (discover) for (const t of host.targets()) send({ method: 'Target.targetCreated', params: { targetInfo: targetInfo(t, attachedTo(t.id)) } });
        return reply(m, {});
      case 'Target.setAutoAttach':
        auto = !!p.autoAttach;
        if (auto) for (const t of host.targets()) if (!attachedTo(t.id)) attach(t.id);
        return reply(m, {});
      case 'Target.attachToTarget': {
        // A client that attaches to everything by itself has this page already: a second word of it reads as a second page.
        const r = attach(String(p.targetId), !auto && !m.sessionId);
        return typeof r === 'string' ? reply(m, { sessionId: r }) : refuse(m, r.error);
      }
      // Another session on the browser itself, which a client opens to attach to a page by hand.
      case 'Target.attachToBrowserTarget': {
        const sid = `browser.${++seq}`;
        browsers.add(sid);
        return reply(m, { sessionId: sid });
      }
      case 'Target.detachFromTarget':
        if (!browsers.delete(String(p.sessionId ?? m.sessionId))) detach(String(p.sessionId));
        return reply(m, {});
      case 'Target.createTarget':
      case 'Target.createBrowserContext':
        return refuse(m, 'teleport drives the pages devices have open: open the app on a device instead');
      case 'Target.closeTarget':
        return refuse(m, "teleport doesn't close a device's page");
      default:
        return reply(m, {});
    }
  };

  const page = (m: Msg, sid: string, a: Attached) => {
    const method = m.method ?? '';
    const p = m.params ?? {};
    if (method.startsWith('Input.')) {
      const script = inputScript(method, p);
      if (!script) return reply(m, {});
      return void host.run(a.target, script, method).then(
        () => reply(m, {}),
        (e: Error) => refuse(m, e.message),
      );
    }
    // The browser's own domains, asked of a page: there is nothing under a device's page to attach to.
    if (method.startsWith('Target.') || method.startsWith('Browser.')) return reply(m, {});
    if (method === 'Page.createIsolatedWorld') {
      return reply(m, { executionContextId: world(sid, a, String(p.worldName ?? '')) });
    }
    if (method === 'Page.addScriptToEvaluateOnNewDocument' && typeof p.worldName === 'string' && !a.worlds.has(p.worldName)) a.worlds.set(p.worldName, ++worldSeq);
    // A world asked for by its id is the page's own.
    for (const k of ['contextId', 'executionContextId'] as const) if (typeof p[k] === 'number' && (p[k] as number) > WORLD) delete p[k];
    delete p.uniqueContextId;
    if (p.frameId === a.target) p.frameId = 'main';
    const id = ++nextAsk;
    a.asked.set(id, m.id!);
    a.session.send(JSON.stringify({ id, method, params: p }));
  };

  ws.onMessage((data, isBinary) => {
    const m = isBinary ? null : read(data);
    if (!m || typeof m.method !== 'string' || typeof m.id !== 'number') return;
    if (typeof m.sessionId !== 'string' || browsers.has(m.sessionId)) return browser(m);
    const a = sessions.get(m.sessionId);
    if (!a) return refuse(m, 'no such session');
    page(m, m.sessionId, a);
  });
  ws.onClose(() => {
    unwatch();
    for (const a of sessions.values()) a.session.close();
    sessions.clear();
  });
}
