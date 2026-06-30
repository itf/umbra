import { test, expect } from '@playwright/test';
import { beginLevel, debugState, liveText, walkToTarget, turnToward } from './helpers';

/**
 * find-the-foam: absorber goal mode (no beacon). Win by reaching the absorber
 * patch's wall region. We assert the level loads in absorber mode (debug state
 * exposes goal=absorber + a goalTarget distinct from any beacon voice), then
 * navigate to the goal target and assert a win.
 */
test('loads in absorber goal mode (no beacon objective)', async ({ page }) => {
  await beginLevel(page, 'find-the-foam');

  const s = await debugState(page);
  expect(s.goal).toBe('absorber');
  // The win target is the absorber patch, not the (silent) beacon coords.
  expect(s.goalTarget).toBeTruthy();
  expect(s.distance).toBeGreaterThan(0); // we start away from the dead spot
});

test('reaching the absorber target triggers a win', async ({ page }) => {
  await beginLevel(page, 'find-the-foam');

  const s0 = await debugState(page);
  await turnToward(page, s0.goalTarget.x, s0.goalTarget.z);

  const won = await walkToTarget(page, 80);
  expect(won).toBe(true);

  await expect
    .poll(async () => (await liveText(page)).toLowerCase())
    .toMatch(/absorber|level complete/);
});
