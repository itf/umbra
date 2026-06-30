/**
 * Reaction-event timing + signal-detection scorer (PURE — src/game/events.ts).
 */
import { describe, it, expect } from 'vitest';
import {
  activeEvents, isAnyActive, ReactionScorer, type ReactionEvent,
} from '../src/game/events';

const EV = (id: string, start: number, end: number): ReactionEvent => ({
  id, type: 'crossing', sourceId: 'fountain', start, end,
});

describe('activeEvents / isAnyActive', () => {
  const evs = [EV('a', 2, 4), EV('b', 5, 7)];
  it('is active on [start, end) only', () => {
    expect(activeEvents(evs, 1.9)).toHaveLength(0);
    expect(activeEvents(evs, 2).map((e) => e.id)).toEqual(['a']);
    expect(activeEvents(evs, 3.9).map((e) => e.id)).toEqual(['a']);
    expect(activeEvents(evs, 4)).toHaveLength(0); // end is exclusive
    expect(activeEvents(evs, 6).map((e) => e.id)).toEqual(['b']);
  });
  it('isAnyActive mirrors activeEvents', () => {
    expect(isAnyActive(evs, 3)).toBe(true);
    expect(isAnyActive(evs, 4.5)).toBe(false);
  });
  it('overlapping events both report active', () => {
    const o = [EV('a', 1, 5), EV('b', 3, 6)];
    expect(activeEvents(o, 4).map((e) => e.id).sort()).toEqual(['a', 'b']);
  });
});

describe('ReactionScorer', () => {
  it('a press inside the window is a HIT (one per event)', () => {
    const s = new ReactionScorer([EV('a', 2, 4)]);
    expect(s.press(3)).toBe('hit');
    expect(s.press(3.5)).toBe('ignored'); // second press, same active event
    s.advance(5);
    expect(s.score()).toEqual({ hits: 1, misses: 0, falseAlarms: 0 });
  });

  it('a press with no active event is a FALSE ALARM', () => {
    const s = new ReactionScorer([EV('a', 2, 4)]);
    expect(s.press(1)).toBe('false-alarm');
    s.advance(5);
    expect(s.score()).toEqual({ hits: 0, misses: 1, falseAlarms: 1 });
  });

  it('an un-pressed event finalizes as a MISS when its window passes', () => {
    const s = new ReactionScorer([EV('a', 2, 4), EV('b', 5, 7)]);
    s.advance(4.5); // a's window passed, b still pending
    expect(s.score()).toEqual({ hits: 0, misses: 1, falseAlarms: 0 });
    s.press(6); // hit b
    s.advance(8);
    expect(s.score()).toEqual({ hits: 1, misses: 1, falseAlarms: 0 });
  });

  it('miss fires exactly once even with repeated advances', () => {
    const s = new ReactionScorer([EV('a', 1, 2)]);
    s.advance(3); s.advance(4); s.advance(5);
    expect(s.score().misses).toBe(1);
  });

  it('a hit on the first of two overlapping active events does not false-alarm the rest', () => {
    const s = new ReactionScorer([EV('a', 1, 5), EV('b', 2, 6)]);
    expect(s.press(3)).toBe('hit');  // credits the earlier-ending one
    expect(s.press(3.1)).toBe('hit'); // credits the other still-active, un-hit one
    expect(s.press(3.2)).toBe('ignored'); // both hit now
    s.advance(7);
    expect(s.score()).toEqual({ hits: 2, misses: 0, falseAlarms: 0 });
  });

  it('a sequence of door open/close events scores independently', () => {
    const s = new ReactionScorer([EV('d1', 1, 3), EV('d2', 5, 7), EV('d3', 9, 11)]);
    s.press(2);  // hit d1
    s.advance(8); // d2 missed (no press)
    s.press(10); // hit d3
    s.advance(12);
    expect(s.score()).toEqual({ hits: 2, misses: 1, falseAlarms: 0 });
    expect(s.total()).toBe(3);
  });

  it('advance is monotonic — a stale earlier t is ignored', () => {
    const s = new ReactionScorer([EV('a', 1, 2)]);
    s.advance(5);
    s.advance(1.5); // earlier — must not "un-miss"
    expect(s.score().misses).toBe(1);
  });
});
