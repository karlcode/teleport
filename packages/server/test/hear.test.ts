import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { crewFrames, CREW, SCENE_H, SCENE_W } from '../src/aliens.js';
import { errorLine, hintFor, ownCode, type PageError } from '../src/errors.js';
import { familyOf, HEAR_SCRIPT, KeyMemory, meaning, parseHeard, pressFrom, type Heard } from '../src/hear.js';
import { KEY, pressFor } from '../src/remote.js';

const ES2015 = /=>|\blet\b|\bconst\b|`|\.\.\./;
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; WebView/3.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0';

describe('naming a key', () => {
  it('knows the codes devices send for the same button', () => {
    expect(meaning('Enter', 13)).toEqual({ id: 'ok', name: 'Enter' });
    expect(meaning('GamepadA', 195)).toEqual({ id: 'ok', name: 'gamepad A' });
    expect(meaning(null, 195)).toEqual({ id: 'ok', name: 'gamepad A' });
    expect(meaning('XF86Back', 0)).toEqual({ id: 'back', name: 'back' });
    expect(meaning(null, 166)).toEqual({ id: 'back', name: 'browser back' });
    expect(meaning('GamepadDPadLeft', 205)).toEqual({ id: 'left', name: 'd-pad left' });
    expect(meaning(null, 101)).toEqual({ id: '5', name: 'keypad 5' });
    expect(meaning('q', 81)).toEqual({ id: null, name: 'q' });
    expect(meaning('Unidentified', 4321)).toEqual({ id: null, name: 'key 4321' });
  });
});

describe('the reader in the page', () => {
  it('is ES5', () => {
    expect(HEAR_SCRIPT).not.toMatch(ES2015);
  });

  it("checks what the page says it heard, dropping what isn't a press", () => {
    const raw = JSON.stringify([
      { kind: 'key', key: 'GamepadA', code: '', keyCode: 195, sent: false, at: 'button#play', t: 1000, took: false, clicked: true, changed: true },
      { kind: 'key', key: 'Enter', code: 'Enter', keyCode: 13, sent: true, at: 'body', to: 'div.tile', t: 1200, took: true },
      { kind: 'button', keyCode: 0, mapping: 'standard', at: 'body', t: 1300 },
      { kind: 'key', keyCode: -1 },
      { kind: 'mouse', keyCode: 1 },
      'junk',
    ]);
    const heard = parseHeard(raw);
    expect(heard.map((h) => [h.from, h.what.name, h.what.id, h.took, h.clicked, h.changed, h.to])).toEqual([
      ['device', 'gamepad A', 'ok', false, true, true, null],
      ['teleport', 'Enter', 'ok', true, false, false, 'div.tile'],
      ['device', 'button A', 'ok', false, false, false, null],
    ]);
    expect(parseHeard('not json')).toEqual([]);
    expect(parseHeard({})).toEqual([]);
  });
});

describe('the keys a device was heard sending', () => {
  const heard = (o: Partial<Heard>): Heard => ({ kind: 'key', key: 'GamepadA', code: 'GamepadA', keyCode: 195, from: 'device', took: false, clicked: false, changed: false, at: '', to: null, t: 0, what: meaning(o.key ?? 'GamepadA', o.keyCode ?? 195), ...o });

  it("learns a device's own key that differs from what the remote sends, keeps it for its kind of device, and forgets it", () => {
    const file = join(mkdtempSync(join(tmpdir(), 'tlpt-keys-')), 'keys.json');
    const mem = new KeyMemory(file);
    const usual = (id: keyof typeof KEY) => pressFor(KEY[id]);
    // Teleport's own presses, and a device's Enter, which is what the remote sends anyway, teach nothing.
    expect(mem.learn(WINDOWS, [heard({ from: 'teleport' }), heard({ key: 'Enter', code: 'Enter', keyCode: 13 })], usual)).toEqual([]);
    expect(mem.learn(WINDOWS, [heard({})], usual)).toEqual([{ id: 'ok', press: { key: 'GamepadA', code: 'GamepadA', keyCode: 195 }, name: 'gamepad A' }]);
    expect(mem.learn(WINDOWS, [heard({})], usual)).toEqual([]);
    expect(mem.of(WINDOWS)).toEqual({ ok: { key: 'GamepadA', code: 'GamepadA', keyCode: 195 } });
    expect(familyOf(WINDOWS)).toBe('Windows');
    // Kept for next time, and read back as it was written.
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ Windows: { ok: { key: 'GamepadA', code: 'GamepadA', keyCode: 195 } } });
    expect(new KeyMemory(file).of(WINDOWS).ok?.keyCode).toBe(195);
    mem.forget(WINDOWS);
    expect(new KeyMemory(file).of(WINDOWS)).toEqual({});
  });

  it("ignores a file that isn't one of its own", () => {
    const dir = mkdtempSync(join(tmpdir(), 'tlpt-keys-'));
    expect(new KeyMemory(join(dir, 'missing.json')).of(WINDOWS)).toEqual({});
    expect(new KeyMemory(null).of(WINDOWS)).toEqual({});
  });
});

describe('the crew in the clips', () => {
  it('draws the same frames every time, each different from the last, at the scene size', () => {
    const a = crewFrames(4, 25, 'hevc 2160');
    expect(a.length).toBe(4 * SCENE_W * SCENE_H * 3);
    expect(crewFrames(4, 25, 'hevc 2160').equals(a)).toBe(true);
    const frame = (i: number) => a.subarray(i * SCENE_W * SCENE_H * 3, (i + 1) * SCENE_W * SCENE_H * 3);
    for (let i = 1; i < 4; i++) expect(frame(i).equals(frame(i - 1))).toBe(false);
    // Each alien's two frames are the same size, a step.
    for (const c of CREW) expect(new Set(c.frames.flatMap((f) => f.map((r) => r.length))).size).toBe(1);
  });
});

describe('mapping a key by hand', () => {
  it('reads a key code or a key name it knows, and keeps what was set for the kind of device', () => {
    expect(pressFrom('195')).toEqual({ key: 'GamepadA', code: '', keyCode: 195 });
    expect(pressFrom('gamepada')).toEqual({ key: 'GamepadA', code: '', keyCode: 195 });
    expect(pressFrom('13')).toEqual({ key: 'Enter', code: 'Enter', keyCode: 13 });
    expect(pressFrom('4321')).toEqual({ key: '', code: '', keyCode: 4321 });
    expect(pressFrom('0')).toBeNull();
    expect(pressFrom('banana')).toBeNull();
    const mem = new KeyMemory(null);
    mem.set(WINDOWS, 'ok', pressFrom('195'));
    expect(pressFor(KEY.ok, mem.of(WINDOWS)).keyCode).toBe(195);
    mem.set(WINDOWS, 'ok', null);
    expect(pressFor(KEY.ok, mem.of(WINDOWS)).keyCode).toBe(13);
  });
});

describe("teleport's own errors", () => {
  const err = (o: Partial<PageError>): PageError => ({ n: 0, atMs: 10, kind: 'error', text: 'Uncaught TypeError: x is not a function', src: 'http://device/app.js', line: 1, col: 2, stack: '', hint: null, near: null, from: null, ...o });
  it("names an error in teleport's code as teleport's, and the app's as the app's", () => {
    expect(ownCode(err({ src: 'http://192.168.1.20:7070/teleport.js' }))).toBe(true);
    expect(ownCode(err({ src: 'http://device/app.js', from: { src: 'webpack://app/node_modules/@tlpt/agent/dist/agent.cjs', line: 3, col: 1 } }))).toBe(true);
    expect(ownCode(err({ stack: 'TypeError\n    at s (https://device.example/__teleport/inspector.js:1:200)' }))).toBe(true);
    // A trial's frame runs the trial's own code: its errors are the trial's.
    expect(ownCode(err({ src: 'http://device:7070/__teleport/trial/abc/run.js' }))).toBe(false);
    expect(ownCode(err({}))).toBe(false);
    expect(errorLine(err({ src: 'http://192.168.1.20:7070/teleport.js' }))).toBe("TypeError: x is not a function · teleport.js:1:2 · in teleport's own code");
    expect(hintFor(err({ src: 'http://192.168.1.20:7070/teleport.js' }), [], 'Linux · Chrome 53')).toMatch(/^This is teleport's code, not your app's/);
  });
});
