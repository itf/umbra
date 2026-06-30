/**
 * Thaler-style ADAPTIVE DISTANCE LADDER for size/distance discrimination.
 *
 * In Thaler et al.'s 10-week echolocation program, the size-discrimination task
 * backs the listener AWAY from the target in fixed 33 cm steps once accuracy
 * reaches ≥ 90% over a window (originally "over two sessions"): 33 → 66 → 99 cm…
 * Backing away shrinks the angular/loudness difference between the two targets,
 * so each rung is harder than the last — a measurable mastery curve.
 *
 * We model that as a per-exercise RUNG (0,1,2,…): the listener-to-source distance
 * is `baseM + rung * stepM`. This pure controller tracks a sliding window of
 * recent correct/incorrect outcomes and steps the rung UP when accuracy over a
 * full window hits the mastery threshold (default ≥ 90% over the last 10).
 * Optionally it steps DOWN if accuracy collapses, so a struggling learner is
 * brought back into flow rather than stranded.
 *
 * No DOM, no audio, no module randomness — fully unit-testable.
 */

export interface DistanceLadderConfig {
  /** Distance at rung 0, metres. Default 0.33 (Thaler's first step). */
  baseM?: number;
  /** Metres added per rung. Default 0.33 (the 33 cm step). */
  stepM?: number;
  /** Trials in the accuracy window. Default 10. */
  window?: number;
  /** Accuracy (0..1) over a FULL window needed to step farther. Default 0.9. */
  stepUpAccuracy?: number;
  /** Accuracy at/under which we step back in (regress). Default 0.5. null = never. */
  stepDownAccuracy?: number | null;
  /** Highest rung allowed. Default 8 (≈ 3 m at 33 cm steps). */
  maxRung?: number;
  /** Starting rung. Default 0. */
  startRung?: number;
}

export interface LadderStep {
  /** Rung after recording this answer. */
  rung: number;
  /** Listener-to-source distance after this answer, metres. */
  distanceM: number;
  /** +1 stepped farther, -1 stepped in, 0 no change — for announcements. */
  moved: 0 | 1 | -1;
}

export class DistanceLadder {
  readonly baseM: number;
  readonly stepM: number;
  readonly window: number;
  readonly stepUpAccuracy: number;
  readonly stepDownAccuracy: number | null;
  readonly maxRung: number;

  private rung: number;
  /** Recent outcomes (true=correct), most-recent last, capped at `window`. */
  private recent: boolean[] = [];

  constructor(cfg: DistanceLadderConfig = {}) {
    this.baseM = cfg.baseM ?? 0.33;
    this.stepM = cfg.stepM ?? 0.33;
    this.window = Math.max(1, cfg.window ?? 10);
    this.stepUpAccuracy = cfg.stepUpAccuracy ?? 0.9;
    this.stepDownAccuracy = cfg.stepDownAccuracy === undefined ? 0.5 : cfg.stepDownAccuracy;
    this.maxRung = Math.max(0, cfg.maxRung ?? 8);
    this.rung = Math.max(0, Math.min(this.maxRung, cfg.startRung ?? 0));
  }

  /** Current rung (0-based). */
  currentRung(): number {
    return this.rung;
  }

  /** Listener-to-source distance for the current rung, metres. */
  distance(): number {
    return this.baseM + this.rung * this.stepM;
  }

  /** Accuracy over the current window (0 when the window is empty). */
  accuracy(): number {
    if (this.recent.length === 0) return 0;
    const hits = this.recent.reduce((n, c) => n + (c ? 1 : 0), 0);
    return hits / this.recent.length;
  }

  /**
   * Record an answer and possibly step. The mastery test only fires on a FULL
   * window (so a lucky 1/1 doesn't promote you), and the window is CLEARED after
   * any move so the next rung is judged on its own fresh evidence.
   */
  record(correct: boolean): LadderStep {
    this.recent.push(correct);
    if (this.recent.length > this.window) this.recent.shift();

    let moved: 0 | 1 | -1 = 0;
    if (this.recent.length >= this.window) {
      const acc = this.accuracy();
      if (acc >= this.stepUpAccuracy && this.rung < this.maxRung) {
        this.rung++;
        moved = 1;
        this.recent = [];
      } else if (this.stepDownAccuracy != null && acc <= this.stepDownAccuracy && this.rung > 0) {
        this.rung--;
        moved = -1;
        this.recent = [];
      }
    }
    return { rung: this.rung, distanceM: this.distance(), moved };
  }
}

/**
 * PURE: spoken note for a ladder move (terse, for the aria-live region). '' when
 * the rung didn't change — the verdict already covered the answer.
 */
export function ladderAnnouncement(step: LadderStep): string {
  if (step.moved > 0) {
    return `Stepping back to ${step.distanceM.toFixed(2)} metres — farther, harder.`;
  }
  if (step.moved < 0) {
    return `Stepping in to ${step.distanceM.toFixed(2)} metres — closer, easier.`;
  }
  return '';
}
