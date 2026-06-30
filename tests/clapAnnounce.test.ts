/**
 * Spoken clap-budget feedback — pure text logic. Locks down the exact eyes-free
 * wording for each budget state so an accessibility regression fails CI.
 */
import { describe, it, expect } from 'vitest';
import {
  remainingPhrase,
  clapFiredAnnouncement,
  clapRefusedAnnouncement,
  budgetIntroAnnouncement,
} from '../src/game/clapAnnounce';

describe('remainingPhrase', () => {
  it('pluralises correctly', () => {
    expect(remainingPhrase(3)).toBe('3 claps left');
    expect(remainingPhrase(1)).toBe('1 clap left');
    expect(remainingPhrase(0)).toBe('0 claps left');
  });
  it('is empty for unlimited (Infinity)', () => {
    expect(remainingPhrase(Infinity)).toBe('');
  });
});

describe('clapFiredAnnouncement', () => {
  it('says nothing budget-related for unlimited levels', () => {
    expect(clapFiredAnnouncement(Infinity, false)).toBe('');
  });
  it('announces a plain count when several remain', () => {
    expect(clapFiredAnnouncement(3, true)).toBe('3 claps left.');
  });
  it('warns on the second-to-last clap (one remaining)', () => {
    expect(clapFiredAnnouncement(1, true)).toBe('One clap left. Make it count.');
  });
  it('announces the soft out-of-sonar state at zero (no game-over)', () => {
    const msg = clapFiredAnnouncement(0, true);
    expect(msg).toContain('last clap');
    expect(msg).toContain('memory');
  });
});

describe('clapRefusedAnnouncement', () => {
  it('speaks the exhausted state distinctly', () => {
    expect(clapRefusedAnnouncement('exhausted')).toBe('No claps left. Navigate from memory.');
  });
  it('speaks the cooldown with a rounded-up wait', () => {
    expect(clapRefusedAnnouncement('cooling', 1200)).toBe('Still echoing — wait 2s.');
    expect(clapRefusedAnnouncement('cooling', 50)).toBe('Still echoing — wait 1s.');
  });
});

describe('budgetIntroAnnouncement', () => {
  it('opens with the starting budget', () => {
    expect(budgetIntroAnnouncement(6)).toBe('Sonar budget: 6 claps left. Clap deliberately.');
  });
});
