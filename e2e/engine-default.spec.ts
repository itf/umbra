import { test, expect } from '@playwright/test';
import { beginLevel, debugState } from './helpers';

/**
 * The high-fidelity (Steam Audio) engine is the DEFAULT: with no saved Settings
 * preference and no ?engine= URL param, beginning a level must boot the Steam
 * backend (debugState().engine === 'steam'), not our fallback engine. The backend
 * loads three + the 6 MB WASM asynchronously after Begin, so poll.
 */
test('high-fidelity engine boots by default (no pref, no URL param)', async ({ page }) => {
  await beginLevel(page, 'small-concrete-room');
  await expect
    .poll(async () => (await debugState(page)).engine, { timeout: 30_000 })
    .toBe('steam');
});

/** An explicit ?engine=ours opt-out still selects our engine. */
test('?engine=ours opts out of the high-fidelity default', async ({ page }) => {
  await beginLevel(page, 'small-concrete-room', 'engine=ours');
  await expect
    .poll(async () => (await debugState(page)).engine, { timeout: 30_000 })
    .not.toBe('steam');
});
