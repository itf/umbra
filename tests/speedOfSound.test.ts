/**
 * Per-level speed of sound, end to end:
 *  - schema/load: the field round-trips into GameLevel/LoadedLevel; absent ⇒
 *    undefined (back-compat); a 0/negative/NaN value is sanitized to undefined so
 *    it can never propagate as inf/NaN into the solver.
 *  - acoustic effect: the SAME room solved at a SLOWER speed of sound yields LONGER
 *    tap delays (delay ∝ 1/c — halve c ≈ double delay). This proves the level field
 *    actually changes echo timing. Calls the WASM core directly (loaded from disk),
 *    mirroring reflectorAcoustics/wasmRoom — NOT the `?url` core wrapper.
 *  - the Cathedral builtin is large + hard (marble) and loads cleanly.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { emptyLevel, isLevel } from '../src/level/schema';
import { loadLevel, sanitizeLevelSpeed } from '../src/level/load';
import { getBuiltin } from '../src/level/builtins';

const here = dirname(fileURLToPath(import.meta.url));
const wasmDir = resolve(here, '../src/engine/acoustics/wasm');

let mod: typeof import('../src/engine/acoustics/wasm/acoustics_core.js');

beforeAll(async () => {
  mod = await import(resolve(wasmDir, 'acoustics_core.js'));
  await mod.default(readFileSync(resolve(wasmDir, 'acoustics_core_bg.wasm')));
});

describe('schema + load threading', () => {
  it('round-trips speedOfSound into GameLevel and LoadedLevel', () => {
    const lvl = emptyLevel('Slow');
    lvl.speedOfSound = 150;
    const loaded = loadLevel(lvl);
    expect(loaded.speedOfSound).toBe(150);
    expect(loaded.game.speedOfSound).toBe(150);
  });

  it('a level with no speedOfSound yields undefined (back-compat ⇒ 343)', () => {
    const lvl = emptyLevel('Default');
    expect('speedOfSound' in lvl).toBe(false);
    const loaded = loadLevel(lvl);
    expect(loaded.speedOfSound).toBeUndefined();
    expect(loaded.game.speedOfSound).toBeUndefined();
  });

  it('sanitizes 0 / negative / NaN / Infinity / <=1 to undefined', () => {
    for (const bad of [0, -100, NaN, Infinity, -Infinity, 1]) {
      expect(sanitizeLevelSpeed(bad)).toBeUndefined();
    }
    expect(sanitizeLevelSpeed(150)).toBe(150);
    expect(sanitizeLevelSpeed(undefined)).toBeUndefined();
  });

  it('a bad authored speedOfSound does not propagate through load', () => {
    const lvl = emptyLevel('Bad');
    (lvl as { speedOfSound?: number }).speedOfSound = NaN;
    const loaded = loadLevel(lvl);
    expect(loaded.speedOfSound).toBeUndefined();
    expect(Number.isFinite(loaded.game.speedOfSound ?? 343)).toBe(true);
  });

  it('isLevel still accepts levels with the optional field (back-compat)', () => {
    const lvl = emptyLevel('OK');
    lvl.speedOfSound = 200;
    expect(isLevel(lvl)).toBe(true);
    expect(isLevel(emptyLevel('NoField'))).toBe(true);
  });
});

describe('acoustic effect: delay scales ~1/c', () => {
  const NB = 8; // NUM_BANDS

  /** Unit-cube room (1x1x1), rigid walls, flat-encoded for the WASM core. */
  function unitCubeFlat() {
    const v = (x: number, y: number, z: number) => [x, y, z];
    const quads = [
      [v(0, 0, 0), v(0, 0, 1), v(0, 1, 1), v(0, 1, 0)],
      [v(1, 0, 0), v(1, 1, 0), v(1, 1, 1), v(1, 0, 1)],
      [v(0, 0, 0), v(1, 0, 0), v(1, 0, 1), v(0, 0, 1)],
      [v(0, 1, 0), v(0, 1, 1), v(1, 1, 1), v(1, 1, 0)],
      [v(0, 0, 0), v(0, 1, 0), v(1, 1, 0), v(1, 0, 0)],
      [v(0, 0, 1), v(1, 0, 1), v(1, 1, 1), v(0, 1, 1)],
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

  /** Sorted tap delays for the unit cube at a given speed of sound. */
  function delaysAt(c: number): number[] {
    const { verts, sizes, abs } = unitCubeFlat();
    const stride = mod.tap_stride();
    const p = new Float32Array([0.5, 0.5, 0.5]);
    const packed = mod.compute_room_taps(
      verts, sizes, abs, new Uint32Array(sizes.length), new Float32Array([]), p, p, 1, c,
    );
    const n = packed.length / stride;
    const ds: number[] = [];
    for (let i = 0; i < n; i++) ds.push(packed[i * stride]);
    return ds.sort((a, b) => a - b);
  }

  it('halving c roughly doubles every tap delay', () => {
    const fast = delaysAt(343);
    const slow = delaysAt(171.5);
    expect(fast.length).toBeGreaterThan(0);
    expect(slow.length).toBe(fast.length);
    for (let i = 0; i < fast.length; i++) {
      if (fast[i] < 1e-9) { expect(slow[i]).toBeLessThan(1e-6); continue; }
      expect(slow[i] / fast[i]).toBeCloseTo(2, 1); // ~2× at half c
    }
  });
});

describe('Cathedral + slow-sound builtins', () => {
  it('Cathedral loads, is large, and uses a hard material', () => {
    const lvl = getBuiltin('cathedral')!;
    expect(lvl).toBeDefined();
    expect(isLevel(lvl)).toBe(true);
    expect(() => loadLevel(lvl)).not.toThrow();
    const volume = lvl.room.width * lvl.room.depth * lvl.room.height;
    expect(volume).toBeGreaterThan(5000); // a vast space ⇒ long RT60
    expect(['marble', 'tile', 'glass', 'concrete']).toContain(lvl.roomMaterial);
  });

  it('the slow-sound vault has a sub-343 c that threads through load', () => {
    const lvl = getBuiltin('slow-sound-vault')!;
    expect(lvl.speedOfSound).toBeGreaterThan(1);
    expect(lvl.speedOfSound!).toBeLessThan(343);
    expect(loadLevel(lvl).speedOfSound).toBe(lvl.speedOfSound);
  });
});
