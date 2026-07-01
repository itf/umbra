import { describe, it, expect } from 'vitest';
import { repeatSelection, nextSelection, harderSelection } from '../src/game/nextRun';
import type { PickerSelection } from '../src/ui/levelPicker';
import type { BuiltinInfo } from '../src/level/builtins';

// A small ordered builtin list spanning the categories that matter to nextRun:
// two beacon levels (so "next" ordering + wrap is observable), one showcase (no
// sandbox mode ⇒ no "harder"), and one sonar.
const BUILTINS: BuiltinInfo[] = [
  { id: 'tour-1', name: 'Tour 1', description: '', category: 'showcase' },
  { id: 'beacon-a', name: 'Beacon A', description: '', category: 'beacon' },
  { id: 'beacon-b', name: 'Beacon B', description: '', category: 'beacon' },
  { id: 'sonar-a', name: 'Sonar A', description: '', category: 'sonar' },
];

const sandboxSel = (
  mode: 'beacon' | 'absorber' | 'sonar' | 'stealth',
  difficulty: 1 | 2 | 3 | 4 | 5,
  seed: number,
): PickerSelection => ({
  source: 'generated',
  ref: `${mode}:${difficulty}:${seed}`,
  label: `Sandbox ${mode} (d${difficulty})`,
  sandbox: { mode, difficulty, seed },
});

describe('repeatSelection', () => {
  it('returns the same selection (byte-identical for a sandbox seed)', () => {
    const sel = sandboxSel('beacon', 3, 12345);
    expect(repeatSelection(sel)).toEqual(sel);
  });
});

describe('nextSelection — sandbox', () => {
  it('keeps mode + difficulty but changes the seed deterministically', () => {
    const sel = sandboxSel('sonar', 4, 999);
    const next = nextSelection(sel, BUILTINS);
    expect(next).not.toBeNull();
    expect(next!.sandbox!.mode).toBe('sonar');
    expect(next!.sandbox!.difficulty).toBe(4);
    expect(next!.sandbox!.seed).not.toBe(999);
    // Deterministic: same input → same next seed (no clock).
    expect(nextSelection(sel, BUILTINS)!.sandbox!.seed).toBe(next!.sandbox!.seed);
  });
});

describe('nextSelection — builtin', () => {
  it('advances to the next builtin in list order', () => {
    const sel: PickerSelection = { source: 'builtin', ref: 'beacon-a', label: 'Beacon A' };
    expect(nextSelection(sel, BUILTINS)!.ref).toBe('beacon-b');
  });
  it('wraps from the last builtin to the first', () => {
    const sel: PickerSelection = { source: 'builtin', ref: 'sonar-a', label: 'Sonar A' };
    expect(nextSelection(sel, BUILTINS)!.ref).toBe('tour-1');
  });
});

describe('nextSelection — saved', () => {
  it('has no defined next (returns null)', () => {
    const sel: PickerSelection = { source: 'saved', ref: 'My level', label: 'My level' };
    expect(nextSelection(sel, BUILTINS)).toBeNull();
  });
});

describe('harderSelection — sandbox', () => {
  it('bumps difficulty by one, same mode + seed', () => {
    const sel = sandboxSel('beacon', 2, 77);
    const harder = harderSelection(sel, BUILTINS);
    expect(harder!.sandbox).toMatchObject({ mode: 'beacon', difficulty: 3, seed: 77 });
  });
  it('returns null at max difficulty (nothing harder)', () => {
    expect(harderSelection(sandboxSel('beacon', 5, 1), BUILTINS)).toBeNull();
  });
});

describe('harderSelection — builtin', () => {
  it('maps a mode-category builtin to its sandbox equivalent, stably seeded', () => {
    const sel: PickerSelection = { source: 'builtin', ref: 'beacon-a', label: 'Beacon A' };
    const h1 = harderSelection(sel, BUILTINS);
    expect(h1!.sandbox!.mode).toBe('beacon');
    expect(h1!.sandbox!.difficulty).toBe(4);
    // Stable: same builtin id → same seed each time.
    const h2 = harderSelection(sel, BUILTINS);
    expect(h2!.sandbox!.seed).toBe(h1!.sandbox!.seed);
  });
  it('has no harder version for a showcase builtin (no sandbox mode)', () => {
    const sel: PickerSelection = { source: 'builtin', ref: 'tour-1', label: 'Tour 1' };
    expect(harderSelection(sel, BUILTINS)).toBeNull();
  });
});
