/**
 * Pure tests for the over-ear headphone-comp NOTCH PROTECTION: the comp must never ADD gain
 * in the ~6–10 kHz pinna-notch band (that would fill the HRTF notches carrying front/back +
 * elevation). Attenuation there is allowed; correction elsewhere is untouched.
 */
import { describe, it, expect } from 'vitest';
import { protectNotchBand, NOTCH_PROTECT_BAND_HZ, type CompBiquad } from '../src/ui/loudnessEqAudio';

const b = (freq: number, gainDb: number, type: CompBiquad['type'] = 'peaking'): CompBiquad => ({ type, freq, Q: 1.4, gainDb });

describe('protectNotchBand (pinna-notch protection, 6–10 kHz)', () => {
  it('caps a POSITIVE peaking gain inside the band to 0 dB (no notch fill)', () => {
    expect(protectNotchBand(b(9000, 2.0)).gainDb).toBe(0);
    expect(protectNotchBand(b(7000, 0.5)).gainDb).toBe(0);
    expect(protectNotchBand(b(NOTCH_PROTECT_BAND_HZ.lo, 3)).gainDb).toBe(0);
    expect(protectNotchBand(b(NOTCH_PROTECT_BAND_HZ.hi, 3)).gainDb).toBe(0);
  });

  it('LEAVES attenuation in the band (deepening the notch is safe)', () => {
    expect(protectNotchBand(b(8000, -4.5)).gainDb).toBe(-4.5);
  });

  it('does NOT touch bands OUTSIDE the protected band', () => {
    expect(protectNotchBand(b(5000, -4.59)).gainDb).toBe(-4.59); // below band
    expect(protectNotchBand(b(12000, 1.8)).gainDb).toBe(1.8);    // above band (kept)
    expect(protectNotchBand(b(3000, -2.05)).gainDb).toBe(-2.05);
  });

  it('the shipped comp curve adds NO gain in 6–10 kHz after protection', () => {
    // Mirror assets/hrtf/overear_comp.json's bands (the ones that touch the region).
    const curve: CompBiquad[] = [
      b(5000, -4.59), b(7000, 0.07), b(9000, 2.01), b(12000, 1.8),
    ];
    for (const band of curve.map(protectNotchBand)) {
      const inBand = band.freq >= NOTCH_PROTECT_BAND_HZ.lo && band.freq <= NOTCH_PROTECT_BAND_HZ.hi;
      if (inBand) expect(band.gainDb).toBeLessThanOrEqual(0); // never boosts the notch band
    }
  });
});
