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
import type { BeaconPreset } from '../game/beaconSounds';
import { resolveBeaconPreset } from '../game/beaconSounds';

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
  /**
   * Synthesized beacon sound preset. Absent ⇒ the default preset
   * (DEFAULT_BEACON_PRESET = 'musicbox'). See src/game/beaconSounds.ts.
   */
  sound?: BeaconPreset;
  /**
   * Optional custom audio file. If set and it loads, it's looped through the
   * beacon's HRTF source instead of the synth (falling back to `sound`/the default
   * preset if the fetch fails).
   */
  soundUrl?: string;
}

/**
 * Wall motion spec (OPTIONAL — old levels have none and stay static).
 *
 * Two serializable kinds, both periodic and self-contained (no runtime state):
 *
 *  - `translate`: the whole segment slides back and forth (PING-PONG) along the
 *    vector (dx,dz). Phase 0 = rest (no offset); it travels to +(dx,dz) and back
 *    over `period` seconds. A shifting maze wall.
 *  - `slide`: a SLIDING DOOR. Endpoint b retracts toward endpoint a, opening a gap
 *    of up to `openFraction` of the segment's length, then closes again, over
 *    `period` seconds. The door's `a` end is the fixed jamb.
 *
 * Both are pure functions of time, so geometry at any `t` is reproducible and the
 * acoustics simulation can be re-driven deterministically (see load.ts `wallAt`).
 */
export type WallMotion =
  | {
      kind: 'translate';
      /** Travel vector (metres) at the far end of the ping-pong. */
      dx: number;
      dz: number;
      /** Seconds for a full out-and-back cycle. */
      period: number;
    }
  | {
      kind: 'slide';
      /** Max fraction of the segment length the door opens (0..1). */
      openFraction: number;
      /** Seconds for a full open-and-close cycle. */
      period: number;
    };

/**
 * An interior wall segment (a low, full-height barrier) on the x/z plane, given
 * as a line from a→b with a material. The game extrudes it to room height.
 * An optional `motion` makes the wall move continuously (sliding door / shifting
 * wall); the acoustics track it in real time.
 */
export interface WallObj {
  id: string;
  ax: number;
  az: number;
  bx: number;
  bz: number;
  material: MaterialName;
  /** Optional continuous motion. Absent ⇒ a static wall (back-compat). */
  motion?: WallMotion;
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
 * A localized ABSORBER PATCH on one of the room's perimeter walls — a rectangle of
 * a different (typically very absorptive) material set into an otherwise reflective
 * wall. Used by the "find the absorber" game mode: the player claps and listens for
 * the DEAD SPOT where this patch swallows the echo.
 *
 * `wall` picks which perimeter face the patch lives on. The patch rectangle is then
 * given in that face's two in-plane axes:
 *  - on '-x'/'+x' faces the plane is (z, y): `u` = z extent, `v` = y (height) extent
 *  - on '-z'/'+z' faces the plane is (x, y): `u` = x extent, `v` = y (height) extent
 * `u0,v0` is the rectangle's min corner and `uSize,vSize` its size (metres). The
 * matching world position (for the win condition + debug overlay) is derived in
 * load.ts. The wall polygon is SPLIT so the patch becomes its own WallDef carrying
 * `material`'s absorption while the rest of the wall keeps `roomMaterial`.
 */
export interface WallPatch {
  id: string;
  wall: '-x' | '+x' | '-z' | '+z';
  u0: number;
  v0: number;
  uSize: number;
  vSize: number;
  material: MaterialName;
}

/**
 * An AMBIENT (non-goal) positioned sound source — a fountain, an AC unit, etc.
 * Spatialized exactly like a beacon (its own voice through the active engine), but
 * it is NEVER a win target and never fades on win. `sound` reuses a BeaconPreset
 * (e.g. the continuous 'fountain'/'brownnoise'/'hum'/'drip'). `id` lets a reaction
 * EVENT (Part C) name the source it occludes/leaks.
 */
export interface AmbientSource {
  id: string;
  x: number;
  z: number;
  /** Continuous preset to synthesize (default 'hum'). */
  sound: BeaconPreset;
  /** Tuning frequency for pitched presets (default 220). */
  freq?: number;
  /** Steady level multiplier (0..1, default 1). */
  gain?: number;
  /** Optional custom audio file looped through this source (falls back to `sound`). */
  soundUrl?: string;
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
  /**
   * Optional custom audio file. If set and it loads, it's looped through the
   * monster's HRTF source instead of the synth voice (falling back to the synth
   * `sound` if the fetch fails). Mirrors BeaconObj.soundUrl.
   */
  soundUrl?: string;
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

