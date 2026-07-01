import { describe, it, expect } from 'vitest';
import {
  renderMouthClick, mouthClickLength, CLICK_VOICES, type MouthClickOpts,
} from '../src/game/clickProbe';

const SR = 48000;

/** Goertzel: magnitude of a single DFT bin at `freq` Hz. Cleaner than a full DFT. */
function goertzel(x: Float32Array, sampleRate: number, freq: number): number {
  const k = (freq / sampleRate) * x.length;
  const w = (2 * Math.PI * k) / x.length;
  const cw = Math.cos(w);
  const coeff = 2 * cw;
  let s0 = 0, s1 = 0, s2 = 0;
  for (let i = 0; i < x.length; i++) {
    s0 = x[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const real = s1 - s2 * cw;
  const imag = s2 * Math.sin(w);
  return Math.hypot(real, imag);
}

describe('renderMouthClick — waveform shape', () => {
  it('length matches requested duration and total is short (< 20 ms)', () => {
    const x = renderMouthClick(SR);
    expect(x.length).toBe(Math.round(0.006 * SR));
    expect(x.length).toBe(mouthClickLength(SR));
    expect(x.length / SR).toBeLessThan(0.02);
  });

  it('is impulsive: near-zero start, sharp onset, decays to near-zero by the end', () => {
    const x = renderMouthClick(SR);
    expect(Math.abs(x[0])).toBeLessThan(0.05); // onset at c > 0 → starts at zero
    // A sharp onset: peak occurs early in the buffer.
    let peakIdx = 0, peak = 0;
    for (let i = 0; i < x.length; i++) {
      const a = Math.abs(x[i]);
      if (a > peak) { peak = a; peakIdx = i; }
    }
    expect(peakIdx / SR).toBeLessThan(0.002); // peak within first 2 ms
    // Tail energy near zero: last 10% of samples are tiny vs the peak.
    const tailStart = Math.floor(x.length * 0.9);
    let tailMax = 0;
    for (let i = tailStart; i < x.length; i++) tailMax = Math.max(tailMax, Math.abs(x[i]));
    expect(tailMax).toBeLessThan(0.05);
  });

  it('peak amplitude is normalized to 1.0', () => {
    const x = renderMouthClick(SR);
    let maxAbs = 0;
    for (const v of x) maxAbs = Math.max(maxAbs, Math.abs(v));
    expect(maxAbs).toBeGreaterThanOrEqual(0.9);
    expect(maxAbs).toBeLessThanOrEqual(1.0 + 1e-6);
    expect(maxAbs).toBeCloseTo(1.0, 5);
  });
});

describe('renderMouthClick — spectral content (Goertzel at 500/3000/10000 Hz)', () => {
  const x = renderMouthClick(SR);
  const e500 = goertzel(x, SR, 500);
  const e3000 = goertzel(x, SR, 3000);
  const e10000 = goertzel(x, SR, 10000);

  it('peak energy sits in the 2–4 kHz region, above 500 Hz', () => {
    // eslint-disable-next-line no-console
    console.log(`Goertzel mags: 500Hz=${e500.toFixed(3)} 3kHz=${e3000.toFixed(3)} 10kHz=${e10000.toFixed(3)}`);
    expect(e3000).toBeGreaterThan(e500 * 2); // strong 2–4 kHz peak vs low band
  });

  it('has meaningful energy near 10 kHz relative to 500 Hz (the shoulder)', () => {
    expect(e10000).toBeGreaterThan(e500);
  });
});

describe('renderMouthClick — determinism & seeded variation', () => {
  it('same inputs → identical array', () => {
    const a = renderMouthClick(SR, { seed: 42, jitter: 0.05 });
    const b = renderMouthClick(SR, { seed: 42, jitter: 0.05 });
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('jitter=0 is the canonical deterministic click regardless of seed', () => {
    const a = renderMouthClick(SR, { seed: 1 });
    const b = renderMouthClick(SR, { seed: 999 });
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('different seeds → different but similar waveforms (same spectral band)', () => {
    const opts: MouthClickOpts = { jitter: 0.05 };
    const a = renderMouthClick(SR, { ...opts, seed: 1 });
    const b = renderMouthClick(SR, { ...opts, seed: 2 });
    // Different sample-wise.
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i]);
    expect(diff).toBeGreaterThan(0);
    // But the spectral peak stays in the 2–4 kHz band for both.
    for (const w of [a, b]) {
      expect(goertzel(w, SR, 3000)).toBeGreaterThan(goertzel(w, SR, 500) * 2);
    }
  });
});

describe('CLICK_VOICES', () => {
  it('exposes the three published EE fits with the ~10 kHz shoulder mode', () => {
    expect(Object.keys(CLICK_VOICES)).toEqual(['EE1', 'EE2', 'EE3']);
    for (const v of Object.values(CLICK_VOICES)) {
      expect(v.freqs.some((f) => f >= 9000 && f <= 12000)).toBe(true); // 10 kHz shoulder
      expect(v.freqs.some((f) => f >= 2000 && f <= 4000)).toBe(true);  // 2–4 kHz peak
      expect(v.b).toBeGreaterThan(0);
    }
  });
});
