/**
 * Pure tests for parametric HRTF personalization. No AudioContext — we build a
 * tiny synthetic MinPhaseHrtf (a few directions, short IRs) and assert the warp's
 * structural effects: ITD scaling is exact, brightness tilt is signed by
 * elevation / front-back, neutral is a no-op copy, and clamping holds the bounds.
 */
import { describe, it, expect } from 'vitest';
import {
  personalizeMinPhase,
  clampPersonalization,
  isNeutral,
  NEUTRAL_PERSONALIZATION,
  PERSONALIZATION_BOUNDS,
} from '../src/engine/hrtf/personalize';
import type { MinPhaseHrtf } from '../src/engine/hrtf/interpolatingDsp';

/** Build a full personalization from a partial (neutral defaults for the rest). */
function mk(partial: Partial<typeof NEUTRAL_PERSONALIZATION>) {
  return { ...NEUTRAL_PERSONALIZATION, ...partial };
}

/** A 3-direction set: [0]=front(-z), [1]=above(+y), [2]=back(+z). taps=4. */
function fakeSet(): MinPhaseHrtf {
  const taps = 4;
  const count = 3;
  const dirs = new Float32Array([
    0, 0, -1, // front
    0, 1, 0, // above
    0, 0, 1, // back
  ]);
  // Each ear IR is an impulse-ish ramp so the tilt has something to bite on.
  const irs = new Float32Array(count * 2 * taps);
  for (let m = 0; m < count; m++) {
    for (let e = 0; e < 2; e++) {
      const base = (m * 2 + e) * taps;
      irs[base] = 1;
      irs[base + 1] = 0.5;
      irs[base + 2] = 0.25;
      irs[base + 3] = 0.1;
    }
  }
  return {
    sampleRate: 48000,
    taps,
    count,
    dirs,
    irs,
    itdL: new Float32Array([2, 3, 4]),
    itdR: new Float32Array([4, 3, 2]),
  };
}

function energy(irs: Float32Array, base: number, taps: number): number {
  let e = 0;
  for (let i = 0; i < taps; i++) e += irs[base + i] * irs[base + i];
  return e;
}

describe('personalizeMinPhase', () => {
  it('neutral personalization leaves values unchanged (but copies)', () => {
    const set = fakeSet();
    const out = personalizeMinPhase(set, NEUTRAL_PERSONALIZATION);
    expect(Array.from(out.itdL)).toEqual(Array.from(set.itdL));
    expect(Array.from(out.itdR)).toEqual(Array.from(set.itdR));
    expect(Array.from(out.irs)).toEqual(Array.from(set.irs));
    // must be a copy — mutating output does not touch input
    out.irs[0] = 999;
    expect(set.irs[0]).toBe(1);
  });

  it('scales ITD exactly by itdScale', () => {
    const set = fakeSet();
    const out = personalizeMinPhase(set, mk({ itdScale: 1.5 }));
    expect(Array.from(out.itdL)).toEqual([3, 4.5, 6]);
    expect(Array.from(out.itdR)).toEqual([6, 4.5, 3]);
  });

  it('elevTilt brightens the above direction and does not touch the horizontal one', () => {
    const set = fakeSet();
    const taps = set.taps;
    const out = personalizeMinPhase(set, mk({ elevTilt: 6 }));
    // above (m=1, y=+1) should gain high-frequency energy vs the original
    const aboveBase = 1 * 2 * taps;
    expect(energy(out.irs, aboveBase, taps)).toBeGreaterThan(energy(set.irs, aboveBase, taps));
    // front (m=0, y=0) has zero elevation → untouched by elevTilt
    const frontBase = 0;
    expect(Array.from(out.irs.subarray(frontBase, frontBase + taps))).toEqual(
      Array.from(set.irs.subarray(frontBase, frontBase + taps)),
    );
  });

  it('frontBackTilt makes front brighter than back for the same positive tilt', () => {
    const set = fakeSet();
    const taps = set.taps;
    const out = personalizeMinPhase(set, mk({ frontBackTilt: 6 }));
    const frontE = energy(out.irs, 0, taps); // m=0, z=-1 → +tilt (bright)
    const backE = energy(out.irs, 2 * 2 * taps, taps); // m=2, z=+1 → −tilt (dark)
    expect(frontE).toBeGreaterThan(backE);
  });
});

describe('pinna notch (elevation cue)', () => {
  it('alters the ABOVE direction but leaves the horizontal one untouched', () => {
    const set = fakeSet();
    const taps = set.taps;
    const out = personalizeMinPhase(set, mk({ notchHz: 7000, notchDepth: 18 }));
    // above (m=1, y=+1) gets the notch → its IR changes.
    const aboveBase = 1 * 2 * taps;
    expect(Array.from(out.irs.subarray(aboveBase, aboveBase + taps)))
      .not.toEqual(Array.from(set.irs.subarray(aboveBase, aboveBase + taps)));
    // front (m=0, y=0, at ear level) gets no notch → unchanged.
    expect(Array.from(out.irs.subarray(0, taps))).toEqual(Array.from(set.irs.subarray(0, taps)));
  });

  it('is disabled when notchDepth is 0 regardless of notchHz', () => {
    const set = fakeSet();
    const out = personalizeMinPhase(set, mk({ notchHz: 9000, notchDepth: 0 }));
    expect(Array.from(out.irs)).toEqual(Array.from(set.irs));
  });
});

describe('clampPersonalization', () => {
  it('holds values within bounds and repairs non-finite', () => {
    const c = clampPersonalization(mk({ itdScale: 99, elevTilt: -99, frontBackTilt: NaN }));
    expect(c.itdScale).toBe(PERSONALIZATION_BOUNDS.itdScale.max);
    expect(c.elevTilt).toBe(PERSONALIZATION_BOUNDS.elevTilt.min);
    expect(c.frontBackTilt).toBe(0);
  });
});

describe('isNeutral', () => {
  it('is true only at defaults', () => {
    expect(isNeutral(NEUTRAL_PERSONALIZATION)).toBe(true);
    expect(isNeutral(mk({ itdScale: 1.1 }))).toBe(false);
  });
});
