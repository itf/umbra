/**
 * Pure propagation-delay / Doppler physics. The vitest env has no AudioContext, so
 * we test the deterministic math the renderer feeds into its DelayNode. The live
 * Doppler (DelayNode resampling) is ear-verified on the debug page; here we prove
 * the physics the modulation rests on is correct.
 */
import { describe, it, expect } from 'vitest';
import {
  propagationDelaySec,
  clampDelaySec,
  dopplerRatio,
  delayResampleRatio,
  DEFAULT_MAX_DELAY_SEC,
} from '../src/engine/hrtf/propagation';
import { DEFAULT_SPEED_OF_SOUND } from '../src/engine/acoustics/core';

describe('propagationDelaySec', () => {
  it('delay equals dist / c', () => {
    expect(propagationDelaySec(343, 343)).toBeCloseTo(1, 9);
    expect(propagationDelaySec(100, 343)).toBeCloseTo(100 / 343, 9);
    expect(propagationDelaySec(0, 343)).toBe(0);
  });

  it('defaults to 343 m/s', () => {
    expect(propagationDelaySec(343)).toBeCloseTo(343 / DEFAULT_SPEED_OF_SOUND, 9);
  });

  it('a slower speed of sound makes sound arrive later (and faster, sooner)', () => {
    const d = 50;
    expect(propagationDelaySec(d, 170)).toBeGreaterThan(propagationDelaySec(d, 343));
    expect(propagationDelaySec(d, 686)).toBeLessThan(propagationDelaySec(d, 343));
    // Halving c doubles the delay.
    expect(propagationDelaySec(d, 171.5)).toBeCloseTo(2 * propagationDelaySec(d, 343), 9);
  });

  it('non-positive speed and negative distance are handled', () => {
    expect(propagationDelaySec(10, 0)).toBe(0);
    expect(propagationDelaySec(-10, 343)).toBe(0);
  });
});

describe('clampDelaySec', () => {
  it('caps at the allocated max (DelayNode size)', () => {
    expect(clampDelaySec(5, DEFAULT_MAX_DELAY_SEC)).toBe(DEFAULT_MAX_DELAY_SEC);
    expect(clampDelaySec(0.3, DEFAULT_MAX_DELAY_SEC)).toBe(0.3);
    expect(clampDelaySec(-1, DEFAULT_MAX_DELAY_SEC)).toBe(0);
  });

  it('default cap is 2 s ≈ 686 m at 343 m/s', () => {
    expect(DEFAULT_MAX_DELAY_SEC).toBe(2);
    expect(DEFAULT_MAX_DELAY_SEC * 343).toBeCloseTo(686, 0);
  });
});

describe('Doppler from delay-line modulation', () => {
  it('approaching source raises pitch, receding lowers it', () => {
    expect(dopplerRatio(20, 343)).toBeGreaterThan(1); // approaching
    expect(dopplerRatio(-20, 343)).toBeLessThan(1); // receding
    expect(dopplerRatio(0, 343)).toBe(1); // at rest: no shift
  });

  it('the delay-line resampling ratio equals the textbook Doppler ratio', () => {
    // A source approaching at v_radial shrinks the delay at rate dDelay/dt = -v/c.
    // The DelayNode resampling ratio for that rate must match c/(c-v).
    const c = 343;
    for (const v of [-50, -10, 0, 10, 50, 100]) {
      const dDelayDt = -v / c;
      expect(delayResampleRatio(dDelayDt)).toBeCloseTo(dopplerRatio(v, c), 9);
    }
  });

  it('a faster medium weakens the Doppler shift for the same speed', () => {
    const v = 30;
    const shiftSlow = dopplerRatio(v, 200) - 1;
    const shiftFast = dopplerRatio(v, 686) - 1;
    expect(shiftSlow).toBeGreaterThan(shiftFast);
  });

  it('source at the speed of sound is a singularity (shock)', () => {
    expect(dopplerRatio(343, 343)).toBe(Infinity);
  });
});
