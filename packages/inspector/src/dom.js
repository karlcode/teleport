'use strict';
var cx = require('./cx.js');
var R = require('./remote.js');
var gov = require('./governor.js');

// The teleport server keeps a copy of the element tree and answers DevTools' tree requests from it
// (expanding, describing, attributes). The page sends it only what DevTools can see: a snapshot of
// the top of the tree, about SNAPSHOT_BUDGET nodes breadth first, and then each subtree as DevTools
// expands it (`teleport.expand`) or needs the path to a node (`teleport.reveal`). Only nodes the
// laptop has are watched for changes, each on its own, never a whole subtree: a device app re-rendering
// a rail of a thousand tiles under a collapsed node costs the inspector nothing.
//
// Node tuples: [id, 1, nodeName, attrs, kids] element with its children, [id, 1, nodeName, attrs, n]
// element with n children the laptop hasn't got, [id, 3|8, value] text or comment,
// [id, 9, URL, compatMode, kids | n] document, [id, 10, name, publicId, systemId] doctype.
// That is the snapshot's form. Changes after it go as one flat batch per MutationObserver callback
// (see `flat` below): a parent's current children, a count, an attribute, a text.
// Records are read after the fact, so a node's previous sibling may itself have moved later in the
// same batch. Sending whole child lists of the parents that changed sidesteps record ordering.
// Ids live in expando properties and only ever increase, like Chrome's.
var ID = '__teleportId';
// The laptop has this node; the laptop has this node's child list.
var SENT = '__teleportSent';
var KIDS = '__teleportKids';
var BATCH = '__teleportBatch';
var WS = /^\s*$/;
var SEARCH_MAX = 1000;
var SNAPSHOT_BUDGET = 1000;
var EL_OPTS = { childList: true, attributes: true };
var DOC_OPTS = { childList: true };
var TEXT_OPTS = { characterData: true };

var nodes = {};
var nextId = 1;
var hidden = null;
var inspected = null;
var observer = null;
// The observer was stopped under pressure (governor level 2); the laptop's copy is stale from then on.
var paused = false;
var parser = null;
var batch = 0;
// The last search's nodes, revealed to the laptop as DevTools pages through them.
var hits = [];

function idOf(n) {
  var id = n[ID];
  if (id && nodes[id] === n) return id;
  id = nextId++;
  nodes[id] = n;
  n[ID] = id;
  return id;
}

function byId(id) {
  return id > 0 ? nodes[id] || null : null;
}

/** The laptop has this node. */
function mirrored(n) {
  return n[SENT] === true && nodes[n[ID]] === n;
}

// teleport's own nodes: the highlight overlay, and the agent's mark on the device's screen.
function own(n) {
  return n === hidden || (n.nodeType === 1 && n.hasAttribute('data-teleport'));
}

function visible(n) {
  var t = n.nodeType;
  if (t === 3) return !WS.test(n.nodeValue);
  if (own(n)) return false;
  return t === 1 || t === 8 || t === 9 || t === 10;
}

function attrs(n) {
  var a = n.attributes;
  var out = [];
  for (var i = 0; i < a.length; i++) out.push(a[i].name, a[i].value);
  return out;
}

function count(n) {
  var c = 0;
  for (var k = n.firstChild; k; k = k.nextSibling) if (visible(k)) c++;
  return c;
}

// Watched one node at a time, not by subtree: an observer's targets are weak references, and only
// what the laptop has can change what the laptop shows.
function watch(n) {
  if (!observer) return;
  var t = n.nodeType;
  if (t === 1) observer.observe(n, EL_OPTS);
  else if (t === 9) observer.observe(n, DOC_OPTS);
  else if (t === 3 || t === 8) observer.observe(n, TEXT_OPTS);
}

/** The node goes to the laptop: it is mirrored and watched from now on. */
function send(n) {
  var id = idOf(n);
  n[SENT] = true;
  watch(n);
  return id;
}

