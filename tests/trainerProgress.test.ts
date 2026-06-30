/**
 * Trainer progression: persistence round-trip + pure summary; reversal/streak
 * announcement logic; the Thaler distance ladder's stepping; and the 4-way
 * orientation drill's fairness + scoring.
 */
import { describe, it, expect } from 'vitest';
import {
  TrainerStore,
  summarizeProgress,
  TRAINER_PROGRESS_KEY,
  type ExerciseProgress,
} from '../src/trainer/trainerStore';
import { Staircase, progressAnnouncement } from '../src/trainer/adaptive';
import { DistanceLadder, ladderAnnouncement } from '../src/trainer/distanceLadder';
import {
  makeQuestion,
  classifyOrientation,
  ORIENTATIONS,
} from '../src/trainer/exercises';

/** Minimal in-memory localStorage stub (mirrors onboarding.test.ts). */
function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    _map: map,
  };
}

describe('TrainerStore persistence', () => {
  it('round-trips a recorded session and tracks best/last/sessions', () => {
    const s = new TrainerStore(fakeStorage());
    expect(s.get('direction').sessions).toBe(0);

    s.recordSession('direction', { threshold: 0.4, trials: 10, correct: 7 });
    s.recordSession('direction', { threshold: 0.25, trials: 8, correct: 6 });
    s.recordSession('direction', { threshold: 0.3, trials: 12, correct: 9 });

    const p = s.get('direction');
    expect(p.sessions).toBe(3);
    expect(p.trials).toBe(30);
    expect(p.correct).toBe(22);
    expect(p.last).toBeCloseTo(0.3);
    expect(p.best).toBeCloseTo(0.25); // lowest threshold = best
    expect(p.thresholdHistory).toEqual([0.4, 0.25, 0.3]);
  });

  it('keeps exercise types separate', () => {
    const s = new TrainerStore(fakeStorage());
    s.recordSession('direction', { threshold: 0.5, trials: 4, correct: 3 });
    s.recordSession('distance', { threshold: 0.2, trials: 4, correct: 4 });
    expect(s.get('direction').last).toBeCloseTo(0.5);
    expect(s.get('distance').last).toBeCloseTo(0.2);
  });

  it('persists across store instances backed by the same storage', () => {
    const fake = fakeStorage();
    new TrainerStore(fake).recordSession('gap', { threshold: 0.33, trials: 5, correct: 4 });
    const reloaded = new TrainerStore(fake).get('gap');
    expect(reloaded.sessions).toBe(1);
    expect(reloaded.last).toBeCloseTo(0.33);
    expect(fake._map.has(TRAINER_PROGRESS_KEY)).toBe(true);
  });

  it('degrades to memory when storage is null', () => {
    const s = new TrainerStore(null);
    s.recordSession('larger', { threshold: 0.6, trials: 2, correct: 1 });
    expect(s.get('larger').last).toBeCloseTo(0.6);
  });

  it('degrades to memory when storage throws', () => {
    const throwing = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    };
    const s = new TrainerStore(throwing);
    s.recordSession('wider', { threshold: 0.7, trials: 3, correct: 2 });
    expect(s.get('wider').last).toBeCloseTo(0.7);
  });

  it('survives malformed/corrupt storage without throwing', () => {
    const fake = fakeStorage();
    fake._map.set(TRAINER_PROGRESS_KEY, '{not valid json');
    expect(() => new TrainerStore(fake).load()).not.toThrow();
    expect(new TrainerStore(fake).get('direction').sessions).toBe(0);

    fake._map.set(TRAINER_PROGRESS_KEY, JSON.stringify({ direction: { trials: 'oops', best: 'x', thresholdHistory: [1, 'bad', 2] } }));
    const p = new TrainerStore(fake).get('direction');
    expect(p.trials).toBe(0);
    expect(p.best).toBeNull();
    expect(p.thresholdHistory).toEqual([1, 2]); // non-numbers dropped
  });

  it('updateLastSession edits the latest sample in place (one sitting = one session)', () => {
    const s = new TrainerStore(fakeStorage());
    s.recordSession('direction', { threshold: 0.5, trials: 4, correct: 2 });
    s.updateLastSession('direction', { threshold: 0.3, trials: 9, correct: 7 });
    const p = s.get('direction');
    expect(p.sessions).toBe(1); // not 2 — updated in place
    expect(p.thresholdHistory).toEqual([0.3]);
    expect(p.trials).toBe(9); // replaced, not summed (4 rolled back)
    expect(p.correct).toBe(7);
    expect(p.last).toBeCloseTo(0.3);
    expect(p.best).toBeCloseTo(0.3);
  });

  it('updateLastSession falls back to recording when no session exists', () => {
    const s = new TrainerStore(fakeStorage());
    s.updateLastSession('gap', { threshold: 0.4, trials: 3, correct: 2 });
    expect(s.get('gap').sessions).toBe(1);
  });

  it('best is recomputed when the updated sample was the previous best', () => {
    const s = new TrainerStore(fakeStorage());
    s.recordSession('metal', { threshold: 0.2, trials: 4, correct: 4 }); // best 0.2
    s.recordSession('metal', { threshold: 0.5, trials: 4, correct: 2 });
    // worsen the latest sample; best should stay 0.2 (from the older session)
    s.updateLastSession('metal', { threshold: 0.6, trials: 4, correct: 1 });
    expect(s.get('metal').best).toBeCloseTo(0.2);
  });

  it('clear() wipes progress', () => {
    const fake = fakeStorage();
    const s = new TrainerStore(fake);
    s.recordSession('metal', { threshold: 0.4, trials: 2, correct: 2 });
    s.clear();
    expect(s.get('metal').sessions).toBe(0);
    expect(fake._map.has(TRAINER_PROGRESS_KEY)).toBe(false);
  });
});

