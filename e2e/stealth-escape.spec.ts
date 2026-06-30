import { test, expect } from '@playwright/test';
import { beginLevel, debugState, liveText, walkToTarget } from './helpers';

/**
 * stealth-escape: the "escape" (stealth) mode + the throw-a-sound decoy verb.
 * We assert the level loads in escape mode with a goalTarget (the exit), the
 * objective is SPOKEN, a decoy keypress is announced (the verb is eyes-free),
 * and walking the quiet acoustic-foam corridor to the exit triggers the escape
 * win. The start already faces the exit (yaw 0 = -z), so no turn is needed.
 */
test('loads in escape mode and speaks the objective', async ({ page }) => {
  await beginLevel(page, 'stealth-escape');

  const s = await debugState(page);
  expect(s.goal).toBe('escape');
  expect(s.goalTarget).toBeTruthy();
  expect(s.distance).toBeGreaterThan(0);

  await expect
    .poll(async () => (await liveText(page)).toLowerCase())
    .toMatch(/exit|without being heard/);
});

test('pressing T throws a decoy and announces it', async ({ page }) => {
  await beginLevel(page, 'stealth-escape');
  await page.keyboard.press('t');
  await expect
    .poll(async () => (await liveText(page)).toLowerCase())
    .toMatch(/decoy thrown/);
});

test('walking the quiet corridor to the exit triggers an escape win', async ({ page }) => {
  await beginLevel(page, 'stealth-escape');

  // Start faces the exit (-z) along the silent foam corridor; the monster is off
  // to the side and never hears the foam steps, so a straight walk escapes.
  const won = await walkToTarget(page, 120);
  expect(won).toBe(true);

  await expect
    .poll(async () => (await liveText(page)).toLowerCase())
    .toMatch(/escaped|level complete|you win/);
});
