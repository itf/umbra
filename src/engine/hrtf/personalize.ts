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
import { fft, minPhase, type MinPhaseHrtf } from './interpolatingDsp';
import { type HrtfPcaModel, vecToCipicAzEl, nearestDirIndex, deformationCurve } from './hrtfPca';

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
  /**
   * OPTIONAL PCA weights (std-dev units) that morph the magnitude spectrum along the
   * CIPIC real-ear principal axes — the "refine along how ears actually vary" layer,
   * tuned by the PCA A/B stage. Applied AFTER the parametric warp, magnitude-only (ITD
   * untouched). Absent / all-zero = no PCA deformation. Length ≤ the model's K.
   */
  pcaWeights?: number[];
}

export const NEUTRAL_PERSONALIZATION: HrtfPersonalization = {
  itdScale: 1,
  elevTilt: 0,
  frontBackTilt: 0,
  notchHz: 7500, // mid pinna-notch range; neutral because notchDepth 0 disables it
  notchDepth: 0,
};

/** Bounds for a single PCA weight (std-dev units): ±2 ≈ the extremes of real ears. */
export const PCA_WEIGHT_BOUND = { min: -2.5, max: 2.5 } as const;

/** True when a PCA weight vector is absent or entirely zero (no deformation). */
export function pcaIsNeutral(w: number[] | undefined): boolean {
  return !w || !w.some((v) => v !== 0);
}

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
  const out: HrtfPersonalization = {
    itdScale: c(p.itdScale, PERSONALIZATION_BOUNDS.itdScale, 1),
    elevTilt: c(p.elevTilt, PERSONALIZATION_BOUNDS.elevTilt, 0),
    frontBackTilt: c(p.frontBackTilt, PERSONALIZATION_BOUNDS.frontBackTilt, 0),
    notchHz: c(p.notchHz, PERSONALIZATION_BOUNDS.notchHz, 7500),
    notchDepth: c(p.notchDepth, PERSONALIZATION_BOUNDS.notchDepth, 0),
  };
  if (Array.isArray(p.pcaWeights) && p.pcaWeights.length) {
    out.pcaWeights = p.pcaWeights.map((w) => c(w, PCA_WEIGHT_BOUND, 0));
  }
  return out;
}

export function isNeutral(p: HrtfPersonalization): boolean {
  return p.itdScale === 1 && p.elevTilt === 0 && p.frontBackTilt === 0 && p.notchDepth === 0
    && pcaIsNeutral(p.pcaWeights);
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

/**
 * Apply a PCA magnitude DEFORMATION (from the CIPIC model) to a min-phase set, morphing
 * each direction's magnitude spectrum along the real-ear principal axes by `weights`
 * (std-dev units, ±2 ≈ the extremes of the population). Timing (ITD) is untouched —
 * PCA is magnitude-only by design. Returns a new set; `weights` all-zero returns a
 * structural copy. This is the "refine along how ears actually vary" warp the PCA A/B
 * search tunes; it composes AFTER the parametric warp (personalizeMinPhase).
 *
 * Per direction: FFT the min-phase IR → multiply |spectrum| by exp(Δlogmag), where
 * Δlogmag is the PCA curve for the nearest CIPIC direction interpolated across bins →
 * re-derive a min-phase IR from the new magnitude (keeps it causal + same length).
 */
export function personalizePcaMinPhase(
  set: MinPhaseHrtf,
  model: HrtfPcaModel,
  weights: number[],
): MinPhaseHrtf {
  const { sampleRate, taps, count, dirs, itdL, itdR } = set;
  if (!weights.some((w) => w !== 0)) {
    return { sampleRate, taps, count, dirs, irs: new Float32Array(set.irs), itdL: new Float32Array(itdL), itdR: new Float32Array(itdR) };
  }
  const irs = new Float32Array(set.irs);
  const stride = 2 * taps;
  // FFT size ≥ taps, power of two.
  let nfft = 1; while (nfft < taps) nfft <<= 1;
  const half = nfft / 2;
  const re = new Float64Array(nfft), im = new Float64Array(nfft);

  // Cache deformation curves per nearest-dir index so repeated directions are cheap.
  const curveCache = new Map<number, Float32Array>();
  const curveFor = (dirIdx: number) => {
    let c = curveCache.get(dirIdx);
    if (!c) { c = deformationCurve(model, weights, dirIdx); curveCache.set(dirIdx, c); }
    return c;
  };

  const applyEar = (base: number, dirIdx: number) => {
    const curve = curveFor(dirIdx);
    // Build a per-bin magnitude multiplier exp(Δlogmag), interpolating the (bins)-length
    // curve across the (half+1) FFT bins.
    re.fill(0); im.fill(0);
    for (let i = 0; i < taps; i++) re[i] = irs[base + i];
    fft(re, im, false);
    for (let b = 0; b <= half; b++) {
      const frac = b / half; // 0..1
      const cf = frac * (model.bins - 1);
      const ci = Math.floor(cf), cfr = cf - ci;
      const d0 = curve[Math.min(model.bins - 1, ci)];
      const d1 = curve[Math.min(model.bins - 1, ci + 1)];
      const delta = d0 * (1 - cfr) + d1 * cfr;
      const g = Math.exp(delta);
      re[b] *= g; im[b] *= g;
      if (b > 0 && b < half) { re[nfft - b] *= g; im[nfft - b] *= g; } // mirror
    }
    // Inverse FFT → magnitude spectrum in time; re-derive a clean min-phase IR so the
    // result stays causal and the same length (matches the rest of the set).
    fft(re, im, true);
    const timeIr = new Float32Array(taps);
    for (let i = 0; i < taps; i++) timeIr[i] = re[i];
    const { mp } = minPhase(timeIr, nfft);
    for (let i = 0; i < taps; i++) irs[base + i] = mp[i];
  };

  for (let m = 0; m < count; m++) {
    const { az, el } = vecToCipicAzEl(dirs[m * 3], dirs[m * 3 + 1], dirs[m * 3 + 2]);
    const dirIdx = nearestDirIndex(model, az, el);
    const base = m * stride;
    applyEar(base, dirIdx);
    applyEar(base + taps, dirIdx);
  }

  return { sampleRate, taps, count, dirs, irs, itdL: new Float32Array(itdL), itdR: new Float32Array(itdR) };
}
