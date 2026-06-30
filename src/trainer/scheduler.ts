/**
 * Interleaved Practice Scheduler for mixed-mode training.
 *
 * BLOCKED → INTERLEAVED transition: while any type is "novice" (< MIN_TRIALS
 * attempts OR staircase threshold < COMPETENCE_THRESHOLD), we keep drilling that
 * type until it clears. This gentle blocking lets absolute beginners build one
 * skill at a time without the confusion of constant switching. Once all active
 * types are competent, we switch to spaced interleaving.
 *
 * INTERLEAVING: no type repeats more than NO_REPEAT_CAP times in a row; selection
 * is weighted by (1 − recentAccuracy) over the last ACCURACY_WINDOW trials per
 * type, so weaker types are visited more often. New/unstarted types default to
 * weight 0.7 (moderate pull toward them).
 *
 * Per-type staircases are INDEPENDENT: switching types resumes each type's own
 * difficulty exactly where it left off.
 *
 * Pure, no DOM, no global randomness: inject `rng` for deterministic tests.
 */

import { Staircase, type StaircaseConfig } from './adaptive';
import type { ExerciseType } from './exercises';

// --- Tuneable constants -------------------------------------------------------

/** Minimum trials before a type leaves "novice" status (independent of threshold). */
export const MIN_TRIALS = 6;

/**
 * Staircase threshold at or above which a type is considered competent.
 * threshold() returns difficulty in [0,1]; lower = better. We treat a type as
 * competent once it parks at ≥ 0.5 difficulty — the learner can handle mid-range
 * contrast — so blocked practice ends early enough to be helpful but late enough
 * to build a real foundation.
 */
export const COMPETENCE_THRESHOLD = 0.5;

/** Maximum consecutive picks of the same type before the scheduler forces a switch. */
export const NO_REPEAT_CAP = 3;

/** Recent-accuracy window (last N trials per type). */
export const ACCURACY_WINDOW = 5;

/** Default weight for a type that has no recent accuracy data (unstarted). */
export const DEFAULT_WEIGHT = 0.7;

// --- Types -------------------------------------------------------------------

export interface SchedulerSnapshot {
  staircases: Record<string, StaircaseSnapshot>;
  recentResults: Record<string, boolean[]>;
  trialCounts: Record<string, number>;
}

interface StaircaseSnapshot {
  difficulty: number;
  step: number;
  lastDir: 0 | 1 | -1;
  consecCorrect: number;
  consecIncorrect: number;
  streakCount: number;
  reversalDifficulties: number[];
}

// --- Scheduler ---------------------------------------------------------------

/** Default staircase config: identical to the one trainer.ts uses implicitly. */
const DEFAULT_STAIRCASE_CFG: StaircaseConfig = {};

export type Rng = () => number;

export class InterleavedScheduler {
  private readonly cfg: StaircaseConfig;
  private readonly rng: Rng;

  /** One Staircase per type, lazy-created on first access. */
  private readonly staircases = new Map<string, Staircase>();

  /** Last ACCURACY_WINDOW results (true=correct) per type. */
  private readonly recentResults = new Map<string, boolean[]>();

  /** Total trial count per type (for MIN_TRIALS gate). */
  private readonly trialCounts = new Map<string, number>();

  constructor(cfg: StaircaseConfig = DEFAULT_STAIRCASE_CFG, rng: Rng = Math.random) {
    this.cfg = cfg;
    this.rng = rng;
  }

  // --- Public API ---

  /**
   * Pick the next exercise type for mixed-mode practice.
   *
   * @param available  The full set of types currently in rotation.
   * @param lastType   The type just asked (undefined on the first question).
   * @param consecutive  How many times in a row `lastType` has been picked.
   */
  nextType(available: ExerciseType[], lastType?: ExerciseType, consecutive = 0): ExerciseType {
    if (available.length === 0) throw new Error('scheduler: available types must not be empty');
    if (available.length === 1) return available[0];

    // Phase 1: find novice types. If any exist, drill one (blocked phase).
    const novices = available.filter((t) => !this.isCompetent(t));
    if (novices.length > 0) {
      // Among novices, prefer the one with fewest trials (least practiced first).
      // Consecutive cap still applies so we don't get stuck on one forever when
      // multiple novices exist.
      const forcedSwitch = lastType != null && novices.includes(lastType) && consecutive >= NO_REPEAT_CAP;
      if (!forcedSwitch && lastType != null && novices.includes(lastType)) {
        // Keep drilling the current novice type.
        return lastType;
      }
      // Pick the novice with the fewest trials (or random among ties).
      return this.pickLeastPracticed(novices, lastType);
    }

    // Phase 2: all types competent — interleaved, weighted by weakness.
    // Enforce no-repeat cap.
    const eligible = consecutive >= NO_REPEAT_CAP && lastType != null
      ? available.filter((t) => t !== lastType)
      : available;

    return this.weightedPick(eligible, lastType);
  }

  /** Record the result of a trial and update the type's staircase + accuracy window. */
  recordResult(type: ExerciseType, correct: boolean, _difficulty: number): void {
    this.getStaircase(type).record(correct);

    const recent = this.recentResults.get(type) ?? [];
    recent.push(correct);
    if (recent.length > ACCURACY_WINDOW) recent.shift();
    this.recentResults.set(type, recent);

    this.trialCounts.set(type, (this.trialCounts.get(type) ?? 0) + 1);
  }

