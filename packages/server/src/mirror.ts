// The laptop's copy of a device's element tree. The page sends a snapshot of the top of the tree,
// then each subtree as DevTools expands it, then compact mutation batches (format in
// packages/inspector/src/dom.js). DevTools' tree requests are answered from here; what the copy
// lacks, the bridge asks the page for first (`missing`), so the device serializes only what is looked at.
//
// The copy also tracks what the DevTools frontend has been told: `shown` nodes it has a DOMNode
// for, `opened` nodes whose children it has. Re-sending a level makes DevTools build new DOMNode
// objects and orphans the ones its panels hold, so known levels are only descended, never re-sent.

type Tuple = [number, number, ...unknown[]];
export type Op = ['k', number, (number | Tuple)[]] | ['n', number, number] | ['a', number, string, string | null] | ['c', number, string];

interface MNode {
  id: number;
  type: number;
  name: string;
  value: string;
  attrs: string[];
  parent: MNode | null;
  /** Null while the page hasn't sent this node's children; `count` says how many it has. */
  kids: MNode[] | null;
  count: number;
  /** Document URL and compat mode, or doctype public and system ids. */
  extra: [string, string];
}

export interface Event {
  method: string;
  params: Record<string, unknown>;
}

const INLINE_TEXT_MAX = 500;
const NAMES: Record<number, string> = { 3: '#text', 8: '#comment', 9: '#document' };

/** Children as a node carries them: a list of nodes, or how many the page kept. */
const kidsOk = (v: unknown) => Array.isArray(v) || (Number.isInteger(v) && (v as number) >= 0);

/**
 * `t` as a node, if it is one as dom.js writes them (`shallow`); throws otherwise. The copy is what
 * DevTools is answered from, so it takes nothing it would have to guess at: a node that isn't one
 * makes the batch it came in one the copy can't follow, like an id it doesn't know.
 */
function nodeOf(t: unknown): Tuple {
  const a = Array.isArray(t) ? (t as unknown[]) : [];
  const text = (i: number) => typeof a[i] === 'string';
  const type = a[1];
  const ok =
    Number.isInteger(a[0]) &&
    (type === 1
      ? text(2) && Array.isArray(a[3]) && a[3].every((x) => typeof x === 'string') && kidsOk(a[4])
      : type === 3 || type === 8
        ? text(2)
        : type === 9
          ? text(2) && text(3) && kidsOk(a[4])
          : type === 10 && text(2) && text(3) && text(4));
  if (!ok) throw new Error('not a node');
  return t as Tuple;
}

export class DomMirror {
  private nodes = new Map<number, MNode>();
  private root: MNode | null = null;
  private shown = new Set<number>();
  private opened = new Set<number>();
  /** Nodes unlinked during the batch being applied. Those not relinked by its end are dropped. */
  private detached = new Set<MNode>();
  /** Set when a batch doesn't fit the copy. The next getDocument takes a fresh snapshot. */
  stale = false;

  get ready() {
    return this.root !== null && !this.stale;
  }

  reset() {
    this.nodes.clear();
    this.root = null;
    this.shown.clear();
    this.opened.clear();
    this.stale = false;
  }

  /** Starts the copy from the page's snapshot. False, with no copy, when it isn't a tree of nodes. */
  load(t: unknown): boolean {
    this.reset();
    try {
      this.root = this.build(nodeOf(t), null);
    } catch {
      this.reset();
    }
    return this.root !== null;
  }

  has(id: number) {
    return this.nodes.has(id);
  }

  /** Builds a node from a tuple. A tuple may carry a node the copy already has elsewhere (moved
   * into a new subtree), so an existing node with that id is unlinked first. */
  private build(t: Tuple, parent: MNode | null, out?: Event[]): MNode {
    const [id, type] = t;
    const old = this.nodes.get(id);
    if (old && out) this.unlink(old, out);
    const n: MNode = { id, type, name: '', value: '', attrs: [], parent, kids: [], count: 0, extra: ['', ''] };
    if (type === 1) {
      n.name = t[2] as string;
      n.attrs = t[3] as string[];
      this.setChildren(n, t[4], out);
    } else if (type === 3 || type === 8) {
      n.name = NAMES[type]!;
      n.value = t[2] as string;
    } else if (type === 9) {
      n.name = NAMES[9]!;
      n.extra = [t[2] as string, t[3] as string];
      this.setChildren(n, t[4], out);
    } else {
      n.name = t[2] as string;
      n.extra = [t[3] as string, t[4] as string];
    }
    this.nodes.set(id, n);
    return n;
  }

  /** A tuple's children: a list of tuples, or how many there are when the page kept them. */
  private setChildren(n: MNode, kids: unknown, out?: Event[]) {
    if (typeof kids === 'number') {
      n.kids = null;
      n.count = kids;
    } else {
      n.kids = (kids as unknown[]).map((k) => this.build(nodeOf(k), n, out));
      n.count = n.kids.length;
    }
  }

  private countOf(n: MNode) {
    return n.kids ? n.kids.length : n.count;
  }

