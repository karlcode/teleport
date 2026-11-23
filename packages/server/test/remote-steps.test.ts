import { describe, expect, it } from 'vitest';
import { KINDS, kindOf, parseSteps, presses, runRemote, targetScript, textScript, type RemoteRun, type Step } from '../src/remote.js';

const ES2015 = /=>|\blet\b|\bconst\b|`|\.\.\./;

/** Runs one of the page scripts against a fake window, as the inspector would, and returns what it returned. */
const inPage = (script: string, win: Record<string, unknown>) => new Function('window', 'document', `with (window) { return ${script} }`)(win, win.document) as unknown;

/** Older Chromium: the constructor exists but drops key, code, keyCode and charCode from the init dictionary. */
class FakeKeyboardEvent {
  type: string;
  bubbles: boolean;
  key = '';
  code = '';
  keyCode = 0;
  which = 0;
  charCode = 0;
  constructor(type: string, init: { bubbles?: boolean }) {
    this.type = type;
    this.bubbles = !!init.bubbles;
  }
}
class FakeEvent {
  type: string;
  bubbles: boolean;
  constructor(type: string, init: { bubbles?: boolean }) {
    this.type = type;
    this.bubbles = !!init.bubbles;
  }
}

interface Seen {
  type: string;
  key?: string;
  code?: string;
  keyCode?: number;
  charCode?: number;
  which?: number;
}
const record = (seen: Seen[], e: FakeKeyboardEvent | FakeEvent) => {
  const k = e as Partial<FakeKeyboardEvent>;
  seen.push(k.key === undefined ? { type: e.type } : { type: e.type, key: k.key, code: k.code, keyCode: k.keyCode, charCode: k.charCode, which: k.which });
};

describe('steps of every kind', () => {
  it('reads text, wait, focus and click steps from outside, and drops what cannot run', () => {
    expect(
      parseSteps([
        { kind: 'text', text: 'hello', delayMs: 100 },
        { kind: 'text', text: '' },
        { kind: 'wait', ms: 99_999 },
        { kind: 'wait' },
        { kind: 'focus', selector: '  .tile  ' },
        { kind: 'click', selector: '#play', delayMs: 0 },
        { kind: 'click', selector: '   ' },
        { kind: 'warp', text: 'x' },
        { kind: 'key', key: 'ok' },
      ]),
    ).toEqual([
      { kind: 'text', text: 'hello', delayMs: 100 },
      { kind: 'wait', ms: 10_000 },
      { kind: 'wait', ms: 350 },
      { kind: 'focus', selector: '.tile', delayMs: 350 },
      { kind: 'click', selector: '#play', delayMs: 0 },
      { key: 'ok', repeat: 1, delayMs: 350 },
    ]);
    expect(parseSteps([{ kind: 'text', text: 'x'.repeat(1000) }])[0]).toMatchObject({ text: 'x'.repeat(200) });
  });

  it('knows each step by its kind, and how many actions it is', () => {
    const steps: Step[] = [
      { key: 'up', repeat: 3, delayMs: 0 },
      { kind: 'text', text: 'abc', delayMs: 0 },
      { kind: 'wait', ms: 500 },
      { kind: 'focus', selector: 'a', delayMs: 0 },
      { kind: 'click', selector: 'a', delayMs: 0 },
    ];
    expect(steps.map(kindOf)).toEqual(['key', 'text', 'wait', 'focus', 'click']);
    expect(presses(steps)).toBe(7);
    expect(Object.keys(KINDS).sort()).toEqual(['click', 'focus', 'key', 'text', 'wait']);
  });
});

describe('the text script', () => {
  function input(opts: { cancel?: string; caret?: boolean } = {}) {
    const seen: Seen[] = [];
    const sets: string[] = [];
    // React's value tracker: the element's own `value` accessor records what the app sets, so an
    // input event after a value set through it is ignored. Typing must go through the prototype's setter.
    class HTMLInputElement {
      _v = '';
      get value() {
        return this._v;
      }
      set value(v: string) {
        this._v = v;
        sets.push(`proto:${v}`);
      }
    }
    const el = new HTMLInputElement() as HTMLInputElement & Record<string, unknown>;
    Object.defineProperty(el, 'value', {
      configurable: true,
      get() {
        return this._v;
      },
      set(v: string) {
        this._v = v;
        sets.push(`own:${v}`);
      },
    });
    el.tagName = 'INPUT';
    if (opts.caret !== false) {
      el.selectionStart = 0;
      el.selectionEnd = 0;
      el.setSelectionRange = (a: number, b: number) => ((el.selectionStart = a), (el.selectionEnd = b));
    }
    el.dispatchEvent = (e: FakeKeyboardEvent) => (record(seen, e), !(e.type === 'keydown' && e.key === opts.cancel));
    const win = { KeyboardEvent: FakeKeyboardEvent, Event: FakeEvent, HTMLInputElement, Object, document: { activeElement: el, body: {} } };
    return { el, seen, sets, win };
  }

  it('is ES5', () => {
    expect(textScript('héllo "wörld" ')).not.toMatch(ES2015);
  });

  it('types each character as keydown, keypress, the value, an input event, then keyup', () => {
    const { el, seen, sets, win } = input();
    expect(inPage(textScript('h1 '), win)).toBe('');
    expect(el.value).toBe('h1 ');
    expect(seen).toEqual([
      { type: 'keydown', key: 'h', code: 'KeyH', keyCode: 72, charCode: 0, which: 72 },
      { type: 'keypress', key: 'h', code: 'KeyH', keyCode: 104, charCode: 104, which: 104 },
      { type: 'input' },
      { type: 'keyup', key: 'h', code: 'KeyH', keyCode: 72, charCode: 0, which: 72 },
      { type: 'keydown', key: '1', code: 'Digit1', keyCode: 49, charCode: 0, which: 49 },
      { type: 'keypress', key: '1', code: 'Digit1', keyCode: 49, charCode: 49, which: 49 },
      { type: 'input' },
      { type: 'keyup', key: '1', code: 'Digit1', keyCode: 49, charCode: 0, which: 49 },
      { type: 'keydown', key: ' ', code: 'Space', keyCode: 32, charCode: 0, which: 32 },
      { type: 'keypress', key: ' ', code: 'Space', keyCode: 32, charCode: 32, which: 32 },
      { type: 'input' },
      { type: 'keyup', key: ' ', code: 'Space', keyCode: 32, charCode: 0, which: 32 },
    ]);
    expect(sets).toEqual(['proto:h', 'proto:h1', 'proto:h1 ']);
  });

  it('inserts at the caret and moves it along', () => {
    const { el, win } = input();
    el._v = 'ac';
    el.selectionStart = el.selectionEnd = 1;
    inPage(textScript('b'), win);
    expect(el.value).toBe('abc');
    expect([el.selectionStart, el.selectionEnd]).toEqual([2, 2]);
  });

  it('appends where the element has no caret', () => {
    const { el, win } = input({ caret: false });
    el._v = 'a';
    inPage(textScript('bc'), win);
    expect(el.value).toBe('abc');
  });

  it('leaves the value alone for a character the app cancelled on keydown', () => {
    const { el, seen, win } = input({ cancel: 'b' });
    inPage(textScript('ab'), win);
    expect(el.value).toBe('a');
    expect(seen.filter((e) => e.key === 'b').map((e) => e.type)).toEqual(['keydown', 'keyup']);
  });

  it('types into a contenteditable element', () => {
    const seen: Seen[] = [];
    const el = { isContentEditable: true, textContent: 'x', dispatchEvent: (e: FakeKeyboardEvent) => (record(seen, e), true) };
    inPage(textScript('yz'), { KeyboardEvent: FakeKeyboardEvent, Event: FakeEvent, Object, document: { activeElement: el, body: {} } });
    expect(el.textContent).toBe('xyz');
    expect(seen.filter((e) => e.type === 'input')).toHaveLength(2);
  });

  it('sends the keys and no input event when nothing editable has focus', () => {
    const seen: Seen[] = [];
    const body = { dispatchEvent: (e: FakeKeyboardEvent) => (record(seen, e), true) };
    inPage(textScript('ok'), { KeyboardEvent: FakeKeyboardEvent, Event: FakeEvent, Object, document: { activeElement: null, body } });
    expect(seen.map((e) => e.type)).toEqual(['keydown', 'keypress', 'keyup', 'keydown', 'keypress', 'keyup']);
  });

  it('builds the events the old way where the constructor is missing', () => {
    const seen: string[] = [];
    const body = { dispatchEvent: (e: { type: string; key: string; keyCode: number }) => (seen.push(`${e.type} ${e.key} ${e.keyCode}`), true) };
    const made: Record<string, unknown>[] = [];
    const document = {
      activeElement: null,
      body,
      createEvent: (iface: string) => {
        const e: Record<string, unknown> = { iface };
        e.initEvent = (type: string, bubbles: boolean) => ((e.type = type), (e.bubbles = bubbles));
        made.push(e);
        return e;
      },
    };
    inPage(textScript('a'), { Object, document });
    expect(seen).toEqual(['keydown a 65', 'keypress a 97', 'keyup a 65']);
    expect(made.map((e) => e.iface)).toEqual(['KeyboardEvent', 'KeyboardEvent', 'KeyboardEvent']);
  });
});

describe('the focus and click scripts', () => {
  function page(found: Record<string, unknown> | null, throws = false) {
    const did: string[] = [];
    const el = found ? Object.assign(found, { focus: () => did.push('focus'), click: () => did.push('click') }) : null;
    const document = {
      querySelector: (q: string) => {
        if (throws) throw new Error('bad');
        did.push(`find ${q}`);
        return el;
      },
    };
    return { did, win: { Object, document } };
  }

  it('is ES5', () => {
    expect(targetScript('click', '.a > b')).not.toMatch(ES2015);
    expect(targetScript('focus', '[data-x="1"]')).not.toMatch(ES2015);
  });

  it('focuses the first match', () => {
    const { did, win } = page({});
    expect(inPage(targetScript('focus', '.tile'), win)).toBe('');
    expect(did).toEqual(['find .tile', 'focus']);
  });

  it('clicks the first match, focusing it first as a pointer would', () => {
    const { did, win } = page({});
    expect(inPage(targetScript('click', '#play'), win)).toBe('');
    expect(did).toEqual(['find #play', 'focus', 'click']);
  });

  it('clicks an element without click() through a mouse event', () => {
    const fired: string[] = [];
    const el = { focus: () => fired.push('focus'), dispatchEvent: (e: { type: string }) => (fired.push(e.type), true) };
    const document = {
      querySelector: () => el,
      createEvent: () => {
        const e: Record<string, unknown> = {};
        e.initMouseEvent = (type: string) => (e.type = type);
        e.initEvent = (type: string) => (e.type = type);
        return e;
      },
    };
    expect(inPage(targetScript('click', 'svg path'), { Object, document })).toBe('');
    expect(fired).toEqual(['focus', 'click']);
  });

  it('says what went wrong instead of throwing', () => {
    expect(inPage(targetScript('click', '.gone'), page(null).win)).toMatch(/nothing matches .gone/);
    expect(inPage(targetScript('focus', ':::'), page(null, true).win)).toMatch(/selector/);
  });
});

describe('running steps of every kind', () => {
  const steps: Step[] = [
    { key: 'right', repeat: 1, delayMs: 10 },
    { kind: 'text', text: 'hi', delayMs: 20 },
    { kind: 'wait', ms: 500 },
    { kind: 'focus', selector: '.a', delayMs: 0 },
    { kind: 'click', selector: '.b', delayMs: 5 },
  ];
  const fresh = (): RemoteRun => ({ steps, loop: false, phase: 'running', step: 0, press: 0, presses: 0, error: null });

  function fake(opts: { rejectWhat?: string } = {}) {
    const did: string[] = [];
    const slept: number[] = [];
    const updates: [number, number][] = [];
    const ctl = {
      press: async (p: { keyCode: number }) => void did.push(`press ${p.keyCode}`),
      evaluate: async (script: string, what: string) => {
        did.push(`eval ${what}`);
        if (what === opts.rejectWhat) throw new Error(`nothing matches .a`);
        expect(script).not.toMatch(ES2015);
      },
      sleep: async (ms: number) => void slept.push(ms),
      update: (r: RemoteRun) => void updates.push([r.step, r.press]),
      stopped: () => false,
    };
    return { ctl, did, slept, updates };
  }

  it('presses, types, waits, focuses and clicks in order, pausing after each as the step says', async () => {
    const f = fake();
    const r = await runRemote(f.ctl, fresh());
    expect(f.did).toEqual(['press 39', 'eval type "hi"', 'eval focus .a', 'eval click .b']);
    expect(f.slept).toEqual([10, 20, 500, 5]);
    expect(r).toMatchObject({ phase: 'done', presses: 5, error: null });
    expect(f.updates).toEqual([[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [4, 0]]);
  });

  it('stops at the step the page could not take, naming it', async () => {
    const f = fake({ rejectWhat: 'focus .a' });
    const r = await runRemote(f.ctl, fresh());
    expect(r).toMatchObject({ phase: 'failed', step: 3, presses: 3, error: 'nothing matches .a' });
  });
});
