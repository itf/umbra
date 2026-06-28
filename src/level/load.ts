/**
 * Convert an editor Level into what the game runtime needs: a GameLevel (start +
 * beacon + goal) and the acoustic geometry (room walls + interior walls + floor
 * material). The editor places things in 2D; we lift them to 3D here.
 */
import type { Level } from './schema';
import type { GameLevel } from '../game/game';
import type { WallDef } from '../engine/acoustics/core';
import { MATERIALS } from '../engine/acoustics/materials';

const abs = (m: string): number[] => [...(MATERIALS[m] ?? MATERIALS.concrete)];

export interface LoadedLevel {
  game: GameLevel;
  /** Acoustic geometry (perimeter + interior walls) for the clap/room IR. */
  walls: WallDef[];
  roomSize: [number, number, number];
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
    quads.push({
      verts: [v(c.x, c.height, c.z), v(c.x, c.height, c.z + c.d),
              v(c.x + c.w, c.height, c.z + c.d), v(c.x + c.w, c.height, c.z)],
      absorption: abs(c.material),
    });
  }
  return quads;
}

/** An interior wall segment, extruded to room height as a thin vertical quad. */
function interiorWall(level: Level, ax: number, az: number, bx: number, bz: number, mat: string): WallDef {
  const sy = level.room.height;
  const v = (x: number, y: number, z: number): [number, number, number] => [x, y, z];
  return { verts: [v(ax, 0, az), v(bx, 0, bz), v(bx, sy, bz), v(ax, sy, az)], absorption: abs(mat) };
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
      ? { x: first.x, z: first.z, freq: first.freq }
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
  };
  // Open levels have no enclosing box — only the free-standing walls you placed.
  const walls = [
    ...(level.open ? [] : perimeterWalls(level)),
    ...level.walls.map((w) => interiorWall(level, w.ax, w.az, w.bx, w.bz, w.material)),
  ];
  return {
    game,
    walls,
    roomSize: [level.room.width, level.room.height, level.room.depth],
  };
}
