/**
 * Pure, DOM-free editor mutation helpers. These take a plain object reference and
 * a (key, value) pair from a properties-panel field and mutate it. Keeping them
 * here (separate from editor.ts, which is all DOM wiring) lets them be unit-tested
 * without a browser, and keeps the apply-logic in one auditable place.
 */
import type { WallObj, WallMotion } from '../level/schema';

/** Default motion params seeded when a kind is first chosen in the editor. */
export const DEFAULT_TRANSLATE: Extract<WallMotion, { kind: 'translate' }> = {
  kind: 'translate', dx: 2, dz: 0, period: 4,
};
export const DEFAULT_SLIDE: Extract<WallMotion, { kind: 'slide' }> = {
  kind: 'slide', openFraction: 1, period: 4,
};

/**
 * Edit a wall's optional `motion` spec from a properties-panel field.
 *
 * - `motionKind` = 'none'      → removes `motion` (static wall again).
 * - `motionKind` = 'translate' → seeds a default ping-pong translate.
 * - `motionKind` = 'slide'     → seeds a default sliding door.
 * - `motionDx`/`motionDz`/`motionPeriod`/`motionOpen` → tweak the active spec
 *   (ignored if they don't match the current kind, or aren't a finite number).
 *
 * Returns true if it handled the key, so callers can `return` early.
 */
export function applyWallMotion(w: WallObj, key: string, raw: string, num: number): boolean {
  if (key === 'motionKind') {
    if (raw === 'none') { delete w.motion; return true; }
    if (raw === 'translate') { w.motion = { ...DEFAULT_TRANSLATE }; return true; }
    if (raw === 'slide') { w.motion = { ...DEFAULT_SLIDE }; return true; }
    return true;
  }
  if (!key.startsWith('motion')) return false;
  if (!w.motion || Number.isNaN(num)) return true;
  const m: WallMotion = w.motion;
  if (key === 'motionPeriod' && num > 0) m.period = num;
  else if (m.kind === 'translate' && key === 'motionDx') m.dx = num;
  else if (m.kind === 'translate' && key === 'motionDz') m.dz = num;
  else if (m.kind === 'slide' && key === 'motionOpen') m.openFraction = clamp01(num);
  return true;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
