/**
 * Convert an editor Level into what the game runtime needs: a GameLevel (start +
 * beacon + goal) and the acoustic geometry (room walls + interior walls + floor
 * material). The editor places things in 2D; we lift them to 3D here.
 */
import type { Level, MaterialName, WallObj } from './schema';
import type { GameLevel } from '../game/game';
import type { WallDef, EdgeDef } from '../engine/acoustics/core';
import { MATERIALS, scatteringFor } from '../engine/acoustics/materials';

const abs = (m: string): number[] => [...(MATERIALS[m] ?? MATERIALS.concrete)];

export interface LoadedLevel {
  game: GameLevel;
  /** Acoustic geometry (perimeter + interior walls) for the clap/room IR. */
  walls: WallDef[];
  /**
   * Diffracting edges (doorway jambs / partial-wall ends) auto-derived from the
   * interior walls' free ends. Passed to the room solver so diffraction "just
   * works" in authored levels. See `diffractionEdgesAt`.
   */
  edges: EdgeDef[];
  roomSize: [number, number, number];
  /** Representative scattering coefficient across the level's materials. */
  scattering: number;
  /** The source level, so callers can call `wallsAt(level, t)` for live geometry. */
  level: Level;
  /** True if any wall has motion (the live IR loop only runs then). */
  hasMovingWalls: boolean;
}

/** The 6 axis-aligned walls of a box room, all one material — used as the default
 *  game level's geometry and a convenience for callers. */
export function boxRoomWalls(size: [number, number, number], material: MaterialName | string): WallDef[] {
  const [sx, sy, sz] = size;
  const a = abs(material);
  const v = (x: number, y: number, z: number): [number, number, number] => [x, y, z];
  return [
    { verts: [v(0, 0, 0), v(0, 0, sz), v(0, sy, sz), v(0, sy, 0)], absorption: a },
    { verts: [v(sx, 0, 0), v(sx, sy, 0), v(sx, sy, sz), v(sx, 0, sz)], absorption: a },
    { verts: [v(0, 0, 0), v(sx, 0, 0), v(sx, 0, sz), v(0, 0, sz)], absorption: a },
    { verts: [v(0, sy, 0), v(0, sy, sz), v(sx, sy, sz), v(sx, sy, 0)], absorption: a },
    { verts: [v(0, 0, 0), v(0, sy, 0), v(sx, sy, 0), v(sx, 0, 0)], absorption: a },
    { verts: [v(0, 0, sz), v(sx, 0, sz), v(sx, sy, sz), v(0, sy, sz)], absorption: a },
  ];
}

/** Read the editor's "current" level from localStorage, if present. */
export function currentEditorLevel(): Level | null {
  const raw = localStorage.getItem('papasangre-current-level');
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Level;
  } catch {
    return null;
  }
}

/** Build the perimeter walls + floor (+ ceiling if present) as polygon WallDefs. */
function perimeterWalls(level: Level): WallDef[] {
  const { width: sx, depth: sz, height: sy } = level.room;
  const a = abs(level.roomMaterial);
  const v = (x: number, y: number, z: number): [number, number, number] => [x, y, z];
  const walls: WallDef[] = [
    { verts: [v(0, 0, 0), v(0, 0, sz), v(0, sy, sz), v(0, sy, 0)], absorption: a }, // -x
    { verts: [v(sx, 0, 0), v(sx, sy, 0), v(sx, sy, sz), v(sx, 0, sz)], absorption: a }, // +x
    { verts: [v(0, 0, 0), v(sx, 0, 0), v(sx, 0, sz), v(0, 0, sz)], absorption: abs(level.floorMaterial) }, // floor
    { verts: [v(0, 0, 0), v(0, sy, 0), v(sx, sy, 0), v(sx, 0, 0)], absorption: a }, // -z
    { verts: [v(0, 0, sz), v(sx, 0, sz), v(sx, sy, sz), v(0, sy, sz)], absorption: a }, // +z
  ];
  if (level.hasCeiling) walls.push(...ceilingQuads(level));
  return walls;
}

/**
 * Ceiling as horizontal quad(s). A flat default ceiling at room.height, plus any
 * CeilingZones that override height/material over their rectangle. We emit the
 * default ceiling and each zone as separate quads; overlapping zones simply add a
 * lower reflecting surface (the image-source method handles multiple planes).
 */
