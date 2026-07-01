/**
 * Parametric HRTF personalization — warp our single measured SADIE H3 set toward
 * the listener's own anatomy using a handful of scalar knobs, applied at bake time
 * (after `precomputeMinPhase`, before the worklet gets the data), so the real-time
 * cost is exactly zero.
 *
 * WHY parametric (not a SOFA tournament): we ship ONE measured head (SADIE H3).
 * Rather than needing a database of full heads, we deform H3's min-phase magnitude
 * + per-ear ITD along the three axes that dominate localization error for a
 * mismatched HRTF:
 *
 *   • itdScale     — multiplies the interaural time difference. This is the
 *                    "head width" knob; larger head → later far-ear onset. Fixes
 *                    left/right localization and externalization (out-of-head).
 *   • elevTilt     — a gentle high-frequency shelf whose SIGN tracks source
 *                    elevation (bright above, dark below). Personalizes the pinna
 *                    notch cue that the brain reads as up/down.
 *   • frontBackTilt— a high-frequency shelf whose sign tracks front(-z) vs
 *                    back(+z). Front is brighter than back for most pinnae; tuning
 *                    this resolves front/back confusion.
 *
 * All three are neutral at their defaults (1 / 0 / 0), so an un-calibrated user
 * gets the raw SADIE set unchanged. The perceptual calibration game
 * (src/ui/hrtfTuning.ts) drives these values via a coarse→fine staircase.
 *
 * Pure & synchronous — no Web Audio, no DOM. Unit-tested in
 * tests/personalize.test.ts.
 */
import type { MinPhaseHrtf } from './interpolatingDsp';

export interface HrtfPersonalization {
  /** Interaural-time-difference multiplier ("head width"). 1 = measured. */
  itdScale: number;
  /** Elevation notch/shelf strength in dB at Nyquist (signed by elevation). 0 = off. */
  elevTilt: number;
  /** Front/back brightness shelf in dB at Nyquist (signed by front vs back). 0 = off. */
  frontBackTilt: number;
  /**
   * PINNA-NOTCH centre frequency in Hz (the real up/down cue). Human elevation
   * perception comes from a narrow spectral NOTCH around 5–10 kHz whose exact
   * frequency is set by each person's ear folds; the brain reads a higher notch as
   * "up". Broadband brightness (elevTilt) cannot create this — a moving notch can.
   * We place a notch here whose DEPTH scales with the source's elevation, so tuning
   * this frequency to your ears makes overhead sounds actually read as overhead.
   */
  notchHz: number;
  /** Notch depth in dB at full elevation (0 = notch off). */
  notchDepth: number;
}

export const NEUTRAL_PERSONALIZATION: HrtfPersonalization = {
  itdScale: 1,
  elevTilt: 0,
  frontBackTilt: 0,
  notchHz: 7500, // mid pinna-notch range; neutral because notchDepth 0 disables it
  notchDepth: 0,
};

/** Staircase / slider bounds. Ranges are deliberately WIDE so the effect is clearly
 *  audible when tuning by hand (the older ±9 dB / narrow-ITD ranges were too subtle to
 *  hear on a horizontal orbit); the perceptual sweet spot is well inside them. */
export const PERSONALIZATION_BOUNDS = {
  itdScale: { min: 0.5, max: 2.0 },
  elevTilt: { min: -18, max: 18 }, // dB at the extreme direction
  frontBackTilt: { min: -18, max: 18 }, // dB at the extreme direction
  notchHz: { min: 4000, max: 11000 }, // pinna-notch sweep range
  notchDepth: { min: 0, max: 24 }, // dB
} as const;

export function clampPersonalization(p: HrtfPersonalization): HrtfPersonalization {
  const c = (v: number, b: { min: number; max: number }, fb: number) =>
    Number.isFinite(v) ? Math.min(b.max, Math.max(b.min, v)) : fb;
  return {
    itdScale: c(p.itdScale, PERSONALIZATION_BOUNDS.itdScale, 1),
    elevTilt: c(p.elevTilt, PERSONALIZATION_BOUNDS.elevTilt, 0),
    frontBackTilt: c(p.frontBackTilt, PERSONALIZATION_BOUNDS.frontBackTilt, 0),
    notchHz: c(p.notchHz, PERSONALIZATION_BOUNDS.notchHz, 7500),
    notchDepth: c(p.notchDepth, PERSONALIZATION_BOUNDS.notchDepth, 0),
  };
}

export function isNeutral(p: HrtfPersonalization): boolean {
  return p.itdScale === 1 && p.elevTilt === 0 && p.frontBackTilt === 0 && p.notchDepth === 0;
}

/**
 * A one-pole high-frequency shelf applied to a min-phase IR in place, using a
 * simple first-difference "brightness" tilt: mixing in the derivative of the IR
 * boosts highs (positive gain) or the running sum darkens them (negative gain).
 * `db` is the approximate shelf gain at Nyquist. Kept crude on purpose — the aim
 * is a perceptual nudge to the pinna cue, not a surgical EQ, and it must stay
 * cheap enough to run over all ~2800 directions at bake time.
 */
