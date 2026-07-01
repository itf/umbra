/**
 * Pure tests for the objective localization calibration core: angular error, seeded
 * test directions, winner decision, and the visualizer click→direction inverse.
 */
import { describe, it, expect } from 'vitest';
import {
  angularError,
  makeTestDirections,
  decideWinner,
  screenToDirection,
  dirToVec,
  type Attempt,
  type Direction,
} from '../src/ui/hrtfLocalize';

describe('angularError', () => {
  it('is zero for identical directions', () => {
    const d: Direction = { az: 0.5, el: 0.2 };
    expect(angularError(d, d)).toBeCloseTo(0, 6);
  });
  it('is π for antipodal directions', () => {
    expect(angularError({ az: 0, el: 0 }, { az: Math.PI, el: 0 })).toBeCloseTo(Math.PI, 4);
  });
  it('is π/2 for front vs directly overhead', () => {
    expect(angularError({ az: 0, el: 0 }, { az: 0, el: Math.PI / 2 })).toBeCloseTo(Math.PI / 2, 4);
  });
});

describe('makeTestDirections', () => {
  it('is deterministic for a fixed seed', () => {
    expect(makeTestDirections(5, 42)).toEqual(makeTestDirections(5, 42));
  });
  it('keeps elevation within ±60°', () => {
    for (const d of makeTestDirections(50, 7)) {
      expect(Math.abs(d.el)).toBeLessThanOrEqual((60 * Math.PI) / 180 + 1e-9);
    }
  });
});

describe('decideWinner', () => {
  it('is undecided until both candidates have enough attempts', () => {
    const a: Attempt[] = [{ which: 'a', error: 0.1 }, { which: 'b', error: 0.1 }];
    expect(decideWinner(a, 2)).toBeNull();
  });
  it('picks the candidate with the smaller mean error', () => {
    const at: Attempt[] = [
      { which: 'a', error: 0.9 }, { which: 'a', error: 0.8 },
      { which: 'b', error: 0.2 }, { which: 'b', error: 0.1 },
    ];
    expect(decideWinner(at, 2)).toBe('b');
  });
  it('keeps A on a tie (incumbent bias)', () => {
    const at: Attempt[] = [
      { which: 'a', error: 0.30 }, { which: 'a', error: 0.30 },
      { which: 'b', error: 0.31 }, { which: 'b', error: 0.30 },
    ];
    expect(decideWinner(at, 2, 0.05)).toBe('a');
  });
});

describe('screenToDirection', () => {
  const cfg = { w: 260, h: 200, scale: 70 };
  const cx = cfg.w / 2, cy = cfg.h / 2;

  it('maps a click at the front of the ring to front, near ear level', () => {
    // In the oblique projection the front-ground point sits at the BOTTOM of the ring
    // (cy + scale*0.45), so that's where "front, ear level" is clicked — not centre.
    const frontGroundY = cy + cfg.scale * 0.45;
    const d = screenToDirection(cx, frontGroundY, cfg);
    const v = dirToVec(d);
    expect(v[2]).toBeLessThan(0); // −z = front
    expect(Math.abs(d.el)).toBeLessThan(0.2);
  });

  it('maps a click to the RIGHT to a positive-x (right) direction', () => {
    const d = screenToDirection(cx + 50, cy + 20, cfg);
    expect(dirToVec(d)[0]).toBeGreaterThan(0);
  });

  it('maps a click well ABOVE the centre to a raised elevation', () => {
    const low = screenToDirection(cx, cy + 30, cfg);
    const high = screenToDirection(cx, cy - 40, cfg);
    expect(high.el).toBeGreaterThan(low.el);
  });
});
