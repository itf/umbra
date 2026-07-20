/**
 * PURE DSP for the click-free interpolating HRTF renderer.
 *
 * This module is the testable heart of the AudioWorklet renderer. It contains:
 *   1. A precompute step (`precomputeMinPhase`) that turns the measured, ITD-baked
 *      HRIRs into MIN-PHASE IRs (onset delay removed) plus a per-direction, per-ear
 *      ITD in fractional samples. Min-phase IRs are phase-aligned, so they can be
 *      LINEARLY BLENDED across directions without combing/smearing — the ITD is
 *      carried separately as a scalar and re-applied as a fractional delay.
 *   2. A `HrtfDsp` engine that, given a head-relative direction each block,
 *      (a) finds the K nearest measured directions + barycentric-ish weights,
 *      (b) builds an interpolated min-phase IR pair (weighted sum) + interpolated
 *          ITD per ear, all SMOOTHLY changing block-to-block (never reset),
 *      (c) convolves a mono input block against the current IR (direct FIR with a
 *          retained history ring), and applies the fractional ITD per ear.
 *
 * Because the IR is a continuous function of direction and the convolution state
 * (history ring) is never discarded, there is NO onset transient and NO buffer
 * reset → no click when crossing measured-direction buckets.
 *
 * Approach (a) from the brief: min-phase + interpolated ITD. Chosen because it is
 * the textbook comb-free method and keeps the measured magnitude spectrum intact.
 *
 * This file has NO Web Audio / DOM dependencies so it runs in vitest and inside the
 * AudioWorklet (the worklet just imports the same functions).
 */

export interface MinPhaseHrtf {
  sampleRate: number;
  taps: number;
  count: number;
  dirs: Float32Array; // count*3 unit vectors
  /** Min-phase L/R IRs interleaved per direction: [L(taps), R(taps)] * count. */
  irs: Float32Array; // count*2*taps
  /** Per-direction ITD per ear in samples (the onset delay removed by min-phase). */
  itdL: Float32Array; // count
  itdR: Float32Array; // count
}

// ----------------------------------------------------------------------------
// FFT (radix-2, in-place) — small, self-contained; used only at precompute.
// ----------------------------------------------------------------------------

export function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  // bit reversal
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * cwr - im[i + k + len / 2] * cwi;
        const vi = re[i + k + len / 2] * cwi + im[i + k + len / 2] * cwr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nwr;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
}

/**
 * Minimum-phase version of a real IR via the real-cepstrum method, and the onset
 * delay (in samples) that the min-phase transform removed (an ITD estimate).
 *
 * The min-phase IR has the SAME magnitude spectrum as the input but all its energy
 * packed at the front (no leading delay), so two min-phase IRs from nearby
 * directions are phase-coherent and safe to sum. The removed delay is recovered as
 * the centroid-of-energy difference between the original and the min-phase IR.
 */
export function minPhase(ir: Float32Array, fftSize: number): { mp: Float32Array; delay: number } {
  const n = fftSize;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < ir.length; i++) re[i] = ir[i];
  fft(re, im, false);
  // log|H|
  const logMag = new Float64Array(n);
  const EPS = 1e-8;
  for (let i = 0; i < n; i++) {
    const mag = Math.hypot(re[i], im[i]);
    logMag[i] = Math.log(mag < EPS ? EPS : mag);
  }
  // real cepstrum = IFFT(logMag)
  const cre = new Float64Array(n);
  const cim = new Float64Array(n);
  for (let i = 0; i < n; i++) cre[i] = logMag[i];
  fft(cre, cim, true);
  // fold cepstrum to make it causal (min-phase window)
  const wre = new Float64Array(n);
  const wim = new Float64Array(n);
  wre[0] = cre[0];
  for (let i = 1; i < n / 2; i++) wre[i] = 2 * cre[i];
  wre[n / 2] = cre[n / 2];
  // exp() in cepstral domain → FFT, exp, IFFT
  fft(wre, wim, false);
  for (let i = 0; i < n; i++) {
    const ex = Math.exp(wre[i]);
    wre[i] = ex * Math.cos(wim[i]);
    wim[i] = ex * Math.sin(wim[i]);
  }
  fft(wre, wim, true);
  const mp = new Float32Array(ir.length);
  for (let i = 0; i < ir.length; i++) mp[i] = wre[i];

  // Onset delay = energy-centroid(original) − energy-centroid(min-phase).
  const c0 = energyCentroid(ir);
  const cm = energyCentroid(mp);
  return { mp, delay: Math.max(0, c0 - cm) };
}

