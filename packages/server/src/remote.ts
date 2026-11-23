// The remote: a sequence of steps done on the device from the laptop. A step presses a key, types
// text into the focused element, waits, or focuses or clicks an element by selector. Each is ES5
// dispatched on the page through the inspector's eval, with key, code, keyCode and which all set:
// older Chromium ignores keyCode in the init dictionary, so it is defined on the event afterwards.
// A sent event is not trusted, so the browser does nothing of its own with it: an OK press does what
// a real Enter does by default (keypress, then a click on a focused button or link), unless the page
// cancelled it. Where a real press on the device was heard (hear.ts), its key is sent in place of the
// usual one. The sequence runs on the laptop, one action at a time, so it can be stopped, or the
// caller can lose its connection, without the device noticing.

/** What one key press carries. */
export interface Press {
  key: string;
  code: string;
  keyCode: number;
}

export type KeyId = 'up' | 'down' | 'left' | 'right' | 'ok' | 'back' | '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'red' | 'green' | 'yellow' | 'blue' | 'play' | 'pause' | 'stop' | 'rewind' | 'forward';

export interface Key {
  id: KeyId;
  label: string;
  press: Press;
}

const digit = (n: number): Key => ({ id: String(n) as KeyId, label: String(n), press: { key: String(n), code: `Digit${n}`, keyCode: 48 + n } });

export const KEYS: readonly Key[] = [
  { id: 'up', label: '↑', press: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 } },
  { id: 'down', label: '↓', press: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 } },
  { id: 'left', label: '←', press: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 } },
  { id: 'right', label: '→', press: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 } },
  { id: 'ok', label: 'ok', press: { key: 'Enter', code: 'Enter', keyCode: 13 } },
  { id: 'back', label: 'back', press: { key: 'Escape', code: 'Escape', keyCode: 27 } },
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map(digit),
  { id: 'red', label: 'red', press: { key: 'ColorF0Red', code: 'ColorF0Red', keyCode: 403 } },
  { id: 'green', label: 'green', press: { key: 'ColorF1Green', code: 'ColorF1Green', keyCode: 404 } },
  { id: 'yellow', label: 'yellow', press: { key: 'ColorF2Yellow', code: 'ColorF2Yellow', keyCode: 405 } },
  { id: 'blue', label: 'blue', press: { key: 'ColorF3Blue', code: 'ColorF3Blue', keyCode: 406 } },
  { id: 'play', label: 'play', press: { key: 'MediaPlay', code: 'MediaPlay', keyCode: 415 } },
  { id: 'pause', label: 'pause', press: { key: 'MediaPause', code: 'MediaPause', keyCode: 19 } },
  { id: 'stop', label: 'stop', press: { key: 'MediaStop', code: 'MediaStop', keyCode: 413 } },
  { id: 'rewind', label: 'rew', press: { key: 'MediaRewind', code: 'MediaRewind', keyCode: 412 } },
  { id: 'forward', label: 'ff', press: { key: 'MediaFastForward', code: 'MediaFastForward', keyCode: 417 } },
];

export const KEY = Object.fromEntries(KEYS.map((k) => [k.id, k])) as Record<KeyId, Key>;

/** Between actions, unless a step says otherwise: a focus move on a device app takes about this long to settle. */
export const DEFAULT_DELAY_MS = 350;
export const MAX_REPEAT = 50;
export const MAX_DELAY_MS = 10_000;
export const MAX_STEPS = 100;
export const MAX_TEXT = 200;
export const MAX_SELECTOR = 200;

export type Kind = 'key' | 'text' | 'wait' | 'focus' | 'click';

/** A key step has no `kind`: it is the original shape, and the one a plain "right,right,ok" list makes. */
export interface KeyStep {
  kind?: undefined;
  key: KeyId;
  repeat: number;
  /** After each press of this step. */
  delayMs: number;
}
/** Typed into the focused element, one character at a time, as a keyboard would. */
export interface TextStep {
  kind: 'text';
  text: string;
  delayMs: number;
}
export interface WaitStep {
  kind: 'wait';
  ms: number;
}
/** The first element the selector matches is focused, or focused and clicked. */
export interface TargetStep {
  kind: 'focus' | 'click';
  selector: string;
  delayMs: number;
}
export type Step = KeyStep | TextStep | WaitStep | TargetStep;

