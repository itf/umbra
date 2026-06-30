/**
 * Spoken clap-budget feedback — the PURE text logic behind the eyes-free sonar
 * cues. `main.ts` owns the live region and the `ClapBudget`; this module owns
 * WHAT gets said, so the wording is unit-testable without a DOM or a clock.
 *
 * The design: budget levels are a "sonar-budget survival" experience. Running
 * out is NOT a hard game-over (the win/lose plumbing stays about reaching the
 * beacon) — instead we build tension by SPEAKING the scarcity:
 *
 *  - every successful clap announces how many probes are left;
 *  - the SECOND-TO-LAST clap warns ("Last clap.") so the player braces;
 *  - the clap that empties the budget says it's the last one and that they must
 *    now navigate from memory — a soft, eyes-free "out of sonar" state, no lose;
 *  - a refused clap (already empty / still cooling) is spoken distinctly so the
 *    player understands nothing fired.
 *
 * All functions take plain numbers (remaining, waitMs) so callers inject state
 * from a `ClapBudget` and tests stay deterministic.
 */

import type { ClapRefusal } from './clapBudget';

/** "3 claps left" / "1 clap left" — the bare count phrase (no trailing punctuation). */
export function remainingPhrase(remaining: number): string {
  if (!Number.isFinite(remaining)) return '';
  const n = Math.max(0, Math.floor(remaining));
  return n === 1 ? '1 clap left' : `${n} claps left`;
}

/**
 * What to SAY after a clap that actually fired, given how many claps remain
 * AFTER it. `hasBudget` is false for unlimited levels → empty string (so the
 * caller keeps today's behaviour and says nothing budget-related).
 */
export function clapFiredAnnouncement(remaining: number, hasBudget: boolean): string {
  if (!hasBudget) return '';
  const n = Math.max(0, Math.floor(remaining));
  if (n <= 0) {
    return 'That was your last clap. No sonar left — navigate from memory.';
  }
  if (n === 1) {
    // Second-to-last just fired: one probe remains. Warn so they brace.
    return 'One clap left. Make it count.';
  }
  return `${remainingPhrase(n)}.`;
}

/**
 * What to SAY when a clap is REFUSED (nothing fired). `exhausted` ⇒ the budget
 * is spent; `cooling` ⇒ still echoing, with `waitMs` until ready.
 */
export function clapRefusedAnnouncement(reason: ClapRefusal, waitMs = 0): string {
  if (reason === 'exhausted') {
    return 'No claps left. Navigate from memory.';
  }
  const secs = Math.max(1, Math.ceil(waitMs / 1000));
  return `Still echoing — wait ${secs}s.`;
}

/** Opening cue announced once when a budget level loads. */
export function budgetIntroAnnouncement(remaining: number): string {
  return `Sonar budget: ${remainingPhrase(remaining)}. Clap deliberately.`;
}
