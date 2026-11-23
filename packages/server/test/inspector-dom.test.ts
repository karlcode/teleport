// The inspector's DOM domain runs on the device; here it runs in Node against a fake document, so what
// it sends the laptop, and what it watches, is held to the rule: only what DevTools looks at.
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomWire } from '../src/devtools.js';

const require = createRequire(import.meta.url);

interface Node {
  nodeType: number;
  nodeName: string;
  nodeValue: string | null;
  firstChild: Node | null;
  nextSibling: Node | null;
  parentNode: Node | null;
  attributes: { name: string; value: string }[];
  hasAttribute(name: string): boolean;
  getAttribute(name: string): string | null;
  contains(n: Node): boolean;
  [k: string]: unknown;
}

function node(type: number, name: string, value: string | null, attrs: [string, string][] = []): Node {
  const n: Node = {
    nodeType: type,
    nodeName: name,
    nodeValue: value,
    firstChild: null,
    nextSibling: null,
    parentNode: null,
    attributes: attrs.map(([k, v]) => ({ name: k, value: v })),
    hasAttribute: (k) => n.attributes.some((a) => a.name === k),
    getAttribute: (k) => n.attributes.find((a) => a.name === k)?.value ?? null,
    contains: (x) => {
      for (let p: Node | null = x; p; p = p.parentNode) if (p === n) return true;
      return false;
    },
  };
  return n;
}
const el = (name: string, attrs: [string, string][] = [], kids: Node[] = []) => {
  const n = node(1, name, null, attrs);
  append(n, kids);
  return n;
};
const text = (s: string) => node(3, '#text', s);
function append(parent: Node, kids: Node[]) {
  let last: Node | null = null;
  for (const k of kids) {
    k.parentNode = parent;
    if (last) last.nextSibling = k;
    else parent.firstChild = k;
    last = k;
  }
}
function setKids(parent: Node, kids: Node[]) {
  parent.firstChild = null;
  for (const k of kids) k.nextSibling = null;
  append(parent, kids);
}

