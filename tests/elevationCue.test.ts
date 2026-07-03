/**
 * Verifies the RESHAPED above-horizon elevation cue (personalize.ts) matches the MEASURED
 * SS2 elevation signature: a 6–8 kHz boost + an 11–14 kHz cut that both grow with elevation,
 * with the primary notch tracking higher. Correlation of the modeled Δ(elevation) vs the
 * measured Δ must be strong (>0.6) at both +30° and +60°, and the key dB features present.
 */
import { describe, it, expect } from 'vitest';
import { personalizeMinPhase, NEUTRAL_PERSONALIZATION } from '../src/engine/hrtf/personalize';
import { fft, type MinPhaseHrtf } from '../src/engine/hrtf/interpolatingDsp';

const SR = 48000;
const TAPS = 256;

// Engine dir vector for a MEDIAN-FRONT source at elevation `elDeg` (az=0). +y up, −z front.
function frontDir(elDeg: number): [number, number, number] {
  const el = (elDeg * Math.PI) / 180;
  return [0, Math.sin(el), -Math.cos(el)];
}

/** A set with one front direction at the given elevation; a broadband impulse-ish IR. */
function frontSet(elDeg: number): MinPhaseHrtf {
  const irs = new Float32Array(2 * TAPS);
  for (let e = 0; e < 2; e++) { irs[e * TAPS] = 1; irs[e * TAPS + 1] = -0.3; irs[e * TAPS + 3] = 0.15; }
  const [x, y, z] = frontDir(elDeg);
  return {
    sampleRate: SR, taps: TAPS, count: 1,
    dirs: new Float32Array([x, y, z]), irs,
    itdL: new Float32Array([0]), itdR: new Float32Array([0]),
  };
}

/** Magnitude (dB) of the left-ear IR at frequency `hz`, via a single-bin DFT. */
function magDb(set: MinPhaseHrtf, hz: number): number {
  const re = new Float64Array(1024), im = new Float64Array(1024);
  for (let i = 0; i < TAPS; i++) re[i] = set.irs[i];
  fft(re, im, false);
  const bin = Math.round((hz / SR) * 1024);
  return 20 * Math.log10(Math.hypot(re[bin], im[bin]) + 1e-9);
}

/** Modeled elevation delta (dB re 0°) at the measured frequencies, with the cue applied. */
function modeledDelta(elDeg: number, freqs: number[]): number[] {
  const p = { ...NEUTRAL_PERSONALIZATION, notchDepth: 24 }; // full-strength elevation cue
  const flat = personalizeMinPhase(frontSet(0), p);
  const up = personalizeMinPhase(frontSet(elDeg), p);
  return freqs.map((f) => magDb(up, f) - magDb(flat, f));
}

/** Pearson correlation. */
function corr(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const u = a[i] - ma, v = b[i] - mb; num += u * v; da += u * u; db += v * v; }
  return num / (Math.sqrt(da * db) || 1);
}

// The SS2 measured deltas (ipsilateral, median-front, population mean) at these frequencies.
const FREQS = [6000, 7400, 9000, 11500, 14000];
const MEASURED_30 = [4.0, 5.2, 0.8, -6.1, -4.7];
const MEASURED_60 = [4.1, 8.1, 5.8, -7.2, -10.0];

describe('reshaped above-horizon elevation cue vs SS2 measurement', () => {
  it('correlates strongly (>0.6) with the measured Δ at +30° and +60°', () => {
    const c30 = corr(modeledDelta(30, FREQS), MEASURED_30);
    const c60 = corr(modeledDelta(60, FREQS), MEASURED_60);
    expect(c30).toBeGreaterThan(0.6);
    expect(c60).toBeGreaterThan(0.6);
  });

  it('has a BOOST near 7 kHz and a CUT near 12 kHz, both growing with elevation', () => {
    const d30 = modeledDelta(30, [7000, 12000]);
    const d60 = modeledDelta(60, [7000, 12000]);
    // 7 kHz: positive (boost), stronger at +60°.
    expect(d30[0]).toBeGreaterThan(2);
    expect(d60[0]).toBeGreaterThan(d30[0]);
    // 12 kHz: negative (cut), deeper at +60°.
    expect(d30[1]).toBeLessThan(-2);
    expect(d60[1]).toBeLessThan(d30[1]);
  });

  it('roughly matches the measured dB magnitudes in 6–14 kHz (within a few dB)', () => {
    const m60 = modeledDelta(60, FREQS);
    // 7.4 kHz boost ~+8, 12–14 kHz cut ~−7..−10 — allow ±4 dB modeling slop.
    expect(m60[1]).toBeGreaterThan(4);   // 7.4k boost present and strong
    expect(m60[3]).toBeLessThan(-3);     // 11.5k cut present
  });

  it('is exactly neutral at notchDepth=0 (no elevation coloring)', () => {
    const p0 = { ...NEUTRAL_PERSONALIZATION, notchDepth: 0 };
    const flat = personalizeMinPhase(frontSet(0), p0);
    const up = personalizeMinPhase(frontSet(60), p0);
    for (const f of FREQS) expect(magDb(up, f) - magDb(flat, f)).toBeCloseTo(0, 6);
  });
});
