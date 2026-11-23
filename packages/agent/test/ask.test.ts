// The agent answers the laptop's questions itself: `eval <id> <0|1> <source>` in, one line out. It
// runs the laptop's code in someone else's page, so whatever that code does or throws must come back
// as an answer and never as something thrown into the app.
import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
type Ask = { ask(arg: string, send: (line: string) => void): void; again(send: (line: string) => void): void };
// A new agent for each test: it keeps its last answers, by the question's id.
let mod: Ask;
const ask: Ask['ask'] = (arg, send) => mod.ask(arg, send);
beforeEach(() => {
  const path = require.resolve('../src/ask.js');
  delete require.cache[path];
  mod = require(path) as Ask;
});

function asked(arg: string) {
  const lines: string[] = [];
  expect(() => ask(arg, (l) => lines.push(l))).not.toThrow();
  return lines;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("the agent's answer to a question", () => {
  it('is the value as JSON, and nothing where JSON has none', () => {
    expect(asked('a 0 1+1')).toEqual(['val a 2']);
    expect(asked('b 0 "tile"')).toEqual(['val b "tile"']);
    expect(asked('c 0 ({ n: [1, { x: null }], s: "é\\n\\u2028" })')).toEqual(['val c {"n":[1,{"x":null}],"s":"é\\n "}']);
    expect(asked('d 0 null')).toEqual(['val d null']);
    expect(asked('e 0 false')).toEqual(['val e false']);
    for (const none of ['undefined', 'NaN', 'Infinity', '-Infinity', '-0', '(function () {})', 'var o = {}; o.o = o; o', 'Symbol("s")']) expect(asked(`f${none.length} 0 ${none}`), none).toEqual([`val f${none.length} `]);
    // One line whatever the value holds, so the laptop can tell answers apart.
    for (const l of asked('g 0 "a\\nb\\rc"')) expect(l).not.toMatch(/[\n\r]/);
  });

  it('runs in the global scope, where a var stays for the next question', () => {
    asked('a 0 var __askTestKept = 41');
    expect(asked('b 0 __askTestKept + 1')).toEqual(['val b 42']);
    delete (globalThis as Record<string, unknown>).__askTestKept;
    // Not in the agent's own scope: its variables can't be read or changed.
    expect(asked('c 0 typeof send + typeof caught + typeof globalEval')).toEqual(['val c "undefinedundefinedundefined"']);
  });

  it('answers what the code threw with its first line, whatever was thrown', () => {
    expect(asked('a 0 nope.nope')).toEqual(['thr a ReferenceError: nope is not defined']);
    expect(asked('b 0 throw new TypeError("two\\nlines")')).toEqual(['thr b TypeError: two']);
    expect(asked('c 0 throw "a string"')).toEqual(['thr c ']);
    expect(asked('d 0 throw null')).toEqual(['thr d ']);
    expect(asked('e 0 throw { get stack() { throw 1 } }')).toEqual(['thr e ']);
    expect(asked('f 0 this is not script')).toEqual([expect.stringMatching(/^thr f SyntaxError: /)]);
  });

  it('waits for a promise only when asked to, and answers its rejection', async () => {
    const lines: string[] = [];
    const send = (l: string) => lines.push(l);
    ask('a 1 Promise.resolve({ ok: 1 })', send);
    ask('b 1 Promise.reject(new RangeError("late"))', send);
    ask('c 1 new Promise(function (r) { setTimeout(function () { r(7) }, 1) })', send);
    ask('d 1 5', send);
    expect(lines).toEqual(['val d 5']);
    await tick();
    await new Promise((r) => setTimeout(r, 5));
    expect(lines.sort()).toEqual(['thr b RangeError: late', 'val a {"ok":1}', 'val c 7', 'val d 5']);
    // Not asked to wait: a promise has no JSON of its own but {}.
    expect(asked('e 0 Promise.resolve(1)')).toEqual(['val e {}']);
  });

  it('never throws, whatever it is sent or handed back', async () => {
    for (const arg of ['', ' ', 'x', 'x ', 'x1 1', 'x2 1 ', '  ', 'x3 9 1', 'x4 1 ({ get then() { throw 1 } })', 'x5 1 ({ then: function () { throw new Error("no") } })']) asked(arg);
    expect(asked('a 1 ({ then: function () { throw new Error("no") } })')).toEqual(['thr a Error: no']);
    expect(asked('b 1 ({ get then() { throw 1 } })')).toEqual(['val b ']);
    expect(asked('')).toEqual([]);
    // A send that fails (the socket closed meanwhile) inside a promise's callback stays inside.
    const unhandled: unknown[] = [];
    const on = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', on);
    ask('c 1 Promise.resolve(1)', () => {
      throw new Error('socket closed');
    });
    await tick();
    await tick();
    process.off('unhandledRejection', on);
    expect(unhandled).toEqual([]);
  });

  it('runs a question once, however often it is asked, and answers again from what it kept', async () => {
    (globalThis as Record<string, unknown>).__askRuns = 0;
    expect(asked('a 0 ++__askRuns')).toEqual(['val a 1']);
    // The laptop never heard: it asks again on the new link. Not run again.
    expect(asked('a 0 ++__askRuns')).toEqual(['val a 1']);
    expect(asked('b 0 ++__askRuns')).toEqual(['val b 2']);
    // A promise still out: asked again, nothing yet, then its one answer.
    const lines: string[] = [];
    ask('c 1 new Promise(function (r) { setTimeout(function () { r(++__askRuns) }, 2) })', (l) => lines.push(l));
    ask('c 1 new Promise(function (r) { setTimeout(function () { r(++__askRuns) }, 2) })', (l) => lines.push(l));
    expect(lines).toEqual([]);
    await new Promise((r) => setTimeout(r, 10));
    expect(lines).toEqual(['val c 3']);
    // The link comes back: every kept answer goes again, in order, and the laptop takes each once.
    const again: string[] = [];
    mod.again((l) => again.push(l));
    expect(again).toEqual(['val a 1', 'val b 2', 'val c 3']);
    delete (globalThis as Record<string, unknown>).__askRuns;
  });

  it('keeps only the last few answers, and never one too long to hold', () => {
    for (let i = 0; i < 12; i++) asked(`q${i} 0 ${i}`);
    const kept: string[] = [];
    mod.again((l) => kept.push(l));
    expect(kept).toEqual([4, 5, 6, 7, 8, 9, 10, 11].map((i) => `val q${i} ${i}`));
    // Forgotten, so it would run again: the laptop only asks twice within one page's short wait.
    expect(asked('q0 0 "ran again"')).toEqual(['val q0 "ran again"']);
    // An answer too long to keep is sent whole, once; asked again, the laptop is told it was lost.
    const long = asked('big 0 new Array(70001).join("x")');
    expect(long[0]!.length).toBeGreaterThan(70000);
    expect(asked('big 0 new Array(70001).join("x")')).toEqual(['thr big the answer was lost with the link, and was too long to keep']);
    // Many answers that fit one by one stay under the limit together.
    for (let i = 0; i < 8; i++) asked(`m${i} 0 new Array(20001).join("y")`);
    const total: string[] = [];
    mod.again((l) => total.push(l));
    expect(total.reduce((n, l) => n + l.length, 0)).toBeLessThanOrEqual(65536 + 100);
    expect(total.length).toBeGreaterThanOrEqual(3);
  });
});

