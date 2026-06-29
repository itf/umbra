/**
 * Calibration state machine — the PURE, testable core of the headphone /
 * left-right / volume check. It owns NO audio and NO DOM: it only tracks which
 * step we're on, records each answer, derives whether the headphones are
 * swapped, and exposes a session L/R-swap toggle. The actual tone playback +
 * announcements live in calibration.ts (ear/screen-reader-verified).
 *
 * Flow (one step at a time, each gated by a player answer):
 *   intro → left → right → volume → done
 *
 * At `left` we play a tone in the LEFT ear and ask "did you hear it on the
 * left?". At `right`, the RIGHT ear. A player answers each with the SIDE they
 * actually heard it on ('left' | 'right'). If their reported side matches the
 * intended side on BOTH probes, the headphones are correctly oriented. If both
 * are reversed, the headphones are swapped — and `swapSuggested()` becomes true.
 *
 * The session swap toggle (`swap`) is independent state the UI maps to inverting
 * the master output channels for the session; here we only model the boolean.
 *
 * `done`-tracking persistence (localStorage) lives in onboardingStore.ts so this
 * stays pure and clock/DOM-free.
 */

export type CalibrationStep = 'intro' | 'left' | 'right' | 'volume' | 'done';
export type Side = 'left' | 'right';

/** The ear a probe is intended to play in, per step. */
export const PROBE_SIDE: Record<'left' | 'right', Side> = { left: 'left', right: 'right' };

export interface CalibrationSnapshot {
  step: CalibrationStep;
  /** What the player reported hearing on each probe (null until answered). */
  leftHeard: Side | null;
  rightHeard: Side | null;
  /** Session L/R channel-swap toggle (maps to inverting master output). */
  swap: boolean;
  done: boolean;
}

const ORDER: CalibrationStep[] = ['intro', 'left', 'right', 'volume', 'done'];

export class CalibrationMachine {
  private step: CalibrationStep = 'intro';
  private leftHeard: Side | null = null;
  private rightHeard: Side | null = null;
  private swap = false;

  constructor(opts: { swap?: boolean } = {}) {
    this.swap = !!opts.swap;
  }

  get current(): CalibrationStep {
    return this.step;
  }

  snapshot(): CalibrationSnapshot {
    return {
      step: this.step,
      leftHeard: this.leftHeard,
      rightHeard: this.rightHeard,
      swap: this.swap,
      done: this.step === 'done',
    };
  }

  /** Advance from intro → left (begins the probes). No-op unless on intro. */
  begin() {
    if (this.step === 'intro') this.step = 'left';
  }

  /**
   * Record the side the player heard the CURRENT probe on, then advance. Only
   * meaningful on the 'left' / 'right' steps; ignored elsewhere.
   */
  answer(heard: Side) {
    if (this.step === 'left') {
      this.leftHeard = heard;
      this.step = 'right';
    } else if (this.step === 'right') {
      this.rightHeard = heard;
      this.step = 'volume';
    }
  }

  /** Acknowledge the volume step → done. No-op unless on 'volume'. */
  confirmVolume() {
    if (this.step === 'volume') this.step = 'done';
  }

  /** Toggle (or set) the session L/R channel swap. Returns the new value. */
  setSwap(on: boolean): boolean {
    this.swap = on;
    return this.swap;
  }
  toggleSwap(): boolean {
    return this.setSwap(!this.swap);
  }
  get swapped(): boolean {
    return this.swap;
  }

  /**
   * True once BOTH probes have been answered and BOTH were heard on the OPPOSITE
   * side to what was intended — i.e. the headphones are physically reversed.
   * Returns false until both are answered.
   */
  swapSuggested(): boolean {
    if (this.leftHeard == null || this.rightHeard == null) return false;
    return this.leftHeard === 'right' && this.rightHeard === 'left';
  }

  /** True when both probes were answered correctly (orientation is fine). */
  orientationCorrect(): boolean {
    if (this.leftHeard == null || this.rightHeard == null) return false;
    return this.leftHeard === 'left' && this.rightHeard === 'right';
  }

  /** Restart the probe sequence (keeps the swap toggle). */
  reset() {
    this.step = 'intro';
    this.leftHeard = null;
    this.rightHeard = null;
  }

  /** Numeric progress 0..1 for an optional spoken/visual indicator. */
  progress(): number {
    return ORDER.indexOf(this.step) / (ORDER.length - 1);
  }
}
