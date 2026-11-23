// The inspector sends its busiest messages in short: arrays of numbers and strings where the Chrome
// DevTools Protocol has nested objects, without what never varies, and for the Styles pane without
// what this side was sent before (packages/inspector/src/cx.js, css.js, remote.js, network.js,
// dom.js say what each array holds). The device's JSON.stringify writes those several times cheaper
// than the protocol's shape on an engine without an optimising compiler, at a quarter of the bytes. This
// writes the protocol's messages back out, so everything after it reads the protocol as before.
//
// Never a wrong answer. A short message is checked as it is read: its shape, its counts, and for the
// ones that lean on earlier messages (a rule by number, a computed style as changes) the epoch they
// were written in. One that can't be followed becomes an error reply for its request, never a guess,
// and the device is asked to say everything again (`resync`). The link delivers in order and exactly
// once; when it can't (messages lost while it was down), the device starts a new epoch and says so.

export interface Cdp {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

type Json = unknown;
type Obj = Record<string, unknown>;

const CONTEXT_ID = 1;
const FRAME_ID = 'main';
const TYPES = ['undefined', 'string', 'number', 'boolean', 'object', 'function', 'symbol', 'bigint', 'accessor'];

class Malformed extends Error {}

function fail(why: string): never {
  throw new Malformed(why);
}
const str = (v: Json, what: string): string => (typeof v === 'string' ? v : fail(`${what} is not a string`));
const num = (v: Json, what: string): number => (typeof v === 'number' && Number.isFinite(v) ? v : fail(`${what} is not a number`));
const int = (v: Json, what: string): number => (Number.isInteger(v) ? (v as number) : fail(`${what} is not a whole number`));
const list = (v: Json, what: string): Json[] => (Array.isArray(v) ? v : fail(`${what} is not a list`));
const obj = (v: Json, what: string): Obj => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : fail(`${what} is not an object`));

/** A console argument back as the protocol's RemoteObject: what remote(v, true) on the device makes. */
export function remoteObject(b: Json): Obj {
  if (b === null) return { type: 'object', subtype: 'null', value: null };
  if (typeof b === 'string' || typeof b === 'boolean') return { type: typeof b, value: b };
  if (typeof b === 'number') return { type: 'number', value: b, description: String(b) };
  const a = list(b, 'a value');
  const id = (v: Json) => (v === 0 ? undefined : str(v, 'an object id'));
  switch (a[0]) {
    case 0:
      return { type: 'undefined' };
    case 1:
      return { type: 'number', unserializableValue: str(a[1], 'a number'), description: a[1] };
    case 2:
      return { type: 'bigint', unserializableValue: str(a[1], 'a bigint') + 'n', description: a[1] + 'n' };
    case 3:
      return defined({ type: 'symbol', description: str(a[1], 'a symbol'), objectId: id(a[2]) });
    case 4:
      return defined({ type: 'function', className: 'Function', description: str(a[1], 'a function'), objectId: id(a[2]) });
    case 5: {
      const description = str(a[2], 'a description');
      const o: Obj = defined({ type: 'object', className: str(a[1], 'a class'), description, objectId: id(a[3]) });
      const sub = a[4] === 0 ? '' : str(a[4], 'a subtype');
      if (sub) o.subtype = sub;
      if (a.length === 5) return sub === 'node' ? o : fail('an object without its preview');
      if ((a.length - 6) % 4 !== 0) fail('a preview of the wrong length');
      const properties: Obj[] = [];
      for (let i = 6; i < a.length; i += 4) {
        const name = str(a[i], 'a property name');
        const type = TYPES[int(a[i + 1], 'a property type')] ?? fail('an unknown property type');
        if (type === 'accessor') {
          properties.push({ name, type });
          continue;
        }
        const e: Obj = { name, type, value: str(a[i + 2], 'a property value') };
        if (a[i + 3] !== 0) e.subtype = str(a[i + 3], 'a property subtype');
        properties.push(e);
      }
      const preview: Obj = { type: 'object', description, overflow: a[5] === 1, properties };
      if (sub) preview.subtype = sub;
      o.preview = preview;
      return o;
    }
    default:
      return fail('an unknown kind of value');
  }
}

