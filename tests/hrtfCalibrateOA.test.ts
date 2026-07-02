/**
 * Pure tests for the OA screening core: the L18 array must be genuinely orthogonal,
 * main-effect estimation must recover a known additive truth, and the basin guard must
 * gate on the best observed error.
 */
import { describe, it, expect } from 'vitest';
import {
  L18,
  oaRunValues,
  estimateMainEffects,
  predictedBest,
  basinIsGood,
  type OaFactor,
} from '../src/ui/hrtfCalibrateOA';

const COLS = [1, 2, 3, 4, 5, 6, 7];

describe('L18 orthogonality', () => {
  it('has 18 rows of 8 columns', () => {
    expect(L18.length).toBe(18);
    for (const r of L18) expect(r.length).toBe(8);
  });

  it('each 3-level column uses levels 0,1,2 six times each (balanced)', () => {
    for (const c of COLS) {
      const counts = [0, 0, 0];
      for (const r of L18) counts[r[c]]++;
      expect(counts).toEqual([6, 6, 6]);
    }
  });

  it('every PAIR of 3-level columns is orthogonal (all 9 combos appear equally)', () => {
    for (let i = 0; i < COLS.length; i++) {
      for (let j = i + 1; j < COLS.length; j++) {
        const combo = new Map<string, number>();
        for (const r of L18) {
          const k = `${r[COLS[i]]}${r[COLS[j]]}`;
          combo.set(k, (combo.get(k) ?? 0) + 1);
        }
        // L18's 3-level columns are orthogonal: each of the 9 pairs appears exactly twice.
        expect(combo.size).toBe(9);
        for (const v of combo.values()) expect(v).toBe(2);
      }
    }
  });
});

describe('oaRunValues', () => {
  const factors: OaFactor[] = [
    { key: 'a', levels: [10, 20, 30] },
    { key: 'b', levels: [-1, 0, 1] },
  ];
  it('maps a run to the assigned levels', () => {
    // run 0 is all-zeros → both factors at level 0
    expect(oaRunValues(factors, 0)).toEqual({ a: 10, b: -1 });
  });
  it('throws when too many factors for L18', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ key: 'f' + i, levels: [0, 1, 2] as [number, number, number] }));
    expect(() => oaRunValues(many, 0)).toThrow();
  });
});

describe('estimateMainEffects recovers an additive truth', () => {
  // Build a synthetic response that is minimized when factor a=level2, b=level0.
  const factors: OaFactor[] = [
    { key: 'a', levels: [0, 1, 2] },
    { key: 'b', levels: [0, 1, 2] },
    { key: 'c', levels: [0, 1, 2] },
  ];
  // truth: error = |a-2| + |b-0| + 0*c  (c irrelevant)
  const responses = L18.map((_, r) => {
    const v = oaRunValues(factors, r);
    return Math.abs(v.a - 2) + Math.abs(v.b - 0);
  });

  it('picks the best level per factor', () => {
    const eff = estimateMainEffects(factors, responses);
    expect(eff[0].bestLevel).toBe(2); // a → level 2
    expect(eff[1].bestLevel).toBe(0); // b → level 0
  });

  it('predictedBest assembles the optimum', () => {
    const best = predictedBest(factors, responses);
    expect(best.a).toBe(2);
    expect(best.b).toBe(0);
  });

  it('irrelevant factor c has ~equal level means', () => {
    const eff = estimateMainEffects(factors, responses);
    const [m0, m1, m2] = eff[2].levelMeans;
    expect(Math.abs(m0 - m1)).toBeLessThan(1e-9);
    expect(Math.abs(m1 - m2)).toBeLessThan(1e-9);
  });
});

describe('basinIsGood', () => {
  it('true when the best error is within threshold', () => {
    expect(basinIsGood([1.2, 0.3, 0.9], (35 * Math.PI) / 180)).toBe(true);
  });
  it('false when even the best error is large (wrong basin)', () => {
    expect(basinIsGood([1.4, 1.2, 1.5], (35 * Math.PI) / 180)).toBe(false);
  });
  it('false on no finite responses', () => {
    expect(basinIsGood([NaN, Infinity])).toBe(false);
  });
});
