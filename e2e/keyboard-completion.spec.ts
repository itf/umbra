import { test, expect } from '@playwright/test';
import { beginLevel, debugState, liveText, walkToTarget, turnToward } from './helpers';

/**
 * THE HEADLINE: keyboard accessibility path, end to end.
 *
 * `small-concrete-room` starts the player at (2, 4.2) facing -z with the beacon
 * straight ahead at (2, 0.8), goalRadius 0.7 — reachable by walking forward, no
 * turn required for completion. We assert a REAL completion (the win fires and the
 * ARIA live region announces it), plus the deterministic mechanics (arrow keys
 * change the announced heading; steps change player position).
 */
const LEVEL = 'small-concrete-room';

test('arrow keys turn and announce a new heading', async ({ page }) => {
  await beginLevel(page, LEVEL);

  const before = (await debugState(page)).player.yaw;
  // Hold-equivalent: several right-arrow presses turn the head toward +x.
  for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(300); // heading slews + the debounced announce fires

  const after = (await debugState(page)).player.yaw;
  expect(Math.abs(after - before)).toBeGreaterThan(0.05);

  // The new heading is announced in the live region (e.g. "Facing east/…").
  await expect
    .poll(async () => (await liveText(page)).toLowerCase())
    .toMatch(/facing|north|south|east|west|left|right|°|degree/);
});

test('the compass widget exposes a slider value that updates when turning', async ({ page }) => {
  await beginLevel(page, LEVEL);

  // The compass SVG is the role=slider widget mounted in #turn-pad. It must be
  // keyboard-focusable and expose its heading to assistive tech via aria-value*.
  const compass = page.locator('#turn-pad [role="slider"]');
  await expect(compass).toHaveAttribute('tabindex', '0');
  await expect(compass).toHaveAttribute('aria-valuemin', '0');
  await expect(compass).toHaveAttribute('aria-valuemax', '359');

  const before = await compass.getAttribute('aria-valuenow');
  const beforeText = await compass.getAttribute('aria-valuetext');
  expect(beforeText).toBeTruthy();

  // Turning via the global arrow handler must update the widget's exposed value.
  for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(300); // let the slew loop apply + setHeading run

  await expect.poll(async () => compass.getAttribute('aria-valuenow')).not.toBe(before);
  await expect
    .poll(async () => (await compass.getAttribute('aria-valuetext'))?.toLowerCase() ?? '')
    .toMatch(/facing|degree|north|south|east|west/);
});

test('step keys move the player toward the beacon', async ({ page }) => {
  await beginLevel(page, LEVEL);

  const start = await debugState(page);
  // A = left foot. One real key press should land a step and reduce distance
  // (start yaw already faces the beacon).
  await page.keyboard.press('a');
  await expect
    .poll(async () => (await debugState(page)).distance)
    .toBeLessThan(start.distance);
});

test('keyboard completion reaches the beacon and announces a win', async ({ page }) => {
  await beginLevel(page, LEVEL);

  // Robustness: re-aim at the beacon via real arrow keys (start already faces it,
  // so this is a no-op or a tiny correction), then walk it in.
  const s0 = await debugState(page);
  await turnToward(page, s0.beacon.x, s0.beacon.z);

  const won = await walkToTarget(page);
  expect(won).toBe(true);

  // Win is detectable via state AND announced in the assertive live region.
  await expect.poll(async () => (await debugState(page)).distance).toBeLessThanOrEqual(0.7);
  await expect
    .poll(async () => (await liveText(page)).toLowerCase())
    .toMatch(/win|reached the beacon|level complete/);

  // SCORING: completing the level announces a spoken completion stat (time + claps),
  // and the first completion is a new best.
  await expect
    .poll(async () => (await liveText(page)).toLowerCase())
    .toMatch(/completed in .*second/);
  await expect
    .poll(async () => (await liveText(page)).toLowerCase())
    .toMatch(/new best/);
});

test('replaying a completed level announces a comparison to the stored best', async ({ page }) => {
  // First run: complete it so a best is stored in localStorage.
  await beginLevel(page, LEVEL);
  {
    const s0 = await debugState(page);
    await turnToward(page, s0.beacon.x, s0.beacon.z);
    expect(await walkToTarget(page)).toBe(true);
    await expect
      .poll(async () => (await liveText(page)).toLowerCase())
      .toMatch(/completed in .*second/);
  }

  // Replay (same page → localStorage persists across the reload).
  await beginLevel(page, LEVEL);
  const s1 = await debugState(page);
  await turnToward(page, s1.beacon.x, s1.beacon.z);
  expect(await walkToTarget(page)).toBe(true);

  // The second completion references the standing best (new best OR "your best is…").
  await expect
    .poll(async () => (await liveText(page)).toLowerCase())
    .toMatch(/new best|your best is/);
});