function energyCentroid(ir: Float32Array): number {
  let num = 0, den = 0;
  for (let i = 0; i < ir.length; i++) {
    const e = ir[i] * ir[i];
    num += i * e;
    den += e;
  }
  return den > 0 ? num / den : 0;
}

/** Precompute min-phase IRs + per-ear ITD for a whole HRTF set (main-thread). */
export function precomputeMinPhase(set: {
  sampleRate: number; taps: number; count: number; dirs: Float32Array; irs: Float32Array;
}): MinPhaseHrtf {
  const { sampleRate, taps, count, dirs, irs } = set;
  let fftSize = 1;
  while (fftSize < taps * 2) fftSize <<= 1; // pad ≥2× to avoid wrap
  const outIrs = new Float32Array(count * 2 * taps);
  const itdL = new Float32Array(count);
  const itdR = new Float32Array(count);
  const stride = 2 * taps;
  for (let m = 0; m < count; m++) {
    const base = m * stride;
    const l = irs.subarray(base, base + taps);
    const r = irs.subarray(base + taps, base + 2 * taps);
    const ml = minPhase(l, fftSize);
    const mr = minPhase(r, fftSize);
    outIrs.set(ml.mp, base);
    outIrs.set(mr.mp, base + taps);
    itdL[m] = ml.delay;
    itdR[m] = mr.delay;
  }
  return { sampleRate, taps, count, dirs, irs: outIrs, itdL, itdR };
}

// ----------------------------------------------------------------------------
// Direction interpolation: K nearest by dot product, weights summing to 1.
// ----------------------------------------------------------------------------

export interface KnnWeights {
  idx: Int32Array;
  w: Float32Array;
  k: number;
}

/**
 * K nearest measured directions to a query unit vector (max dot product), with
 * weights that sum to 1. Weight = (dot − cutoff) so the nearest dominates and a
 * direction at the K-th boundary contributes ~0 → as the query moves and the K-set
 * changes, the entering/leaving direction crosses with weight ~0 (CONTINUOUS, no
 * step). This is the key to click-free interpolation across buckets.
 */
export function knn(
  dirs: Float32Array, count: number, x: number, y: number, z: number, k: number,
  out?: KnnWeights,
): KnnWeights {
  const idx = out?.idx ?? new Int32Array(k);
  const w = out?.w ?? new Float32Array(k);
  const dots = out ? (out as any)._dots ?? ((out as any)._dots = new Float32Array(k)) : new Float32Array(k);
  for (let i = 0; i < k; i++) { idx[i] = -1; dots[i] = -Infinity; }
  for (let m = 0; m < count; m++) {
    const d = dirs[m * 3] * x + dirs[m * 3 + 1] * y + dirs[m * 3 + 2] * z;
    // insert into the top-k (small k, linear insert)
    if (d > dots[k - 1]) {
      let j = k - 1;
      while (j > 0 && dots[j - 1] < d) { dots[j] = dots[j - 1]; idx[j] = idx[j - 1]; j--; }
      dots[j] = d; idx[j] = m;
    }
  }
  // weight: (dot - cutoff), cutoff = the (k+1)-th best ≈ dots[k-1]; use that as floor
  const cutoff = dots[k - 1];
  let sum = 0;
  for (let i = 0; i < k; i++) {
    const wi = Math.max(0, dots[i] - cutoff);
    w[i] = wi;
    sum += wi;
  }
  if (sum <= 1e-9) {
    // degenerate (all equal): uniform
    for (let i = 0; i < k; i++) w[i] = 1 / k;
  } else {
    for (let i = 0; i < k; i++) w[i] /= sum;
  }
  return { idx, w, k };
}

// ----------------------------------------------------------------------------
// Block convolution engine (per source).
// ----------------------------------------------------------------------------

/** Fractional delay read from a ring buffer via linear interpolation. */
function readFrac(ring: Float32Array, writePos: number, size: number, delay: number): number {
  const d = delay < 0 ? 0 : delay;
  const i0 = Math.floor(d);
  const frac = d - i0;
  // position of "now - i0" sample
  let p0 = writePos - 1 - i0;
  while (p0 < 0) p0 += size;
  let p1 = p0 - 1;
  while (p1 < 0) p1 += size;
  return ring[p0] * (1 - frac) + ring[p1] * frac;
}

