import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tls from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KEY } from './keyed.js';
import WebSocket from 'ws';
import { startDevServer, type DevServer } from '../src/server.js';

const WELL_KNOWN = '/.well-known/appspecific/com.chrome.devtools.json';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const at = (s: DevServer) => `127.0.0.1:${(s.http.address() as { port: number }).port}`;
const tab = (s: DevServer, id: string) =>
  new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(`ws://${at(s)}/ws/target?id=${id}`);
    ws.once('open', () => resolve(ws)).once('error', reject);
  });
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
};

describe("DevTools' workspace question", () => {
  it('names the folder teleport serves, with an id that stays the same for that folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tlpt-ws-'));
    writeFileSync(join(dir, 'index.html'), '<html><head></head><body></body></html>');
    const a = await startDevServer({ port: 0, host: '127.0.0.1', app: dir });
    const b = await startDevServer({ port: 0, host: '127.0.0.1', app: dir });
    try {
      const one = await fetch(`http://${at(a)}${WELL_KNOWN}`);
      expect(one.status).toBe(200);
      const body = await one.json();
      expect(body.workspace.root).toBe(dir);
      expect(body.workspace.uuid).toMatch(UUID);
      expect((await (await fetch(`http://${at(b)}${WELL_KNOWN}`)).json()).workspace.uuid).toBe(body.workspace.uuid);
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });

  it('answers for a proxied app itself, with the folder teleport was started in', async () => {
    const asked: string[] = [];
    const upstream: Server = createServer((req, res) => (asked.push(req.url ?? ''), res.writeHead(404).end()));
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    const s = await startDevServer({ port: 0, host: '127.0.0.1', app: `http://127.0.0.1:${(upstream.address() as { port: number }).port}` });
    try {
      const res = await fetch(`http://${at(s)}${WELL_KNOWN}`);
      expect(res.status).toBe(200);
      expect((await res.json()).workspace.root).toBe(process.cwd());
      expect(asked).toEqual([]);
    } finally {
      await s.close();
      upstream.close();
    }
  });
});

describe('certificates', () => {
  it("trusts this machine's certificate store for every https request once teleport starts", async () => {
    const t = tls as { getCACertificates?: (kind: string) => string[]; setDefaultCACertificates?: (certs: string[]) => void };
    // Node 22.19 and later. Start from Node's own roots without this machine's, as on a machine
    // whose company root Node doesn't ship.
    const system = t.getCACertificates && t.setDefaultCACertificates ? t.getCACertificates('system') : null;
    if (system) t.setDefaultCACertificates!(t.getCACertificates!('bundled').filter((c) => !system.includes(c)));
    const s = await startDevServer({ port: 0, host: '127.0.0.1' });
    try {
      if (system) expect(t.getCACertificates!('default')).toEqual(expect.arrayContaining(system));
    } finally {
      await s.close();
    }
  });
});

describe('what opens is DevTools', () => {
  let s: DevServer;
  const offered: [string, boolean][] = [];
  beforeAll(async () => {
    s = await startDevServer({ port: 0, host: '127.0.0.1', onTab: (id, opening) => offered.push([id, opening]) });
  });
  afterAll(() => s.close());

  it("teleport's own address says how DevTools opens, to whoever comes without the key", async () => {
    const res = await fetch(`http://${at(s)}/__teleport/`, { redirect: 'manual' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain("press d in tlpt's console");
  });

  it('the DevTools link opened before any screen waits, and opens on the first one', async () => {
    const link = fetch(`http://${at(s)}/__teleport/${KEY}/d`, { redirect: 'manual' });
    await new Promise((r) => setTimeout(r, 100));
    const dut = await tab(s, 'first');
    const res = await link;
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`/__teleport/frontend/devtools_app.html?ws=${at(s)}/__teleport/${KEY}/ws/first`);
    // The waiting link is opening on this screen, so the CLI opens no other DevTools for it.
    expect(offered).toEqual([['first', true]]);
    dut.close();
  });

  it('each screen with no DevTools on it is offered for one', async () => {
    const dut = await tab(s, 'second');
    await until(() => offered.length > 1);
    expect(offered).toEqual([
      ['first', true],
      ['second', false],
    ]);
    dut.close();
  });
});
