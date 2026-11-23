// One agent for a tab. Every page teleport serves gets the agent, a page in a frame too, and frames
// of one origin share the storage the tab's id is kept in. Two agents under one id read to the
// laptop as the tab loading another page: in a real browser the frame took the tab over and the
// page above it was dropped for good, so every answer after that came from the frame.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const INDEX = fileURLToPath(new URL('../src/index.js', import.meta.url));
const URL_ = 'ws://127.0.0.1:7070/ws/target';
const js = (await build({ entryPoints: [INDEX], bundle: true, write: false, format: 'iife', target: 'es5', logLevel: 'error' })).outputFiles[0]!.text;

interface Agent {
  init(o: { url: string }): Agent;
  status(): { running: boolean };
}

/** The agent loaded in a window whose parent is `parent`: none for a top window, which is its own. */
function windowUnder(parent?: object) {
  const sockets: string[] = [];
  class FakeSocket {
    readyState = 0;
    bufferedAmount = 0;
    constructor(url: string) {
      sockets.push(url);
    }
    send() {}
    close() {}
  }
  const ctx: Record<string, unknown> = {
    WebSocket: FakeSocket, ArrayBuffer, DataView, Float64Array, Float32Array, Uint8Array, Uint16Array, Uint32Array, Math, Date, String, Array, Object,
    performance: { now: () => 0 },
    setTimeout: () => 1,
    clearTimeout: () => {},
  };
  ctx.window = ctx;
  ctx.parent = parent ?? ctx;
  runInNewContext(js, ctx);
  return { win: ctx, agent: ctx.teleport as Agent, sockets };
}
const running = { teleport: { status: () => ({ running: true }) } };
/** A window of another origin: reading anything of it throws, but its parent may be read. */
const foreign = (parent: object) =>
  new Proxy({ parent }, { get: (t, k) => (k === 'parent' ? t.parent : (() => { throw new Error('SecurityError: blocked a frame with another origin'); })()) });

describe('a page in a frame', () => {
  it('starts as any page does when it is the top one', () => {
    const top = windowUnder();
    top.agent.init({ url: URL_ });
    expect(top.agent.status().running).toBe(true);
    expect(top.sockets).toHaveLength(1);
  });

  it('leaves the tab to the page above it when that page has an agent running', () => {
    const top = windowUnder();
    top.agent.init({ url: URL_ });
    const frame = windowUnder(top.win);
    frame.agent.init({ url: URL_ });
    expect(frame.agent.status().running).toBe(false);
    expect(frame.sockets).toEqual([]);
    // Any depth: a frame in a frame under the same page.
    const inner = windowUnder({ parent: top.win });
    inner.agent.init({ url: URL_ });
    expect(inner.agent.status().running).toBe(false);
  });

  it('is the device itself under a page with no agent, as an app a launcher page frames', () => {
    const launcher: Record<string, unknown> = {};
    launcher.parent = launcher;
    const app = windowUnder(launcher);
    app.agent.init({ url: URL_ });
    expect(app.agent.status().running).toBe(true);
    // An agent above that was stopped, or a `teleport` of the launcher's own, is no agent running.
    for (const teleport of [{ status: () => ({ running: false }) }, { name: 'the launcher' }, 5]) {
      const under = windowUnder(Object.assign({ teleport }, { parent: null as unknown }));
      under.agent.init({ url: URL_ });
      expect(under.agent.status().running).toBe(true);
    }
  });

  it('reads past a page of another origin above it, without throwing', () => {
    // Its own origin's page two levels up runs the agent, with another origin's page in between.
    const top = Object.assign({ ...running }, { parent: null as unknown });
    top.parent = top;
    const frame = windowUnder(foreign(top));
    expect(() => frame.agent.init({ url: URL_ })).not.toThrow();
    expect(frame.agent.status().running).toBe(false);
    // Another origin's page is the top: nothing of it can be read, so this frame is the device.
    const lone: { parent: unknown } = { parent: null };
    const alien = foreign(lone);
    lone.parent = alien;
    const app = windowUnder(foreign(alien));
    app.agent.init({ url: URL_ });
    expect(app.agent.status().running).toBe(true);
  });
});
