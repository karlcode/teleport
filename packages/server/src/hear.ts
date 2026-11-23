// The key reader: what the page hears when a key is pressed, and what that key is. A device's own
// remote, a game controller or a keyboard each send their own codes for the same button (OK is Enter
// 13 on most, GamepadA 195 from a controller on Windows, button 0 through the Gamepad API), and an app reads only
// some of them. The reader listens in the page for a while and names each press: which remote key it
// stands for, whether the page took it (cancelled it, moved focus, or a click followed), and whether
// it came from the device or from teleport. A device's own press of a known key is remembered for its
// platform, so the remote sends what the device's remote sends (remote.ts pressFor).
//
// The listener is installed by the first read and removes itself when nothing reads it for a few
// seconds, so a laptop that goes away leaves nothing behind in the page.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { KEY, type KeyId, type Learned, type Press } from './remote.js';
import { describeUa } from './ua.js';

/** What a key code or key name stands for. */
export interface Meaning {
  /** The remote key it is, when it is one. */
  id: KeyId | null;
  /** Its name as a person would say it: 'Enter', 'gamepad A', 'browser back'. */
  name: string;
}

// Key codes as devices send them. Windows' virtual key codes for a controller (VK_GAMEPAD_*, 195 on)
// are what Edge and WebView2 send on Windows when a controller types keys.
const CODES: Record<number, [KeyId | null, string]> = {
  13: ['ok', 'Enter'],
  32: [null, 'Space'],
  8: ['back', 'Backspace'],
  27: ['back', 'Escape'],
  166: ['back', 'browser back'],
  37: ['left', 'arrow left'],
  38: ['up', 'arrow up'],
  39: ['right', 'arrow right'],
  40: ['down', 'arrow down'],
  195: ['ok', 'gamepad A'],
  196: ['back', 'gamepad B'],
  197: [null, 'gamepad X'],
  198: [null, 'gamepad Y'],
  199: [null, 'gamepad RB'],
  200: [null, 'gamepad LB'],
  201: [null, 'gamepad LT'],
  202: [null, 'gamepad RT'],
  203: ['up', 'd-pad up'],
  204: ['down', 'd-pad down'],
  205: ['left', 'd-pad left'],
  206: ['right', 'd-pad right'],
  207: [null, 'gamepad menu'],
  208: [null, 'gamepad view'],
  211: ['up', 'left stick up'],
  212: ['down', 'left stick down'],
  213: ['right', 'left stick right'],
  214: ['left', 'left stick left'],
  403: ['red', 'red'],
  404: ['green', 'green'],
  405: ['yellow', 'yellow'],
  406: ['blue', 'blue'],
  415: ['play', 'play'],
  19: ['pause', 'pause'],
  413: ['stop', 'stop'],
  412: ['rewind', 'rewind'],
  417: ['forward', 'fast forward'],
  179: [null, 'play/pause'],
};
for (let d = 0; d <= 9; d++) {
  CODES[48 + d] = [String(d) as KeyId, String(d)];
  CODES[96 + d] = [String(d) as KeyId, `keypad ${d}`];
}

// The same by key name, for engines whose key code is 0 or a platform's own.
const NAMES: Record<string, [KeyId | null, string]> = {
  Enter: ['ok', 'Enter'], Accept: ['ok', 'Accept'], Select: ['ok', 'Select'], GamepadA: ['ok', 'gamepad A'],
  Escape: ['back', 'Escape'], Backspace: ['back', 'Backspace'], BrowserBack: ['back', 'browser back'], GoBack: ['back', 'go back'], XF86Back: ['back', 'back'], GamepadB: ['back', 'gamepad B'],
  ArrowUp: ['up', 'arrow up'], ArrowDown: ['down', 'arrow down'], ArrowLeft: ['left', 'arrow left'], ArrowRight: ['right', 'arrow right'],
  Up: ['up', 'arrow up'], Down: ['down', 'arrow down'], Left: ['left', 'arrow left'], Right: ['right', 'arrow right'],
  GamepadDPadUp: ['up', 'd-pad up'], GamepadDPadDown: ['down', 'd-pad down'], GamepadDPadLeft: ['left', 'd-pad left'], GamepadDPadRight: ['right', 'd-pad right'],
  MediaPlay: ['play', 'play'], MediaPause: ['pause', 'pause'], MediaStop: ['stop', 'stop'], MediaRewind: ['rewind', 'rewind'], MediaFastForward: ['forward', 'fast forward'], MediaPlayPause: [null, 'play/pause'],
  ColorF0Red: ['red', 'red'], ColorF1Green: ['green', 'green'], ColorF2Yellow: ['yellow', 'yellow'], ColorF3Blue: ['blue', 'blue'],
};