export class HrtfDsp {
  readonly taps: number;
  readonly count: number;
  private dirs: Float32Array;
  private irs: Float32Array; // min-phase
  private itdL: Float32Array;
  private itdR: Float32Array;
  private k: number;

  // Current interpolated IR pair (per ear). Smoothly updated each block.
  private curL: Float32Array;
  private curR: Float32Array;
  private prevL: Float32Array;
  private prevR: Float32Array;
  private curItdL = 0;
  private curItdR = 0;
  private prevItdL = 0;
  private prevItdR = 0;
  private firstBlock = true;

  // Per-ear delayed-input rings for applying the fractional ITD AFTER convolution.
  private delRingL: Float32Array;
  private delRingR: Float32Array;
  private delPos = 0;
  private delSize: number;

  private knnBuf: KnnWeights;

  // --- FFT (overlap-save) convolution state ---
  // The block-time convolution against a 256-tap IR is the dominant per-source cost;
  // overlap-save via FFT is the mathematically identical operation at O(F log F) per
  // block instead of O(block·taps). Sized to next-pow2(block + taps) so a full block
  // convolves without time-aliasing.
  private fftSize = 0;                 // 0 until the first process() sizes it to the block
  private reBuf!: Float64Array;        // scratch: input / product real part
  private imBuf!: Float64Array;        // scratch: input / product imag part
  // Frequency-domain IRs for the CURRENT and PREVIOUS direction, per ear. Swapped in
  // lockstep with curL/prevL so only the new `cur` IR is re-transformed per block.
  private curReL!: Float64Array; private curImL!: Float64Array;
  private curReR!: Float64Array; private curImR!: Float64Array;
  private prevReL!: Float64Array; private prevImL!: Float64Array;
  private prevReR!: Float64Array; private prevImR!: Float64Array;
  private curSpecDirty = true;        // cur IR changed since its spectrum was computed
  // True while the interpolated IR is UNCHANGED between blocks (a settled / static
  // source — the common case once the head stops moving). Then prev IR == cur IR, the
  // per-sample crossfade is a no-op, and we can convolve ONCE instead of twice per ear
  // — halving the per-block FFT work. Reset whenever setDirection produces a new IR.
  private settled = false;
  private lastDx = NaN; private lastDy = NaN; private lastDz = NaN;
  // Overlap-save history: the last (fftSize - block) input samples, prepended before
  // each block so the FIR sees the correct preceding context.
  private osHist!: Float64Array;      // length fftSize; [0..overlap) = carried tail
  private overlap = 0;                // fftSize - block (valid once sized)
  // Per-block convolution outputs (pre-crossfade), reused each block.
  private yPrevL!: Float64Array; private yPrevR!: Float64Array;
  private yCurL!: Float64Array; private yCurR!: Float64Array;
  // Spectral-product scratch (re/im), reused across the four per-block convolutions.
  private pRe!: Float64Array; private pIm!: Float64Array;

  constructor(mp: MinPhaseHrtf, k = 4) {
    this.taps = mp.taps;
    this.count = mp.count;
    this.dirs = mp.dirs;
    this.irs = mp.irs;
    this.itdL = mp.itdL;
    this.itdR = mp.itdR;
    this.k = k;
    this.curL = new Float32Array(this.taps);
    this.curR = new Float32Array(this.taps);
    this.prevL = new Float32Array(this.taps);
    this.prevR = new Float32Array(this.taps);
    this.delSize = 512; // > max ITD (samples) + block
    this.delRingL = new Float32Array(this.delSize);
    this.delRingR = new Float32Array(this.delSize);
    this.knnBuf = { idx: new Int32Array(k), w: new Float32Array(k), k };
  }

