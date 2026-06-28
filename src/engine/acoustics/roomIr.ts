/**
 * Build a stereo room impulse response from acoustics taps + an HRTF set.
 *
 * Each tap is a delayed, direction-filtered, band-shaped copy of the source.
 * Collapsing all taps into ONE stereo IR means the runtime cost is a single
 * ConvolverNode convolution of the dry sound (e.g. a clap) — not N per-tap
 * filter chains. This is the standard auralization shortcut and is what makes
 * "clap to hear the room" cheap enough for real time.
 *
 * Per-tap rendering:
 *   1. take the HRIR pair for the tap's arrival direction (head-relative),
 *   2. color it by the tap's per-band gains (material + air absorption),
 *   3. scale by broadband 1/r gain,
 *   4. add it into the output IR at the sample offset = round(delay * sampleRate).
 *
 * Band coloration (V1 approximation): rather than an FFT per tap, we apply the
 * band gains as a short linear-phase FIR derived from the 8 band targets. This
 * is cheap, dependency-free, and audibly captures "duller vs brighter"
 * reflections. A frequency-sampled FIR / FFT path can replace it later for
 * accuracy without changing this interface.
 */
import { getIrPair, nearestDir, type HrtfSet } from '../hrtf/sofa';
import { BANDS_HZ, NUM_BANDS } from './materials';
import type { Tap } from './core';

export interface RoomIrOptions {
  /** Head yaw (radians) so tap world-directions become head-relative. */
  yaw?: number;
  /** Extra tail seconds beyond the latest tap (headroom for filter ringing). */
  tailPad?: number;
}

/** Rotate a world direction into head-local space (inverse listener yaw). */
function worldDirToHead(d: [number, number, number], yaw: number): [number, number, number] {
  const c = Math.cos(-yaw);
  const s = Math.sin(-yaw);
  return [d[0] * c - d[2] * s, d[1], d[0] * s + d[2] * c];
}

/**
 * Build a tiny symmetric FIR (length = taps) whose magnitude response roughly
 * matches the 8 band gains. We use frequency sampling: target magnitude at each
 * band center, inverse-DFT to a short kernel, windowed. Length is small (the
 * HRIR length) so this is cheap.
 */
function bandFir(bandGains: number[], length: number, sampleRate: number): Float32Array {
  // Degenerate IR lengths can't carry frequency shaping; return a scaled impulse
  // using the broadband-ish average so callers stay well-defined.
  if (length < 4) {
    const avg = bandGains.reduce((s, v) => s + v, 0) / bandGains.length;
    const k = new Float32Array(Math.max(1, length));
    k[0] = avg;
    return k;
  }
  // Frequency-sample: for each output frequency bin up to Nyquist, interpolate a
  // target magnitude from the band centers, then build a linear-phase FIR via a
  // real inverse transform. length is ~256 so an O(length^2) build is fine here
  // (only runs when the IR is (re)built, not per audio frame).
  const half = Math.floor(length / 2);
  const fir = new Float32Array(length);
  const nyquist = sampleRate / 2;

  const targetAt = (freq: number): number => {
    if (freq <= BANDS_HZ[0]) return bandGains[0];
    if (freq >= BANDS_HZ[NUM_BANDS - 1]) return bandGains[NUM_BANDS - 1];
    for (let b = 1; b < NUM_BANDS; b++) {
      if (freq <= BANDS_HZ[b]) {
        const f0 = BANDS_HZ[b - 1];
        const f1 = BANDS_HZ[b];
        const t = (Math.log(freq) - Math.log(f0)) / (Math.log(f1) - Math.log(f0));
        return bandGains[b - 1] * (1 - t) + bandGains[b] * t;
      }
    }
    return bandGains[NUM_BANDS - 1];
  };

  // Build symmetric (linear-phase) kernel: h[n] = (1/N) Σ_k H[k] cos(2π k (n-half)/N)
  const N = length;
  for (let n = 0; n < N; n++) {
    let acc = 0;
    for (let k = 0; k <= N / 2; k++) {
      const freq = (k / (N / 2)) * nyquist;
      const mag = targetAt(freq);
      const w = k === 0 || k === N / 2 ? 1 : 2;
      acc += w * mag * Math.cos((2 * Math.PI * k * (n - half)) / N);
    }
    fir[n] = acc / N;
  }
  // Hann window to tame ripple.
  for (let n = 0; n < N; n++) {
    fir[n] *= 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (N - 1));
  }
  return fir;
}

/** Convolve a (short) FIR into an HRIR copy: returns length a+b-1. */
function convolve(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length + b.length - 1);
  for (let i = 0; i < a.length; i++) {
    const ai = a[i];
    if (ai === 0) continue;
    for (let j = 0; j < b.length; j++) out[i + j] += ai * b[j];
  }
  return out;
}

export interface RoomIr {
  left: Float32Array;
  right: Float32Array;
  sampleRate: number;
  length: number;
}

export function buildRoomIr(taps: Tap[], hrtf: HrtfSet, opts: RoomIrOptions = {}): RoomIr {
  const yaw = opts.yaw ?? 0;
  const sr = hrtf.sampleRate;
  const tailPad = opts.tailPad ?? 0.05;

  // Output length: latest tap delay + HRIR length + band-FIR length + pad.
  let maxDelay = 0;
  for (const t of taps) if (t.delay > maxDelay) maxDelay = t.delay;
  const extra = hrtf.taps + hrtf.taps + Math.ceil(tailPad * sr);
  const length = Math.ceil(maxDelay * sr) + extra;

  const left = new Float32Array(length);
  const right = new Float32Array(length);

  for (const t of taps) {
    const hd = worldDirToHead(t.dir, yaw);
    const len = Math.hypot(hd[0], hd[1], hd[2]) || 1;
    const idx = nearestDir(hrtf, hd[0] / len, hd[1] / len, hd[2] / len);
    if (idx < 0) continue;
    const { left: hl, right: hr } = getIrPair(hrtf, idx);

    // Color both ears by the same band FIR (material/air coloration is direction-
    // independent at this altitude).
    const fir = bandFir(t.bandGains, hrtf.taps, sr);
    const cl = convolve(hl, fir);
    const cr = convolve(hr, fir);

    const offset = Math.round(t.delay * sr);
    const g = t.gain;
    for (let i = 0; i < cl.length; i++) {
      const o = offset + i;
      if (o >= length) break;
      left[o] += cl[i] * g;
      right[o] += cr[i] * g;
    }
  }

  return { left, right, sampleRate: sr, length };
}