describe('summarizeProgress (pure)', () => {
  it('returns empty for a brand-new user (no sessions)', () => {
    expect(summarizeProgress('direction', null)).toBe('');
    const empty: ExerciseProgress = { thresholdHistory: [], trials: 0, correct: 0, sessions: 0, best: null, last: null };
    expect(summarizeProgress('direction', empty)).toBe('');
  });

  it('renders best, last and session count as percents', () => {
    const p: ExerciseProgress = { thresholdHistory: [0.4, 0.18], trials: 18, correct: 14, sessions: 2, best: 0.18, last: 0.18 };
    const msg = summarizeProgress('Sound direction', p);
    expect(msg).toContain('Sound direction');
    expect(msg).toContain('18%');
    expect(msg).toContain('2 sessions');
  });

  it('uses singular "1 session"', () => {
    const p: ExerciseProgress = { thresholdHistory: [0.5], trials: 5, correct: 3, sessions: 1, best: 0.5, last: 0.5 };
    expect(summarizeProgress('x', p)).toContain('1 session');
  });
});

describe('progressAnnouncement (reversals & streaks)', () => {
  it('announces a reversal direction', () => {
    expect(progressAnnouncement({ correct: true, reversal: true, lastMove: 1, streak: 3 }))
      .toBe('Reversal — stepping up.');
    expect(progressAnnouncement({ correct: false, reversal: true, lastMove: -1, streak: 0 }))
      .toBe('Reversal — stepping down.');
  });

  it('announces a streak only at >= 2 in a row, and never on a miss', () => {
    expect(progressAnnouncement({ correct: true, reversal: false, lastMove: 1, streak: 1 })).toBe('');
    expect(progressAnnouncement({ correct: true, reversal: false, lastMove: 1, streak: 3 })).toBe('3 in a row.');
    expect(progressAnnouncement({ correct: false, reversal: false, lastMove: -1, streak: 0 })).toBe('');
  });

  it('prefers the reversal note over the streak note', () => {
    // A step-up reversal can coincide with a streak; the turn is the headline.
    expect(progressAnnouncement({ correct: true, reversal: true, lastMove: 1, streak: 4 }))
      .toBe('Reversal — stepping up.');
  });
});

describe('Staircase streak tracking', () => {
  it('counts consecutive corrects and resets on a miss', () => {
    const s = new Staircase({ start: 0.5 });
    s.record(true); expect(s.streak).toBe(1);
    s.record(true); expect(s.streak).toBe(2); // survives a step-up
    s.record(true); expect(s.streak).toBe(3);
    s.record(false); expect(s.streak).toBe(0);
    s.record(true); expect(s.streak).toBe(1);
  });
});

