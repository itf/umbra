/**
 * Pure, DOM-free helpers for the editor's selection UX:
 *  - `kindLabel` maps an object KIND to a human heading ("Floor zone", …);
 *  - `objectListModel` flattens a Level into a flat, ordered list of selectable
 *    entries `{ id, kind, label }` for the "Objects" outline panel.
 *
 * Keeping these here (no DOM) lets them be unit-tested, mirroring apply.ts.
 */
import type { Level } from '../level/schema';

/** The selectable object kinds in the editor. */
export type SelKind = 'start' | 'beacon' | 'wall' | 'floor' | 'ceiling' | 'monster' | 'absorber' | 'exit';

/** Human-readable heading for a selected object's kind. */
export function kindLabel(kind: SelKind): string {
  switch (kind) {
    case 'start': return 'Start point';
    case 'beacon': return 'Beacon';
    case 'wall': return 'Wall';
    case 'floor': return 'Floor zone';
    case 'ceiling': return 'Ceiling zone';
    case 'monster': return 'Monster';
    case 'absorber': return 'Absorber patch';
    case 'exit': return 'Escape exit';
  }
}

/** One entry in the scene object list: an id to select, its kind, and a label. */
export interface ObjectListEntry {
  id: string;
  kind: SelKind;
  label: string;
}

/**
 * Flatten a Level into an ordered list of every selectable object. The Start point
 * comes first (always exactly one), then beacons, walls, floors, ceilings, monsters,
 * and absorber patches — each labelled by kind + id (zones also show their material).
 *
 * The FIRST beacon is the navigation goal per the schema; it gets a "(goal)" badge in
 * its label when the level is in beacon-goal mode, and absorber patches show "(goal)"
 * on the first one in absorber-goal mode, so authors aren't confused by multiple
 * beacons / patches.
 */
export function objectListModel(level: Level): ObjectListEntry[] {
  const out: ObjectListEntry[] = [];
  out.push({ id: 'start', kind: 'start', label: 'Start' });
  const beaconGoal = (level.goal ?? 'beacon') === 'beacon';
  level.beacons.forEach((b, i) =>
    out.push({ id: b.id, kind: 'beacon',
      label: `Beacon ${b.id}${beaconGoal && i === 0 ? ' (goal)' : ''}` }));
  for (const w of level.walls) out.push({ id: w.id, kind: 'wall', label: `Wall ${w.id}` });
  for (const f of level.floors) out.push({ id: f.id, kind: 'floor', label: `Floor ${f.id} (${f.material})` });
  for (const c of level.ceilings) out.push({ id: c.id, kind: 'ceiling', label: `Ceiling ${c.id} (${c.material})` });
  const escape = level.goal === 'escape';
  for (const m of level.monsters) {
    out.push({ id: m.id, kind: 'monster',
      label: `Monster ${m.id} (${m.sound})${escape ? ' — evade' : ''}` });
  }
  if (level.exit) {
    out.push({ id: '__exit', kind: 'exit',
      label: `Exit (${level.exit.x}, ${level.exit.z})${escape ? ' (goal)' : ''}` });
  }
  (level.absorbers ?? []).forEach((p, i) =>
    out.push({ id: p.id, kind: 'absorber',
      label: `Absorber ${p.id} (${p.wall}, ${p.material})${level.goal === 'absorber' && i === 0 ? ' (goal)' : ''}` }));
  return out;
}
