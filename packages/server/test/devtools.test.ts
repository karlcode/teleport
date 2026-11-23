import { describe, expect, it } from 'vitest';
import { DevtoolsBridge } from '../src/devtools.js';
import type { Peer } from '../src/ws.js';

// The whole tree, as a page small enough to fit one snapshot sends it.
const SNAPSHOT = [1, 9, 'http://device/', 'CSS1Compat', [
  [2, 1, 'HTML', [], [
    [3, 1, 'BODY', ['class', 'home'], [
      [4, 1, 'DIV', ['id', 'grid'], [[5, 1, 'DIV', ['class', 'tile'], [[6, 3, 'One']]], [7, 1, 'DIV', ['class', 'tile'], [[8, 3, 'Two']]]]],
    ]],
  ]],
]];

// The same page as a bigger one sends it: the grid's children stayed on the device, as a count.
const LAZY = [1, 9, 'http://device/', 'CSS1Compat', [
  [2, 1, 'HTML', [], [
    [3, 1, 'BODY', ['class', 'home'], [
      [4, 1, 'DIV', ['id', 'grid'], 2],
    ]],
  ]],
]];
const GRID_KIDS = [[5, 1, 'DIV', ['class', 'tile'], 1], [7, 1, 'DIV', ['class', 'tile'], 1]];

function setup() {
  const toDevice: any[] = [];
  const toClients: any[] = [];
  const replies: any[] = [];
  const bridge = new DevtoolsBridge((m) => toDevice.push(JSON.parse(m)), (m) => toClients.push(JSON.parse(m)));
  const ws = { send: (m: string) => replies.push(JSON.parse(m)) } as unknown as Peer;
  const client = (id: number, method: string, params: Record<string, unknown> = {}) => bridge.fromClient(ws, { id, method, params });
  const device = (m: unknown) => bridge.fromDevice(JSON.stringify(m), m as never);
  /** The last request the bridge sent the page, removed from the outbox. */
  const asked = () => toDevice.shift();
  return { bridge, toDevice, toClients, replies, client, device, asked };
}

function ready(snapshot: unknown = SNAPSHOT) {
  const s = setup();
  s.client(1, 'DOM.getDocument', { depth: 1 });
  s.device({ id: s.asked().id, result: { root: snapshot } });
  s.replies.length = 0;
  s.toClients.length = 0;
  return s;
}

describe('DevTools bridge', () => {
  it('answers getDocument from one snapshot and never forwards it', () => {
    const s = setup();
    expect(s.client(1, 'DOM.getDocument', { depth: 2 })).toBe(true);
    expect(s.toDevice).toEqual([{ id: -1, method: 'teleport.snapshot', params: {} }]);
    expect(s.device({ id: -1, result: { root: SNAPSHOT } })).toBeNull();
    const root = s.replies[0].result.root;
    expect(root).toMatchObject({ nodeId: 1, nodeName: '#document', documentURL: 'http://device/', childNodeCount: 1 });
    expect(root.children[0]).toMatchObject({ nodeName: 'HTML', localName: 'html', parentId: 1 });
    expect(root.children[0].children[0]).toMatchObject({ nodeName: 'BODY', childNodeCount: 1, attributes: ['class', 'home'] });
    expect(root.children[0].children[0].children).toBeUndefined();
  });

  it('expands, describes and reads attributes without the device', () => {
    const s = ready();
    s.client(2, 'DOM.requestChildNodes', { nodeId: 3, depth: -1 });
    s.client(3, 'DOM.describeNode', { nodeId: 5 });
    s.client(4, 'DOM.getAttributes', { nodeId: 4 });
    s.client(5, 'DOM.requestChildNodes', { nodeId: 3, depth: -1 });
    expect(s.toDevice).toEqual([]);
    const set = s.toClients.filter((e) => e.method === 'DOM.setChildNodes');
    expect(set).toHaveLength(1);
    expect(set[0].params.nodes[0].children.map((c: any) => c.nodeId)).toEqual([5, 7]);
    expect(s.replies.find((r) => r.id === 3).result.node).toMatchObject({ nodeId: 5, childNodeCount: 1 });
    expect(s.replies.find((r) => r.id === 4).result.attributes).toEqual(['id', 'grid']);
  });

  it('pushes the path to nodes the page returns, before the reply', () => {
    const s = ready();
    expect(s.client(6, 'DOM.querySelector', { nodeId: 1, selector: '.tile' })).toBe(false);
    const reply = JSON.parse(s.device({ id: 6, result: { nodeId: 7 } })!);
    expect(reply.result.nodeId).toBe(7);
    expect(s.toClients.map((e) => [e.method, e.params.parentId])).toEqual([['DOM.setChildNodes', 2], ['DOM.setChildNodes', 3], ['DOM.setChildNodes', 4]]);
  });

  it('turns child-list batches into the events DevTools expects', () => {
    const s = ready();
    s.client(2, 'DOM.requestChildNodes', { nodeId: 3, depth: -1 });
    s.toClients.length = 0;
    s.device({ method: 'teleport.mutations', params: [['k', 4, [7, [9, 1, 'DIV', ['class', 'tile new'], []], 5]], ['a', 5, 'class', 'tile focus'], ['c', 8, 'Deux']] });
    expect(s.toClients.map((e) => e.method)).toEqual(['DOM.childNodeRemoved', 'DOM.childNodeInserted', 'DOM.childNodeInserted', 'DOM.attributeModified', 'DOM.characterDataModified']);
    expect(s.toClients[0].params).toEqual({ parentNodeId: 4, nodeId: 5 });
    expect(s.toClients[1].params).toMatchObject({ parentNodeId: 4, previousNodeId: 7, node: { nodeId: 9 } });
    expect(s.toClients[2].params).toMatchObject({ parentNodeId: 4, previousNodeId: 9, node: { nodeId: 5 } });
    s.toClients.length = 0;
    s.device({ method: 'teleport.mutations', params: [['k', 4, [5]]] });
    expect(s.toClients.map((e) => [e.method, e.params.nodeId])).toEqual([['DOM.childNodeRemoved', 7], ['DOM.childNodeRemoved', 9]]);
  });

  it('asks DevTools to reload the tree when a batch does not fit the copy', () => {
    const s = ready();
    s.device({ method: 'teleport.mutations', params: [['k', 99, []]] });
    expect(s.toClients).toEqual([{ method: 'DOM.documentUpdated', params: {} }]);
    s.client(9, 'DOM.getDocument', {});
    expect(s.toDevice).toEqual([{ id: -2, method: 'teleport.snapshot', params: {} }]);
  });
});