/** The buttons of a controller in the Gamepad API's standard layout, by index. */
const BUTTONS: [KeyId | null, string][] = [
  ['ok', 'A'], ['back', 'B'], [null, 'X'], [null, 'Y'], [null, 'LB'], [null, 'RB'], [null, 'LT'], [null, 'RT'], [null, 'view'], [null, 'menu'],
  [null, 'left stick'], [null, 'right stick'], ['up', 'd-pad up'], ['down', 'd-pad down'], ['left', 'd-pad left'], ['right', 'd-pad right'], [null, 'home'],
];

/** What a key event stands for: by its key name first, which says more, then by its code. */
export function meaning(key: string | null, keyCode: number): Meaning {
  const byName = key ? NAMES[key] : undefined;
  const byCode = CODES[keyCode];
  const hit = byName ?? byCode;
  if (hit) return { id: hit[0], name: hit[1] };
  if (key && key.length === 1) return { id: null, name: key === ' ' ? 'Space' : key };
  return { id: null, name: key && key !== 'Unidentified' ? key : `key ${keyCode}` };
}

/** A controller button by its index in the standard layout. */
export const buttonMeaning = (i: number): Meaning => {
  const b = BUTTONS[i];
  return b ? { id: b[0], name: `button ${b[1]}` } : { id: null, name: `button ${i}` };
};

/** A remote key's short name for a row: arrows as words, a remote key as its label, the rest by name. */
export const keyWord = (code: number) => {
  const m = meaning(null, code);
  if (!m.id) return m.name.toLowerCase();
  return m.id === 'up' || m.id === 'down' || m.id === 'left' || m.id === 'right' ? m.id : KEY[m.id].label;
};

/** One thing the page heard. */
export interface Heard {
  kind: 'key' | 'button';
  /** The event's key, code and key code as the page saw them; for a button, its index in `keyCode`. */
  key: string | null;
  code: string | null;
  keyCode: number;
  /** Who pressed it: the device itself, or teleport (a sent press). */
  from: 'device' | 'teleport';
  /** The page cancelled it: something handled it. */
  took: boolean;
  /** A click followed it: a button or link was activated. */
  clicked: boolean;
  /** The page's DOM changed just after it: something on screen reacted. */
  changed: boolean;
  /** Where focus was, and where it went, as tag#id or tag.class. */
  at: string;
  to: string | null;
  /** When, ms: the device's clock as the page read it; the server makes it ms after the first heard. */
  t: number;
  /** For a button, the controller's layout ('standard' or ''). */
  mapping?: string;
  what: Meaning;
}

/** The listener's buffer: at most this many things between reads. */
export const HEAR_MAX = 64;
/** How long after a press the page is watched for what it did: focus, a click, any change to the DOM. */
export const HEAR_WATCH_MS = 150;
/** The listener removes itself when nothing has read it for this long. */
export const HEAR_IDLE_MS = 5000;

/**
 * ES5, run in the page: installs the listener if it isn't there, then hands over what it heard since
 * the last read, as JSON. Key presses are heard on window in the capture phase, before the app's
 * own handlers; what the app did with one is read 150 ms after, from the same event: cancelled,
 * focus moved, a click, or the DOM changed (a MutationObserver over the page for those 150 ms only). A controller read
 * through the Gamepad API types no keys, so its buttons are polled every 50 ms while it listens.
 * Everything is in try/catch: a reader must never throw into the page.
 */
