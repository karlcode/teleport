// Sits between DevTools and one device's inspector. Tree-reading DOM methods are answered from the
// laptop's copy of the tree. The copy holds only what the page has sent: the top of the tree, then
// each subtree as DevTools expands it. What a request needs and the copy lacks is asked of the page
// first (`teleport.expand` for children, `teleport.reveal` for the path to a node), so the device
// serializes a node once, when someone looks at it. Methods only the page can answer are forwarded,
// and their replies get node ids DevTools hasn't seen pushed to it first, as Chrome's backend does.
import { DomMirror, type Event, type Op } from './mirror.js';
/** Where a reply goes: a DevTools client's link. */
interface Client {
  send(msg: string): void;
}

interface Message {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: unknown;
}

const SERVED = new Set(['DOM.getDocument', 'DOM.requestChildNodes', 'DOM.describeNode', 'DOM.getAttributes', 'DOM.pushNodesByBackendIdsToFrontend']);
/** Forwarded methods whose replies carry node ids DevTools may not have yet. */
const PUSHES = new Set(['DOM.requestNode', 'DOM.querySelector', 'DOM.querySelectorAll', 'DOM.getNodeForLocation', 'DOM.moveTo', 'DOM.getSearchResults']);
/** Rounds of asking the page for more of the tree one request may take: one per level it descends. */
const MAX_ROUNDS = 64;

type Ask = 'expand' | 'reveal';

/**
 * Reads the inspector's flat DOM batches (packages/inspector/src/dom.js `flat`) back into the ops
 * the copy applies. Tag and attribute names arrive as text once and as their number after; the
 * list starts again with each epoch, which every batch names. A batch that can't be followed
 * (a number for a name never sent, a count that runs past the end) is null: never a guess.
 */
export class DomWire {
  private epoch = -1;
  private names: string[] = [];

  read(a: unknown[]): Op[] | null {
    if (a[0] !== 10 || !Number.isInteger(a[1])) return null;
    if (a[1] !== this.epoch) {
      this.epoch = a[1] as number;
      this.names = [];
    }
    const ops: Op[] = [];
    let i = 2;
    let ok = true;
    const int = () => {
      const v = a[i++];
      if (!Number.isInteger(v)) ok = false;
      return v as number;
    };
    const str = () => {
      const v = a[i++];
      if (typeof v !== 'string') ok = false;
      return v as string;
    };
    const name = () => {
      const v = a[i++];
      if (typeof v === 'string') return this.names.push(v), v;
      const known = Number.isInteger(v) ? this.names[v as number] : undefined;
      if (known === undefined) ok = false;
      return known ?? '';
    };
    const node = (): number | [number, number, ...unknown[]] => {
      const id = int();
      if (id < 0) return -id;
      const type = int();
      if (type === 1) {
        const tag = name();
        const n = int();
        const attrs: string[] = [];
        for (let k = 0; ok && k < n; k++) attrs.push(name(), str());
        const count = -1 - int();
        if (count < 0) ok = false;
        return [id, 1, tag, attrs, count];
      }
      if (type === 3 || type === 8) return [id, type, str()];
      if (type === 10) return [id, 10, str(), str(), str()];
      ok = false;
      return 0;
    };
    while (ok && i < a.length) {
      const op = int();
      if (op === 1) {
        const parent = int();
        const n = int();
        const kids: (number | [number, number, ...unknown[]])[] = [];
        for (let k = 0; ok && k < n; k++) kids.push(node());
        ops.push(['k', parent, kids as never]);
      } else if (op === 2) {
        const id = int();
        const attr = name();
        const v = a[i++];
        if (v !== null && typeof v !== 'string') ok = false;
        ops.push(['a', id, attr, v as string | null]);
      } else if (op === 3) ops.push(['c', int(), str()]);
      else if (op === 4) ops.push(['n', int(), int()]);
      else ok = false;
    }
    // Past the end is a batch cut short: every read there was undefined, so `ok` is already false.
    return ok && i === a.length ? ops : null;
  }
}