function ceilingQuads(level: Level): WallDef[] {
  const { width: sx, depth: sz, height: sy } = level.room;
  const v = (x: number, y: number, z: number): [number, number, number] => [x, y, z];
  const quads: WallDef[] = [
    { verts: [v(0, sy, 0), v(0, sy, sz), v(sx, sy, sz), v(sx, sy, 0)], absorption: abs(level.ceilingMaterial) },
  ];
  for (const c of level.ceilings) {
    // The lower ceiling plane over the zone.
    quads.push({
      verts: [v(c.x, c.height, c.z), v(c.x, c.height, c.z + c.d),
              v(c.x + c.w, c.height, c.z + c.d), v(c.x + c.w, c.height, c.z)],
      absorption: abs(c.material),
    });
    // PARTIAL WALLS connecting the height change: when this zone's ceiling is
    // lower than the surrounding ceiling, the four sides of the step are real
    // vertical surfaces (the "soffit" faces) from c.height up to room height.
    // Without these, sound would leak through the open band around a dropped
    // ceiling. (If the zone is higher than the room ceiling, no step-down walls.)
    if (c.height < sy - 1e-3) {
      const x0 = c.x, x1 = c.x + c.w, z0 = c.z, z1 = c.z + c.d;
      const m = abs(c.material);
      quads.push(
        // -z face
        { verts: [v(x0, c.height, z0), v(x1, c.height, z0), v(x1, sy, z0), v(x0, sy, z0)], absorption: m },
        // +z face
        { verts: [v(x0, c.height, z1), v(x0, sy, z1), v(x1, sy, z1), v(x1, c.height, z1)], absorption: m },
        // -x face
        { verts: [v(x0, c.height, z0), v(x0, sy, z0), v(x0, sy, z1), v(x0, c.height, z1)], absorption: m },
        // +x face
        { verts: [v(x1, c.height, z0), v(x1, c.height, z1), v(x1, sy, z1), v(x1, sy, z0)], absorption: m },
      );
    }
  }
  return quads;
}

/** An interior wall segment, extruded to room height as a thin vertical quad. */
function interiorWall(level: Level, ax: number, az: number, bx: number, bz: number, mat: string): WallDef {
  const sy = level.room.height;
  const v = (x: number, y: number, z: number): [number, number, number] => [x, y, z];
  return { verts: [v(ax, 0, az), v(bx, 0, bz), v(bx, sy, bz), v(ax, sy, az)], absorption: abs(mat) };
}

/** A 2D segment on the x/z plane. */
export interface WallSegment { ax: number; az: number; bx: number; bz: number; }

/**
 * Triangle ping-pong in [0,1]: 0 at phase 0, 1 at half period, back to 0 at the
 * full period. `t` and `period` in seconds; pure and bounded to [0,1].
 */
function pingPong(t: number, period: number): number {
  if (!(period > 0)) return 0;
  const p = ((t % period) + period) % period; // [0,period)
  const half = period / 2;
  return p < half ? p / half : 2 - p / half;
}

/**
 * The wall's current 2D segment at time `t` (seconds), applying its motion.
 * A wall with no `motion` returns its rest segment for ALL t (so old levels are
 * byte-identical to before). Pure — no runtime state.
 */
export function wallSegmentAt(w: WallObj, t: number): WallSegment {
  const rest: WallSegment = { ax: w.ax, az: w.az, bx: w.bx, bz: w.bz };
  const m = w.motion;
  if (!m) return rest;
  if (m.kind === 'translate') {
    const f = pingPong(t, m.period);
    return {
      ax: w.ax + m.dx * f, az: w.az + m.dz * f,
      bx: w.bx + m.dx * f, bz: w.bz + m.dz * f,
    };
  }
  // slide: endpoint b retracts toward a, opening a gap. f ranges [0, openFraction]
  // (0 = closed; openFraction = maximally open, a fraction of the segment length).
  const f = pingPong(t, m.period) * Math.max(0, Math.min(1, m.openFraction));
  return {
    ax: w.ax, az: w.az,
    bx: w.bx + (w.ax - w.bx) * f,
    bz: w.bz + (w.az - w.bz) * f,
  };
}

/**
 * The acoustic interior walls (only) at time `t`. Separated so callers can rebuild
 * just the moving part; combined with the static perimeter by `wallsAt`.
 */
function interiorWallsAt(level: Level, t: number): WallDef[] {
  return level.walls.map((w) => {
    const s = wallSegmentAt(w, t);
    return interiorWall(level, s.ax, s.az, s.bx, s.bz, w.material);
  });
}

