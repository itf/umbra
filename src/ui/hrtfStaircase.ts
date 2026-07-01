/**
 * Coarse→fine staircase for one personalization parameter.
 *
 * The perceptual game (hrtfTuning.ts) presents MOVING probe sounds rendered with
 * two candidate settings — "A" and "B" — and asks which felt more like the target
 * motion (more outside the head / more clearly in front / more like moving up).
 * Each answer nudges one scalar of `HrtfPersonalization`.
 *
 * We use a bracketing staircase with a step that starts LARGE and halves whenever
 * the listener reverses direction (a classic transformed up/down / "optometrist"
 * search). Large first steps make the difference obvious before the brain adapts
 * (~3–5 min budget); the halving converges to a stable value in a handful of
 * choices without slider-fiddling.
 *
 * Pure & deterministic — no audio, no DOM, no randomness. Unit-tested in
 * tests/hrtfStaircase.test.ts.
 */

export interface StaircaseOpts {
  /** Starting (center) value — usually the neutral default. */
  start: number;
  /** Initial step magnitude (deliberately large so A vs B is obvious). */
  step: number;
  /** Smallest step; once the step would drop below this we're converged. */
  minStep: number;
  /** Hard clamp on the value. */
  min: number;
  max: number;
  /** How many reversals before we call it converged (default 3). */
  reversals?: number;
}

/** One A/B comparison the game should present. */
export interface StaircaseTrial {
  /** Candidate value for option A. */
  a: number;
  /** Candidate value for option B. */
  b: number;
}

export class Staircase {
  private value: number;
  private step: number;
  private readonly minStep: number;
  private readonly min: number;
  private readonly max: number;
  private readonly targetReversals: number;
  private reversals = 0;
  /** Consecutive "both bad" answers, so an unanswerable param terminates gracefully. */
  private noProgress = 0;
  /** +1 if the last accepted move raised the value, −1 if lowered, 0 at start. */
  private lastDir = 0;

  constructor(opts: StaircaseOpts) {
    this.value = clamp(opts.start, opts.min, opts.max);
    this.step = opts.step;
    this.minStep = opts.minStep;
    this.min = opts.min;
    this.max = opts.max;
    this.targetReversals = opts.reversals ?? 3;
  }

  /** Current best estimate. */
  get current(): number {
    return this.value;
  }

  get done(): boolean {
    return this.reversals >= this.targetReversals || this.step < this.minStep;
  }

  /**
   * The next A/B pair to audition: A is the current value, B is one step away.
   * We alternate which way B probes so the search explores both directions —
   * but always bracket around the current best.
   */
  nextTrial(): StaircaseTrial {
    // Probe in the direction we last moved (momentum), or up on the first trial.
    const dir = this.lastDir === 0 ? 1 : this.lastDir;
    const b = clamp(this.value + dir * this.step, this.min, this.max);
    return { a: this.value, b };
  }

  /**
   * Record which option won. `chose` is 'a' (keep current) or 'b' (move toward B).
   * A reversal (moving opposite to the previous accepted move) halves the step.
   */
  answer(chose: 'a' | 'b', trial: StaircaseTrial): void {
    if (this.done) return;
    this.noProgress = 0; // a real preference clears the "both bad" give-up counter
    if (chose === 'b') {
      const dir = Math.sign(trial.b - trial.a) || 1;
      if (this.lastDir !== 0 && dir !== this.lastDir) {
        this.reversals++;
        this.step = Math.max(this.minStep / 2, this.step / 2);
      }
      this.value = trial.b;
      this.lastDir = dir;
    } else {
      // Rejecting B means the current value is better than that direction.
      const probedDir = Math.sign(trial.b - trial.a) || 1;
      if (this.lastDir === 0) {
        // First trial: we probed up by default and it lost, so search downward
        // next — without counting a reversal (we never actually moved yet).
        this.lastDir = -probedDir;
      } else {
        // Sticking with A after having moved is a reversal: the step overshot,
        // so shrink it, count it, and probe the other way next.
        this.reversals++;
        this.step = Math.max(this.minStep / 2, this.step / 2);
        this.lastDir = -this.lastDir;
      }
    }
  }

  /**
   * "Neither was good" / "both bad" — the listener couldn't tell or disliked both
   * candidates. Rather than pick a direction, JUMP the search further out (both
   * candidates were near the current value, so the answer is likely farther away)
   * and DON'T shrink the step. If we've bounced around a lot with no luck, take the
   * jump the opposite way we last went. Counts lightly toward termination so the
   * game can't loop forever on an unanswerable parameter.
   */
  bothBad(): void {
    if (this.done) return;
    const dir = this.lastDir === 0 ? 1 : this.lastDir;
    // Grow the step a bit and leap, exploring farther territory.
    this.step = Math.min(this.step * 1.5, (this.max - this.min));
    const next = clamp(this.value + dir * this.step, this.min, this.max);
    // If we're pinned at a rail, flip direction so we actually move.
    if (next === this.value) { this.lastDir = -dir; this.value = clamp(this.value - dir * this.step, this.min, this.max); }
    else { this.lastDir = Math.sign(next - this.value) || dir; this.value = next; }
    this.noProgress++;
    if (this.noProgress >= 3) { this.reversals = this.targetReversals; } // give up gracefully
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
