'use strict';
var cx = require('./cx.js');
var dom = require('./dom.js');

// Each stylesheet is presented to DevTools as one line per style rule:
//   `<selector> { <decl>; <decl>; }`
// Ranges point into that text, so a style edit maps back to (sheet, rule index) with no parsing.
// Inline styles use one sheet per element ('i' + nodeId) whose single line is the declarations.
// Rule lists are re-flattened only when a sheet's cssRules.length changes.
//
// A style DevTools edited is reported from the text DevTools sent, not from CSSOM, as Chrome does.
// CSSOM drops what it can't parse: a half-typed value (`font-size: 2`) or a property DevTools
// disabled by commenting it out. Reporting CSSOM's version would make the property vanish
// mid-edit, and DevTools would then commit against a rule that no longer matches its view.

var SHEET = '__teleportSheet';
var AUTHORED = '__teleportAuthored';
var sheets = [];
var enabled = false;

// What the Styles pane asks for on every click is mostly what it was sent on the last one: the same
// rules match an element and its ancestors, and a computed style differs from the last in a few
// values. So the replies are short (see cx.js on epochs, and expand.ts on the laptop):
//   - a rule's selector and declarations go once, then only as (sheet, rule index). A rule is sent
//     again when its selector or its declaration text has changed since (`sent` holds what they
//     were), and a sheet whose rule list changed length has all of its rules forgotten (`resets`).
//   - a computed style's property names go once, then only the values that differ from the last
//     reply's (`csLast`), each with its index.
var csNames = null;
var csLast = null;
var resets = [];

function forgetSent() {
  csNames = csLast = null;
  resets = [];
  for (var i = 0; i < sheets.length; i++) sheets[i].sent = {};
}
cx.onEpoch(forgetSent);

function cssRules(sheet) {
  try {
    return sheet.cssRules || sheet.rules || null;
  } catch (e) {
    return null;
  }
}

function flatten(list, out) {
  for (var i = 0; i < list.length; i++) {
    var r = list[i];
    if (r.type === 1) out.push(r);
    else if (r.cssRules && (r.type === 4 || r.type === 12)) flatten(r.cssRules, out);
  }
  return out;
}

function header(e) {
  var owner = e.sheet.ownerNode;
  var h = {
    styleSheetId: e.id,
    frameId: cx.FRAME_ID,
    sourceURL: e.sheet.href || '',
    origin: 'regular',
    title: e.sheet.title || '',
    disabled: !!e.sheet.disabled,
    isInline: !e.sheet.href,
    isMutable: true,
    isConstructed: false,
    startLine: 0,
    startColumn: 0,
    length: 0,
    endLine: e.rules.length,
    endColumn: 0
  };
  if (owner) h.ownerNode = dom.idOf(owner);
  return h;
}

// Each selector is kept with a key from its rightmost compound (an id, a class or a tag) and its
// specificity, both computed once per sheet load. matching() tests the key before calling the
// engine's matches(): a 5000-rule bundle against a 15-deep element would otherwise be 75 000
// selector matches per Styles pane refresh, which a device feels.
function load(e, rules, len) {
  e.rules = rules ? flatten(rules, []) : [];
  e.sels = [];
  e.keys = [];
  e.specs = [];
  for (var i = 0; i < e.rules.length; i++) {
    var sels = splitSelectors(e.rules[i].selectorText);
    var keys = [];
    var specs = [];
    for (var k = 0; k < sels.length; k++) {
      keys.push(keyOf(sels[k]));
      specs.push(specificity(sels[k]));
    }
    e.sels.push(sels);
    e.keys.push(keys);
    e.specs.push(specs);
  }
  // Rule indexes mean something else now: the laptop forgets what it had of this sheet.
  if (e.len !== -2) resets.push(e.index);
  e.sent = {};
  e.spelt = {};
  e.len = len;
}

function refresh() {
  var list = document.styleSheets;
  for (var i = 0; i < list.length; i++) {
    var s = list[i];
    var e = s[SHEET];
    var rules = cssRules(s);
    var len = rules ? rules.length : -1;
    if (!e || sheets[e.index] !== e) {
      e = { index: sheets.length, id: 's' + sheets.length, sheet: s, len: -2, rules: null, sels: null };
      sheets.push(e);
      s[SHEET] = e;
      load(e, rules, len);
      if (enabled) cx.emit('CSS.styleSheetAdded', { header: header(e) });
    } else if (e.len !== len) {
      load(e, rules, len);
    }
  }
}

