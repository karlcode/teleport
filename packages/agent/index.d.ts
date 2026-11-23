/** teleport's on-device agent. Importing it does nothing: it is asleep until the app calls `init`.
 *  None of its calls throw, whatever they are passed, and nothing it does on the device reaches the
 *  app's console or error reporting. */
declare const teleport: teleport.Teleport;

declare namespace teleport {
  interface Teleport {
    version: string;
    /** Starts the agent. `url` is teleport's relay, e.g. `ws://192.168.1.20:7070/ws/target`. Without
     *  one it reports to the teleport on the machine that served the page: that host on port 7070
     *  for this machine or a private network address, the page's own address under `/__teleport/`
     *  for anywhere else, and nowhere for a page no host served. Nothing shows on the screen unless
     *  `badge: true`, which adds a small square in the screen's corner, lit while the laptop is
     *  connected (`data-badge="on"` does the same for the script tag). */
    init(options?: { url?: string; badge?: boolean }): Teleport;
    stop(): Teleport;
    status(): { running: boolean; overheadPct: number; selfMs: number; [key: string]: unknown };
  }
}

export = teleport;
