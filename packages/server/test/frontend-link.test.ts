import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { injectFrontend, serveFrontend } from '../src/frontend.js';

const PAGE = '<!DOCTYPE html>\n<meta charset="utf-8">\n<script type="module" src="./entrypoints/devtools_app/devtools_app.js"></script>\n<body>';

describe("DevTools' start page", () => {
  it('runs the link script before DevTools opens its socket', () => {
    const html = injectFrontend(PAGE, '<script src="./teleport-link.js"></script>');
    expect(html.indexOf('teleport-link.js')).toBeGreaterThan(0);
    expect(html.indexOf('teleport-link.js')).toBeLessThan(html.indexOf('type="module"'));
  });

  it('is served with the link script and never cached; the rest of the frontend is cached for good', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tlpt-frontend-'));
    writeFileSync(join(root, 'devtools_app.html'), PAGE);
    mkdirSync(join(root, 'core'));
    writeFileSync(join(root, 'core', 'a.js'), 'export {}');
    const http = createServer((req, res) => void serveFrontend(res, req.url!.slice(1), root, '<script src="./teleport-link.js"></script>'));
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
    const at = `http://127.0.0.1:${(http.address() as { port: number }).port}/`;
    const page = await fetch(at + 'devtools_app.html');
    expect(await page.text()).toContain('teleport-link.js');
    expect(page.headers.get('cache-control')).toBe('no-store');
    const js = await fetch(at + 'core/a.js');
    expect(js.headers.get('cache-control')).toContain('immutable');
    http.close();
  });
});