function declText(style) {
  var t = '';
  for (var i = 0; i < style.length; i++) {
    var name = style[i];
    var imp = style.getPropertyPriority(name);
    t += (i ? ' ' : '') + name + ': ' + style.getPropertyValue(name) + (imp ? ' !important' : '') + ';';
  }
  return t;
}

// Kept on one line, so a sheet stays one line per rule and ranges stay on the rule's line.
function setStyleText(style, text) {
  text = text.replace(/\s*\n\s*/g, ' ').replace(/^\s+|\s+$/g, '');
  style.cssText = text;
  style[AUTHORED] = { text: text, css: style.cssText };
}

// The text DevTools last set, if the page hasn't changed the style since.
function authored(style) {
  var a = style[AUTHORED];
  return a && a.css === style.cssText ? a.text : null;
}

function declaration(text, start, end, disabled, style, sheetId, line, col) {
  var body = disabled ? text.slice(start + 2, end - 2) : text.slice(start, end);
  var colon = body.indexOf(':');
  if (colon < 0) return null;
  var name = body.slice(0, colon).replace(/^\s+|\s+$/g, '');
  var value = body.slice(colon + 1).replace(/;\s*$/, '').replace(/^\s+|\s+$/g, '');
  var imp = /!\s*important$/i.test(value);
  if (imp) value = value.replace(/\s*!\s*important$/i, '');
  if (!name) return null;
  var p = { name: name, value: value, important: imp, implicit: false, text: text.slice(start, end), disabled: disabled };
  if (!disabled) p.parsedOk = style.getPropertyValue(name) !== '';
  if (sheetId) p.range = { startLine: line, startColumn: col + start, endLine: line, endColumn: col + end };
  return p;
}

// Splits declarations at top-level `;`, skipping strings and parentheses. `/* ... */` holds a
// property DevTools disabled.
function authoredProps(text, style, sheetId, line, col) {
  var props = [];
  var i = 0;
  var n = text.length;
  while (i < n) {
    while (i < n && /\s|;/.test(text.charAt(i))) i++;
    if (i >= n) break;
    var start = i;
    var p = null;
    if (text.substr(i, 2) === '/*') {
      var close = text.indexOf('*/', i + 2);
      i = close < 0 ? n : close + 2;
      p = declaration(text, start, i, true, style, sheetId, line, col);
    } else {
      var depth = 0;
      var quote = '';
      for (; i < n; i++) {
        var ch = text.charAt(i);
        if (quote) {
          if (ch === '\\') i++;
          else if (ch === quote) quote = '';
        } else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === '(') depth++;
        else if (ch === ')') depth--;
        else if (ch === ';' && depth <= 0) break;
        else if (ch === '/' && text.charAt(i + 1) === '*' && depth <= 0) break;
      }
      if (text.charAt(i) === ';') i++;
      p = declaration(text, start, i, false, style, sheetId, line, col);
    }
    if (p) props.push(p);
  }
  return props;
}

function styleOf(style, sheetId, line, col) {
  var text = authored(style);
  if (text !== null) {
    var s0 = { cssProperties: authoredProps(text, style, sheetId, line, col), shorthandEntries: [], cssText: text };
    if (sheetId) {
      s0.styleSheetId = sheetId;
      s0.range = { startLine: line, startColumn: col, endLine: line, endColumn: col + text.length };
    }
    return s0;
  }
  var props = [];
  var c = col;
  for (var i = 0; i < style.length; i++) {
    var name = style[i];
    var value = style.getPropertyValue(name);
    var imp = style.getPropertyPriority(name);
    var text = name + ': ' + value + (imp ? ' !important' : '') + ';';
    var p = { name: name, value: value, important: !!imp, implicit: false, text: text, disabled: false };
    if (sheetId) p.range = { startLine: line, startColumn: c, endLine: line, endColumn: c + text.length };
    props.push(p);
    c += text.length + 1;
  }
  var cssText = declText(style);
  var s = { cssProperties: props, shorthandEntries: [], cssText: cssText };
  if (sheetId) {
    s.styleSheetId = sheetId;
    s.range = { startLine: line, startColumn: col, endLine: line, endColumn: col + cssText.length };
  }
  return s;
}

/** A style's declarations, three values each: name, value, 1 when !important. */
function triples(style) {
  var out = [];
  for (var i = 0; i < style.length; i++) {
    var name = style[i];
    out.push(name, style.getPropertyValue(name), style.getPropertyPriority(name) ? 1 : 0);
  }
  return out;
}

