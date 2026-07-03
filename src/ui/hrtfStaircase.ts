/**
 * Per-parameter search for the perceptual HRTF game. Presents A/B probe pairs; each
 * answer ('a' = A better, 'b' = B better) narrows one scalar of `HrtfPersonalization`.
 *
 * SEARCH STRATEGY (two-phase, per the desired behaviour):
 *  • BOUNDED param (finite min/max) → BINARY SEARCH the range. Each trial plays two
 *    probes straddling the midpoint (A = lower third, B = upper third of the live
 *    bracket); the winner's side is kept and the bracket halves. Guaranteed log₂
 *    convergence in a fixed, predictable number of steps.
 *  • UNBOUNDED (no usable range) → EXPONENTIALLY grow the step from `start`, probing
 *    current-vs-stepped, until the answer FLIPS (the point where B stops/starts
 *    winning) — that flip brackets the optimum — then binary-search that bracket.
 *
 * Same public API as before (current / done / nextTrial / answer / bothBad) so callers
 * (guided A/B + localization + PCA) are unchanged. Pure & deterministic. Unit-tested.
 */

export interface StaircaseOpts {
  /** Starting (center) value. */
  start: number;
  /** Initial step magnitude (used only by the unbounded exponential-bracket phase). */
  step: number;
  /** Convergence: stop once the bracket width ≤ minStep. */
  minStep: number;
  /** Range. When both are finite the search binary-searches [min,max] directly. */
  min: number;
  max: number;
  /** Kept for API compatibility (ignored by the binary search). */
  reversals?: number;
}

/** One A/B comparison the game should present. */
export interface StaircaseTrial {
  a: number;
  b: number;
}

export class Staircase {
  private lo: number;
  private hi: number;
  private readonly minStep: number;
  private readonly min: number;
  private readonly max: number;
  /** Best estimate (bracket midpoint). */
  private value: number;
  /** 'binary' once we have a finite bracket; 'bracket' while exponentially expanding. */
  private phase: 'binary' | 'bracket';
  // --- unbounded exponential-bracket phase state ---
  private step: number;
  private bracketDir = 1;
  private lastChoseB: boolean | null = null;
  private bracketFrom = 0;
  /** "both bad" give-up counter. */
  private noProgress = 0;
  private givenUp = false;

  constructor(opts: StaircaseOpts) {
    this.min = opts.min;
    this.max = opts.max;
    this.minStep = opts.minStep;
    this.step = opts.step;
    const bounded = Number.isFinite(opts.min) && Number.isFinite(opts.max) && opts.max > opts.min;
    if (bounded) {
      this.phase = 'binary';
      this.lo = opts.min;
      this.hi = opts.max;
      this.value = (this.lo + this.hi) / 2;
    } else {
      this.phase = 'bracket';
      this.lo = this.hi = clamp(opts.start, opts.min, opts.max);
      this.value = this.lo;
      this.bracketFrom = this.value;
    }
  }

  get current(): number {
    return this.value;
  }

  get done(): boolean {
    return this.givenUp || (this.phase === 'binary' && this.hi - this.lo <= this.minStep);
  }

  /**
   * How much of the search range still remains, as a fraction 0..1 — 1 = full range (just
   * started), →0 = converged to minStep. Drives the "space shrinking" UI. In the bounded
   * binary phase this is the live bracket width over the full [min,max] span. In the
   * unbounded bracket phase we haven't localized a finite interval yet, so report ~1
   * (still wide open). Once converged/given-up, report the residual (≈ minStep fraction).
   */
  get bracketFraction(): number {
    const full = this.max - this.min;
    if (!Number.isFinite(full) || full <= 0) {
      // Unbounded: no finite range to measure against until we flip into binary.
      return this.phase === 'binary' ? clamp01((this.hi - this.lo) / (this.step || 1)) : 1;
    }
    return clamp01((this.hi - this.lo) / full);
  }

  /**
   * Next A/B pair. Binary phase: two probes straddling the bracket midpoint (lower third
   * vs upper third). Bracket phase: current value vs a value one exponential step away.
   */
  nextTrial(): StaircaseTrial {
    if (this.phase === 'binary') {
      const third = (this.hi - this.lo) / 3;
      return { a: this.lo + third, b: this.hi - third };
    }
    // Exponential bracketing (unbounded): probe current vs stepped.
    const b = clamp(this.value + this.bracketDir * this.step, this.min, this.max);
    return { a: this.value, b };
  }

  /** Record which option won ('a' or 'b') for the given trial. */
  answer(chose: 'a' | 'b', trial: StaircaseTrial): void {
    if (this.done) return;
    this.noProgress = 0;

    if (this.phase === 'binary') {
      // Winner's side keeps its half of the bracket; drop the far side at the midpoint.
      const mid = (trial.a + trial.b) / 2;
      if (chose === 'b') this.lo = mid; else this.hi = mid; // b is the upper probe
      this.value = (this.lo + this.hi) / 2;
      return;
    }

    // Bracket phase: watch for a FLIP in the answer, which brackets the optimum.
    const choseB = chose === 'b';
    if (this.lastChoseB !== null && choseB !== this.lastChoseB) {
      // Flip → the optimum is between the last value and the current probe. Switch to
      // binary search over that bracket.
      this.lo = Math.min(this.bracketFrom, trial.b);
      this.hi = Math.max(this.bracketFrom, trial.b);
      this.phase = 'binary';
      this.value = (this.lo + this.hi) / 2;
      return;
    }
    this.lastChoseB = choseB;
    if (choseB) {
      // Keep going that way, growing the step.
      this.bracketFrom = this.value;
      this.value = trial.b;
      this.step *= 2;
    } else {
      // A (current) won on the first probe — reverse direction and try the other side.
      this.bracketDir = -this.bracketDir;
    }
  }

  /**
   * "Neither / can't tell" — widen the bracket (we're likely near the middle of an
   * uninformative region) and, after a few in a row, give up gracefully so the game
   * can't loop forever on an unanswerable parameter.
   */
  bothBad(): void {
    if (this.done) return;
    if (this.phase === 'binary') {
      // Expand the bracket back out a bit (both nearby probes were bad → answer is farther).
      const w = this.hi - this.lo;
      this.lo = clamp(this.lo - w / 2, this.min, this.max);
      this.hi = clamp(this.hi + w / 2, this.min, this.max);
      this.value = (this.lo + this.hi) / 2;
    } else {
      this.step *= 2;
    }
    this.noProgress++;
    if (this.noProgress >= 3) this.givenUp = true;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
