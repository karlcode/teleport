import { expect, test } from './fixtures.mjs';

// `device` works on any engine teleport does: keys go as the remote's, the code is yours to keep ES5.
test('the remote moves focus without the page throwing', async ({ device }) => {
  const before = await device.eval('document.activeElement && document.activeElement.textContent');
  await device.keys('right,right,down');
  const after = await device.eval('document.activeElement && document.activeElement.textContent');
  expect(after).not.toBe(before);
  expect((await device.errors()).total).toBe(0);
  expect(await device.network({ failed: true })).toEqual([]);
});

// `devicePage` is the same device as a Playwright page: for an engine new enough to read Playwright's scripts.
test('the page is a Playwright page', async ({ devicePage }) => {
  await devicePage.keyboard.press('ArrowRight');
  expect(await devicePage.title()).not.toBe('');
});
