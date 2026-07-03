/**
 * UP/DOWN cue ON/OFF localization A/B — the "does the elevation cue actually help?" test the
 * data alone can't answer. Mirrors the headphone-comp on/off A/B (headphoneCalibration.ts):
 * compares up/down POINTING ERROR with the reshaped elevation cue ON vs OFF on ELEVATION-
 * targeted directions (makeTargetedDirection('elevation')), scored with the SAME winner rule
 * + user-scatter tie-band (decideWinner, 5° tolerance, ties → 'a' = keep OFF/incumbent).
 *
 * A synthetic "listener" perceives elevation from the rendered spectral cue: the more the
 * rendered set colors elevation (a measurable 6–8 kHz boost vs 11–14 kHz cut delta), the
 * closer their guessed elevation tracks the true elevation; with a FLAT set (cue OFF) the
 * percept collapses toward ear level, so up/down error is large above/below the horizon.
 */
import { describe, it, expect } from 'vitest';
import { personalizeMinPhase, NEUTRAL_PERSONALIZATION } from '../src/engine/hrtf/personalize';
import { fft, type MinPhaseHrtf } from '../src/engine/hrtf/interpolatingDsp';
import {
  makeTargetedDirection, decomposeError, decideWinner,
  type Direction, type Attempt,
} from '../src/ui/hrtfLocalize';

const SR = 48000, TAPS = 256;
const COMP_TIE_RAD = (5 * Math.PI) / 180; // same user-scatter tie-band as the comp A/B
const PER_SIDE = 5;

/** One-direction set for the given engine direction, broadband IR. */
function dirSet(d: Direction): MinPhaseHrtf {
  const v = dirToVec(d);
  const irs = new Float32Array(2 * TAPS);
  for (let e = 0; e < 2; e++) { irs[e * TAPS] = 1; irs[e * TAPS + 1] = -0.3; irs[e * TAPS + 3] = 0.15; }
  return {
    sampleRate: SR, taps: TAPS, count: 1,
    dirs: new Float32Array([v[0], v[1], v[2]]), irs,
    itdL: new Float32Array([0]), itdR: new Float32Array([0]),
  };
}
function dirToVec(d: Direction): [number, number, number] {
  const ce = Math.cos(d.el);
  return [Math.sin(d.az) * ce, Math.sin(d.el), -Math.cos(d.az) * ce];
}
function magDb(set: MinPhaseHrtf, hz: number): number {
  const re = new Float64Array(1024), im = new Float64Array(1024);
  for (let i = 0; i < TAPS; i++) re[i] = set.irs[i];
  fft(re, im, false);
  const bin = Math.round((hz / SR) * 1024);
  return 20 * Math.log10(Math.hypot(re[bin], im[bin]) + 1e-9);
}

/** Elevation-cue STRENGTH the rendered set applies at direction `d`: the SS2 signature is a
 *  ~7 kHz boost minus a ~12 kHz cut, so (mag@7k − mag@12k) grows with applied elevation cue. */
function cueStrength(set: MinPhaseHrtf): number {
  return magDb(set, 7000) - magDb(set, 12000);
}

/** Model a listener's GUESSED elevation from the rendered cue. With a strong, correctly-
 *  signed cue the guess tracks the truth; with none, it collapses toward ear level (0). We
 *  read the cue strength at the true elevation vs at the horizon and scale the truth by how
 *  much elevation contrast the set provides (clamped to a plausible gain). */
function guessedElevation(params: Parameters<typeof personalizeMinPhase>[1], truth: Direction): number {
  const atTruth = cueStrength(personalizeMinPhase(dirSet(truth), params));
  const atHorizon = cueStrength(personalizeMinPhase(dirSet({ az: truth.az, el: 0 }), params));
  const contrast = atTruth - atHorizon; // dB of elevation contrast the cue provides
  // Map contrast→perceived fraction of the true elevation (≈full percept by ~12 dB contrast).
  const frac = Math.max(-1, Math.min(1, contrast / 12));
  return truth.el * frac;
}

/** Simulated up/down pointing error (rad) for one probe with a given personalization. */
function updownError(params: Parameters<typeof personalizeMinPhase>[1], truth: Direction): number {
  const guess: Direction = { az: truth.az, el: guessedElevation(params, truth) };
  return Math.abs(decomposeError(truth, guess).updown);
}

const CUE_ON = { ...NEUTRAL_PERSONALIZATION, notchDepth: 20, elevTilt: 6 };
const CUE_OFF = { ...NEUTRAL_PERSONALIZATION, notchDepth: 0, elevTilt: 0 };

/** Run the A/B: PER_SIDE elevation-targeted probes each for OFF ('a') and ON ('b'). */
function runAb(onParams: typeof CUE_ON): Attempt[] {
  const attempts: Attempt[] = [];
  for (let i = 0; i < PER_SIDE; i++) {
    const dir = makeTargetedDirection('elevation', 100 + i); // above/below horizon, |el| 20–60°
    attempts.push({ which: 'a', error: updownError(CUE_OFF, dir) });
    attempts.push({ which: 'b', error: updownError(onParams, dir) });
  }
  return attempts;
}

describe('up/down cue ON/OFF A/B (does the elevation cue help)', () => {
  it('elevation-targeted probes are actually off the horizon', () => {
    for (let i = 0; i < 10; i++) {
      const d = makeTargetedDirection('elevation', 100 + i);
      expect(Math.abs(d.el)).toBeGreaterThan((20 * Math.PI) / 180 - 1e-9);
    }
  });

  it('the reshaped cue ON reduces up/down error vs OFF, and the A/B picks it', () => {
    const attempts = runAb(CUE_ON);
    const meanA = attempts.filter((x) => x.which === 'a').reduce((s, x) => s + x.error, 0) / PER_SIDE;
    const meanB = attempts.filter((x) => x.which === 'b').reduce((s, x) => s + x.error, 0) / PER_SIDE;
    expect(meanB).toBeLessThan(meanA); // cue ON localizes elevation better
    expect(decideWinner(attempts, PER_SIDE, COMP_TIE_RAD)).toBe('b'); // A/B promotes ON
  });

  it('keeps the cue OFF when ON does not help (a no-op "cue" ties → OFF)', () => {
    // An ON that applies no elevation coloring (notchDepth 0) can't beat OFF → tie → keep OFF.
    const attempts = runAb({ ...CUE_ON, notchDepth: 0, elevTilt: 0 });
    expect(decideWinner(attempts, PER_SIDE, COMP_TIE_RAD)).toBe('a'); // OFF kept (not forced on)
  });

  it('respects the user-scatter tie-band: a within-noise ON advantage keeps OFF', () => {
    // Fabricate a marginal ON (mean only ~3° better than OFF, inside the 5° tie band).
    const attempts: Attempt[] = [];
    for (let i = 0; i < PER_SIDE; i++) {
      attempts.push({ which: 'a', error: (20 * Math.PI) / 180 });
      attempts.push({ which: 'b', error: (17 * Math.PI) / 180 }); // 3° better < 5° tie band
    }
    expect(decideWinner(attempts, PER_SIDE, COMP_TIE_RAD)).toBe('a'); // ties → OFF, don't force on
  });
});
