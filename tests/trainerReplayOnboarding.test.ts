/**
 * Pure logic for the three training-value features:
 *  - freeze-frame post-answer replay sequencing (which scenes, labels, when to skip),
 *  - first-launch onboarding gating (runs once, never in daily mode),
 *  - timestamped thresholdLog shape (back-compat with old number[] history) +
 *    sparkline data prep + the accessible trend summary.
 */
import { describe, it, expect } from 'vitest';
import { planReplay, replayAnnouncement, replayDescriptors } from '../src/trainer/replay';
import { shouldRunOnboarding, onboardingQuestion, ONBOARDING_REVEAL } from '../src/trainer/onboarding';
import {
  TrainerStore,
  sparklinePoints,
  trendSummary,
  TRAINER_PROGRESS_KEY,
  type ExerciseProgress,
} from '../src/trainer/trainerStore';
import { makeQuestion } from '../src/trainer/exercises';

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    _map: map,
  };
}

// --- Replay sequencing --------------------------------------------------------

describe('planReplay (freeze-frame post-answer replay)', () => {
  it('returns null for single-scene exercises (no Room B → no replay)', () => {
    for (const type of ['direction', 'gap', 'orientation'] as const) {
      const q = makeQuestion(type, 5);
      expect(planReplay(q, true)).toBeNull();
      expect(planReplay(q, false)).toBeNull();
    }
  });

  it('plans an A→B comparison for an A/B drill, with A first then B', () => {
    const q = makeQuestion('larger', 11);
    const plan = planReplay(q, false)!;
    expect(plan).not.toBeNull();
    expect(plan.steps.map((s) => s.room)).toEqual(['A', 'B']);
    expect(plan.gapMs).toBe(500);
  });

  it('marks exactly the correct room as correct and labels it', () => {
    const q = makeQuestion('larger', 11);
    const plan = planReplay(q, false)!;
    const correctRoom = q.correctAnswer === 'Room B' ? 'B' : 'A';
    const correctStep = plan.steps.find((s) => s.room === correctRoom)!;
    const otherStep = plan.steps.find((s) => s.room !== correctRoom)!;
    expect(correctStep.isCorrect).toBe(true);
    expect(otherStep.isCorrect).toBe(false);
    expect(correctStep.label).toContain('(correct)');
    expect(otherStep.label).not.toContain('(correct)');
  });

  it('uses type-specific descriptors in the labels', () => {
    expect(replayDescriptors('larger').correct).toContain('larger');
    expect(replayDescriptors('wider').correct).toContain('wider');
    expect(replayDescriptors('distance').correct).toContain('closer');
    // unmapped type still yields a usable generic descriptor
    expect(replayDescriptors('carpet').correct).toBeTruthy();
  });

  it('intro wording differs for correct (reinforce) vs wrong (correct it)', () => {
    const q = makeQuestion('wider', 3);
    expect(planReplay(q, true)!.intro).not.toBe(planReplay(q, false)!.intro);
  });

  it('replayAnnouncement joins intro + both step labels', () => {
    const q = makeQuestion('longer', 7);
    const plan = planReplay(q, true)!;
    const line = replayAnnouncement(plan);
    expect(line).toContain(plan.intro.trim());
    for (const s of plan.steps) expect(line).toContain(s.label);
  });
});

// --- Onboarding gating --------------------------------------------------------

describe('shouldRunOnboarding (first-launch only)', () => {
  it('runs on a brand-new launch (not seen, not daily)', () => {
    expect(shouldRunOnboarding({ hasSeen: false, daily: false })).toBe(true);
  });
  it('never runs once seen', () => {
    expect(shouldRunOnboarding({ hasSeen: true, daily: false })).toBe(false);
  });
  it('never runs in daily mode', () => {
    expect(shouldRunOnboarding({ hasSeen: false, daily: true })).toBe(false);
  });

  it('the onboarding question is an easy larger/smaller A/B', () => {
    const q = onboardingQuestion();
    expect(q.type).toBe('larger');
    expect(q.sceneB).toBeDefined();
    expect(q.choices).toEqual(['Room A', 'Room B']);
    expect(q).toEqual(onboardingQuestion()); // deterministic
  });

  it('names the skill in the reveal', () => {
    expect(ONBOARDING_REVEAL.toLowerCase()).toContain('echolocation');
  });
});

describe('TrainerStore onboarding flag (persisted, one-shot)', () => {
  it('defaults to not-seen, then sticks once marked', () => {
    const fake = fakeStorage();
    expect(new TrainerStore(fake).hasSeenOnboarding()).toBe(false);
    new TrainerStore(fake).markOnboardingSeen();
    expect(new TrainerStore(fake).hasSeenOnboarding()).toBe(true);
  });
  it('survives a progress clear() (separate key)', () => {
    const fake = fakeStorage();
    const s = new TrainerStore(fake);
    s.markOnboardingSeen();
    s.clear();
    expect(s.hasSeenOnboarding()).toBe(true);
  });
  it('degrades to memory when storage throws', () => {
    const throwing = {
      getItem: () => { throw new Error('x'); },
      setItem: () => { throw new Error('x'); },
      removeItem: () => { throw new Error('x'); },
    };
    const s = new TrainerStore(throwing);
    expect(s.hasSeenOnboarding()).toBe(false);
    s.markOnboardingSeen();
    expect(s.hasSeenOnboarding()).toBe(true);
  });
});

