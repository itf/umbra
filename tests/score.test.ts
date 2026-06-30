/**
 * Scoring + per-level bests: the pure score model (better-score comparison,
 * completion/best phrasing) and the ScoreStore persistence (round-trip, defensive
 * degradation on corrupt JSON, new-best detection, clear).
 */
import { describe, it, expect } from 'vitest';
import {
  betterScore,
  announceCompletion,
  summarizeBest,
  formatDuration,
  toBest,
  type LevelResult,
} from '../src/game/scoreModel';
import { ScoreStore, SCORES_KEY } from '../src/game/scoreStore';

/** Minimal in-memory localStorage stub (mirrors trainerProgress.test.ts). */
function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    _map: map,
  };
}

const result = (over: Partial<LevelResult> = {}): LevelResult => ({
  levelId: 'lvl', timeMs: 42000, clapsUsed: 6, won: true, ...over,
});

describe('betterScore', () => {
  it('any completion beats no prior best', () => {
    expect(betterScore(null, { timeMs: 99000, clapsUsed: 12 })).toBe(true);
  });

  it('lower time (by second) is better', () => {
    expect(betterScore({ timeMs: 50000, clapsUsed: 0 }, { timeMs: 42000, clapsUsed: 9 })).toBe(true);
    expect(betterScore({ timeMs: 42000, clapsUsed: 0 }, { timeMs: 50000, clapsUsed: 0 })).toBe(false);
  });

  it('ignores sub-second jitter (same second is not better on time alone)', () => {
    expect(betterScore({ timeMs: 42000, clapsUsed: 5 }, { timeMs: 42400, clapsUsed: 5 })).toBe(false);
  });

  it('breaks a time tie by fewer claps', () => {
    expect(betterScore({ timeMs: 42000, clapsUsed: 6 }, { timeMs: 42300, clapsUsed: 4 })).toBe(true);
    expect(betterScore({ timeMs: 42000, clapsUsed: 4 }, { timeMs: 42300, clapsUsed: 6 })).toBe(false);
  });
});

describe('announce / format', () => {
  it('phrases durations concisely', () => {
    expect(formatDuration(42000)).toBe('42 seconds');
    expect(formatDuration(1000)).toBe('1 second');
    expect(formatDuration(65000)).toBe('1 minute 5 seconds');
    expect(formatDuration(60000)).toBe('1 minute');
  });

  it('announces a new best with claps', () => {
    expect(announceCompletion(result(), true, null)).toBe('Completed in 42 seconds, 6 claps. New best!');
  });

  it('announces a comparison to the standing best', () => {
    const line = announceCompletion(result({ timeMs: 50000, clapsUsed: 0 }), false, { timeMs: 42000, clapsUsed: 6 });
    expect(line).toBe('Completed in 50 seconds. Your best is 42 seconds.');
  });

  it('summarizeBest is empty for no best', () => {
    expect(summarizeBest(null)).toBe('');
    expect(summarizeBest({ timeMs: 42000, clapsUsed: 0 })).toBe('Best: 42 seconds');
  });
});

describe('ScoreStore persistence', () => {
  it('round-trips a completion and tracks best/completions/last', () => {
    const s = new ScoreStore(fakeStorage());
    expect(s.get('lvl').completions).toBe(0);
    expect(s.best('lvl')).toBeNull();

    const r1 = s.record(result({ timeMs: 50000, clapsUsed: 8 }));
    expect(r1.isBest).toBe(true);
    expect(r1.previousBest).toBeNull();

    const r2 = s.record(result({ timeMs: 42000, clapsUsed: 6 }));
    expect(r2.isBest).toBe(true);
    expect(r2.previousBest).toEqual({ timeMs: 50000, clapsUsed: 8 });

    const r3 = s.record(result({ timeMs: 55000, clapsUsed: 2 }));
    expect(r3.isBest).toBe(false);

    expect(s.get('lvl').completions).toBe(3);
    expect(s.best('lvl')).toEqual({ timeMs: 42000, clapsUsed: 6 });
    expect(s.get('lvl').last).toEqual(toBest(result({ timeMs: 55000, clapsUsed: 2 })));
  });

  it('does not score a non-won result', () => {
    const s = new ScoreStore(fakeStorage());
    const r = s.record(result({ won: false }));
    expect(r.isBest).toBe(false);
    expect(s.get('lvl').completions).toBe(0);
    expect(s.best('lvl')).toBeNull();
  });

  it('persists across instances via the same storage', () => {
    const storage = fakeStorage();
    new ScoreStore(storage).record(result());
    expect(new ScoreStore(storage).best('lvl')).toEqual({ timeMs: 42000, clapsUsed: 6 });
  });

  it('degrades to no scores on corrupt JSON (never throws)', () => {
    const storage = fakeStorage();
    storage._map.set(SCORES_KEY, '{not valid json');
    const s = new ScoreStore(storage);
    expect(s.load()).toEqual({});
    expect(s.best('lvl')).toBeNull();
    // and a fresh record still works
    expect(s.record(result()).isBest).toBe(true);
  });

  it('sanitizes a malformed best (drops bad fields)', () => {
    const storage = fakeStorage();
    storage._map.set(SCORES_KEY, JSON.stringify({ lvl: { best: { timeMs: 'x', clapsUsed: 6 }, completions: -3 } }));
    const s = new ScoreStore(storage);
    expect(s.best('lvl')).toBeNull(); // bad timeMs → whole best dropped
    expect(s.get('lvl').completions).toBe(0); // negative → clamped
  });

  it('clear wipes all scores', () => {
    const storage = fakeStorage();
    const s = new ScoreStore(storage);
    s.record(result());
    s.clear();
    expect(s.best('lvl')).toBeNull();
    expect(storage._map.has(SCORES_KEY)).toBe(false);
  });
});