export const kindOf = (s: Step): Kind => s.kind ?? 'key';

export interface RemoteRun {
  steps: Step[];
  loop: boolean;
  phase: 'running' | 'done' | 'stopped' | 'failed';
  /** The step and the action within it being done now (or done last). */
  step: number;
  press: number;
  /** Actions done so far: a press, a typed text, a wait, a focus or a click each count one. */
  presses: number;
  error: string | null;
}

/** The keys a device's own remote was heard to send (hear.ts), by key id. */
export type Learned = Partial<Record<KeyId, Press>>;

/** What a key sends: what the device's own remote was heard sending, else the common one. */
export const pressFor = (k: Key, learned?: Learned): Press => learned?.[k.id] ?? k.press;

const clamp = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};
const delay = (v: unknown) => clamp(v, 0, MAX_DELAY_MS, DEFAULT_DELAY_MS);
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

/** What the runner does for one action of a step. `ok` presses do what a real Enter does by default. */
export type Action = { do: 'press'; press: Press; ok: boolean } | { do: 'eval'; script: string; what: string } | { do: 'sleep'; ms: number };

/** How a kind of step is read from outside, counted, done, and paused after. */
export interface StepKind<S extends Step> {
  parse(o: Record<string, unknown>): S | null;
  /** Actions in the step: a key step is pressed `repeat` times, the rest once. */
  count(s: S): number;
  action(s: S, learned?: Learned): Action;
  /** The pause after each action. */
  after(s: S): number;
}

interface StepByKind {
  key: KeyStep;
  text: TextStep;
  wait: WaitStep;
  focus: TargetStep;
  click: TargetStep;
}

const target = (kind: 'focus' | 'click'): StepKind<TargetStep> => ({
  parse(o) {
    const selector = text(o.selector, MAX_SELECTOR).trim();
    return selector ? { kind, selector, delayMs: delay(o.delayMs) } : null;
  },
  count: () => 1,
  action: (s) => ({ do: 'eval', script: targetScript(s.kind, s.selector), what: `${s.kind} ${s.selector}` }),
  after: (s) => s.delayMs,
});

export const KINDS: { [K in Kind]: StepKind<StepByKind[K]> } = {
  key: {
    parse: (o) => (typeof o.key === 'string' && o.key in KEY ? { key: o.key as KeyId, repeat: clamp(o.repeat, 1, MAX_REPEAT, 1), delayMs: delay(o.delayMs) } : null),
    count: (s) => s.repeat,
    action: (s, learned) => ({ do: 'press', press: pressFor(KEY[s.key], learned), ok: s.key === 'ok' }),
    after: (s) => s.delayMs,
  },
  text: {
    parse(o) {
      const t = text(o.text, MAX_TEXT);
      return t ? { kind: 'text', text: t, delayMs: delay(o.delayMs) } : null;
    },
    count: () => 1,
    action: (s) => ({ do: 'eval', script: textScript(s.text), what: `type ${JSON.stringify(s.text)}` }),
    after: (s) => s.delayMs,
  },
  wait: {
    parse: (o) => ({ kind: 'wait', ms: delay(o.ms) }),
    count: () => 1,
    action: (s) => ({ do: 'sleep', ms: s.ms }),
    after: () => 0,
  },
  focus: target('focus'),
  click: target('click'),
};

/** The one place a step meets its kind's table: the kinds are keyed by the step's discriminant. */
const of = (s: Step) => KINDS[kindOf(s)] as StepKind<Step>;

