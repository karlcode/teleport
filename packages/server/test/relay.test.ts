import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KEY } from './keyed.js';
import WebSocket from 'ws';
import { startDevServer, type DevServer } from '../src/server.js';

const require = createRequire(import.meta.url);
const ring = require('../../agent/src/ring.js');
const enc = require('../../agent/src/encode.js');
const S = require('../../agent/src/generated/schema.js');

let server: DevServer;
let port: number;

beforeAll(async () => {
  server = await startDevServer({ port: 0, host: '127.0.0.1' });
  port = (server.http.address() as { port: number }).port;
});
afterAll(() => server.close());

const open = (path: string) =>
  new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });

describe('relay', () => {
  it('decodes a target\'s frames into the samples the API shows', async () => {
    const target = await open('/ws/target?id=relay-1');
    const r = ring.createRing(4, S.S_OVERHEAD_TYPES);
    const i = ring.ringNext(r);
    r.t[i] = 500;
    r.cols[0][i] = 0.5;
    r.cols[1][i] = 1000;
    const e = enc.createEncoder(256);
    const len = enc.encodeFrame(e, [r]);
    target.send(new Uint8Array(e.buf, 0, len));

    let latest: { overheadPct: number; wireBytes: number } | null = null;
    while (!latest) {
      const live = (await (await fetch(`http://127.0.0.1:${port}/__teleport/${KEY}/api/live`)).json()) as { device: { id: string }; latest: typeof latest; stats: { frames: number } }[];
      latest = live.find((d) => d.device.id === 'relay-1')?.latest ?? null;
      if (!latest) await new Promise((r) => setTimeout(r, 5));
    }
    expect(latest.overheadPct).toBe(0.05);
    expect(latest.wireBytes).toBe(len);
    target.close();
  });

  it('rejects unknown websocket paths', async () => {
    await expect(open('/ws/nope')).rejects.toBeTruthy();
  });

  it('serves the built agent', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/teleport.js`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('teleport');
  });
});
