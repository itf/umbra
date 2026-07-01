/**
 * Convert an editor Level into what the game runtime needs: a GameLevel (start +
 * beacon + goal) and the acoustic geometry (room walls + interior walls + floor
 * material). The editor places things in 2D; we lift them to 3D here.
 */
import type { Level, MaterialName, WallObj, WallPatch } from './schema';
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
  /**
   * Sanitized per-level speed of sound (m/s), or undefined ⇒ engine default 343.
   * Only finite values > 1 are forwarded; 0/negative/NaN collapse to undefined so
   * a bad authored value can never propagate as inf/NaN into the solver.
   */
  speedOfSound?: number;
}

/** Default win radius (m) for a `winPoint` with no explicit `winRadius`/beacon. */
export const DEFAULT_WIN_RADIUS = 0.9;

/**
 * The player must ORIENT (turn) to reach the goal, not just walk straight. But we also
 * must NOT spin them toward a wall. So: the goal only needs to be a LITTLE off the
 * heading (> MIN_START_OFFSET); if it already is, leave the authored yaw alone. If it's
 * (nearly) dead-ahead, apply a SMALL random-ish turn — at most MAX_START_OFFSET to
 * either side — so the goal moves just off-centre without pointing the player at a wall.
 *
 * PURE + deterministic: the "random" turn is seeded from the start position, so a given
 * level always starts identically (no per-load jitter). No-op when the goal is already
 * off-axis or coincident with the start. Convention: yaw 0 faces -z, +yaw turns right;
 * the goal's bearing from the start is atan2(dx, -dz) in the same frame (see player.ts).
 */
export const MIN_START_OFFSET = (5 * Math.PI) / 180;  // goal must be >5° off the heading
export const MAX_START_OFFSET = (45 * Math.PI) / 180; // …but we turn at most 45° to a side

export function offAxisStartYaw(
  start: { x: number; z: number; yaw: number },
  target: { x: number; z: number },
): number {
  const dx = target.x - start.x;
  const dz = target.z - start.z;
  // Degenerate: start ON the goal — nothing to orient toward; keep the authored yaw.
  if (Math.hypot(dx, dz) < 1e-3) return start.yaw;
  const bearing = Math.atan2(dx, -dz); // heading that faces the goal
  // Signed smallest angle from the current heading to the goal, in (-π, π].
  let delta = bearing - start.yaw;
  delta = Math.atan2(Math.sin(delta), Math.cos(delta));
  if (Math.abs(delta) > MIN_START_OFFSET) return start.yaw; // already more than 5° off
  // Nearly dead-ahead: turn the heading a small, deterministic amount to one side so the
  // goal ends up between MIN and MAX offset off-centre (never a big spin toward a wall).
  // Seed a stable 0..1 fraction from the position (integer hash of cm-quantised coords).
  const h = (Math.round(start.x * 100) * 73856093 + Math.round(start.z * 100) * 19349663) >>> 0;
  const frac = (h % 1000) / 1000;
  const magnitude = MIN_START_OFFSET + frac * (MAX_START_OFFSET - MIN_START_OFFSET);
  const side = (h & 1) === 0 ? 1 : -1;
  // Rotate the HEADING away from the goal by `magnitude` → the goal sits `magnitude` off.
  return bearing + side * magnitude;
}

