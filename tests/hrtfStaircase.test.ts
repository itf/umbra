/**
 * Pure tests for the coarse→fine staircase driving the perceptual HRTF game.
 * Deterministic: given a fixed "oracle" listener (a target value the simulated
 * user prefers), the staircase must converge near it and terminate.
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

describe('Staircase', () => {
  const base = { start: 1, step: 0.4, minStep: 0.05, min: 0.6, max: 1.6 };

  it('converges toward a target above the start', () => {
    const { value } = runToConvergence(1.35, base);
    expect(value).toBeGreaterThan(1.15);
    expect(value).toBeLessThanOrEqual(1.6);
  });

  it('converges toward a target below the start', () => {
    const { value } = runToConvergence(0.75, base);
    expect(value).toBeLessThan(0.95);
    expect(value).toBeGreaterThanOrEqual(0.6);
  });

  it('terminates in a small number of choices (fast before brain adapts)', () => {
    const { iterations } = runToConvergence(1.3, base);
    expect(iterations).toBeLessThan(20);
  });

  it('respects the hard clamp', () => {
    const { value } = runToConvergence(99, base); // impossible target → pin to max
    expect(value).toBeLessThanOrEqual(base.max);
    expect(value).toBeGreaterThanOrEqual(base.min);
  });

  it('nextTrial always brackets the current best', () => {
    const sc = makeStaircase(base);
    const t = sc.nextTrial();
    expect(t.a).toBe(sc.current);
    expect(t.b).not.toBe(t.a);
  });

  it('answer() is a no-op once done', () => {
    const sc = makeStaircase({ ...base, reversals: 1 });
    // force a reversal to finish quickly
    let t = sc.nextTrial();
    sc.answer('b', t); // move up
    t = sc.nextTrial();
    sc.answer('a', t); // stick → reversal → done
    const before = sc.current;
    sc.answer('b', { a: before, b: before + 1 });
    expect(sc.current).toBe(before);
  });
});

describe('Staircase.bothBad', () => {
  const base = { start: 1, step: 0.4, minStep: 0.05, min: 0.6, max: 1.6 };
  it('moves the value and never gets stuck', () => {
    const sc = new Staircase(base);
    const before = sc.current;
    sc.bothBad();
    // it should explore — value changes (unless already at a rail, then still valid)
    expect(sc.current).toBeGreaterThanOrEqual(base.min);
    expect(sc.current).toBeLessThanOrEqual(base.max);
    expect(sc.current).not.toBe(before);
  });
  it('terminates after repeated "both bad" (no infinite loop)', () => {
    const sc = new Staircase(base);
    for (let i = 0; i < 5 && !sc.done; i++) sc.bothBad();
    expect(sc.done).toBe(true);
  });
});
