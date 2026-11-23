// A page on a device runs a bundle, and an error names a place in it. With the build's source map
// the laptop says where that is in the code someone wrote. The maps here are real ones, made by
// esbuild as the test runs, minified to one line as an app ships.
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { PageError } from '../src/errors.js';
import { formatErrors } from '../src/format.js';
import type { ServerEvent } from '../src/live.js';
import { startDevServer, type DevServer } from '../src/server.js';
import { inlineMap, mapUrlOf, originalOf } from '../src/sourcemap.js';
import { paint } from '../src/tui.js';

const RAIL = ['export function rail(items) {', '  if (!items.length) {', '    throw new Error("the rail has no tiles");', '  }', '  return items.map((x) => x.title);', '}', ''].join('\n');
const APP = ['import { rail } from "./rail.js";', '', 'window.start = function () {', '  return rail(window.catalogue || []);', '};', ''].join('\n');

/** The two files above as one minified bundle with its map, as an app's build writes them. */
async function bundle(sourcemap: 'external' | 'inline', banner = '') {
  const dir = mkdtempSync(join(tmpdir(), 'tlpt-map-src-'));
  writeFileSync(join(dir, 'rail.js'), RAIL);
  writeFileSync(join(dir, 'app.js'), APP);
  const out = await build({ entryPoints: [join(dir, 'app.js')], bundle: true, minify: true, format: 'iife', sourcemap, write: false, outfile: join(dir, 'out/built.js'), logLevel: 'error', banner: banner ? { js: banner } : undefined });
  const file = (end: string) => out.outputFiles.find((f) => f.path.endsWith(end))?.text ?? '';
  const js = file('built.js');
  /** Where `needle` is in the bundle, as an engine reports a place: line and column from 1. */
  const at = (needle: string) => {
    const i = js.indexOf(needle);
    const before = js.slice(0, i).split('\n');
    return { line: before.length, col: before[before.length - 1]!.length + 1 };
  };
  return { js, map: file('built.js.map'), at };
}

describe('a source map', () => {
  it('names the file, line and column a place in a minified bundle came from, with the line as written', async () => {
    const b = await bundle('external');
    expect(b.js.trimEnd().split('\n').length).toBeLessThanOrEqual(2);
    const thrown = b.at('"the rail has no tiles"');
    const o = originalOf(JSON.parse(b.map), thrown.line, thrown.col)!;
    expect(o.source).toMatch(/rail\.js$/);
    expect(o.line).toBe(3);
    expect(o.text).toBe('    throw new Error("the rail has no tiles");');
    expect(o.text!.slice(o.col - 1)).toMatch(/^"the rail has no tiles"/);
    // Another file of the same bundle.
    const called = originalOf(JSON.parse(b.map), b.at('catalogue').line, b.at('catalogue').col)!;
    expect(called.source).toMatch(/app\.js$/);
    expect(called.line).toBe(4);
  });

  it('is found from the comment at the end of the script, as a file beside it or inside the comment itself', async () => {
    expect(mapUrlOf((await bundle('external')).js)).toBeNull();
    expect(mapUrlOf('var a=1;\n//# sourceMappingURL=built.js.map\n')).toBe('built.js.map');
    expect(mapUrlOf('//# sourceMappingURL=old.map\nvar a=1;\n//@ sourceMappingURL=new.map')).toBe('new.map');
    const inline = await bundle('inline');
    const text = inlineMap(mapUrlOf(inline.js)!)!;
    const thrown = inline.at('"the rail has no tiles"');
    expect(originalOf(JSON.parse(text), thrown.line, thrown.col)).toMatchObject({ line: 3 });
    expect(inlineMap('built.js.map')).toBeNull();
    expect(inlineMap('data:application/json;base64,%%%')).not.toBe('{}');
  });

  it('answers nothing where it has nothing, and never a guess', async () => {
    const b = await bundle('external');
    const map = JSON.parse(b.map);
    const thrown = b.at('"the rail has no tiles"');
    // Past the end of the file, before its first character, a line the bundle doesn't have.
    expect(originalOf(map, 99, 1)).toBeNull();
    expect(originalOf(map, 0, 1)).toBeNull();
    expect(originalOf(map, thrown.line, 0)).toBeNull();
    // A map that only names its files still gives the place, without the line's text.
    expect(originalOf({ ...map, sourcesContent: undefined }, thrown.line, thrown.col)).toMatchObject({ line: 3, text: null });
    expect(originalOf({ ...map, sourceRoot: 'webpack://app' }, thrown.line, thrown.col)!.source).toMatch(/^webpack:\/\/app\/.*rail\.js$/);
    // What isn't a map, a map in sections, and one cut short or with characters no map has.
    for (const not of [null, 5, 'x', [], {}, { mappings: 5, sources: [] }, { version: 3, sections: [] }, { ...map, mappings: map.mappings.slice(0, 7) + '!' }, { ...map, sources: [5, 5] }]) {
      expect(originalOf(not, thrown.line, thrown.col), JSON.stringify(not)?.slice(0, 40)).toBeNull();
    }
  });
});

