import { test, expect } from '@playwright/test';

/**
 * Trainer Room-B-visibility bug fix + keyboard play.
 *
 *  - A SINGLE-scene exercise (e.g. `direction`) must hide the "Play Room B"
 *    affordance entirely — the old bug showed a dead Room B button.
 *  - An A/B exercise (e.g. `larger`) must show both Room A and Room B.
 *  - The keyboard scheme is additive: pressing A announces playback, Q/E move the
 *    answer selection, and Enter confirms (the live region carries it all).
 *
 * Audio boots on Begin (the required user gesture); we don't assert sound, only
 * the DOM/announcement wiring, so the test is robust and non-flaky.
 */

async function begin(page: import('@playwright/test').Page, type: string) {
  await page.goto('/trainer.html');
  await page.selectOption('#type', type);
  // Fixed-easy difficulty keeps the question deterministic-ish (not required, but
  // avoids any adaptive surprises); the predicate under test is type-driven anyway.
  await page.selectOption('#difficulty-mode', '0');
  await page.locator('#begin').click();
  await expect(page.locator('#drill')).toBeVisible();
}

test('single-scene exercise hides the Play Room B control', async ({ page }) => {
  await begin(page, 'direction');
  // The whole A/B row is hidden; the single "Play sound" row is shown instead.
  await expect(page.locator('#play-ab')).toBeHidden();
  await expect(page.locator('#play-single')).toBeVisible();
  // Even if found, Room B is disabled so it can never fire.
  await expect(page.locator('#play-b')).toBeDisabled();
});

test('A/B exercise shows both Room A and Room B', async ({ page }) => {
  await begin(page, 'larger');
  await expect(page.locator('#play-ab')).toBeVisible();
  await expect(page.locator('#play-a')).toBeVisible();
  await expect(page.locator('#play-b')).toBeVisible();
  await expect(page.locator('#play-b')).toBeEnabled();
});

test('keyboard: A plays, Q/E select an answer, Enter confirms', async ({ page }) => {
  await begin(page, 'larger');
  const live = page.locator('#live');

  // A plays Room A (announced via the live region).
  await page.keyboard.press('a');
  await expect(live).toHaveText(/Playing Room A/i);

  // E moves to an answer; the live region names the highlighted choice.
  await page.keyboard.press('e');
  await expect(live).toHaveText(/Answer: Room A.*confirm/i);
  await page.keyboard.press('e');
  await expect(live).toHaveText(/Answer: Room B.*confirm/i);

  // Enter confirms — feedback is populated and Next becomes enabled.
  await page.keyboard.press('Enter');
  await expect(page.locator('#feedback')).not.toHaveText('');
  await expect(page.locator('#next')).toBeEnabled();
});
