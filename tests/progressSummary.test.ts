/**
 * Progress summary (the "Best Times / Progress" model): cleared counts,
 * per-mode grouping, the empty state, best-time formatting, fastest-level pick,
 * streak inclusion, and the spoken overview. Pure — no DOM, no storage.
 */
import { describe, it, expect } from 'vitest';
import {
  buildProgressSummary,
  announceProgress,
  streakPhrase,
  type LevelInfo,
  type StreakInfo,
} from '../src/game/progressSummary';
import type { LevelBest } from '../src/game/scoreModel';

const levels: LevelInfo[] = [
  { name: 'Beacon Meadow', category: 'beacon' },
  { name: 'Beacon Hall', category: 'beacon' },
  { name: 'Dead Spot', category: 'absorber' },
  { name: 'Vault', category: 'sonar' },
  { name: 'The Hunt', category: 'stealth' },
  { name: 'Tour Start', category: 'showcase' },
];

const noStreak: StreakInfo = { currentStreak: 0, longestStreak: 0, totalDays: 0 };

function bestMap(m: Record<string, LevelBest>) {
  return (name: string): LevelBest | null => m[name] ?? null;
}

describe('buildProgressSummary', () => {
  it('counts cleared levels out of the total', () => {
    const s = buildProgressSummary(
      levels,
      bestMap({
        'Beacon Meadow': { timeMs: 38_000, clapsUsed: 0 },
        Vault: { timeMs: 55_000, clapsUsed: 6 },
      }),
      noStreak,
    );
    expect(s.totalLevels).toBe(6);
    expect(s.totalCleared).toBe(2);
  });

  it('groups levels by mode in display order with per-group tallies', () => {
    const s = buildProgressSummary(levels, bestMap({ 'Beacon Meadow': { timeMs: 38_000, clapsUsed: 0 } }), noStreak);
    expect(s.groups.map((g) => g.category)).toEqual(['showcase', 'beacon', 'absorber', 'sonar', 'stealth']);
    const beacon = s.groups.find((g) => g.category === 'beacon')!;
    expect(beacon.total).toBe(2);
    expect(beacon.cleared).toBe(1);
    expect(beacon.rows.map((r) => r.name)).toEqual(['Beacon Meadow', 'Beacon Hall']);
  });

  it('marks uncleared levels and formats best times for cleared ones', () => {
    const s = buildProgressSummary(levels, bestMap({ 'Beacon Meadow': { timeMs: 38_000, clapsUsed: 4 } }), noStreak);
    const beacon = s.groups.find((g) => g.category === 'beacon')!;
    expect(beacon.rows[0]).toMatchObject({ cleared: true, bestText: 'Best: 38 seconds, 4 claps' });
    expect(beacon.rows[1]).toMatchObject({ cleared: false, bestText: 'Not yet cleared' });
  });

  it('empty state: nothing cleared, no fastest', () => {
    const s = buildProgressSummary(levels, bestMap({}), noStreak);
    expect(s.totalCleared).toBe(0);
    expect(s.fastest).toBeNull();
    expect(announceProgress(s)).toBe('0 of 6 levels cleared. No daily challenge completed yet.');
  });

  it('picks the single fastest cleared level across all modes', () => {
    const s = buildProgressSummary(
      levels,
      bestMap({
        'Beacon Meadow': { timeMs: 38_000, clapsUsed: 0 },
        Vault: { timeMs: 20_000, clapsUsed: 6 },
        'Dead Spot': { timeMs: 90_000, clapsUsed: 0 },
      }),
      noStreak,
    );
    expect(s.fastest).toEqual({ name: 'Vault', best: { timeMs: 20_000, clapsUsed: 6 } });
  });

  it('omits empty categories (no levels in that mode)', () => {
    const only: LevelInfo[] = [{ name: 'A', category: 'beacon' }];
    const s = buildProgressSummary(only, bestMap({}), noStreak);
    expect(s.groups.map((g) => g.category)).toEqual(['beacon']);
  });

  it('includes the streak in the structured summary', () => {
    const streak: StreakInfo = { currentStreak: 5, longestStreak: 8, totalDays: 30 };
    const s = buildProgressSummary(levels, bestMap({}), streak);
    expect(s.streak).toEqual(streak);
  });
});

describe('streakPhrase', () => {
  it('reports the empty state', () => {
    expect(streakPhrase(noStreak)).toBe('No daily challenge completed yet.');
  });
  it('pluralises days and reports current/longest/total', () => {
    expect(streakPhrase({ currentStreak: 1, longestStreak: 1, totalDays: 1 })).toBe(
      'Daily streak: 1 day; longest 1 day; 1 day total.',
    );
    expect(streakPhrase({ currentStreak: 5, longestStreak: 8, totalDays: 30 })).toBe(
      'Daily streak: 5 days; longest 8 days; 30 days total.',
    );
  });
});

describe('announceProgress', () => {
  it('announces cleared count, streak, and fastest level', () => {
    const s = buildProgressSummary(
      levels,
      bestMap({ 'Beacon Meadow': { timeMs: 38_000, clapsUsed: 0 } }),
      { currentStreak: 5, longestStreak: 8, totalDays: 30 },
    );
    expect(announceProgress(s)).toBe(
      '1 of 6 levels cleared. Daily streak: 5 days; longest 8 days; 30 days total. Fastest: Beacon Meadow, 38 seconds.',
    );
  });
});
