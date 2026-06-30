import { test, expect } from '@playwright/test';
import { beginLevel, liveText } from './helpers';

/**
 * Sonar-budget survival smoke: clapping in the budgeted vault must SPEAK the
 * remaining budget (eyes-free), and draining the budget must announce the soft
 * out-of-sonar state. We drive the real #listen button and read the combined
 * ARIA live region, so a regression in the spoken path fails CI.
 *
 * The level has a 2 s cooldown, so between claps we advance time by waiting out
 * the cooldown rather than racing it (a refused-while-cooling clap fires no
 * budget change). This keeps the smoke deterministic, not flaky.
 */

const CLAP_BUDGET = 6;
const COOLDOWN_MS = 2000;

test('clapping announces the remaining sonar budget', async ({ page }) => {
  await beginLevel(page, 'sonar-vault');

  // The intro cue already names the starting budget.
  await expect.poll(async () => (await liveText(page)).toLowerCase()).toContain('sonar budget');

  await page.locator('#listen').click();
  await expect
    .poll(async () => (await liveText(page)).toLowerCase())
    .toMatch(/claps left|clap left/);
});

test('clapping again while still echoing is spoken as a refusal', async ({ page }) => {
  await beginLevel(page, 'sonar-vault');
  const listen = page.locator('#listen');

  await listen.click();
  // Immediate second clap is inside the cooldown → refused, spoken, no clap fired.
  await listen.click();
  await expect
    .poll(async () => (await liveText(page)).toLowerCase())
    .toContain('still echoing');
});

test('draining the budget announces the out-of-sonar state', async ({ page }) => {
  test.setTimeout(40_000);
  await beginLevel(page, 'sonar-vault');
  const listen = page.locator('#listen');

  // Spend every clap, waiting out the cooldown between each so each one fires.
  for (let i = 0; i < CLAP_BUDGET; i++) {
    await listen.click();
    await page.waitForTimeout(COOLDOWN_MS + 150);
  }

  // The last fired clap announces the soft out-of-sonar state (no game-over).
  await expect
    .poll(async () => (await liveText(page)).toLowerCase())
    .toMatch(/no sonar left|last clap/);

  // The button is now disabled and a further click is refused as exhausted.
  await expect(listen).toBeDisabled();
});
