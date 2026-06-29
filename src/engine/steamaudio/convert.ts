/**
 * Pure converter: our `WallDef[]` (8-band absorption + scattering, double-sided
 * flag) → the geometry + materials a WASM Steam Audio scene wants.
 *
 * This module is the testable heart of the Steam Audio backend: it is pure (no Web
 * Audio, no WASM, no Steam Audio runtime) and is unit-tested in
 * `convert.test.ts`. `buildSteamScene` (the one function that touches the live
 * `world.scene`) takes the runtime objects as opaque args so this file never
 * imports `three` or `three-steam-audio` directly — the backend passes them in via
 * a dynamic import, keeping `three` + the 6 MB WASM out of the default bundle.
 *
 * --- BAND MAPPING (8-band → 3-band) ---
 * Our materials carry absorption[8] over octave bands [63,125,250,500,1k,2k,4k,8k].
 * Steam Audio materials are 3-band (low/mid/high). We group:
 *   low  = mean of [63, 125, 250]   (indices 0..2)
 *   mid  = mean of [500, 1000, 2000] (indices 3..5)
 *   high = mean of [4000, 8000]      (indices 6..7)
 * This keeps the 250/500 Hz split at the conventional low/mid boundary and the
 * 2k/4k split at the mid/high boundary — a defensible, documented grouping.
 *
 * --- SCATTERING (8-band → scalar) ---
 * Steam Audio takes a single scattering scalar. We use the mean of the mid bands
 * (500/1k/2k, indices 3..5), matching how our engine's representative scattering is
 * taken around ~1 kHz (the perceptually-central band).
 *
 * --- TRANSMISSION ---
 * Our `WallDef` carries no transmission data (absorption only). Steam Audio uses
 * transmission for the through-wall path. We default to a SMALL non-zero value so
 * walls aren't perfectly opaque (matching our engine's modest through-wall leak),
 * but well below the reflected/occluded field so occlusion still reads clearly. The
 * default is `DEFAULT_TRANSMISSION` below; callers may override per build.
 *
 * --- DOUBLE-SIDED ---
 * Steam Audio meshes are surfaces and a single triangle reflects/occludes from one
 * face only. Interior / free-standing walls (`doubleSided`) must echo + occlude from
 * BOTH sides, so we emit them as a THIN BOX (extruded a small thickness along the
 * polygon normal) — the spike's divider used a thin box and occluded correctly from
 * both sides. Perimeter walls (`doubleSided` falsy — you're always inside) stay a
 * single-sided quad/fan, which is cheaper and correct (the inside face is the only
 * one that matters).
 */
import type { WallDef } from '../acoustics/core';

/** Steam Audio acoustic material (3-band absorption + scalar scattering + 3-band transmission). */
export interface SteamMaterial {
  absorption: [number, number, number];
  scattering: number;
  transmission: [number, number, number];
}

/** Default through-wall transmission (3-band) — small, so walls leak a little but
 *  occlusion still dominates. Our `WallDef` has no transmission data of its own. */
export const DEFAULT_TRANSMISSION: [number, number, number] = [0.02, 0.015, 0.01];

/** Thickness (m) of the extruded box used for double-sided / interior walls. */
export const THIN_WALL_THICKNESS = 0.1;

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Map an 8-band absorption array to Steam Audio's 3-band [low, mid, high]. */
export function absorption8to3(abs: number[]): [number, number, number] {
  return [mean([abs[0], abs[1], abs[2]]), mean([abs[3], abs[4], abs[5]]), mean([abs[6], abs[7]])];
}

/** Reduce an 8-band scattering curve (or our scalar) to Steam Audio's single value. */
export function scattering8toScalar(scatter: number[]): number {
  return mean([scatter[3], scatter[4], scatter[5]]);
}

/**
 * Build the Steam Audio material for one wall. `scattering` is a per-wall scalar
 * (our engine uses a single representative scattering per room — see
 * `acousticScattering`); if a full per-band scattering curve is ever attached to a
 * `WallDef`, reduce it with `scattering8toScalar` before calling.
 */
export function wallMaterial(
  wall: WallDef,
  scattering: number,
  transmission: [number, number, number] = DEFAULT_TRANSMISSION,
): SteamMaterial {
  return {
    absorption: absorption8to3(wall.absorption),
    scattering,
    transmission,
  };
}

/** A plain geometry description (positions + triangle indices) — `three`-free, so it
 *  is unit-testable. The backend turns this into a THREE.BufferGeometry. */
export interface MeshData {
  /** Flat xyz positions, 3 floats per vertex. */
  positions: Float32Array;
  /** Triangle indices into `positions` (3 per triangle). */
  indices: Uint32Array;
}

/**
 * Triangulate a single convex polygon (the wall's `verts`) as a fan: for verts
 * v0..v(n-1) emit triangles (v0,v1,v2), (v0,v2,v3), … — n-2 triangles for an
 * n-gon (a quad → 2). Single-sided: one winding only.
 */
