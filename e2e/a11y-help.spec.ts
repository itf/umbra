import { test, expect } from '@playwright/test';
import { beginLevel, liveText } from './helpers';

/**
 * Accessibility smoke: the ARIA live regions exist with the right politeness, and
 * the help key (? / h) populates the live region with control instructions.
 */
test('status and alerts live regions exist with aria-live', async ({ page }) => {
  await page.goto('/');
  const status = page.locator('#status');
  const alerts = page.locator('#alerts');
  await expect(status).toHaveAttribute('aria-live', 'polite');
  await expect(alerts).toHaveAttribute('aria-live', 'assertive');
});

test('pressing ? populates the live region with control instructions', async ({ page }) => {
  await beginLevel(page, 'small-concrete-room');

  await page.keyboard.press('?');
  await expect
    .poll(async () => (await liveText(page)).toLowerCase())
    .toMatch(/controls|turn|step|arrow/);

  // The h key speaks the same help.
  await page.evaluate(() => { document.getElementById('status')!.textContent = ''; });
  await page.keyboard.press('h');
  await expect
    .poll(async () => (await liveText(page)).toLowerCase())
    .toMatch(/controls|turn|step|arrow/);
});
