/**
 * Level picker PURE helpers: the model merge + the sandbox selection mapping.
 * (The DOM wiring `renderSandboxSection` is thin and covered by e2e; the
 * selection-building logic is extracted to `sandboxSelection` so it's unit-
 * testable here without a DOM.)
 */
import { describe, it, expect } from 'vitest';
import {
  buildPickerModel,
  sandboxSelection,
  spreadSeed,
  SANDBOX_MODE_LABELS,
} from '../src/ui/levelPicker';
import { generateLevel } from '../src/game/sandbox';

describe('buildPickerModel', () => {
  it('lists builtins then saved, with stable keys', () => {
    const model = buildPickerModel(
      [{ id: 'a', name: 'A', description: 'da', category: 'beacon' }],
      ['mine'],
    );
    expect(model[0]).toMatchObject({ key: 'builtin:a', source: 'builtin', ref: 'a' });
    expect(model[1]).toMatchObject({ key: 'saved:mine', source: 'saved', ref: 'mine' });
  });
});

describe('spreadSeed', () => {
  it('is deterministic and spreads consecutive counters apart', () => {
    expect(spreadSeed(1)).toBe(spreadSeed(1));
    expect(spreadSeed(1)).not.toBe(spreadSeed(2));
  });
});

describe('sandboxSelection', () => {
  it('builds a source:generated selection carrying the inputs', () => {
    const sel = sandboxSelection('sonar', 4, 1);
    expect(sel.source).toBe('generated');
    expect(sel.sandbox).toMatchObject({ mode: 'sonar', difficulty: 4 });
    expect(sel.sandbox!.seed).toBe(spreadSeed(1));
  });

  it('advancing the counter ("Another") yields a different seed', () => {
    expect(sandboxSelection('beacon', 3, 1).sandbox!.seed).not.toBe(
      sandboxSelection('beacon', 3, 2).sandbox!.seed,
    );
  });

  it('its selection drives a generated level deterministically end-to-end', () => {
    const sel = sandboxSelection('beacon', 3, 5);
    const a = generateLevel(sel.sandbox!);
    const b = generateLevel(sel.sandbox!);
    expect(b).toEqual(a);
    expect(a.goal).toBe('beacon');
  });

  it('exposes a label for every mode', () => {
    for (const m of ['beacon', 'absorber', 'sonar', 'stealth'] as const) {
      expect(SANDBOX_MODE_LABELS[m]).toBeTruthy();
    }
  });
});