// A node on its own, children as a count: the laptop asks for them when DevTools expands it.
// No children is the whole list: the laptop has it, so the first child comes as a list it can
// insert, not as a count DevTools would have to ask about on a node it thinks it has opened.
function shallow(n) {
  var id = send(n);
  var t = n.nodeType;
  var c;
  if (t === 1) {
    c = count(n);
    n[KIDS] = c === 0;
    return [id, 1, n.nodeName, attrs(n), c];
  }
  if (t === 3 || t === 8) return [id, t, n.nodeValue];
  if (t === 9) {
    c = count(n);
    n[KIDS] = c === 0;
    return [id, 9, n.URL, n.compatMode, c];
  }
  return [id, 10, n.name, n.publicId, n.systemId];
}

// Everything after the snapshot goes as one flat array of numbers and strings (and null, for an
// attribute removed): on old engines that is written and sent at half the cost of nested lists or
// less, and it is a quarter smaller (measured on Chromium 38, x64 and ARM). A tag or attribute
// name goes as text the first time and as its number after; the laptop keeps the same list, and
// both start it again with each epoch (cx.js), which every array names.
//   [10, epoch, op, ...]
//   1, parent, n, child x n     the parent's children now: -id for a node the laptop has, or a node
//   2, id, name, value | null   attribute set or removed
//   3, id, text                 text or comment changed
//   4, parent, count            a parent whose children the laptop hasn't got changed them
// A node: id, 1, name, attributes (their number, then name and value each), -1 - its child count;
// id, 3 | 8, text; id, 10, name, publicId, systemId. Its children are never in line: they are
// asked for when DevTools opens it.
var known = {};
var nameCount = 0;

function forgetNames() {
  known = {};
  nameCount = 0;
}
cx.onEpoch(forgetNames);

function ref(out, s) {
  var id = known[s];
  if (id === undefined) {
    known[s] = nameCount++;
    out.push(s);
  } else out.push(id);
}

function flat() {
  return [10, cx.epoch()];
}

function putNode(out, n) {
  var id = send(n);
  var t = n.nodeType;
  if (t === 1) {
    var c = count(n);
    n[KIDS] = c === 0;
    out.push(id, 1);
    ref(out, n.nodeName);
    var a = n.attributes;
    out.push(a.length);
    for (var i = 0; i < a.length; i++) {
      ref(out, a[i].name);
      out.push(a[i].value);
    }
    out.push(-1 - c);
  } else if (t === 3 || t === 8) out.push(id, t, n.nodeValue);
  else out.push(id, 10, n.name, n.publicId, n.systemId);
}

/** Op 1: the node's children, in order. */
function putKids(out, n) {
  out.push(1, n[ID], 0);
  var at = out.length - 1;
  var c = 0;
  for (var k = n.firstChild; k; k = k.nextSibling) {
    if (!visible(k)) continue;
    c++;
    if (mirrored(k)) out.push(-k[ID]);
    else putNode(out, k);
  }
  out[at] = c;
  n[KIDS] = true;
}

// The top of the tree, breadth first, until about `budget` nodes have been sent. A parent's children
// go all or none, so DevTools always has a true count. The big subtrees apps for these devices keep a few levels
// down stay as counts until DevTools expands them.
function snapshot(budget) {
  var root = shallow(document);
  var queue = [[document, root]];
  var left = budget - 1;
  for (var q = 0; q < queue.length; q++) {
    var n = queue[q][0];
    var t = queue[q][1];
    var c = t[4];
    if (c === 0 || c > left) continue;
    left -= c;
    var kids = [];
    for (var k = n.firstChild; k; k = k.nextSibling) {
      if (!visible(k)) continue;
      var kt = shallow(k);
      kids.push(kt);
      if (k.nodeType === 1 && kt[4] > 0) queue.push([k, kt]);
    }
    t[4] = kids;
    n[KIDS] = true;
  }
  return root;
}

/** The child lists from the nearest node the laptop has down to n's parent, so the laptop can show n. */
function revealInto(n, ops) {
  if (!n || own(n)) return;
  var chain = [];
  var a = n;
  while (a && !mirrored(a)) {
    chain.push(a);
    a = a.parentNode;
  }
  if (!a) return;
  var p = a;
  for (var i = chain.length - 1; i >= 0; i--) {
    // A path through a node the laptop can't have (whitespace, teleport's own) can't be shown.
    if (!mirrored(p)) return;
    if (!p[KIDS]) putKids(ops, p);
    p = chain[i];
  }
}

