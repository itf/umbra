/**
 * Verifies the WASM binding for the GENERAL room solver + diffraction — i.e. the
 * flat-encoding round-trip across the JS↔WASM boundary, which the Rust unit tests
 * can't cover. Loads the wasm bytes from disk directly (bypassing Vite's ?url).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const wasmDir = resolve(here, '../src/engine/acoustics/wasm');

// The wasm-bindgen glue exports `default` init accepting wasm bytes/module.
let mod: typeof import('../src/engine/acoustics/wasm/acoustics_core.js');

beforeAll(async () => {
  mod = await import(resolve(wasmDir, 'acoustics_core.js'));
  const bytes = readFileSync(resolve(wasmDir, 'acoustics_core_bg.wasm'));
  await mod.default(bytes);
});

const NB = 8; // NUM_BANDS

/** Unit-cube room (1x1x1) with rigid walls, built as 6 quads. */
function unitCubeFlat() {
  const v = (x: number, y: number, z: number) => [x, y, z];
  const quads = [
    [v(0, 0, 0), v(0, 0, 1), v(0, 1, 1), v(0, 1, 0)], // -x
    [v(1, 0, 0), v(1, 1, 0), v(1, 1, 1), v(1, 0, 1)], // +x
    [v(0, 0, 0), v(1, 0, 0), v(1, 0, 1), v(0, 0, 1)], // floor
    [v(0, 1, 0), v(0, 1, 1), v(1, 1, 1), v(1, 1, 0)], // ceil
    [v(0, 0, 0), v(0, 1, 0), v(1, 1, 0), v(1, 0, 0)], // -z
    [v(0, 0, 1), v(1, 0, 1), v(1, 1, 1), v(0, 1, 1)], // +z
  ];
  const verts: number[] = [];
  const sizes: number[] = [];
  const abs: number[] = [];
  for (const q of quads) {
    sizes.push(q.length);
    for (const p of q) verts.push(p[0], p[1], p[2]);
    for (let b = 0; b < NB; b++) abs.push(0); // rigid
  }
  return {
    verts: new Float32Array(verts),
    sizes: new Uint32Array(sizes),
    abs: new Float32Array(abs),
  };
}

describe('WASM general-room binding', () => {
  it('round-trips geometry and returns a box-like reflection set', () => {
    const { verts, sizes, abs } = unitCubeFlat();
    const stride = mod.tap_stride();
    const p = new Float32Array([0.5, 0.5, 0.5]);
    const packed = mod.compute_room_taps(
      verts, sizes, abs, new Float32Array([]), p, p, 1,
    );
    const n = packed.length / stride;
    // Listener=source at center of a unit cube: 6 first-order reflections, each a
    // 1m round-trip (0.5m to wall and back) → delay = 1/343.
    const delays = [];
    for (let i = 0; i < n; i++) delays.push(packed[i * stride]);
    const oneMeter = 1 / 343;
    const reflections = delays.filter((d) => Math.abs(d - oneMeter) < 1e-3);
    expect(reflections.length).toBe(6);
  });

  it('adds a diffraction tap when an edge is supplied', () => {
    const { verts, sizes, abs } = unitCubeFlat();
    const stride = mod.tap_stride();
    const listener = new Float32Array([0.2, 0.5, 0.5]);
    const source = new Float32Array([0.8, 0.5, 0.5]);
    const noEdge = mod.compute_room_taps(
      verts, sizes, abs, new Float32Array([]), listener, source, 1,
    );
    // One vertical edge through the middle of the room.
    const edge = new Float32Array([0.5, 0, 0.5, 0.5, 1, 0.5]);
    const withEdge = mod.compute_room_taps(
      verts, sizes, abs, edge, listener, source, 1,
    );
    expect(withEdge.length / stride).toBe(noEdge.length / stride + 1);
  });
});
