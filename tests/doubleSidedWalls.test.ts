/**
 * Proves interior walls reflect from BOTH faces via the `doubleSided` flag (handled
 * in acoustics-core/src/geometry.rs). An interior wall is exposed on both sides —
 * you can stand on either side — so it must echo whichever side you're on. A
 * single-sided wall reflects only its normal face; the test puts a listener on the
 * side the single normal does NOT face and confirms the double-sided wall echoes
 * there while the single-sided one does not.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { computeRoomTaps, type WallDef, type Tap, initAcoustics } from '../src/engine/acoustics/core';

beforeAll(async () => {
  // Initialise the WASM module the same way the app does.
  const wasmDir = resolve(dirname(fileURLToPath(import.meta.url)), '../src/engine/acoustics/wasm');
  const mod = await import(resolve(wasmDir, 'acoustics_core.js'));
  await mod.default(readFileSync(resolve(wasmDir, 'acoustics_core_bg.wasm')));
  await initAcoustics().catch(() => { /* already inited via the import above */ });
});

const RIGID = new Array(8).fill(0.1);

/** A 16-deep room whose vertex centroid sits on the +z (large) side of a divider. */
function room(): WallDef[] {
  const sx = 8, sy = 3, sz = 16;
  const v = (x: number, y: number, z: number): [number, number, number] => [x, y, z];
  return [
    { verts: [v(0, 0, 0), v(0, 0, sz), v(0, sy, sz), v(0, sy, 0)], absorption: RIGID },
    { verts: [v(sx, 0, 0), v(sx, sy, 0), v(sx, sy, sz), v(sx, 0, sz)], absorption: RIGID },
    { verts: [v(0, 0, 0), v(sx, 0, 0), v(sx, 0, sz), v(0, 0, sz)], absorption: RIGID },
    { verts: [v(0, 0, 0), v(0, sy, 0), v(sx, sy, 0), v(sx, 0, 0)], absorption: RIGID },
    { verts: [v(0, 0, sz), v(sx, 0, sz), v(sx, sy, sz), v(0, sy, sz)], absorption: RIGID },
  ];
}

// A full-width divider at z=4. The room centroid is at z>4 (the larger side), so a
// single-sided divider's normal is forced toward +z — its -z (small-side) face is
// dead. We test a listener at z=2, on that dead small side.
function divider(doubleSided: boolean): WallDef {
  const v = (x: number, y: number, z: number): [number, number, number] => [x, y, z];
  return { verts: [v(0, 0, 4), v(8, 0, 4), v(8, 3, 4), v(0, 3, 4)], absorption: RIGID, doubleSided };
}

const reflections = (walls: WallDef[], at: [number, number, number]): Tap[] =>
  computeRoomTaps({ walls, listener: at, source: at, maxOrder: 1 }).filter((t) => t.order >= 1);

/**
 * The near-divider echo at z=4: from a listener at z=2 it arrives from straight
 * ahead (+z, dir.z > 0.5) after a 4 m round trip (≈0.0117 s) — distinct from the
 * far +z perimeter wall at z=16 (≈0.08 s). Returns the matching tap, if any.
 */
const dividerEcho = (taps: Tap[]): Tap | undefined =>
  taps.find((t) => t.dir[2] > 0.5 && t.delay < 0.02);

describe('interior walls reflect from both sides (doubleSided flag)', () => {
  const smallSide: [number, number, number] = [4, 1.6, 2]; // the face away from the centroid

  it('a SINGLE-sided divider is dead on its back (small) side — no near echo', () => {
    expect(dividerEcho(reflections([...room(), divider(false)], smallSide))).toBeUndefined();
  });

  it('a DOUBLE-sided divider echoes on the small side (round-trip ≈ 4 m)', () => {
    const echo = dividerEcho(reflections([...room(), divider(true)], smallSide));
    expect(echo).toBeDefined();
    expect(echo!.delay).toBeCloseTo(4 / 343, 3); // 2 m out + 2 m back at 343 m/s
  });

  it('does NOT double-count: the centroid-facing side has the divider echo exactly once', () => {
    // At z=6 (the +z side the single normal already faced), the near divider echo
    // (round trip 4 m) must appear ONCE for both single- and double-sided.
    const at: [number, number, number] = [4, 1.6, 6];
    const near = (ds: boolean) =>
      reflections([...room(), divider(ds)], at).filter((t) => t.dir[2] < -0.5 && t.delay < 0.02);
    expect(near(false).length).toBe(1);
    expect(near(true).length).toBe(1); // no duplicate from a second coincident quad
  });
});