/**
 * Auto-derive first-order diffracting edges from the level's interior walls.
 *
 * Each interior wall is a thin vertical quad extruded from floor (y=0) to room
 * height. Its two FREE ENDS — the vertical edges at the segment endpoints that
 * are not joined to another wall or the perimeter — are exactly the surfaces
 * sound bends around: doorway jambs and the ends of partial walls. We emit one
 * vertical `EdgeDef` (floor → wall-top) per free end.
 *
 * HEURISTIC ("free" detection) and its LIMITS:
 *  - An endpoint is "free" when it is NOT coincident (within `EDGE_EPS`) with any
 *    OTHER wall endpoint and NOT lying on the room perimeter (x≈0/width or
 *    z≈0/depth). Endpoints shared by two walls (an L/T junction) or buried in the
 *    perimeter are skipped — those are solid corners, not diffracting free ends.
 *  - This is a pragmatic test, not full geometric free-end detection: an endpoint
 *    that touches the MIDDLE of another wall (a true T-junction not sharing a
 *    vertex) is treated as free and over-emits an edge. That is acoustically
 *    near-harmless — the UTD coefficient is ~unity when the listener isn't in that
 *    edge's shadow — so we accept it rather than do full segment-incidence tests.
 *  - First-order only (one bend); no second-order edge chaining.
 *  - Open / perimeter-only levels with no interior walls yield NO edges.
 *
 * Time-parameterised (`t` seconds) so moving walls' free ends track their motion,
 * mirroring `interiorWallsAt`.
 */
const EDGE_EPS = 0.05; // 5 cm: endpoints closer than this are "the same point"

function onPerimeter(level: Level, x: number, z: number): boolean {
  const { width: w, depth: d } = level.room;
  if (level.open) return false; // no perimeter to be buried in
  return (
    Math.abs(x) < EDGE_EPS || Math.abs(x - w) < EDGE_EPS ||
    Math.abs(z) < EDGE_EPS || Math.abs(z - d) < EDGE_EPS
  );
}

export function diffractionEdgesAt(level: Level, t: number): EdgeDef[] {
  const sy = level.room.height;
  // All interior-wall endpoints at time t, as (x,z) pairs tagged by wall index.
  const segs = level.walls.map((w) => wallSegmentAt(w, t));
  const ends: Array<{ wi: number; x: number; z: number }> = [];
  for (let i = 0; i < segs.length; i++) {
    ends.push({ wi: i, x: segs[i].ax, z: segs[i].az });
    ends.push({ wi: i, x: segs[i].bx, z: segs[i].bz });
  }

  const coincidesWithOther = (wi: number, x: number, z: number): boolean =>
    ends.some(
      (e) => e.wi !== wi && Math.hypot(e.x - x, e.z - z) < EDGE_EPS,
    );

  const edges: EdgeDef[] = [];
  for (const e of ends) {
    if (onPerimeter(level, e.x, e.z)) continue; // buried in a perimeter wall
    if (coincidesWithOther(e.wi, e.x, e.z)) continue; // joined to another wall
    // A free end: emit a vertical diffracting edge (floor → wall top).
    edges.push([
      [e.x, 0, e.z],
      [e.x, sy, e.z],
    ]);
  }
  return edges;
}

/** Does this level contain any wall that moves? (cheap gate for the live loop) */
export function levelHasMovingWalls(level: Level): boolean {
  return level.walls.some((w) => w.motion != null);
}

/**
 * Full acoustic geometry (perimeter + interior) at time `t`. At t=0 with no moving
 * walls this equals the static `loadLevel().walls`. The clap/room IR consumes this.
 */
export function wallsAt(level: Level, t: number): WallDef[] {
  return [
    ...(level.open ? [] : perimeterWalls(level)),
    ...interiorWallsAt(level, t),
  ];
}

/** Quantisation steps for the live dirty check (see `liveRebuildSignature`). */
export const POSE_POS_QUANTUM = 0.05; // 5 cm
export const POSE_YAW_QUANTUM = (2.5 * Math.PI) / 180; // ~2.5°

/** A listener pose for the dirty check (world x/z + heading yaw, radians). */
export interface ListenerPose { x: number; z: number; yaw: number; }

