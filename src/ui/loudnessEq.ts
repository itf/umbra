/**
 * Loudness-EQ calibration — the PURE, testable core of the per-user equal-loudness
 * check. Headphones and ears have wildly uneven frequency responses; we measure a
 * per-user correction curve by asking equal-loudness questions ("which is louder:
 * the reference, or this band?") and converging, per band, on the gain (in dB) at
 * which the band sounds AS LOUD as the 1 kHz reference.
 *
 * This module owns NO audio and NO DOM: it only sequences the questions, folds each
 * answer into per-band staircase state, detects convergence, and emits the final
 * correction curve. Tone playback + announcements live in loudnessEqAudio.ts /
 * calibration.ts / settings.ts (ear-verified). Persistence lives in settingsStore.ts.
 *
 * METHOD — a 1-up/1-down staircase per non-reference band (a simple transformed
 * staircase converging on the point of subjective equality). At each trial the band
 * is played at its current test gain against the fixed 0 dB reference:
 *   - "band louder"  → the band is too hot → LOWER its test gain by the step;
 *   - "reference louder" (band quieter) → RAISE its test gain by the step;
 *   - "they're equal" → we're at the match point → record a reversal, don't move.
 * The step HALVES at each direction reversal (down to a floor), so the staircase
 * homes in. We converge a band once it has logged `targetReversals` reversals (or a
 * trial cap). The band's measured equal-loudness gain is the mean of the reversal
 * points (a robust PSE estimate).
 *
 * The CORRECTION for a band IS that measured match gain: if a user needed the 8 kHz
 * band boosted +6 dB to sound as loud as 1 kHz, that band is perceptually quiet for
 * them, so the master EQ boosts 8 kHz by +6 dB to restore flat loudness. (A band that
 * had to be CUT to match is intrinsically too hot ⇒ a negative correction.)
 *
 * Randomness (band order) is injected via an `rng` so tests are deterministic;
 * app code passes `Math.random`.
 */

/** A measured correction point: boost (+) / cut (−) in dB for a band centre freq. */
export interface EqBand {
  freq: number;
  gainDb: number;
}

/** Player's verdict comparing the REFERENCE tone (A) to the BAND tone (B). */
export type LoudnessAnswer = 'reference-louder' | 'band-louder' | 'equal';

/** The reference band — equal loudness is defined RELATIVE to this; always 0 dB. */
export const REFERENCE_FREQ = 1000;

/** Log-spaced ~1-octave band centres. 1 kHz is the reference (gain 0 by definition). */
export const BAND_FREQS = [125, 250, 500, 1000, 2000, 4000, 8000] as const;

/** Non-reference bands we actually calibrate (the reference is fixed at 0 dB). */
export const TEST_FREQS: number[] = BAND_FREQS.filter((f) => f !== REFERENCE_FREQ);

/** Clamp range for the final correction (dB). Keeps a bad run from blowing up. */
export const MAX_CORRECTION_DB = 12;

/** Staircase tuning. */
export const INITIAL_STEP_DB = 4;
export const MIN_STEP_DB = 0.5;
/** Reversals needed to call a band converged. */
export const TARGET_REVERSALS = 4;
/** Hard cap on trials per band (so a noisy/indecisive user can't loop forever). */
export const MAX_TRIALS_PER_BAND = 16;

/** PURE: clamp a correction to ±MAX_CORRECTION_DB; non-finite ⇒ 0. */
export function clampCorrectionDb(db: number): number {
  if (!Number.isFinite(db)) return 0;
  if (db > MAX_CORRECTION_DB) return MAX_CORRECTION_DB;
  if (db < -MAX_CORRECTION_DB) return -MAX_CORRECTION_DB;
  return db;
}

/** Per-band staircase state. */
interface BandState {
  freq: number;
  /** Current test gain (dB) applied to the band tone vs the 0 dB reference. */
  testGainDb: number;
  step: number;
  /** Direction of the LAST move: -1 lowered, +1 raised, 0 none yet. */
  lastDir: number;
  /** Test-gain values at each reversal — averaged for the PSE estimate. */
  reversals: number[];
  trials: number;
  done: boolean;
}

function newBandState(freq: number): BandState {
  return {
    freq,
    testGainDb: 0,
    step: INITIAL_STEP_DB,
    lastDir: 0,
    reversals: [],
    trials: 0,
    done: false,
  };
}

/** A question to ask the player: play the reference, then this band at `testGainDb`. */
export interface LoudnessQuestion {
  freq: number;
  /** dB gain to apply to the band tone for THIS trial (reference is 0 dB). */
  testGainDb: number;
  /** 0-based index of this band in the session order (for progress reporting). */
  bandIndex: number;
  totalBands: number;
}

export interface LoudnessEqSnapshot {
  /** Bands remaining to calibrate, in order (current band is [0]). */
  pending: number[];
  /** Bands fully converged. */
  doneCount: number;
  totalBands: number;
  /** True when every band has converged (or hit its trial cap). */
  finished: boolean;
}

