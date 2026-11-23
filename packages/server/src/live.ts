// What the laptop derives from the device's raw records, as the API and `tlpt q` show it. Everything
// here is computed on the laptop; the device only sent timestamps and counters.

import type { PageError } from './errors.js';
/** One sample per agent frame (about 1 Hz). null means the device can't measure it. */
export interface Point {
  t: number;
  overheadPct: number | null;
  lagMs: number | null;
  longTaskMs: number;
  longTasks: number;
  heapMB: number | null;
  heapTotalMB: number | null;
  videoDroppedPerS: number | null;
  videoDecodedPerS: number | null;
  resources: number;
  resourceKB: number;
  keys: number;
  /** Slowest key → next frame in this frame, ms. */
  keyToFrameMs: number | null;
  /** Animation frames are recorded only during a capture, so these are null outside one. */
  fps: number | null;
  frameP95Ms: number | null;
  /** Size of the agent's frame on the wire, so its bandwidth shows next to its CPU cost. */
  wireBytes: number;
  /** Bytes waiting on the device's sockets to the laptop (agent, and inspector while DevTools is open). */
  agentQueuedKB: number | null;
  inspectorQueuedKB: number | null;
  /** The inspector's share of the main thread in its last second, while DevTools is open. */
  inspectorPct: number | null;
  /** The inspector governor's level: 0 normal, 1 shed, 2 survive. */
  level: number;
  heapLimitMB: number | null;
  domNodes: number | null;
  /** How long DevTools messages spend between the device queueing them and the laptop receiving them. */
  devtoolsLagMs: number | null;
}

/** Where a key press's time went, in the order it happens. Matches the agent's keyphase stream. */
export const KEY_PHASES = ['inputDelay', 'handlers', 'waitFrame', 'raf', 'style', 'layout', 'paint'] as const;
export type KeyPhase = (typeof KEY_PHASES)[number];
/** ms per phase; null where the device couldn't measure it. */
export type KeyPhases = Record<KeyPhase, number | null>;

/** Key → next frame grouped by the element that had focus. */
export interface KeyTargetStat {
  target: string;
  keys: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  /** Median of each phase over the probed keys, null when none were probed. */
  phases: KeyPhases | null;
}

/** Health of the link and of the agent's rings. */
export interface DeviceStats {
  frames: number;
  badFrames: number;
  /** Messages from the page, its inspector or its DevTools that teleport could not read, and dropped. */
  unread: number;
  bytesIn: number;
  /** Bytes the inspector sent, while DevTools is open. */
  inspectorBytesIn: number;
  /** Cumulative records each ring overwrote before they were sent. */
  dropped: Record<string, number>;
  offsetMs: number;
  rttMs: number | null;
  names: number;
}

export interface DeviceInfo {
  id: string;
  href: string;
  ua: string;
  ip: string;
  inspecting: boolean;
  /** Opens Chrome's DevTools for this device from a normal http link. */
  inspect: string;
  /** The same DevTools by its `devtools://` address, for when the frontend can't be fetched. */
  devtools: string;
  started: number;
  /** The inspector governor's level and why it is there, while the inspector is loaded. */
  governor: { level: number; reason: string };
  /** Uncaught errors, unhandled rejections and scripts that did not load, in this page load. */
  errors: number;
}

/** What adds teleport to an app tlpt isn't serving: the import, which leaves the agent asleep, and
 *  the call that starts it against this laptop (`lan` is its address and port). */
export const AUTO_LINE = "import teleport from '@tlpt/agent'";
export const initLine = (lan: string) => `teleport.init({ url: '${/^wss?:\/\//.test(lan) ? lan : `ws://${lan}`}/ws/target' })`;

/** Who asked the API for something: the console, `tlpt q`, `tlpt mcp` (an AI agent), or anything else. */
export type Caller = 'console' | 'q' | 'mcp' | 'other';

/**
 * What happened to a device, as it happens, for the console. Everything that touches a device is here
 * whoever asked for it, so a developer sees what an AI agent did on their device too.
 */
export type ServerEvent =
  /** A page connected: a tab seen for the first time, the same tab after a reload, or the same page back after its link dropped. */
  | { type: 'page'; id: string; kind: 'new' | 'reload' | 'relink'; href: string; ua: string; ip: string }
  /** A page's socket ended. `waiting`: DevTools is open on it and waits a minute for it to come back. */
  | { type: 'gone'; id: string; waiting: boolean }
  /** A frame of samples arrived: about once a second per device. */
  | { type: 'sample'; id: string }
  /** DevTools windows open on the device now. */
  | { type: 'devtools'; id: string; open: number }
  /** The inspector governor changed level: 0 normal, 1 shed, 2 survive. */
  | { type: 'governor'; id: string; level: number; reason: string }
  /** The page threw, a promise was rejected with nothing handling it, or a script did not load. `total` so far in this page load. */
  | { type: 'error'; id: string; error: PageError; total: number }
  /** The page's error count grew past the ones reported one by one (the agent holds the first and last few). */
  | { type: 'errors'; id: string; total: number }
  /** The inspector counted these instead of reporting them since the last such event: its link was full, or its governor had stopped them. */
  | { type: 'dropped'; id: string; console: number; network: number }
  /** An API call that does something on the device began or ended. */
  | { type: 'call'; id: string; by: Caller; what: string; phase: 'start' | 'end'; ms?: number; error?: string }
  /** A request a device made through teleport, as it finished. `id` is the device it came from, null when no device is connected from that address. */
  | { type: 'request'; id: string | null; ip: string; method: string; url: string; status: number; ms: number; failed?: string; document: boolean }
  /** A test run reserved the device, as `as`; null when it let go or its time ran out. */
  | { type: 'hold'; id: string; as: string | null }
  /** A trial's progress on a device. */
  | { type: 'trial'; id: string; by: Caller; name: string; done: number; total: number; phase: 'start' | 'run' | 'end' };
