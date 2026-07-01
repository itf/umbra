/**
 * PURE: given the selection that launched the level the player just finished, work
 * out what "Repeat", "Next", and "Harder" should load next. The victory menu shows
 * these four choices (plus Explore/Level-select, which don't need a selection).
 *
 * All functions are pure — no DOM, no history, no generator side-effects — so the
 * "what plays next" mapping is unit-testable in isolation. The host (main.ts) turns
 * the returned PickerSelection back into a Level via the existing resolveSelection
 * path, exactly as if the player had picked it from the picker.
 *
 * Sandbox runs have a real difficulty knob, so Next = a fresh seed at the same
 * difficulty and Harder = the same seed one step harder (capped at 5). Builtins have
 * no difficulty, so Next = the next builtin in the picker's ordered list (wrapping),
 * and Harder = the sandbox equivalent of that builtin's mode, one step above medium.
 */

import { DIFFICULTIES, type Difficulty, type SandboxMode } from './sandbox';
import type { PickerSelection } from '../ui/levelPicker';
import { sandboxSelectionFor } from '../ui/levelPicker';
import type { BuiltinInfo } from '../level/builtins';

/** The picker categories that map 1:1 onto a sandbox mode (for a builtin's "Harder"). */
const CATEGORY_TO_SANDBOX_MODE: Partial<Record<string, SandboxMode>> = {
  beacon: 'beacon',
  absorber: 'absorber',
  sonar: 'sonar',
  stealth: 'stealth',
};

/** Clamp a difficulty step into the valid 1..5 band. */
function clampDifficulty(d: number): Difficulty {
  const lo = DIFFICULTIES[0];
  const hi = DIFFICULTIES[DIFFICULTIES.length - 1];
  return Math.min(hi, Math.max(lo, d)) as Difficulty;
}

/** "Repeat": the exact same level again (byte-identical for sandbox seeds). */
export function repeatSelection(sel: PickerSelection): PickerSelection {
  return sel;
}

/**
 * "Harder": one difficulty step up.
 * - sandbox → same mode + seed, difficulty+1 (capped at 5). Null if already at max.
 * - builtin whose category is a sandbox mode → that mode's sandbox at d4 (a clear
 *   step up from a hand-authored intro), seeded from the builtin id so it's stable.
 * - anything else (saved level, showcase builtin) → null (no meaningful "harder").
 */
export function harderSelection(
  sel: PickerSelection,
  builtins: BuiltinInfo[],
): PickerSelection | null {
  if (sel.source === 'generated' && sel.sandbox) {
    const { mode, difficulty, seed } = sel.sandbox;
    if (difficulty >= DIFFICULTIES[DIFFICULTIES.length - 1]) return null;
    return sandboxSelectionFor(mode, clampDifficulty(difficulty + 1), seed);
  }
  if (sel.source === 'builtin') {
    const info = builtins.find((b) => b.id === sel.ref);
    const mode = info && CATEGORY_TO_SANDBOX_MODE[info.category];
    if (!mode) return null;
    // Seed from the builtin id so "Harder" off the same intro is repeatable.
    const seed = hashSeed(sel.ref);
    return sandboxSelectionFor(mode, clampDifficulty(4), seed);
  }
  return null;
}

/**
 * "Next": move on without repeating.
 * - sandbox → a fresh seed at the same mode + difficulty (derived from the old seed
 *   so it's deterministic and visibly different — no clock needed).
 * - builtin → the next builtin in the picker's ordered list, wrapping to the first.
 * - saved level → null (no defined "next" among unordered saved levels).
 */
export function nextSelection(
  sel: PickerSelection,
  builtins: BuiltinInfo[],
): PickerSelection | null {
  if (sel.source === 'generated' && sel.sandbox) {
    const { mode, difficulty, seed } = sel.sandbox;
    return sandboxSelectionFor(mode, difficulty, nextSeed(seed));
  }
  if (sel.source === 'builtin') {
    if (builtins.length === 0) return null;
    const idx = builtins.findIndex((b) => b.id === sel.ref);
    const next = builtins[(idx + 1 + builtins.length) % builtins.length];
    return { source: 'builtin', ref: next.id, label: next.name };
  }
  return null;
}

/** PURE: derive a visibly-different next seed from the current one (no clock). */
function nextSeed(seed: number): number {
  return (Math.imul(seed >>> 0, 2654435761) ^ 0x9e3779b9) >>> 0;
}

/** PURE: a stable 32-bit seed from a string id (FNV-1a). */
function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
