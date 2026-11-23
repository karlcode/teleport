import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { agentApi, findEndpoint, pointAt, tailscale, tunnelCommand, type Run } from '../src/tunnel.js';

type Def = { name: string; url: string; upstream: { url: string; protocol?: string }; traffic_policy?: string; inspect?: boolean };

/** A tunnel agent's local API, as one forwarding to port 54866 leaves it, recording what it is asked to change. */
async function agent(endpoints: Def[], status = 200) {
  const puts: { name: string; body: Def }[] = [];
  const server: Server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/endpoints') {
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ endpoints: endpoints.map((e) => ({ ...e, uri: `/api/endpoints/${e.name}` })), uri: '/api/endpoints' }));
    }
    if (req.method === 'PUT' && req.url === '/api/endpoints') {
      let text = '';
      req.on('data', (c) => (text += c)).on('end', () => {
        const body = JSON.parse(text) as Def;
        puts.push({ name: body.name, body });
        if (status < 300) endpoints.splice(endpoints.findIndex((e) => e.name === body.name), 1, body);
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(status < 300 ? body : { msg: 'nope' }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return { api: `http://127.0.0.1:${(server.address() as { port: number }).port}/api`, puts, endpoints };
}
const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

const APP = { name: 'command_line', url: 'https://device-dev.tunnel.example', upstream: { url: 'http://localhost:54866', protocol: 'http1' }, traffic_policy: 'on_http_request: []', inspect: true };

describe('the tunnel a developer already runs', () => {
  it('is found by its public address or by the local port it forwards to, with the app behind it', async () => {
    const a = await agent([{ ...APP }]);
    for (const given of ['https://device-dev.tunnel.example', 'device-dev.tunnel.example', 'localhost:54866', '54866', 'http://127.0.0.1:54866/home']) {
      const e = await findEndpoint(given, 7070, [agentApi([a.api])]);
      expect(e, given).toMatchObject({ name: 'command_line', url: 'https://device-dev.tunnel.example', app: 'http://localhost:54866' });
    }
  });

  it('is not found for another address, another port, or with no agent running', async () => {
    const a = await agent([{ ...APP }]);
    expect(await findEndpoint('https://other.example', 7070, [agentApi([a.api])])).toBeNull();
    expect(await findEndpoint('localhost:3000', 7070, [agentApi([a.api])])).toBeNull();
    expect(await findEndpoint('localhost:54866', 7070, [agentApi(['http://127.0.0.1:9/api'])])).toBeNull();
  });

  it('after a teleport that never pointed it back, is found by the app it should forward to', async () => {
    const a = await agent([{ ...APP, upstream: { url: 'http://localhost:7070', protocol: 'http1' } }]);
    expect(await findEndpoint('localhost:54866', 7070, [agentApi([a.api])])).toMatchObject({ name: 'command_line', app: 'http://localhost:54866' });
    // Its public address alone can't say where the app is.
    expect(await findEndpoint('https://device-dev.tunnel.example', 7070, [agentApi([a.api])])).toMatchObject({ name: 'command_line', app: null });
  });

  it('is pointed elsewhere keeping the rest of its definition, and says when the agent refuses', async () => {
    const a = await agent([{ ...APP }]);
    const e = (await findEndpoint('localhost:54866', 7070, [agentApi([a.api])]))!;
    expect(await pointAt(e, 'http://localhost:7070')).toBe(true);
    expect(a.puts).toEqual([{ name: 'command_line', body: { ...APP, upstream: { url: 'http://localhost:7070', protocol: 'http1' } } }]);
    expect(await pointAt(e, 'http://localhost:54866')).toBe(true);
    expect(a.endpoints[0]).toEqual(APP);

    const refusing = await agent([{ ...APP }], 400);
    expect(await pointAt((await findEndpoint('localhost:54866', 7070, [agentApi([refusing.api])]))!, 'http://localhost:7070')).toBe(false);
  });
});

describe('Tailscale serve and funnel', () => {
  const STATUS = {
    TCP: { '443': { HTTPS: true }, '8443': { HTTPS: true } },
    Web: {
      'mac.tail1234.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:54866' } } },
      'mac.tail1234.ts.net:8443': { Handlers: { '/docs': { Proxy: 'http://localhost:4000' } } },
    },
    AllowFunnel: { 'mac.tail1234.ts.net:443': true },
  };
  const fake = (status: unknown, ok = true) => {
    const calls: string[][] = [];
    const exec: Run = async (_bin, args) => (calls.push(args), args[1] === 'status' ? JSON.stringify(status) : ok ? '' : null);
    return { calls, vendor: tailscale(exec) };
  };

  it('finds what each name and path forwards, and re-points it in place, funnel as funnel', async () => {
    const { calls, vendor } = fake(STATUS);
    const e = (await findEndpoint('54866', 7070, [vendor]))!;
    expect(e).toMatchObject({ vendor: 'tailscale', url: 'https://mac.tail1234.ts.net', app: 'http://127.0.0.1:54866' });
    expect(await pointAt(e, 'http://localhost:7070')).toBe(true);
    expect(calls.at(-1)).toEqual(['funnel', '--bg', '--https=443', 'http://localhost:7070']);
    const docs = (await findEndpoint('https://mac.tail1234.ts.net:8443/docs', 7070, [vendor]))!;
    expect(docs.app).toBe('http://localhost:4000');
    await pointAt(docs, 'http://localhost:7070');
    expect(calls.at(-1)).toEqual(['serve', '--bg', '--https=8443', '--set-path=/docs', 'http://localhost:7070']);
  });

  it('finds nothing when Tailscale is missing, serves nothing, or says something it cannot read', async () => {
    for (const out of [null, '{}', 'not json']) expect(await findEndpoint('54866', 7070, [tailscale(async () => out)])).toBeNull();
    const { vendor } = fake(STATUS, false);
    expect(await pointAt((await findEndpoint('54866', 7070, [vendor]))!, 'http://localhost:7070')).toBe(false);
  });

  it('asks every vendor at once, and one that fails never hides another', async () => {
    const a = await agent([{ ...APP, upstream: { url: 'http://localhost:3000' } }]);
    const broken = { name: 'broken', find: () => Promise.reject(new Error('no')) };
    expect(await findEndpoint('3000', 7070, [broken, tailscale(async () => '{}'), agentApi([a.api])])).toMatchObject({ vendor: 'agent', app: 'http://localhost:3000' });
  });
});