/** Steps from outside: a list of steps as JSON, or "right,right,down,ok". Unknown kinds and keys are dropped. */
export function parseSteps(input: unknown): Step[] {
  const raw: unknown[] = typeof input === 'string' ? input.split(',').map((k) => ({ key: k.trim() })) : Array.isArray(input) ? input : [];
  const out: Step[] = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue;
    const o = s as Record<string, unknown>;
    const kind = o.kind === undefined ? 'key' : o.kind;
    if (typeof kind !== 'string' || !(kind in KINDS)) continue;
    const step = KINDS[kind as Kind].parse(o);
    if (step) out.push(step);
    if (out.length === MAX_STEPS) break;
  }
  return out;
}

/** How many actions a sequence is. */
export const presses = (steps: Step[]) => steps.reduce((n, s) => n + of(s).count(s), 0);

/** JSON is valid JavaScript only once U+2028 and U+2029 are escaped; older engines reject them raw. */
const js = (v: unknown) => JSON.stringify(v).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/**
 * ES5 for a keyboard event of `type` on the page, bubbling and cancelable, with key, code, keyCode,
 * charCode and which set. Where the engine's constructor or init dictionary drops a field, it is
 * defined on the event itself.
 */
const MAKE =
  "function make(type,k,c,n,ch){var e;try{e=new KeyboardEvent(type,{key:k,code:c,bubbles:true,cancelable:true});}catch(x){e=document.createEvent('KeyboardEvent');if(e.initKeyboardEvent){e.initKeyboardEvent(type,true,true,window,k,0,'',false,'');}else{e.initEvent(type,true,true);}}var ps={key:k,code:c,keyCode:n,charCode:ch,which:ch||n};for(var q in ps){if(e[q]!==ps[q]){try{Object.defineProperty(e,q,{get:(function(v){return function(){return v;};})(ps[q])});}catch(y){}}}try{e.__tlpt=1;}catch(z){}return e;}";

/**
 * ES5: what a real Enter does by default on the focused element, which a sent one never does by
 * itself: a button, a link, a summary or a submit is clicked. Anything else is left to the page.
 */
const ACTIVATE =
  "function act(el){var tag=(el.tagName||'').toUpperCase(),ty=String(el.type||'').toLowerCase();if(tag==='BUTTON'||tag==='SUMMARY'||((tag==='A'||tag==='AREA')&&el.href)||(tag==='INPUT'&&/^(button|submit|reset|image)$/.test(ty))){if(el.click){el.click();}return 1;}return 0;}";

/**
 * ES5 that presses one key in the page, from the focused element (the body when nothing has focus):
 * keydown, keypress for Enter and a printable key, then keyup. With `ok`, a press the page didn't
 * cancel then does what a real Enter does by default (ACTIVATE). Every event it sends is marked
 * `__tlpt`, so the key reader (hear.ts) tells them from the device's own.
 */
export function pressScript(p: Press, ok = false): string {
  const ch = p.keyCode === 13 || p.key === 'Enter' ? 13 : p.key.length === 1 ? p.key.charCodeAt(0) : 0;
  return (
    `(function(){var k=${js(p.key)},c=${js(p.code)},n=${p.keyCode},ch=${ch};var t=document.activeElement||document.body;${MAKE}${ok ? ACTIVATE : ''}` +
    `var go=t.dispatchEvent(make('keydown',k,c,n,0));if(go&&ch){go=t.dispatchEvent(make('keypress',k,c,ch,ch));}${ok ? 'if(go){act(t);}' : ''}t.dispatchEvent(make('keyup',k,c,n,0));return '';})()`
  );
}

/**
 * ES5 that types `text` into the focused element as a keyboard would: per character keydown,
 * keypress, the character into the value at the caret, an input event, then keyup. A keydown or
 * keypress the app cancels types nothing. The value is set through the element's prototype, past
 * any accessor the app put on the element (React's value tracker), so the app sees the input event
 * as a change. Where nothing editable has focus the keys still go to the page.
 */