export function quadToMeshData(wall: WallDef): MeshData {
  const n = wall.verts.length;
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    positions[i * 3] = wall.verts[i][0];
    positions[i * 3 + 1] = wall.verts[i][1];
    positions[i * 3 + 2] = wall.verts[i][2];
  }
  const tris = n - 2;
  const indices = new Uint32Array(tris * 3);
  for (let i = 0; i < tris; i++) {
    indices[i * 3] = 0;
    indices[i * 3 + 1] = i + 1;
    indices[i * 3 + 2] = i + 2;
  }
  return { positions, indices };
}

/** Unit normal of a polygon from its first three (non-colinear) vertices. */
function polygonNormal(verts: Array<[number, number, number]>): [number, number, number] {
  const [a, b, c] = verts;
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len; ny /= len; nz /= len;
  return [nx, ny, nz];
}

/**
 * Build a THIN BOX for a double-sided / interior wall: extrude the polygon by
 * ±(thickness/2) along its normal and emit BOTH faces (front + back fan, with
 * opposite windings) so the wall reflects/occludes from either side. We emit the
 * two parallel faces only (no side rim) — that's enough for occlusion + reflection
 * of a thin panel and keeps the triangle count minimal. For an n-gon this is
 * 2*(n-2) triangles.
 */
export function thinBoxMeshData(wall: WallDef, thickness = THIN_WALL_THICKNESS): MeshData {
  const n = wall.verts.length;
  const [nx, ny, nz] = polygonNormal(wall.verts);
  const h = thickness / 2;
  // Front face = verts + h*normal, back face = verts - h*normal.
  const positions = new Float32Array(n * 2 * 3);
  for (let i = 0; i < n; i++) {
    const v = wall.verts[i];
    // front
    positions[i * 3] = v[0] + nx * h;
    positions[i * 3 + 1] = v[1] + ny * h;
    positions[i * 3 + 2] = v[2] + nz * h;
    // back
    const o = (n + i) * 3;
    positions[o] = v[0] - nx * h;
    positions[o + 1] = v[1] - ny * h;
    positions[o + 2] = v[2] - nz * h;
  }
  const tris = n - 2;
  const indices = new Uint32Array(tris * 2 * 3);
  for (let i = 0; i < tris; i++) {
    // front face (winding 0,1,2)
    indices[i * 3] = 0;
    indices[i * 3 + 1] = i + 1;
    indices[i * 3 + 2] = i + 2;
    // back face (reversed winding, offset by n so the outward normal flips)
    const o = (tris + i) * 3;
    indices[o] = n;
    indices[o + 1] = n + i + 2;
    indices[o + 2] = n + i + 1;
  }
  return { positions, indices };
}

/** Pick the right triangulation for a wall (thin box if double-sided, else fan quad). */
export function wallToMeshData(wall: WallDef, thickness = THIN_WALL_THICKNESS): MeshData {
  return wall.doubleSided ? thinBoxMeshData(wall, thickness) : quadToMeshData(wall);
}

/**
 * A geometry factory + scene host, injected by the backend so this module stays
 * free of `three` / `three-steam-audio` imports (and out of the default bundle).
 */
export interface SceneDeps {
  /** Build a runtime geometry object (THREE.BufferGeometry) from plain mesh data. */
  makeGeometry(data: MeshData): unknown;
  /** Identity world matrix (THREE.Matrix4) — our wall verts are already world-space. */
  identityMatrix(): unknown;
}

/** The minimal slice of a Steam Audio `world.scene` we use. */
export interface SteamScene {
  addStaticMesh(args: { geometry: unknown; material: SteamMaterial | SteamMaterial[]; matrixWorld: unknown }): unknown;
  commit(): void;
}

/**
 * Build the Steam Audio scene from our walls: one static mesh per wall (each with
 * its own material from the 8→3-band mapping), then commit. Returns the added mesh
 * handles so the backend can dispose them on the next `setGeometry`.
 *
 * One mesh per wall (rather than one merged mesh) keeps per-wall materials simple
 * and lets us dispose/rebuild on moving-wall updates; Steam Audio's BVH is rebuilt
 * on `commit()` regardless. Our wall verts are already in world space, so each mesh
 * uses an identity world matrix.
 */
export function buildSteamScene(
  scene: SteamScene,
  walls: WallDef[],
  deps: SceneDeps,
  opts: { scattering: number; transmission?: [number, number, number]; thickness?: number } = { scattering: 0.1 },
): unknown[] {
  const handles: unknown[] = [];
  for (const wall of walls) {
    const data = wallToMeshData(wall, opts.thickness ?? THIN_WALL_THICKNESS);
    const geometry = deps.makeGeometry(data);
    const material = wallMaterial(wall, opts.scattering, opts.transmission ?? DEFAULT_TRANSMISSION);
    handles.push(scene.addStaticMesh({ geometry, material, matrixWorld: deps.identityMatrix() }));
  }
  scene.commit();
  return handles;
}
