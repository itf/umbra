/**
 * Score model — the PURE, testable core behind per-level bests + replay.
 *
 * A level run ends in a WIN (reached the goal) or a loss (caught). Only WINS are
 * scored: a completion records the elapsed TIME (primary metric) and the number of
 * claps used (secondary), so finishing faster — or with fewer sonar probes — beats
 * a previous run. Caught runs carry no score (they don't complete the level).
 *
 * METRIC (documented, kept simple):
 *   1. TIME to complete (timeMs) — lower is better. The primary chase metric.
 *   2. CLAPS used — lower is better, used only to break a time TIE (same second).
 * We compare to the second to avoid sub-second jitter making every run a "new best".
 *
 * Everything here is pure: no clock, no storage, no DOM. The game injects the
 * elapsed ms (measured off the audio/monotonic clock); these functions only compare
 * and phrase. That keeps the model deterministic + unit-testable.
 */

/** One level-completion result. `caughtCount` is informational (loud runs). */
export interface LevelResult {
  levelId: string;
  /** Elapsed wall time from level start to win, in milliseconds. */
  timeMs: number;
  /** Sonar claps consumed during the run (0 when the level is clap-free). */
  clapsUsed: number;
  /** Times caught before completing (0 in normal play; reserved for future retries). */
  caughtCount?: number;
  /** True for a completion (the only scored outcome). */
  won: boolean;
}

/** A persisted best for one level (the score-defining fields only). */
export interface LevelBest {
  timeMs: number;
  clapsUsed: number;
}

/** Whole-second bucket — the comparison granularity (sub-second jitter ignored). */
function seconds(timeMs: number): number {
  return Math.round(timeMs / 1000);
}

/**
 * Is `next` a better score than `prev`? Lower TIME wins (compared at second
 * granularity); on a tie, fewer CLAPS wins. A null `prev` (no prior best) means any
 * completion is a new best. Pure + total.
 */
export function betterScore(prev: LevelBest | null | undefined, next: LevelBest): boolean {
  if (!prev) return true;
  const ps = seconds(prev.timeMs);
  const ns = seconds(next.timeMs);
  if (ns !== ps) return ns < ps;
  return next.clapsUsed < prev.clapsUsed;
}

/** Project a result down to its score-defining best fields. */
export function toBest(result: LevelResult): LevelBest {
  return { timeMs: result.timeMs, clapsUsed: result.clapsUsed };
}

/** Render a duration as a concise spoken phrase ("42 seconds", "1 minute 5 seconds"). */
export function formatDuration(timeMs: number): string {
  const total = Math.max(0, Math.round(timeMs / 1000));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  const sp = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  if (mins === 0) return sp(secs, 'second');
  if (secs === 0) return sp(mins, 'minute');
  return `${sp(mins, 'minute')} ${sp(secs, 'second')}`;
}

/** Render a clap count ("6 claps", "1 clap"), or '' when the level was clap-free. */
function formatClaps(clapsUsed: number): string {
  if (clapsUsed <= 0) return '';
  return `${clapsUsed} ${clapsUsed === 1 ? 'clap' : 'claps'}`;
}

/**
 * PURE: the spoken completion line. Always states the run's time (+ claps when any);
 * then either "New best!" (when `isBest`) or the standing best for comparison.
 *
 *   "Completed in 42 seconds, 6 claps. New best!"
 *   "Completed in 50 seconds. Your best is 42 seconds."
 */
export function announceCompletion(
  result: LevelResult,
  isBest: boolean,
  previousBest: LevelBest | null | undefined,
): string {
  const claps = formatClaps(result.clapsUsed);
  const head = `Completed in ${formatDuration(result.timeMs)}${claps ? `, ${claps}` : ''}.`;
  if (isBest) return `${head} New best!`;
  if (previousBest) return `${head} Your best is ${formatDuration(previousBest.timeMs)}.`;
  return head;
}

/**
 * PURE: a short readout of a stored best for the picker ("Best: 42 seconds, 6 claps"),
 * or '' when there is no best yet. Used to surface bests in the level list.
 */
export function summarizeBest(best: LevelBest | null | undefined): string {
  if (!best) return '';
  const claps = formatClaps(best.clapsUsed);
  return `Best: ${formatDuration(best.timeMs)}${claps ? `, ${claps}` : ''}`;
}
