'use strict';
var cx = require('./cx.js');

var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function frame() {
  var url = location.href.split('#')[0];
  return {
    id: cx.FRAME_ID,
    loaderId: 'teleport',
    url: url,
    domainAndRegistry: '',
    securityOrigin: cx.origin(),
    mimeType: 'text/html',
    secureContextType: location.protocol === 'https:' ? 'Secure' : 'InsecureScheme',
    crossOriginIsolatedContextType: 'NotIsolated',
    gatedAPIFeatures: []
  };
}

function addAll(out, seen, list, attr, type, mime) {
  for (var i = 0; i < list.length; i++) {
    var url = list[i][attr];
    if (!url || seen[url] === 1 || url.indexOf('data:') === 0) continue;
    seen[url] = 1;
    out.push({ url: url, type: type, mimeType: mime });
  }
}

function resources() {
  var out = [];
  var seen = {};
  addAll(out, seen, document.scripts || document.getElementsByTagName('script'), 'src', 'Script', 'text/javascript');
  addAll(out, seen, document.querySelectorAll('link[rel~="stylesheet"]'), 'href', 'Stylesheet', 'text/css');
  addAll(out, seen, document.images, 'src', 'Image', 'image');
  return out;
}

function base64(buf) {
  var b = new Uint8Array(buf);
  var out = '';
  var i = 0;
  for (; i + 2 < b.length; i += 3) {
    var n = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
    out += B64.charAt(n >> 18) + B64.charAt((n >> 12) & 63) + B64.charAt((n >> 6) & 63) + B64.charAt(n & 63);
  }
  var rest = b.length - i;
  if (rest === 1) {
    out += B64.charAt(b[i] >> 2) + B64.charAt((b[i] & 3) << 4) + '==';
  } else if (rest === 2) {
    var m = (b[i] << 8) | b[i + 1];
    out += B64.charAt(m >> 10) + B64.charAt((m >> 4) & 63) + B64.charAt((m & 15) << 2) + '=';
  }
  return out;
}

function isImage(url) {
  var imgs = document.images;
  for (var i = 0; i < imgs.length; i++) if (imgs[i].src === url) return true;
  return false;
}

// Whether a URL is on the page's own origin. Another origin's file isn't fetched: without CORS the
// request fails, and the app's console and its error reporting (which see every XHR) would get the
// failure, for a request the app never made.
function sameOrigin(url) {
  var a = document.createElement('a');
  a.href = url;
  return String(a.href).indexOf(location.protocol + '//' + location.host + '/') === 0;
}

function fetchContent(id, url) {
  if (!cx.attempt(sameOrigin, url)) {
    cx.fail(id, "teleport reads only the page's own files; " + url + ' is on another origin');
    return cx.ASYNC;
  }
  var xhr = new XMLHttpRequest();
  var binary = isImage(url);
  xhr.open('GET', url);
  if (binary) xhr.responseType = 'arraybuffer';
  xhr.onload = cx.guard(function () {
    if (binary) cx.reply(id, { content: base64(xhr.response), base64Encoded: true });
    else cx.reply(id, { content: xhr.responseText, base64Encoded: false });
  });
  xhr.onerror = cx.guard(function () {
    cx.fail(id, 'Could not load ' + url);
  });
  xhr.send();
  return cx.ASYNC;
}

function storage(p) {
  var local = !p.storageId || p.storageId.isLocalStorage;
  try {
    return local ? window.localStorage : window.sessionStorage;
  } catch (e) {
    return null;
  }
}

function withStorage(p, id) {
  var s = storage(p);
  if (!s) cx.fail(id, 'unavailable: storage is blocked or missing on this engine');
  return s;
}

function storageKey() {
  return { storageKey: cx.origin() + '/' };
}

exports.detach = function () {};

cx.on({
  'Page.getResourceTree': function () {
    return { frameTree: { frame: frame(), resources: resources() } };
  },
  'Page.getFrameTree': function () {
    return { frameTree: { frame: frame() } };
  },
  'Page.getResourceContent': function (p, id) {
    return fetchContent(id, p.url);
  },
  'Page.reload': function () {
    setTimeout(
      cx.guard(function () {
        location.reload();
      }),
      0
    );
    return {};
  },
  'Page.navigate': function (p) {
    setTimeout(
      cx.guard(function () {
        location.href = p.url;
      }),
      0
    );
    return { frameId: cx.FRAME_ID, loaderId: 'teleport' };
  },
  'Page.getNavigationHistory': function () {
    return {
      currentIndex: 0,
      entries: [{ id: 0, url: location.href, userTypedURL: location.href, title: document.title, transitionType: 'typed' }]
    };
  },
  'Page.getLayoutMetrics': function () {
    var de = document.documentElement;
    var vp = { pageX: window.pageXOffset, pageY: window.pageYOffset, clientWidth: de.clientWidth, clientHeight: de.clientHeight };
    var vv = {
      offsetX: 0, offsetY: 0, pageX: vp.pageX, pageY: vp.pageY,
      clientWidth: vp.clientWidth, clientHeight: vp.clientHeight, scale: 1, zoom: 1
    };
    var size = { x: 0, y: 0, width: de.scrollWidth, height: de.scrollHeight };
    return {
      layoutViewport: vp, visualViewport: vv, contentSize: size,
      cssLayoutViewport: vp, cssVisualViewport: vv, cssContentSize: size
    };
  },
  'Page.addScriptToEvaluateOnNewDocument': function () {
    return { identifier: '0' };
  },

  'Storage.getStorageKey': storageKey,
  'Storage.getStorageKeyForFrame': storageKey,

  'DOMStorage.getDOMStorageItems': function (p, id) {
    var s = withStorage(p, id);
    if (!s) return cx.ASYNC;
    var entries = [];
    for (var i = 0; i < s.length; i++) {
      var k = s.key(i);
      entries.push([k, s.getItem(k)]);
    }
    return { entries: entries };
  },
  'DOMStorage.setDOMStorageItem': function (p, id) {
    var s = withStorage(p, id);
    if (!s) return cx.ASYNC;
    s.setItem(p.key, p.value);
    return {};
  },
  'DOMStorage.removeDOMStorageItem': function (p, id) {
    var s = withStorage(p, id);
    if (!s) return cx.ASYNC;
    s.removeItem(p.key);
    return {};
  },
  'DOMStorage.clear': function (p, id) {
    var s = withStorage(p, id);
    if (!s) return cx.ASYNC;
    s.clear();
    return {};
  }
});
