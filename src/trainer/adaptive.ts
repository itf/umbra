/**
 * Pure, deterministic ADAPTIVE STAIRCASE for the Echolocation Trainer.
 *
 * The classic psychophysics method for tracking a learner's discrimination
 * THRESHOLD. Instead of the old punitive streak ramp (one miss → reset to easy),
 * a transformed up/down staircase parks difficulty near the threshold:
 *
 *   - After N consecutive CORRECT answers → make it HARDER (difficulty up).
 *   - After M consecutive INCORRECT answers → make it EASIER (difficulty down).
 *
 * With the default N-down=2 / M-up=1 the staircase converges to ≈71% correct
 * (the classic 2-down/1-up rule); 3-down/1-up targets ≈79%. The STEP SIZE starts
 * large and HALVES at each REVERSAL (a change of direction) down to a floor, so
 * the difficulty homes in rather than oscillating forever. The THRESHOLD estimate
 * is the mean difficulty over the last K reversals — that number is the mastery
 * score.
 *
 * No DOM, no Web Audio, no module-scope randomness: same sequence of
 * (correct/incorrect) → identical difficulty trajectory. Fully unit-testable.
 */

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export interface StaircaseConfig {
  /** Consecutive correct answers needed before stepping UP (harder). Default 2. */
  down?: number;
  /** Consecutive incorrect answers needed before stepping DOWN (easier). Default 1. */
  up?: number;
  /** Starting difficulty in [0,1]. Default 0 (easiest). */
  start?: number;
  /** Initial step size. Default 0.2. */
  startStep?: number;
  /** Step size floor (steps stop shrinking here). Default 0.04. */
  minStep?: number;
  /** Reversals averaged for the threshold estimate. Default 6. */
  thresholdReversals?: number;
}

/** A reversal-tracking transformed up/down staircase over difficulty ∈ [0,1]. */
export class Staircase {
  readonly down: number;
  readonly up: number;
  readonly startStep: number;
  readonly minStep: number;
  readonly thresholdReversals: number;

  private difficulty: number;
  private step: number;
  /** +1 = last move was harder, -1 = easier, 0 = no move yet. */
  private lastDir: 0 | 1 | -1 = 0;
  private consecCorrect = 0;
  private consecIncorrect = 0;
  /** Difficulty at each reversal, in order. */
  private reversalDifficulties: number[] = [];

  constructor(cfg: StaircaseConfig = {}) {
    this.down = Math.max(1, cfg.down ?? 2);
    this.up = Math.max(1, cfg.up ?? 1);
    this.startStep = cfg.startStep ?? 0.2;
    this.minStep = cfg.minStep ?? 0.04;
    this.thresholdReversals = Math.max(1, cfg.thresholdReversals ?? 6);
    this.difficulty = clamp01(cfg.start ?? 0);
    this.step = this.startStep;
  }

  /** Current difficulty in [0,1] — feed this to the question generator. */
  current(): number {
    return this.difficulty;
  }

  /** Number of reversals (direction changes) seen so far. */
  get reversals(): number {
    return this.reversalDifficulties.length;
  }

  /** Current step size (shrinks at reversals). */
  get stepSize(): number {
    return this.step;
  }

  /**
   * Record an answer and move the staircase. Returns the new difficulty.
   * Moving HARDER means raising difficulty; EASIER means lowering it.
   */
  record(correct: boolean): number {
    if (correct) {
      this.consecCorrect++;
      this.consecIncorrect = 0;
    } else {
      this.consecIncorrect++;
      this.consecCorrect = 0;
    }

    let dir: 0 | 1 | -1 = 0;
    if (correct && this.consecCorrect >= this.down) {
      dir = 1; // harder
      this.consecCorrect = 0;
    } else if (!correct && this.consecIncorrect >= this.up) {
      dir = -1; // easier
      this.consecIncorrect = 0;
    }

    if (dir !== 0) this.move(dir);
    return this.difficulty;
  }

  private move(dir: 1 | -1): void {
    // A reversal: this move opposes the previous one. Shrink the step (halve,
    // to the floor) and record the threshold sample at the turning point.
    if (this.lastDir !== 0 && dir !== this.lastDir) {
      this.reversalDifficulties.push(this.difficulty);
      this.step = Math.max(this.minStep, this.step / 2);
    }
    this.lastDir = dir;
    this.difficulty = clamp01(this.difficulty + dir * this.step);
  }

  /**
   * Threshold estimate: mean difficulty over the last K reversals (the mastery
   * score). Before any reversal there's no estimate; we return the current
   * difficulty as a best-effort fallback so callers always get a number.
   */
  threshold(): number {
    const revs = this.reversalDifficulties;
    if (revs.length === 0) return this.difficulty;
    const k = Math.min(this.thresholdReversals, revs.length);
    const slice = revs.slice(revs.length - k);
    const sum = slice.reduce((a, b) => a + b, 0);
    return sum / k;
  }

  /** Whether the threshold estimate is settled (enough reversals seen). */
  get settled(): boolean {
    return this.reversalDifficulties.length >= this.thresholdReversals;
  }
}

/** Human-readable band for a difficulty/threshold in [0,1]. */
export function difficultyBand(d: number): string {
  if (d < 0.2) return 'easy';
  if (d < 0.4) return 'moderate';
  if (d < 0.6) return 'firm';
  if (d < 0.8) return 'hard';
  return 'expert';
}
