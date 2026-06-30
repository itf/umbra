import { test, expect } from '@playwright/test';
import { DAILY_STREAK_KEY } from '../src/trainer/dailyStreakStore';

/**
 * Daily-challenge smoke: opening the trainer shows today's seeded challenge and
 * the current streak (spoken via the live region / status line), and completing it
 * announces the extended streak. We make it deterministic by:
 *   - pinning "today" with ?date=YYYY-MM-DD (the UI override, no clock faking), and
 *   - seeding localStorage with a known lastCompletedDate = yesterday so completing
 *     today extends the streak to a known value.
 */
const TODAY = '2026-06-29';
const YESTERDAY = '2026-06-28';

async function seedStreak(page: import('@playwright/test').Page) {
  await page.addInitScript(
    ([key, state]) => {
      try {
        localStorage.setItem(key, state);
      } catch {
        /* private mode — store degrades to memory; streak assertions then start fresh */
      }
    },
    [
      DAILY_STREAK_KEY,
      JSON.stringify({
        currentStreak: 4,
        longestStreak: 4,
        lastCompletedDate: YESTERDAY,
        totalDays: 4,
      }),
    ] as const,
  );
}

test('daily panel announces the challenge and current streak', async ({ page }) => {
  await seedStreak(page);
  await page.goto(`/trainer.html?date=${TODAY}`);

  // The resting status line names the challenge + the seeded Day 4 streak — no
  // audio needed (it's populated on load).
  await expect
    .poll(async () => (await page.locator('#daily-status').textContent()) ?? '')
    .toMatch(/Daily challenge:.*Day 4 streak/);
});

test('completing the daily extends and announces the streak', async ({ page }) => {
  await seedStreak(page);
  await page.goto(`/trainer.html?date=${TODAY}`);

  // Start today's challenge (the required audio gesture).
  await page.locator('#daily-begin').click();
  // Drill UI reveals with answer buttons once audio is ready.
  await expect(page.locator('#answers button').first()).toBeVisible({ timeout: 30_000 });

  // Pick the first answer (right or wrong both complete the daily + extend the streak).
  await page.locator('#answers button').first().click();

  // The live region announces the new 5-day streak; the share string appears.
  await expect
    .poll(async () => (await page.locator('#live').textContent()) ?? '')
    .toMatch(/5-day streak/);
  await expect(page.locator('#daily-share-text')).toHaveValue(/papasangre daily 2026-06-29.*5-day streak/);
});
