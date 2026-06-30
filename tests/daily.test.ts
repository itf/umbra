/**
 * DAILY CHALLENGE — pure date→challenge determinism, streak transitions
 * (consecutive / missed-day reset / same-day idempotency / first-ever), the
 * spoken announcements, the shareable score string, and the persisted streak
 * store (round-trip + idempotency + degraded storage).
 */
import { describe, it, expect } from 'vitest';
import {
  dailySeed,
  challengeForDate,
  shiftDate,
  isDateStr,
  applyDailyCompletion,
  dailyOpenAnnouncement,
  dailyResultAnnouncement,
  shareScoreString,
  TYPE_LABELS,
} from '../src/trainer/daily';
import {
  DailyStreakStore,
  DAILY_STREAK_KEY,
  emptyStreak,
} from '../src/trainer/dailyStreakStore';

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    _map: map,
  };
}

describe('dailySeed (pure date → seed)', () => {
  it('is deterministic: same date → same seed', () => {
    expect(dailySeed('2026-06-29')).toBe(dailySeed('2026-06-29'));
  });
  it('differs across adjacent dates', () => {
    expect(dailySeed('2026-06-29')).not.toBe(dailySeed('2026-06-30'));
    expect(dailySeed('2026-06-29')).not.toBe(dailySeed('2026-07-29'));
  });
  it('returns an unsigned 32-bit integer', () => {
    const s = dailySeed('2026-01-01');
    expect(Number.isInteger(s)).toBe(true);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(0xffffffff);
  });
});

describe('challengeForDate (deterministic daily)', () => {
  it('same date → identical challenge (type, difficulty, question)', () => {
    const a = challengeForDate('2026-06-29');
    const b = challengeForDate('2026-06-29');
    expect(a.type).toBe(b.type);
    expect(a.difficulty).toBe(b.difficulty);
    expect(a.question).toEqual(b.question);
    expect(a.seed).toBe(b.seed);
  });
  it('different dates generally yield different challenges over a span', () => {
    const types = new Set<string>();
    for (let d = 1; d <= 28; d++) {
      const date = `2026-06-${d.toString().padStart(2, '0')}`;
      types.add(challengeForDate(date).type);
    }
    // Over a month we should see several distinct exercise types (not all one).
    expect(types.size).toBeGreaterThanOrEqual(3);
  });
  it('produces a valid question with a label', () => {
    const c = challengeForDate('2026-06-29');
    expect(c.difficulty).toBeGreaterThanOrEqual(0);
    expect(c.difficulty).toBeLessThanOrEqual(1);
    expect(TYPE_LABELS[c.type]).toBeTruthy();
    expect(c.question.choices.length).toBeGreaterThanOrEqual(2);
  });
});