describe('DistanceLadder (Thaler 90%-over-window step-back)', () => {
  it('does not step before a full window', () => {
    const l = new DistanceLadder({ window: 10 });
    for (let i = 0; i < 9; i++) expect(l.record(true).moved).toBe(0);
    expect(l.currentRung()).toBe(0);
  });

  it('steps farther by 33 cm once accuracy >= 90% over a full window', () => {
    const l = new DistanceLadder({ window: 10, stepUpAccuracy: 0.9, baseM: 0.33, stepM: 0.33 });
    expect(l.distance()).toBeCloseTo(0.33);
    let last;
    for (let i = 0; i < 10; i++) last = l.record(true);
    expect(last!.moved).toBe(1);
    expect(l.currentRung()).toBe(1);
    expect(l.distance()).toBeCloseTo(0.66); // 33 -> 66 cm
  });

  it('one miss inside the window keeps 90% (9/10) and still promotes', () => {
    const l = new DistanceLadder({ window: 10, stepUpAccuracy: 0.9 });
    for (let i = 0; i < 9; i++) l.record(true);
    expect(l.record(false).moved).toBe(1); // 9/10 = 0.9
  });

  it('two misses (8/10 < 90%) do NOT promote', () => {
    const l = new DistanceLadder({ window: 10, stepUpAccuracy: 0.9, stepDownAccuracy: null });
    l.record(false); l.record(false);
    for (let i = 0; i < 8; i++) l.record(true);
    expect(l.currentRung()).toBe(0);
  });

  it('clears the window after a step so the next rung is judged fresh', () => {
    const l = new DistanceLadder({ window: 4, stepUpAccuracy: 1 });
    for (let i = 0; i < 4; i++) l.record(true);
    expect(l.currentRung()).toBe(1);
    expect(l.accuracy()).toBe(0); // window reset
  });

  it('regresses when accuracy collapses (step-down enabled)', () => {
    const l = new DistanceLadder({ window: 4, startRung: 2, stepDownAccuracy: 0.5 });
    let last;
    for (let i = 0; i < 4; i++) last = l.record(false);
    expect(last!.moved).toBe(-1);
    expect(l.currentRung()).toBe(1);
  });

  it('respects maxRung', () => {
    const l = new DistanceLadder({ window: 2, stepUpAccuracy: 1, maxRung: 1 });
    l.record(true); l.record(true); // -> rung 1
    l.record(true); l.record(true); // would be rung 2 but capped
    expect(l.currentRung()).toBe(1);
  });

  it('announcement is terse and only on a move', () => {
    expect(ladderAnnouncement({ rung: 1, distanceM: 0.66, moved: 1 })).toContain('farther');
    expect(ladderAnnouncement({ rung: 0, distanceM: 0.33, moved: -1 })).toContain('closer');
    expect(ladderAnnouncement({ rung: 0, distanceM: 0.33, moved: 0 })).toBe('');
  });
});

describe('distance exercise honours the ladder distance', () => {
  it('places the near panel at the requested distance ahead', () => {
    const near = makeQuestion('distance', 42, { nearDistanceM: 0.33 });
    const far = makeQuestion('distance', 42, { nearDistanceM: 3.0 });
    // The closer-room panel z (front = -z from centre 8) should differ with the
    // ladder distance, holding the seed fixed.
    const panelZ = (s: typeof near.sceneA) => s.extraWalls![0].verts[0][2];
    expect(panelZ(near.sceneA)).not.toBeCloseTo(panelZ(far.sceneA));
  });
});

describe('orientation drill (4-way classification)', () => {
  const SEEDS = Array.from({ length: 40 }, (_, i) => i * 9173 + 3);

  it('offers exactly the four orientation choices', () => {
    const q = makeQuestion('orientation', 7);
    expect(q.choices).toEqual(ORIENTATIONS.map((o) => o.label));
    expect(q.choices).toHaveLength(4); // 4AFC, chance 25%
  });

  it('the correct answer is one of the four and scores via classifyOrientation', () => {
    for (const seed of SEEDS) {
      const q = makeQuestion('orientation', seed);
      const truth = ORIENTATIONS.find((o) => o.label === q.correctAnswer);
      expect(truth).toBeDefined();
      expect(classifyOrientation(q.correctAnswer, truth!.key)).toBe(true);
      // a different choice must score wrong (no partial credit)
      const wrong = ORIENTATIONS.find((o) => o.label !== q.correctAnswer)!;
      expect(classifyOrientation(wrong.label, truth!.key)).toBe(false);
    }
  });

  it('is a fair single-scene clap drill (no size cue): same room each time', () => {
    for (const seed of SEEDS) {
      const q = makeQuestion('orientation', seed);
      expect(q.sceneB).toBeUndefined(); // single-scene
      expect(q.sceneA.sources.some((s) => s.kind === 'clap')).toBe(true);
      expect(q.sceneA.extraWalls && q.sceneA.extraWalls.length).toBe(1);
      // the panel face elevation is the ONLY varying cue: panel centred ahead at
      // ear height, room geometry/material identical across orientations.
      expect(q.sceneA.roomSize).toEqual([16, 4, 16]);
    }
  });

  it('different orientations produce geometrically different panels', () => {
    // Sweep seeds until we see at least two distinct correct orientations, then
    // confirm their panel vertices differ (tilt actually changes geometry).
    const byOrient = new Map<string, number[][]>();
    for (const seed of SEEDS) {
      const q = makeQuestion('orientation', seed);
      byOrient.set(q.correctAnswer, q.sceneA.extraWalls![0].verts as number[][]);
    }
    expect(byOrient.size).toBeGreaterThanOrEqual(2);
    const verts = [...byOrient.values()];
    expect(JSON.stringify(verts[0])).not.toBe(JSON.stringify(verts[1]));
  });

  it('determinism: same seed → same orientation question', () => {
    expect(makeQuestion('orientation', 99)).toEqual(makeQuestion('orientation', 99));
  });
});
