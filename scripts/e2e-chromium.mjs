// Real Chromium against the built server, what the unit tests can't hold: the agent connects, a fake
// DevTools client drives the tree a piece at a time, changes arrive through a real MutationObserver,
// Styles matching runs on the engine's matches(), and the agent reports its own cost.
// Needs playwright on the module path (`npm i -g playwright`, or as a dev dependency) and a build:
//   npm run build && node scripts/e2e-chromium.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const WebSocket = createRequire(repo + 'package.json')('ws');
const { startDevServer } = await import(repo + 'packages/server/dist/server.js');

const server = await startDevServer({ port: 0, host: '127.0.0.1', app: repo + 'examples/hello-device' });
const port = server.http.address().port;
const log = [];
const check = (name, ok, detail = '') => {
  log.push(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) process.exitCode = 1;
};

const browser = await chromium.launch();
const page = await browser.newPage();
const consoleLines = [];
page.on('console', (m) => consoleLines.push(m.text()));
await page.goto(`http://127.0.0.1:${port}/`);
const started = Date.now();
while (!server.devices.size && Date.now() - started < 5000) await new Promise((r) => setTimeout(r, 20));
await page.waitForFunction(() => document.querySelectorAll('#grid div').length > 0);
await page.evaluate(() => {
  const grid = document.getElementById('grid');
  for (let i = 0; i < 1200; i++) {
    const d = document.createElement('div');
    d.className = 'tile';
    d.textContent = 'tile ' + i;
    grid.appendChild(d);
  }
});
const [id] = [...server.devices.keys()];
check('agent connected', !!id, `tab ${id}`);

const inbox = [];
const ws = new WebSocket(`ws://127.0.0.1:${port}/__teleport/${server.key}/ws/${id}`);
ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
await new Promise((r) => ws.once('open', r));
let seq = 0;
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const n = ++seq;
    ws.send(JSON.stringify({ id: n, method, params }));
    const t = setTimeout(() => reject(new Error(`${method} timed out`)), 8000);
    const poll = () => {
      const i = inbox.findIndex((m) => m.id === n);
      if (i < 0) return setTimeout(poll, 5);
      clearTimeout(t);
      const [m] = inbox.splice(i, 1);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    };
    poll();
  });
const events = (method) => inbox.filter((m) => m.method === method);
const waitFor = async (pred, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
};

await call('Runtime.enable');
await call('DOM.enable');
await call('CSS.enable');
const { root } = await call('DOM.getDocument', { depth: 2 });
const snapshotBytes = JSON.stringify(root).length;
const htmlNode = root.children.find((c) => c.nodeName === 'HTML');
check('getDocument answers from the snapshot', root.nodeName === '#document' && !!htmlNode && htmlNode.children.length === 2, `url ${root.documentURL}, ${root.children.length} top nodes`);
// The grid has 24 tiles once items.json loads; wait for it in the page, then find it through the page.
await page.waitForFunction(() => document.querySelectorAll('#grid div').length > 0);
const { nodeId: gridId } = await call('DOM.querySelector', { nodeId: root.nodeId, selector: '#grid' });
check('querySelector returns a node the laptop then knows', gridId > 0, `grid ${gridId}`);
const { node: grid } = await call('DOM.describeNode', { nodeId: gridId });
const tilesInPage = await page.evaluate(() => document.querySelectorAll('#grid > div').length);
check('describeNode reports the grid child count without expanding it', grid.childNodeCount === tilesInPage, `${grid.childNodeCount} tiles; the depth-2 document was ${snapshotBytes} bytes as served`);

inbox.length = 0;
await call('DOM.requestChildNodes', { nodeId: gridId, depth: 1 });
const set = events('DOM.setChildNodes').find((e) => e.params.parentId === gridId);
check('expanding the grid fetches its children once', !!set && set.params.nodes.length === tilesInPage);
const firstTile = set.params.nodes[0];
check('a tile comes shallow, with its text as a count', firstTile.childNodeCount === 1 && firstTile.children === undefined);