/** Drops a removed subtree from the registry. Nothing the laptop has sits under a node it hasn't. */
function forget(n) {
  if (!mirrored(n)) return;
  delete nodes[n[ID]];
  n[SENT] = false;
  n[KIDS] = false;
  for (var k = n.firstChild; k; k = k.nextSibling) forget(k);
}

function attached(n) {
  return n === document || document.contains(n);
}

// Whether the laptop still has a node that left its parent. It keeps one only under a child list it
// has: a node that left the page, or moved under a parent whose children the laptop hasn't got, is
// dropped there and so forgotten here, and is sent afresh if DevTools opens that parent.
function held(n) {
  var p = n.parentNode;
  return !!p && mirrored(p) && p[KIDS] === true && attached(n);
}

// Changes are collected as dirty nodes and read from the live DOM when sent. Normally that's at
// the end of each MutationObserver callback. While the link is full they stay dirty, so a burst of
// changes costs one entry per changed node, not one batch per callback.
var dirtyKids = [];
var dirtyAttrs = [];
var dirtyText = [];
var ATTRS = '__teleportAttrs';
var TEXT = '__teleportText';

function onMutations(records) {
  var t0 = cx.ms();
  var gone = [];
  var i, j, r, t, names;
  for (i = 0; i < records.length; i++) {
    r = records[i];
    t = r.target;
    if (!mirrored(t)) continue;
    if (r.type === 'childList') {
      for (j = 0; j < r.removedNodes.length; j++) if (mirrored(r.removedNodes[j])) gone.push(r.removedNodes[j]);
      if (t[BATCH] !== batch) {
        t[BATCH] = batch;
        dirtyKids.push(t);
      }
    } else if (r.type === 'attributes') {
      names = t[ATTRS];
      if (!names || names.batch !== batch) {
        names = t[ATTRS] = { batch: batch, list: [] };
        dirtyAttrs.push(t);
      }
      if (names.list.indexOf(r.attributeName) < 0) names.list.push(r.attributeName);
    } else if (r.type === 'characterData' && t[TEXT] !== batch) {
      t[TEXT] = batch;
      dirtyText.push(t);
    }
  }
  for (i = 0; i < gone.length; i++) if (!held(gone[i])) forget(gone[i]);
  if (!cx.congested()) flushChanges();
  else cx.schedule();
  cx.work(t0);
}

function flushChanges() {
  var ops = flat();
  var i, j, n, list;
  for (i = 0; i < dirtyAttrs.length; i++) {
    n = dirtyAttrs[i];
    if (!mirrored(n) || !attached(n)) continue;
    list = n[ATTRS].list;
    for (j = 0; j < list.length; j++) {
      ops.push(2, n[ID]);
      ref(ops, list[j]);
      ops.push(n.getAttribute(list[j]));
    }
  }
  for (i = 0; i < dirtyText.length; i++) {
    n = dirtyText[i];
    if (mirrored(n) && attached(n)) ops.push(3, n[ID], n.nodeValue);
  }
  for (i = 0; i < dirtyKids.length; i++) {
    n = dirtyKids[i];
    if (!mirrored(n) || !attached(n)) continue;
    if (n[KIDS]) putKids(ops, n);
    else ops.push(4, n[ID], count(n));
  }
  dropChanges();
  if (ops.length > 2) cx.send(ops);
}

function dropChanges() {
  dirtyKids = [];
  dirtyAttrs = [];
  dirtyText = [];
  batch++;
}

flushChanges.pending = function () {
  return dirtyKids.length + dirtyAttrs.length + dirtyText.length > 0;
};
cx.onDrain(flushChanges);

var mutated = cx.guard(onMutations);

function observe() {
  if (observer) return;
  var MO = window.MutationObserver || window.WebKitMutationObserver;
  if (MO) observer = new MO(mutated);
}

// Under pressure, watching an app that re-renders heavily is often the inspector's biggest cost, so
// it stops. When the page is calm again the laptop is told its tree is stale; it tells DevTools, which
// asks for the document again, and that snapshot starts watching afresh.
function onLevel(level) {
  if (level >= 2 && observer) {
    observer.disconnect();
    observer = null;
    paused = true;
    dropChanges();
  } else if (level < 2 && paused) {
    paused = false;
    cx.send({ method: 'teleport.stale' });
  }
}
gov.onLevel(onLevel);

