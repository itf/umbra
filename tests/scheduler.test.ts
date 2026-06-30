/**
 * Tests for the InterleavedScheduler (src/trainer/scheduler.ts).
 *
 * All tests inject a seeded deterministic RNG so outcomes are reproducible.
 * Seeded RNG: mulberry32 (same algorithm as exercises.ts makeRng).
 */
import { describe, it, expect } from 'vitest';
import {
  InterleavedScheduler,
  MIN_TRIALS,
  COMPETENCE_THRESHOLD,
  NO_REPEAT_CAP,
  DEFAULT_WEIGHT,
  ACCURACY_WINDOW,
} from '../src/trainer/scheduler';
import type { ExerciseType } from '../src/trainer/exercises';

// --- Seeded RNG (mulberry32) -------------------------------------------------

function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Types used across tests
const TYPES: ExerciseType[] = ['larger', 'wider', 'direction'];
const T_A: ExerciseType = 'larger';
const T_B: ExerciseType = 'wider';
const T_C: ExerciseType = 'direction';

// --- Helper: make a type competent by recording enough correct answers -------

function makeCompetent(scheduler: InterleavedScheduler, type: ExerciseType) {
  // Record MIN_TRIALS answers: alternate correct/correct/incorrect so the
  // staircase climbs above COMPETENCE_THRESHOLD via the 2-down/1-up rule.
  // We just record all-correct — staircase starts at 0 and climbs quickly.
  for (let i = 0; i < MIN_TRIALS; i++) {
    scheduler.recordResult(type, true, 0);
  }
  // After MIN_TRIALS all-correct the staircase will have stepped up several
  // times; threshold() should be at or near the difficulty reached.
}

// --- Tests -------------------------------------------------------------------

describe('InterleavedScheduler — novice / blocked phase', () => {
  it('returns the same type while it is below competence (blocked practice)', () => {
    const s = new InterleavedScheduler({}, makeRng(1));
    // No results recorded → all types are novice. Should keep returning T_A
    // (the last picked) until consecutive cap is hit.
    expect(s.isCompetent(T_A)).toBe(false);
    let result = s.nextType(TYPES, T_A, 1);
    expect(result).toBe(T_A); // stays on T_A (novice, consecutive < cap)
    result = s.nextType(TYPES, T_A, 2);
    expect(result).toBe(T_A); // still under cap
  });

  it('switches away from a novice type once the no-repeat cap is hit', () => {
    const s = new InterleavedScheduler({}, makeRng(2));
    // After NO_REPEAT_CAP consecutive picks of T_A (still novice), should switch.
    const result = s.nextType(TYPES, T_A, NO_REPEAT_CAP);
    expect(result).not.toBe(T_A);
  });

  it('isCompetent is false until MIN_TRIALS are accumulated', () => {
    const s = new InterleavedScheduler({}, makeRng(3));
    for (let i = 0; i < MIN_TRIALS - 1; i++) {
      s.recordResult(T_A, true, 0);
      expect(s.isCompetent(T_A)).toBe(false);
    }
  });

  it('single-element available list always returns that type regardless of state', () => {
    const s = new InterleavedScheduler({}, makeRng(4));
    expect(s.nextType([T_A])).toBe(T_A);
    expect(s.nextType([T_A], T_A, 100)).toBe(T_A);
  });
});

describe('InterleavedScheduler — competent / interleaved phase', () => {
  it('never repeats the same type more than NO_REPEAT_CAP times in a row', () => {
    const s = new InterleavedScheduler({}, makeRng(5));
    // Make all types competent.
    for (const t of TYPES) makeCompetent(s, t);

    let lastType: ExerciseType = s.nextType(TYPES);
    let consecutive = 1;
    for (let i = 0; i < 50; i++) {
      const next = s.nextType(TYPES, lastType, consecutive);
      if (next === lastType) {
        consecutive++;
      } else {
        consecutive = 1;
      }
      expect(consecutive).toBeLessThanOrEqual(NO_REPEAT_CAP);
      lastType = next;
    }
  });

  it('oversamples weak types (weaker → picked more often)', () => {
    const s = new InterleavedScheduler({}, makeRng(6));

    // Make all competent.
    for (const t of TYPES) makeCompetent(s, t);

    // Drive T_C to be weak: record ACCURACY_WINDOW all-wrong answers.
    for (let i = 0; i < ACCURACY_WINDOW; i++) s.recordResult(T_C, false, 0.5);
    // Drive T_A to be strong: record ACCURACY_WINDOW all-correct answers.
    for (let i = 0; i < ACCURACY_WINDOW; i++) s.recordResult(T_A, true, 0.5);

    // T_C weight should be higher than T_A weight.
    expect(s.weightFor(T_C)).toBeGreaterThan(s.weightFor(T_A));

    // Count picks over many trials — T_C should appear more often than T_A.
    const counts: Record<string, number> = { [T_A]: 0, [T_B]: 0, [T_C]: 0 };
    let last: ExerciseType = T_A;
    let consecutive = 0;
    for (let i = 0; i < 200; i++) {
      const next = s.nextType(TYPES, last, consecutive);
      counts[next]++;
      consecutive = next === last ? consecutive + 1 : 1;
      last = next;
    }
    expect(counts[T_C]).toBeGreaterThan(counts[T_A]);
  });
});

