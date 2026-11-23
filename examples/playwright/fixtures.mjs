// Playwright's own `test`, with a device for each worker. Start `tlpt` and open the app on the
// devices first, then: npx playwright test -c examples/playwright
import { test as base } from '@playwright/test';
import { fixtures } from 'tlpt/drive';

export const test = base.extend(fixtures());
export { expect } from '@playwright/test';
