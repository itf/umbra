import { test, expect } from '@playwright/test';
import { CALIBRATION_DONE_KEY, TUTORIAL_DONE_KEY } from '../src/ui/onboardingStore';

/**
 * Guided onboarding smoke (Build 5A): a FRESH user (no onboarding flags) meets the
 * graduated tutorial — the seated LOCALIZING lesson first, then is able to skip
 * through to the Begin screen; a RETURNING user (flags set) goes straight to Begin.
 *
 * We pre-set the calibration flag (calibration plays positioned tones that need a
 * real audio gesture and is covered elsewhere) so we land directly on the tutorial
 * screen and exercise the new lessons + skip path without flaky audio.
 */

/** Land directly on the tutorial: calibration done, tutorial NOT done. */
async function freshTutorial(page: import('@playwright/test').Page) {
  await page.addInitScript(
    ([calKey]) => {
      try {
        localStorage.setItem(calKey, '1');
      } catch { /* private mode — in-memory fallback still gates */ }
    },
    [CALIBRATION_DONE_KEY],
  );
}

test('fresh user lands on the graduated tutorial (localizing first) and can skip to Begin', async ({ page }) => {
  await freshTutorial(page);
  await page.goto('/?level=small-concrete-room&debug=1');

  // The tutorial screen is shown (not the Begin screen) for a fresh user.
  const tutorial = page.locator('#tutorial-screen');
  await expect(tutorial).toBeVisible();
  await expect(page.locator('#start-screen')).toBeHidden();

  // The spoken intro mentions the localization-first progression + the controls.
  await expect
    .poll(async () => ((await page.locator('#status').textContent()) ?? '').toLowerCase())
    .toMatch(/left.*right.*ahead|localiz/);

  // Skip the whole tutorial → fall through the gate to the Begin screen.
  await tutorial.getByRole('button', { name: /skip tutorial/i }).click();
  await expect(page.locator('#start-button')).toBeVisible();
});

test('first-time stealth level speaks the new-mode primer (decoy verb), once', async ({ page }) => {
  // Calibration + tutorial done, but the stealth primer NOT seen → primer fires.
  await page.addInitScript(
    ([calKey, tutKey]) => {
      try {
        localStorage.setItem(calKey, '1');
        localStorage.setItem(tutKey, '1');
      } catch { /* in-memory fallback */ }
    },
    [CALIBRATION_DONE_KEY, TUTORIAL_DONE_KEY],
  );
  await page.goto('/?level=stealth-escape&debug=1');
  await page.locator('#start-button').click();
  await expect(page.locator('#game-screen')).toBeVisible();

  // The in-context primer teaches the verb (decoy) the first time only.
  await expect
    .poll(async () => ((await page.locator('#alerts').textContent()) ?? '').toLowerCase())
    .toMatch(/new mode.*stealth|decoy/);
});

test('returning user (flags set) skips onboarding straight to Begin', async ({ page }) => {
  await page.addInitScript(
    ([calKey, tutKey]) => {
      try {
        localStorage.setItem(calKey, '1');
        localStorage.setItem(tutKey, '1');
      } catch { /* in-memory fallback */ }
    },
    [CALIBRATION_DONE_KEY, TUTORIAL_DONE_KEY],
  );
  await page.goto('/?level=small-concrete-room&debug=1');

  await expect(page.locator('#start-button')).toBeVisible();
  await expect(page.locator('#tutorial-screen')).toBeHidden();
  await expect(page.locator('#calibration-screen')).toBeHidden();
});
