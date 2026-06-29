/**
 * Proves the MODELED beacon (Phase 1) is acoustically real: through the REAL WASM
 * solver, when a wall OCCLUDES the beacon the order-0 DIRECT tap is ABSENT and at
 * least one diffraction (order≥1) tap exists; with clear line of sight the direct
 * tap is PRESENT. This is exactly the occlusion+diffraction transition the feature
 * delivers. We call the wasm `compute_room_taps` directly (the OOM-on-double-init
 * gotcha — never call the JS wrapper's initAcoustics in the same process).
 *
 * Also unit-tests the ModeledSource dirty-check/throttle signature (pure) and a
 * perf/bench for the per-refresh solve+IR-build cost.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { getBuiltin } from '../src/level/builtins';
import { loadLevel } from '../src/level/load';
import { modeledRefreshSignature } from '../src/engine/acoustics/modeledSource';
import { buildRoomIrWasm } from '../src/engine/acoustics/roomIr';
import { markAcousticsReady, type Tap } from '../src/engine/acoustics/core';
import type { HrtfSet } from '../src/engine/hrtf/sofa';

const NB = 8;
let mod: typeof import('../src/engine/acoustics/wasm/acoustics_core.js');

beforeAll(async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const wasmDir = resolve(here, '../src/engine/acoustics/wasm');
  mod = await import(resolve(wasmDir, 'acoustics_core.js'));
  await mod.default(readFileSync(resolve(wasmDir, 'acoustics_core_bg.wasm')));
  // Mark the JS wrapper ready so buildRoomIrWasm uses the WASM IR path (it shares
  // the same module instance loaded above).
  markAcousticsReady();
});

/** Run the WASM room solver for the clap-maze geometry at a listener/beacon pair. */
function solve(
  walls: ReturnType<typeof loadLevel>['walls'],
  edges: ReturnType<typeof loadLevel>['edges'],
  listener: [number, number, number],
  source: [number, number, number],
  maxOrder: number,
): Tap[] {
  const verts: number[] = [], sizes: number[] = [], abs: number[] = [], ds: number[] = [];
  for (const w of walls) {
    sizes.push(w.verts.length);
    for (const v of w.verts) verts.push(v[0], v[1], v[2]);
    for (let b = 0; b < NB; b++) abs.push(w.absorption[b]);
    ds.push(w.doubleSided ? 1 : 0);
  }
  const edgeArr: number[] = [];
  for (const e of edges) edgeArr.push(e[0][0], e[0][1], e[0][2], e[1][0], e[1][1], e[1][2]);
  const packed = mod.compute_room_taps(
    new Float32Array(verts), new Uint32Array(sizes), new Float32Array(abs),
    new Uint32Array(ds), new Float32Array(edgeArr),
    new Float32Array(listener), new Float32Array(source), maxOrder, 343,
  );
  const stride = mod.tap_stride();
  const out: Tap[] = [];
  for (let i = 0; i < packed.length / stride; i++) {
    const o = i * stride;
    const bandGains: number[] = [];
    for (let b = 0; b < NB; b++) bandGains.push(packed[o + 6 + b]);
    out.push({
      delay: packed[o], gain: packed[o + 1],
      dir: [packed[o + 2], packed[o + 3], packed[o + 4]],
      order: packed[o + 5], bandGains,
    });
  }
  return out;
}

describe('modeled beacon occlusion + diffraction (clap-maze, real solver)', () => {
  const loaded = (() => {
    const lvl = getBuiltin('clap-maze');
    if (!lvl) throw new Error('clap-maze builtin missing');
    return loadLevel(lvl);
  })();
  const H = 1.6;
  // clap-maze: beacon at (5,1); wall w1 spans x=0..7 at z=12 (a gap at x>7). The
  // player starts at (5,15), behind w1 — the beacon at z=1 is occluded by w1.
  const beacon: [number, number, number] = [5, H, 1];

  it('drops the direct tap and keeps a diffraction tap when a wall occludes the beacon', () => {
    const listener: [number, number, number] = [5, H, 15]; // behind wall w1
    const taps = solve(loaded.walls, loaded.edges, listener, beacon, 1);
    const direct = taps.filter((t) => t.order === 0);
    const diffracted = taps.filter((t) => t.order >= 1);
    expect(direct.length).toBe(0); // occluded → no straight-line path
    expect(diffracted.length).toBeGreaterThan(0); // sound still leaks around edges
  });

  it('keeps the direct tap when there is clear line of sight to the beacon', () => {
    // Stand just in front of the beacon, past every maze wall (z < 4): clear LOS.
    const listener: [number, number, number] = [5, H, 3];
    const taps = solve(loaded.walls, loaded.edges, listener, beacon, 1);
    const direct = taps.filter((t) => t.order === 0);
    expect(direct.length).toBe(1); // visible → direct path present
  });

  it('the occluded beacon is materially quieter at the listener than the LOS beacon', () => {
    const occluded = solve(loaded.walls, loaded.edges, [5, H, 15], beacon, 1);
    const los = solve(loaded.walls, loaded.edges, [5, H, 3], beacon, 1);
    const energy = (taps: Tap[]) => taps.reduce((s, t) => s + t.gain * t.gain, 0);
    expect(energy(occluded)).toBeLessThan(energy(los));
  });
});

