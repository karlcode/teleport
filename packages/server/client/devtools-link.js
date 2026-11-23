// Keeps Chrome's DevTools attached to a device through dropped links and teleport restarts. teleport
// serves this into its copy of the DevTools frontend, ahead of DevTools itself. DevTools' socket to
// teleport (/__teleport/<key>/ws/<tab>) becomes a durable link (packages/server/src/link.ts): the socket under
// it is replaced whenever it drops, both sides number their messages so none is missed or repeated,
// and DevTools never sees a close. A teleport that comes back with nothing of the link (it restarted)
// gets DevTools' state again: what DevTools switched on, then the requests it still waits on.
(() => {
  const Native = window.WebSocket;
  const CONTROL = '{"teleport":';
  const RETRY_MS = [100, 250, 500, 1000, 2000];
  const ACK_MS = 1000;
  /** The calls that set a domain's state, the last of each kept for a teleport that lost it. */
  const STATE = /^(\w+)\.(?:enable|disable)$/;
  /** A reply's id, read without parsing the whole message. */
  const REPLY = /^\{"id":(\d+|"[^"]*")/;

  const token = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');

  class DurableSocket extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor(url) {
      super();
      this.url = url;
      this.readyState = 0;
      this.protocol = '';
      this.extensions = '';
      this.binaryType = 'blob';
      this.onopen = this.onmessage = this.onclose = this.onerror = null;
      this.link = token();
      /** Messages received from teleport, which it asks after on reconnect. */
      this.got = 0;
      this.acked = 0;
      this.sent = 0;
      /** Sent and not yet acknowledged, oldest first. */
      this.kept = [];
      /** Sent by DevTools while no socket was ready. */
      this.out = [];
      /** Requests DevTools waits on, by id. */
      this.waiting = new Map();
      this.state = new Map();
      this.page = null;
      this.ready = false;
      this.opened = false;
      this.tries = 0;
      this.ws = null;
      this.ackTimer = 0;
      this.banner = new Banner();
      addEventListener('pagehide', () => this.ws?.readyState === 1 && this.ws.send('{"teleport":"bye"}'));
      this.connect();
    }

    get bufferedAmount() {
      return this.ws ? this.ws.bufferedAmount : 0;
    }

    connect() {
      if (this.readyState >= 2) return;
      const u = new URL(this.url, location.href);
      u.searchParams.set('link', this.link);
      u.searchParams.set('got', String(this.got));
      if (this.page !== null) u.searchParams.set('page', this.page);
      const ws = new Native(u.href);
      this.ws = ws;
      this.ready = false;
      ws.onmessage = (e) => this.ws === ws && this.receive(e.data);
      ws.onclose = () => this.ws === ws && this.lost();
    }

    lost() {
      this.ws = null;
      this.ready = false;
      if (this.readyState >= 2) return;
      if (++this.tries > 3) this.banner.show('teleport: reconnecting…');
      setTimeout(() => this.connect(), RETRY_MS[Math.min(this.tries - 1, RETRY_MS.length - 1)]);
    }

    receive(data) {
      if (typeof data === 'string' && data.startsWith(CONTROL)) return this.control(JSON.parse(data));
      this.got++;
      if (!this.ackTimer) this.ackTimer = setTimeout(() => this.ack(), ACK_MS);
      const id = REPLY.exec(data)?.[1];
      if (id !== undefined) {
        // A reply to state sent again for a teleport that lost it: DevTools never asked.
        if (id.charCodeAt(0) === 34) return;
        this.waiting.delete(+id);
      }
      this.emit('message', data);
    }

    control(c) {
      if (c.teleport === 'link') return this.linked(c);
      if (c.teleport === 'ack') return this.trim(c.got);
      if (c.teleport === 'page') this.page = c.page;
      else if (c.teleport === 'away') this.banner.show('teleport: the device is away. DevTools carries on when it is back.', 1000);
      else if (c.teleport === 'here') this.banner.hide();
    }

    linked(c) {
      this.tries = 0;
      this.banner.hide();
      if (c.kept) {
        this.trim(c.got);
        for (const msg of this.kept) this.ws.send(msg);
      } else {
        // A teleport with nothing of this link: numbering starts again, and DevTools' state goes again.
        this.got = this.acked = this.sent = 0;
        this.kept = [];
        if (this.opened) {
          const queued = new Set(this.out);
          for (const [domain, msg] of this.state) this.write(withId(msg, `"teleport:${domain}"`));
          for (const msg of this.waiting.values()) if (!queued.has(msg)) this.write(msg);
        }
      }
      this.ready = true;
      const out = this.out;
      this.out = [];
      for (const msg of out) this.write(msg);
      if (!this.opened) {
        this.opened = true;
        this.readyState = 1;
        this.emit('open');
      }
    }

    send(data) {
      if (this.readyState >= 2) return;
      const m = parse(data);
      if (typeof m?.id === 'number') this.waiting.set(m.id, data);
      const s = typeof m?.method === 'string' && STATE.exec(m.method);
      if (s) this.state.set(s[1], data);
      if (this.ready) this.write(data);
      else this.out.push(data);
    }

    write(msg) {
      this.sent++;
      this.kept.push(msg);
      this.ws.send(msg);
    }

    ack() {
      this.ackTimer = 0;
      if (this.ws?.readyState === 1) this.ws.send(`{"teleport":"ack","got":${this.got}}`);
    }

    trim(theirGot) {
      if (theirGot <= this.acked) return;
      this.acked = Math.min(theirGot, this.sent);
      const first = this.sent - this.kept.length + 1;
      this.kept.splice(0, Math.max(0, this.acked - first + 1));
    }

    close() {
      if (this.readyState >= 2) return;
      this.readyState = 3;
      const ws = this.ws;
      this.ws = null;
      if (ws?.readyState === 1) ws.send('{"teleport":"bye"}');
      ws?.close();
      this.banner.hide();
      setTimeout(() => this.emit('close'), 0);
    }

    emit(type, data) {
      const e = type === 'message' ? new MessageEvent('message', { data }) : type === 'close' ? new CloseEvent('close', { code: 1000 }) : new Event(type);
      this['on' + type]?.call(this, e);
      this.dispatchEvent(e);
    }
  }

  /** A line over DevTools saying why nothing new arrives, shown only if it lasts. */
  class Banner {
    constructor() {
      this.el = null;
      this.timer = 0;
    }
    show(text, afterMs = 0) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        if (!document.body) return;
        if (!this.el) {
          this.el = document.createElement('div');
          this.el.style.cssText =
            'position:fixed;top:6px;left:50%;transform:translateX(-50%);z-index:2147483647;pointer-events:none;' +
            'font:12px/1.4 system-ui,sans-serif;padding:4px 10px;border-radius:4px;background:#b25d00;color:#fff;box-shadow:0 1px 4px rgb(0 0 0 / 30%)';
        }
        this.el.textContent = text;
        if (!this.el.isConnected) document.body.append(this.el);
      }, afterMs);
    }
    hide() {
      clearTimeout(this.timer);
      this.el?.remove();
    }
  }

  function parse(s) {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  }

  function withId(msg, id) {
    return msg.replace(/^\{"id":\d+/, `{"id":${id}`);
  }

  window.WebSocket = new Proxy(Native, {
    construct(target, args) {
      return /\/ws\/client\/[^/?]+/.test(String(args[0])) ? new DurableSocket(String(args[0])) : new target(...args);
    },
  });
})();
