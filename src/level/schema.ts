/**
 * Level schema — the shared data model produced by the editor and consumed by the
 * game. Everything lives on the top-down x/z plane (y is height; the editor works
 * in 2D and uses sensible default heights).
 *
 * Coordinates are in metres. The level defines a rectangular room footprint; the
 * editor places objects within it. Walls beyond the room boundary, interior
 * obstacles, floor material zones, beacons, the start point, and (place-only for
 * now) monsters are all listed here.
 */

import type { MATERIALS } from '../engine/acoustics/materials';

export type MaterialName = keyof typeof MATERIALS;

/** Editor object kinds placeable on the map. */
export type ObjectKind = 'start' | 'beacon' | 'wall' | 'floor' | 'monster';

export interface Vec2 {
  x: number;
  z: number;
}

/** Player start: position + facing (yaw radians, 0 = -z / "north"). */
export interface StartPoint {
  x: number;
  z: number;
  yaw: number;
}

/** A goal beacon to navigate toward. */
export interface BeaconObj {
  id: string;
  x: number;
  z: number;
  freq: number;
  /** Win radius in metres. */
  goalRadius: number;
}

/**
 * An interior wall segment (a low, full-height barrier) on the x/z plane, given
 * as a line from a→b with a material. The game extrudes it to room height.
 */
export interface WallObj {
  id: string;
  ax: number;
  az: number;
  bx: number;
  bz: number;
  material: MaterialName;
}

/**
 * A rectangular floor zone with a material — lets a level have, e.g., a carpeted
 * patch on a concrete floor (affects the acoustics underfoot).
 */
export interface FloorZone {
  id: string;
  x: number; // top-left corner (min x)
  z: number; // top-left corner (min z)
  w: number;
  d: number;
  material: MaterialName;
}

/**
 * A ceiling zone: over the rectangle [x,z, w×d], the ceiling is at `height` with
 * `material`. Lets a level have a low-ceilinged alcove inside a tall hall, etc.
 * Outside every zone, the room's default ceiling (room.height / roomMaterial)
 * applies — unless the level has no ceiling at all (open space).
 */
export interface CeilingZone {
  id: string;
  x: number;
  z: number;
  w: number;
  d: number;
  height: number;
  material: MaterialName;
}

/**
 * A monster placement. PLACE-ONLY for now: saved in the level with its props, but
 * the game does not yet run chase AI. The fields anticipate that future feature.
 */
export interface MonsterObj {
  id: string;
  x: number;
  z: number;
  /** Intended movement speed (m/s) once AI exists. */
  speed: number;
  /** A short label / sound id for the monster's noise. */
  sound: string;
}

export interface Level {
  /** Schema version for forward-compat. */
  version: 1;
  name: string;
  /**
   * When true, there is NO enclosing room — an open space (a street, a field).
   * Only the free-standing walls/buildings you place reflect sound; there's no
   * perimeter, ceiling, or floor box. The `room` width/depth then just bound the
   * editor canvas; `height` is the height of free-standing walls.
   */
  open: boolean;
  /** Room footprint (the bounding box). Height is the wall height in metres. */
  room: { width: number; depth: number; height: number };
  /** Default material for the room's perimeter walls + floor. */
  roomMaterial: MaterialName;
  floorMaterial: MaterialName;
  /**
   * Whether the level has a ceiling at all. Open/outdoor levels set this false
   * (sky — no overhead reflection). Defaults true for enclosed rooms.
   */
  hasCeiling: boolean;
  /** Default ceiling material (when there IS a ceiling). */
  ceilingMaterial: MaterialName;

  start: StartPoint;
  beacons: BeaconObj[];
  walls: WallObj[];
  floors: FloorZone[];
  ceilings: CeilingZone[];
  monsters: MonsterObj[];
}

/** A blank level with sane defaults — the editor's "New level". */
export function emptyLevel(name = 'Untitled'): Level {
  return {
    version: 1,
    name,
    open: false,
    room: { width: 12, depth: 16, height: 3 },
    roomMaterial: 'concrete',
    floorMaterial: 'concrete',
    hasCeiling: true,
    ceilingMaterial: 'concrete',
    start: { x: 6, z: 14, yaw: 0 },
    beacons: [{ id: 'beacon-1', x: 6, z: 2, freq: 440, goalRadius: 0.8 }],
    walls: [],
    floors: [],
    ceilings: [],
    monsters: [],
  };
}

/** Lightweight runtime validation of a parsed level (for JSON import). */
export function isLevel(v: unknown): v is Level {
  if (!v || typeof v !== 'object') return false;
  const l = v as Partial<Level>;
  // Back-compat: fill fields added after early levels were saved.
  if (typeof l.open !== 'boolean') l.open = false;
  if (typeof l.hasCeiling !== 'boolean') l.hasCeiling = !l.open;
  if (typeof l.ceilingMaterial !== 'string') l.ceilingMaterial = l.roomMaterial ?? 'concrete';
  if (!Array.isArray(l.ceilings)) l.ceilings = [];
  return (
    l.version === 1 &&
    typeof l.name === 'string' &&
    !!l.room &&
    !!l.start &&
    Array.isArray(l.beacons) &&
    Array.isArray(l.walls) &&
    Array.isArray(l.floors) &&
    Array.isArray(l.monsters)
  );
}
