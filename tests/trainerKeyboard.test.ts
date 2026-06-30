/**
 * The trainer's keyboard scheme is the eyes-free entry point, so its key→action
 * mapping is a PURE function we can assert without a DOM: A/D play rooms, Q/E move
 * between answers, Enter/Space confirm. The D=play-Room-B key must be inert when
 * the current question has no Room B (mirrors the show-Room-B-only-when-sceneB bug
 * fix), so a single-scene exercise can't trigger a dead playback.
 */
import { describe, it, expect } from 'vitest';
import { trainerKeyAction } from '../src/trainer/trainer';

describe('trainerKeyAction', () => {
  it('maps the play/select/confirm keys (A/B present)', () => {
    expect(trainerKeyAction('a', true)).toBe('playA');
    expect(trainerKeyAction('d', true)).toBe('playB');
    expect(trainerKeyAction('q', true)).toBe('prev');
    expect(trainerKeyAction('e', true)).toBe('next');
    expect(trainerKeyAction('Enter', true)).toBe('confirm');
    expect(trainerKeyAction(' ', true)).toBe('confirm');
  });

  it('is case-insensitive', () => {
    expect(trainerKeyAction('A', true)).toBe('playA');
    expect(trainerKeyAction('D', true)).toBe('playB');
    expect(trainerKeyAction('Q', true)).toBe('prev');
    expect(trainerKeyAction('E', true)).toBe('next');
  });

  it('D (play Room B) is inert when there is no Room B', () => {
    expect(trainerKeyAction('d', false)).toBeNull();
    expect(trainerKeyAction('D', false)).toBeNull();
    // A (the single "play" affordance) still works without a Room B.
    expect(trainerKeyAction('a', false)).toBe('playA');
  });

  it('returns null for unmapped keys', () => {
    for (const k of ['w', 's', 'z', 'Tab', 'Escape', 'ArrowUp', '1']) {
      expect(trainerKeyAction(k, true)).toBeNull();
    }
  });
});