  /** Deletes a detached subtree. Ids a newer node has taken over are left alone. */
  private drop(n: MNode) {
    if (this.nodes.get(n.id) === n) {
      this.nodes.delete(n.id);
      this.shown.delete(n.id);
      this.opened.delete(n.id);
    }
    for (const k of n.kids ?? []) if (k.parent === n) this.drop(k);
  }

  private forget(n: MNode) {
    this.shown.delete(n.id);
    if (!this.opened.delete(n.id)) return;
    for (const k of n.kids ?? []) if (this.shown.has(k.id)) this.forget(k);
  }

  private base(n: MNode) {
    const o: Record<string, unknown> = {
      nodeId: n.id,
      backendNodeId: n.id,
      nodeType: n.type,
      nodeName: n.name,
      localName: n.type === 1 ? (n.name === n.name.toUpperCase() ? n.name.toLowerCase() : n.name) : '',
      nodeValue: n.value,
    };
    if (n.type === 1) o.attributes = n.attrs;
    else if (n.type === 9) {
      o.documentURL = o.baseURL = n.extra[0];
      o.xmlVersion = '';
      o.compatibilityMode = n.extra[1] === 'BackCompat' ? 'QuirksMode' : 'NoQuirksMode';
    } else if (n.type === 10) {
      o.publicId = n.extra[0];
      o.systemId = n.extra[1];
    }
    return o;
  }

  private inlineText(n: MNode) {
    return n.kids !== null && n.kids.length === 1 && n.kids[0]!.type === 3 && n.kids[0]!.value.length <= INLINE_TEXT_MAX;
  }

  private ser(n: MNode, depth: number): Record<string, unknown> {
    this.shown.add(n.id);
    const o = this.base(n);
    if (n.parent && this.shown.has(n.parent.id)) o.parentId = n.parent.id;
    o.childNodeCount = this.countOf(n);
    if (n.kids && n.kids.length > 0 && (depth !== 0 || this.inlineText(n))) o.children = this.kidsOf(n, depth > 0 ? depth - 1 : depth);
    return o;
  }

  private kidsOf(n: MNode, depth: number) {
    this.opened.add(n.id);
    return (n.kids ?? []).map((k) => this.ser(k, depth));
  }

  /**
   * Nodes within `depth` levels under `id` whose children the page hasn't sent, so the bridge can
   * ask for them before serving. Null when `id` is unknown. -1 is every level.
   */
  missing(id: number, depth: number): number[] | null {
    const n = this.nodes.get(id);
    if (!n) return null;
    const out: number[] = [];
    const walk = (x: MNode, d: number) => {
      if (d === 0) return;
      if (x.kids === null) {
        if (x.count > 0) out.push(x.id);
        return;
      }
      for (const k of x.kids) if (k.type === 1 || k.type === 9) walk(k, d > 0 ? d - 1 : d);
    };
    walk(n, depth);
    return out;
  }

  get rootId() {
    return this.root?.id ?? 0;
  }

  getDocument(depth: number) {
    this.shown.clear();
    this.opened.clear();
    return { root: this.ser(this.root!, depth) };
  }

  /** Sends the levels under `id` DevTools doesn't have yet. */
  requestChildNodes(id: number, depth: number, out: Event[]) {
    const n = this.nodes.get(id);
    if (!n) return false;
    this.expand(n, depth, out);
    return true;
  }

  private expand(n: MNode, depth: number, out: Event[]) {
    if (!this.opened.has(n.id)) {
      out.push({ method: 'DOM.setChildNodes', params: { parentId: n.id, nodes: this.kidsOf(n, depth > 0 ? depth - 1 : depth) } });
      return;
    }
    if (depth === 1) return;
    for (const k of n.kids ?? []) if (k.type === 1 && this.shown.has(k.id)) this.expand(k, depth > 0 ? depth - 1 : depth, out);
  }

  /** Tells DevTools about every ancestor of `id` it hasn't seen and returns the id, or 0. */
  pushPath(id: number, out: Event[]) {
    const n = this.nodes.get(id);
    if (!n || !this.root || !this.shown.has(this.root.id)) return 0;
    const chain: MNode[] = [];
    let a: MNode | null = n;
    while (a && !this.shown.has(a.id)) {
      chain.push(a);
      a = a.parent;
    }
    if (!a) return 0;
    for (let i = chain.length - 1; i >= 0; i--) {
      const parent = chain[i]!.parent!;
      if (!this.opened.has(parent.id)) out.push({ method: 'DOM.setChildNodes', params: { parentId: parent.id, nodes: this.kidsOf(parent, 0) } });
    }
    return this.shown.has(id) ? id : 0;
  }

  describe(id: number) {
    const n = this.nodes.get(id);
    if (!n) return null;
    const o = this.base(n);
    if (!this.shown.has(id)) o.nodeId = 0;
    o.childNodeCount = this.countOf(n);
    return o;
  }

  attributes(id: number) {
    return this.nodes.get(id)?.attrs ?? null;
  }

