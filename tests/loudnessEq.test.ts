import { describe, it, expect } from 'vitest';
import {
  LoudnessEqSession,
  simulateAnswer,
  clampCorrectionDb,
  REFERENCE_FREQ,
  TEST_FREQS,
  MAX_CORRECTION_DB,
  type LoudnessAnswer,
} from '../src/ui/loudnessEq';

/** Deterministic RNG (LCG) so band order + any randomness is reproducible. */
function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/**
 * Run a whole session against a synthetic listener whose TRUE per-band offset (the dB
 * the band must be boosted to MATCH 1 kHz for this listener) is given by `offsetFor`.
 * Returns the emitted correction curve as a freq→gainDb map.
 */
function runSession(offsetFor: (freq: number) => number, seed = 1): Map<number, number> {
  const session = new LoudnessEqSession({ rng: seededRng(seed) });
  let guard = 0;
  let q = session.nextQuestion();
  while (q) {
    const verdict: LoudnessAnswer = simulateAnswer(offsetFor(q.freq), q.testGainDb);
    session.answer(verdict);
    q = session.nextQuestion();
    if (++guard > 1000) throw new Error('session did not terminate');
  }
  const map = new Map<number, number>();
  for (const b of session.curve()) map.set(b.freq, b.gainDb);
  return map;
}

describe('clampCorrectionDb', () => {
  it('clamps to ±MAX and maps non-finite to 0', () => {
    expect(clampCorrectionDb(100)).toBe(MAX_CORRECTION_DB);
    expect(clampCorrectionDb(-100)).toBe(-MAX_CORRECTION_DB);
    expect(clampCorrectionDb(3)).toBe(3);
    expect(clampCorrectionDb(NaN)).toBe(0);
    expect(clampCorrectionDb(Infinity)).toBe(0);
  });
});

describe('simulateAnswer (synthetic listener)', () => {
  it('reports band louder when test gain exceeds the match point', () => {
    expect(simulateAnswer(0, 6)).toBe('band-louder');
  });
  it('reports reference louder when test gain is below the match point', () => {
    expect(simulateAnswer(6, 0)).toBe('reference-louder');
  });
  it('reports equal within tolerance', () => {
    expect(simulateAnswer(3, 3)).toBe('equal');
  });
});

describe('LoudnessEqSession question sequence', () => {
  it('covers every non-reference band and never the reference', () => {
    const session = new LoudnessEqSession({ rng: seededRng(7) });
    const seen = new Set<number>();
    let q = session.nextQuestion();
    let guard = 0;
    while (q) {
      seen.add(q.freq);
      expect(q.freq).not.toBe(REFERENCE_FREQ);
      session.answer('equal'); // converge fast
      q = session.nextQuestion();
      if (++guard > 1000) throw new Error('did not terminate');
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([...TEST_FREQS].sort((a, b) => a - b));
  });

  it('reports progress via bandIndex/totalBands and finishes', () => {
    const session = new LoudnessEqSession({ rng: seededRng(2) });
    const first = session.nextQuestion()!;
    expect(first.totalBands).toBe(TEST_FREQS.length);
    expect(first.bandIndex).toBe(0);
    while (session.nextQuestion()) session.answer('equal');
    expect(session.finished).toBe(true);
    expect(session.snapshot().finished).toBe(true);
    expect(session.snapshot().doneCount).toBe(TEST_FREQS.length);
  });
});

describe('staircase convergence recovers the INVERSE curve', () => {
  it('a listener needing +6 dB on a band gets ~ +6 dB correction', () => {
    // True offset: this listener perceives 8 kHz as quiet, needing +6 dB to match.
    const offsetFor = (freq: number) => (freq === 8000 ? 6 : 0);
    const curve = runSession(offsetFor, 11);
    // Correction = inverse of measured offset ⇒ a BOOST near +6 dB at 8 kHz.
    expect(curve.get(8000)!).toBeGreaterThan(4);
    expect(curve.get(8000)!).toBeLessThan(8);
    // Flat bands stay near 0.
    expect(Math.abs(curve.get(250)!)).toBeLessThan(2);
  });

  it('a listener with a band that is too HOT gets a CUT correction', () => {
    // Band must be cut (negative offset) to match ⇒ correction is negative (cut).
    const offsetFor = (freq: number) => (freq === 125 ? -6 : 0);
    const curve = runSession(offsetFor, 23);
    expect(curve.get(125)!).toBeLessThan(-4);
    expect(curve.get(125)!).toBeGreaterThan(-8);
  });

  it('reference band is always present at exactly 0 dB', () => {
    const curve = runSession(() => 0, 5);
    expect(curve.get(REFERENCE_FREQ)).toBe(0);
  });

  it('clamps an extreme listener offset to ±MAX correction', () => {
    const curve = runSession((freq) => (freq === 4000 ? 40 : 0), 3);
    expect(curve.get(4000)!).toBe(MAX_CORRECTION_DB);
    const curveLow = runSession((freq) => (freq === 4000 ? -40 : 0), 3);
    expect(curveLow.get(4000)!).toBe(-MAX_CORRECTION_DB);
  });
});

describe('answer folding', () => {
  it('lowers test gain on "band louder" and raises on "reference louder"', () => {
    const session = new LoudnessEqSession({ freqs: [2000], rng: seededRng(1) });
    const start = session.nextQuestion()!.testGainDb;
    session.answer('band-louder');
    const afterDown = session.nextQuestion()!.testGainDb;
    expect(afterDown).toBeLessThan(start);
    session.answer('reference-louder'); // reversal → raise
    const afterUp = session.nextQuestion()!.testGainDb;
    expect(afterUp).toBeGreaterThan(afterDown);
  });

  it('step shrinks at a reversal (homes in)', () => {
    const session = new LoudnessEqSession({ freqs: [2000], rng: seededRng(1) });
    const q0 = session.nextQuestion()!.testGainDb;
    session.answer('band-louder');
    const q1 = session.nextQuestion()!.testGainDb;
    const firstStep = Math.abs(q1 - q0);
    session.answer('reference-louder'); // reversal halves the step
    const q2 = session.nextQuestion()!.testGainDb;
    const secondStep = Math.abs(q2 - q1);
    expect(secondStep).toBeLessThan(firstStep);
  });

  it('answer() after finish is a harmless no-op', () => {
    const session = new LoudnessEqSession({ freqs: [2000], rng: seededRng(1) });
    while (session.nextQuestion()) session.answer('equal');
    expect(() => session.answer('equal')).not.toThrow();
    expect(session.nextQuestion()).toBeNull();
  });
});