export function textScript(text: string): string {
  return (
    `(function(){var s=${js(text)};var t=document.activeElement||document.body;${MAKE}` +
    "function put(el,v){var tag=(el.tagName||'').toUpperCase();if(tag==='INPUT'||tag==='TEXTAREA'){var old=el.value||'',a=el.selectionStart,b=el.selectionEnd,at=typeof a==='number'&&typeof b==='number';var val=at?old.slice(0,a)+v+old.slice(b):old+v;var proto=window[tag==='INPUT'?'HTMLInputElement':'HTMLTextAreaElement'],d=proto&&Object.getOwnPropertyDescriptor?Object.getOwnPropertyDescriptor(proto.prototype,'value'):null;if(d&&d.set){d.set.call(el,val);}else{el.value=val;}if(at&&el.setSelectionRange){try{el.setSelectionRange(a+v.length,a+v.length);}catch(z){}}return true;}if(el.isContentEditable){el.textContent+=v;return true;}return false;}" +
    "function input(){var e;try{e=new Event('input',{bubbles:true});}catch(x){e=document.createEvent('Event');e.initEvent('input',true,false);}t.dispatchEvent(e);}" +
    "for(var i=0;i<s.length;i++){var ch=s.charAt(i),u=ch.toUpperCase(),n=/^[A-Z0-9]$/.test(u)?u.charCodeAt(0):ch===' '?32:0,c=/^[A-Z]$/.test(u)?'Key'+u:/^[0-9]$/.test(u)?'Digit'+u:ch===' '?'Space':'',cc=ch.charCodeAt(0);if(t.dispatchEvent(make('keydown',ch,c,n,0))&&t.dispatchEvent(make('keypress',ch,c,cc,cc))&&put(t,ch)){input();}t.dispatchEvent(make('keyup',ch,c,n,0));}return '';})()"
  );
}

/**
 * ES5 that focuses the first element `selector` matches, and clicks it too for a click step (a
 * pointer focuses what it clicks). Returns '' when done, else what went wrong.
 */
export function targetScript(kind: 'focus' | 'click', selector: string): string {
  const click = kind === 'click' ? "if(el.click){el.click();}else{var e=document.createEvent('MouseEvents');if(e.initMouseEvent){e.initMouseEvent('click',true,true,window,1,0,0,0,0,false,false,false,false,0,null);}else{e.initEvent('click',true,true);}el.dispatchEvent(e);}" : '';
  return `(function(){var q=${js(selector)},el;try{el=document.querySelector(q);}catch(x){return 'not a selector: '+q;}if(!el){return 'nothing matches '+q;}if(el.focus){el.focus();}${click}return '';})()`;
}

export interface RemoteControl {
  /** Resolves once the device has dispatched the press; `ok` does what a real Enter does by default. */
  press(p: Press, ok: boolean): Promise<void>;
  /** Runs a step's script in the page; rejects with what went wrong. */
  evaluate(script: string, what: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  /** Called before every action and when the run ends. */
  update(run: RemoteRun): void;
  stopped(): boolean;
}

/** Does the steps in order, each its count of actions, and again while `loop`, until stopped or an action fails. */
export async function runRemote(ctl: RemoteControl, run: RemoteRun, learned?: Learned): Promise<RemoteRun> {
  try {
    do {
      for (let i = 0; i < run.steps.length; i++) {
        const step = run.steps[i]!;
        const kind = of(step);
        const n = kind.count(step);
        for (let j = 0; j < n; j++) {
          run.step = i;
          run.press = j;
          ctl.update(run);
          const a = kind.action(step, learned);
          if (a.do === 'press') await ctl.press(a.press, a.ok);
          else if (a.do === 'eval') await ctl.evaluate(a.script, a.what);
          else await ctl.sleep(a.ms);
          run.presses++;
          if (ctl.stopped()) {
            run.phase = 'stopped';
            ctl.update(run);
            return run;
          }
          const after = kind.after(step);
          if (after) await ctl.sleep(after);
        }
      }
    } while (run.loop && run.steps.length && !ctl.stopped());
    run.phase = ctl.stopped() ? 'stopped' : 'done';
  } catch (e) {
    run.phase = 'failed';
    run.error = (e as Error).message;
  }
  ctl.update(run);
  return run;
}
