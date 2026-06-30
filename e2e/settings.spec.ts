import { test, expect } from '@playwright/test';
import { beginLevel, liveText } from './helpers';
import { MASTER_VOLUME_KEY } from '../src/ui/settingsStore';
import { COMPANION_KEY } from '../src/ui/onboardingStore';

/**
 * Settings panel smoke (6C): open the panel (⚙ button), toggle companion voice
 * OFF (assert it persists to localStorage), change the master volume (assert it
 * persists), and run reset-progress (two-step confirm). All operated through the
 * real labeled controls so it exercises the actual accessible wiring.
 */
const LEVEL = 'small-concrete-room';

test('settings: open, toggle companion off (persists), set volume, reset', async ({ page }) => {
  await beginLevel(page, LEVEL);

  // Open via the button; the dialog + heading become visible.
  await page.locator('#open-settings').click();
  await expect(page.locator('#settings-screen .settings-dialog')).toBeVisible();
  await expect.poll(async () => (await liveText(page)).toLowerCase()).toContain('settings opened');

  // Companion voice off → persists to COMPANION_KEY '0'.
  const companion = page.getByLabel('Companion voice');
  await expect(companion).toBeChecked(); // default ON
  await companion.uncheck();
  await expect
    .poll(() => page.evaluate((k) => localStorage.getItem(k), COMPANION_KEY))
    .toBe('0');

  // Master volume slider → persists a clamped 0..1 float.
  const vol = page.getByLabel('Master volume percent');
  await vol.fill('30');
  await expect
    .poll(() => page.evaluate((k) => localStorage.getItem(k), MASTER_VOLUME_KEY))
    .toBe('0.3');

  // Reset progress: first click arms (label changes + spoken confirm), second confirms.
  const reset = page.getByRole('button', { name: /reset progress/i });
  await reset.click();
  await expect(page.getByRole('button', { name: /confirm reset progress/i })).toBeVisible();
  await expect.poll(async () => (await liveText(page)).toLowerCase()).toContain('reset all progress');
  await page.getByRole('button', { name: /confirm reset progress/i }).click();
  await expect.poll(async () => (await liveText(page)).toLowerCase()).toContain('progress reset');
  // Reset wiped the companion pref back to the default-ON; the control reflects it.
  await expect(page.getByLabel('Companion voice')).toBeChecked();
  await expect
    .poll(() => page.evaluate((k) => localStorage.getItem(k), COMPANION_KEY))
    .toBeNull();

  // Escape closes the dialog and returns focus to the game.
  await page.keyboard.press('Escape');
  await expect(page.locator('#settings-screen')).toBeHidden();
});
