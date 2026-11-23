import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { decodeFrame } from '@teleport/protocol';

const INDEX = fileURLToPath(new URL('../src/index.js', import.meta.url));

const js = (
  await build({ entryPoints: [INDEX], bundle: true, write: false, format: 'iife', target: 'es5', logLevel: 'error' })
).outputFiles[0]!.text;

interface El {
  tag: string;
  attrs: Record<string, string>;
  style: Record<string, string>;
  textContent: string;
  src?: string;
  parentNode: El | null;
  children: El[];
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  appendChild(c: El): El;
  removeChild(c: El): El;
}

function el(tag: string): El {
  const e: El = {
    tag,
    attrs: {},
    style: {},
    textContent: '',
    parentNode: null,
    children: [],
    setAttribute: (k, v) => void (e.attrs[k] = v),
    getAttribute: (k) => e.attrs[k] ?? null,
    appendChild: (c) => (c.parentNode?.removeChild(c), (c.parentNode = e), e.children.push(c), c),
    removeChild: (c) => ((e.children = e.children.filter((x) => x !== c)), (c.parentNode = null), c),
  };
  return e;
}

/** The agent on a fake device page: a document, a manual clock, timers and WebSockets the test drives. */
function dut(withDocument = true, extra: Record<string, unknown> = {}) {
  let clock = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    readyState = 0;
    bufferedAmount = 0;
    sent: unknown[] = [];
    onopen: ((e: object) => void) | null = null;
    onclose: ((e: object) => void) | null = null;
    onmessage: ((e: object) => void) | null = null;
    constructor(public url: string) {
      sockets.push(this);
    }
    send(d: unknown) {
      // The agent reuses one buffer for every frame, so a frame is copied as the socket takes it.
      this.sent.push(d instanceof Uint8Array ? d.slice() : d);
    }
    close() {
      if (this.readyState < 2) this.readyState = 2;
    }
    open() {
      this.readyState = 1;
      this.onopen?.call(this, {});
    }
    say(data: string) {
      this.onmessage?.call(this, { data });
    }
    fireClose(code = 1006) {
      this.readyState = 3;
      this.onclose?.call(this, { code });
    }
  }
  const html = el('html');
  const head = el('head');
  html.appendChild(head);
  const document = { documentElement: html, head, createElement: el };
  const ctx: Record<string, unknown> = {
    WebSocket: FakeSocket, ArrayBuffer, DataView, Float64Array, Float32Array, Uint8Array, Uint16Array, Uint32Array, Math, Date, String, Array, Object,
    performance: { now: () => clock },
    setTimeout: (fn: () => void, ms?: number) => (timers.set(++seq, { at: clock + (ms ?? 0), fn }), seq),
    clearTimeout: (id: number) => timers.delete(id),
    ...(withDocument ? { document } : {}),
    ...extra,
  };
  ctx.window = ctx;
  runInNewContext(js, ctx);
  const advance = (ms: number, each?: (t: number) => void) => {
    const end = clock + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | null = null;
      for (const e of timers) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      timers.delete(next[0]);
      clock = Math.max(clock, next[1].at);
      next[1].fn();
      each?.(clock);
    }
    clock = end;
  };
  const mark = () => html.children.find((c) => 'data-teleport' in c.attrs) ?? null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { api: ctx.teleport as any, sockets, timers, advance, html, head, mark };
}

