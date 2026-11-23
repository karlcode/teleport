'use strict';
// Remote objects: values DevTools holds by objectId, in fixed rings of slots, so a long session of
// console.log(bigObject) can't grow the heap. When a ring wraps, the oldest ids go stale and
// DevTools gets "object not found" for them, which it already handles. Objects that console
// messages hold get their own smaller ring (ids "c<n>"), which clearing the console empties.

function ring(cap, prefix) {
  return { cap: cap, prefix: prefix, slots: new Array(cap), seqs: new Array(cap), seq: 0 };
}
var general = ring(4096, '');
var consoleRing = ring(512, 'c');
var into = general;
// While false (the governor is shedding), console arguments are previewed but not kept.
var retain = true;

var toStr = Object.prototype.toString;
var fnToStr = Function.prototype.toString;
var PREVIEW_PROPS = 5;
var PREVIEW_ITEMS = 20;
var PREVIEW_STRING = 100;

function keep(v) {
  var r = into;
  if (!retain && r === consoleRing) return undefined;
  r.seq++;
  var i = r.seq % r.cap;
  r.slots[i] = v;
  r.seqs[i] = r.seq;
  return r.prefix + r.seq;
}

function ringFor(id) {
  return String(id).charAt(0) === 'c' ? consoleRing : general;
}

function get(id) {
  var r = ringFor(id);
  var s = +String(id).slice(r.prefix.length);
  var i = s % r.cap;
  return s > 0 && r.seqs[i] === s ? r.slots[i] : undefined;
}

function release(id) {
  var r = ringFor(id);
  var s = +String(id).slice(r.prefix.length);
  var i = s % r.cap;
  if (s > 0 && r.seqs[i] === s) {
    r.slots[i] = undefined;
    r.seqs[i] = 0;
  }
}

function empty(r) {
  for (var i = 0; i < r.cap; i++) {
    r.slots[i] = undefined;
    r.seqs[i] = 0;
  }
}

function clear() {
  empty(general);
  empty(consoleRing);
}

// Property reads on host objects and proxies can throw. Isolated so callers stay try-free.
function read(o, k) {
  try {
    return o[k];
  } catch (e) {
    return undefined;
  }
}

function descriptor(o, k) {
  try {
    return Object.getOwnPropertyDescriptor(o, k);
  } catch (e) {
    return undefined;
  }
}

function ownNames(o) {
  try {
    return Object.getOwnPropertyNames(o);
  } catch (e) {
    return [];
  }
}

function protoOf(o) {
  try {
    return Object.getPrototypeOf(o);
  } catch (e) {
    return null;
  }
}

function isNode(v) {
  return typeof read(v, 'nodeType') === 'number' && typeof read(v, 'nodeName') === 'string';
}

var SUBTYPES = {
  RegExp: 'regexp', Date: 'date', Error: 'error', Map: 'map', Set: 'set', WeakMap: 'weakmap',
  WeakSet: 'weakset', Promise: 'promise', ArrayBuffer: 'arraybuffer', DataView: 'dataview',
  Int8Array: 'typedarray', Uint8Array: 'typedarray', Uint8ClampedArray: 'typedarray',
  Int16Array: 'typedarray', Uint16Array: 'typedarray', Int32Array: 'typedarray',
  Uint32Array: 'typedarray', Float32Array: 'typedarray', Float64Array: 'typedarray',
  NodeList: 'array', HTMLCollection: 'array', Arguments: 'array'
};

function subtypeOf(v, tag) {
  if (Array.isArray(v)) return 'array';
  if (SUBTYPES[tag]) return SUBTYPES[tag];
  if (v instanceof Error) return 'error';
  if (isNode(v)) return 'node';
  return '';
}

function classOf(v, tag) {
  var c = read(v, 'constructor');
  var name = c && read(c, 'name');
  return typeof name === 'string' && name ? name : tag;
}

function nodeDescription(n) {
  if (n.nodeType !== 1) return n.nodeName.toLowerCase();
  var s = n.nodeName.toLowerCase();
  if (n.id) s += '#' + n.id;
  var cls = typeof n.className === 'string' ? n.className.replace(/^\s+|\s+$/g, '') : '';
  if (cls) s += '.' + cls.split(/\s+/).join('.');
  return s;
}

function describe(v, sub, cls) {
  if (sub === 'array' || sub === 'typedarray') return cls + '(' + read(v, 'length') + ')';
  if (sub === 'node') return nodeDescription(v);
  if (sub === 'error') return read(v, 'stack') || read(v, 'name') + ': ' + read(v, 'message');
  if (sub === 'regexp' || sub === 'date') return String(v);
  if (sub === 'map' || sub === 'set') return cls + '(' + read(v, 'size') + ')';
  return cls;
}

