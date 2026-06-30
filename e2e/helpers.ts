import { type Page, expect } from '@playwright/test';
import {
  CALIBRATION_DONE_KEY,
  TUTORIAL_DONE_KEY,
  MODE_PRIMER_KEY,
} from '../src/ui/onboardingStore';

/**
 * Mark first-run onboarding (calibration + tutorial) as already complete BEFORE
 * the app script runs, so a preselected `?level=…` jumps straight to the Begin
 * screen. We use addInitScript (runs before any page script) rather than clicking
 * "Skip" so the gate is robust regardless of onboarding UI changes.
 */
export async function skipOnboarding(page: Page) {
  await page.addInitScript(
    ([calKey, tutKey, primerKeys]) => {
      try {
        localStorage.setItem(calKey, '1');
        localStorage.setItem(tutKey, '1');
        // Returning/expert users have already met every mode, so suppress the
        // first-time per-mode primers too — tests assert the steady-state objective.
        for (const k of primerKeys as string[]) localStorage.setItem(k, '1');
      } catch {
        /* private mode — the in-memory fallback still gates, just not persisted */
      }
    },
    [CALIBRATION_DONE_KEY, TUTORIAL_DONE_KEY, Object.values(MODE_PRIMER_KEY)] as const,
  );
}

/**
 * Open a level (with onboarding skipped), get past the Begin gesture gate, and
 * wait until the game screen + the ?debug=1 test hook are live. Always appends
 * ?debug=1 so the read-only state hook (window.__ps) is attached.
 */
export async function beginLevel(page: Page, levelId: string, extraParams = '') {
  await skipOnboarding(page);
  const q = new URLSearchParams({ level: levelId, debug: '1' });
  await page.goto(`/?${q.toString()}${extraParams ? '&' + extraParams : ''}`);

  // Preselected level → Begin screen. Click Begin (the required user gesture for
  // audio) and wait for the game screen to reveal.
  const begin = page.locator('#start-button');
  await expect(begin).toBeVisible();
  await begin.click();

  await expect(page.locator('#game-screen')).toBeVisible();
  // The hook is attached right after the game is constructed (debug path).
  await page.waitForFunction(() => !!(window as unknown as { __ps?: unknown }).__ps);
}

/** Read the read-only debug state exposed by the ?debug=1 test hook. */
export async function debugState(page: Page) {
  return page.evaluate(() =>
    (window as unknown as { __ps: { debugState: () => DebugStateShape } }).__ps.debugState(),
  );
}

export interface DebugStateShape {
  player: { x: number; z: number; yaw: number };
  beacon: { x: number; z: number };
  goal: 'beacon' | 'absorber' | 'escape';
  goalTarget: { x: number; z: number };
  distance: number;
  engine: string;
  decoysLeft?: number;
  monster?: { x: number; z: number } | null;
}

/** The combined ARIA live-region text (#status polite + #alerts assertive). */
export async function liveText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const s = document.getElementById('status')?.textContent ?? '';
    const a = document.getElementById('alerts')?.textContent ?? '';
    return `${s} ${a}`.trim();
  });
}

/**
 * Drive a deterministic walk to the win target by alternating L/R steps through
 * the debug step hook, using an explicit, well-spaced monotonic clock so the
 * cadence/alternation rules are satisfied and never flake on the headless audio
 * clock. The player must already be facing the target (the caller turns first, or
 * the level's start yaw already points at it). Returns once won or after maxSteps.
 */
export async function walkToTarget(page: Page, maxSteps = 60): Promise<boolean> {
  return page.evaluate((max) => {
    const ps = (window as unknown as {
      __ps: {
        step: (foot: 'L' | 'R', nowMs: number) => void;
        won: () => boolean;
      };
    }).__ps;

    let t = 1000;
    let foot: 'L' | 'R' = 'L';
    for (let i = 0; i < max; i++) {
      if (ps.won()) return true;
      ps.step(foot, t);
      foot = foot === 'L' ? 'R' : 'L';
      t += 600; // above rushIntervalMs (220), within the legal cadence band
      if (ps.won()) return true;
    }
    return ps.won();
  }, maxSteps);
}

/**
 * Turn toward (tx,tz) using the REAL keyboard (ArrowLeft/Right), polling the
 * debug state's yaw until aligned. Exercises the actual keyboard-turn handler.
 * yaw 0 faces -z; +yaw turns toward +x.
 */
export async function turnToward(page: Page, tx: number, tz: number, toleranceRad = 0.12) {
  const want = await page.evaluate(([x, z]) => {
    const ps = (window as unknown as { __ps: { debugState: () => DebugStateShape } }).__ps;
    const s = ps.debugState();
    return Math.atan2(x - s.player.x, -(z - s.player.z));
  }, [tx, tz] as const);

  for (let i = 0; i < 120; i++) {
    const cur = (await debugState(page)).player.yaw;
    let diff = want - cur;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    if (Math.abs(diff) <= toleranceRad) return;
    await page.keyboard.press(diff > 0 ? 'ArrowRight' : 'ArrowLeft');
    await page.waitForTimeout(40); // let the heading slew loop apply the nudge
  }
}