  /** Current adaptive difficulty for this type (delegates to its Staircase). */
  difficultyFor(type: ExerciseType): number {
    return this.getStaircase(type).current();
  }

  /**
   * True when a type has enough trials AND its staircase threshold meets the bar.
   * Both gates matter: a lucky streak early can push threshold high prematurely;
   * MIN_TRIALS ensures the estimate is based on real exposure.
   */
  isCompetent(type: ExerciseType): boolean {
    const trials = this.trialCounts.get(type) ?? 0;
    if (trials < MIN_TRIALS) return false;
    return this.getStaircase(type).threshold() >= COMPETENCE_THRESHOLD;
  }

  /** Serialisable snapshot of all per-type state. */
  getSnapshot(): SchedulerSnapshot {
    const staircases: Record<string, StaircaseSnapshot> = {};
    for (const [t, sc] of this.staircases) {
      staircases[t] = extractStaircaseSnapshot(sc);
    }
    const recentResults: Record<string, boolean[]> = {};
    for (const [t, r] of this.recentResults) recentResults[t] = [...r];
    const trialCounts: Record<string, number> = {};
    for (const [t, n] of this.trialCounts) trialCounts[t] = n;
    return { staircases, recentResults, trialCounts };
  }

  /** Restore state from a snapshot (call before any nextType/recordResult). */
  loadSnapshot(snap: SchedulerSnapshot): void {
    this.staircases.clear();
    this.recentResults.clear();
    this.trialCounts.clear();
    for (const [t, ss] of Object.entries(snap.staircases)) {
      const sc = new Staircase(this.cfg);
      applyStaircaseSnapshot(sc, ss);
      this.staircases.set(t, sc);
    }
    for (const [t, r] of Object.entries(snap.recentResults)) {
      this.recentResults.set(t, [...r]);
    }
    for (const [t, n] of Object.entries(snap.trialCounts)) {
      this.trialCounts.set(t, n);
    }
  }

  // --- Private helpers ---------------------------------------------------------

  private getStaircase(type: string): Staircase {
    if (!this.staircases.has(type)) {
      this.staircases.set(type, new Staircase(this.cfg));
    }
    return this.staircases.get(type)!;
  }

  /** Weight for a type: (1 − recentAccuracy); DEFAULT_WEIGHT if no data yet. */
  weightFor(type: ExerciseType): number {
    const recent = this.recentResults.get(type);
    if (!recent || recent.length === 0) return DEFAULT_WEIGHT;
    const acc = recent.filter(Boolean).length / recent.length;
    return 1 - acc;
  }

  private weightedPick(candidates: ExerciseType[], exclude?: ExerciseType): ExerciseType {
    // Filter to avoid picking excluded type when we have alternatives.
    const pool = candidates.length > 1 && exclude != null
      ? candidates.filter((t) => t !== exclude)
      : candidates;
    // Fall back to the full list if filtering emptied it (shouldn't happen after cap logic).
    const actual = pool.length > 0 ? pool : candidates;

    const weights = actual.map((t) => Math.max(0.01, this.weightFor(t)));
    const total = weights.reduce((a, b) => a + b, 0);
    let r = this.rng() * total;
    for (let i = 0; i < actual.length; i++) {
      r -= weights[i];
      if (r <= 0) return actual[i];
    }
    return actual[actual.length - 1];
  }

  private pickLeastPracticed(novices: ExerciseType[], exclude?: ExerciseType): ExerciseType {
    const pool = novices.length > 1 && exclude != null
      ? novices.filter((t) => t !== exclude)
      : novices;
    const actual = pool.length > 0 ? pool : novices;
    // Sort by trial count ascending; among ties pick randomly.
    const minTrials = Math.min(...actual.map((t) => this.trialCounts.get(t) ?? 0));
    const least = actual.filter((t) => (this.trialCounts.get(t) ?? 0) === minTrials);
    return least[Math.floor(this.rng() * least.length)];
  }
}

// --- Staircase snapshot helpers (access private fields via type assertion) -----
// Staircase doesn't expose a serialize API, so we read the private fields through
// a structural cast. This is fragile to internal renames but keeps adaptive.ts
// untouched (no engine/ui edits required). If adaptive.ts ever adds serialize(),
// swap these out.

interface StaircaseInternal {
  difficulty: number;
  step: number;
  lastDir: 0 | 1 | -1;
  consecCorrect: number;
  consecIncorrect: number;
  streakCount: number;
  reversalDifficulties: number[];
}

function extractStaircaseSnapshot(sc: Staircase): StaircaseSnapshot {
  const s = sc as unknown as StaircaseInternal;
  return {
    difficulty: s.difficulty,
    step: s.step,
    lastDir: s.lastDir,
    consecCorrect: s.consecCorrect,
    consecIncorrect: s.consecIncorrect,
    streakCount: s.streakCount,
    reversalDifficulties: [...s.reversalDifficulties],
  };
}

function applyStaircaseSnapshot(sc: Staircase, snap: StaircaseSnapshot): void {
  const s = sc as unknown as StaircaseInternal;
  s.difficulty = snap.difficulty;
  s.step = snap.step;
  s.lastDir = snap.lastDir;
  s.consecCorrect = snap.consecCorrect;
  s.consecIncorrect = snap.consecIncorrect;
  s.streakCount = snap.streakCount;
  s.reversalDifficulties = [...snap.reversalDifficulties];
}