function applyBrightnessTilt(ir: Float32Array, base: number, taps: number, db: number): void {
  if (db === 0) return;
  // Convert dB to a linear high-shelf coefficient. A first-difference filter
  // y[n] = x[n] + k*(x[n]-x[n-1]) has ~ (1+2k) gain at Nyquist, ~1 at DC.
  const nyqGain = Math.pow(10, db / 20);
  const k = (nyqGain - 1) / 2;
  let prev = 0;
  // Work on a copy so the difference uses original samples.
  for (let i = 0; i < taps; i++) {
    const x = ir[base + i];
    ir[base + i] = x + k * (x - prev);
    prev = x;
  }
}

/**
 * Apply a peaking (notch) biquad to a short IR in place — a Direct-Form-I RBJ
 * cookbook peaking filter with negative gain, giving a spectral DIP at `fc` with
 * bandwidth `q`. This is the real pinna-notch shape the ear reads as elevation
 * (unlike broadband brightness). `gainDb` should be ≤0 for a notch.
 */
function applyNotch(ir: Float32Array, base: number, taps: number, fc: number, q: number, gainDb: number, sampleRate: number): void {
  if (gainDb === 0) return;
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * fc) / sampleRate;
  const cosw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  // RBJ peakingEQ
  const b0 = 1 + alpha * A;
  const b1 = -2 * cosw;
  const b2 = 1 - alpha * A;
  const a0 = 1 + alpha / A;
  const a1 = -2 * cosw;
  const a2 = 1 - alpha / A;
  const nb0 = b0 / a0, nb1 = b1 / a0, nb2 = b2 / a0, na1 = a1 / a0, na2 = a2 / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < taps; i++) {
    const x0 = ir[base + i];
    const y0 = nb0 * x0 + nb1 * x1 + nb2 * x2 - na1 * y1 - na2 * y2;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    ir[base + i] = y0;
  }
}

/**
 * Produce a personalized copy of a baked min-phase HRTF set. The input is left
 * untouched; the returned set has its ITD scaled, its per-direction magnitude
 * filters tilted (elevation/front-back brightness), and — the real elevation cue —
 * a pinna NOTCH at `notchHz` whose depth scales with the source's elevation.
 * Neutral personalization returns a structural copy identical to the input.
 */
export function personalizeMinPhase(
  set: MinPhaseHrtf,
  raw: HrtfPersonalization,
): MinPhaseHrtf {
  const p = clampPersonalization(raw);
  const { sampleRate, taps, count, dirs } = set;
  const irs = new Float32Array(set.irs); // copy — we mutate the copy
  const itdL = new Float32Array(count);
  const itdR = new Float32Array(count);
  const stride = 2 * taps;

  for (let m = 0; m < count; m++) {
    itdL[m] = set.itdL[m] * p.itdScale;
    itdR[m] = set.itdR[m] * p.itdScale;

    if (p.elevTilt !== 0 || p.frontBackTilt !== 0) {
      const y = dirs[m * 3 + 1]; // elevation component (+up)
      const z = dirs[m * 3 + 2]; // −z = front, +z = back
      // Front/back: weight the whole FRONT hemisphere positive and the whole BACK
      // hemisphere negative (a soft sign of −z), not the raw cosine — so a source at
      // the SIDES of a horizontal orbit still gets most of the tilt. This is what
      // makes the slider clearly audible as the sound circles, instead of only
      // biting at dead-front / dead-back. tanh gives a smooth ±1 plateau.
      const fbWeight = Math.tanh(-z * 3); // ≈ −1 back … +1 front, steep near median
      // Elevation stays cosine-like (the up cue really is concentrated overhead).
      const db = p.elevTilt * y + p.frontBackTilt * fbWeight;
      const base = m * stride;
      applyBrightnessTilt(irs, base, taps, db); // left ear
      applyBrightnessTilt(irs, base + taps, taps, db); // right ear
    }

    // PINNA NOTCH — the real elevation cue. Depth scales with elevation (deep when
    // the source is overhead, none at/below ear level), and the notch centre RISES a
    // little with elevation (natural pinna behaviour). Tuning notchHz to the user's
    // ears is what finally makes "up" read as up.
    if (p.notchDepth > 0) {
      const y = dirs[m * 3 + 1]; // −1 (down) … +1 (up)
      const elev = Math.max(0, y); // only above ear level gets the notch
      if (elev > 0.02) {
        // Centre shifts up ~15% from lowest to highest elevation.
        const fc = p.notchHz * (1 + 0.15 * elev);
        const depth = -p.notchDepth * elev; // negative dB → a dip
        const q = 4; // fairly narrow, notch-like
        const base = m * stride;
        applyNotch(irs, base, taps, fc, q, depth, sampleRate);
        applyNotch(irs, base + taps, taps, fc, q, depth, sampleRate);
      }
    }
  }

  return { sampleRate, taps, count, dirs, irs, itdL, itdR };
}
