import { Duplex } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLOSE_MS, DEAD_MS, Peer, PING_MS } from '../src/ws.js';

/** A socket whose far side is gone: nothing ever arrives, and what's written goes nowhere. */
function link() {
  const written: Buffer[] = [];
  const socket = new Duplex({
    read() {},
    write(chunk: Buffer, _enc, done) {
      written.push(chunk);
      done();
    },
  });
  return { socket, written, pings: () => written.filter((b) => b[0] === 0x89).length };
}

/** A masked pong frame, as a browser answers a ping. */
const PONG = Buffer.from([0x8a, 0x80, 1, 2, 3, 4]);

afterEach(() => vi.useRealTimers());

describe('a quiet WebSocket', () => {
  it('is pinged, so tunnels and routers see it in use', () => {
    vi.useFakeTimers();
    const l = link();
    const peer = new Peer(l.socket);
    vi.advanceTimersByTime(PING_MS * 2 + 1);
    expect(l.pings()).toBe(2);
    peer.terminate();
  });

  it('is dropped once its far side stops answering, so the page can reconnect', () => {
    vi.useFakeTimers();
    const l = link();
    const peer = new Peer(l.socket);
    let gone = false;
    peer.onClose(() => (gone = true));
    vi.advanceTimersByTime(DEAD_MS - PING_MS);
    expect(gone).toBe(false);
    vi.advanceTimersByTime(PING_MS * 2);
    expect(gone).toBe(true);
  });

  it('stays while its far side answers the pings', () => {
    vi.useFakeTimers();
    const l = link();
    const peer = new Peer(l.socket);
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(PING_MS);
      l.socket.emit('data', PONG);
    }
    expect(peer.open).toBe(true);
    peer.terminate();
  });
});

describe('silence the server never saw', () => {
  it('does not count while this machine slept: a laptop waking up keeps its DevTools', () => {
    vi.useFakeTimers();
    const l = link();
    const peer = new Peer(l.socket);
    // The lid closes for ten minutes: the wall clock moves on, and no timer runs meanwhile.
    vi.setSystemTime(Date.now() + 10 * 60 * 1000);
    vi.advanceTimersByTime(PING_MS);
    expect(peer.open).toBe(true);
    expect(l.pings()).toBeGreaterThan(0);
    // A far side that is really gone is still dropped, counted from the wake.
    vi.advanceTimersByTime(DEAD_MS + PING_MS);
    expect(peer.open).toBe(false);
  });

  it('gives a socket that asks for it a shorter limit, as a device link through a tunnel does', () => {
    vi.useFakeTimers();
    const l = link();
    expect(3 * PING_MS).toBeLessThan(DEAD_MS);
    const peer = new Peer(l.socket, { deadMs: 2 * PING_MS });
    vi.advanceTimersByTime(PING_MS);
    expect(peer.open).toBe(true);
    vi.advanceTimersByTime(2 * PING_MS);
    expect(peer.open).toBe(false);
  });
});

describe('a socket this side closes', () => {
  it('is let go even when the far side never finishes the close, as a dead tunnel does not', () => {
    vi.useFakeTimers();
    const l = link();
    const peer = new Peer(l.socket);
    peer.close(1000, 'replaced');
    expect(peer.open).toBe(false);
    expect(l.socket.destroyed).toBe(false);
    vi.advanceTimersByTime(CLOSE_MS);
    expect(l.socket.destroyed).toBe(true);
  });
});
