/**
 * PERFORMANCE BENCH for Question A (docs/engine/reverb-and-order-analysis.md):
 * the real per-refresh cost of raising the modeled beacon's image-source order on
 * the HEAVIEST authored levels (open-street, cathedral, clap-maze) at maxOrder 1/2/3.
 *
 * Uses loadLevel() so the wall list is exactly what the solver sees (interior walls
 * are double-sided → both faces are real reflectors). Calls the WASM core directly
 * (loaded from disk, mirroring reflectorAcoustics/speedOfSound) to avoid the double-
 * init OOM, and builds the IR via buildRoomIrWasm with tail:false (the beacon path).
 *
 * Run: npx vitest run tests/orderCostBench.test.ts  (table prints to stderr).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { getBuiltin } from '../src/level/builtins';
import { loadLevel } from '../src/level/load';
import { buildRoomIrWasm } from '../src/engine/acoustics/roomIr';
import { markAcousticsReady, type Tap } from '../src/engine/acoustics/core';
import { NUM_BANDS } from '../src/engine/acoustics/materials';
import type { HrtfSet } from '../src/engine/hrtf/sofa';

let mod: typeof import('../src/engine/acoustics/wasm/acoustics_core.js');
let stride = 0;

beforeAll(async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const wasmDir = resolve(here, '../src/engine/acoustics/wasm');
  mod = await import(resolve(wasmDir, 'acoustics_core.js'));
  await mod.default(readFileSync(resolve(wasmDir, 'acoustics_core_bg.wasm')));
  stride = mod.tap_stride();
  markAcousticsReady(); // let buildRoomIr use the WASM (build_room_ir) path
});

/** 256-tap, 26-direction synthetic HRTF (matches roomIrBench's realistic set). */
function realisticHrtf(count = 26, taps = 256): HrtfSet {
  const dirs = new Float32Array(count * 3);
  const irs = new Float32Array(count * 2 * taps);
  for (let m = 0; m < count; m++) {
    const a = (m / count) * Math.PI * 2;
    dirs[m * 3] = Math.sin(a);
    dirs[m * 3 + 1] = 0;
    dirs[m * 3 + 2] = -Math.cos(a);
    for (let r = 0; r < 2; r++) {
      const base = (m * 2 + r) * taps;
      let seed = 1234 + m * 7 + r;
      for (let i = 0; i < 40; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        irs[base + i] = ((seed / 0x7fffffff) * 2 - 1) * Math.exp(-i / 12);
      }
    }
  }
  return { sampleRate: 48000, taps, count, dirs, irs };
}

function unpack(packed: Float32Array): Tap[] {
  const out: Tap[] = [];
  for (let i = 0; i < packed.length / stride; i++) {
    const o = i * stride;
    const bandGains: number[] = [];
    for (let b = 0; b < NUM_BANDS; b++) bandGains.push(packed[o + 6 + b]);
    out.push({
      delay: packed[o], gain: packed[o + 1],
      dir: [packed[o + 2], packed[o + 3], packed[o + 4]],
      order: packed[o + 5], bandGains,
    });
  }
  return out;
}

/** Solve a loaded level's room taps at `order` via the WASM core directly. */
function solve(
  walls: ReturnType<typeof loadLevel>['walls'],
  edges: ReturnType<typeof loadLevel>['edges'],
  listener: [number, number, number],
  source: [number, number, number],
  order: number,
): Tap[] {
  const verts: number[] = [], sizes: number[] = [], abs: number[] = [], ds: number[] = [];
  for (const w of walls) {
    sizes.push(w.verts.length);
    for (const v of w.verts) verts.push(v[0], v[1], v[2]);
    for (let b = 0; b < NUM_BANDS; b++) abs.push(w.absorption[b]);
    ds.push(w.doubleSided ? 1 : 0);
  }
  const e: number[] = [];
  for (const ed of edges) e.push(ed[0][0], ed[0][1], ed[0][2], ed[1][0], ed[1][1], ed[1][2]);
  const packed = mod.compute_room_taps(
    new Float32Array(verts), new Uint32Array(sizes), new Float32Array(abs),
    new Uint32Array(ds), new Float32Array(e),
    new Float32Array(listener), new Float32Array(source), order, 343,
  );
  return unpack(packed);
}

function timed(fn: () => void, iters: number): number {
  for (let i = 0; i < 3; i++) fn(); // warm
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  return (performance.now() - t0) / iters;
}

describe('image-source order cost on the heaviest authored levels', () => {
  const LEVELS = ['open-street', 'cathedral', 'clap-maze'];
  const ITERS = 40;

  it('measures taps / solve / IR-build / total per order', () => {
    const hrtf = realisticHrtf();
    const rows: string[] = [];
    rows.push('level         | walls(solver) | order | taps | solve ms | IR-build ms | total ms');
    rows.push('--------------|---------------|-------|------|----------|-------------|---------');

    for (const id of LEVELS) {
      const lvl = getBuiltin(id)!;
      const loaded = loadLevel(lvl);
      const { walls, edges } = loaded;
      // Listener: level start, head height. Source: the beacon, head height.
      const listener: [number, number, number] = [lvl.start.x, 1.6, lvl.start.z];
      const b = loaded.game.beacon;
      const source: [number, number, number] = [b.x, 1.6, b.z];

      for (const order of [1, 2, 3]) {
        const solveMs = timed(() => { solve(walls, edges, listener, source, order); }, ITERS);
        const taps = solve(walls, edges, listener, source, order);
        const buildMs = timed(() => { buildRoomIrWasm(taps, hrtf, { yaw: 0, scattering: loaded.scattering, tail: false }); }, ITERS);
        const total = solveMs + buildMs;
        rows.push(
          `${id.padEnd(13)} | ${String(walls.length).padEnd(13)} | ${String(order).padEnd(5)} | ${String(taps.length).padEnd(4)} | ${solveMs.toFixed(2).padEnd(8)} | ${buildMs.toFixed(2).padEnd(11)} | ${total.toFixed(2)}`,
        );
        expect(taps.length).toBeGreaterThan(0);
      }
    }
    // eslint-disable-next-line no-console
    console.error('\n' + rows.join('\n') + '\n');
  });
});