// A change under a collapsed tile: only the count moves; a change to the grid: an insert.
inbox.length = 0;
await page.evaluate(() => {
  const tile = document.querySelector('#grid > div');
  tile.appendChild(document.createElement('b'));
  const extra = document.createElement('div');
  extra.className = 'tile';
  extra.textContent = 'extra';
  document.getElementById('grid').appendChild(extra);
});
check('a collapsed node changing reports its new count', await waitFor(() => events('DOM.childNodeCountUpdated').some((e) => e.params.nodeId === firstTile.nodeId && e.params.childNodeCount === 2)));
check('an expanded node changing reports the inserted child', await waitFor(() => events('DOM.childNodeInserted').some((e) => e.params.parentNodeId === gridId && e.params.node.nodeName === 'DIV')));

// Attributes on a watched node, and nothing for one the laptop never got.
inbox.length = 0;
await page.evaluate(() => {
  document.querySelector('#grid > div').setAttribute('data-x', '1');
  document.querySelector('#grid > div > b').setAttribute('data-deep', '1');
});
check('an attribute on a known node arrives', await waitFor(() => events('DOM.attributeModified').some((e) => e.params.nodeId === firstTile.nodeId && e.params.name === 'data-x')));
await new Promise((r) => setTimeout(r, 300));
check('an attribute on a node the laptop lacks sends nothing', !events('DOM.attributeModified').some((e) => e.params.name === 'data-deep'));

// Styles for a tile: the prefilter against real matches().
const styles = await call('CSS.getMatchedStylesForNode', { nodeId: firstTile.nodeId });
const selectors = styles.matchedCSSRules.map((r) => r.rule.selectorList.text);
check('matched rules include the tile rule and not unrelated ones', selectors.some((s) => /\.tile/.test(s)) && !selectors.some((s) => /#status/.test(s)), selectors.join(' | '));

// Search: hits stay on the device; the page of them reveals.
const { resultCount } = await call('DOM.performSearch', { query: '.tile' });
const { nodeIds } = await call('DOM.getSearchResults', { searchId: '1', fromIndex: 0, toIndex: 3 });
check('search pages reveal their nodes, capped at a thousand hits', resultCount === 1000 && nodeIds.length === 3 && nodeIds.every((x) => x > 0), `${resultCount} hits`);

// Console and eval through the inspector.
await page.evaluate(() => console.log('hello from the device', { a: 1 }));
check('console.log reaches DevTools', await waitFor(() => events('Runtime.consoleAPICalled').some((e) => e.params.args[0]?.value === 'hello from the device')));
const ev = await call('Runtime.evaluate', { expression: '1 + 1', returnByValue: true });
check('Runtime.evaluate answers', ev.result.value === 2);

// The API path: a probe through the lease, on the same inspector.
const probe = await (await fetch(`http://127.0.0.1:${port}/__teleport/${server.key}/api/probe?name=dom&id=${id}`)).json();
check('q probe dom answers from the real page', typeof probe.elements === 'number' && probe.elements > 20, `${probe.elements} elements`);

// Overhead the agent reports about itself, and what the inspector reports.
// The agent ticks once a second; give it two.
await new Promise((r) => setTimeout(r, 2200));
const snap = await (await fetch(`http://127.0.0.1:${port}/__teleport/${server.key}/api/device?id=${id}`)).json();
check('agent samples flow', snap.latest !== null && snap.stats.frames > 0, `frames ${snap.stats.frames}, overhead ${snap.latest?.overheadPct?.toFixed(3)} %`);
check('inspector link health is reported', snap.latest?.level === 0, `inspector ${snap.latest?.inspectorPct ?? 'idle'} %, queued ${snap.latest?.inspectorQueuedKB ?? 0} KB`);

const status = await page.evaluate(() => window.teleport.status());
check('agent status', status.running && status.framesSent > 0, `sent ${status.framesSent}, skipped ${status.framesSkipped}, self ${status.selfMs.toFixed(1)} ms over ${(status.elapsedMs / 1000).toFixed(1)} s`);
check('no page errors', !consoleLines.some((l) => /error/i.test(l) && !/hello from/.test(l)), consoleLines.filter((l) => /error/i.test(l)).join(' | '));

ws.close();
await browser.close();
await server.close();
console.log(log.join('\n'));
if (process.exitCode) console.log('\nsome checks failed');
