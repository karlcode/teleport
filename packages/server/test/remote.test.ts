import { describe, expect, it } from 'vitest';
import { KEY, KEYS, parseSteps, pressFor, pressScript, presses, runRemote, type RemoteRun, type Step } from '../src/remote.js';

const ES2015 = /=>|\blet\b|\bconst\b|`|\.\.\./;

describe('the remote', () => {
  it('knows each key once, with the codes a device app reads', () => {
    const ids = KEYS.map((k) => k.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const k of KEYS) {
      expect(k.label.length).toBeGreaterThan(0);
      expect(k.press.keyCode).toBeGreaterThan(0);
      expect(KEY[k.id]).toBe(k);
    }
    expect(pressFor(KEY.right)).toEqual({ key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 });
    expect(pressFor(KEY['5']).keyCode).toBe(53);
  });

  it('reads a sequence from outside, dropping what it does not know and clamping the rest', () => {
    expect(parseSteps([{ key: 'right', repeat: 3, delayMs: 100 }, { key: 'warp' }, { key: 'ok', repeat: 999, delayMs: -4 }, 'junk'])).toEqual([
      { key: 'right', repeat: 3, delayMs: 100 },
      { key: 'ok', repeat: 50, delayMs: 0 },
    ]);
    expect(parseSteps('right,right,down,ok')).toEqual([
      { key: 'right', repeat: 1, delayMs: 350 },
      { key: 'right', repeat: 1, delayMs: 350 },
      { key: 'down', repeat: 1, delayMs: 350 },
      { key: 'ok', repeat: 1, delayMs: 350 },
    ]);
    expect(parseSteps(null)).toEqual([]);
    expect(parseSteps(new Array(500).fill({ key: 'up' }))).toHaveLength(100);
    expect(presses([{ key: 'up', repeat: 3, delayMs: 0 }, { key: 'ok', repeat: 2, delayMs: 0 }])).toBe(5);
  });
});

describe('the press script', () => {
  it('is ES5', () => {
    expect(pressScript(pressFor(KEY.ok))).not.toMatch(ES2015);
  });

  it('dispatches keydown then keyup on the focused element, with keyCode set even when the engine ignores it', () => {
    const seen: { type: string; key: string; code: string; keyCode: number; which: number; bubbles: boolean }[] = [];
    // Older Chromium: the constructor exists but drops keyCode and key from the init dictionary.
    class KeyboardEvent {
      type: string;
      bubbles: boolean;
      key = '';
      code = '';
      keyCode = 0;
      which = 0;
      constructor(type: string, init: { bubbles?: boolean }) {
        this.type = type;
        this.bubbles = !!init.bubbles;
      }
    }
    const el = { dispatchEvent: (e: KeyboardEvent) => (seen.push({ type: e.type, key: e.key, code: e.code, keyCode: e.keyCode, which: e.which, bubbles: e.bubbles }), true) };
    const win = { KeyboardEvent, Object, document: { activeElement: el, body: {} } };
    new Function('window', 'document', `with (window) { ${pressScript({ key: 'BrowserBack', code: 'BrowserBack', keyCode: 166 })} }`)(win, win.document);
    expect(seen).toEqual([
      { type: 'keydown', key: 'BrowserBack', code: 'BrowserBack', keyCode: 166, which: 166, bubbles: true },
      { type: 'keyup', key: 'BrowserBack', code: 'BrowserBack', keyCode: 166, which: 166, bubbles: true },
    ]);
  });

  it('falls back to body when nothing has focus', () => {
    const on: string[] = [];
    class KeyboardEvent {
      constructor(public type: string) {}
    }
    const win = { KeyboardEvent, Object, document: { activeElement: null, body: { dispatchEvent: () => (on.push('body'), true) } } };
    new Function('window', 'document', `with (window) { ${pressScript(pressFor(KEY.up))} }`)(win, win.document);
    expect(on).toEqual(['body', 'body']);
  });
});

describe('what an OK press does', () => {
  /** A page with one focused element, recording what reaches it; `cancel` makes the page cancel this event type. */
  function page(tag: string, attrs: Record<string, string> = {}, cancel = '') {
    const seen: string[] = [];
    class KeyboardEvent {
      key = '';
      keyCode = 0;
      charCode = 0;
      defaultPrevented = false;
      constructor(public type: string) {}
    }
    const el = {
      tagName: tag,
      ...attrs,
      dispatchEvent: (e: KeyboardEvent & { __tlpt?: number }) => {
        seen.push(`${e.type} ${e.keyCode}${e.charCode ? `/${e.charCode}` : ''}${e.__tlpt ? ' marked' : ''}`);
        return e.type !== cancel;
      },
      click: () => seen.push('click'),
    };
    const win = { KeyboardEvent, Object, document: { activeElement: el, body: {} } };
    return { seen, run: (script: string) => new Function('window', 'document', `with (window) { ${script} }`)(win, win.document) };
  }

  it('is ES5', () => {
    expect(pressScript(pressFor(KEY.ok), true)).not.toMatch(ES2015);
  });

  it('does what a real Enter does by default: a keypress, then a click on a focused button or link', () => {
    for (const [tag, attrs] of [['BUTTON', {}], ['A', { href: '#x' }], ['INPUT', { type: 'submit' }], ['SUMMARY', {}]] as const) {
      const p = page(tag, attrs);
      p.run(pressScript(pressFor(KEY.ok), true));
      expect(p.seen, tag).toEqual(['keydown 13 marked', 'keypress 13/13 marked', 'click', 'keyup 13 marked']);
    }
  });

  it('clicks nothing the page cancelled, nothing that is not a button or link, and nothing for another key', () => {
    const cancelled = page('BUTTON', {}, 'keydown');
    cancelled.run(pressScript(pressFor(KEY.ok), true));
    expect(cancelled.seen).toEqual(['keydown 13 marked', 'keyup 13 marked']);
    const tile = page('DIV');
    tile.run(pressScript(pressFor(KEY.ok), true));
    expect(tile.seen).toEqual(['keydown 13 marked', 'keypress 13/13 marked', 'keyup 13 marked']);
    const right = page('BUTTON');
    right.run(pressScript(pressFor(KEY.right), false));
    expect(right.seen).toEqual(['keydown 39 marked', 'keyup 39 marked']);
  });

  it("sends what the device's own remote was heard sending, in place of the usual key", () => {
    const learned = { ok: { key: 'GamepadA', code: 'GamepadA', keyCode: 195 } };
    expect(pressFor(KEY.ok, learned)).toEqual({ key: 'GamepadA', code: 'GamepadA', keyCode: 195 });
    expect(pressFor(KEY.back, learned)).toEqual({ key: 'Escape', code: 'Escape', keyCode: 27 });
  });
});

describe('running a sequence', () => {
  const steps: Step[] = [
    { key: 'right', repeat: 2, delayMs: 10 },
    { key: 'ok', repeat: 1, delayMs: 5 },
  ];
  const fresh = (loop = false): RemoteRun => ({ steps, loop, phase: 'running', step: 0, press: 0, presses: 0, error: null });

  function fake(opts: { failAt?: number; stopAfter?: number } = {}) {
    const pressed: string[] = [];
    const slept: number[] = [];
    const updates: RemoteRun[] = [];
    let stopped = false;
    const ctl = {
      press: async (p: { keyCode: number }) => {
        pressed.push(String(p.keyCode));
        if (opts.failAt !== undefined && pressed.length === opts.failAt) throw new Error('no answer from the device');
        if (opts.stopAfter !== undefined && pressed.length === opts.stopAfter) stopped = true;
      },
      sleep: async (ms: number) => void slept.push(ms),
      update: (r: RemoteRun) => void updates.push({ ...r }),
      stopped: () => stopped,
    };
    return { ctl, pressed, slept, updates };
  }

  it('presses each step its repeat count, waits after every press, and lights the step as it goes', async () => {
    const f = fake();
    const r = await runRemote(f.ctl, fresh());
    expect(f.pressed).toEqual(['39', '39', '13']);
    expect(f.slept).toEqual([10, 10, 5]);
    expect(r).toMatchObject({ phase: 'done', presses: 3 });
    expect(f.updates.map((u) => [u.step, u.press])).toEqual([[0, 0], [0, 1], [1, 0], [1, 0]]);
  });

  it('loops until stopped', async () => {
    const f = fake({ stopAfter: 7 });
    const r = await runRemote(f.ctl, fresh(true));
    expect(f.pressed).toHaveLength(7);
    expect(r.phase).toBe('stopped');
  });

  it('stops at the first press the device cannot take', async () => {
    const f = fake({ failAt: 2 });
    const r = await runRemote(f.ctl, fresh());
    expect(r).toMatchObject({ phase: 'failed', error: 'no answer from the device', presses: 1 });
  });
});
