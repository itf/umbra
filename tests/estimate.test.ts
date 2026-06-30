/**
 * Tests for the 'estimate' exercise: scoring helper, distance grid, and builder.
 */
import { describe, it, expect } from 'vitest';
import {
  scoreEstimate,
  estimateTolerance,
  estimateDistances,
  makeQuestion,
  ESTIMATE_MIN_M,
  ESTIMATE_MAX_M,
} from '../src/trainer/exercises';

describe('estimateTolerance', () => {
  it('is 25% at easiest difficulty', () => {
    expect(estimateTolerance(0)).toBeCloseTo(0.25);
  });
  it('is 10% at hardest difficulty', () => {
    expect(estimateTolerance(1)).toBeCloseTo(0.10);
  });
  it('interpolates at mid difficulty', () => {
    const tol = estimateTolerance(0.5);
    expect(tol).toBeGreaterThan(0.10);
    expect(tol).toBeLessThan(0.25);
  });
});

describe('estimateDistances', () => {
  it('easy grid uses 0.5 m steps, starts at ESTIMATE_MIN_M', () => {
    const dists = estimateDistances(0);
    expect(dists[0]).toBeCloseTo(ESTIMATE_MIN_M);
    expect(dists[1] - dists[0]).toBeCloseTo(0.5);
    for (const d of dists) {
      expect(d).toBeGreaterThanOrEqual(ESTIMATE_MIN_M - 1e-6);
      expect(d).toBeLessThanOrEqual(ESTIMATE_MAX_M + 1e-6);
    }
  });
  it('hard grid uses 0.25 m steps', () => {
    const dists = estimateDistances(1);
    expect(dists[1] - dists[0]).toBeCloseTo(0.25);
  });
  it('hard grid is finer than easy grid', () => {
    expect(estimateDistances(1).length).toBeGreaterThan(estimateDistances(0).length);
  });
});

describe('scoreEstimate', () => {
  it('scores exact match as correct with 0% error', () => {
    const r = scoreEstimate(2.0, 2.0, 0.5);
    expect(r.correct).toBe(true);
    expect(r.errorPct).toBe(0);
  });

  it('scores within easy tolerance as correct', () => {
    // At difficulty 0, tolerance is 25%. 2.4 m true, guess 2.0 m → 16.7% error < 25%
    const r = scoreEstimate(2.0, 2.4, 0);
    expect(r.correct).toBe(true);
    expect(r.errorPct).toBeCloseTo(16.7, 0);
  });

  it('scores outside easy tolerance as wrong', () => {
    // 2.4 m true, guess 1.0 m → 58.3% error > 25%
    const r = scoreEstimate(1.0, 2.4, 0);
    expect(r.correct).toBe(false);
  });

  it('scores within hard tolerance as correct', () => {
    // At difficulty 1, tolerance is 10%. 2.0 m true, guess 2.18 m → 9% error < 10%
    const r = scoreEstimate(2.18, 2.0, 1);
    expect(r.correct).toBe(true);
  });

  it('scores outside hard tolerance as wrong', () => {
    // At difficulty 1, tolerance is 10%. 2.0 m true, guess 2.25 m → 12.5% error > 10%
    const r = scoreEstimate(2.25, 2.0, 1);
    expect(r.correct).toBe(false);
  });

  it('tolerancePct matches estimateTolerance × 100', () => {
    const r = scoreEstimate(2.0, 2.0, 0.3);
    expect(r.tolerancePct).toBeCloseTo(estimateTolerance(0.3) * 100, 0);
  });

  it('errorPct is symmetric (overshot vs undershot)', () => {
    const over = scoreEstimate(3.0, 2.0, 0.5);
    const under = scoreEstimate(1.0, 2.0, 0.5);
    expect(over.errorPct).toBe(under.errorPct);
  });
});

describe('makeQuestion estimate', () => {
  it('produces a single-scene question with no sceneB', () => {
    const q = makeQuestion('estimate', 42);
    expect(q.type).toBe('estimate');
    expect(q.sceneA).toBeDefined();
    expect(q.sceneB).toBeUndefined();
  });

  it('trueDist is within the valid range', () => {
    for (const seed of [1, 2, 3, 100, 999]) {
      const q = makeQuestion('estimate', seed);
      expect(q.trueDist).toBeGreaterThanOrEqual(ESTIMATE_MIN_M - 1e-6);
      expect(q.trueDist).toBeLessThanOrEqual(ESTIMATE_MAX_M + 1e-6);
    }
  });

  it('correctAnswer matches trueDist formatted string', () => {
    const q = makeQuestion('estimate', 7);
    expect(q.correctAnswer).toBe(`${q.trueDist!.toFixed(2)} m`);
  });

  it('correctAnswer is one of the choices', () => {
    const q = makeQuestion('estimate', 13);
    expect(q.choices).toContain(q.correctAnswer);
  });

  it('choices cover the expected range for easy difficulty', () => {
    const q = makeQuestion('estimate', 5, { difficulty: 0 });
    const parsed = q.choices.map((c) => parseFloat(c));
    expect(Math.min(...parsed)).toBeCloseTo(ESTIMATE_MIN_M, 1);
    // Last easy step: 0.75 + n*0.5 ≤ 6.0 → max is 5.75.
    expect(Math.max(...parsed)).toBeGreaterThanOrEqual(ESTIMATE_MAX_M - 0.5);
    expect(Math.max(...parsed)).toBeLessThanOrEqual(ESTIMATE_MAX_M);
  });

  it('id is deterministic from type + seed', () => {
    const a = makeQuestion('estimate', 42);
    const b = makeQuestion('estimate', 42);
    expect(a.id).toBe(b.id);
    expect(a.trueDist).toBe(b.trueDist);
  });

  it('sceneA has a concrete panel extraWall ahead', () => {
    const q = makeQuestion('estimate', 8);
    expect(q.sceneA.extraWalls).toBeDefined();
    expect(q.sceneA.extraWalls!.length).toBeGreaterThan(0);
  });
});