// An element's inline style, in short: 0 without one, [nodeId, triples], or for a style DevTools
// edited [nodeId, 0, the protocol's style], whose text is DevTools' own and not the engine's.
function inlineBrief(el) {
  var st = el.style;
  if (!st) return 0;
  var id = dom.idOf(el);
  return authored(st) !== null ? [id, 0, styleOf(st, 'i' + id, 0, 0)] : [id, triples(st)];
}

// Adds rule i of sheet e to defs unless the laptop has it as it is now:
// [sheet, rule, selector, triples], or [sheet, rule, selector, 0, the protocol's style] for one
// DevTools edited, which is never taken as known.
// False when the page has rewritten the rule's selector since the sheet was read: the selectors
// that were matched against are not the rule's any more, so the sheet is read again and the reply
// started over.
function define(e, i, defs) {
  var r = e.rules[i];
  var st = r.style;
  var sel = r.selectorText;
  if (sel !== e.sels[i].join(', ') && e.spelt[i] !== sel) {
    // Changed, or an engine that writes a list another way: then it is remembered as the same.
    if (splitSelectors(sel).join('\n') !== e.sels[i].join('\n')) return false;
    e.spelt[i] = sel;
  }
  if (authored(st) !== null) {
    delete e.sent[i];
    defs.push([e.index, i, sel, 0, styleOf(st, e.id, i, sel.length + 3)]);
    return true;
  }
  var now = sel + '\n' + st.cssText;
  if (e.sent[i] === now) return true;
  e.sent[i] = now;
  defs.push([e.index, i, sel, triples(st)]);
  return true;
}

// One element's part of a matched-styles reply: its inline style, then (sheet, rule, which of the
// rule's selectors match: an index, or a list of them) for each rule, in cascade order. Null when a
// sheet turned out stale and has been read again.
function matchedBrief(el, defs) {
  var out = [inlineBrief(el)];
  var hits = matching(el);
  for (var h = 0; h < hits.length; h++) {
    var hit = hits[h];
    if (!define(hit.e, hit.i, defs)) {
      load(hit.e, cssRules(hit.e.sheet), hit.e.len);
      return null;
    }
    out.push(hit.e.index, hit.i, hit.matching.length === 1 ? hit.matching[0] : hit.matching);
  }
  return out;
}

// [3, id, epoch, definitions, the element's part, each ancestor's part], or null (see matchedBrief).
function matchedReply(el, id) {
  var defs = [];
  for (var i = 0; i < resets.length; i++) defs.push([resets[i], -1]);
  var out = [3, id, cx.epoch(), defs];
  for (var a = el; a && a.nodeType === 1; a = a.parentNode) {
    var part = matchedBrief(a, defs);
    if (!part) return null;
    out.push(part);
  }
  resets = [];
  return out;
}

function splitSelectors(text) {
  var out = [];
  var depth = 0;
  var start = 0;
  for (var i = 0; i < text.length; i++) {
    var ch = text.charAt(i);
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(text.slice(start, i).replace(/^\s+|\s+$/g, ''));
      start = i + 1;
    }
  }
  out.push(text.slice(start).replace(/^\s+|\s+$/g, ''));
  return out;
}

var ID_RE = /#[\w-]+/g;
var CLASS_RE = /\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g;
var STRIP_RE = /#[\w-]+|\.[\w-]+|\[[^\]]*\]|::?[\w-]+(\([^)]*\))?/g;
var TAG_RE = /[a-zA-Z][\w-]*/g;

function specificity(sel) {
  var ids = (sel.match(ID_RE) || []).length;
  var cls = (sel.match(CLASS_RE) || []).length;
  var tags = (sel.replace(STRIP_RE, ' ').match(TAG_RE) || []).length;
  return ids * 10000 + cls * 100 + tags;
}

function test(el, fn, sel) {
  try {
    return fn.call(el, sel);
  } catch (e) {
    return false;
  }
}

var KEY_ANY = { id: null, cls: null, tag: null };