function number(v) {
  if (v !== v) return { type: 'number', unserializableValue: 'NaN', description: 'NaN' };
  if (v === Infinity) return { type: 'number', unserializableValue: 'Infinity', description: 'Infinity' };
  if (v === -Infinity) return { type: 'number', unserializableValue: '-Infinity', description: '-Infinity' };
  if (v === 0 && 1 / v < 0) return { type: 'number', unserializableValue: '-0', description: '-0' };
  return { type: 'number', value: v, description: String(v) };
}

function short(v) {
  var t = typeof v;
  if (t === 'string') return v.length > PREVIEW_STRING ? v.slice(0, PREVIEW_STRING) + '…' : v;
  if (t === 'function') return '';
  if (v === null || t !== 'object') return String(v);
  var tag = toStr.call(v).slice(8, -1);
  return describe(v, subtypeOf(v, tag), classOf(v, tag));
}

function previewEntry(name, v) {
  var t = typeof v;
  var e = { name: name, type: t === 'undefined' ? 'undefined' : t, value: short(v) };
  if (v === null) e.subtype = 'null';
  else if (t === 'object') {
    var sub = subtypeOf(v, toStr.call(v).slice(8, -1));
    if (sub) e.subtype = sub;
  }
  return e;
}

function preview(v, sub, o) {
  var props = [];
  var p = { type: 'object', description: o.description, overflow: false, properties: props };
  if (sub) p.subtype = sub;
  var isList = sub === 'array' || sub === 'typedarray';
  var max = isList ? PREVIEW_ITEMS : PREVIEW_PROPS;
  var keys = isList ? null : Object.keys(v);
  var n = isList ? read(v, 'length') >>> 0 : keys.length;
  for (var i = 0; i < n && i < max; i++) {
    var k = isList ? String(i) : keys[i];
    var d = descriptor(v, k);
    props.push(d && !('value' in d) ? { name: k, type: 'accessor' } : previewEntry(k, read(v, k)));
  }
  p.overflow = n > max;
  return p;
}

function remote(v, withPreview) {
  var t = typeof v;
  if (t === 'undefined') return { type: 'undefined' };
  if (t === 'string' || t === 'boolean') return { type: t, value: v };
  if (t === 'number') return number(v);
  if (t === 'bigint') return { type: 'bigint', unserializableValue: String(v) + 'n', description: String(v) + 'n' };
  if (t === 'symbol') return { type: 'symbol', description: String(v), objectId: keep(v) };
  if (v === null) return { type: 'object', subtype: 'null', value: null };
  if (t === 'function') {
    return { type: 'function', className: 'Function', description: fnToStr.call(v), objectId: keep(v) };
  }
  var tag = toStr.call(v).slice(8, -1);
  var sub = subtypeOf(v, tag);
  var cls = classOf(v, tag);
  var o = { type: 'object', className: cls, description: describe(v, sub, cls), objectId: keep(v) };
  if (sub) o.subtype = sub;
  if (withPreview && sub !== 'node') o.preview = preview(v, sub, o);
  return o;
}

// The same value as remote(v, true), in short, for console messages: a logged string, number,
// boolean or null is itself, and everything else is an array that starts with its kind. The laptop
// writes the protocol's object back out of it (expand.ts, held to remote() by test).
//   [0] undefined · [1, text] NaN, Infinity, -Infinity, -0 · [2, digits] bigint
//   [3, description, objectId] symbol · [4, source, objectId] function
//   [5, className, description, objectId, subtype, overflow, name, type, value, subtype, ...] object
// with its preview's entries four at a time. A node has no preview: its array ends at the subtype.
// 0 stands for an objectId or subtype there isn't.
var TYPE_CODE = { undefined: 0, string: 1, number: 2, boolean: 3, object: 4, function: 5, symbol: 6, bigint: 7 };
var ACCESSOR = 8;