describe("the inspector's DOM domain on the device", () => {
  const g = globalThis as Record<string, unknown>;
  const had = { window: g.window, document: g.document };
  const observed: Node[] = [];
  let onMutations: ((records: unknown[]) => void) | null = null;
  const sent: unknown[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cx: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let handlers: Record<string, (p: any, id?: number) => any>;

  // <html><body><div id=rail>40 tiles, each with a text</div><p>hi</p></body></html>
  const tiles = Array.from({ length: 40 }, (_, i) => el('DIV', [['class', 'tile']], [text(`tile ${i}`)]));
  const rail = el('DIV', [['id', 'rail']], tiles);
  const p = el('P', [], [text('hi')]);
  const body = el('BODY', [], [rail, text('  '), p]);
  const html = el('HTML', [], [body]);
  const doc = node(9, '#document', null);
  Object.assign(doc, { URL: 'http://device/', compatMode: 'CSS1Compat' });
  append(doc, [html]);

  beforeAll(() => {
    class MO {
      constructor(cb: (records: unknown[]) => void) {
        onMutations = cb;
      }
      observe(n: Node) {
        observed.push(n);
      }
      disconnect() {
        observed.length = 0;
      }
    }
    g.window = { MutationObserver: MO };
    g.document = doc;
    cx = require('../../inspector/src/cx.js');
    require('../../inspector/src/dom.js');
    // As the laptop reads them: the flat batches are the copy's ops again (DomWire, src/devtools.ts).
    const wire = new DomWire();
    const read = (v: unknown) => (Array.isArray(v) && v[0] === 10 ? wire.read(v) : v);
    const raw = cx.handlers;
    handlers = new Proxy(raw, {
      get: (t, k: string) => (p: object, id?: number) => {
        const r = t[k]!(p, id as never) as Record<string, unknown>;
        if (r && typeof r === 'object' && 'ops' in r) r.ops = read(r.ops);
        if (r && typeof r === 'object' && 'teleportOps' in r) r.teleportOps = read(r.teleportOps);
        return r;
      },
    }) as typeof handlers;
    cx.setSocket({
      readyState: 1,
      bufferedAmount: 0,
      send: (s: string) => void sent.push(...s.split('\n').map((l) => JSON.parse(l)).map((m) => (Array.isArray(m) && m[0] === 10 ? { method: 'teleport.mutations', params: wire.read(m) } : m))),
    });
    cx.linked(0, false);
  });
  afterAll(() => {
    g.window = had.window;
    g.document = had.document;
  });

  const ids = (n: Node) => n.__teleportId as number;

  it('sends the top of the tree breadth first within the budget, the rest as counts, and watches only that', () => {
    const { root } = handlers['teleport.snapshot']!({ budget: 8 });
    // document, html, body, rail, p: 5 nodes; the rail's 40 tiles don't fit, the p's one text does.
    expect(root[1]).toBe(9);
    const htmlT = root[4][0];
    const bodyT = htmlT[4][0];
    expect(bodyT[2]).toBe('BODY');
    const [railT, pT] = bodyT[4];
    expect(railT[2]).toBe('DIV');
    expect(railT[4]).toBe(40);
    expect(pT[4]).toEqual([[ids(p.firstChild!), 3, 'hi']]);
    expect(observed).toHaveLength(6);
    expect(observed).toContain(rail);
    expect(observed).not.toContain(tiles[0]);
  });

  it('serializes children only when the laptop asks, each child shallow, and marks the list as known', () => {
    const { ops } = handlers['teleport.expand']!({ ids: [ids(rail)] });
    expect(ops).toHaveLength(1);
    expect(ops[0][0]).toBe('k');
    expect(ops[0][1]).toBe(ids(rail));
    expect(ops[0][2]).toHaveLength(40);
    expect(ops[0][2][0]).toEqual([ids(tiles[0]!), 1, 'DIV', ['class', 'tile'], 1]);
    expect(observed).toContain(tiles[0]);
    expect(observed).not.toContain(tiles[0]!.firstChild);
    expect(handlers['teleport.expand']!({ ids: [ids(rail)] }).ops).toEqual([]);
  });

  it('reveals a node by sending the child lists on its path that the laptop lacks', () => {
    const t = tiles[7]!.firstChild!;
    // The page named the text node (a console $0, say): it gets an id, and the laptop asks for its path.
    const { ops } = handlers['teleport.reveal']!({ ids: [cxIdOf(t)] });
    expect(ops.map((o: unknown[]) => [o[0], o[1]])).toEqual([['k', ids(tiles[7]!)]]);
    expect(ops[0][2]).toEqual([[ids(t), 3, 'tile 7']]);
    expect(handlers['teleport.reveal']!({ ids: [ids(t)] }).ops).toEqual([]);
  });

  it('reports a changed count for children the laptop has not got, and the list for ones it has', async () => {
    sent.length = 0;
    const tile0 = tiles[0]!;
    setKids(tile0, [text('tile 0'), el('SPAN')]);
    onMutations!([{ type: 'childList', target: tile0, removedNodes: [] }]);
    const extra = el('DIV', [['class', 'tile']]);
    setKids(rail, [...tiles, extra]);
    onMutations!([{ type: 'childList', target: rail, removedNodes: [] }]);
    await new Promise((r) => setTimeout(r, 0));
    const ops = sent.flatMap((m: any) => (m.method === 'teleport.mutations' ? m.params : []));
    expect(ops.map((o: unknown[]) => o[0])).toEqual(['n', 'k']);
    expect(ops[0]).toEqual(['n', ids(tile0), 2]);
    expect(ops[1][2]).toHaveLength(41);
    expect(ops[1][2][40]).toEqual([ids(extra), 1, 'DIV', ['class', 'tile'], 0]);
  });

  it('ignores records for nodes the laptop has not got, and forgets removed subtrees', async () => {
    sent.length = 0;
    // Texts under tiles 8 and 9 were never sent: the laptop can't show a change to them.
    onMutations!([{ type: 'attributes', target: tiles[8]!.firstChild, attributeName: 'x' }, { type: 'childList', target: tiles[9]!.firstChild, removedNodes: [] }]);
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual([]);
    const gone = tiles[3]!;
    setKids(rail, tiles.filter((t) => t !== gone));
    gone.parentNode = null;
    onMutations!([{ type: 'childList', target: rail, removedNodes: [gone] }]);
    expect(handlers['teleport.expand']!({ ids: [ids(gone)] }).ops).toEqual([]);
    expect(handlers['teleport.reveal']!({ ids: [ids(gone)] }).ops).toEqual([]);
  });

  it('keeps search hits on the device and reveals the page of them DevTools shows', () => {
    doc.querySelectorAll = (sel: string) => (sel === '.tile' ? tiles.filter((t) => t.parentNode) : []);
    expect(handlers['DOM.performSearch']!({ query: '.tile' })).toEqual({ searchId: '1', resultCount: 39 });
    const r = handlers['DOM.getSearchResults']!({ searchId: '1', fromIndex: 0, toIndex: 2 });
    expect(r.nodeIds).toEqual([ids(tiles[0]!), ids(tiles[1]!)]);
    expect(r.teleportOps).toEqual([]);
    handlers['DOM.discardSearchResults']!({});
    expect(handlers['DOM.getSearchResults']!({ searchId: '1', fromIndex: 0, toIndex: 2 }).nodeIds).toEqual([]);
  });

  function cxIdOf(n: Node) {
    return require('../../inspector/src/dom.js').idOf(n);
  }
});