/** Without the keys whose value is undefined, as JSON.stringify on the device leaves them out. */
function defined(o: Obj): Obj {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

/** A selector list at its top-level commas: css.js `splitSelectors`, held to it by test. */
export function splitSelectors(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
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

/** The protocol's CSSStyle from (name, value, important) triples: css.js `styleOf` for a style DevTools hasn't edited. */
export function styleFrom(triples: Json[], sheetId: string, line: number, col: number): Obj {
  if (triples.length % 3 !== 0) fail('declarations of the wrong length');
  const cssProperties: Obj[] = [];
  const texts: string[] = [];
  let c = col;
  for (let i = 0; i < triples.length; i += 3) {
    const name = str(triples[i], 'a property name');
    const value = str(triples[i + 1], 'a property value');
    const important = triples[i + 2] === 1;
    const text = name + ': ' + value + (important ? ' !important' : '') + ';';
    cssProperties.push({ name, value, important, implicit: false, text, disabled: false, range: { startLine: line, startColumn: c, endLine: line, endColumn: c + text.length } });
    texts.push(text);
    c += text.length + 1;
  }
  const cssText = texts.join(' ');
  return { cssProperties, shorthandEntries: [], cssText, styleSheetId: sheetId, range: { startLine: line, startColumn: col, endLine: line, endColumn: col + cssText.length } };
}

function mimeOf(headers: Obj): string {
  for (const k in headers) if (k.toLowerCase() === 'content-type') return String(headers[k]).split(';')[0]!;
  return '';
}

interface Rule {
  selectorText: string;
  selectors: { text: string }[];
  style: Obj;
}

export class Expander {
  /** Set when a short message couldn't be followed: the device is to be asked to start over. */
  resync = false;
  /** Short messages that couldn't be followed, over the life of the link. */
  refused = 0;
  private epoch = 0;
  private names: string[] | null = null;
  private values: string[] = [];
  private rules = new Map<string, Rule>();

  /** Forgets what earlier messages said, as when the device says some were lost. */
  reset() {
    this.epoch = 0;
    this.names = null;
    this.values = [];
    this.rules.clear();
  }

  /** The protocol messages a short message stands for. One that can't be followed gives an error
   *  reply when it answered a request, and nothing when it was an event. */
  expand(msg: Json): Cdp[] {
    try {
      return this.read(list(msg, 'a short message'));
    } catch (e) {
      if (!(e instanceof Malformed)) throw e;
      this.refused++;
      this.resync = true;
      this.reset();
      const a = Array.isArray(msg) ? msg : [];
      const isReply = a[0] === 2 || a[0] === 3 || a[0] === 4 || a[0] === 5;
      const id = a[1];
      if (!isReply || (typeof id !== 'number' && typeof id !== 'string')) return [];
      return [{ id, error: { code: -32000, message: `teleport: couldn't read the device's answer (${e.message}); ask again` } }];
    }
  }

  private read(a: Json[]): Cdp[] {
    switch (a[0]) {
      case 1: {
        const args = a.slice(3).map(remoteObject);
        return [{ method: 'Runtime.consoleAPICalled', params: { type: str(a[1], 'a console type'), args, executionContextId: CONTEXT_ID, timestamp: num(a[2], 'a timestamp') } }];
      }
      case 2:
        return [{ id: replyId(a[1]), result: { computedStyle: this.computed(a) } }];
      case 3: {
        if (a.length < 5) fail('a matched-styles reply that is too short');
        this.enter(a[2]);
        for (const d of list(a[3], 'definitions')) this.define(list(d, 'a definition'));
        const own = this.matched(a[4]);
        const inherited = a.slice(5).map((part) => this.matched(part));
        return [
          {
            id: replyId(a[1]),
            result: {
              ...own,
              inherited,
              pseudoElements: [],
              inheritedPseudoElements: [],
              cssKeyframesRules: [],
              cssPositionTryRules: [],
              cssPropertyRules: [],
              cssPropertyRegistrations: [],
              cssAtRules: [],
              cssFunctionRules: [],
            },
          },
        ];
      }
      case 4:
        if (a.length !== 3) fail('an inline-styles reply of the wrong length');
        return [{ id: replyId(a[1]), result: defined({ inlineStyle: inline(a[2]) }) }];
      case 5:
        return [{ id: replyId(a[1]), result: { model: boxModel(a) } }];
      case 6: {
        if (a.length !== 10) fail('a request of the wrong length');
        const request: Obj = { url: str(a[3], 'a URL'), method: str(a[2], 'a method'), headers: obj(a[4], 'headers'), initialPriority: 'High', referrerPolicy: 'strict-origin-when-cross-origin' };
        if (a[5] !== 0) request.postData = str(a[5], 'a body');
        return [
          {
            method: 'Network.requestWillBeSent',
            params: {
              requestId: str(a[1], 'a request id'),
              loaderId: 'teleport',
              documentURL: str(a[9], 'a document URL'),
              request,
              timestamp: num(a[7], 'a timestamp'),
              wallTime: num(a[8], 'a wall time'),
              initiator: { type: 'other' },
              type: str(a[6], 'a resource type'),
              frameId: FRAME_ID,
            },
          },
        ];
      }
      case 7: {
        if (a.length !== 9) fail('a response of the wrong length');
        const requestId = str(a[1], 'a request id');
        const headers = obj(a[5], 'headers');
        const timestamp = num(a[8], 'a timestamp');
        const encodedDataLength = num(a[7], 'a size');
        return [
          {
            method: 'Network.responseReceived',
            params: {
              requestId,
              loaderId: 'teleport',
              timestamp,
              type: str(a[6], 'a resource type'),
              frameId: FRAME_ID,
              response: {
                url: str(a[2], 'a URL'),
                status: num(a[3], 'a status'),
                statusText: str(a[4], 'a status text'),
                headers,
                mimeType: mimeOf(headers),
                connectionReused: false,
                connectionId: 0,
                encodedDataLength,
                securityState: 'unknown',
              },
            },
          },
          { method: 'Network.loadingFinished', params: { requestId, timestamp, encodedDataLength } },
        ];
      }
      case 8:
        if (a.length !== 5) fail('a failure of the wrong length');
        return [{ method: 'Network.loadingFailed', params: { requestId: str(a[1], 'a request id'), timestamp: num(a[4], 'a timestamp'), type: str(a[2], 'a resource type'), errorText: str(a[3], 'an error'), canceled: false } }];
      case 9:
        if (a.length !== 7) fail('a mark of the wrong length');
        return [
          {
            method: 'teleport.mark',
            params: { t: num(a[1], 't'), queued: num(a[2], 'queued'), costPct: num(a[3], 'cost'), level: num(a[4], 'level'), droppedConsole: num(a[5], 'dropped'), droppedNet: num(a[6], 'dropped') },
          },
        ];
      case 10:
        // The DOM's changes: the bridge reads them, since it holds the names they lean on.
        return [{ method: 'teleport.mutations', params: a as never }];
      default:
        return fail('an unknown kind of message');
    }
  }

  /** A message written in `epoch`. A later epoch than the one held means what is held is void. */
  private enter(epoch: Json) {
    const e = int(epoch, 'an epoch');
    if (e === this.epoch) return;
    this.reset();
    this.epoch = e;
  }

  private computed(a: Json[]): Obj[] {
    this.enter(a[2]);
    if (a[3] === 1) {
      if (a.length !== 6) fail('a computed style of the wrong length');
      const names = list(a[4], 'names').map((n) => str(n, 'a property name'));
      const values = list(a[5], 'values').map((v) => str(v, 'a property value'));
      if (names.length !== values.length) fail('as many names as values');
      this.names = names;
      this.values = values;
    } else {
      const names = this.names ?? fail('changes to a computed style this side never had');
      if (int(a[4], 'a count') !== names.length) fail('changes to a computed style of another length');
      if ((a.length - 5) % 2 !== 0) fail('changes of the wrong length');
      // Checked whole before any is applied, so a bad one leaves nothing half changed.
      for (let i = 5; i < a.length; i += 2) {
        const at = int(a[i], 'an index');
        if (at < 0 || at >= names.length) fail('a change outside the list');
        str(a[i + 1], 'a property value');
      }
      for (let i = 5; i < a.length; i += 2) this.values[a[i] as number] = a[i + 1] as string;
    }
    const values = this.values;
    return this.names!.map((name, i) => ({ name, value: values[i]! }));
  }

  private define(d: Json[]) {
    const sheet = int(d[0], 'a sheet');
    const index = int(d[1], 'a rule');
    if (sheet < 0) fail('a sheet below zero');
    if (index === -1) {
      if (d.length !== 2) fail('a reset of the wrong length');
      for (const k of [...this.rules.keys()]) if (k.startsWith(sheet + ':')) this.rules.delete(k);
      return;
    }
    if (index < 0) fail('a rule below zero');
    const selectorText = str(d[2], 'a selector');
    const sheetId = 's' + sheet;
    let style: Obj;
    if (d[3] === 0) {
      if (d.length !== 5) fail('an edited rule of the wrong length');
      style = obj(d[4], 'a style');
    } else {
      if (d.length !== 4) fail('a rule of the wrong length');
      style = styleFrom(list(d[3], 'declarations'), sheetId, index, selectorText.length + 3);
    }
    this.rules.set(sheet + ':' + index, { selectorText, selectors: splitSelectors(selectorText).map((text) => ({ text })), style });
  }

  /** One element's inline style and the rules that match it. */
  private matched(part: Json): Obj {
    const a = list(part, "an element's styles");
    if (a.length < 1 || (a.length - 1) % 3 !== 0) fail("an element's styles of the wrong length");
    const matchedCSSRules: Obj[] = [];
    for (let i = 1; i < a.length; i += 3) {
      const sheet = int(a[i], 'a sheet');
      const rule = this.rules.get(sheet + ':' + int(a[i + 1], 'a rule')) ?? fail('a rule this side was never sent');
      const m = a[i + 2];
      const matchingSelectors = (Array.isArray(m) ? m : [m]).map((x) => int(x, 'a selector index'));
      for (const x of matchingSelectors) if (x < 0 || x >= rule.selectors.length) fail('a selector the rule does not have');
      matchedCSSRules.push({
        rule: { styleSheetId: 's' + sheet, selectorList: { selectors: rule.selectors, text: rule.selectorText }, origin: 'regular', style: rule.style },
        matchingSelectors,
      });
    }
    return defined({ inlineStyle: inline(a[0]), matchedCSSRules });
  }
}

function replyId(v: Json): number | string {
  return typeof v === 'number' || typeof v === 'string' ? v : fail('a reply without its id');
}

function inline(v: Json): Obj | undefined {
  if (v === 0) return undefined;
  const a = list(v, 'an inline style');
  const sheetId = 'i' + int(a[0], 'a node id');
  if (a[1] === 0) return a.length === 3 ? obj(a[2], 'a style') : fail('an edited inline style of the wrong length');
  return a.length === 2 ? styleFrom(list(a[1], 'declarations'), sheetId, 0, 0) : fail('an inline style of the wrong length');
}

function boxModel(a: Json[]): Obj {
  if (a.length !== 20) fail('a box of the wrong length');
  const n = a.slice(2).map((v) => num(v, 'a length'));
  const [left, top, right, bottom, width, height, bl, bt, br, bb, pl, pt, pr, pb, ml, mt, mr, mb] = n as [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number];
  const quad = (l: number, t: number, r: number, b: number) => [l, t, r, t, r, b, l, b];
  // The same sums in the same order as dom.js `boxModel`, so each is the same double.
  return {
    content: quad(left + bl + pl, top + bt + pt, right - br - pr, bottom - bb - pb),
    padding: quad(left + bl, top + bt, right - br, bottom - bb),
    border: quad(left, top, right, bottom),
    margin: quad(left - ml, top - mt, right + mr, bottom + mb),
    width,
    height,
  };
}
