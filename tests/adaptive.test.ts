/**
 * The adaptive staircase is the heart of threshold tracking: a buggy rule would
 * either never converge or sit the learner at the wrong percent-correct. These
 * tests assert the rule precisely (when it steps up/down), step halving at
 * reversals, [0,1] clamping, reversal counting, determinism, and that a simulated
 * observer drives the threshold estimate to the simulated threshold.
 */
import { describe, it, expect } from 'vitest';
import { Staircase, difficultyBand } from '../src/trainer/adaptive';

describe('Staircase rule (2-down / 1-up)', () => {
  it('only steps HARDER after N=2 consecutive correct', () => {
    const s = new Staircase({ start: 0.5, startStep: 0.2 });
    expect(s.record(true)).toBeCloseTo(0.5); // 1 correct: no move yet
    expect(s.record(true)).toBeCloseTo(0.7); // 2nd correct: harder
    expect(s.record(true)).toBeCloseTo(0.7); // counter reset: 1 correct again
    expect(s.record(true)).toBeCloseTo(0.9); // 2nd: harder again
  });

  it('steps EASIER after M=1 incorrect', () => {
    const s = new Staircase({ start: 0.5, startStep: 0.2 });
    expect(s.record(false)).toBeCloseTo(0.3);
    expect(s.record(false)).toBeCloseTo(0.1);
  });

  it('a single miss does not reset to easy (unlike the streak ramp)', () => {
    const s = new Staircase({ start: 0.8, startStep: 0.2 });
    s.record(false); // 0.6
    expect(s.current()).toBeCloseTo(0.6);
    expect(s.current()).toBeGreaterThan(0); // not slammed to floor
  });
});

describe('Reversals and step halving', () => {
  it('counts reversals and halves the step at each one', () => {
    const s = new Staircase({ start: 0.5, startStep: 0.2, minStep: 0.01 });
    s.record(true); s.record(true); // up to 0.7, step still 0.2, no reversal yet
    expect(s.reversals).toBe(0);
    expect(s.stepSize).toBeCloseTo(0.2);
    s.record(false); // first move down → reversal; step halves to 0.1
    expect(s.reversals).toBe(1);
    expect(s.stepSize).toBeCloseTo(0.1);
    expect(s.current()).toBeCloseTo(0.6); // 0.7 - 0.1
    s.record(true); s.record(true); // up → reversal; step halves to 0.05
    expect(s.reversals).toBe(2);
    expect(s.stepSize).toBeCloseTo(0.05);
  });

  it('step never shrinks below the floor', () => {
    const s = new Staircase({ start: 0.5, startStep: 0.2, minStep: 0.05 });
    // Alternate to force many reversals.
    for (let i = 0; i < 30; i++) { s.record(true); s.record(true); s.record(false); }
    expect(s.stepSize).toBeGreaterThanOrEqual(0.05 - 1e-9);
    expect(s.stepSize).toBeCloseTo(0.05);
  });
});

describe('Clamping to [0,1]', () => {
  it('never exceeds 1 when driven up', () => {
    const s = new Staircase({ start: 0.9, startStep: 0.2, minStep: 0.2 });
    for (let i = 0; i < 20; i++) { s.record(true); s.record(true); }
    expect(s.current()).toBeLessThanOrEqual(1);
    expect(s.current()).toBeGreaterThanOrEqual(0);
  });
  it('never drops below 0 when driven down', () => {
    const s = new Staircase({ start: 0.1, startStep: 0.2, minStep: 0.2 });
    for (let i = 0; i < 20; i++) s.record(false);
    expect(s.current()).toBe(0);
  });
});

describe('Determinism', () => {
  it('same correct/incorrect sequence → same trajectory', () => {
    const seq = [true, true, false, true, false, false, true, true, true, false];
    const run = () => {
      const s = new Staircase({ start: 0.4 });
      return seq.map((c) => s.record(c));
    };
    expect(run()).toEqual(run());
  });
});

describe('Convergence to a simulated threshold', () => {
  it('threshold estimate lands near the observer threshold (2-down/1-up ≈ 71%)', () => {
    // Simulated observer: answers correctly with a probability that falls as the
    // task gets harder, crossing ~71% correct at trueThreshold. We use a sharp
    // logistic so behaviour is near-deterministic around the threshold, and a
    // seeded RNG so the test is reproducible.
    const trueThreshold = 0.6;
    let a = 12345 >>> 0;
    const rng = () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    // p(correct): a logistic on a 2AFC scale (floor 0.5 chance, ceil ~1) tuned so
    // that p ≈ 0.71 exactly at trueThreshold — the level a 2-down/1-up staircase
    // homes in on. Steep slope so the staircase brackets the threshold cleanly.
    // The slope is steep, so the staircase's ~71% target band sits right at
    // trueThreshold regardless of this curve's exact value there; the test brackets
    // via the slope, not the precise p, so it doesn't depend on 0.71 vs 0.75.
    const pCorrect = (d: number) => {
      const k = 14;
      const logistic = 1 / (1 + Math.exp(k * (d - trueThreshold))); // 0.5 at threshold
      return 0.5 + 0.5 * logistic; // → 1 (easy) … 0.75 (at threshold) … 0.5 (hard)
    };

    const s = new Staircase({ start: 0.3, startStep: 0.2, minStep: 0.02, thresholdReversals: 10 });
    for (let i = 0; i < 400; i++) {
      const d = s.current();
      const correct = rng() < pCorrect(d);
      s.record(correct);
    }
    expect(s.reversals).toBeGreaterThan(12);
    expect(s.threshold()).toBeGreaterThan(trueThreshold - 0.12);
    expect(s.threshold()).toBeLessThan(trueThreshold + 0.12);
  });
});

describe('Threshold estimator', () => {
  it('before any reversal falls back to current difficulty', () => {
    const s = new Staircase({ start: 0.25 });
    expect(s.threshold()).toBeCloseTo(0.25);
    expect(s.settled).toBe(false);
  });
  it('averages only the last K reversals', () => {
    // 1-down/1-up so simple alternation produces a reversal every step.
    const s = new Staircase({ down: 1, up: 1, start: 0.5, startStep: 0.1, minStep: 0.1, thresholdReversals: 2 });
    const revs: number[] = [];
    for (let i = 0; i < 8; i++) {
      const before = s.reversals;
      s.record(i % 2 === 0); // alternate true/false
      if (s.reversals > before) revs.push(s.current());
    }
    // threshold = mean of last 2 recorded reversal difficulties.
    const last2 = revs.slice(-2);
    expect(s.threshold()).toBeCloseTo((last2[0] + last2[1]) / 2);
  });
});

describe('difficultyBand', () => {
  it('maps the [0,1] range to readable bands', () => {
    expect(difficultyBand(0)).toBe('easy');
    expect(difficultyBand(0.5)).toBe('firm');
    expect(difficultyBand(0.9)).toBe('expert');
  });
});
