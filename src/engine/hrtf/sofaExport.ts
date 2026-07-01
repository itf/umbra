/**
 * Reconstruct a full-HRIR HRTF set from our runtime min-phase + ITD representation,
 * so a user's PERSONALIZED head response can be exported as a standard SOFA file for
 * use in OTHER programs (Steam Audio, OpenAL Soft, SPARTA, etc.).
 *
 * Our engine stores each direction as a min-phase magnitude IR plus a per-ear onset
 * DELAY (the ITD the min-phase transform stripped out) — that's what the worklet
 * recombines at play time. To export a normal HRIR we do the same recombination
 * offline: shift each ear's min-phase IR right by its ITD (fractional, via linear
 * interpolation) into a buffer long enough to hold the largest delay. The result is a
 * causal, correctly-delayed L/R impulse-response pair per direction — a faithful
 * frozen copy of exactly what the listener calibrated.
 *
 * Pure math (no HDF5, no DOM) so it's unit-testable; the actual SOFA/HDF5 serialization
 * (which needs h5wasm) lives in sofaWrite.ts and consumes this.
 */
import type { MinPhaseHrtf } from './interpolatingDsp';

export interface ReconstructedHrtf {
  sampleRate: number;
  /** Number of directions (measurements). */
  count: number;
  /** Taps per ear in the reconstructed HRIR (>= input taps, room for the ITD shift). */
  taps: number;
  /** Full HRIRs, [L(taps), R(taps)] interleaved per direction (count*2*taps). */
  irs: Float32Array;
  /** SourcePosition rows: [azimuth°, elevation°, distance m] * count. */
  positions: Float32Array;
}

/** Read one fractional-delay sample from `src[base..base+len)` at position `pos`
 *  (linear interpolation, zero outside range). Used to apply a non-integer ITD. */
function readFrac(src: Float32Array, base: number, len: number, pos: number): number {
  if (pos < 0) return 0; // before the delayed onset → silence, not the first tap
  const i = Math.floor(pos);
  if (i >= len) return 0;
  const frac = pos - i;
  const a = src[base + i] ?? 0;
  const b = i + 1 < len ? (src[base + i + 1] ?? 0) : 0;
  return a * (1 - frac) + b * frac;
}

/** Direction unit vector (engine: +x right, +y up, −z front) → SOFA spherical coords.
 *  SOFA SimpleFreeFieldHRIR: azimuth CCW from front in the horizontal plane (degrees,
 *  0=front, 90=left), elevation up (degrees). */
export function vecToAzEl(x: number, y: number, z: number): [number, number] {
  const el = Math.asin(Math.max(-1, Math.min(1, y))) * (180 / Math.PI);
  // Front is −z. Azimuth measured CCW (toward +... left). In engine coords +x is right,
  // so left is −x → CCW positive means azimuth = atan2(−x, −z).
  let az = Math.atan2(-x, -z) * (180 / Math.PI);
  if (az < 0) az += 360;
  return [az, el];
}

/**
 * Reconstruct full HRIRs from a (possibly personalized) min-phase set. `distanceM`
 * labels the measurement shell in the SOFA SourcePosition (we render far-field, so a
 * nominal ~1.5 m is fine and matches typical measured sets).
 */
export function reconstructHrtf(mp: MinPhaseHrtf, distanceM = 1.5): ReconstructedHrtf {
  const { sampleRate, taps, count, dirs, irs, itdL, itdR } = mp;
  // Headroom for the largest ITD so no delayed tap is clipped.
  let maxItd = 0;
  for (let m = 0; m < count; m++) {
    if (itdL[m] > maxItd) maxItd = itdL[m];
    if (itdR[m] > maxItd) maxItd = itdR[m];
  }
  const outTaps = taps + Math.ceil(maxItd) + 1;
  const out = new Float32Array(count * 2 * outTaps);
  const positions = new Float32Array(count * 3);
  const inStride = 2 * taps;
  const outStride = 2 * outTaps;

  for (let m = 0; m < count; m++) {
    const inBaseL = m * inStride;
    const inBaseR = inBaseL + taps;
    const outBaseL = m * outStride;
    const outBaseR = outBaseL + outTaps;
    const dL = itdL[m];
    const dR = itdR[m];
    // Place the min-phase IR starting at its ITD (fractional) in the output buffer.
    for (let i = 0; i < outTaps; i++) {
      out[outBaseL + i] = readFrac(irs, inBaseL, taps, i - dL);
      out[outBaseR + i] = readFrac(irs, inBaseR, taps, i - dR);
    }
    const [az, el] = vecToAzEl(dirs[m * 3], dirs[m * 3 + 1], dirs[m * 3 + 2]);
    positions[m * 3] = az;
    positions[m * 3 + 1] = el;
    positions[m * 3 + 2] = distanceM;
  }

  return { sampleRate, count, taps: outTaps, irs: out, positions };
}