describe('DevTools bridge on a tree the page sends a piece at a time', () => {
  it('serves what the snapshot has and reports counts for what it kept', () => {
    const s = ready(LAZY);
    s.client(2, 'DOM.describeNode', { nodeId: 4 });
    expect(s.toDevice).toEqual([]);
    expect(s.replies[0].result.node).toMatchObject({ backendNodeId: 4, childNodeCount: 2 });
  });

  it("fetches a node's children from the page the first time DevTools expands it, then never again", () => {
    const s = ready(LAZY);
    s.client(2, 'DOM.requestChildNodes', { nodeId: 4, depth: 1 });
    expect(s.replies).toEqual([]);
    expect(s.asked()).toEqual({ id: -2, method: 'teleport.expand', params: { ids: [4] } });
    s.device({ id: -2, result: { ops: [['k', 4, GRID_KIDS]] } });
    expect(s.replies).toEqual([{ id: 2, result: {} }]);
    const set = s.toClients.find((e) => e.method === 'DOM.setChildNodes');
    expect(set.params.parentId).toBe(4);
    expect(set.params.nodes.map((n: any) => [n.nodeId, n.childNodeCount, n.children])).toEqual([[5, 1, undefined], [7, 1, undefined]]);
    s.client(3, 'DOM.requestChildNodes', { nodeId: 4, depth: 1 });
    expect(s.toDevice).toEqual([]);
  });

  it('descends a level a round for a deep request, and stops asking when the page has nothing more', () => {
    const s = ready(LAZY);
    s.client(2, 'DOM.requestChildNodes', { nodeId: 3, depth: -1 });
    expect(s.asked()).toMatchObject({ method: 'teleport.expand', params: { ids: [4] } });
    s.device({ id: -2, result: { ops: [['k', 4, GRID_KIDS]] } });
    expect(s.asked()).toMatchObject({ method: 'teleport.expand', params: { ids: [5, 7] } });
    // The tiles went away on the device in the meantime: nothing comes back, and the request is served as is.
    s.device({ id: -3, result: { ops: [] } });
    expect(s.toDevice).toEqual([]);
    expect(s.replies).toEqual([{ id: 2, result: {} }]);
  });

  it('asks the page for the path to a node it names that the copy has not got, then pushes it', () => {
    const s = ready(LAZY);
    expect(s.client(6, 'DOM.querySelector', { nodeId: 1, selector: '.tile' })).toBe(false);
    expect(s.device({ id: 6, result: { nodeId: 7 } })).toBeNull();
    expect(s.asked()).toEqual({ id: -2, method: 'teleport.reveal', params: { ids: [7] } });
    s.device({ id: -2, result: { ops: [['k', 4, GRID_KIDS]] } });
    const reply = s.toClients.pop();
    expect(reply).toMatchObject({ id: 6, result: { nodeId: 7 } });
    expect(s.toClients.map((e) => [e.method, e.params.parentId])).toEqual([['DOM.setChildNodes', 2], ['DOM.setChildNodes', 3], ['DOM.setChildNodes', 4]]);
  });

  it('takes the paths the page sends with a page of search results', () => {
    const s = ready(LAZY);
    s.client(7, 'DOM.getSearchResults', { searchId: '1', fromIndex: 0, toIndex: 2 });
    const reply = JSON.parse(s.device({ id: 7, result: { nodeIds: [5, 7], teleportOps: [['k', 4, GRID_KIDS]] } })!);
    expect(reply.result).toEqual({ nodeIds: [5, 7] });
    expect(s.toClients.filter((e) => e.method === 'DOM.setChildNodes').map((e) => e.params.parentId)).toEqual([2, 3, 4]);
  });

  it('updates a count DevTools shows when children it has not got change on the device', () => {
    const s = ready(LAZY);
    s.client(2, 'DOM.requestChildNodes', { nodeId: 3, depth: 1 });
    s.toClients.length = 0;
    s.device({ method: 'teleport.mutations', params: [['n', 4, 3]] });
    expect(s.toClients).toEqual([{ method: 'DOM.childNodeCountUpdated', params: { nodeId: 4, childNodeCount: 3 } }]);
    s.device({ method: 'teleport.mutations', params: [['n', 4, 3]] });
    expect(s.toClients).toHaveLength(1);
  });

  it('reveals before describing a node DevTools learned of from an event', () => {
    const s = ready(LAZY);
    s.client(2, 'DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: [7] });
    expect(s.asked()).toEqual({ id: -2, method: 'teleport.reveal', params: { ids: [7] } });
    s.device({ id: -2, result: { ops: [['k', 4, GRID_KIDS]] } });
    expect(s.replies).toEqual([{ id: 2, result: { nodeIds: [7] } }]);
  });
});

// The copy is what DevTools is answered from, so it holds nothing it would have to guess at. Each of
// these once ended the whole process: the page's side is whatever an old engine, a cut link or
// another machine on the network sends.
describe('what the page sends that is not a tree', () => {
  const NOT_TREES = [undefined, null, 5, 'x', [], {}, [1], [1, 9], ['1', 9, '', '', []], [1, 9, 'http://device/', 'CSS1Compat', [null]], [1, 9, 'u', 'c', [[2, 1, 'HTML', 'not attributes', []]]], [1, 9, 'u', 'c', [[2, 1, 'HTML', [], [[3, 3]]]]], [1, 9, 'u', 'c', -1], [1, 2, 'x', 'y', 'z']];

  it.each(NOT_TREES.map((root) => [JSON.stringify(root) ?? 'undefined', root]))('answers DevTools with an error for a snapshot of %s', (_, root) => {
    const s = setup();
    s.client(1, 'DOM.getDocument', { depth: 1 });
    expect(() => s.device({ id: s.asked().id, result: { root } })).not.toThrow();
    expect(s.replies).toEqual([{ id: 1, error: { code: -32000, message: "teleport has no copy of the page's document" } }]);
    // The next request asks the page for its document again, and a good one is taken.
    s.client(2, 'DOM.getDocument', { depth: 1 });
    s.device({ id: s.asked().id, result: { root: SNAPSHOT } });
    expect(s.replies[1]).toMatchObject({ id: 2, result: { root: { nodeId: 1, nodeName: '#document' } } });
  });

  const NOT_OPS = [[5], [null], [['k']], [['k', 4, 5]], [['k', 4, [[9, 1, 'DIV']]]], [['k', 4, [null]]], [['a', 4, 5, 'v']], [['a', 4, 'id', 7]], [['c', 6, 9]], [['n', 4, 'many']], [['n', 4, -1]], [['x', 4]]];

  it.each(NOT_OPS.map((ops) => [JSON.stringify(ops), ops]))('takes a fresh document after the batch %s, and keeps none of it', (_, ops) => {
    const s = ready();
    s.toClients.length = 0;
    expect(() => s.device({ method: 'teleport.mutations', params: ops })).not.toThrow();
    expect(s.toClients).toEqual([{ method: 'DOM.documentUpdated', params: {} }]);
    expect(s.bridge.mirror.ready).toBe(false);
  });

  it('reads requests whose arguments are not what the protocol says', () => {
    const s = ready();
    expect(() => s.client(2, 'DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: 5 })).not.toThrow();
    expect(() => s.client(3, 'DOM.requestChildNodes', { nodeId: {}, depth: 'x' })).not.toThrow();
    expect(() => s.client(4, 'DOM.getDocument', 5 as never)).not.toThrow();
    expect(s.replies.map((r) => r.id)).toEqual([2, 3, 4]);
  });
});
