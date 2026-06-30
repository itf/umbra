import { test, expect } from '@playwright/test';
import { skipOnboarding, debugState } from './helpers';

/**
 * SANDBOX / FREEPLAY: the picker's Sandbox section generates a fresh, solvable
 * level and starts it through the normal game path. We don't walk it (audio
 * cadence) — we assert it LOADS and is playable: the Begin gate passes, the game
 * screen + ?debug hook come up, and a goal/beacon is present.
 *
 * Non-flaky: no timing, no audio walk — just UI clicks + the debug state hook.
 */
test('sandbox: generate a beacon level and it loads + is playable', async ({ page }) => {
  await skipOnboarding(page);
  await page.goto('/?debug=1');

  // The picker is the default entry point. Pick beacon mode, then generate.
  const mode = page.locator('#sandbox-mode');
  await expect(mode).toBeVisible();
  await mode.selectOption('beacon');
  await page.locator('#sandbox-difficulty').selectOption('2');
  await page.locator('.sandbox-generate').click();

  // Generated level → Begin screen (the audio gesture gate).
  const begin = page.locator('#start-button');
  await expect(begin).toBeVisible();
  await begin.click();

  await expect(page.locator('#game-screen')).toBeVisible();
  await page.waitForFunction(() => !!(window as unknown as { __ps?: unknown }).__ps);

  const st = await debugState(page);
  expect(st.goal).toBe('beacon');
  expect(Number.isFinite(st.distance)).toBe(true);
  expect(st.distance).toBeGreaterThan(0);
});