function brief(v) {
  var t = typeof v;
  if (t === 'string' || t === 'boolean' || v === null) return v;
  if (t === 'number') {
    if (v !== v) return [1, 'NaN'];
    if (v === Infinity) return [1, 'Infinity'];
    if (v === -Infinity) return [1, '-Infinity'];
    return v === 0 && 1 / v < 0 ? [1, '-0'] : v;
  }
  if (t === 'undefined') return [0];
  if (t === 'bigint') return [2, String(v)];
  if (t === 'symbol') return [3, String(v), keep(v) || 0];
  if (t === 'function') return [4, fnToStr.call(v), keep(v) || 0];
  var tag = toStr.call(v).slice(8, -1);
  var sub = subtypeOf(v, tag);
  var cls = classOf(v, tag);
  var out = [5, cls, describe(v, sub, cls), keep(v) || 0, sub || 0];
  if (sub === 'node') return out;
  var isList = sub === 'array' || sub === 'typedarray';
  var max = isList ? PREVIEW_ITEMS : PREVIEW_PROPS;
  var keys = isList ? null : Object.keys(v);
  var n = isList ? read(v, 'length') >>> 0 : keys.length;
  out.push(n > max ? 1 : 0);
  for (var i = 0; i < n && i < max; i++) {
    var k = isList ? String(i) : keys[i];
    var d = descriptor(v, k);
    if (d && !('value' in d)) {
      out.push(k, ACCESSOR, 0, 0);
      continue;
    }
    var x = read(v, k);
    var xt = typeof x;
    out.push(k, TYPE_CODE[xt], short(x), x === null ? 'null' : xt === 'object' ? subtypeOf(x, toStr.call(x).slice(8, -1)) || 0 : 0);
  }
  return out;
}

function jsonCopy(v) {
  try {
    return JSON.parse(JSON.stringify(v));
  } catch (e) {
    return undefined;
  }
}

function byValue(v) {
  var t = typeof v;
  if (t === 'undefined') return { type: 'undefined' };
  if (t === 'number') return number(v);
  if (v === null) return { type: 'object', subtype: 'null', value: null };
  return { type: t === 'function' ? 'function' : t, value: t === 'object' ? jsonCopy(v) : v };
}

function fromArg(a) {
  if (!a) return undefined;
  if (a.objectId) return get(a.objectId);
  if (a.unserializableValue) {
    var u = a.unserializableValue;
    if (u === 'NaN') return NaN;
    if (u === 'Infinity') return Infinity;
    if (u === '-Infinity') return -Infinity;
    if (u === '-0') return -0;
    return undefined;
  }
  return a.value;
}

function property(name, d, isOwn, withPreview) {
  var p = { name: name, configurable: !!d.configurable, enumerable: !!d.enumerable, isOwn: isOwn };
  if ('value' in d) {
    p.value = remote(d.value, withPreview);
    p.writable = !!d.writable;
  } else {
    p.get = d.get ? remote(d.get) : { type: 'undefined' };
    p.set = d.set ? remote(d.set) : { type: 'undefined' };
  }
  return p;
}

// Runtime.getProperties. Getters are never invoked: DevTools shows "(...)" and calls them on click.
function properties(o, ownOnly, accessorsOnly, withPreview) {
  var result = [];
  var names, d, i;
  if (!accessorsOnly) {
    names = ownNames(o);
    for (i = 0; i < names.length; i++) {
      d = descriptor(o, names[i]);
      if (d) result.push(property(names[i], d, true, withPreview));
    }
  }
  if (accessorsOnly || !ownOnly) {
    var seen = {};
    for (var p = accessorsOnly ? o : protoOf(o); p; p = protoOf(p)) {
      names = ownNames(p);
      for (i = 0; i < names.length; i++) {
        if (seen[names[i]] === 1 || names[i] === '__proto__') continue;
        d = descriptor(p, names[i]);
        if (!d || (accessorsOnly && 'value' in d)) continue;
        seen[names[i]] = 1;
        result.push(property(names[i], d, p === o, withPreview));
      }
    }
  }
  var out = { result: result };
  var proto = protoOf(o);
  if (!accessorsOnly && proto) out.internalProperties = [{ name: '[[Prototype]]', value: remote(proto) }];
  return out;
}

exports.keep = keep;
exports.get = get;
exports.clear = clear;
exports.release = release;
exports.clearConsole = function () {
  empty(consoleRing);
};
/** Values made remote between consoleStart() and consoleEnd() are held by the console's ring. */
exports.consoleStart = function () {
  into = consoleRing;
};
exports.consoleEnd = function () {
  into = general;
};
/** Governor level: 0 full detail, 1 and up shorter previews and console arguments not kept. */
exports.setDetail = function (level) {
  PREVIEW_PROPS = level ? 2 : 5;
  PREVIEW_ITEMS = level ? 5 : 20;
  retain = !level;
};
exports.remote = remote;
exports.brief = brief;
exports.byValue = byValue;
exports.fromArg = fromArg;
exports.properties = properties;
exports.nodeDescription = nodeDescription;
