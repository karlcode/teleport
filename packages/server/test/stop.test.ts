import { describe, expect, it } from 'vitest';
import { KEY } from './keyed.js';
import { startDevServer } from '../src/server.js';

describe('stop endpoint', () => {
  it('lets a newer teleport on this machine stop this one, and nothing else', async () => {
    let stopped = 0;
    const server = await startDevServer({ port: 0, host: '127.0.0.1', onStop: () => stopped++ });
    const url = `http://127.0.0.1:${(server.http.address() as { port: number }).port}/__teleport/${KEY}/api/stop`;
    try {
      // Whoever holds this user's key is this user's tlpt; anyone else is refused, as is a GET.
      expect((await fetch(url.replace(KEY, 'wrongkey00'), { method: 'POST' })).status).toBe(403);
      expect((await fetch(url)).status).toBe(403);
      expect(stopped).toBe(0);
      expect((await fetch(url, { method: 'POST' })).status).toBe(200);
      await new Promise((r) => setImmediate(r));
      expect(stopped).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('refuses when the embedding app gave no way to stop', async () => {
    const server = await startDevServer({ port: 0, host: '127.0.0.1' });
    const url = `http://127.0.0.1:${(server.http.address() as { port: number }).port}/__teleport/${KEY}/api/stop`;
    try {
      expect((await fetch(url, { method: 'POST' })).status).toBe(403);
    } finally {
      await server.close();
    }
  });
});