  /** Takes `n` out of its parent's children, telling DevTools if it had the node. */
  private unlink(n: MNode, out: Event[]) {
    const p = n.parent;
    if (!p) return;
    if (p.kids) p.kids.splice(p.kids.indexOf(n), 1);
    n.parent = null;
    this.detached.add(n);
    if (this.shown.has(n.id)) out.push({ method: 'DOM.childNodeRemoved', params: { parentNodeId: p.id, nodeId: n.id } });
    else if (this.shown.has(p.id) && !this.opened.has(p.id)) out.push({ method: 'DOM.childNodeCountUpdated', params: { nodeId: p.id, childNodeCount: this.countOf(p) } });
    this.forget(n);
  }

  /** Applies one batch from the page and returns the events DevTools needs. */
  apply(ops: Op[]): Event[] {
    const out: Event[] = [];
    this.detached.clear();
    for (const op of ops) {
      if (!this.follows(op, out)) {
        this.stale = true;
        return [{ method: 'DOM.documentUpdated', params: {} }];
      }
    }
    for (const n of this.detached) if (!n.parent) this.drop(n);
    this.detached.clear();
    return out;
  }

  private setKids(parent: MNode, list: (number | Tuple)[], out: Event[]): boolean {
    const before = this.countOf(parent);
    const next: MNode[] = [];
    for (const x of list) {
      if (typeof x !== 'number') {
        next.push(this.build(nodeOf(x), null, out));
        continue;
      }
      const n = this.nodes.get(x);
      if (!n) return false;
      next.push(n);
    }
    const keep = new Set(next);
    const kids = parent.kids ?? [];
    for (const n of [...kids]) {
      if (!keep.has(n)) this.unlink(n, out);
    }
    // Children that stay but changed order are moved: remove, then insert at the new place.
    let lastOld = -1;
    for (const n of next) {
      if (n.parent !== parent) continue;
      const i = kids.indexOf(n);
      if (i < lastOld) this.unlink(n, out);
      else lastOld = i;
    }
    for (const n of next) if (n.parent && n.parent !== parent) this.unlink(n, out);
    const tell = this.shown.has(parent.id) && this.opened.has(parent.id);
    const had = new Set(kids);
    parent.kids = next;
    parent.count = next.length;
    next.forEach((n, i) => {
      n.parent = parent;
      if (had.has(n) || !tell) return;
      out.push({ method: 'DOM.childNodeInserted', params: { parentNodeId: parent.id, previousNodeId: i ? next[i - 1]!.id : 0, node: this.ser(n, 0) } });
    });
    if (this.shown.has(parent.id) && !this.opened.has(parent.id) && before !== next.length) {
      out.push({ method: 'DOM.childNodeCountUpdated', params: { nodeId: parent.id, childNodeCount: next.length } });
    }
    return true;
  }

  /** Applies one op. False when the copy can't follow it: a node it doesn't have, or an op or a node
   *  in it that isn't one. */
  private follows(op: Op, out: Event[]): boolean {
    try {
      return Array.isArray(op) && this.applyOne(op, out);
    } catch {
      return false;
    }
  }

  private applyOne(op: Op, out: Event[]): boolean {
    switch (op[0]) {
      case 'k': {
        const parent = this.nodes.get(op[1]);
        return !!parent && Array.isArray(op[2]) && this.setKids(parent, op[2], out);
      }
      case 'n': {
        // The page changed children the copy hasn't got; only their number is known.
        const parent = this.nodes.get(op[1]);
        if (!parent || !kidsOk(op[2]) || Array.isArray(op[2])) return false;
        if (parent.kids !== null) return this.setKids(parent, [], out) && ((parent.kids = null), (parent.count = op[2]), true);
        if (parent.count === op[2]) return true;
        parent.count = op[2];
        if (this.shown.has(parent.id)) out.push({ method: 'DOM.childNodeCountUpdated', params: { nodeId: parent.id, childNodeCount: op[2] } });
        return true;
      }
      case 'a': {
        const [, id, name, value] = op;
        const n = this.nodes.get(id);
        if (!n || typeof name !== 'string' || (value !== null && typeof value !== 'string')) return false;
        const i = n.attrs.findIndex((x, j) => j % 2 === 0 && x === name);
        if (value === null) {
          if (i >= 0) n.attrs.splice(i, 2);
        } else if (i >= 0) n.attrs[i + 1] = value;
        else n.attrs.push(name, value);
        if (this.shown.has(id)) out.push(value === null ? { method: 'DOM.attributeRemoved', params: { nodeId: id, name } } : { method: 'DOM.attributeModified', params: { nodeId: id, name, value } });
        return true;
      }
      case 'c': {
        const [, id, text] = op;
        const n = this.nodes.get(id);
        if (!n || typeof text !== 'string') return false;
        n.value = text;
        if (this.shown.has(id)) out.push({ method: 'DOM.characterDataModified', params: { nodeId: id, characterData: text } });
        return true;
      }
    }
    return false;
  }
}
