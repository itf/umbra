/**
 * Pure sample-analysis utilities for verifying spatial-audio correctness.
 *
 * These operate on raw Float32 sample buffers — the output of either an
 * OfflineAudioContext render (in the browser) or our IR builder (in tests). Both
 * the automated tests and the debug view share these so "what the test checks"
 * and "what you see on screen" are literally the same measurements.
 */

/** Root-mean-square level of a buffer (overall loudness). */
export function rms(buf: Float32Array): number {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / Math.max(1, buf.length));
}

/** Peak absolute sample (clipping check: should stay < 1). */
export function peak(buf: Float32Array): number {
  let m = 0;
  for (let i = 0; i < buf.length; i++) m = Math.max(m, Math.abs(buf[i]));
  return m;
}

/** True if any sample is NaN or Infinity (a hard correctness failure). */
export function hasInvalid(buf: Float32Array): boolean {
  for (let i = 0; i < buf.length; i++) if (!Number.isFinite(buf[i])) return true;
  return false;
}

export interface StereoEnergy {
  left: number;
  right: number;
  /** right − left, normalized to [-1,1]. >0 means source is to the right. */
  balance: number;
}

/** Compare L/R energy — the primary horizontal-direction check. */
export function stereoEnergy(left: Float32Array, right: Float32Array): StereoEnergy {
  const l = rms(left);
  const r = rms(right);
  const total = l + r || 1;
  return { left: l, right: r, balance: (r - l) / total };
}

/**
 * Interaural time difference in samples, via cross-correlation of L vs R.
 * Positive lag = right channel is delayed relative to left = sound reaches the
 * LEFT ear first = source is on the LEFT. (We return signed samples; caller maps
 * to seconds with /sampleRate.) Searches ±maxLag samples (default ~1ms @48k).
 */
export function interauralLagSamples(
  left: Float32Array,
  right: Float32Array,
  maxLag = 48,
): number {
  const n = Math.min(left.length, right.length);
  let bestLag = 0;
  let bestCorr = -Infinity;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let corr = 0;
    for (let i = 0; i < n; i++) {
      const j = i + lag;
      if (j < 0 || j >= n) continue;
      corr += left[i] * right[j];
    }
    if (corr > bestCorr) {
      bestCorr = corr;
      bestLag = lag;
    }
  }
  return bestLag;
}

/**
 * Naive DFT magnitude at a set of frequencies (Hz). O(F·N) — fine for short IRs
 * and a handful of band centers; we don't need a full FFT for band ratios. Use
 * for "is the high end rolled off?" distance/material checks.
 */
export function bandEnergy(
  buf: Float32Array,
  sampleRate: number,
  freqs: readonly number[],
): number[] {
  const N = buf.length;
  return freqs.map((f) => {
    const w = (2 * Math.PI * f) / sampleRate;
    let re = 0;
    let im = 0;
    for (let n = 0; n < N; n++) {
      re += buf[n] * Math.cos(w * n);
      im -= buf[n] * Math.sin(w * n);
    }
    return Math.hypot(re, im) / N;
  });
}

/** Ratio of high-band to low-band energy — a single "brightness" number. */
export function brightness(buf: Float32Array, sampleRate: number): number {
  const [lo, hi] = bandEnergy(buf, sampleRate, [250, 6000]);
  return hi / (lo || 1e-9);
}

/**
 * Find the sample index of the first salient peak AFTER the direct sound — i.e.
 * the first reflection. Skips the initial direct-arrival region, then returns the
 * first local maximum exceeding `threshold` × the global peak. This is the
 * room-size cue: a bigger room → later first reflection.
 */
export function firstReflectionSample(
  buf: Float32Array,
  opts: { skip?: number; threshold?: number } = {},
): number {
  const skip = opts.skip ?? 1;
  const threshold = opts.threshold ?? 0.05;
  const pk = peak(buf);
  const limit = threshold * pk;
  // Find the direct peak first, then look beyond it.
  let directIdx = 0;
  let directVal = -1;
  for (let i = 0; i < buf.length; i++) {
    if (Math.abs(buf[i]) > directVal) {
      directVal = Math.abs(buf[i]);
      directIdx = i;
    }
  }
  for (let i = directIdx + skip + 1; i < buf.length - 1; i++) {
    const a = Math.abs(buf[i]);
    if (a > limit && a >= Math.abs(buf[i - 1]) && a > Math.abs(buf[i + 1])) {
      return i;
    }
  }
  return -1;
}

/** Downsample a buffer to `points` min/max pairs for waveform drawing. */
export function waveformPeaks(buf: Float32Array, points: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const step = Math.max(1, Math.floor(buf.length / points));
  for (let i = 0; i < buf.length; i += step) {
    let mn = Infinity;
    let mx = -Infinity;
    for (let j = i; j < Math.min(i + step, buf.length); j++) {
      if (buf[j] < mn) mn = buf[j];
      if (buf[j] > mx) mx = buf[j];
    }
    out.push([mn, mx]);
  }
  return out;
}
