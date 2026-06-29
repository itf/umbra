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
import { isAcousticsReady, type Tap } from './core';
import { build_room_ir } from './wasm/acoustics_core.js';

export interface RoomIrOptions {
  /** Head yaw (radians) so tap world-directions become head-relative. */
  yaw?: number;
  /** Extra tail seconds beyond the latest tap (headroom for filter ringing). */
  tailPad?: number;
  /**
   * Representative scattering coefficient (0..1) for the room's surfaces. When >0,
   * each reflection keeps (1−s) of its energy as a crisp specular tap and spreads
   * the remaining s as a short diffuse "smear" (a few jittered, decaying copies).
   * This makes rough surfaces (brick, gravel) sound soft and spread-out rather
   * than a single sharp echo. A scalar is sufficient at this altitude.
   */
  scattering?: number;
  /**
   * LATE REVERB (FDN tail). When enabled (default), an offline-rendered Feedback Delay
   * Network tail is overlap-added onto the early IR so rooms decay smoothly instead of
   * stopping abruptly. The tail's reverberation time is derived from the room (see
   * `room` below) or set explicitly via `rt60`. Set `tail: false` to omit it (e.g. for
   * tests that assert purely on the early field).
   */
  tail?: boolean;
  /**
   * Room geometry+materials used to derive RT60 via an Eyring estimate (preferred over
   * passing `rt60` directly): { volume m³, surfaceArea m², meanAbsorption 0..1 }. When
   * absent, no tail is generated unless `rt60` is given explicitly.
   */
  room?: { volume: number; surfaceArea: number; meanAbsorption: number };
  /** Explicit broadband RT60 (seconds), overrides `room`-derived RT60. */
  rt60?: number;
  /** Multiply the room-derived RT60 by this (a single tuning knob). Default 1. */
  rt60Scale?: number;
  /** HF RT60 ratio (highs decay faster): rt60_hf/rt60 in (0,1). Default 0.5. */
  rt60HfRatio?: number;
  /** Wet-level multiplier for the late tail (1 = continuity-matched). Default 1. */
  wet?: number;
}

/** Speed of sound used for the Sabine/Eyring RT60 estimate (m/s). */
const SPEED_OF_SOUND = 343;

/**
 * Estimate broadband RT60 (seconds) from room geometry + mean absorption.
 *
 * We use the **Eyring** form (better than Sabine for absorbent rooms, and it stays
 * finite as ᾱ→1):
 *
 *     RT60 = 0.161 · V / ( −S · ln(1 − ᾱ) )
 *
 * where V = volume (m³), S = total surface area (m²), ᾱ = mean absorption coefficient.
 * Sabine is the ᾱ→0 limit (−S·ln(1−ᾱ) → S·ᾱ). The constant 0.161 = 24·ln(10)/c with
 * c≈343 m/s. A large hard room (big V, small ᾱ) → long RT60; a small absorbent room →
 * short RT60 — exactly the audible contrast we want.
 */
export function eyringRt60(volume: number, surfaceArea: number, meanAbsorption: number): number {
  if (volume <= 0 || surfaceArea <= 0) return 0;
  const a = Math.max(1e-3, Math.min(0.999, meanAbsorption));
  const k = (24 * Math.LN10) / SPEED_OF_SOUND; // ≈ 0.161
  const eyringAbs = -surfaceArea * Math.log(1 - a);
  if (eyringAbs <= 0) return 0;
  return (k * volume) / eyringAbs;
}

