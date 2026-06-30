/**
 * Progress summary — the PURE, testable core behind the "Best Times / Progress"
 * screen. It folds the already-stored data (per-level bests from the ScoreStore,
 * the daily-challenge streak from the DailyStreakStore, and optionally the
 * echolocation trainer's bests) into a structured, ANNOUNCEABLE summary.
 *
 * Everything here is pure: no DOM, no storage, no clock. The caller passes in the
 * loaded store data (best-by-level lookups, the streak state, the trainer rows)
 * and gets back structured rows + spoken strings, so counts / grouping / empty
 * states / formatting are all unit-testable in isolation.
 *
 * READ-ONLY: this never mutates the stores or changes scoring/streak semantics —
 * it only re-phrases what is already persisted.
 */
import { formatDuration, type LevelBest } from './scoreModel';

/** The mode/category buckets we group levels under, in display order. */
export type ProgressCategory = 'showcase' | 'beacon' | 'absorber' | 'sonar' | 'stealth';

/** Human heading + a short spoken label for each category, in display order. */
export const PROGRESS_GROUPS: Array<{ category: ProgressCategory; heading: string; mode: string }> = [
  { category: 'showcase', heading: 'Acoustics tour', mode: 'Tour' },
  { category: 'beacon', heading: 'Beacon — navigate to a sound', mode: 'Beacon' },
  { category: 'absorber', heading: 'Absorber — find the dead spot', mode: 'Absorber' },
  { category: 'sonar', heading: 'Sonar — clap on a budget', mode: 'Sonar' },
  { category: 'stealth', heading: 'Stealth — escape the hunter', mode: 'Stealth' },
];

/** One builtin level as the summary needs it (name + its category bucket). */
export interface LevelInfo {
  /** The level's display name — also the key its score is stored under. */
  name: string;
  category: ProgressCategory;
}

/** Streak state the summary reads (a subset of DailyStreakState — read-only). */
export interface StreakInfo {
  currentStreak: number;
  longestStreak: number;
  totalDays: number;
}

/** One trainer exercise's best, for the optional trainer section. */
export interface TrainerInfo {
  /** Human label, e.g. "Direction". */
  label: string;
  /** Lowest (best) threshold in [0,1], or null if never trained. */
  best: number | null;
  sessions: number;
}

/** One level's row in the summary. */
export interface LevelRow {
  name: string;
  best: LevelBest | null;
  cleared: boolean;
  /** Spoken/visible best phrase, or "Not yet cleared" when there's no best. */
  bestText: string;
}

/** One mode group with its level rows + a cleared tally. */
export interface ModeGroup {
  category: ProgressCategory;
  heading: string;
  mode: string;
  rows: LevelRow[];
  cleared: number;
  total: number;
}

/** The whole structured summary. */
export interface ProgressSummary {
  totalLevels: number;
  totalCleared: number;
  groups: ModeGroup[];
  streak: StreakInfo;
  /** The single fastest cleared level, or null when nothing is cleared. */
  fastest: { name: string; best: LevelBest } | null;
  trainer: TrainerInfo[];
}

/** Render a stored best as a row phrase ("42 seconds, 6 claps"), best only. */
function bestPhrase(best: LevelBest): string {
  const claps = best.clapsUsed > 0 ? `, ${best.clapsUsed} ${best.clapsUsed === 1 ? 'clap' : 'claps'}` : '';
  return `${formatDuration(best.timeMs)}${claps}`;
}

/**
 * PURE: build the structured progress summary from already-loaded store data.
 *
 * @param levels  every builtin level (name + category), in any order.
 * @param bestOf  a read-only lookup: level name → its stored best (or null).
 * @param streak  the daily-challenge streak state.
 * @param trainer optional trainer-best rows for the trainer section.
 */
export function buildProgressSummary(
  levels: LevelInfo[],
  bestOf: (name: string) => LevelBest | null,
  streak: StreakInfo,
  trainer: TrainerInfo[] = [],
): ProgressSummary {
  const groups: ModeGroup[] = [];
  let totalLevels = 0;
  let totalCleared = 0;
  let fastest: { name: string; best: LevelBest } | null = null;

  for (const g of PROGRESS_GROUPS) {
    const inGroup = levels.filter((l) => l.category === g.category);
    if (inGroup.length === 0) continue;
    const rows: LevelRow[] = [];
    let cleared = 0;
    for (const l of inGroup) {
      const best = bestOf(l.name);
      const isCleared = best != null;
      if (isCleared) {
        cleared++;
        if (!fastest || best.timeMs < fastest.best.timeMs) fastest = { name: l.name, best };
      }
      rows.push({
        name: l.name,
        best,
        cleared: isCleared,
        bestText: best ? `Best: ${bestPhrase(best)}` : 'Not yet cleared',
      });
    }
    totalLevels += inGroup.length;
    totalCleared += cleared;
    groups.push({
      category: g.category,
      heading: g.heading,
      mode: g.mode,
      rows,
      cleared,
      total: inGroup.length,
    });
  }

  return { totalLevels, totalCleared, groups, streak, fastest, trainer };
}

/** Render the streak as a spoken phrase ("Daily streak: 5 days; longest 8."). */
export function streakPhrase(s: StreakInfo): string {
  if (s.totalDays === 0 && s.currentStreak === 0 && s.longestStreak === 0) {
    return 'No daily challenge completed yet.';
  }
  const day = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;
  return `Daily streak: ${day(s.currentStreak)}; longest ${day(s.longestStreak)}; ${day(s.totalDays)} total.`;
}

/**
 * PURE: a concise SPOKEN overview to announce on open, e.g.
 *   "12 of 27 levels cleared. Daily streak: 5 days; longest 8; 30 days total.
 *    Fastest: Beacon Meadow, 38 seconds."
 */
export function announceProgress(s: ProgressSummary): string {
  const parts: string[] = [`${s.totalCleared} of ${s.totalLevels} levels cleared.`];
  parts.push(streakPhrase(s.streak));
  if (s.fastest) parts.push(`Fastest: ${s.fastest.name}, ${formatDuration(s.fastest.best.timeMs)}.`);
  return parts.join(' ');
}