function nodeFrom(p) {
  var n = p.nodeId ? byId(p.nodeId) : p.backendNodeId ? byId(p.backendNodeId) : p.objectId ? R.get(p.objectId) : null;
  return n && typeof n.nodeType === 'number' ? n : null;
}

function outerHTML(n) {
  var t = n.nodeType;
  if (t === 1) return n.outerHTML;
  if (t === 3) return n.nodeValue;
  if (t === 8) return '<!--' + n.nodeValue + '-->';
  if (t === 10) return '<!DOCTYPE ' + n.name + '>';
  if (t === 9) return (n.doctype ? outerHTML(n.doctype) + '\n' : '') + n.documentElement.outerHTML;
  return '';
}

function quad(l, t, r, b) {
  return [l, t, r, t, r, b, l, b];
}

function px(cs, prop) {
  return parseFloat(cs.getPropertyValue(prop)) || 0;
}

function boxModel(n) {
  var r = n.getBoundingClientRect();
  var cs = getComputedStyle(n);
  var bl = px(cs, 'border-left-width');
  var bt = px(cs, 'border-top-width');
  var br = px(cs, 'border-right-width');
  var bb = px(cs, 'border-bottom-width');
  var pl = px(cs, 'padding-left');
  var pt = px(cs, 'padding-top');
  var pr = px(cs, 'padding-right');
  var pb = px(cs, 'padding-bottom');
  var ml = px(cs, 'margin-left');
  var mt = px(cs, 'margin-top');
  var mr = px(cs, 'margin-right');
  var mb = px(cs, 'margin-bottom');
  return {
    content: quad(r.left + bl + pl, r.top + bt + pt, r.right - br - pr, r.bottom - bb - pb),
    padding: quad(r.left + bl, r.top + bt, r.right - br, r.bottom - bb),
    border: quad(r.left, r.top, r.right, r.bottom),
    margin: quad(r.left - ml, r.top - mt, r.right + mr, r.bottom + mb),
    width: r.width,
    height: r.height
  };
}

// DOM.getBoxModel's reply, in short: [5, id, the border box's left, top, right, bottom, width and
// height, then border, padding and margin widths, each left, top, right, bottom]. The laptop adds
// them up into the four quads, in the order boxModel() does, so the sums are the same doubles.
function boxNumbers(n, id) {
  var r = n.getBoundingClientRect();
  var cs = getComputedStyle(n);
  return [
    5, id, r.left, r.top, r.right, r.bottom, r.width, r.height,
    px(cs, 'border-left-width'), px(cs, 'border-top-width'), px(cs, 'border-right-width'), px(cs, 'border-bottom-width'),
    px(cs, 'padding-left'), px(cs, 'padding-top'), px(cs, 'padding-right'), px(cs, 'padding-bottom'),
    px(cs, 'margin-left'), px(cs, 'margin-top'), px(cs, 'margin-right'), px(cs, 'margin-bottom')
  ];
}

function matchesText(n, q) {
  if (n.nodeType === 3) return n.nodeValue.toLowerCase().indexOf(q) >= 0;
  if (n.nodeName.toLowerCase().indexOf(q) >= 0) return true;
  var a = n.attributes;
  for (var i = 0; i < a.length; i++) {
    if (a[i].name.toLowerCase().indexOf(q) >= 0 || a[i].value.toLowerCase().indexOf(q) >= 0) return true;
  }
  return false;
}

function selectAll(root, sel) {
  try {
    return root.querySelectorAll(sel);
  } catch (e) {
    return [];
  }
}

function runSearch(query) {
  var out = [];
  var found = selectAll(document, query);
  for (var i = 0; i < found.length && out.length < SEARCH_MAX; i++) if (!own(found[i])) out.push(found[i]);
  if (out.length) return out;
  var q = query.toLowerCase();
  var w = document.createTreeWalker(document.documentElement, 5, null, false);
  for (var n = w.currentNode; n && out.length < SEARCH_MAX; n = w.nextNode()) {
    if (hidden && hidden.contains(n)) continue;
    if (visible(n) && matchesText(n, q)) out.push(n);
  }
  return out;
}

