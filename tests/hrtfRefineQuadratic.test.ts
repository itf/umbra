/**
 * Pure tests for the local quadratic refiner: sample planning stays in-neighborhood +
 * in-bounds, and the vertex fit finds a convex minimum / safely falls back otherwise.
 */
import { describe, it, expect } from 'vitest';
import { planSamples, fitVertex } from '../src/ui/hrtfRefineQuadratic';

describe('planSamples', () => {
  it('returns [center-δ, center, center+δ] inside a wide range', () => {
    const [lo, mid, hi] = planSamples(1, { min: 0.5, max: 2.0 }, 0.25);
    expect(mid).toBe(1);
    expect(lo).toBeCloseTo(1 - 1.5 * 0.25, 6);
    expect(hi).toBeCloseTo(1 + 1.5 * 0.25, 6);
  });
  it('clamps to bounds at a rail', () => {
    const [lo, , hi] = planSamples(2.0, { min: 0.5, max: 2.0 }, 0.25);
    expect(lo).toBeGreaterThanOrEqual(0.5);
    expect(hi).toBeLessThanOrEqual(2.0);
    expect(hi).toBe(2.0);
  });
});

describe('fitVertex', () => {
  it('finds the minimum of a convex parabola', () => {
    // e(x) = (x-1.3)^2 sampled at 1.0, 1.25, 1.5
    const xs: [number, number, number] = [1.0, 1.25, 1.5];
    const errs = xs.map((x) => (x - 1.3) ** 2) as [number, number, number];
    expect(fitVertex(xs, errs)).toBeCloseTo(1.3, 4);
  });
  it('falls back to the argmin sample when not convex (a ≤ 0)', () => {
    // concave-up-down: middle is the LOWEST so argmin is mid, but shape is a peak → distrust vertex
    const xs: [number, number, number] = [0, 1, 2];
    const errs: [number, number, number] = [1, 2, 0.5]; // not a clean bowl
    const v = fitVertex(xs, errs);
    expect([0, 1, 2]).toContain(v); // returns one of the samples, not an extrapolation
  });
  it('distrusts a vertex that lies outside the sampled span', () => {
    const xs: [number, number, number] = [1.0, 1.25, 1.5];
    // monotically decreasing → vertex would extrapolate right of 1.5
    const errs: [number, number, number] = [3, 2, 1];
    const v = fitVertex(xs, errs);
    expect(v).toBe(1.5); // argmin sample
  });
  it('handles coincident x (rail) by returning argmin', () => {
    const xs: [number, number, number] = [2.0, 2.0, 2.0];
    const errs: [number, number, number] = [0.5, 0.4, 0.6];
    expect(fitVertex(xs, errs)).toBe(2.0);
  });
});
