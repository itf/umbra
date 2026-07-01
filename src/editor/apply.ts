/**
 * Pure, DOM-free editor mutation helpers. These take a plain object reference and
 * a (key, value) pair from a properties-panel field and mutate it. Keeping them
 * here (separate from editor.ts, which is all DOM wiring) lets them be unit-tested
 * without a browser, and keeps the apply-logic in one auditable place.
 */
import type { Level, WallObj, WallMotion, WallPatch, MaterialName, AmbientSource } from '../level/schema';
import type { ReactionEvent, ReactionEventType } from '../game/events';
import type { BeaconPreset } from '../game/beaconSounds';

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

/**
 * Build a default absorber WallPatch for a given perimeter face, centred along the
 * wall at a sensible head-ish height. `id`, `wall` and `material` are supplied; the
 * rectangle defaults to a 2 m wide × 1.6 m tall patch starting near the wall's middle,
 * clamped to the face extents so it's always a valid (on-face) patch.
 */
export function defaultAbsorber(
  id: string, wall: WallPatch['wall'], material: MaterialName,
  uMax: number, vMax: number,
): WallPatch {
  const uSize = Math.min(2, uMax);
  const vSize = Math.min(1.6, vMax);
  const u0 = Math.max(0, Math.min(uMax - uSize, uMax / 2 - uSize / 2));
  const v0 = Math.max(0, Math.min(vMax - vSize, 0.8));
  return { id, wall, u0, v0, uSize, vSize, material };
}

/**
 * Edit an absorber patch from a properties-panel field. Handles `wall` (face id),
 * `material`, and the numeric rectangle fields `u0`/`v0`/`uSize`/`vSize`. Sizes are
 * floored at a small positive minimum so a patch never collapses to nothing. Returns
 * true if it handled the key.
 */
export function applyAbsorberProp(p: WallPatch, key: string, raw: string, num: number): boolean {
  if (key === 'wall') {
    if (raw === '-x' || raw === '+x' || raw === '-z' || raw === '+z') p.wall = raw;
    return true;
  }
  if (key === 'material') { p.material = raw as MaterialName; return true; }
  if (key === 'u0' || key === 'v0' || key === 'uSize' || key === 'vSize') {
    if (Number.isNaN(num)) return true;
    if (key === 'uSize' || key === 'vSize') p[key] = Math.max(0.1, num);
    else p[key] = Math.max(0, num);
    return true;
  }
  return false;
}

/** A default ambient source at a map point (continuous hum, full gain). */
export function defaultAmbience(id: string, x: number, z: number): AmbientSource {
  return { id, x, z, sound: 'hum', freq: 220, gain: 1 };
}

/**
 * Edit an ambient source from a properties-panel field. Handles position (x/z),
 * `sound` (preset), `freq`, `gain` (clamped 0..2), and `soundUrl` (empty clears).
 * Returns true if it handled the key.
 */
export function applyAmbienceProp(a: AmbientSource, key: string, raw: string, num: number): boolean {
  if (key === 'sound') { a.sound = raw as BeaconPreset; return true; }
  if (key === 'soundUrl') {
    if (raw === '') delete a.soundUrl; else a.soundUrl = raw;
    return true;
  }
  if (key === 'x' || key === 'z' || key === 'freq' || key === 'gain') {
    if (Number.isNaN(num)) return true;
    if (key === 'gain') a.gain = Math.max(0, Math.min(2, num));
    else a[key] = num;
    return true;
  }
  return false;
}

/** A default reaction event over a named source (a 2.5 s crossing window). */
export function defaultEvent(id: string, sourceId: string, start = 5): ReactionEvent {
  return { id, type: 'crossing', sourceId, start, end: start + 2.5 };
}

/**
 * Edit a reaction event from a field. Handles `type` ('crossing'|'door'),
 * `sourceId`, and the numeric `start`/`end` window (kept ordered: end > start).
 * Returns true if it handled the key.
 */
export function applyEventProp(e: ReactionEvent, key: string, raw: string, num: number): boolean {
  if (key === 'type') {
    if (raw === 'crossing' || raw === 'occlusion' || raw === 'door') e.type = raw as ReactionEventType;
    return true;
  }
  if (key === 'sourceId') { e.sourceId = raw; return true; }
  if (key === 'start' || key === 'end') {
    if (Number.isNaN(num) || num < 0) return true;
    e[key] = num;
    if (e.end <= e.start) e.end = e.start + 0.5; // keep a positive window
    return true;
  }
  return false;
}

/**
 * Non-blocking save-time lint: return human-readable WARNINGS (not errors) about a
 * level that's probably mis-authored. Surfaced via the editor's status/hint channel.
 * Pure + DOM-free so it's unit-testable.
 */
export function lintLevel(level: Level): string[] {
  const warnings: string[] = [];
  const { width, depth } = level.room;
  if (level.goal === 'absorber' && (level.absorbers?.length ?? 0) === 0) {
    warnings.push('Goal is "absorber" but the level has no absorber patches.');
  }
  if ((level.goal ?? 'beacon') === 'beacon' && level.beacons.length === 0 && !level.winPoint) {
    warnings.push('No beacons and no win area — set a win point (or add a beacon) so the level is winnable.');
  }
  // Reaction events must name an existing ambient source.
  const ambIds = new Set((level.ambience ?? []).map((a) => a.id));
  for (const e of level.events ?? []) {
    if (!ambIds.has(e.sourceId)) {
      warnings.push(`Event "${e.id}" targets ambient source "${e.sourceId}" which doesn't exist.`);
    }
    if (e.end <= e.start) warnings.push(`Event "${e.id}" has a non-positive active window.`);
  }
  if ((level.requiredReactions ?? 0) > (level.events?.length ?? 0)) {
    warnings.push('requiredReactions is larger than the number of events — the level can never be won.');
  }
  // Sequence (trail) mode needs 2+ beacons that all exist; ids must resolve.
  if (level.sequence && level.sequence.length > 0) {
    if (level.sequence.length < 2) {
      warnings.push('Sequence (trail) mode needs at least 2 beacons to chain.');
    }
    const beaconIds = new Set(level.beacons.map((b) => b.id));
    for (const id of level.sequence) {
      if (!beaconIds.has(id)) warnings.push(`Sequence references beacon "${id}" which doesn't exist.`);
    }
  }
  if (level.goal === 'escape') {
    if (!level.exit) {
      warnings.push('Goal is "escape" but the level has no exit. Place an exit with the Exit tool.');
    } else if (!level.open && (level.exit.x < 0 || level.exit.x > width || level.exit.z < 0 || level.exit.z > depth)) {
      warnings.push('Exit position is outside the room.');
    }
    if (level.monsters.length === 0) {
      warnings.push('Goal is "escape" but the level has no monsters to evade.');
    }
  }
  if (!level.open) {
    const { x, z } = level.start;
    if (x < 0 || x > width || z < 0 || z > depth) {
      warnings.push('Start position is outside the room.');
    }
  }
  return warnings;
}
