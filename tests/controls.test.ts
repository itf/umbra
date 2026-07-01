/**
 * Canonical controls list — the single source of truth consumed by the in-game
 * ?/H help (speakControls) and the tutorial recap. Locks down that every expected
 * control is present and that the rendered spoken string mentions each key, so a
 * help/tutorial regression (or a drift between them) fails CI.
 */
import { describe, it, expect } from 'vitest';
import { CONTROLS, renderControlsSpeech } from '../src/game/controls';

describe('CONTROLS canonical list', () => {
  it('includes every expected control', () => {
    const keys = CONTROLS.map((c) => c.keys);
    expect(keys).toEqual([
      'Arrow keys, or Q and E',
      'A and D',
      'W',
      'Echo button, or the Down arrow',
      'T',
      'S',
      'G',
      'question mark or H',
    ]);
  });

  it('every control has a non-empty keys and action', () => {
    for (const c of CONTROLS) {
      expect(c.keys.length).toBeGreaterThan(0);
      expect(c.action.length).toBeGreaterThan(0);
    }
  });
});

describe('renderControlsSpeech', () => {
  const speech = renderControlsSpeech();

  it('starts with the Controls: preamble', () => {
    expect(speech.startsWith('Controls: ')).toBe(true);
  });

  it('mentions each control key', () => {
    for (const c of CONTROLS) {
      expect(speech).toContain(c.keys);
    }
  });

  it('mentions the core verbs an eyes-free player needs', () => {
    expect(speech.toLowerCase()).toMatch(/turn/);
    expect(speech.toLowerCase()).toMatch(/step/);
    expect(speech.toLowerCase()).toMatch(/decoy/);
    expect(speech.toLowerCase()).toMatch(/settings/);
  });
});