/** Forward only a finite, sensible speed of sound; else undefined (⇒ 343). */
export function sanitizeLevelSpeed(c: number | undefined): number | undefined {
  return c != null && Number.isFinite(c) && c > 1 ? c : undefined;
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

/**
 * The four vertical perimeter faces, identified by side, so absorber patches can be
 * split into whichever one they sit on. Each face is parameterised by its two
 * in-plane axes (u, v=height) and a function turning (u,v) into a world point, so a
 * single splitter works for all four orientations.
 */
type PerimeterFace = {
  wall: WallPatch['wall'];
  uMax: number; // extent of the in-plane horizontal axis (z for ±x faces, x for ±z)
  vMax: number; // height
  /** Map (u, v) on the face to a world vertex. */
  pt: (u: number, v: number) => [number, number, number];
};

function perimeterFaces(level: Level): PerimeterFace[] {
  const { width: sx, depth: sz, height: sy } = level.room;
  return [
    { wall: '-x', uMax: sz, vMax: sy, pt: (u, v) => [0, v, u] },
    { wall: '+x', uMax: sz, vMax: sy, pt: (u, v) => [sx, v, u] },
    { wall: '-z', uMax: sx, vMax: sy, pt: (u, v) => [u, v, 0] },
    { wall: '+z', uMax: sx, vMax: sy, pt: (u, v) => [u, v, sz] },
  ];
}

/**
 * Split one perimeter face into WallDefs, carving out any absorber patches on it.
 * No patches ⇒ a single quad (byte-identical to the un-split wall). With a patch we
 * emit a border-grid: the patch quad (absorber material) plus up to four surrounding
 * rectangles (room material) covering the rest of the face. Axis-aligned, coarse,
 * cheap — a handful of extra quads. Multiple patches on one face are carved one at a
 * time by recursively splitting the remaining rectangles (rare; kept simple).
 */
function splitFace(face: PerimeterFace, a: number[], patches: WallPatch[]): WallDef[] {
  // A rectangle in face (u,v) space, with the material to fill it with.
  type Rect = { u0: number; v0: number; u1: number; v1: number; mat: number[] };
  const quad = (r: Rect): WallDef => ({
    verts: [face.pt(r.u0, r.v0), face.pt(r.u1, r.v0), face.pt(r.u1, r.v1), face.pt(r.u0, r.v1)],
    absorption: r.mat,
  });
  let rects: Rect[] = [{ u0: 0, v0: 0, u1: face.uMax, v1: face.vMax, mat: a }];
  for (const p of patches) {
    const pu0 = Math.max(0, p.u0), pv0 = Math.max(0, p.v0);
    const pu1 = Math.min(face.uMax, p.u0 + p.uSize), pv1 = Math.min(face.vMax, p.v0 + p.vSize);
    if (!(pu1 > pu0 && pv1 > pv0)) continue; // degenerate / off-face patch
    const pm = abs(p.material);
    const next: Rect[] = [];
    for (const r of rects) {
      // Patch doesn't overlap this rect ⇒ keep as-is.
      if (pu0 >= r.u1 || pu1 <= r.u0 || pv0 >= r.v1 || pv1 <= r.v0) { next.push(r); continue; }
      const cu0 = Math.max(r.u0, pu0), cu1 = Math.min(r.u1, pu1);
      const cv0 = Math.max(r.v0, pv0), cv1 = Math.min(r.v1, pv1);
      // Border pieces (room material), then the patch piece (absorber material).
      if (cv0 > r.v0) next.push({ u0: r.u0, v0: r.v0, u1: r.u1, v1: cv0, mat: r.mat }); // below
      if (cv1 < r.v1) next.push({ u0: r.u0, v0: cv1, u1: r.u1, v1: r.v1, mat: r.mat }); // above
      if (cu0 > r.u0) next.push({ u0: r.u0, v0: cv0, u1: cu0, v1: cv1, mat: r.mat }); // left
      if (cu1 < r.u1) next.push({ u0: cu1, v0: cv0, u1: r.u1, v1: cv1, mat: r.mat }); // right
      next.push({ u0: cu0, v0: cv0, u1: cu1, v1: cv1, mat: pm }); // the patch
    }
    rects = next;
  }
  return rects.map(quad);
}

/** Build the perimeter walls + floor (+ ceiling if present) as polygon WallDefs. */
function perimeterWalls(level: Level): WallDef[] {
  const { width: sx, depth: sz } = level.room;
  const a = abs(level.roomMaterial);
  const v = (x: number, y: number, z: number): [number, number, number] => [x, y, z];
  const patches = level.absorbers ?? [];
  const walls: WallDef[] = [];
  for (const face of perimeterFaces(level)) {
    walls.push(...splitFace(face, a, patches.filter((p) => p.wall === face.wall)));
  }
  walls.push({ verts: [v(0, 0, 0), v(sx, 0, 0), v(sx, 0, sz), v(0, 0, sz)], absorption: abs(level.floorMaterial) }); // floor
  if (level.hasCeiling) walls.push(...ceilingQuads(level));
  return walls;
}

/**
 * World-space centre of an absorber patch (the point the player walks to in
 * "find the absorber" mode, and the debug overlay marker). The horizontal centre is
 * what matters for the floor-plane win check; height is set at head-ish level.
 */
export function absorberWorldPos(level: Level, p: WallPatch): { x: number; y: number; z: number } {
  const face = perimeterFaces(level).find((f) => f.wall === p.wall)!;
  const uc = p.u0 + p.uSize / 2;
  const vc = p.v0 + p.vSize / 2;
  const [x, y, z] = face.pt(uc, vc);
  return { x, y, z };
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

/**
 * An interior wall segment, extruded to room height as a thin vertical quad,
 * flagged DOUBLE-SIDED so it reflects from both faces. Interior walls are exposed
 * on both sides — you can stand on either side — so a listener behind the wall must
 * still hear it echo. (A single-sided wall reflects only its normal face; the
 * solver honours the `doubleSided` flag and reflects images on either side.)
 */
function interiorWall(
  level: Level, ax: number, az: number, bx: number, bz: number, mat: string,
): WallDef {
  const sy = level.room.height;
  const v = (x: number, y: number, z: number): [number, number, number] => [x, y, z];
  return {
    verts: [v(ax, 0, az), v(bx, 0, bz), v(bx, sy, bz), v(ax, sy, az)],
    absorption: abs(mat),
    doubleSided: true,
  };
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

/** Clamp a clutter value to [0,1]; non-finite ⇒ 0 (bare room). */
function sanitizeClutter(v: number | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}

/**
 * Apply CLUTTER to a wall's per-band absorption: push each band toward full
 * absorption by a fraction of its remaining headroom. clutter=0 ⇒ unchanged;
 * clutter=1 ⇒ ~MAX_ABSORB_BOOST of the way to fully absorptive. Pure.
 */
const MAX_ABSORB_BOOST = 0.6;
function clutterAbsorption(absorption: number[], clutter: number): number[] {
  if (clutter <= 0) return absorption;
  return absorption.map((a) => a + clutter * MAX_ABSORB_BOOST * (1 - a));
}

/** Raise the representative scattering toward a diffuse target as clutter rises. */
const CLUTTER_SCATTER_TARGET = 0.85;
function clutterScattering(scattering: number, clutter: number): number {
  if (clutter <= 0) return scattering;
  return scattering + clutter * (CLUTTER_SCATTER_TARGET - scattering) * (CLUTTER_SCATTER_TARGET > scattering ? 1 : 0);
}

/**
 * Load a level into the runtime form. `clutterOverride` (0..1), when given, REPLACES
 * the level's own `clutter` — used by the live settings "clutter" slider so the user
 * can tame a fluttery room by ear (re-load to apply). Absent ⇒ the level's value.
 */
export function loadLevel(level: Level, clutterOverride?: number): LoadedLevel {
  const first = level.beacons[0];
  const speedOfSound = sanitizeLevelSpeed(level.speedOfSound);
  const clutter = sanitizeClutter(clutterOverride ?? level.clutter);
  // Map ALL beacons to uniform specs; `beacon` mirrors the first (back-compat).
  // A level may have ZERO beacons (a silent corridor): we do NOT synthesize one.
  // `beacon` then carries a non-audible placeholder ONLY for legacy field readers
  // (debug overlay / the winTarget default); `beacons` stays empty, so nothing
  // sounds. The win is the `winPoint` area, decoupled from any beacon.
  const winFallback = level.winPoint ?? { x: level.room.width / 2, z: 1 };
  const beacon = first
    ? { id: first.id, x: first.x, z: first.z, freq: first.freq, sound: first.sound, soundUrl: first.soundUrl }
    : { x: winFallback.x, z: winFallback.z, freq: 440 };
  const beacons = level.beacons.map((b) => ({ id: b.id, x: b.x, z: b.z, freq: b.freq, sound: b.sound, soundUrl: b.soundUrl }));
  // SEQUENCE mode: an ordered list of beacon ids that actually exist, in order. Only
  // valid with 2+ resolvable ids; otherwise it's normal (all-audible) behaviour.
  const seqIds = (level.sequence ?? []).filter((id) => level.beacons.some((b) => b.id === id));
  const sequence = seqIds.length >= 2 ? seqIds : undefined;
  // The last beacon in the sequence, if any (its position is the win target below).
  const lastSeqBeacon = sequence
    ? level.beacons.find((b) => b.id === sequence[sequence.length - 1])
    : undefined;
  // Decoupled win point: an explicit `winPoint`, else in SEQUENCE mode the LAST beacon
  // (the player is led to it through the trail), else the first beacon's position.
  const winTarget = level.winPoint
    ?? (lastSeqBeacon ? { x: lastSeqBeacon.x, z: lastSeqBeacon.z } : { x: beacon.x, z: beacon.z });
  // The player must turn to find the goal — never start facing straight at it. Rotate
  // the authored start yaw so the goal is ≥MIN_START_OFFSET off the heading (no-op if
  // it already is). Applies uniformly to builtin, saved, and sandbox levels.
  const startYaw = offAxisStartYaw(
    { x: level.start.x, z: level.start.z, yaw: level.start.yaw },
    winTarget,
  );
  const game: GameLevel = {
    start: { x: level.start.x, z: level.start.z, yaw: startYaw },
    beacon,
    beacons,
    // SEQUENCE (trail) mode: ordered beacon ids, one audible at a time (see game.ts).
    sequence,
    winTarget,
    // Win radius: explicit `winRadius`, else the first beacon's goalRadius, else 0.9.
    goalRadius: level.winRadius ?? first?.goalRadius ?? DEFAULT_WIN_RADIUS,
    headHeight: 1.6,
    floorMaterial: level.floorMaterial,
    floors: level.floors.map((f) => ({ x: f.x, z: f.z, w: f.w, d: f.d, material: f.material })),
    // Collision walls = interior walls, plus the perimeter (as 4 segments) when
    // the level is enclosed, so you can't walk out of an enclosed room.
    walls: [
      ...level.walls.map((w) => ({ ax: w.ax, az: w.az, bx: w.bx, bz: w.bz, material: w.material })),
      ...(level.open ? [] : perimeterSegments(level)),
    ],
    monsters: level.monsters.map((m) => ({ x: m.x, z: m.z, speed: m.speed, sound: m.sound, soundUrl: m.soundUrl })),
    // Reaction events (Part C) — threaded verbatim; driven from Game.tick().
    events: level.events ? [...level.events] : undefined,
    requiredReactions: level.requiredReactions,
    // Ambient (non-goal) positioned sources — spatialized like beacons, never goals.
    ambience: (level.ambience ?? []).map((a) => ({
      id: a.id, x: a.x, z: a.z, freq: a.freq ?? 220,
      sound: a.sound, gain: a.gain ?? 1, soundUrl: a.soundUrl,
    })),
    // Sonar budget: thread through verbatim. Absent ⇒ undefined ⇒ unlimited clap
    // (today's behaviour), so old levels and the default room are unchanged.
    clapBudget: level.clapBudget,
    clapCooldownMs: level.clapCooldownMs,
    decoyBudget: level.decoyBudget,
    speedOfSound,
  };
  // "Find the absorber" mode: target the first absorber patch's wall region.
  const firstAbsorber = level.absorbers?.[0];
  if (level.goal === 'absorber' && firstAbsorber) {
    const w = absorberWorldPos(level, firstAbsorber);
    game.goal = 'absorber';
    game.goalTarget = { x: w.x, z: w.z };
  }
  // "Stealth / escape" mode: the win target is the exit (reuses the same
  // goalTarget plumbing as absorber mode). The first beacon stays audible as the
  // exit's locator sound, so the player can home in on it by ear.
  if (level.goal === 'escape' && level.exit) {
    game.goal = 'escape';
    game.goalTarget = { x: level.exit.x, z: level.exit.z };
  }
  // Open levels have no enclosing box — only the free-standing walls you placed.
  // Built at t=0 (rest pose); for moving-wall levels the live loop re-derives the
  // interior geometry per frame via `wallsAt(level, t)`.
  const rawWalls = wallsAt(level, 0);
  // CLUTTER raises every surface's absorption (shorter tail). Both engines read
  // WallDef.absorption (Steam via convert.ts, our engine directly), so this one map
  // makes a cluttered room sound damped everywhere.
  const walls = clutter > 0
    ? rawWalls.map((w) => ({ ...w, absorption: clutterAbsorption(w.absorption, clutter) }))
    : rawWalls;
  const edges = diffractionEdgesAt(level, 0);

  // Representative mid-band scattering across all the materials in play, then raised
  // by clutter (breaks sharp flutter echoes into a diffuse decay).
  const usedMats = new Set<string>([
    level.roomMaterial, level.floorMaterial, level.ceilingMaterial,
    ...level.walls.map((w) => w.material),
    ...level.ceilings.map((c) => c.material),
  ]);
  let sSum = 0;
  for (const m of usedMats) sSum += scatteringFor(m)[4]; // ~1kHz band
  const scattering = clutterScattering(usedMats.size ? sSum / usedMats.size : 0.1, clutter);

  return {
    game,
    walls,
    edges,
    roomSize: [level.room.width, level.room.height, level.room.depth],
    scattering,
    level,
    hasMovingWalls: levelHasMovingWalls(level),
    speedOfSound,
  };
}