  /**
   * SONAR BUDGET — make the clap/echo probe a managed resource ("flash sonar").
   * Both OPTIONAL and independent; absent ⇒ today's free, unlimited clap:
   *  - `clapBudget`: max claps for the whole level (0/undefined ⇒ unlimited).
   *  - `clapCooldownMs`: minimum ms between consecutive claps (0/undefined ⇒ none).
   * The pure model lives in src/game/clapBudget.ts.
   */
  clapBudget?: number;
  clapCooldownMs?: number;

  /**
   * SPEED OF SOUND (m/s) for this level — "alien physics". Absent ⇒ 343 (~20C
   * dry air; the engine default). Changing it scales echo timing (delay ∝ 1/c)
   * AND the live beacon/monster propagation delay + Doppler, so a slow- or
   * fast-sound level sounds coherently different for both the clap and live
   * sources. Non-finite / non-positive values are ignored (treated as default).
   */
  speedOfSound?: number;

  /**
   * CLUTTER (0..1) — how "furnished/soft" the room is, without modelling individual
   * objects. Absent/0 ⇒ today's behaviour (bare room). Higher values raise the
   * representative SCATTERING (breaks up sharp flutter echoes into a natural diffuse
   * decay) and the surfaces' ABSORPTION (shortens the reverb tail), so a hard, empty
   * room with a long fluttery tail can be tamed with one knob. Applied in load.ts to
   * every wall's absorption + the level scattering, so BOTH the clap/modeled engine
   * and the Steam path inherit it. The settings "clutter" slider scales on top.
   */
  clutter?: number;

  /**
   * Win objective. Absent or 'beacon' ⇒ today's behaviour (navigate to the first
   * beacon). 'absorber' ⇒ "find the absorber" mode: the goal is the wall region in
   * front of the first `absorbers` patch, and the beacon is silenced (the clap
   * reveals the room; the dead spot reveals the foam). 'escape' ⇒ "stealth" mode:
   * the goal is to reach `exit` UNCAUGHT past the noise-hunting monster(s); the
   * beacon (if any) acts as the exit's locator sound. See game.ts.
   */
  goal?: 'beacon' | 'absorber' | 'escape';
  /** Absorptive wall patches (optional). The first is the goal in 'absorber' mode. */
  absorbers?: WallPatch[];
  /** Exit location (used when goal === 'escape'): reach it uncaught to win. */
  exit?: Vec2;
  /**
   * DECOUPLED WIN POINT — the place the player must reach to win, INDEPENDENT of
   * any beacon. Absent ⇒ the win target defaults to the first beacon (today's
   * behaviour, byte-identical). Lets a multi-beacon level have several audible
   * beacons while winning is tied to one specific spot. Ignored in 'absorber' /
   * 'escape' modes (those keep using `goalTarget`/`exit`).
   */
  winPoint?: Vec2;
  /**
   * Win radius (metres) around `winPoint` — reach within this to win. Absent ⇒
   * the first beacon's `goalRadius` (if any) else `DEFAULT_WIN_RADIUS` (0.9). Lets a
   * beacon-less level (silent corridor) still specify how close "close enough" is.
   * Ignored in 'absorber'/'escape' modes (those keep their own radii via goalRadius).
   */
  winRadius?: number;
  /**
   * Throw-a-sound decoy budget (stealth verb). Number of decoys the player may
   * throw this level. Absent/undefined ⇒ unlimited. See game.ts `throwDecoy`.
   */
  decoyBudget?: number;

  /**
   * AMBIENT (non-goal) positioned sound sources — fountains, AC units. Spatialized
   * like beacons but never win targets. Absent ⇒ none (back-compat). See game.ts.
   */
  ambience?: AmbientSource[];

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
    absorbers: [],
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
  if (!Array.isArray(l.absorbers)) l.absorbers = [];
  if (!Array.isArray(l.ambience)) l.ambience = [];
  // Back-fill beacon sound preset: beacons with no `sound` get DEFAULT_BEACON_PRESET.
  if (Array.isArray(l.beacons)) {
    for (const b of l.beacons as BeaconObj[]) {
      if (b && typeof b === 'object') b.sound = resolveBeaconPreset(b.sound);
    }
  }
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
