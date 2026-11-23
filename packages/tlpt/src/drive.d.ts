/** Where a running teleport is. */
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

/** A device this run holds. Every call renews the hold; `release` ends it. */
export class Device {
  readonly id: string;
  readonly ua: string;
  readonly href: string;
  /** The browser-level DevTools protocol socket that shows this device alone. */
  readonly cdp: string;
  /** What `connectOverCDP` takes: `chromium.connectOverCDP(device.endpoint)`. */
  readonly endpoint: string;
  /** Presses remote keys (`'right,right,ok'`) or does steps. Rejects when a step failed. */
  keys(seq: string | KeyStep[]): Promise<{ presses: number }>;
  /** Runs code on the device and resolves with its value. A function is sent as its source: write it in what the device's engine reads. */
  eval<T = unknown>(code: string | ((...args: any[]) => T), ...args: unknown[]): Promise<T>;
  /** What the page threw since it loaded, or since `clear`. */
  errors(): Promise<{ total: number; errors: { text: string; [k: string]: unknown }[] }>;
  /** The device's requests through teleport since it loaded, or since `clear`. */
  network(filter?: { url?: string; minMs?: number; failed?: boolean; limit?: number }): Promise<{ url: string; status: number; durMs: number; [k: string]: unknown }[]>;
  /** Forgets the errors and requests so far. */
  clear(): Promise<{ cleared: { errors: number; requests: number } }>;
  capture(ms?: number): Promise<Record<string, unknown>>;
  trial(spec: Record<string, unknown>): Promise<Record<string, unknown>>;
  probe(name: string): Promise<Record<string, unknown>>;
  release(): Promise<void>;
}

/** Every connected device. */
export function devices(options?: ConnectOptions): Promise<{ device: { id: string; ua: string; href: string } }[]>;

/** Reserves a device for this run. Rejects when none is free within `wait`. */
export function reserve(options?: ReserveOptions): Promise<Device>;

export interface FixtureOptions extends Omit<ReserveOptions, 'id' | 'as'> {
  /** The devices to run on, by id, a worker each in order; any that are free otherwise. */
  ids?: string[];
}

/** What `fixtures()` adds to a test: `base.extend<DeviceFixtures<Page>, DeviceWorkerFixtures<Browser>>(fixtures())`. */
export interface DeviceFixtures<Page = unknown> {
  /** The device as a Playwright page, over connectOverCDP. */
  devicePage: Page;
}
export interface DeviceWorkerFixtures<Browser = unknown> {
  /** This worker's own device, held while the worker lives. */
  device: Device;
  deviceBrowser: Browser;
}

/** Fixtures for Playwright's `test.extend`: a device for each worker, cleared before each test. */
export function fixtures(options?: FixtureOptions): any;