export class DevtoolsBridge {
  readonly mirror = new DomMirror();
  private pushes = new Map<number, string>();
  private waiting: (() => void)[] = [];
  private snapshotId = 0;
  private nextId = 0;
  /** Expand and reveal requests out to the page, by id, and what to do once their ops are in. */
  private asks = new Map<number, () => void>();
  private wire = new DomWire();

  constructor(
    private toDevice: (msg: string) => void,
    private toClients: (msg: string) => void,
  ) {}

  /** Forgets the copy, e.g. when the inspector reconnects. Requests still waiting get a new snapshot. */
  reset() {
    this.mirror.reset();
    this.pushes.clear();
    this.snapshotId = 0;
    // Requests that were asking the page for more start over against the new copy.
    for (const then of this.asks.values()) this.waiting.push(then);
    this.asks.clear();
    if (this.waiting.length) this.requestSnapshot();
  }

  /** Handles a DevTools message. Returns false when it should go to the device unchanged. */
  fromClient(ws: Client, m: Message): boolean {
    const method = m.method ?? '';
    const p = m.params ?? {};
    if (SERVED.has(method) && !(method === 'DOM.describeNode' && p.objectId)) {
      this.whenReady(() =>
        this.loaded(method, p, new Set(), 0, () => {
          const out: Event[] = [];
          const r = this.serve(method, p, out);
          this.emit(out);
          ws.send(JSON.stringify(typeof r === 'string' ? { id: m.id, error: { code: -32000, message: r } } : { id: m.id, result: r }));
        }),
      );
      return true;
    }
    if (PUSHES.has(method) && typeof m.id === 'number') this.pushes.set(m.id, method);
    return false;
  }

  /** Handles a device message. Returns the message to forward to DevTools, or null. */
  fromDevice(raw: string, m: Message | null): string | null {
    if (!m) return raw;
    if (typeof m.id === 'number' && m.id < 0) {
      // One of this bridge's own requests.
      if (m.id === this.snapshotId) {
        this.snapshotId = 0;
        // A snapshot that isn't a tree leaves no copy, and what waited for it is told so (`serve`).
        if (m.result) this.mirror.load(m.result.root);
        const run = this.waiting;
        this.waiting = [];
        for (const fn of run) fn();
        return null;
      }
      const then = this.asks.get(m.id);
      if (then) {
        this.asks.delete(m.id);
        const ops = this.ops(m.result?.ops);
        if (ops && this.mirror.ready) this.emit(this.mirror.apply(ops));
        then();
      }
      return null;
    }
    if (m.method === 'teleport.mutations') {
      // Read whether or not the copy is ready: the names a batch brings are needed by the next.
      const ops = this.ops(m.params);
      if (ops && this.mirror.ready) this.emit(this.mirror.apply(ops));
      return null;
    }
    const method = m.id !== undefined ? this.pushes.get(m.id) : undefined;
    if (!method) return raw;
    this.pushes.delete(m.id!);
    if (!m.result || !this.mirror.ready) return raw;
    const r = m.result;
    // The page revealed the search hits' paths along with the ids; the copy takes them first.
    if (method === 'DOM.getSearchResults') {
      const ops = this.ops(r.teleportOps);
      delete r.teleportOps;
      if (ops) this.emit(this.mirror.apply(ops));
    }
    const ids = Array.isArray(r.nodeIds) ? (r.nodeIds as unknown[]) : 'nodeId' in r ? [r.nodeId] : [];
    const unknown = ids.filter((x): x is number => typeof x === 'number' && x > 0 && !this.mirror.has(x));
    const finish = () => {
      const out: Event[] = [];
      const push = (id: unknown) => (typeof id === 'number' ? this.mirror.pushPath(id, out) : 0);
      if (Array.isArray(r.nodeIds)) r.nodeIds = r.nodeIds.map(push);
      else if ('nodeId' in r) r.nodeId = push(r.nodeId);
      this.emit(out);
      return JSON.stringify(m);
    };
    if (!unknown.length) return finish();
    // Nodes the page named that the copy hasn't got: their paths come first, then the reply.
    this.ask('reveal', unknown, () => this.toClients(finish()));
    return null;
  }