function parseAttributes(text) {
  if (!parser) parser = document.createElement('div');
  parser.innerHTML = '<b ' + text + '></b>';
  return parser.firstChild ? parser.firstChild.attributes : [];
}

function element(p, id) {
  var n = nodeFrom(p);
  if (!n) cx.fail(id, 'Could not find node with given id');
  return n;
}

exports.idOf = idOf;
exports.nodeFrom = nodeFrom;
exports.boxModel = boxModel;
exports.inspected = function () {
  return inspected;
};
// The console's $0: the element DevTools selected.
exports.inspect = function (n) {
  inspected = n;
};
exports.search = runSearch;
exports.setHidden = function (n) {
  hidden = n;
};
exports.detach = function () {
  if (observer) observer.disconnect();
  observer = null;
  paused = false;
  nodes = {};
  hits = [];
  inspected = null;
  dropChanges();
};

cx.on({
  'teleport.snapshot': function (p) {
    nodes = {};
    hits = [];
    // What the old copy watched is watched again as it is sent again, and nothing else.
    if (observer) observer.disconnect();
    observe();
    dropChanges();
    return { root: snapshot(p.budget > 0 ? p.budget : SNAPSHOT_BUDGET) };
  },

  // The child lists of nodes the laptop has, which DevTools is expanding.
  'teleport.expand': function (p) {
    var ops = flat();
    var ids = p.ids || [];
    for (var i = 0; i < ids.length; i++) {
      var n = byId(ids[i]);
      if (n && mirrored(n) && !n[KIDS] && (n.nodeType === 1 || n.nodeType === 9)) putKids(ops, n);
    }
    return { ops: ops };
  },

  // The paths to nodes the laptop hasn't got, which the page named in a reply or an event.
  'teleport.reveal': function (p) {
    var ops = flat();
    var ids = p.ids || [];
    for (var i = 0; i < ids.length; i++) revealInto(byId(ids[i]), ops);
    return { ops: ops };
  },

  'DOM.describeNode': function (p, id) {
    var n = element(p, id);
    if (!n) return cx.ASYNC;
    var o = { nodeId: 0, backendNodeId: idOf(n), nodeType: n.nodeType, nodeName: n.nodeName, localName: n.localName || '', nodeValue: n.nodeValue || '' };
    if (n.nodeType === 1) o.attributes = attrs(n);
    return { node: o };
  },

  'DOM.resolveNode': function (p, id) {
    var n = element(p, id);
    return n ? { object: R.remote(n) } : cx.ASYNC;
  },

  'DOM.requestNode': function (p) {
    var n = nodeFrom(p);
    return { nodeId: n ? idOf(n) : 0 };
  },

  'DOM.getOuterHTML': function (p, id) {
    var n = element(p, id);
    return n ? { outerHTML: outerHTML(n) } : cx.ASYNC;
  },

  'DOM.setOuterHTML': function (p, id) {
    var n = element(p, id);
    if (!n) return cx.ASYNC;
    n.outerHTML = p.outerHTML;
    return { nodeId: 0 };
  },

  'DOM.setAttributesAsText': function (p, id) {
    var n = element(p, id);
    if (!n) return cx.ASYNC;
    var parsed = parseAttributes(p.text || '');
    var keepName = false;
    for (var i = 0; i < parsed.length; i++) {
      n.setAttribute(parsed[i].name, parsed[i].value);
      if (parsed[i].name === p.name) keepName = true;
    }
    if (p.name && !keepName) n.removeAttribute(p.name);
    return {};
  },

  'DOM.setAttributeValue': function (p, id) {
    var n = element(p, id);
    if (!n) return cx.ASYNC;
    n.setAttribute(p.name, p.value);
    return {};
  },

  'DOM.removeAttribute': function (p, id) {
    var n = element(p, id);
    if (!n) return cx.ASYNC;
    n.removeAttribute(p.name);
    return {};
  },

  'DOM.removeNode': function (p, id) {
    var n = element(p, id);
    if (!n) return cx.ASYNC;
    if (n.parentNode) n.parentNode.removeChild(n);
    return {};
  },

  'DOM.setNodeValue': function (p, id) {
    var n = element(p, id);
    if (!n) return cx.ASYNC;
    n.nodeValue = p.value;
    return {};
  },

  'DOM.moveTo': function (p, id) {
    var n = element(p, id);
    var target = byId(p.targetNodeId);
    if (!n || !target) {
      if (n) cx.fail(id, 'Could not find target node');
      return cx.ASYNC;
    }
    target.insertBefore(n, byId(p.insertBeforeNodeId));
    return { nodeId: n[ID] };
  },

  'DOM.getBoxModel': function (p, id) {
    var n = element(p, id);
    if (!n) return cx.ASYNC;
    if (n.nodeType !== 1) {
      cx.fail(id, 'Could not compute box model.');
      return cx.ASYNC;
    }
    return cx.answer(boxNumbers(n, id));
  },

  'DOM.getContentQuads': function (p, id) {
    var n = element(p, id);
    if (!n) return cx.ASYNC;
    return { quads: n.nodeType === 1 ? [boxModel(n).border] : [] };
  },

  'DOM.getNodeForLocation': function (p, id) {
    var n = document.elementFromPoint(p.x, p.y);
    if (!n || n === hidden) {
      cx.fail(id, 'No node found at given location');
      return cx.ASYNC;
    }
    var nid = idOf(n);
    return { backendNodeId: nid, nodeId: nid, frameId: cx.FRAME_ID };
  },

  'DOM.setInspectedNode': function (p) {
    inspected = byId(p.nodeId);
    return {};
  },

  // The hits stay here; the laptop asks for the page of them DevTools shows, and gets their paths.
  'DOM.performSearch': function (p) {
    hits = runSearch(p.query || '');
    return { searchId: '1', resultCount: hits.length };
  },

  'DOM.getSearchResults': function (p) {
    var ops = flat();
    var ids = [];
    var to = Math.min(p.toIndex >>> 0, hits.length);
    for (var i = p.fromIndex >>> 0; i < to; i++) {
      var n = hits[i];
      if (attached(n)) revealInto(n, ops);
      ids.push(mirrored(n) ? n[ID] : 0);
    }
    return { nodeIds: ids, teleportOps: ops };
  },

  'DOM.discardSearchResults': function () {
    hits = [];
    return {};
  },

  'DOM.querySelector': function (p, id) {
    var n = element(p, id);
    if (!n) return cx.ASYNC;
    var hit = selectAll(n, p.selector)[0];
    return { nodeId: hit ? idOf(hit) : 0 };
  },

  'DOM.querySelectorAll': function (p, id) {
    var n = element(p, id);
    if (!n) return cx.ASYNC;
    var found = selectAll(n, p.selector);
    var out = [];
    for (var i = 0; i < found.length; i++) out.push(idOf(found[i]));
    return { nodeIds: out };
  },

  'DOM.collectClassNamesFromSubtree': function (p, id) {
    var n = element(p, id);
    if (!n) return cx.ASYNC;
    var seen = {};
    var out = [];
    var all = n.getElementsByTagName('*');
    for (var i = -1; i < all.length; i++) {
      var el = i < 0 ? n : all[i];
      var list = typeof el.className === 'string' ? el.className.split(/\s+/) : [];
      for (var j = 0; j < list.length; j++) {
        if (list[j] && seen[list[j]] !== 1) {
          seen[list[j]] = 1;
          out.push(list[j]);
        }
      }
    }
    return { classNames: out };
  },

  'DOM.scrollIntoViewIfNeeded': function (p, id) {
    var n = element(p, id);
    if (!n) return cx.ASYNC;
    if (n.scrollIntoViewIfNeeded) n.scrollIntoViewIfNeeded();
    else if (n.scrollIntoView) n.scrollIntoView();
    return {};
  },

  'DOM.focus': function (p, id) {
    var n = element(p, id);
    if (!n) return cx.ASYNC;
    if (n.focus) n.focus();
    return {};
  },

  'DOM.getTopLayerElements': function () {
    return { nodeIds: [] };
  },

  'DOM.markUndoableState': function () {
    return {};
  }
});
