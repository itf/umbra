/**
 * Pure tests for the bracket-then-binary parameter search driving the perceptual HRTF
 * game. Deterministic: given a fixed "oracle" listener (a target value the simulated
 * user prefers), the search must converge near it and terminate.
 */
import { describe, it, expect } from 'vitest';
import { Staircase } from '../src/ui/hrtfStaircase';

/** Simulate a listener who always prefers the candidate closer to `target`. */
function runToConvergence(target: number, opts: Parameters<typeof makeStaircase>[0]) {
  const sc = makeStaircase(opts);
  let guard = 0;
  while (!sc.done && guard++ < 100) {
    const trial = sc.nextTrial();
    const chose = Math.abs(trial.b - target) < Math.abs(trial.a - target) ? 'b' : 'a';
    sc.answer(chose, trial);
  }
  return { value: sc.current, iterations: guard };
}

function makeStaircase(opts: {
  start: number; step: number; minStep: number; min: number; max: number; reversals?: number;
}) {
  return new Staircase(opts);
}

describe('Staircase (binary search over a bounded range)', () => {
  const base = { start: 1, step: 0.4, minStep: 0.05, min: 0.6, max: 1.6 };

  it('converges near a target above the midpoint', () => {
    const { value } = runToConvergence(1.35, base);
    expect(Math.abs(value - 1.35)).toBeLessThan(0.1);
  });

  it('converges near a target below the midpoint', () => {
    const { value } = runToConvergence(0.75, base);
    expect(Math.abs(value - 0.75)).toBeLessThan(0.1);
  });

  it('converges in a small, predictable number of choices (log2 of the range)', () => {
    const { iterations } = runToConvergence(1.3, base);
    // range 1.0, minStep 0.05 → ~log2(20) ≈ 5 halvings, plus guard slack.
    expect(iterations).toBeLessThan(12);
  });

  it('respects the hard clamp for an out-of-range target', () => {
    const { value } = runToConvergence(99, base); // impossible target → pin near max
    expect(value).toBeLessThanOrEqual(base.max);
    expect(value).toBeGreaterThanOrEqual(base.min);
    expect(value).toBeGreaterThan(1.4); // pushed toward the top
  });

  it('nextTrial presents two DISTINCT probes straddling the current best', () => {
    const sc = makeStaircase(base);
    const t = sc.nextTrial();
    expect(t.a).not.toBe(t.b);
    expect(Math.min(t.a, t.b)).toBeLessThan(sc.current);
    expect(Math.max(t.a, t.b)).toBeGreaterThan(sc.current);
  });

  it('answer() is a no-op once done', () => {
    const sc = makeStaircase({ ...base, minStep: 10 }); // huge minStep → done immediately
    expect(sc.done).toBe(true);
    const before = sc.current;
    sc.answer('b', sc.nextTrial());
    expect(sc.current).toBe(before);
  });
});

describe('Staircase.bothBad', () => {
  const base = { start: 1, step: 0.4, minStep: 0.05, min: 0.6, max: 1.6 };
  it('widens the search and stays in range', () => {
    const sc = new Staircase(base);
    sc.bothBad();
    expect(sc.current).toBeGreaterThanOrEqual(base.min);
    expect(sc.current).toBeLessThanOrEqual(base.max);
  });
  it('terminates after repeated "both bad" (no infinite loop)', () => {
    const sc = new Staircase(base);
    for (let i = 0; i < 5 && !sc.done; i++) sc.bothBad();
    expect(sc.done).toBe(true);
  });
});

describe('Staircase (unbounded → exponential bracket then binary)', () => {
  // No finite range → exponential grow until the preference flips, then binary.
  const opts = { start: 0, step: 1, minStep: 0.1, min: -Infinity, max: Infinity };
  it('brackets and converges on a target reached only by growing the step', () => {
    const { value, iterations } = runToConvergence(6.3, opts);
    expect(Math.abs(value - 6.3)).toBeLessThan(0.5);
    expect(iterations).toBeLessThan(30);
  });
});