/** Resolve the FDN tail params (rt60, hfRatio, wet) for a build; rt60=0 disables it. */
function resolveTail(opts: RoomIrOptions): { rt60: number; hfRatio: number; wet: number } {
  if (opts.tail === false) return { rt60: 0, hfRatio: 0.5, wet: 1 };
  let rt60 = 0;
  if (opts.rt60 != null && opts.rt60 > 0) {
    rt60 = opts.rt60;
  } else if (opts.room) {
    rt60 = eyringRt60(opts.room.volume, opts.room.surfaceArea, opts.room.meanAbsorption);
  }
  rt60 *= opts.rt60Scale ?? 1;
  // Clamp so a degenerate room can't generate a multi-minute IR.
  rt60 = Math.max(0, Math.min(8, rt60));
  return { rt60, hfRatio: opts.rt60HfRatio ?? 0.5, wet: opts.wet ?? 1 };
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

/**
 * Build the room IR. By default this dispatches to the FFT-based WASM path
 * (`buildRoomIrWasm`), which is ~10-50x faster than the JS reference and the
 * thing that makes per-frame rebuilds (moving walls) viable. Pass
 * `{ impl: 'js' }` to force the original JS reference (used for comparison/bench
 * and as a fallback if WASM isn't initialized).
 *
 * JS↔WASM split: the cheap `nearestDir` HRIR lookup stays in JS (keeps the SOFA
 * loader JS-only); the expensive band-FIR coloring + convolution + accumulation
 * + scattering happen in WASM.
 */
export function buildRoomIr(
  taps: Tap[],
  hrtf: HrtfSet,
  opts: RoomIrOptions & { impl?: 'wasm' | 'js' } = {},
): RoomIr {
  // Explicit overrides always honored.
  if (opts.impl === 'js') return buildRoomIrJs(taps, hrtf, opts);
  if (opts.impl === 'wasm') return buildRoomIrWasm(taps, hrtf, opts);
  // Default dispatch: only fall back to JS when WASM is NOT yet initialized.
  // Once it's ready we let any build_room_ir error propagate rather than
  // silently producing a divergent JS IR (which would mask real WASM bugs).
  if (!isAcousticsReady()) return buildRoomIrJs(taps, hrtf, opts);
  return buildRoomIrWasm(taps, hrtf, opts);
}

/**
 * WASM path: JS resolves each tap's HRIR pair via nearestDir, packs the tap
 * scalars + HRIR pairs flat, and hands the convolution-heavy work to Rust.
 * Requires `initAcoustics()` to have run (same module as computeShoeboxTaps).
 */
export function buildRoomIrWasm(taps: Tap[], hrtf: HrtfSet, opts: RoomIrOptions = {}): RoomIr {
  const yaw = opts.yaw ?? 0;
  const sr = hrtf.sampleRate;
  const tailPad = opts.tailPad ?? 0.05;
  const scatter = Math.max(0, Math.min(1, opts.scattering ?? 0));
  const hlen = hrtf.taps;

  // Resolve HRIR pairs in JS (cheap), drop taps with no valid direction.
  const tapStride = 3 + NUM_BANDS;
  const tapData = new Float32Array(taps.length * tapStride);
  const hrirL = new Float32Array(taps.length * hlen);
  const hrirR = new Float32Array(taps.length * hlen);
  let n = 0;
  for (const t of taps) {
    const hd = worldDirToHead(t.dir, yaw);
    const len = Math.hypot(hd[0], hd[1], hd[2]) || 1;
    const idx = nearestDir(hrtf, hd[0] / len, hd[1] / len, hd[2] / len);
    if (idx < 0) continue;
    const { left: hl, right: hr } = getIrPair(hrtf, idx);
    const o = n * tapStride;
    tapData[o] = t.delay;
    tapData[o + 1] = t.gain;
    tapData[o + 2] = t.order;
    for (let b = 0; b < NUM_BANDS; b++) tapData[o + 3 + b] = t.bandGains[b];
    hrirL.set(hl, n * hlen);
    hrirR.set(hr, n * hlen);
    n++;
  }
  const td = tapData.subarray(0, n * tapStride);
  const hL = hrirL.subarray(0, n * hlen);
  const hR = hrirR.subarray(0, n * hlen);

  const { rt60, hfRatio, wet } = resolveTail(opts);
  const out = build_room_ir(td, hL, hR, hlen, sr, scatter, tailPad, rt60, hfRatio, wet);
  const length = out[0] | 0; // out[0] is a float; floor to an int index.
  const left = out.slice(1, 1 + length);
  const right = out.slice(1 + length, 1 + 2 * length);
  return { left, right, sampleRate: sr, length };
}

/** Original plain-JS reference implementation (kept for comparison + fallback). */
export function buildRoomIrJs(taps: Tap[], hrtf: HrtfSet, opts: RoomIrOptions = {}): RoomIr {
  const yaw = opts.yaw ?? 0;
  const sr = hrtf.sampleRate;
  const tailPad = opts.tailPad ?? 0.05;
  const scatter = Math.max(0, Math.min(1, opts.scattering ?? 0));
  // Diffuse smear length (seconds) — how far a scattered reflection spreads.
  const smearSec = 0.02;
  const smearN = Math.ceil(smearSec * sr);

  // Output length: latest tap delay + HRIR length + band-FIR length + smear + pad.
  let maxDelay = 0;
  for (const t of taps) if (t.delay > maxDelay) maxDelay = t.delay;
  const extra = hrtf.taps + hrtf.taps + smearN + Math.ceil(tailPad * sr);
  const earlyLen = Math.ceil(maxDelay * sr) + extra;

  // Late FDN tail params + total length (mirrors ir_build.rs).
  const { rt60, hfRatio, wet } = resolveTail(opts);
  const tailSamples = rt60 > 0 ? Math.ceil((rt60 * 1.05 + 0.05) * sr) : 0;
  const length = earlyLen + tailSamples;

  const left = new Float32Array(length);
  const right = new Float32Array(length);

  // Deterministic jitter for the diffuse smear (avoids Math.random for testability).
  let seed = 0x9e3779b9;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };

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

    // Scattering: the direct path (order 0) is never scattered. For reflections,
    // keep (1−s) specular and spread s as a short diffuse tail of jittered copies.
    const s = t.order === 0 ? 0 : scatter;
    const specGain = t.gain * (1 - s);
    place(left, right, cl, cr, Math.round(t.delay * sr), specGain, length);

    if (s > 0) {
      const copies = 6;
      const baseOff = Math.round(t.delay * sr);
      for (let c = 0; c < copies; c++) {
        const jitter = Math.round(rand() * smearN);
        // Each diffuse copy is quieter and later; total diffuse energy ≈ s·gain.
        const decay = (1 - jitter / smearN) * (0.5 + 0.5 * rand());
        const dg = (t.gain * s * decay) / copies;
        place(left, right, cl, cr, baseOff + jitter, dg, length);
      }
    }
  }

  // LATE REVERB: render the FDN tail offline and overlap-add it (see fdnTail / the
  // Rust mirror in ir_build.rs for the structure + continuity handling).
  if (tailSamples > 0) {
    const handover = Math.min(Math.round(maxDelay * sr), earlyLen - 1);
    const win = Math.ceil(0.01 * sr);
    const w0 = Math.max(0, handover - win);
    let el = 0, er = 0, wn = 0;
    for (let i = w0; i < Math.min(handover, left.length); i++) {
      el += left[i] * left[i];
      er += right[i] * right[i];
      wn++;
    }
    const rmsL = wn > 0 ? Math.sqrt(el / wn) : 0;
    const rmsR = wn > 0 ? Math.sqrt(er / wn) : 0;
    let peak = 0;
    for (let i = 0; i < Math.min(earlyLen, left.length); i++) {
      peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
    }
    const seedL = rmsL > 1e-6 ? rmsL : peak * 0.1;
    const seedR = rmsR > 1e-6 ? rmsR : peak * 0.1;
    const { tl, tr } = fdnTail(tailSamples, sr, rt60, hfRatio, seedL, seedR);
    const xfade = Math.ceil(0.005 * sr);
    for (let i = 0; i < tl.length; i++) {
      const o = handover + i;
      if (o >= length) break;
      const ramp = i < xfade ? Math.max(0, Math.min(1, 0.5 - 0.5 * Math.cos((Math.PI * i) / xfade))) : 1;
      left[o] += tl[i] * wet * ramp;
      right[o] += tr[i] * wet * ramp;
    }
  }

  return { left, right, sampleRate: sr, length };
}