export const HEAR_SCRIPT = `(function(){var w=window,d=document,h=w.__tlptHear,M=${HEAR_MAX},IDLE=${HEAR_IDLE_MS};
function now(){return +new Date()}
function el(x){try{if(!x)return '';if(x===d.body)return 'body';var s=String(x.tagName||'').toLowerCase();if(x.id)return s+'#'+x.id;var c=typeof x.className==='string'?x.className.replace(/^\\s+/,'').split(/\\s+/)[0]:'';return c?s+'.'+c:s}catch(e){return ''}}
function off(){try{w.removeEventListener('keydown',h.key,true);w.removeEventListener('click',h.click,true);if(h.poll)clearInterval(h.poll)}catch(e){}try{delete w.__tlptHear}catch(e){w.__tlptHear=undefined}}
if(!h){h=w.__tlptHear={q:[],read:now(),last:null,pads:{}};
var MO=w.MutationObserver||w.WebKitMutationObserver;
h.key=function(e){try{if(h.q.length>=M)return;var r={kind:'key',key:e.key===undefined?null:String(e.key),code:e.code===undefined?null:String(e.code),keyCode:(e.keyCode||e.which||0)|0,sent:!!e.__tlpt,at:el(d.activeElement),t:now(),done:false};h.q.push(r);h.last=r;
var mo=null;if(MO){try{mo=new MO(function(){r.changed=true});mo.observe(d.documentElement,{childList:true,subtree:true,attributes:true,characterData:true})}catch(x){mo=null}}
setTimeout(function(){try{r.took=!!e.defaultPrevented;var a=el(d.activeElement);if(a!==r.at)r.to=a;if(mo)mo.disconnect()}catch(x){}r.done=true},${HEAR_WATCH_MS})}catch(x){}};
h.click=function(){try{if(h.last&&now()-h.last.t<${HEAR_WATCH_MS})h.last.clicked=true}catch(x){}};
w.addEventListener('keydown',h.key,true);w.addEventListener('click',h.click,true);
var gp=navigator.getGamepads||navigator.webkitGetGamepads;
if(gp){h.poll=setInterval(function(){try{if(now()-h.read>IDLE)return off();var ps=gp.call(navigator)||[];for(var i=0;i<ps.length;i++){var p=ps[i];if(!p||!p.buttons)continue;var was=h.pads[i]||[];for(var b=0;b<p.buttons.length;b++){var on=typeof p.buttons[b]==='object'?p.buttons[b].pressed:p.buttons[b]>0.5;if(on&&!was[b]&&h.q.length<M)h.q.push({kind:'button',key:null,code:null,keyCode:b,sent:false,at:el(d.activeElement),t:now(),mapping:String(p.mapping||''),done:true});was[b]=on}h.pads[i]=was}}catch(x){}},50)}
else{h.poll=setInterval(function(){if(now()-h.read>IDLE)off()},1000)}}
h.read=now();var out=[],keep=[];for(var i=0;i<h.q.length;i++)(h.q[i].done?out:keep).push(h.q[i]);h.q=keep;return JSON.stringify(out)})()`;

const str = (v: unknown, max = 40) => (typeof v === 'string' ? v.slice(0, max) : null);

/** What the page said it heard, checked: anything malformed is dropped. */
export function parseHeard(raw: unknown): Heard[] {
  let list: unknown;
  try {
    list = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const out: Heard[] = [];
  for (const r of list.slice(0, HEAR_MAX)) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const kind = o.kind === 'button' ? 'button' : o.kind === 'key' ? 'key' : null;
    const keyCode = Number(o.keyCode);
    if (!kind || !Number.isInteger(keyCode) || keyCode < 0 || keyCode > 65535) continue;
    const t = Number(o.t);
    const key = str(o.key);
    out.push({
      kind,
      key,
      code: str(o.code),
      keyCode,
      from: o.sent === true ? 'teleport' : 'device',
      took: o.took === true,
      clicked: o.clicked === true,
      changed: o.changed === true,
      at: str(o.at, 60) ?? '',
      to: str(o.to, 60),
      t: Number.isFinite(t) ? Math.max(0, t) : 0,
      ...(kind === 'button' ? { mapping: str(o.mapping, 20) ?? '' } : {}),
      what: kind === 'button' ? buttonMeaning(keyCode) : meaning(key, keyCode),
    });
  }
  return out;
}

