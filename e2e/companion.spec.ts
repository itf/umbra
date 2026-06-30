import { test, expect } from '@playwright/test';
import { beginLevel, liveText } from './helpers';

/**
 * Companion-voice smoke: with the companion ON (the default), starting a level
 * eventually speaks a characterful objective-framing line through the live
 * region (in addition to the plain objective). With `?companion=off` it never
 * does — pure-acoustics players are respected. Both assertions watch the SAME
 * region, so they exercise the real opt-in wiring.
 */
const LEVEL = 'small-concrete-room';

// A fragment unique to the beacon companion START lines (companion.ts), not the
// plain objective ("Walk to the beacon ahead…").
const COMPANION_FRAGMENT = /beacon is calling|follow the sound ahead/i;

test('companion ON speaks an objective-framing line at level start', async ({ page }) => {
  await beginLevel(page, LEVEL); // default: companion enabled
  await expect
    .poll(async () => (await liveText(page)).toLowerCase(), { timeout: 5000 })
    .toMatch(COMPANION_FRAGMENT);
});

test('?companion=off never speaks a companion line', async ({ page }) => {
  await beginLevel(page, LEVEL, 'companion=off');
  // Give the start line ample time to (not) fire, then assert it never did.
  await page.waitForTimeout(2500);
  const text = (await liveText(page)).toLowerCase();
  expect(text).not.toMatch(COMPANION_FRAGMENT);
  // The plain objective still works whether the companion is on or off.
  expect(text).toMatch(/walk to the beacon/);
});