describe('the link to the laptop', () => {
  it('loads a script the server names by path from the address the device reached the server by', () => {
    const p = dut();
    p.api.init({ url: 'wss://tunnel.example/ws/target' });
    p.sockets[0]!.open();
    p.sockets[0]!.say('load /__teleport/inspector.js?id=t1');
    expect(p.head.children.at(-1)!.src).toBe('https://tunnel.example/__teleport/inspector.js?id=t1');

    const lan = dut();
    lan.api.init({ url: 'ws://192.168.1.5:7070/ws/target' });
    lan.sockets[0]!.open();
    lan.sockets[0]!.say('load /__teleport/snippets.js');
    expect(lan.head.children.at(-1)!.src).toBe('http://192.168.1.5:7070/__teleport/snippets.js');
  });

  it('replaces an open socket the server has gone quiet on', () => {
    const p = dut();
    p.api.init({ url: 'ws://192.168.1.5:7070/ws/target' });
    p.sockets[0]!.open();
    p.advance(60000);
    expect(p.sockets[0]!.readyState).toBeGreaterThanOrEqual(2);
    expect(p.sockets.length).toBeGreaterThan(1);
  });

  it('keeps a socket the server pings, however long nothing else happens', () => {
    const p = dut();
    p.api.init({ url: 'ws://192.168.1.5:7070/ws/target' });
    const s = p.sockets[0]!;
    s.open();
    let last = 0;
    p.advance(300000, (t) => {
      if (t - last >= 15000) (last = t), s.say(`ping ${t}`);
    });
    expect(p.sockets).toHaveLength(1);
    expect(s.readyState).toBe(1);
  });
});

describe('a link that drops', () => {
  const store = () => {
    const s: Record<string, string> = {};
    return { getItem: (k: string) => s[k] ?? null, setItem: (k: string, v: string) => void (s[k] = v), removeItem: (k: string) => void delete s[k] };
  };
  const page = (url: string) => new URL(url).searchParams.get('page');

  it('comes back within a second, and says it is the same page, which a reload is not', () => {
    const tab = store();
    const p = dut(true, { location: { href: 'http://device.example/app' }, sessionStorage: tab });
    p.api.init({ url: 'wss://tunnel.example/ws/target' });
    p.sockets[0]!.open();
    p.sockets[0]!.fireClose();
    p.advance(1000);
    expect(p.sockets).toHaveLength(2);
    expect(page(p.sockets[1]!.url)).toMatch(/^[a-z0-9]{4,}$/);
    expect(page(p.sockets[1]!.url)).toBe(page(p.sockets[0]!.url));

    const reloaded = dut(true, { location: { href: 'http://device.example/app' }, sessionStorage: tab });
    reloaded.api.init({ url: 'wss://tunnel.example/ws/target' });
    const again = new URL(reloaded.sockets[0]!.url).searchParams;
    expect(again.get('id')).toBe(new URL(p.sockets[0]!.url).searchParams.get('id'));
    expect(again.get('page')).not.toBe(page(p.sockets[0]!.url));
  });

  it('still waits longer and longer for a laptop that never answered', () => {
    const p = dut();
    p.api.init({ url: 'ws://192.168.1.5:7070/ws/target' });
    p.sockets[0]!.fireClose();
    p.advance(4000);
    expect(p.sockets).toHaveLength(1);
  });
});

describe('the mark on the device', () => {
  const URL_ = 'ws://192.168.1.5:7070/ws/target';

  it('is not there unless asked for: nothing on the screen by default, or with badge: false', () => {
    for (const opts of [{ url: URL_ }, { url: URL_, badge: false }]) {
      const p = dut();
      p.api.init(opts);
      p.sockets[0]!.open();
      expect(p.mark()).toBeNull();
      p.sockets[0]!.fireClose();
      expect(p.mark()).toBeNull();
      expect(p.html.children).toHaveLength(1);
    }
  });

  it('lights while the laptop is connected and goes hollow while it is away', () => {
    const p = dut();
    p.api.init({ url: URL_, badge: true });
    expect(p.mark()).toBeNull();
    p.sockets[0]!.open();
    const lit = p.mark()!;
    expect(lit.attrs['data-teleport']).toBe('connected');
    p.sockets[0]!.fireClose();
    expect(p.mark()!.attrs['data-teleport']).toBe('away');
    p.advance(6000);
    p.sockets[1]!.open();
    expect(p.mark()).toBe(lit);
    expect(lit.attrs['data-teleport']).toBe('connected');
  });

  it('comes back when the app clears the page', () => {
    const p = dut();
    p.api.init({ url: URL_, badge: true });
    p.sockets[0]!.open();
    p.html.removeChild(p.mark()!);
    p.sockets[0]!.fireClose();
    expect(p.mark()!.attrs['data-teleport']).toBe('away');
  });

  it('goes with stop()', () => {
    const p = dut();
    p.api.init({ url: URL_, badge: true });
    p.sockets[0]!.open();
    p.api.stop();
    expect(p.mark()).toBeNull();
    expect(p.timers.size).toBe(0);
  });

  it('needs no document', () => {
    const p = dut(false);
    p.api.init({ url: URL_, badge: true });
    p.sockets[0]!.open();
    p.sockets[0]!.fireClose();
    expect(p.api.status().running).toBe(true);
  });
});

