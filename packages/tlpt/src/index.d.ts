import type { Server } from 'node:http';

export const BASE: '/__teleport/';

export interface DevServerOptions {
  port: number;
  /** One interface to listen on. Every interface, IPv4 and IPv6, unless given. */
  host?: string;
  /** Your dev server's URL to proxy, or a folder to serve, with the agent added to each page. */
  app?: string;
  /** Trust any certificate the proxied app presents, not just those this machine trusts. */
  insecure?: boolean;
  /** The path of a launcher's JSON manifest whose `files` list the agent is added to, such as `/app.json`. */
  manifest?: string;
  /** The key a caller shows to drive a device. This user's own, from `~/.config/teleport/key`, unless given. */
  key?: string;
  /** The address the device opens, such as `https://device.example.com`, when it reaches teleport through
   *  a proxy or port forward that doesn't say so in its headers. */
  via?: string;
}

export interface DevServer {
  http: Server;
  /** The key the API and DevTools ask for: they live under `/__teleport/<key>/`. */
  key: string;
  close(): Promise<void>;
}

/** Starts teleport: the relay, and under `/__teleport/<key>/` the API (`api/`) and DevTools for each
 *  connected device (`d/<id>`). */
export function startDevServer(options: DevServerOptions): Promise<DevServer>;