describe('ModeledSource dirty-check / throttle signature (pure)', () => {
  const base = {
    walls: loadLevel(getBuiltin('clap-maze')!).walls,
    edges: loadLevel(getBuiltin('clap-maze')!).edges,
    listener: [5, 1.6, 15] as [number, number, number],
    yaw: 0,
    source: [5, 1.6, 1] as [number, number, number],
  };

  it('is identical when nothing moved (no rebuild)', () => {
    expect(modeledRefreshSignature(base)).toBe(modeledRefreshSignature({ ...base }));
  });

  it('is unchanged for sub-quantum jitter (below 5 cm / ~2.5°)', () => {
    const jittered = {
      ...base,
      listener: [5.01, 1.6, 15.01] as [number, number, number],
      yaw: 0.01,
    };
    expect(modeledRefreshSignature(jittered)).toBe(modeledRefreshSignature(base));
  });

  it('changes when the listener moves past the quantum', () => {
    const moved = { ...base, listener: [5, 1.6, 14] as [number, number, number] };
    expect(modeledRefreshSignature(moved)).not.toBe(modeledRefreshSignature(base));
  });

  it('changes when the listener turns past the yaw quantum', () => {
    const turned = { ...base, yaw: 0.5 };
    expect(modeledRefreshSignature(turned)).not.toBe(modeledRefreshSignature(base));
  });

  it('changes when the source (beacon) moves', () => {
    const moved = { ...base, source: [6, 1.6, 1] as [number, number, number] };
    expect(modeledRefreshSignature(moved)).not.toBe(modeledRefreshSignature(base));
  });

  it('changes when the wall geometry moves (occlusion could change)', () => {
    const w = base.walls.map((wall) => ({ ...wall, verts: wall.verts.map((v) => [...v] as [number, number, number]) }));
    w[0].verts[0][0] += 1; // nudge a wall vertex 1 m
    const moved = { ...base, walls: w };
    expect(modeledRefreshSignature(moved)).not.toBe(modeledRefreshSignature(base));
  });
});

/** A small realistic HRTF set (mirrors roomIrBench) so the IR build does real work. */
function realisticHrtf(count = 26, taps = 256): HrtfSet {
  const dirs = new Float32Array(count * 3);
  const irs = new Float32Array(count * 2 * taps);
  for (let m = 0; m < count; m++) {
    const a = (m / count) * Math.PI * 2;
    dirs[m * 3] = Math.sin(a); dirs[m * 3 + 1] = 0; dirs[m * 3 + 2] = -Math.cos(a);
    for (let r = 0; r < 2; r++) {
      const baseI = (m * 2 + r) * taps;
      let seed = 1234 + m * 7 + r;
      for (let i = 0; i < 40; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        irs[baseI + i] = ((seed / 0x7fffffff) * 2 - 1) * Math.exp(-i / 12);
      }
    }
  }
  return { sampleRate: 48000, taps, count, dirs, irs };
}

describe('modeled beacon per-refresh cost (clap-maze, order 1)', () => {
  it('measures the solve + IR-build cost against the ~70ms throttle budget', () => {
    const loaded = loadLevel(getBuiltin('clap-maze')!);
    const hrtf = realisticHrtf();
    const listener: [number, number, number] = [5, 1.6, 15];
    const beacon: [number, number, number] = [5, 1.6, 1];

    const refresh = () => {
      const taps = solve(loaded.walls, loaded.edges, listener, beacon, 1);
      buildRoomIrWasm(taps, hrtf, { yaw: 0, scattering: 0.1, tail: false });
    };
    refresh(); // warm
    const iters = 50;
    const t0 = performance.now();
    for (let i = 0; i < iters; i++) refresh();
    const ms = (performance.now() - t0) / iters;
    // eslint-disable-next-line no-console
    console.error(`modeled beacon refresh (order 1): ${ms.toFixed(3)} ms/refresh`);
    // Sanity: it must be comfortably under the 70 ms throttle budget.
    expect(ms).toBeLessThan(70);
  });
});
