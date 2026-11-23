// A test runner's side of teleport: reserve a device, drive it, read what it threw and asked for,
// let it go. A thin client of the HTTP API of a teleport that is running, with nothing of the server
// in it, so a test file that imports it loads little. `fixtures()` is the same thing shaped for
// Playwright's `test.extend`: a device for each worker, so workers run on devices side by side.
import { readKey } from './key.js';

export interface ConnectOptions {
  /** Where teleport listens: `TELEPORT_PORT`, else 7070, unless given. */
  port?: number;
  /** teleport's key; this user's own, from `~/.config/teleport/key`, unless given. */
  key?: string;
}

export interface ReserveOptions extends ConnectOptions {
  /** A device by id; the first nobody holds otherwise. */
  id?: string;
  /** Who holds it, as the device's frame and the console say it. */
  as?: string;
  /** How long the hold outlives the last call made with it, 120 s unless given. */
  ms?: number;
  /** False leaves the frame off the device's screen: for a run that measures frames. */
  frame?: boolean;
  /** How long to wait for a device to be free, 0 unless given. */
  wait?: number;
  /** True keeps the errors and requests the device has so far. */
  keep?: boolean;
}

export type KeyStep = string | { key?: string; kind?: 'text' | 'wait' | 'focus' | 'click'; text?: string; ms?: number; selector?: string; repeat?: number; delayMs?: number };

class Refused extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call(o: ConnectOptions, path: string, init: { post?: boolean; body?: unknown; q?: Record<string, string | number | undefined>; hold?: string } = {}): Promise<any> {
  const key = o.key ?? readKey();
  if (!key) throw new Error('no teleport has run on this machine as this user: start it with `tlpt`');
  const port = o.port ?? (Number(process.env.TELEPORT_PORT) || 7070);
  const url = new URL(`http://127.0.0.1:${port}/__teleport/${key}/api/${path}`);
  for (const [k, v] of Object.entries(init.q ?? {})) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    method: init.post || init.body !== undefined ? 'POST' : 'GET',
    headers: { 'x-teleport': 'q', ...(init.hold ? { 'x-teleport-hold': init.hold } : null), ...(init.body !== undefined ? { 'content-type': 'application/json' } : null) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  }).catch((e: Error) => {
    throw new Error(`no teleport on port ${port} (${(e.cause as Error | undefined)?.message ?? e.message}): start it with \`tlpt\``);
  });
  const out = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new Refused(out?.error ?? `teleport answered ${res.status}`, res.status);
  return out;
}

/** Every connected device, as `GET live` lists them. */
export const devices = (o: ConnectOptions = {}): Promise<{ device: { id: string; ua: string; href: string } }[]> => call(o, 'live');

/** A device this run holds. Every call renews the hold; `release` ends it. */
export class Device {
  constructor(
    private o: ConnectOptions,
    readonly id: string,
    private token: string,
    readonly ua: string,
    readonly href: string,
    /** The browser-level DevTools protocol socket that shows this device alone. */
    readonly cdp: string,
  ) {}

  /** What `connectOverCDP` takes: `chromium.connectOverCDP(device.endpoint)`. */
  get endpoint(): string {
    return this.cdp;
  }

  private ask(path: string, init: Parameters<typeof call>[2] = {}) {
    return call(this.o, path, { ...init, hold: this.token, q: { ...init.q, id: this.id } });
  }

  /** Presses remote keys (`'right,right,ok'`) or does steps, and resolves with the run. Rejects when a step failed. */
  async keys(seq: string | KeyStep[]): Promise<{ presses: number }> {
    const run = await (typeof seq === 'string' ? this.ask('keys', { post: true, q: { seq } }) : this.ask('keys', { body: { steps: seq } }));
    if (run.error) throw new Error(run.error);
    return run;
  }

  /** Runs code on the device and resolves with its value. A function is sent as its source, called with `args`: write it in what the device's engine reads (ES5 on an old one). */
  async eval<T = unknown>(code: string | ((...args: any[]) => T), ...args: unknown[]): Promise<T> {
    const expr = typeof code === 'function' ? `(${String(code)}).apply(null,${JSON.stringify(args)})` : code;
    return (await this.ask('eval', { body: { expr } })).value as T;
  }

  /** What the page threw since it loaded, or since `clear`. */
  errors(): Promise<{ total: number; errors: { text: string; [k: string]: unknown }[] }> {
    return this.ask('errors');
  }