  /** Recompute the interpolated IR pair + ITD for a head-relative direction. */
  setDirection(x: number, y: number, z: number): void {
    const len = Math.hypot(x, y, z) || 1;
    const nx = x / len, ny = y / len, nz = z / len;
    // SETTLED fast path: an identical normalized direction yields an identical IR + ITD
    // (kNN is deterministic), so prev == cur and the block crossfade is a no-op. Mark it
    // so process() can convolve once per ear instead of twice. Skip the (identical)
    // recompute entirely — cur* already holds the right IR/spectrum from last block.
    if (!this.firstBlock && nx === this.lastDx && ny === this.lastDy && nz === this.lastDz) {
      this.settled = true;
      return;
    }
    this.settled = false;
    this.lastDx = nx; this.lastDy = ny; this.lastDz = nz;
    const w = knn(this.dirs, this.count, nx, ny, nz, this.k, this.knnBuf);
    // swap cur → prev for the block crossfade
    const tL = this.prevL; this.prevL = this.curL; this.curL = tL;
    const tR = this.prevR; this.prevR = this.curR; this.curR = tR;
    this.prevItdL = this.curItdL; this.prevItdR = this.curItdR;
    // Swap the frequency-domain IRs in lockstep: the just-demoted `cur` spectrum is
    // still valid as the new `prev`; only the new `cur` IR (recomputed below) needs a
    // fresh transform. This keeps it to ONE pair of IR FFTs per block, not two.
    if (this.fftSize > 0) {
      let s = this.prevReL; this.prevReL = this.curReL; this.curReL = s;
      s = this.prevImL; this.prevImL = this.curImL; this.curImL = s;
      s = this.prevReR; this.prevReR = this.curReR; this.curReR = s;
      s = this.prevImR; this.prevImR = this.curImR; this.curImR = s;
    }
    this.curSpecDirty = true;
    this.curL.fill(0);
    this.curR.fill(0);
    let itdL = 0, itdR = 0;
    const taps = this.taps;
    for (let i = 0; i < w.k; i++) {
      const idx = w.idx[i];
      if (idx < 0) continue;
      const wi = w.w[i];
      const base = idx * 2 * taps;
      for (let t = 0; t < taps; t++) {
        this.curL[t] += wi * this.irs[base + t];
        this.curR[t] += wi * this.irs[base + taps + t];
      }
      itdL += wi * this.itdL[idx];
      itdR += wi * this.itdR[idx];
    }
    this.curItdL = itdL;
    this.curItdR = itdR;
    if (this.firstBlock) {
      this.prevL.set(this.curL);
      this.prevR.set(this.curR);
      this.prevItdL = this.curItdL;
      this.prevItdR = this.curItdR;
      this.firstBlock = false;
      // prev == cur on the first block: force prev spectrum to be recomputed from the
      // (now identical) cur IR too, so the very first crossfade has matching spectra.
      this.prevSpecFromCur = true;
    }
  }

  /** Set on the first block so process() seeds prev spectrum = cur spectrum. */
  private prevSpecFromCur = false;

  /** Lazily size the FFT buffers for a block length `n` (first process() call). */
  private ensureFft(n: number): void {
    const taps = this.taps;
    let F = 1;
    while (F < n + taps - 1) F <<= 1; // ≥ block + taps − 1 ⇒ no time-aliasing
    this.fftSize = F;
    this.overlap = F - n;
    this.reBuf = new Float64Array(F);
    this.imBuf = new Float64Array(F);
    this.osHist = new Float64Array(F); // carried tail lives in [0..overlap)
    this.curReL = new Float64Array(F); this.curImL = new Float64Array(F);
    this.curReR = new Float64Array(F); this.curImR = new Float64Array(F);
    this.prevReL = new Float64Array(F); this.prevImL = new Float64Array(F);
    this.prevReR = new Float64Array(F); this.prevImR = new Float64Array(F);
    this.yPrevL = new Float64Array(n); this.yPrevR = new Float64Array(n);
    this.yCurL = new Float64Array(n); this.yCurR = new Float64Array(n);
    this.pRe = new Float64Array(F); this.pIm = new Float64Array(F);
  }

  /** Transform an IR (length taps, zero-padded to fftSize) into (re,im). */
  private irSpectrum(ir: Float32Array, re: Float64Array, im: Float64Array): void {
    re.fill(0); im.fill(0);
    for (let t = 0; t < this.taps; t++) re[t] = ir[t];
    fft(re, im, false);
  }