describe('what a page threw, in the code someone wrote', () => {
  const open: { close(): unknown }[] = [];
  afterAll(async () => {
    for (const s of open) await s.close();
  });
  const until = async (ok: () => boolean) => {
    while (!ok()) await new Promise((r) => setTimeout(r, 5));
  };
  /** An agent that reports one error at `at` in `/built.js`, and the error the console then hears of. */
  async function thrown(dev: DevServer, events: ServerEvent[], at: { line: number; col: number }, id: string): Promise<PageError> {
    const base = `127.0.0.1:${(dev.http.address() as { port: number }).port}`;
    const ws = new WebSocket(`ws://${base}/ws/target?href=${encodeURIComponent(`http://${base}/`)}&id=${id}&page=p`);
    await new Promise((r) => ws.once('open', r));
    ws.send(`err ${JSON.stringify([0, 40, 'e', 'Uncaught Error: the rail has no tiles', `http://${base}/built.js`, at.line, at.col, ''])}`);
    const heard = () => events.find((e): e is Extract<ServerEvent, { type: 'error' }> => e.type === 'error' && e.id === id);
    await until(() => !!heard());
    ws.close();
    return heard()!.error;
  }

  let folder: DevServer;
  const events: ServerEvent[] = [];
  let b: Awaited<ReturnType<typeof bundle>>;
  beforeAll(async () => {
    b = await bundle('external');
    const dir = mkdtempSync(join(tmpdir(), 'tlpt-map-app-'));
    writeFileSync(join(dir, 'index.html'), '<script src="built.js"></script>');
    writeFileSync(join(dir, 'built.js'), b.js + '//# sourceMappingURL=built.js.map\n');
    writeFileSync(join(dir, 'built.js.map'), b.map);
    writeFileSync(join(dir, 'plain.js'), b.js);
    folder = await startDevServer({ port: 0, host: '127.0.0.1', app: dir, onEvent: (e) => events.push(e) });
    open.push(folder);
  });

  it('says the file and line that were written, shows that line, and keeps the place in the bundle too', async () => {
    const at = b.at('"the rail has no tiles"');
    const e = await thrown(folder, events, at, 'mapped');
    expect(e.from).toMatchObject({ line: 3 });
    expect(e.from!.src).toMatch(/rail\.js$/);
    expect(e.near!.text).toBe('throw new Error("the rail has no tiles");'.padStart(e.near!.text.length));
    expect(e.near!.text.slice(e.near!.caret)).toMatch(/^"the rail has no tiles"/);
    expect([e.line, e.col]).toEqual([at.line, at.col]);
    const said = formatErrors({ id: 'mapped', href: '', engine: '', total: 1, errors: [e] }, paint('none'), 100).join('\n');
    expect(said).toContain(`Error: the rail has no tiles · rail.js:3:${e.from!.col}`);
    expect(said).not.toContain('built.js');
  });

  it('says the place in the bundle where there is no map', async () => {
    const base = `127.0.0.1:${(folder.http.address() as { port: number }).port}`;
    const ws = new WebSocket(`ws://${base}/ws/target?href=${encodeURIComponent(`http://${base}/`)}&id=plain&page=p`);
    await new Promise((r) => ws.once('open', r));
    const at = b.at('"the rail has no tiles"');
    ws.send(`err ${JSON.stringify([0, 40, 'e', 'Uncaught Error: x', `http://${base}/plain.js`, at.line, at.col, ''])}`);
    const heard = () => events.find((e): e is Extract<ServerEvent, { type: 'error' }> => e.type === 'error' && e.id === 'plain');
    await until(() => !!heard());
    expect(heard()!.error.from).toBeNull();
    expect(heard()!.error.near!.text).toContain('the rail has no tiles');
    ws.close();
  });

  // Through the proxy the app's own address in a file is rewritten, to the device's address in the
  // device's copy and to the laptop's in the one the laptop reads. A column past such a place may
  // be another character in each, so there the map is not asked.
  it("doesn't trust a column past a place the proxy rewrote, and does trust one before it", async () => {
    let app: Server;
    const port = await new Promise<number>((r) => {
      app = createServer((req, res) => {
        const own = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
        const files: Record<string, [string, string]> = {
          '/built.js': ['text/javascript', b.js + '//# sourceMappingURL=built.js.map\n'],
          '/built.js.map': ['application/json', b.map],
          '/early.js': ['text/javascript', `var api="${own}/api";` + b.js + '//# sourceMappingURL=built.js.map\n'],
        };
        const f = files[req.url ?? ''];
        if (f) res.writeHead(200, { 'content-type': f[0] }).end(f[1]);
        else res.writeHead(200, { 'content-type': 'text/html' }).end('<html><head></head></html>');
      });
      app.listen(0, '127.0.0.1', () => r((app.address() as { port: number }).port));
    });
    open.push({ close: () => app.close() });
    const heard: ServerEvent[] = [];
    const proxy = await startDevServer({ port: 0, host: '127.0.0.1', app: `http://127.0.0.1:${port}`, onEvent: (e) => heard.push(e) });
    open.push(proxy);
    const at = b.at('"the rail has no tiles"');
    expect((await thrown(proxy, heard, at, 'through')).from).toMatchObject({ line: 3 });

    const base = `127.0.0.1:${(proxy.http.address() as { port: number }).port}`;
    const ws = new WebSocket(`ws://${base}/ws/target?href=${encodeURIComponent(`http://${base}/`)}&id=shifted&page=p`);
    await new Promise((r) => ws.once('open', r));
    ws.send(`err ${JSON.stringify([0, 40, 'e', 'Uncaught Error: x', `http://${base}/early.js`, at.line, at.col + 40, ''])}`);
    const said = () => heard.find((e): e is Extract<ServerEvent, { type: 'error' }> => e.type === 'error' && e.id === 'shifted');
    await until(() => !!said());
    expect(said()!.error.from).toBeNull();
    ws.close();
  });
});
