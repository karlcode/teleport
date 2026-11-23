// Real Playwright against the built server, what the unit tests can't hold: connectOverCDP's whole
// handshake, a page driven through it, and two runs each holding a device of their own.
// Needs playwright on the module path and a build; PW_CHANNEL=chrome uses an installed Chrome:
//   npm run build && node scripts/e2e-playwright.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const { chromium } = createRequire(import.meta.url)('playwright');
const { startDevServer } = await import(repo + 'packages/server/dist/server.js');
const { reserve } = await import(repo + 'packages/tlpt/dist/drive.js');

const server = await startDevServer({ port: 0, host: '127.0.0.1', app: repo + 'examples/hello-device' });
const port = server.http.address().port;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) process.exitCode = 1;
};
setTimeout(() => (check('finished in 30 s', false), process.exit(1)), 30_000).unref();

// Two tabs in two contexts stand in for two devices.
const devices = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined });
const tabs = [];
for (let i = 0; i < 2; i++) tabs.push(await (await devices.newContext()).newPage());
for (const t of tabs) await t.goto(`http://127.0.0.1:${port}/`);
while (server.devices.size < 2) await new Promise((r) => setTimeout(r, 20));

const run = async (as) => {
  const device = await reserve({ port, key: server.key, as });
  const browser = await chromium.connectOverCDP(device.endpoint);
  const pages = browser.contexts()[0].pages();
  const page = pages[0];
  check(`${as}: its socket shows its device alone`, pages.length === 1 && page.url() === device.href, page.url());
  check(`${as}: title`, (await page.title()) === 'hello-device');
  check(`${as}: evaluate with an argument`, (await page.evaluate((a) => a.x + document.querySelectorAll('*').length, { x: 1 })) > 5);
  await page.evaluate(() => void (window.__k = []) || document.addEventListener('keydown', (e) => window.__k.push(e.key)));
  await page.keyboard.press('ArrowRight');
  await device.keys('down');
  check(`${as}: keys from Playwright and from the remote reach the page`, (await device.eval('window.__k.join()')) === 'ArrowRight,ArrowDown');
  check(`${as}: locator`, (await page.locator('body').innerText()).includes('hello-device'));
  const session = await browser.contexts()[0].newCDPSession(page);
  check(`${as}: a raw session`, (await session.send('Runtime.evaluate', { expression: '6*7', returnByValue: true })).result.value === 42);
  check(`${as}: the frame is on the device`, (await device.eval("document.getElementById('__tlpt_hold').textContent")) === `◎ teleport · ${as}`);
  await device.eval("setTimeout(function(){throw new Error('boom')},0)");
  await new Promise((r) => setTimeout(r, 300));
  check(`${as}: what the page threw is read, then forgotten`, (await device.errors()).total === 1 && (await device.clear()).cleared.errors === 1 && (await device.errors()).total === 0);
  await browser.close();
  return device;
};
const t0 = Date.now();
const held = await Promise.all([run('run a'), run('run b')]);
check('two runs took a device each', held[0].id !== held[1].id, `${Date.now() - t0} ms`);
check('a third is refused', await reserve({ port, key: server.key }).then(() => false, (e) => /reserved/.test(e.message)));
if (process.env.SHOT) await tabs[0].screenshot({ path: process.env.SHOT });
for (const d of held) await d.release();
await new Promise((r) => setTimeout(r, 100));
check('released: the frame is gone', (await tabs[0].evaluate(() => !document.getElementById('__tlpt_hold'))) && (await tabs[1].evaluate(() => !document.getElementById('__tlpt_hold'))));

await devices.close();
await server.close();
process.exit(process.exitCode ?? 0);