/** Key names by key code, for a key given as a number: what the device's own remote sends with it. */
const KEY_OF: Record<number, [string, string]> = {
  13: ['Enter', 'Enter'], 27: ['Escape', 'Escape'], 8: ['Backspace', 'Backspace'], 32: [' ', 'Space'], 166: ['BrowserBack', 'BrowserBack'],
  37: ['ArrowLeft', 'ArrowLeft'], 38: ['ArrowUp', 'ArrowUp'], 39: ['ArrowRight', 'ArrowRight'], 40: ['ArrowDown', 'ArrowDown'],
  195: ['GamepadA', ''], 196: ['GamepadB', ''], 203: ['GamepadDPadUp', ''], 204: ['GamepadDPadDown', ''], 205: ['GamepadDPadLeft', ''], 206: ['GamepadDPadRight', ''],
};

/**
 * A press from what a person types for it: a key code (`195`), or a key name (`GamepadA`, `Enter`),
 * which teleport knows the code of. Null when it is neither.
 */
export function pressFrom(said: string): Press | null {
  const t = said.trim();
  if (/^\d{1,5}$/.test(t)) {
    const n = Number(t);
    if (!n || n > 65535) return null;
    const [key, code] = KEY_OF[n] ?? ['', ''];
    return { key, code, keyCode: n };
  }
  for (const [n, [key, code]] of Object.entries(KEY_OF)) if (key.toLowerCase() === t.toLowerCase()) return { key, code, keyCode: Number(n) };
  return null;
}

/** The press a heard key would be, sent: its own key, code and key code (an engine without key names sends none). */
export const pressOf = (h: Heard): Press | null =>
  h.kind === 'key' && h.keyCode > 0 ? { key: h.key && h.key !== 'Unidentified' ? h.key : '', code: h.code ?? '', keyCode: h.keyCode } : null;

/** Which family of device a learned key belongs to: its platform, as describeUa names it. */
export const familyOf = (ua: string) => describeUa(ua).split(' · ')[0] || 'unknown';

/**
 * The keys each family of device was heard to send, kept in teleport's config folder so the remote
 * sends them next time too. Only a device's own presses of a remote key are kept, and only where they
 * differ from what teleport would send anyway.
 */
export class KeyMemory {
  private by: Record<string, Learned> = {};
  constructor(private file: string | null = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'teleport', 'keys.json')) {
    if (!file) return;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>;
      for (const [fam, keys] of Object.entries(raw ?? {})) {
        if (!keys || typeof keys !== 'object') continue;
        const ok: Learned = {};
        for (const [id, p] of Object.entries(keys)) {
          const q = p as Partial<Press>;
          if (id in KEY && q && typeof q.key === 'string' && typeof q.code === 'string' && Number.isInteger(q.keyCode)) ok[id as KeyId] = { key: q.key, code: q.code, keyCode: q.keyCode! };
        }
        this.by[fam] = ok;
      }
    } catch {
      // No file yet, or one that isn't ours: start empty.
    }
  }

  of(ua: string): Learned {
    return this.by[familyOf(ua)] ?? {};
  }

  /**
   * Takes what a device was heard pressing; returns the keys it learned, each with what it sends now.
   * `usual` is what teleport would send for a key without this memory.
   */
  learn(ua: string, heard: Heard[], usual: (id: KeyId) => Press): { id: KeyId; press: Press; name: string }[] {
    const fam = familyOf(ua);
    const mine = (this.by[fam] ??= {});
    const out: { id: KeyId; press: Press; name: string }[] = [];
    for (const h of heard) {
      const id = h.what.id;
      const p = pressOf(h);
      if (h.from !== 'device' || !id || !p) continue;
      // The key code is what apps for these devices read; an engine too old for key names sends the
      // same code with no name, which is nothing new.
      const now = mine[id] ?? usual(id);
      if (now.keyCode === p.keyCode) continue;
      mine[id] = p;
      out.push({ id, press: p, name: h.what.name });
    }
    if (out.length) this.save();
    return out;
  }

  /** Sets what a key sends on this family of device, by hand; null puts it back to what teleport sends of itself. */
  set(ua: string, id: KeyId, press: Press | null) {
    const mine = (this.by[familyOf(ua)] ??= {});
    if (press) mine[id] = press;
    else delete mine[id];
    this.save();
  }

  /** Forgets what a family was heard to send. */
  forget(ua: string) {
    delete this.by[familyOf(ua)];
    this.save();
  }

  private save() {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.by, null, 2) + '\n');
    } catch {
      // A read-only config folder: the memory lasts while tlpt runs.
    }
  }
}
