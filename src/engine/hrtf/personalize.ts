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
import { type HrtfPcaModel, vecToAzEl, nearestDirIndex, deformationCurve, normFreqToCurveIndex } from './hrtfPca';

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
   * FRONT/BACK perceptual BIAS ∈ [−1,+1], 0 = neutral. NOT a geometric offset — it shifts the
   * hemisphere term that drives the front/back SPECTRAL cue (+ the FB contrast PCs) BEFORE the
   * cue is applied, so a positive bias colors ALL directions more "front" (even dead-ahead),
   * negative more "back". Corrects a listener's reversal tendency ("everything sounds behind
   * me"). At 0 it exactly reproduces the un-biased cue; true front/back stay distinguishable.
   */
  frontBackBias?: number;
  /** UP/DOWN perceptual BIAS ∈ [−1,+1], 0 = neutral. Analogous to frontBackBias but for the
   *  elevation coloring (brightness tilt + pinna notch): + nudges everything toward "up"
   *  spectral cue, − toward "down". A geometric no-op; purely the spectral elevation cue. */
  upDownBias?: number;
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
  frontBackBias: 0,
  upDownBias: 0,
};

/** How strongly a ±1 bias shifts the signed front/back (resp. up/down) coordinate before the
 *  hemisphere term. 0.6 keeps true front (−z=+1 → +1.6) and true back (−z=−1 → −0.4) on
 *  OPPOSITE sides of zero at full bias, so the cue never collapses — only shifts the balance. */
export const FRONT_BACK_BIAS_K = 0.6;
export const UP_DOWN_BIAS_K = 0.6;

/** The signed FRONT/BACK hemisphere term (+ front, − back, ~0 near the median plane) for a
 *  source with front/back coordinate `negZ` (= −z, so + = front), shifted by `bias∈[−1,1]`.
 *  bias=0 → tanh(negZ·3) (the historical term). Shared by the parametric cue AND the FB
 *  contrast PCs so the bias moves both consistently. */
export function frontBackHemisphere(negZ: number, bias = 0): number {
  return Math.tanh((negZ + bias * FRONT_BACK_BIAS_K) * 3);
}

/** The biased ELEVATION coordinate (+up) for the up/down spectral cues. bias=0 → y itself. */
export function biasedElevation(y: number, bias = 0): number {
  return y + bias * UP_DOWN_BIAS_K;
}

/** Bounds for a single PCA weight (std-dev units): ±2 ≈ the extremes of real ears. */
// ±3 std-dev: magnitude PCs use ±2.5 (real-ear range) via their staircase; front/back
// contrast PCs are allowed to ±3 (they move both hemispheres, so need a touch more range).
// The clamp is the outer safety bound; per-PC staircase ranges live in hrtfTuning.
export const PCA_WEIGHT_BOUND = { min: -3, max: 3 } as const;

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
  notchHz: { min: 4000, max: 11500 }, // pinna-notch sweep range (top reaches SS2 N1 @ high el)
  notchDepth: { min: 0, max: 24 }, // dB
  frontBackBias: { min: -1, max: 1 }, // perceptual front/back bias
  upDownBias: { min: -1, max: 1 }, // perceptual up/down bias
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
    frontBackBias: c(p.frontBackBias ?? 0, PERSONALIZATION_BOUNDS.frontBackBias, 0),
    upDownBias: c(p.upDownBias ?? 0, PERSONALIZATION_BOUNDS.upDownBias, 0),
  };
  if (Array.isArray(p.pcaWeights) && p.pcaWeights.length) {
    out.pcaWeights = p.pcaWeights.map((w) => c(w, PCA_WEIGHT_BOUND, 0));
  }
  return out;
}

