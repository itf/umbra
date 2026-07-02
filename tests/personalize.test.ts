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
  frontBackHemisphere,
  biasedElevation,
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

  it('frontBackTilt applies a SPECTRAL front/back cue: boosts ~1 kHz for BACK, cuts it for FRONT', () => {
    // Front/back is now a direction-specific spectral cue (Blauert 1 kHz band etc.), not a
    // brightness tilt. Use a long impulse so 1 kHz is resolvable, one front + one back dir.
    const taps = 256, count = 2;
    const dirs = new Float32Array([0, 0, -1, /*front*/ 0, 0, 1 /*back*/]);
    const irs = new Float32Array(count * 2 * taps);
    irs[0] = 1; irs[taps] = 1;               // front L/R = unit impulse
    irs[2 * taps] = 1; irs[3 * taps] = 1;    // back  L/R = unit impulse
    const set: MinPhaseHrtf = {
      sampleRate: 48000, taps, count, dirs, irs,
      itdL: new Float32Array(count), itdR: new Float32Array(count),
    };
    const out = personalizeMinPhase(set, mk({ frontBackTilt: 18 }));
    const magAt = (base: number, f: number) => {
      let re = 0, im = 0; const w = (2 * Math.PI * f) / 48000;
      for (let n = 0; n < taps; n++) { re += out.irs[base + n] * Math.cos(w * n); im -= out.irs[base + n] * Math.sin(w * n); }
      return Math.hypot(re, im);
    };
    const front1k = magAt(0, 1000);          // front dir, left ear
    const back1k = magAt(2 * taps, 1000);    // back dir, left ear
    // Back must have MORE 1 kHz energy than front after the cue (the robust rear cue).
    expect(back1k).toBeGreaterThan(front1k);
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

describe('front/back + up/down perceptual bias', () => {
  it('frontBackHemisphere at bias=0 is exactly the historical tanh(-z·3)', () => {
    for (const z of [-1, -0.5, 0, 0.5, 1]) {
      expect(frontBackHemisphere(-z, 0)).toBeCloseTo(Math.tanh(-z * 3), 12);
    }
  });

  it('+frontBackBias increases front-coloring at a FIXED direction (incl. dead-ahead z=0)', () => {
    // dead-ahead: negZ = 0. Positive bias must push the hemisphere term toward front (+).
    expect(frontBackHemisphere(0, 0)).toBeCloseTo(0, 12);
    expect(frontBackHemisphere(0, +0.5)).toBeGreaterThan(0);
    expect(frontBackHemisphere(0, +1)).toBeGreaterThan(frontBackHemisphere(0, +0.5));
    // negative bias pushes toward back (−)
    expect(frontBackHemisphere(0, -0.5)).toBeLessThan(0);
  });

  it('front vs back stay SEPARABLE (opposite sign) even at full bias', () => {
    for (const bias of [-1, -0.5, 0.5, 1]) {
      const front = frontBackHemisphere(+1, bias); // negZ=+1 (true front)
      const back = frontBackHemisphere(-1, bias);  // negZ=−1 (true back)
      expect(front).toBeGreaterThan(back);          // ordering preserved
      expect(Math.sign(front)).toBe(1);             // true front still front-signed
      expect(Math.sign(back)).toBe(-1);             // true back still back-signed
    }
  });

  it('biasedElevation at bias=0 is identity; +bias nudges up, −bias down', () => {
    expect(biasedElevation(0.3, 0)).toBeCloseTo(0.3, 12);
    expect(biasedElevation(0, +1)).toBeGreaterThan(0);
    expect(biasedElevation(0, -1)).toBeLessThan(0);
  });

  it('isNeutral is false when a bias is nonzero', () => {
    expect(isNeutral(NEUTRAL_PERSONALIZATION)).toBe(true);
    expect(isNeutral({ ...NEUTRAL_PERSONALIZATION, frontBackBias: 0.3 })).toBe(false);
    expect(isNeutral({ ...NEUTRAL_PERSONALIZATION, upDownBias: -0.2 })).toBe(false);
  });

  it('clamp holds bias in [−1,1] and defaults missing to 0', () => {
    const c = clampPersonalization({ ...NEUTRAL_PERSONALIZATION, frontBackBias: 5, upDownBias: -9 });
    expect(c.frontBackBias).toBe(PERSONALIZATION_BOUNDS.frontBackBias.max);
    expect(c.upDownBias).toBe(PERSONALIZATION_BOUNDS.upDownBias.min);
  });

  it('warp: bias=0 reproduces the un-biased warp exactly; +frontBackBias changes a source', () => {
    const set = fakeSet();
    const noBias = personalizeMinPhase(set, mk({ frontBackTilt: 12, frontBackBias: 0 }));
    const noBias2 = personalizeMinPhase(set, mk({ frontBackTilt: 12 })); // bias defaults 0
    for (let i = 0; i < noBias.irs.length; i++) expect(noBias.irs[i]).toBeCloseTo(noBias2.irs[i], 10);
    // With a strong +front bias, the DEAD-AHEAD source (dir 0, z=−1 → already front) plus the
    // ABOVE source (dir 1, z=0 median) gets a different front/back coloring than un-biased.
    const biased = personalizeMinPhase(set, mk({ frontBackTilt: 12, frontBackBias: 1 }));
    let changed = false;
    for (let i = 0; i < biased.irs.length; i++) if (Math.abs(biased.irs[i] - noBias.irs[i]) > 1e-4) changed = true;
    expect(changed).toBe(true);
  });
});
