/**
 * Best Times / Progress screen: seed a per-level best + a daily streak into
 * localStorage, open the screen from the picker, and assert the spoken overview
 * (cleared-count + streak) lands in the live region and a best time is shown.
 */
import { test, expect } from '@playwright/test';
import { SCORES_KEY } from '../src/game/scoreStore';
import { DAILY_STREAK_KEY } from '../src/trainer/dailyStreakStore';

test('progress screen announces cleared-count and streak', async ({ page }) => {
  // Seed one cleared level (keyed by display name) + a 5-day streak BEFORE load.
  await page.addInitScript(
    ([scoresKey, streakKey]) => {
      try {
        localStorage.setItem(
          scoresKey,
          JSON.stringify({ 'Beacon Meadow': { best: { timeMs: 38_000, clapsUsed: 0 }, completions: 1, last: { timeMs: 38_000, clapsUsed: 0 } } }),
        );
        localStorage.setItem(
          streakKey,
          JSON.stringify({ currentStreak: 5, longestStreak: 8, lastCompletedDate: '2026-06-29', totalDays: 30 }),
        );
      } catch {
        /* private mode — screen still renders, just unseeded */
      }
    },
    [SCORES_KEY, DAILY_STREAK_KEY] as const,
  );

  await page.goto('/');

  // The picker is the default entry; open the progress link.
  const link = page.locator('#open-progress');
  await expect(link).toBeVisible();
  await link.click();

  // The spoken overview rides the polite #status live region on open.
  const status = page.locator('#status');
  await expect(status).toContainText(/of \d+ levels cleared\./);
  await expect(status).toContainText('Daily streak: 5 days');

  // The cleared level's best time is shown on screen.
  const screen = page.locator('#progress-screen');
  await expect(screen).toContainText('Best: 38 seconds');
  await expect(screen).toContainText('Daily streak: 5 days');

  // Back returns to the picker.
  await page.locator('.progress-back').click();
  await expect(page.locator('#picker-screen')).toBeVisible();
});