  /** The device's requests through teleport since it loaded, or since `clear`. */
  network(filter: { url?: string; minMs?: number; failed?: boolean; limit?: number } = {}): Promise<{ url: string; status: number; durMs: number; [k: string]: unknown }[]> {
    return this.ask('network', { q: { url: filter.url, minMs: filter.minMs, failed: filter.failed ? 1 : undefined, limit: filter.limit } });
  }

  /** Forgets the errors and requests so far: the next test reads only its own. */
  clear(): Promise<{ cleared: { errors: number; requests: number } }> {
    return this.ask('clear', { post: true });
  }

  /** Records frames for `ms` and resolves with the report. */
  capture(ms = 10_000): Promise<Record<string, unknown>> {
    return this.ask('capture', { post: true, q: { ms } });
  }

  /** Runs a trial and resolves with its report. */
  trial(spec: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.ask('trial', { body: { spec } });
  }

  probe(name: string): Promise<Record<string, unknown>> {
    return this.ask('probe', { q: { name } });
  }

  /** Lets the device go, and takes the frame off its screen. */
  async release(): Promise<void> {
    await this.ask('release', { post: true }).catch(() => {});
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Reserves a device for this run. Rejects when none is free within `wait`. */
export async function reserve(o: ReserveOptions = {}): Promise<Device> {
  const until = Date.now() + (o.wait ?? 0);
  for (;;) {
    try {
      const r = await call(o, 'reserve', { post: true, q: { id: o.id, as: o.as, ms: o.ms, frame: o.frame === false ? 0 : undefined, keep: o.keep ? 1 : undefined } });
      return new Device(o, r.id, r.token, r.ua, r.href, r.cdp);
    } catch (e) {
      // Held by another run, or not connected yet: both may pass.
      if (!(e instanceof Refused) || (e.status !== 423 && e.status !== 404) || Date.now() >= until) throw e;
      await sleep(500);
    }
  }
}

export interface FixtureOptions extends Omit<ReserveOptions, 'id' | 'as'> {
  /** The devices to run on, by id, a worker each in order; any that are free otherwise. */
  ids?: string[];
}

/**
 * Fixtures for Playwright's `test.extend`, as plain objects, so this needs no Playwright of its own:
 *
 *   import { test as base } from '@playwright/test';
 *   import { fixtures } from 'tlpt/drive';
 *   export const test = base.extend(fixtures());
 *
 * `device` is a worker's own device, held for as long as the worker lives: with `workers: 3` and
 * three devices connected, three test files run at once, one on each. Before each test its errors
 * and requests are forgotten, and what it threw during the test is put on the test as an annotation.
 * `devicePage` is the device as a Playwright `Page`, over `connectOverCDP`, for an engine new enough
 * to read Playwright's own scripts.
 */
export function fixtures(o: FixtureOptions = {}) {
  return {
    device: [
      async ({}: object, use: (d: Device) => Promise<void>, info: { parallelIndex: number; project?: { name?: string } }) => {
        const d = await reserve({ wait: 30_000, ...o, id: o.ids?.[info.parallelIndex % o.ids.length], as: `${info.project?.name || 'playwright'} #${info.parallelIndex + 1}` });
        try {
          await use(d);
        } finally {
          await d.release();
        }
      },
      { scope: 'worker' },
    ],
    deviceFresh: [
      async ({ device }: { device: Device }, use: () => Promise<void>, info: { annotations: { type: string; description?: string }[] }) => {
        await device.clear();
        await use();
        const threw = await device.errors().catch(() => null);
        if (threw?.total) info.annotations.push({ type: 'device errors', description: threw.errors.map((e) => e.text).join('\n') });
      },
      { auto: true },
    ],
    deviceBrowser: [
      async ({ playwright, device }: { playwright: { chromium: { connectOverCDP(url: string): Promise<{ contexts(): { pages(): unknown[] }[]; close(): Promise<void> }> } }; device: Device }, use: (b: unknown) => Promise<void>) => {
        const browser = await playwright.chromium.connectOverCDP(device.endpoint);
        try {
          await use(browser);
        } finally {
          await browser.close().catch(() => {});
        }
      },
      { scope: 'worker' },
    ],
    devicePage: async ({ deviceBrowser }: { deviceBrowser: { contexts(): { pages(): unknown[] }[] } }, use: (page: unknown) => Promise<void>) => {
      const page = deviceBrowser.contexts()[0]?.pages()[0];
      if (!page) throw new Error("the device's page is not there: is the app still open on it?");
      await use(page);
    },
  } as const;
}
