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

/**
 * SEED-SHARE round-trip: generate a level, read its displayed share code, go back
 * to the picker, paste the code into the seed input, and assert the SAME level
 * loads (identical goal target via the debug hook). Deterministic — no audio walk.
 */
test('sandbox: a shared seed reproduces the exact level', async ({ page }) => {
  await skipOnboarding(page);
  await page.goto('/?debug=1');

  await page.locator('#sandbox-mode').selectOption('beacon');
  await page.locator('#sandbox-difficulty').selectOption('3');
  await page.locator('.sandbox-generate').click();

  // Read the displayed share code, then play the first roll and capture its target.
  const shareText = await page.locator('.sandbox-seed-text').textContent();
  const code = shareText!.match(/Share code:\s*(papasangre sandbox .+)$/)![1].trim();

  await page.locator('#start-button').click();
  await expect(page.locator('#game-screen')).toBeVisible();
  await page.waitForFunction(() => !!(window as unknown as { __ps?: unknown }).__ps);
  const first = await debugState(page);

  // Fresh load of the picker (simulates a different player), paste the share
  // code, and play it.
  await page.goto('/?debug=1');
  const input = page.locator('#sandbox-seed-input');
  await expect(input).toBeVisible();
  await input.fill(code);
  await page.locator('.sandbox-play-seed').click();

  await page.locator('#start-button').click();
  await expect(page.locator('#game-screen')).toBeVisible();
  await page.waitForFunction(() => !!(window as unknown as { __ps?: unknown }).__ps);
  const second = await debugState(page);

  // Same level ⇒ same goal target and start position.
  expect(second.goalTarget).toEqual(first.goalTarget);
  expect(second.player).toEqual(first.player);
});
