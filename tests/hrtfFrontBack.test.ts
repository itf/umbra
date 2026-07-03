/**
 * Tests the front/back CONTRAST feature construction (scripts/lib/hrtfFrontBack.mjs):
 * the cone-of-confusion mirror must keep the lateral coordinate + elevation fixed and flip
 * ONLY front/back, and the pairing/contrast math must be correct.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs bake helper, no types
import { coneMirrorAzDeg, buildFrontBackPairs, contrastSpectrum, nearestGridIndex } from '../scripts/lib/hrtfFrontBack.mjs';

// Engine unit vector from az/el degrees (0 az = front, +right; +el = up).
function vec(azDeg: number, elDeg: number): [number, number, number] {
  const az = (azDeg * Math.PI) / 180, el = (elDeg * Math.PI) / 180, ce = Math.cos(el);
  return [Math.sin(az) * ce, Math.sin(el), -Math.cos(az) * ce];
}

describe('coneMirrorAzDeg', () => {
  it('maps θ → 180−θ (front/back flip), wrapped to (−180,180]', () => {
    expect(coneMirrorAzDeg(30)).toBeCloseTo(150, 6);   // front-right → back-right
    expect(coneMirrorAzDeg(-30)).toBeCloseTo(-150, 6); // front-left → back-left
    expect(coneMirrorAzDeg(60)).toBeCloseTo(120, 6);
  });

  it('keeps the LATERAL coordinate fixed and flips ONLY front/back', () => {
    for (const az of [20, 45, 60, -35, -70]) {
      const m = coneMirrorAzDeg(az);
      const [x, y, z] = vec(az, 15);
      const [mx, my, mz] = vec(m, 15);
      expect(mx).toBeCloseTo(x, 5);   // lateral (interaural x) preserved
      expect(my).toBeCloseTo(y, 5);   // elevation preserved
      expect(Math.sign(mz)).toBe(-Math.sign(z)); // front/back FLIPPED
    }
  });

  it('is NOT the left/right mirror (θ ↔ −θ)', () => {
    // The L/R mirror would negate x; the cone mirror must NOT.
    const [x] = vec(40, 0);
    const [mx] = vec(coneMirrorAzDeg(40), 0);
    expect(mx).toBeCloseTo(x, 5);      // same side (cone mirror)
    expect(mx).not.toBeCloseTo(-x, 3); // would be the WRONG (L/R) mirror
  });
});

describe('buildFrontBackPairs', () => {
  // A simple grid: horizontal ring every 15° + a couple of elevations.
  const az: number[] = [], el: number[] = [];
  for (const e of [0, 20, -20]) for (let a = -180; a < 180; a += 15) { az.push(a); el.push(e); }

  it('pairs each front dir with a back dir at the SAME lateral + elevation', () => {
    const pairs = buildFrontBackPairs(az, el);
    expect(pairs.length).toBeGreaterThan(0);
    for (const { frontG, backG, elDeg } of pairs) {
      const [fx, fy, fz] = vec(az[frontG], el[frontG]);
      const [bx, by, bz] = vec(az[backG], el[backG]);
      expect(fz).toBeLessThan(0); // front seed
      expect(bz).toBeGreaterThan(0); // back mirror
      expect(bx).toBeCloseTo(fx, 2); // lateral preserved
      expect(by).toBeCloseTo(fy, 2); // elevation preserved
      expect(el[backG]).toBeCloseTo(elDeg, 6);
    }
  });

  it('skips the median plane (no near-0/180 seeds)', () => {
    const pairs = buildFrontBackPairs(az, el);
    for (const { azDeg } of pairs) expect(Math.abs(azDeg)).toBeGreaterThanOrEqual(25);
  });
});

describe('contrastSpectrum', () => {
  it('is the mean per-bin (front − back) over pairs', () => {
    const KEEP = 3;
    // 2 grid dirs: g0 "front" feature [1,1,1], g1 "back" feature [0,0,0].
    const feats = [new Float64Array([1, 1, 1]), new Float64Array([0, 0, 0])];
    const featOf = (g: number) => feats[g];
    const pairs = [{ frontG: 0, backG: 1 }];
    const c = contrastSpectrum(pairs, featOf, KEEP);
    expect(Array.from(c)).toEqual([1, 1, 1]); // front − back
  });

  it('averages across multiple pairs', () => {
    const featOf = (g: number) => [new Float64Array([2, 0]), new Float64Array([0, 0]), new Float64Array([4, 0]), new Float64Array([0, 0])][g];
    const pairs = [{ frontG: 0, backG: 1 }, { frontG: 2, backG: 3 }];
    const c = contrastSpectrum(pairs, featOf, 2);
    expect(c[0]).toBeCloseTo(3, 6); // mean of (2−0) and (4−0)
  });
});

describe('nearestGridIndex', () => {
  it('finds the closest grid direction by wrapped angular distance', () => {
    const az = [0, 90, 180, -90], el = [0, 0, 0, 0];
    expect(nearestGridIndex(az, el, 85, 2).idx).toBe(1);
    expect(nearestGridIndex(az, el, -170, 0).idx).toBe(2); // 180 wraps near −170
  });
});
