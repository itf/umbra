/**
 * Pure artifact detectors for rendered audio buffers — CLICK / ZIPPER / CLIP.
 *
 * These run on raw Float32 output (from an OfflineAudioContext render or any
 * synthetic signal) and are independently unit-testable. The offline-render
 * artifact suite (tests/audioArtifacts.test.ts) feeds real engine output through
 * `detectClicks` / `clipCount`; the unit tests feed synthetic clean and clicky
 * signals to calibrate thresholds.
 *
 * A "click" here is a sample-to-sample discontinuity far larger than the local
 * signal warrants — the audible signature of a buffer swap, an ungated gain jump,
 * or a delay-line glitch. We measure each step |x[n]-x[n-1]| against a LOCAL RMS
 * window so the metric is amplitude-independent: a quiet click is still a click.
 */

/**
 * Local RMS over a centered window of half-width `half` around index i, EXCLUDING
 * a small guard band (±`guard` samples) right at i. The guard means a short
 * transient (a click is 1–3 samples) is measured against the surrounding signal,
 * not against itself — otherwise a big spike inflates its own reference and hides.
 */
function localRms(buf: Float32Array, i: number, half: number, guard: number): number {
  let s = 0;
  let n = 0;
  const lo = Math.max(0, i - half);
  const hi = Math.min(buf.length - 1, i + half);
  for (let j = lo; j <= hi; j++) {
    if (Math.abs(j - i) <= guard) continue;
    s += buf[j] * buf[j];
    n++;
  }
  return Math.sqrt(s / Math.max(1, n));
}

export interface ClickReport {
  /** Largest discontinuity ratio found: max |x[n]-x[n-1]| / (localRms + floor). */
  maxRatio: number;
  /** Sample index of that worst step. */
  atSample: number;
  /** How many steps exceeded `threshold`. */
  count: number;
  /** The raw worst |x[n]-x[n-1]| jump. */
  maxJump: number;
}

export interface ClickOptions {
  /** Discontinuity ratio above which a step counts as a click. Default 8. */
  threshold?: number;
  /** Half-width (samples) of the local-RMS window. Default 64. */
  window?: number;
  /** Noise floor added to the local RMS so silence doesn't blow up the ratio. */
  floor?: number;
  /** Guard half-width excluded from the local-RMS reference. Default 3. */
  guard?: number;
}

/**
 * Scan a buffer for discontinuities. The ratio normalizes each first-difference
 * by the local RMS, so a clean sine (whose max step is bounded by its own slope)
 * scores low while an inserted spike scores high regardless of overall level.
 *
 * Calibration note: a band-limited sine at 1 kHz / 48 k has a per-sample step of
 * at most ~2π·f/fs × amplitude ≈ 0.13 × amp, while its local RMS ≈ 0.707 × amp,
 * giving a ratio ≈ 0.18 — far below the default threshold of 8. An equal-power
 * crossfade between two correlated convolver outputs likewise stays smooth. A real
 * buffer-swap click produces a step several times the local RMS → ratio ≫ 8.
 */
export function detectClicks(buf: Float32Array, opts: ClickOptions = {}): ClickReport {
  const threshold = opts.threshold ?? 8;
  const window = opts.window ?? 64;
  const floor = opts.floor ?? 1e-4;
  const guard = opts.guard ?? 3;
  let maxRatio = 0;
  let atSample = 0;
  let maxJump = 0;
  let count = 0;
  for (let i = 1; i < buf.length; i++) {
    const jump = Math.abs(buf[i] - buf[i - 1]);
    if (jump > maxJump) maxJump = jump;
    const ref = localRms(buf, i, window, guard) + floor;
    const ratio = jump / ref;
    if (ratio > maxRatio) {
      maxRatio = ratio;
      atSample = i;
    }
    if (ratio > threshold) count++;
  }
  return { maxRatio, atSample, count, maxJump };
}

/** Worst click ratio across BOTH channels of a stereo render. */
export function detectClicksStereo(
  left: Float32Array,
  right: Float32Array,
  opts: ClickOptions = {},
): ClickReport {
  const l = detectClicks(left, opts);
  const r = detectClicks(right, opts);
  return l.maxRatio >= r.maxRatio ? l : r;
}

/** Count samples that exceed ±limit (hard-clip / out-of-bounds). limit default 1. */
export function clipCount(buf: Float32Array, limit = 1.0): number {
  let n = 0;
  for (let i = 0; i < buf.length; i++) {
    if (Math.abs(buf[i]) > limit) n++;
  }
  return n;
}