describe('a link that comes back to a server that kept the page', () => {
  type Sock = { sent: unknown[] };
  const frames = (s: Sock) => s.sent.filter((d): d is Uint8Array => d instanceof Uint8Array).map((d) => decodeFrame(d));
  const ends = (f: ReturnType<typeof decodeFrame>) => f.streams.map((x) => x.first! + x.count);

  it('waits a moment for what the server has, then sends only what it lacks', () => {
    const p = dut();
    p.api.init({ url: 'ws://192.168.1.5:7070/ws/target' });
    const a = p.sockets[0]!;
    a.open();
    a.say('resume');
    p.advance(5000);
    const sent = ends(frames(a).at(-1)!);
    a.fireClose();
    p.advance(3000);
    const b = p.sockets[1]!;
    b.open();
    // The server got everything but the last two overhead records.
    const has = sent.slice();
    has[0] = sent[0]! - 2;
    b.say('resume ' + has.join(' '));
    const f = frames(b)[0]!;
    expect(f.streams[0]!.name).toBe('overhead');
    expect(f.streams[0]!.first).toBe(has[0]);
    expect(f.streams[0]!.count).toBeGreaterThanOrEqual(2 + 3);
    expect(f.streams[0]!.dropped).toBe(0);
  });

  it('counts records the rings no longer hold as dropped', () => {
    const p = dut();
    p.api.init({ url: 'ws://192.168.1.5:7070/ws/target' });
    const a = p.sockets[0]!;
    a.open();
    a.say('resume');
    p.advance(2000);
    const b = (a.fireClose(), p.advance(1000), p.sockets[1]!);
    b.open();
    b.say('resume ' + ends(frames(a).at(-1)!).map(() => 0).join(' ') + ' 0');
    const lag = frames(b)[0]!.streams.find((x) => x.name === 'lag')!;
    expect(lag.first).toBe(0);
    expect(lag.dropped).toBe(0);
  });

  it('still sends to a server that never says what it has', () => {
    const p = dut();
    p.api.init({ url: 'ws://192.168.1.5:7070/ws/target' });
    p.sockets[0]!.open();
    p.advance(3000);
    expect(frames(p.sockets[0]!).length).toBeGreaterThan(0);
  });

  it('sends a server that never says what it has frames it can read: version 2, without positions', () => {
    const p = dut();
    p.api.init({ url: 'ws://192.168.1.5:7070/ws/target' });
    p.sockets[0]!.open();
    p.advance(3000);
    const old = frames(p.sockets[0]!).at(-1)!;
    expect(old.version).toBe(2);
    expect(old.streams[0]!.first).toBeNull();
    p.sockets[0]!.say('resume');
    p.advance(1000);
    expect(frames(p.sockets[0]!).at(-1)!.version).toBe(3);
  });

  it('once the server beats, takes a few silent seconds for a dead link instead of most of a minute', () => {
    const p = dut();
    p.api.init({ url: 'ws://192.168.1.5:7070/ws/target' });
    const a = p.sockets[0]!;
    a.open();
    a.say('beat');
    p.advance(12000);
    expect(a.readyState).toBeGreaterThanOrEqual(2);
    expect(p.sockets.length).toBeGreaterThan(1);
  });
});
