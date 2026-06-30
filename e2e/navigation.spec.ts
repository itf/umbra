import { test, expect } from '@playwright/test';
import { beginLevel, debugState, walkToTarget, turnToward, skipOnboarding } from './helpers';

/**
 * Screen routing / history (REQUESTS-QUEUE item 2). Covers:
 *  - the picker is re-rendered (populated + clickable) every time it's shown,
 *    including on RETURN from a level — it must never be blank;
 *  - finishing/leaving a level returns to a populated picker, and a second level
 *    is then playable;
 *  - reload on a level returns to that level (deep-link via the URL);
 *  - the browser Back button walks picker ← level.
 */

const LEVEL = 'small-concrete-room';

/** Open the app at the picker (onboarding skipped) and wait for it to populate. */
async function openPicker(page: import('@playwright/test').Page) {
  await skipOnboarding(page);
  await page.goto('/?debug=1');
  await expect(page.locator('#picker-screen')).toBeVisible();
  await expect(page.locator('#level-picker .picker-list .picker-item').first()).toBeVisible();
}

test('picker is populated on first load and lists levels', async ({ page }) => {
  await openPicker(page);
  const count = await page.locator('#level-picker .picker-list .picker-item').count();
  expect(count).toBeGreaterThan(1);
});

test('leaving a level mid-game returns to a populated, clickable picker', async ({ page }) => {
  await beginLevel(page, LEVEL);
  // Press B to bail back to level select.
  await page.keyboard.press('b');
  await expect(page.locator('#picker-screen')).toBeVisible();
  await expect(page.locator('#game-screen')).toBeHidden();
  // The picker re-rendered (NOT blank) and is clickable: pick another level.
  const items = page.locator('#level-picker .picker-list .picker-item');
  await expect(items.first()).toBeVisible();
  expect(await items.count()).toBeGreaterThan(1);
  // The URL reflects the picker (routing param cleared).
  expect(new URL(page.url()).searchParams.get('level')).toBeNull();
});

test('finishing a level then returning to the picker lets you pick a second level', async ({ page }) => {
  await beginLevel(page, LEVEL);
  const s0 = await debugState(page);
  await turnToward(page, s0.beacon.x, s0.beacon.z);
  expect(await walkToTarget(page)).toBe(true);

  // Back to levels after the win (the B key / button work after ending).
  await page.keyboard.press('b');
  await expect(page.locator('#picker-screen')).toBeVisible();
  const items = page.locator('#level-picker .picker-list .picker-item');
  await expect(items.first()).toBeVisible();

  // Pick a second (builtin) level → routes to its Begin screen.
  await items.first().click();
  await expect(page.locator('#start-button')).toBeVisible();
});

test('reload on a level returns to that level', async ({ page }) => {
  await beginLevel(page, LEVEL);
  // The URL carries the deep-link; reloading restores the Begin screen for it.
  expect(new URL(page.url()).searchParams.get('level')).toBe(LEVEL);
  await page.reload();
  await expect(page.locator('#start-button')).toBeVisible();
  await expect(page.locator('#start-level-name')).toContainText(/now playing/i);
});

test('browser Back from a level returns to the picker', async ({ page }) => {
  await openPicker(page);
  // Navigate picker → a level by clicking a builtin card (pushes history).
  await page.locator('#level-picker .picker-list .picker-item').first().click();
  await expect(page.locator('#start-button')).toBeVisible();

  await page.goBack();
  await expect(page.locator('#picker-screen')).toBeVisible();
  await expect(page.locator('#level-picker .picker-list .picker-item').first()).toBeVisible();
});

test('progress screen is a routed screen and Back returns to the picker', async ({ page }) => {
  await openPicker(page);
  await page.locator('#open-progress').click();
  await expect(page.locator('#progress-screen')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('screen')).toBe('progress');
  await page.goBack();
  await expect(page.locator('#picker-screen')).toBeVisible();
});
