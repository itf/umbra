/**
 * Pure tests for HRIR reconstruction (min-phase + ITD → full HRIR) used by SOFA export.
 */
import { describe, it, expect } from 'vitest';
import { reconstructHrtf, vecToAzEl } from '../src/engine/hrtf/sofaExport';
import type { MinPhaseHrtf } from '../src/engine/hrtf/interpolatingDsp';

/** A tiny 2-direction min-phase set: a unit impulse per ear, distinct ITDs. */
function toyMp(): MinPhaseHrtf {
  const taps = 4;
  const count = 2;
  const irs = new Float32Array(count * 2 * taps);
  // dir 0: L impulse at tap 0, R impulse at tap 0
  irs[0] = 1; irs[taps] = 1;
  // dir 1: same impulses
  irs[2 * taps] = 1; irs[3 * taps] = 1;
  const dirs = new Float32Array([0, 0, -1, /*front*/ 1, 0, 0 /*right*/]);
  const itdL = new Float32Array([0, 3]); // dir1 delays left ear by 3 samples
  const itdR = new Float32Array([0, 0]);
  return { sampleRate: 48000, taps, count, dirs, irs, itdL, itdR };
}

describe('reconstructHrtf', () => {
  it('places the impulse at the ITD offset', () => {
    const r = reconstructHrtf(toyMp());
    // dir1 left ear: impulse should land at tap 3 (its ITD), right ear at tap 0.
    const outStride = 2 * r.taps;
    const dir1L = r.irs.subarray(outStride, outStride + r.taps);
    const dir1R = r.irs.subarray(outStride + r.taps, outStride + 2 * r.taps);
    expect(dir1L[3]).toBeCloseTo(1, 5);
    expect(dir1L[0]).toBeCloseTo(0, 5);
    expect(dir1R[0]).toBeCloseTo(1, 5);
  });

  it('sizes taps with headroom for the largest ITD', () => {
    const r = reconstructHrtf(toyMp());
    expect(r.taps).toBeGreaterThanOrEqual(4 + 3);
  });

  it('carries sample rate + count through', () => {
    const r = reconstructHrtf(toyMp());
    expect(r.sampleRate).toBe(48000);
    expect(r.count).toBe(2);
    expect(r.positions.length).toBe(6);
  });
});

describe('vecToAzEl', () => {
  it('maps front (−z) to azimuth 0, elevation 0', () => {
    const [az, el] = vecToAzEl(0, 0, -1);
    expect(az).toBeCloseTo(0, 4);
    expect(el).toBeCloseTo(0, 4);
  });
  it('maps left (−x) to azimuth 90', () => {
    const [az] = vecToAzEl(-1, 0, 0);
    expect(az).toBeCloseTo(90, 4);
  });
  it('maps straight up to elevation 90', () => {
    const [, el] = vecToAzEl(0, 1, 0);
    expect(el).toBeCloseTo(90, 4);
  });
});
