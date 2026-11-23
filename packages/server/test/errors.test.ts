import { describe, expect, it } from 'vitest';
import { errorLine, excerpt, hintFor, insecureContext, PageErrors, placeOf } from '../src/errors.js';

const line = (n: number, kind: string, text: string, src = '', l = 0, c = 0, stack = '') => JSON.stringify([n, 100 + n, kind, text, src, l, c, stack]);

describe("a page's errors, as its agent reports them", () => {
  it('takes each error once, whatever order and however often the agent sends it', () => {
    const e = new PageErrors();
    expect(e.take(line(1, 'e', 'b', 'http://device/app.js', 3, 9))?.n).toBe(1);
    expect(e.take(line(0, 'e', 'a'))?.n).toBe(0);
    expect(e.take(line(1, 'e', 'b'))).toBeNull();
    expect(e.list().map((x) => x.text)).toEqual(['a', 'b']);
    expect(e.total).toBe(2);
  });

  it('counts what the agent only counted, and starts again with a new page', () => {
    const e = new PageErrors();
    e.take(line(0, 'e', 'a'));
    expect(e.count('100')).toBe(true);
    expect(e.count('100')).toBe(false);
    expect(e.total).toBe(100);
    e.clear();
    expect([e.total, e.list()]).toEqual([0, []]);
  });

  it('refuses what is not an error line', () => {
    const e = new PageErrors();
    for (const bad of ['', '{}', '[]', '["x"]', '[0,1,"z","t"]', 'not json']) expect(e.take(bad)).toBeNull();
    expect(e.count('many')).toBe(false);
  });

  it('says what was thrown and where in one line', () => {
    const e = new PageErrors();
    expect(errorLine(e.take(line(0, 'e', 'Uncaught ReferenceError: main is not defined', 'http://device/build/app.js?v=3', 3, 9))!)).toBe('ReferenceError: main is not defined · app.js:3:9');
    expect(errorLine(e.take(line(1, 'p', 'no rails'))!)).toBe('unhandled rejection: no rails');
    expect(errorLine(e.take(line(2, 'r', 'script', 'http://device/vendor.js'))!)).toBe('script did not load: http://device/vendor.js');
    expect(errorLine(e.take(line(3, 'e', ''))!)).toBe('an error with no message');
    expect(placeOf({ src: 'http://device/a.js', line: 0, col: 0 })).toBe('a.js');
  });
});

describe('what an error most likely means on a device', () => {
  const take = (lines: string[], engine = 'Chrome 38') => {
    const e = new PageErrors(() => engine);
    return lines.map((l) => e.take(l)!);
  };

  it('says a file the engine could not parse never ran, and names the engine', () => {
    const [e] = take([line(0, 'e', 'Uncaught SyntaxError: Unexpected token =>', 'http://device/app.js', 1, 5231)]);
    expect(e!.hint).toMatch(/The engine \(Chrome 38\) could not parse this file, so none of it ran/);
  });

  it('ties a missing name to the script that did not parse or did not load before it', () => {
    const [, missing] = take([line(0, 'e', 'Uncaught SyntaxError: Unexpected token {', 'http://device/app.js', 1, 9), line(1, 'e', 'Uncaught ReferenceError: main is not defined', 'http://device/', 12, 3)]);
    expect(missing!.hint).toBe('Probably because of error 1: SyntaxError: Unexpected token { · app.js:1:9. That script never ran, so what it defines is missing.');
    const [, after] = take([line(0, 'r', 'script', 'http://cdn/vendor.js'), line(1, 'e', 'TypeError: undefined is not a function')]);
    expect(after!.hint).toMatch(/^Probably because of error 1: script did not load: http:\/\/cdn\/vendor\.js/);
    const [, , both, nil] = take([line(0, 'r', 'script', 'http://cdn/vendor.js'), line(1, 'e', 'SyntaxError: Unexpected token =>', 'http://device/app.js', 1, 9), line(2, 'e', 'ReferenceError: main is not defined'), line(3, 'e', "TypeError: Cannot read properties of null (reading 'rail')")]);
    expect(both!.hint).toBe('Probably because an earlier script never ran, so what it defines is missing: error 1 (script did not load: http://cdn/vendor.js), error 2 (SyntaxError: Unexpected token => · app.js:1:9).');
    // A null read is the app's own bug far more often than a missing script.
    expect(nil!.hint).toBeNull();
  });

  it('explains the error an engine hides, and says nothing where the message says it all', () => {
    const [opaque, plain, css] = take([line(0, 'e', 'Script error.'), line(1, 'e', 'TypeError: x is not a function', 'http://device/app.js', 2, 2), line(2, 'r', 'link', 'http://device/a.css')]);
    expect(opaque!.hint).toMatch(/another origin/);
    expect(plain!.hint).toBeNull();
    expect(css!.hint).toBeNull();
    expect(hintFor(plain!, [])).toBeNull();
  });

  // DRM, service workers and crypto.subtle are kept from a page opened over plain http from another
  // machine. On a device that reads as "this device has no DRM", which is the wrong thing to conclude.
  it('says when a missing API is one an engine keeps for a secure context, on a page that is not one', () => {
    const on = (href: string) => new PageErrors(() => 'Chrome 68', () => insecureContext(href));
    const drm = line(0, 'e', 'Uncaught TypeError: navigator.requestMediaKeySystemAccess is not a function', 'http://192.168.1.20:7070/player.js', 9, 4);
    expect(on('http://192.168.1.20:7070/').take(drm)!.hint).toMatch(/^Probably because this page is not a secure context .* Open the app over https .* --via\.$/);
    for (const text of ["TypeError: Cannot read properties of undefined (reading 'register')", "TypeError: Cannot read property 'importKey' of undefined", 'ReferenceError: caches is not defined']) {
      expect(on('http://device.example.com/').take(line(0, 'e', text))!.hint, text).toMatch(/not a secure context/);
    }
    // The same error on a page that is one has another cause, and so does another error on this one.
    expect(on('https://device.example.com/').take(drm)!.hint).toBeNull();
    expect(on('http://localhost:7070/').take(drm)!.hint).toBeNull();
    expect(on('http://192.168.1.20:7070/').take(line(0, 'e', 'TypeError: rail.focus is not a function'))!.hint).toBeNull();
  });

  it('takes a page for a secure context unless it plainly is not', () => {
    for (const href of ['http://192.168.1.20:7070/', 'http://device.example.com/app', 'http://10.0.0.5/']) expect(insecureContext(href), href).toBe(true);
    for (const href of ['https://device.example.com/', 'http://localhost:5173/', 'http://127.0.0.1:7070/', 'http://[::1]:7070/', 'http://app.localhost/', 'file:///app/index.html', '', 'not an address']) expect(insecureContext(href), href).toBe(false);
  });
});

describe('the source around an error', () => {
  it('cuts a window around the column of a minified line', () => {
    const src = 'var a=1;\n' + 'x'.repeat(500) + 'const f=()=>{}' + 'y'.repeat(500);
    const x = excerpt(src, 2, 501, 40)!;
    expect(x.text).toHaveLength(40);
    expect(x.text.slice(x.caret, x.caret + 5)).toBe('const');
  });

  it('gives the whole of a short line, and nothing for a line the file lacks', () => {
    expect(excerpt('a\n  main();\n', 2, 3)).toEqual({ text: '  main();', caret: 2 });
    expect(excerpt('a', 5, 1)).toBeNull();
    expect(excerpt('a', 0, 0)).toBeNull();
  });
});