export function isNeutral(p: HrtfPersonalization): boolean {
  return p.itdScale === 1 && p.elevTilt === 0 && p.frontBackTilt === 0 && p.notchDepth === 0
    && !p.frontBackBias && !p.upDownBias
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
 * Reinforce the FRONT/BACK spectral cue on one ear's IR. `s ∈ [-1, +1]`: + pushes the
 * percept toward FRONT, − toward BACK; magnitude = strength. Applies the research-backed
 * recipe (Blauert directional bands + measured HRTF front/back differences):
 *   • ~1 kHz peaking: BOOST for back (s<0), CUT for front (s>0). The strongest, most
 *     individual-robust cue (rear HRTFs are measurably louder ~1 kHz).
 *   • ~4 kHz peaking: opposite sign (front band).
 *   • first pinna NOTCH whose CENTRE slides ~7 kHz (front) → ~10 kHz (back) — it's the
 *     notch FREQUENCY, not depth, that carries direction, so we place the dip at the
 *     hemisphere-appropriate frequency.
 * `applyNotch` here is a general RBJ peakingEQ (any-sign gain), reused for all three.
 */
function applyFrontBackCue(ir: Float32Array, base: number, taps: number, s: number, sampleRate: number): void {
  if (s === 0) return;
  const mag = Math.min(1, Math.abs(s));
  // 1 kHz: +6 dB at full BACK, −5 dB at full FRONT (sign: back boosts, so gain = −s·k).
  applyNotch(ir, base, taps, 1000, 1.2, -s * (s < 0 ? 6 : 5), sampleRate);
  // 4 kHz: front band — +4 dB at full FRONT, −3 dB at full BACK (gain = +s·k).
  applyNotch(ir, base, taps, 4000, 1.4, s * (s > 0 ? 4 : 3), sampleRate);
  // Pinna notch slides with hemisphere: ~7 kHz (front) ↔ ~10 kHz (back). Depth scales
  // with strength so neutral (s→0) leaves the natural notch alone.
  const notchHz = s < 0 ? 7000 + 3000 * mag : 7000; // front ~7k; back rises toward 10k
  applyNotch(ir, base, taps, notchHz, 4, -8 * mag, sampleRate);
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

    const yRaw = dirs[m * 3 + 1]; // elevation component (+up)
    const z = dirs[m * 3 + 2]; // −z = front, +z = back
    const base = m * stride;
    // Up/down BIAS shifts the elevation coordinate used by BOTH elevation cues (a positive
    // bias colors everything more "up"). bias=0 → y unchanged.
    const y = biasedElevation(yRaw, p.upDownBias ?? 0);

    // ELEVATION brightness (broadband) — kept as-is; the real up/down cue is the notch below.
    if (p.elevTilt !== 0) {
      const db = p.elevTilt * y;
      applyBrightnessTilt(irs, base, taps, db);
      applyBrightnessTilt(irs, base + taps, taps, db);
    }

    // FRONT/BACK — a SPECTRAL cue, not a brightness shelf (a broadband tilt can't flip a
    // front/back confusion: the auditory system reads the notch PATTERN + specific boosted
    // bands, and normalises gross tilt away). Per Blauert's directional bands + measured
    // HRTF differences (see research): the ~1 kHz band is LOUDER for REAR sources (the most
    // robust, individual-invariant cue), ~4 kHz favours FRONT, and the first pinna notch
    // slides from ~7 kHz (front) up to ~10 kHz (back). We REINFORCE the correct cue for
    // each source's true hemisphere, scaled by frontBackTilt (0..18 → 0..1 strength).
    // Ref: Blauert, Spatial Hearing (MIT Press, 1997); Iida et al. (rear ~1 kHz boost).
    if (p.frontBackTilt !== 0) {
      // Hemisphere sign shifted by frontBackBias (+ → color everything more front).
      const s = (p.frontBackTilt / 18) * frontBackHemisphere(-z, p.frontBackBias ?? 0);
      applyFrontBackCue(irs, base, taps, s, sampleRate);
      applyFrontBackCue(irs, base + taps, taps, s, sampleRate);
    }

    // ABOVE-HORIZON ELEVATION SIGNATURE — reshaped to the MEASURED SS2 pattern (ipsilateral,
    // median-front, population mean elevation delta re 0°):
    //   6k  +4.0/+4.1   7.4k +5.2/+8.1   9k +0.8/+5.8   11.5k −6.1/−7.2   14k −4.7/−10.0  (+30°/+63°)
    // The OLD single narrow notch missed the two dominant features (a 6–8 kHz BOOST and an
    // 11–14 kHz CUT, both growing with elevation) and sat ~1.5–2 kHz too low + too shallow.
    // We now apply THREE elevation-scaled biquads (all off at ear level, all tunable):
    //   • ~7.4 kHz peaking BOOST  (+~5 dB@+30° → +~8 dB@+60°) — the dominant "up" energy rise
    //   • ~6 kHz gentle BOOST     (~+4 dB, roughly flat with elevation)
    //   • N1 notch, centre tracking ~10 kHz@+30° → ~12.8 kHz@+60°, ~1.5× the old depth
    //   • ~12.5 kHz peaking CUT   (−~6 dB@+30° → −~10 dB@+60°) — the high-band roll-off
    // Everything scales with `notchDepth` (the elevation-cue strength knob) so notchDepth=0
    // stays exactly neutral, and uses the UP/DOWN-BIASED elevation `y` so the bias still nudges
    // it. `elev` in [0,1]; the measured points are elev≈0.5 (+30°) and elev≈0.87 (+60°).
    if (p.notchDepth > 0) {
      const elev = Math.max(0, Math.min(1, y)); // biased elevation; above ear level only
      if (elev > 0.02) {
        const base = m * stride;
        // Strength scalar: notchDepth is the tunable master (24 = full-strength default).
        const s = p.notchDepth / 24;
        // 7.4 kHz boost: +0.9 + 8.2·elev dB (≈+5@+30°, +8@+60°), scaled by strength.
        const boost74 = s * Math.max(0, 0.9 + 8.2 * elev);
        // 6 kHz boost: ~+4 dB once clearly above the horizon (near-flat with elevation).
        const boost6 = s * 4 * Math.min(1, elev / 0.3);
        // N1 notch centre tracks ~7.3k(→ear) → ~10k@+30° → ~12.8k@+60°; ~1.2× the old depth.
        // (Kept modest so it doesn't STACK with the broad high-band cut below — at +60° both
        // land near 12–13 kHz and would otherwise gouge an unrealistically deep hole there.)
        const fc = Math.min(PERSONALIZATION_BOUNDS.notchHz.max, (p.notchHz * 0.97) + 6300 * elev);
        const notchDb = -1.2 * p.notchDepth * elev;
        // Broad high-band cut ~13.5 kHz (above the notch so they don't pile up): −(0.5+7·elev).
        const cutHi = -s * (0.5 + 7 * elev);
        for (const b of [base, base + taps]) {
          applyNotch(irs, b, taps, 6000, 1.6, boost6, sampleRate);
          applyNotch(irs, b, taps, 7400, 1.8, boost74, sampleRate);
          applyNotch(irs, b, taps, fc, 4, notchDb, sampleRate);
          applyNotch(irs, b, taps, 13500, 1.2, cutHi, sampleRate);
        }
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
  frontBackBias = 0, // shifts the hemisphere sign for FB contrast PCs (same as the parametric cue)
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

  // Front/back CONTRAST PCs deform front vs back OPPOSITE ways, so the curve depends on the
  // source's hemisphere too, not just its nearest grid dir. Sign = tanh(-z·3): +1 front
  // (−z), −1 back (+z), ~0 near the median plane (where front/back is ambiguous — the
  // contrast fades out there rather than snapping). Cache by (dirIdx, coarse sign bucket)
  // so repeated directions stay cheap while distinct hemispheres get distinct curves.
  const curveCache = new Map<string, Float32Array>();
  const curveFor = (dirIdx: number, hemiSign: number) => {
    // Quantize the sign to keep the cache small (curves vary smoothly with it).
    const bucket = Math.round(hemiSign * 8) / 8;
    const key = dirIdx + ':' + bucket;
    let c = curveCache.get(key);
    if (!c) { c = deformationCurve(model, weights, dirIdx, bucket); curveCache.set(key, c); }
    return c;
  };

  const applyEar = (base: number, dirIdx: number, hemiSign: number) => {
    const curve = curveFor(dirIdx, hemiSign);
    // Build a per-bin magnitude multiplier exp(Δlogmag), interpolating the (bins)-length
    // curve across the (half+1) FFT bins.
    re.fill(0); im.fill(0);
    for (let i = 0; i < taps; i++) re[i] = irs[base + i];
    fft(re, im, false);
    for (let b = 0; b <= half; b++) {
      // Map this FFT bin to the curve using the SAME log-spaced frequency grid the bake
      // used (normFreqToCurveIndex), so each deformation lands at the frequency it was
      // measured at. b=0 (DC) clamps to curve[0]; a linear map here is the historical bug.
      const cf = normFreqToCurveIndex(b / half, model.bins, model.nfft);
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
    const { az, el } = vecToAzEl(dirs[m * 3], dirs[m * 3 + 1], dirs[m * 3 + 2]);
    const dirIdx = nearestDirIndex(model, az, el);
    // Hemisphere sign for contrast PCs: −z = front → +1, +z = back → −1, fading through 0
    // near the median plane. Shifted by frontBackBias exactly like the parametric cue, so the
    // "push forward/back" knob moves BOTH the parametric cue and the FB contrast PCs together.
    const z = dirs[m * 3 + 2];
    const hemiSign = frontBackHemisphere(-z, frontBackBias);
    const base = m * stride;
    applyEar(base, dirIdx, hemiSign);
    applyEar(base + taps, dirIdx, hemiSign);
  }

  return { sampleRate, taps, count, dirs, irs, itdL: new Float32Array(itdL), itdR: new Float32Array(itdR) };
}