// The rightmost compound of a selector, the part that must match the element itself, reduced to
// the id, one class and the tag it demands (each null when it demands none). Parenthesised and
// bracketed parts are skipped, so `.a:not(.b)` keys on `a`, not `b`. An escape anywhere in the
// compound makes it demand nothing, as the engine alone can read those.
function keyOf(sel) {
  var i = sel.length - 1;
  var depth = 0;
  for (; i >= 0; i--) {
    var ch = sel.charAt(i);
    if (ch === ')' || ch === ']') depth++;
    else if (ch === '(' || ch === '[') depth--;
    else if (depth === 0 && (ch === ' ' || ch === '>' || ch === '+' || ch === '~')) break;
  }
  var compound = sel.slice(i + 1);
  if (compound.indexOf('\\') >= 0) return KEY_ANY;
  compound = compound.replace(/\([^)]*\)|\[[^\]]*\]/g, '');
  var id = /#([\w-]+)/.exec(compound);
  var cls = /\.([\w-]+)/.exec(compound);
  var tag = /^([a-zA-Z][\w-]*)/.exec(compound);
  if (!id && !cls && !tag) return KEY_ANY;
  return { id: id ? id[1] : null, cls: cls ? cls[1] : null, tag: tag ? tag[1].toUpperCase() : null };
}

function hasClass(el, c) {
  var cl = el.classList;
  if (cl) return cl.contains(c);
  var s = el.getAttribute('class');
  return typeof s === 'string' && (' ' + s.replace(/\s+/g, ' ') + ' ').indexOf(' ' + c + ' ') >= 0;
}

// Whether the selector's key lets el match at all. True means ask the engine.
function might(el, key) {
  if (key.id !== null && el.id !== key.id) return false;
  if (key.cls !== null && !hasClass(el, key.cls)) return false;
  if (key.tag !== null) {
    var tag = el.tagName;
    return tag === key.tag || (typeof tag === 'string' && tag.toUpperCase() === key.tag);
  }
  return true;
}

function mediaOk(rule) {
  for (var p = rule.parentRule; p; p = p.parentRule) {
    if (p.type === 4 && window.matchMedia && !window.matchMedia(p.media.mediaText).matches) return false;
  }
  return true;
}

function ruleText(e, i) {
  var r = e.rules[i];
  var text = authored(r.style);
  return r.selectorText + ' { ' + (text !== null ? text : declText(r.style)) + ' }';
}

function rulePayload(e, i, sels) {
  var r = e.rules[i];
  var selectors = [];
  for (var k = 0; k < sels.length; k++) selectors.push({ text: sels[k] });
  return {
    styleSheetId: e.id,
    selectorList: { selectors: selectors, text: r.selectorText },
    origin: 'regular',
    style: styleOf(r.style, e.id, i, r.selectorText.length + 3)
  };
}

// Rules that match el in cascade order (specificity, then document order), as { e, i, sels, matching }.
function matching(el) {
  var fn = el.matches || el.webkitMatchesSelector || el.msMatchesSelector;
  var hits = [];
  if (!fn) return hits;
  for (var s = 0; s < sheets.length; s++) {
    var e = sheets[s];
    if (e.sheet.disabled) continue;
    for (var i = 0; i < e.rules.length; i++) {
      var r = e.rules[i];
      var sels = e.sels[i];
      var keys = e.keys[i];
      var specs = e.specs[i];
      var matched = [];
      var spec = -1;
      for (var k = 0; k < sels.length; k++) {
        if (might(el, keys[k]) && test(el, fn, sels[k])) {
          matched.push(k);
          if (specs[k] > spec) spec = specs[k];
        }
      }
      if (matched.length && mediaOk(r)) hits.push({ spec: spec, order: hits.length, e: e, i: i, sels: sels, matching: matched });
    }
  }
  hits.sort(function (a, b) {
    return a.spec - b.spec || a.order - b.order;
  });
  return hits;
}

function element(p, id) {
  var n = dom.nodeFrom(p);
  if (n && n.nodeType === 1) return n;
  cx.fail(id, 'Could not find element with given id');
  return null;
}

function sheetFor(id) {
  return id && id.charAt(0) === 's' ? sheets[+id.slice(1)] || null : null;
}

function applyEdit(edit) {
  var sid = edit.styleSheetId;
  if (sid.charAt(0) === 'i') {
    var el = dom.nodeFrom({ nodeId: +sid.slice(1) });
    if (!el) return null;
    setStyleText(el.style, edit.text);
    return styleOf(el.style, sid, 0, 0);
  }
  var e = sheetFor(sid);
  var r = e && e.rules[edit.range.startLine];
  if (!r) return null;
  setStyleText(r.style, edit.text);
  return styleOf(r.style, sid, edit.range.startLine, r.selectorText.length + 3);
}

exports.refresh = refresh;
exports.matching = matching;
exports.keyOf = keyOf;
exports.splitSelectors = splitSelectors;

exports.detach = function () {
  enabled = false;
  sheets = [];
};