/**
 * Stereo FDN late-reverb tail (JS mirror of `fdn_tail` in ir_build.rs). 8 mutually-
 * prime delay lines, lossless Householder feedback matrix, per-line one-pole HF
 * damping, decorrelated L/R output taps. Excited by a single seed impulse so the tail
 * starts at the early-field handover level and decays per RT60. See docs/engine/
 * late-reverb-fdn.md for the design rationale.
 */
function fdnTail(
  nOut: number, sr: number, rt60: number, hfRatio: number, seedL: number, seedR: number,
): { tl: Float32Array; tr: Float32Array } {
  const tl = new Float32Array(nOut);
  const tr = new Float32Array(nOut);
  if (nOut === 0 || rt60 <= 0) return { tl, tr };
  const N = 8;
  const basePrimes = [809, 877, 937, 1049, 1151, 1249, 1373, 1499];
  const scale = sr / 48000;
  const lens = basePrimes.map((p) => Math.max(1, Math.round(p * scale)));
  const g = new Float32Array(N);
  const damp = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const d = lens[i] / sr;
    g[i] = Math.pow(10, (-3 * d) / rt60);
    const gHf = Math.pow(10, (-3 * d) / (rt60 * hfRatio));
    damp[i] = Math.max(0.05, Math.min(1, gHf / g[i]));
  }
  const lpA = 2 / N; // Householder M = I − (2/N)·J
  const lines = lens.map((l) => new Float32Array(l));
  const widx = new Int32Array(N);
  const lpState = new Float32Array(N);
  const inGain = 1 / Math.sqrt(N);
  const s = new Float32Array(N);
  for (let t = 0; t < nOut; t++) {
    let sum = 0;
    for (let i = 0; i < N; i++) {
      const v = lines[i][widx[i]];
      const a = 1 - damp[i];
      const y = (1 - a) * v + a * lpState[i];
      lpState[i] = y;
      s[i] = y;
      sum += y;
    }
    let ol = 0, or = 0;
    for (let i = 0; i < N; i++) {
      if (i % 2 === 0) { ol += s[i]; or += 0.4 * s[i]; }
      else { or += s[i]; ol += 0.4 * s[i]; }
    }
    tl[t] = ol * inGain;
    tr[t] = or * inGain;
    for (let i = 0; i < N; i++) {
      const mixed = s[i] - lpA * sum;
      let fb = g[i] * mixed;
      if (t === 0) {
        const sgn = i % 2 === 0 ? 1 : -1;
        const seed = i % 2 === 0 ? seedL : seedR;
        fb += sgn * seed * inGain;
      }
      lines[i][widx[i]] = fb;
      widx[i] = (widx[i] + 1) % lines[i].length;
    }
  }
  return { tl, tr };
}

/** Add a convolved L/R tap into the output buffers at a sample offset. */
function place(
  left: Float32Array, right: Float32Array,
  cl: Float32Array, cr: Float32Array,
  offset: number, gain: number, length: number,
) {
  if (gain === 0) return;
  for (let i = 0; i < cl.length; i++) {
    const o = offset + i;
    if (o >= length) break;
    if (o < 0) continue;
    left[o] += cl[i] * gain;
    right[o] += cr[i] * gain;
  }
}
