import { test, expect } from '@playwright/test';
import { skipOnboarding } from './helpers';

/**
 * The loading overlay must be VISIBLE while the engine loads (so a slow first load
 * never reads as a frozen screen) and gone once the game is running. We assert its
 * end state deterministically (hidden after the game screen appears); its transient
 * appearance is covered by the throttled variant below.
 */
test('loading overlay is gone once the game screen is live', async ({ page }) => {
  await skipOnboarding(page);
  await page.goto('/level/small-concrete-room?debug=1&engine=ours');
  await page.locator('#start-button').click();
  await expect(page.locator('#game-screen')).toBeVisible();
  await page.waitForFunction(() => !!(window as unknown as { __ps?: unknown }).__ps);
  const overlay = page.locator('#loading-overlay');
  // Either never created (fast local load) or present-but-hidden — both are "not shown".
  await expect
    .poll(async () => (await overlay.count()) === 0 || (await overlay.isHidden()))
    .toBe(true);
});

test('loading overlay is SHOWN during a slow engine load, then clears', async ({ page }) => {
  await skipOnboarding(page);
  // Throttle the HRTF asset fetch so the load window is long enough to observe the
  // overlay. (Delays the big binary the renderer waits on before the game screen.)
  await page.route('**/assets/hrtf/**', async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await page.goto('/level/small-concrete-room?debug=1&engine=ours');
  await page.locator('#start-button').click();

  // The overlay should become visible with a loading message while the fetch is stalled.
  const overlay = page.locator('#loading-overlay');
  await expect(overlay).toBeVisible({ timeout: 5000 });
  await expect(overlay.locator('.loading-msg')).toContainText(/loading/i);

  // …and be hidden once the game screen takes over.
  await expect(page.locator('#game-screen')).toBeVisible({ timeout: 15000 });
  await expect(overlay).toBeHidden();
});