  /** A batch of the page's, as ops: flat batches are read, and one that can't be followed makes the
   *  copy stale, so DevTools asks for the document again and the page says its names again. */
  private ops(v: unknown): Op[] | null {
    if (!Array.isArray(v)) return null;
    if (v.length === 0 || Array.isArray(v[0])) return v as Op[];
    const ops = this.wire.read(v);
    if (ops) return ops;
    this.toDevice('{"id":"resync","method":"teleport.resync"}');
    if (this.mirror.ready) {
      this.mirror.stale = true;
      this.emit([{ method: 'DOM.documentUpdated', params: {} }]);
    }
    return null;
  }

  private emit(events: Event[]) {
    for (const e of events) this.toClients(JSON.stringify(e));
  }

  private whenReady(fn: () => void) {
    if (this.mirror.ready) return fn();
    this.waiting.push(fn);
    if (!this.snapshotId) this.requestSnapshot();
  }

  private requestSnapshot() {
    this.snapshotId = --this.nextId;
    this.toDevice(JSON.stringify({ id: this.snapshotId, method: 'teleport.snapshot', params: {} }));
  }

  /** Asks the page for what `method` needs that the copy lacks, a level a round, then runs `then`. */
  private loaded(method: string, p: Record<string, unknown>, tried: Set<number>, round: number, then: () => void) {
    const need = this.needs(method, p).filter((id) => !tried.has(id));
    if (!need.length || round >= MAX_ROUNDS) return then();
    for (const id of need) tried.add(id);
    const kind: Ask = method === 'DOM.getDocument' || method === 'DOM.requestChildNodes' ? 'expand' : 'reveal';
    this.ask(kind, need, () => this.whenReady(() => this.loaded(method, p, tried, round + 1, then)));
  }

  /** Node ids `method` needs from the page before the copy can answer it. */
  private needs(method: string, p: Record<string, unknown>): number[] {
    const m = this.mirror;
    const id = Number(p.nodeId ?? p.backendNodeId ?? 0);
    switch (method) {
      case 'DOM.getDocument':
        return m.missing(m.rootId, p.depth === undefined ? 2 : Number(p.depth)) ?? [];
      case 'DOM.requestChildNodes':
        return m.missing(id, p.depth === undefined ? 1 : Number(p.depth)) ?? [];
      case 'DOM.describeNode':
      case 'DOM.getAttributes':
        return id > 0 && !m.has(id) ? [id] : [];
      case 'DOM.pushNodesByBackendIdsToFrontend':
        return (Array.isArray(p.backendNodeIds) ? (p.backendNodeIds as unknown[]) : []).filter((b): b is number => typeof b === 'number' && b > 0 && !m.has(b));
      default:
        return [];
    }
  }

  private ask(kind: Ask, ids: number[], then: () => void) {
    const id = --this.nextId;
    this.asks.set(id, then);
    this.toDevice(JSON.stringify({ id, method: `teleport.${kind}`, params: { ids } }));
  }

  private serve(method: string, p: Record<string, unknown>, out: Event[]): Record<string, unknown> | string {
    const m = this.mirror;
    // No copy to answer from: the page's snapshot never came, or wasn't one. An error, never a guess.
    if (!m.ready) return "teleport has no copy of the page's document";
    const id = Number(p.nodeId ?? p.backendNodeId ?? 0);
    switch (method) {
      case 'DOM.getDocument':
        return m.getDocument(p.depth === undefined ? 2 : Number(p.depth));
      case 'DOM.requestChildNodes':
        return m.requestChildNodes(id, p.depth === undefined ? 1 : Number(p.depth), out) ? {} : 'Could not find node with given id';
      case 'DOM.describeNode': {
        const node = m.describe(id);
        return node ? { node } : 'Could not find node with given id';
      }
      case 'DOM.getAttributes': {
        const attributes = m.attributes(id);
        return attributes ? { attributes } : 'Could not find node with given id';
      }
      case 'DOM.pushNodesByBackendIdsToFrontend':
        return { nodeIds: (Array.isArray(p.backendNodeIds) ? (p.backendNodeIds as number[]) : []).map((b) => m.pushPath(b, out)) };
      default:
        return {};
    }
  }
}