  /**
   * Convolve a mono input block into stereo out. Uses OVERLAP-SAVE FFT convolution —
   * the mathematically identical result to a direct FIR, at O(F log F) per block. Both
   * the PREVIOUS and CURRENT direction's IRs are convolved (so the per-sample IR
   * crossfade below can't zipper on a moving source); the crossfade and the fractional
   * ITD delay-ring stages are unchanged from the time-domain version.
   */
  process(input: Float32Array, outL: Float32Array, outR: Float32Array): void {
    const n = input.length;
    if (this.fftSize === 0 || this.overlap !== this.fftSize - n) this.ensureFft(n);
    const F = this.fftSize;
    const overlap = this.overlap;

    // Refresh the CURRENT IR spectrum only when the direction changed since last block.
    if (this.curSpecDirty) {
      this.irSpectrum(this.curL, this.curReL, this.curImL);
      this.irSpectrum(this.curR, this.curReR, this.curImR);
      this.curSpecDirty = false;
    }
    // On the very first block prev IR == cur IR, so mirror the spectrum too.
    if (this.prevSpecFromCur) {
      this.prevReL.set(this.curReL); this.prevImL.set(this.curImL);
      this.prevReR.set(this.curReR); this.prevImR.set(this.curImR);
      this.prevSpecFromCur = false;
    }

    // Overlap-save frame: [ carried tail (overlap) | this block (n) ]. Build it in
    // reBuf. Save the LAST `overlap` samples of the frame as next block's tail BEFORE
    // the in-place FFT clobbers reBuf.
    for (let i = 0; i < overlap; i++) this.reBuf[i] = this.osHist[i];
    for (let i = 0; i < n; i++) this.reBuf[overlap + i] = input[i];
    for (let i = 0; i < overlap; i++) this.osHist[i] = this.reBuf[F - overlap + i];
    this.imBuf.fill(0);
    fft(this.reBuf, this.imBuf, false);
    // Keep the input spectrum; the four ear/dir products reuse it.
    const xre = this.reBuf, xim = this.imBuf;

    // Convolve (spectral multiply + IFFT) for one IR spectrum, writing the last n
    // samples (the alias-free region of overlap-save) into `dst`.
    const conv = (
      hre: Float64Array, him: Float64Array, dst: Float64Array,
      pre: Float64Array, pim: Float64Array,
    ) => {
      for (let i = 0; i < F; i++) {
        // (xre+ j xim)(hre + j him)
        pre[i] = xre[i] * hre[i] - xim[i] * him[i];
        pim[i] = xre[i] * him[i] + xim[i] * hre[i];
      }
      fft(pre, pim, true);
      for (let s = 0; s < n; s++) dst[s] = pre[overlap + s];
    };

    conv(this.curReL, this.curImL, this.yCurL, this.pRe, this.pIm);
    conv(this.curReR, this.curImR, this.yCurR, this.pRe, this.pIm);
    if (this.settled) {
      // prev IR == cur IR ⇒ the crossfade is a no-op; reuse the cur convolution for
      // both, skipping the two prev IFFTs (the whole point of the settled fast path).
      // ITD may still differ across the block if it was mid-glide, so it's applied
      // per-sample below exactly as before — only the (identical) convolution is shared.
      this.yPrevL.set(this.yCurL);
      this.yPrevR.set(this.yCurR);
    } else {
      conv(this.prevReL, this.prevImL, this.yPrevL, this.pRe, this.pIm);
      conv(this.prevReR, this.prevImR, this.yPrevR, this.pRe, this.pIm);
    }

    // (tail already saved above, before the FFT clobbered reBuf)

    // Per-sample crossfade (prev→cur) + fractional ITD delay ring — identical to the
    // original time-domain tail, now fed by the FFT convolution results.
    for (let s = 0; s < n; s++) {
      const f = n > 1 ? s / (n - 1) : 1;
      const dryL = this.yPrevL[s] * (1 - f) + this.yCurL[s] * f;
      const dryR = this.yPrevR[s] * (1 - f) + this.yCurR[s] * f;
      this.delRingL[this.delPos] = dryL;
      this.delRingR[this.delPos] = dryR;
      const itdL = this.prevItdL * (1 - f) + this.curItdL * f;
      const itdR = this.prevItdR * (1 - f) + this.curItdR * f;
      this.delPos = (this.delPos + 1) % this.delSize;
      outL[s] = readFrac(this.delRingL, this.delPos, this.delSize, itdL);
      outR[s] = readFrac(this.delRingR, this.delPos, this.delSize, itdR);
    }
  }
}