describe('isDateStr / shiftDate (pure)', () => {
  it('validates YYYY-MM-DD shape', () => {
    expect(isDateStr('2026-06-29')).toBe(true);
    expect(isDateStr('2026-6-9')).toBe(false);
    expect(isDateStr('not-a-date')).toBe(false);
    expect(isDateStr(123)).toBe(false);
  });
  it('shifts dates across month and year boundaries (UTC, clock-free)', () => {
    expect(shiftDate('2026-06-29', 1)).toBe('2026-06-30');
    expect(shiftDate('2026-06-30', 1)).toBe('2026-07-01');
    expect(shiftDate('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftDate('2026-01-01', -1)).toBe('2025-12-31');
  });
});

describe('applyDailyCompletion (pure streak transition)', () => {
  it('first-ever completion → streak 1', () => {
    const t = applyDailyCompletion({ lastCompletedDate: null, currentStreak: 0, longestStreak: 0 }, '2026-06-29');
    expect(t.currentStreak).toBe(1);
    expect(t.longestStreak).toBe(1);
    expect(t.changed).toBe(true);
    expect(t.isBest).toBe(false); // day 1 of a fresh streak isn't "your best"
  });

  it('consecutive day → increments', () => {
    const t = applyDailyCompletion({ lastCompletedDate: '2026-06-29', currentStreak: 4, longestStreak: 4 }, '2026-06-30');
    expect(t.currentStreak).toBe(5);
    expect(t.longestStreak).toBe(5);
    expect(t.changed).toBe(true);
    expect(t.isBest).toBe(true); // new record
  });

  it('same-day repeat → idempotent (no change)', () => {
    const t = applyDailyCompletion({ lastCompletedDate: '2026-06-29', currentStreak: 5, longestStreak: 7 }, '2026-06-29');
    expect(t.currentStreak).toBe(5);
    expect(t.longestStreak).toBe(7);
    expect(t.changed).toBe(false);
    expect(t.isBest).toBe(false);
  });

  it('missed a day → resets to 1, longest preserved', () => {
    const t = applyDailyCompletion({ lastCompletedDate: '2026-06-27', currentStreak: 9, longestStreak: 9 }, '2026-06-29');
    expect(t.currentStreak).toBe(1);
    expect(t.longestStreak).toBe(9); // longest never shrinks
    expect(t.changed).toBe(true);
    expect(t.isBest).toBe(false);
  });

  it('extending past prior best is a record; matching it is not', () => {
    // current 3, longest 5: a consecutive day → 4, not a record yet.
    const t1 = applyDailyCompletion({ lastCompletedDate: '2026-06-29', currentStreak: 3, longestStreak: 5 }, '2026-06-30');
    expect(t1.currentStreak).toBe(4);
    expect(t1.isBest).toBe(false);
    // current 5, longest 5: consecutive → 6, beats the record.
    const t2 = applyDailyCompletion({ lastCompletedDate: '2026-06-29', currentStreak: 5, longestStreak: 5 }, '2026-06-30');
    expect(t2.isBest).toBe(true);
  });

  it('a backwards/weird last date resets to 1', () => {
    const t = applyDailyCompletion({ lastCompletedDate: '2026-07-05', currentStreak: 3, longestStreak: 3 }, '2026-06-29');
    expect(t.currentStreak).toBe(1);
  });
});

describe('announcements (pure)', () => {
  const challenge = challengeForDate('2026-06-29');

  it('open announcement names the skill and the streak', () => {
    const msg = dailyOpenAnnouncement({ challenge, currentStreak: 4, doneToday: false });
    expect(msg).toContain('Daily challenge');
    expect(msg).toContain(TYPE_LABELS[challenge.type]);
    expect(msg).toContain('Day 4 streak');
    expect(msg).not.toContain('Already completed');
  });

  it('open announcement notes already-done and a zero streak', () => {
    const msg = dailyOpenAnnouncement({ challenge, currentStreak: 0, doneToday: true });
    expect(msg).toContain('No streak yet');
    expect(msg).toContain('Already completed today');
  });

  it('result announcement calls out a personal best', () => {
    const t = applyDailyCompletion({ lastCompletedDate: '2026-06-29', currentStreak: 4, longestStreak: 4 }, '2026-06-30');
    const msg = dailyResultAnnouncement({ correct: true, transition: t, alreadyDoneToday: false });
    expect(msg).toContain('Correct!');
    expect(msg).toContain('5-day streak');
    expect(msg).toContain('your best');
  });

  it('result announcement is idempotent-aware on a same-day repeat', () => {
    const t = applyDailyCompletion({ lastCompletedDate: '2026-06-29', currentStreak: 5, longestStreak: 7 }, '2026-06-29');
    const msg = dailyResultAnnouncement({ correct: false, transition: t, alreadyDoneToday: true });
    expect(msg).toContain('already done today');
    expect(msg).toContain('5-day streak');
  });
});

describe('shareScoreString (pure)', () => {
  const challenge = challengeForDate('2026-06-29');

  it('formats a one-line shareable score', () => {
    const s = shareScoreString({ date: '2026-06-29', challenge, correct: true, currentStreak: 5 });
    expect(s).toContain('papasangre daily 2026-06-29');
    expect(s).toContain(TYPE_LABELS[challenge.type]);
    expect(s).toContain('correct');
    expect(s).toContain('5-day streak');
  });

  it('marks a miss and folds in an optional detail', () => {
    const s = shareScoreString({ date: '2026-06-29', challenge, correct: false, currentStreak: 1, detail: '18°' });
    expect(s).toContain('missed');
    expect(s).toContain('18°');
    expect(s).toContain('1-day streak');
  });
});

describe('DailyStreakStore (persistence + idempotency)', () => {
  it('records a first completion and persists', () => {
    const fake = fakeStorage();
    const store = new DailyStreakStore(fake);
    const { state } = store.complete('2026-06-29');
    expect(state.currentStreak).toBe(1);
    expect(state.totalDays).toBe(1);
    expect(store.isCompletedOn('2026-06-29')).toBe(true);
    expect(fake._map.has(DAILY_STREAK_KEY)).toBe(true);
  });

  it('is idempotent for the same day (no double count)', () => {
    const store = new DailyStreakStore(fakeStorage());
    store.complete('2026-06-29');
    const second = store.complete('2026-06-29');
    expect(second.transition.changed).toBe(false);
    expect(second.state.currentStreak).toBe(1);
    expect(second.state.totalDays).toBe(1); // not 2
  });

  it('extends across consecutive days and resets on a gap', () => {
    const store = new DailyStreakStore(fakeStorage());
    store.complete('2026-06-27');
    store.complete('2026-06-28');
    expect(store.load().currentStreak).toBe(2);
    store.complete('2026-06-30'); // skipped the 29th
    const s = store.load();
    expect(s.currentStreak).toBe(1);
    expect(s.longestStreak).toBe(2);
    expect(s.totalDays).toBe(3);
  });

  it('persists across instances sharing storage', () => {
    const fake = fakeStorage();
    new DailyStreakStore(fake).complete('2026-06-29');
    expect(new DailyStreakStore(fake).isCompletedOn('2026-06-29')).toBe(true);
  });

  it('degrades to memory when storage is null / throwing', () => {
    const s1 = new DailyStreakStore(null);
    s1.complete('2026-06-29');
    expect(s1.load().currentStreak).toBe(1);

    const throwing = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    };
    const s2 = new DailyStreakStore(throwing);
    s2.complete('2026-06-29');
    expect(s2.load().currentStreak).toBe(1);
  });

  it('survives corrupt storage and clears', () => {
    const fake = fakeStorage();
    fake._map.set(DAILY_STREAK_KEY, '{bad json');
    expect(() => new DailyStreakStore(fake).load()).not.toThrow();
    expect(new DailyStreakStore(fake).load()).toEqual(emptyStreak());

    const store = new DailyStreakStore(fake);
    store.complete('2026-06-29');
    store.clear();
    expect(store.load().currentStreak).toBe(0);
  });
});