/**
 * The pure loudness-EQ calibration session. Construct, then loop:
 *   q = session.nextQuestion()         // null when finished
 *   ...play reference vs band at q.testGainDb, ask the user...
 *   session.answer(verdict)            // folds it into the staircase
 * When `nextQuestion()` returns null, call `curve()` for the correction.
 */
export class LoudnessEqSession {
  private bands: BandState[];
  /** Order of bands still to calibrate; finished bands are removed. */
  private order: number[];

  constructor(opts: { freqs?: number[]; rng?: () => number } = {}) {
    const freqs = opts.freqs ?? TEST_FREQS;
    this.bands = freqs.map(newBandState);
    // Randomise band order so fatigue/order effects don't bias one band; deterministic
    // when an rng is injected (tests pass a seeded one).
    this.order = shuffle(
      this.bands.map((_, i) => i),
      opts.rng,
    );
  }

  /** The index (into `bands`) of the band currently under test, or -1 if finished. */
  private currentIndex(): number {
    return this.order.length ? this.order[0] : -1;
  }

  /** The next question to pose, or null when the whole session has converged. */
  nextQuestion(): LoudnessQuestion | null {
    const i = this.currentIndex();
    if (i < 0) return null;
    const b = this.bands[i];
    return {
      freq: b.freq,
      testGainDb: b.testGainDb,
      bandIndex: this.bands.length - this.order.length,
      totalBands: this.bands.length,
    };
  }

  /**
   * Fold a verdict into the current band's staircase and advance. A no-op when the
   * session is already finished.
   */
  answer(verdict: LoudnessAnswer): void {
    const i = this.currentIndex();
    if (i < 0) return;
    const b = this.bands[i];
    b.trials++;

    if (verdict === 'equal') {
      // At the match point: record it as a reversal sample without moving.
      b.reversals.push(b.testGainDb);
    } else {
      // band-louder ⇒ too hot ⇒ lower (dir -1); reference-louder ⇒ raise (dir +1).
      const dir = verdict === 'band-louder' ? -1 : 1;
      if (b.lastDir !== 0 && dir !== b.lastDir) {
        // Direction reversal: log the turn-point, then shrink the step.
        b.reversals.push(b.testGainDb);
        b.step = Math.max(MIN_STEP_DB, b.step / 2);
      }
      b.testGainDb = clampCorrectionDb(b.testGainDb + dir * b.step);
      b.lastDir = dir;
    }

    if (b.reversals.length >= TARGET_REVERSALS || b.trials >= MAX_TRIALS_PER_BAND) {
      b.done = true;
      this.order.shift();
    }
  }

  snapshot(): LoudnessEqSnapshot {
    return {
      pending: this.order.map((i) => this.bands[i].freq),
      doneCount: this.bands.filter((b) => b.done).length,
      totalBands: this.bands.length,
      finished: this.order.length === 0,
    };
  }

  get finished(): boolean {
    return this.order.length === 0;
  }

  /**
   * The CORRECTION curve: one point per band, gain = the measured equal-loudness match
   * gain (the boost/cut that made the band sound as loud as the reference, which is
   * exactly what the master EQ must apply to flatten perceived loudness), clamped to
   * ±MAX_CORRECTION_DB. The reference band is included at exactly 0 dB.
   * Bands not yet converged contribute their best current estimate.
   */
  curve(): EqBand[] {
    const points: EqBand[] = this.bands.map((b) => ({
      freq: b.freq,
      gainDb: clampCorrectionDb(measuredGain(b)),
    }));
    points.push({ freq: REFERENCE_FREQ, gainDb: 0 });
    points.sort((a, b) => a.freq - b.freq);
    return points;
  }
}

/**
 * The measured equal-loudness gain for a band: the mean of its reversal turn-points
 * (the robust point-of-subjective-equality estimate), or the current test gain if no
 * reversals were logged yet.
 */
function measuredGain(b: BandState): number {
  if (b.reversals.length === 0) return b.testGainDb;
  const sum = b.reversals.reduce((s, v) => s + v, 0);
  return sum / b.reversals.length;
}

/**
 * PURE: a simulated listener for tests — given a TRUE per-band perceptual offset
 * (dB the band must be boosted to match the reference for THIS listener), returns the
 * verdict for a trial at `testGainDb`. If the band is played louder than its match
 * point it sounds louder; within `tol` dB it's "equal".
 */
export function simulateAnswer(
  trueOffsetDb: number,
  testGainDb: number,
  tol = MIN_STEP_DB,
): LoudnessAnswer {
  const diff = testGainDb - trueOffsetDb; // >0 ⇒ band hotter than match
  if (Math.abs(diff) <= tol) return 'equal';
  return diff > 0 ? 'band-louder' : 'reference-louder';
}

/** PURE: Fisher–Yates shuffle (deterministic with an injected rng). */
function shuffle<T>(arr: T[], rng: () => number = Math.random): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