describe('InterleavedScheduler — per-type difficulty persistence', () => {
  it('each type has its own independent difficulty; switching preserves it', () => {
    const s = new InterleavedScheduler({}, makeRng(7));

    // Drive T_A difficulty up via all-correct.
    for (let i = 0; i < 10; i++) s.recordResult(T_A, true, 0);
    const diffA_after = s.difficultyFor(T_A);
    expect(diffA_after).toBeGreaterThan(0); // staircase has climbed

    // T_B should still be at the start difficulty (0).
    expect(s.difficultyFor(T_B)).toBe(0);

    // Record some T_B results (wrong, to drive it differently).
    s.recordResult(T_B, false, 0);
    const diffB = s.difficultyFor(T_B);
    expect(diffB).toBe(0); // 1-up after a miss from 0 = stays at 0 (clamped)

    // Switching back to T_A: its difficulty unchanged.
    expect(s.difficultyFor(T_A)).toBeCloseTo(diffA_after);
  });
});

describe('InterleavedScheduler — determinism with seeded RNG', () => {
  it('produces identical type sequences given the same seed', () => {
    function runSequence(seed: number): ExerciseType[] {
      const s = new InterleavedScheduler({}, makeRng(seed));
      for (const t of TYPES) makeCompetent(s, t);
      const out: ExerciseType[] = [];
      let last: ExerciseType | undefined;
      let consecutive = 0;
      for (let i = 0; i < 20; i++) {
        const next = s.nextType(TYPES, last, consecutive);
        out.push(next);
        consecutive = next === last ? consecutive + 1 : 1;
        last = next;
      }
      return out;
    }
    expect(runSequence(42)).toEqual(runSequence(42));
    expect(runSequence(42)).not.toEqual(runSequence(99)); // different seeds differ
  });
});

describe('InterleavedScheduler — snapshot / restore', () => {
  it('restores per-type difficulty and competence from a snapshot', () => {
    const s1 = new InterleavedScheduler({}, makeRng(8));
    for (let i = 0; i < 10; i++) s1.recordResult(T_A, true, 0);
    for (let i = 0; i < 3; i++) s1.recordResult(T_B, false, 0.3);

    const snap = s1.getSnapshot();

    const s2 = new InterleavedScheduler({}, makeRng(9)); // different seed
    s2.loadSnapshot(snap);

    expect(s2.difficultyFor(T_A)).toBeCloseTo(s1.difficultyFor(T_A));
    expect(s2.difficultyFor(T_B)).toBeCloseTo(s1.difficultyFor(T_B));
    expect(s2.isCompetent(T_A)).toBe(s1.isCompetent(T_A));
  });
});

describe('InterleavedScheduler — constants sanity', () => {
  it('exported constants are within expected ranges', () => {
    expect(MIN_TRIALS).toBeGreaterThanOrEqual(4);
    expect(COMPETENCE_THRESHOLD).toBeGreaterThan(0);
    expect(COMPETENCE_THRESHOLD).toBeLessThan(1);
    expect(NO_REPEAT_CAP).toBeGreaterThanOrEqual(2);
    expect(DEFAULT_WEIGHT).toBeGreaterThan(0);
    expect(DEFAULT_WEIGHT).toBeLessThanOrEqual(1);
    expect(ACCURACY_WINDOW).toBeGreaterThanOrEqual(3);
  });
});