// --- Timestamped history + sparkline prep + trend summary ---------------------

describe('thresholdLog (timestamped, back-compat)', () => {
  it('records a timestamped entry per session', () => {
    const s = new TrainerStore(fakeStorage());
    s.recordSession('larger', { threshold: 0.4, trials: 4, correct: 3 }, 1000);
    s.recordSession('larger', { threshold: 0.25, trials: 4, correct: 4 }, 2000);
    const p = s.get('larger');
    expect(p.thresholdLog).toEqual([
      { ts: 1000, threshold: 0.4 },
      { ts: 2000, threshold: 0.25 },
    ]);
    expect(p.thresholdHistory).toEqual([0.4, 0.25]); // legacy field kept in sync
  });

  it('updateLastSession re-stamps the latest log entry in place', () => {
    const s = new TrainerStore(fakeStorage());
    s.recordSession('gap', { threshold: 0.5, trials: 4, correct: 2 }, 1000);
    s.updateLastSession('gap', { threshold: 0.3, trials: 9, correct: 8 }, 1500);
    const p = s.get('gap');
    expect(p.thresholdLog).toEqual([{ ts: 1500, threshold: 0.3 }]);
  });

  it('back-fills thresholdLog from an OLD blob that only had number[] history', () => {
    const fake = fakeStorage();
    fake._map.set(TRAINER_PROGRESS_KEY, JSON.stringify({
      direction: { thresholdHistory: [0.5, 0.3], trials: 8, correct: 6, sessions: 2, best: 0.3, last: 0.3 },
    }));
    const p = new TrainerStore(fake).get('direction');
    expect(p.thresholdLog).toEqual([
      { ts: 0, threshold: 0.5 },
      { ts: 0, threshold: 0.3 },
    ]);
  });

  it('drops malformed log entries without throwing', () => {
    const fake = fakeStorage();
    fake._map.set(TRAINER_PROGRESS_KEY, JSON.stringify({
      direction: { thresholdLog: [{ ts: 1, threshold: 0.2 }, { ts: 'bad', threshold: 0.3 }, null, 7] },
    }));
    expect(new TrainerStore(fake).get('direction').thresholdLog).toEqual([{ ts: 1, threshold: 0.2 }]);
  });
});

describe('sparklinePoints (pure data prep)', () => {
  it('is empty for no history', () => {
    expect(sparklinePoints([])).toEqual([]);
  });
  it('centres a single sample', () => {
    expect(sparklinePoints([{ ts: 1, threshold: 0.4 }])).toEqual([{ x: 0.5, y: 0.4 }]);
  });
  it('spreads x evenly and keeps raw threshold as y', () => {
    const pts = sparklinePoints([
      { ts: 1, threshold: 0.6 },
      { ts: 2, threshold: 0.4 },
      { ts: 3, threshold: 0.2 },
    ]);
    expect(pts.map((p) => p.x)).toEqual([0, 0.5, 1]);
    expect(pts.map((p) => p.y)).toEqual([0.6, 0.4, 0.2]);
  });
  it('clamps out-of-range thresholds into [0,1]', () => {
    const pts = sparklinePoints([{ ts: 1, threshold: -0.5 }, { ts: 2, threshold: 1.5 }]);
    expect(pts.map((p) => p.y)).toEqual([0, 1]);
  });
});

describe('trendSummary (accessible text alongside the canvas)', () => {
  const base = (log: { ts: number; threshold: number }[]): ExerciseProgress => ({
    thresholdHistory: log.map((e) => e.threshold),
    thresholdLog: log,
    trials: 10,
    correct: 8,
    sessions: log.length,
    best: log.length ? Math.min(...log.map((e) => e.threshold)) : null,
    last: log.length ? log[log.length - 1].threshold : null,
  });

  it('is empty for no history', () => {
    expect(trendSummary('Room size', base([]))).toBe('');
    expect(trendSummary('Room size', null)).toBe('');
  });

  it('reads "improving" when the latest is clearly lower than earlier', () => {
    const msg = trendSummary('Room size', base([
      { ts: 1, threshold: 0.6 },
      { ts: 2, threshold: 0.5 },
      { ts: 3, threshold: 0.2 },
    ]));
    expect(msg).toContain('improving');
    expect(msg).toContain('Room size');
    expect(msg).toContain('20%'); // best
  });

  it('reads "slipping" when the latest is clearly higher', () => {
    expect(trendSummary('x', base([
      { ts: 1, threshold: 0.2 },
      { ts: 2, threshold: 0.6 },
    ]))).toContain('slipping');
  });

  it('reads "steady" for a single sample', () => {
    expect(trendSummary('x', base([{ ts: 1, threshold: 0.3 }]))).toContain('steady');
  });
});