/**
 * A compact signature of the MOVING geometry at time `t`, for the dirty check: if
 * it equals the previous signature, nothing moved materially and the expensive IR
 * rebuild can be skipped. Coordinates are quantised to ~1 mm so sub-perceptual
 * jitter doesn't force a rebuild. Static walls/perimeter are omitted (they never
 * change), so a level with no motion yields a constant signature ⇒ zero rebuilds.
 */
export function movingGeometrySignature(level: Level, t: number): string {
  const parts: string[] = [];
  for (const w of level.walls) {
    if (!w.motion) continue;
    const s = wallSegmentAt(w, t);
    const q = (n: number) => Math.round(n * 1000); // mm
    parts.push(`${q(s.ax)},${q(s.az)},${q(s.bx)},${q(s.bz)}`);
  }
  return parts.join('|');
}

/**
 * The full live dirty-check key: MOVING geometry at time `t` PLUS a QUANTISED
 * listener pose. The ambient room IR depends on where the listener stands and which
 * way they face, so the player walking or turning while walls are momentarily static
 * must still trigger a rebuild — otherwise the space goes stale for the new pose.
 *
 * The pose is quantised (position to ~5 cm, yaw to ~2.5°) so sub-perceptual jitter
 * doesn't thrash rebuilds, while real movement does. If NEITHER the walls NOR the
 * (quantised) pose changed, the signature is identical ⇒ no rebuild (a static level
 * with a static listener still never rebuilds).
 */
export function liveRebuildSignature(level: Level, t: number, pose: ListenerPose): string {
  const geo = movingGeometrySignature(level, t);
  const qx = Math.round(pose.x / POSE_POS_QUANTUM);
  const qz = Math.round(pose.z / POSE_POS_QUANTUM);
  const qyaw = Math.round(pose.yaw / POSE_YAW_QUANTUM);
  return `${geo}#${qx},${qz},${qyaw}`;
}

/** The room perimeter as 4 collision wall segments. */
function perimeterSegments(level: Level) {
  const { width: w, depth: d } = level.room;
  const m = level.roomMaterial;
  return [
    { ax: 0, az: 0, bx: w, bz: 0, material: m },
    { ax: w, az: 0, bx: w, bz: d, material: m },
    { ax: w, az: d, bx: 0, bz: d, material: m },
    { ax: 0, az: d, bx: 0, bz: 0, material: m },
  ];
}

export function loadLevel(level: Level): LoadedLevel {
  const first = level.beacons[0];
  const game: GameLevel = {
    start: { x: level.start.x, z: level.start.z, yaw: level.start.yaw },
    beacon: first
      ? { x: first.x, z: first.z, freq: first.freq, sound: first.sound, soundUrl: first.soundUrl }
      : { x: level.room.width / 2, z: 1, freq: 440 },
    goalRadius: first?.goalRadius ?? 0.8,
    headHeight: 1.6,
    floorMaterial: level.floorMaterial,
    floors: level.floors.map((f) => ({ x: f.x, z: f.z, w: f.w, d: f.d, material: f.material })),
    // Collision walls = interior walls, plus the perimeter (as 4 segments) when
    // the level is enclosed, so you can't walk out of an enclosed room.
    walls: [
      ...level.walls.map((w) => ({ ax: w.ax, az: w.az, bx: w.bx, bz: w.bz, material: w.material })),
      ...(level.open ? [] : perimeterSegments(level)),
    ],
    monsters: level.monsters.map((m) => ({ x: m.x, z: m.z, speed: m.speed, sound: m.sound })),
  };
  // Open levels have no enclosing box — only the free-standing walls you placed.
  // Built at t=0 (rest pose); for moving-wall levels the live loop re-derives the
  // interior geometry per frame via `wallsAt(level, t)`.
  const walls = wallsAt(level, 0);
  const edges = diffractionEdgesAt(level, 0);

  // Representative mid-band scattering across all the materials in play.
  const usedMats = new Set<string>([
    level.roomMaterial, level.floorMaterial, level.ceilingMaterial,
    ...level.walls.map((w) => w.material),
    ...level.ceilings.map((c) => c.material),
  ]);
  let sSum = 0;
  for (const m of usedMats) sSum += scatteringFor(m)[4]; // ~1kHz band
  const scattering = usedMats.size ? sSum / usedMats.size : 0.1;

  return {
    game,
    walls,
    edges,
    roomSize: [level.room.width, level.room.height, level.room.depth],
    scattering,
    level,
    hasMovingWalls: levelHasMovingWalls(level),
  };
}