describe('any tunnel, by its own command', () => {
  const fakeTunnel = `node -e "console.error('INF |  https://quiet-owl-12.trycloudflare.com  |'); console.log('port', process.argv[1]); setInterval(()=>{},1000)"`;

  it('runs the command pointed at tlpt and takes the first https address it prints', async () => {
    const t = tunnelCommand(fakeTunnel + ' {port}', 7070);
    expect(await t.url).toBe('https://quiet-owl-12.trycloudflare.com');
    t.stop();
  });

  it('says why when the command is missing or ends, and gives up on one that prints no address', async () => {
    const missing = tunnelCommand('no-such-tunnel-cli --to', 7070);
    const why = new Promise<string>((r) => missing.onExit(r));
    expect(await missing.url).toBeNull();
    expect(await why).toBe('no-such-tunnel-cli is not installed');
    const ends = tunnelCommand(`node -e "console.error('bad token'); process.exit(3)"`, 7070);
    const ended = new Promise<string>((r) => ends.onExit(r));
    expect(await ended).toBe('node ended (exit 3): bad token');
    const quiet = tunnelCommand(`node -e "setInterval(()=>{},1000)"`, 7070, 200);
    expect(await quiet.url).toBeNull();
    quiet.stop();
    expect(() => tunnelCommand('  ', 7070)).toThrow(/needs a command/);
  });
});
