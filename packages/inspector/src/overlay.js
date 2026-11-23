'use strict';
var cx = require('./cx.js');
var dom = require('./dom.js');

// Highlight boxes are three nested rings drawn with borders (margin, border, padding) around a
// filled content box: four divs, created once, moved on demand. Nothing runs while hidden.
var root = null;
var marginBox, borderBox, paddingBox, label;
var inspectConfig = null;

var DEFAULTS = {
  contentColor: { r: 111, g: 168, b: 220, a: 0.66 },
  paddingColor: { r: 147, g: 196, b: 125, a: 0.55 },
  borderColor: { r: 255, g: 229, b: 153, a: 0.66 },
  marginColor: { r: 246, g: 178, b: 107, a: 0.66 }
};

function rgba(c, fallback) {
  c = c || fallback;
  return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + (c.a === undefined ? 1 : c.a) + ')';
}

function box(parent) {
  var d = document.createElement('div');
  d.style.cssText = 'position:absolute;box-sizing:border-box;border-style:solid;border-color:transparent;-webkit-background-clip:content-box;background-clip:content-box';
  parent.appendChild(d);
  return d;
}

function ensure() {
  if (!root) {
    root = document.createElement('div');
    root.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none';
    marginBox = box(root);
    borderBox = box(root);
    paddingBox = box(root);
    label = document.createElement('div');
    label.style.cssText = 'position:absolute;padding:2px 6px;background:#333740;color:#fff;font:12px/1.4 monospace;white-space:nowrap;border-radius:2px';
    root.appendChild(label);
    dom.setHidden(root);
  }
  if (!root.parentNode) (document.body || document.documentElement).appendChild(root);
}

function place(d, q, widths, color) {
  d.style.left = q[0] + 'px';
  d.style.top = q[1] + 'px';
  d.style.width = q[2] - q[0] + 'px';
  d.style.height = q[5] - q[1] + 'px';
  d.style.borderWidth = widths;
  d.style.borderColor = color;
}

function edges(outer, inner) {
  return inner[1] - outer[1] + 'px ' + (outer[2] - inner[2]) + 'px ' + (outer[5] - inner[5]) + 'px ' + (inner[0] - outer[0]) + 'px';
}

function show(n, config) {
  if (!n || n.nodeType !== 1) return hide();
  config = config || {};
  ensure();
  var m = dom.boxModel(n);
  place(marginBox, m.margin, edges(m.margin, m.border), rgba(config.marginColor, DEFAULTS.marginColor));
  place(borderBox, m.border, edges(m.border, m.padding), rgba(config.borderColor, DEFAULTS.borderColor));
  place(paddingBox, m.padding, edges(m.padding, m.content), rgba(config.paddingColor, DEFAULTS.paddingColor));
  paddingBox.style.backgroundColor = rgba(config.contentColor, DEFAULTS.contentColor);
  label.textContent = nodeLabel(n) + '  ' + Math.round(m.width) + ' × ' + Math.round(m.height);
  label.style.left = Math.max(0, m.border[0]) + 'px';
  label.style.top = (m.border[5] + 26 < window.innerHeight ? m.border[5] + 4 : Math.max(0, m.border[1] - 24)) + 'px';
  root.style.display = 'block';
}

function nodeLabel(n) {
  var s = n.nodeName.toLowerCase();
  if (n.id) s += '#' + n.id;
  if (typeof n.className === 'string' && n.className) s += '.' + n.className.replace(/^\s+|\s+$/g, '').split(/\s+/).join('.');
  return s;
}

function hide() {
  if (root) root.style.display = 'none';
}

function pick(n) {
  if (!n || n === root) return;
  setInspect(null);
  cx.emit('Overlay.inspectNodeRequested', { backendNodeId: dom.idOf(n) });
}

function onMove(e) {
  show(e.target, inspectConfig);
}

function onClick(e) {
  e.preventDefault();
  e.stopPropagation();
  pick(e.target);
}

// Devices have no pointer: Enter picks whatever the app has focused.
function onKey(e) {
  if (e.keyCode !== 13) return;
  e.preventDefault();
  e.stopPropagation();
  pick(document.activeElement);
}

function onFocus(e) {
  show(e.target, inspectConfig);
}

// Listeners on the app's document, while DevTools picks an element: guarded, so the app's own
// handlers and its onerror never hear of a failure here.
var moved = cx.guard(onMove);
var clicked = cx.guard(onClick);
var pressed = cx.guard(onKey);
var focused = cx.guard(onFocus);

function setInspect(config) {
  var on = !!config;
  if (on === !!inspectConfig) {
    inspectConfig = config;
    return;
  }
  inspectConfig = config;
  var method = on ? 'addEventListener' : 'removeEventListener';
  document[method]('mousemove', moved, true);
  document[method]('click', clicked, true);
  document[method]('keydown', pressed, true);
  document[method]('focus', focused, true);
  if (!on) hide();
}

function highlight(p, id) {
  var n = dom.nodeFrom(p);
  if (!n) {
    cx.fail(id, 'Could not find node with given id');
    return cx.ASYNC;
  }
  show(n, p.highlightConfig);
  return {};
}

exports.show = show;
exports.hide = hide;

exports.detach = function () {
  setInspect(null);
  if (root && root.parentNode) root.parentNode.removeChild(root);
};

cx.on({
  'Overlay.highlightNode': highlight,
  'DOM.highlightNode': highlight,
  'Overlay.hideHighlight': function () {
    hide();
    return {};
  },
  'DOM.hideHighlight': function () {
    hide();
    return {};
  },
  'Overlay.setInspectMode': function (p) {
    setInspect(p.mode === 'searchForNode' ? p.highlightConfig || {} : null);
    return {};
  }
});
