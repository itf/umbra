import { test, expect } from '@playwright/test';
import { beginLevel, liveText } from './helpers';
import { TTS_ENABLED_KEY, TTS_RATE_KEY } from '../src/ui/settingsStore';

/**
 * Spoken-voice (TTS, 8A) settings smoke. Asserts the SETTINGS WIRING only — never
 * real audio (headless engines may not implement speechSynthesis). The TTS block
 * only renders when the browser reports a speech engine, so we guard: if the
 * toggle isn't present we skip (graceful-fallback path, not a failure).
 */
const LEVEL = 'small-concrete-room';

test('TTS settings: toggle on persists (opt-in), rate persists', async ({ page }) => {
  await beginLevel(page, LEVEL);
  await page.locator('#open-settings').click();
  await expect(page.locator('#settings-screen .settings-dialog')).toBeVisible();

  const tts = page.getByLabel('Spoken voice (text-to-speech)');
  if ((await tts.count()) === 0) {
    test.skip(true, 'No speechSynthesis in this engine — graceful live-region-only fallback.');
    return;
  }

  // Default OFF (opt-in — no double-speak for screen-reader users).
  await expect(tts).not.toBeChecked();
  expect(await page.evaluate((k) => localStorage.getItem(k), TTS_ENABLED_KEY)).toBeNull();

  // Turn it on → persists '1' and the voice/rate sub-controls appear.
  await tts.check();
  await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), TTS_ENABLED_KEY)).toBe('1');
  await expect.poll(async () => (await liveText(page)).toLowerCase()).toContain('spoken voice on');
  await expect(page.getByLabel('Spoken voice selection')).toBeVisible();
  await expect(page.getByLabel('Voice speed')).toBeVisible();

  // Rate slider persists a clamped value.
  await page.getByLabel('Voice speed').fill('1.5');
  await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), TTS_RATE_KEY)).toBe('1.5');

  // Survives a reload (persisted, control reflects it).
  await page.reload();
  // Re-begin and reopen settings.
  const begin = page.locator('#start-button');
  await expect(begin).toBeVisible();
  await begin.click();
  await page.locator('#open-settings').click();
  await expect(page.getByLabel('Spoken voice (text-to-speech)')).toBeChecked();
});