cx.on({
  // The laptop couldn't follow a short reply: everything is said again from the next one.
  'teleport.resync': function () {
    cx.newEpoch();
    return {};
  },

  'CSS.enable': function () {
    enabled = true;
    sheets = [];
    // Sheets are numbered from 0 again.
    cx.newEpoch();
    refresh();
    return {};
  },

  // In short: [3, id, epoch, definitions, the element's part, each ancestor's part]. The definitions
  // start with [sheet, -1] for every sheet whose rules the laptop must forget.
  'CSS.getMatchedStylesForNode': function (p, id) {
    var el = element(p, id);
    if (!el) return cx.ASYNC;
    refresh();
    // A second go when a sheet was stale, and a third never: by then every sheet has been read again.
    var out = null;
    for (var tries = 0; !out && tries <= sheets.length; tries++) out = matchedReply(el, id);
    if (!out) {
      cx.fail(id, 'teleport: the style sheets kept changing');
      return cx.ASYNC;
    }
    return cx.answer(out);
  },

  // In short: [4, id, the inline style].
  'CSS.getInlineStylesForNode': function (p, id) {
    var el = element(p, id);
    return el ? cx.answer([4, id, inlineBrief(el)]) : cx.ASYNC;
  },

  // In short: [2, id, epoch, 1, names, values] the first time, and whenever the engine lists other
  // properties than it did; after that [2, id, epoch, 0, how many properties, index, value, ...]
  // with only the values that differ from the last reply's.
  'CSS.getComputedStyleForNode': function (p, id) {
    var el = element(p, id);
    if (!el) return cx.ASYNC;
    var cs = getComputedStyle(el);
    var n = cs.length;
    var i, name, v;
    if (csNames !== null && csNames.length === n) {
      var out = [2, id, cx.epoch(), 0, n];
      for (i = 0; i < n; i++) {
        name = cs[i];
        if (name !== csNames[i]) break;
        v = cs.getPropertyValue(name);
        if (v !== csLast[i]) {
          out.push(i, v);
          csLast[i] = v;
        }
      }
      if (i === n) return cx.answer(out);
    }
    csNames = [];
    csLast = [];
    for (i = 0; i < n; i++) {
      name = cs[i];
      csNames.push(name);
      csLast.push(cs.getPropertyValue(name));
    }
    return cx.answer([2, id, cx.epoch(), 1, csNames, csLast]);
  },

  'CSS.getStyleSheetText': function (p, id) {
    var sid = p.styleSheetId;
    if (sid.charAt(0) === 'i') {
      var el = dom.nodeFrom({ nodeId: +sid.slice(1) });
      return { text: el ? declText(el.style) : '' };
    }
    var e = sheetFor(sid);
    if (!e) {
      cx.fail(id, 'No style sheet with given id found');
      return cx.ASYNC;
    }
    var lines = [];
    for (var i = 0; i < e.rules.length; i++) lines.push(ruleText(e, i));
    return { text: lines.join('\n') };
  },

  'CSS.setStyleTexts': function (p, id) {
    var styles = [];
    var edits = p.edits || [];
    for (var i = 0; i < edits.length; i++) {
      var s = applyEdit(edits[i]);
      if (!s) {
        cx.fail(id, 'Could not apply style edit');
        return cx.ASYNC;
      }
      styles.push(s);
    }
    return { styles: styles };
  },

  'CSS.createStyleSheet': function () {
    var el = document.createElement('style');
    (document.head || document.documentElement).appendChild(el);
    refresh();
    return { styleSheetId: el.sheet[SHEET].id };
  },

  'CSS.addRule': function (p, id) {
    var e = sheetFor(p.styleSheetId);
    if (!e) {
      cx.fail(id, 'No style sheet with given id found');
      return cx.ASYNC;
    }
    var list = cssRules(e.sheet);
    e.sheet.insertRule(p.ruleText, list ? list.length : 0);
    refresh();
    var i = e.rules.length - 1;
    return { rule: rulePayload(e, i, e.sels[i]) };
  },

  'CSS.getPlatformFontsForNode': function () {
    return { fonts: [] };
  },
  'CSS.getEnvironmentVariables': function () {
    return { environmentVariables: {} };
  },
  'CSS.getMediaQueries': function () {
    return { medias: [] };
  },
  'CSS.getAnimatedStylesForNode': function () {
    return { animationStyles: [], inherited: [] };
  },
  'CSS.trackComputedStyleUpdates': function () {
    return {};
  },
  'CSS.trackComputedStyleUpdatesForNode': function () {
    return {};
  },
  'CSS.takeComputedStyleUpdates': function () {
    return { nodeIds: [] };
  }
});
