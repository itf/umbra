/**
 * "Find the absorber" mode — proves the foam wall-patch creates a measurable DEAD
 * SPOT in the room's reflections, and that the win condition / schema plumbing is
 * wired correctly.
 *
 * The acoustic claim: a clap in a concrete room produces a reflection bouncing off
 * the far (-z) wall. When a localized acoustic-foam patch is set into the spot where
 * that reflection lands, the energy arriving FROM THE PATCH DIRECTION (taps coming
 * from -z, in front of the listener) drops sharply vs the bare concrete wall. We
 * quantify the contrast through the REAL WASM room solver, calling it directly
 * (mirrors reflectorAcoustics.test.ts) so the module's `tap_stride` is initialised.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadLevel } from '../src/level/load';
import { isLevel, type Level } from '../src/level/schema';
import type { WallDef } from '../src/engine/acoustics/core';
import findTheFoam from '../src/levels/find-the-foam.json';

const here = dirname(fileURLToPath(import.meta.url));
const wasmDir = resolve(here, '../src/engine/acoustics/wasm');
let mod: typeof import('../src/engine/acoustics/wasm/acoustics_core.js');
const NB = 8;

beforeAll(async () => {
  mod = await import(resolve(wasmDir, 'acoustics_core.js'));
  await mod.default(readFileSync(resolve(wasmDir, 'acoustics_core_bg.wasm')));
});

interface Tap { delay: number; gain: number; dir: [number, number, number]; order: number; bandGains: number[]; }

/** Solve room taps via the WASM core directly (stride from the module). */
function roomTaps(walls: WallDef[], listener: number[], source: number[], maxOrder: number): Tap[] {
  const verts: number[] = [], sizes: number[] = [], abs: number[] = [], ds: number[] = [];
  for (const w of walls) {
    sizes.push(w.verts.length);
    for (const v of w.verts) verts.push(v[0], v[1], v[2]);
    for (let b = 0; b < NB; b++) abs.push(w.absorption[b]);
    ds.push(w.doubleSided ? 1 : 0);
  }
  const packed = mod.compute_room_taps(
    new Float32Array(verts), new Uint32Array(sizes), new Float32Array(abs),
    new Uint32Array(ds), new Float32Array([]),
    new Float32Array(listener), new Float32Array(source), maxOrder, 343,
  );
  const stride = mod.tap_stride();
  const taps: Tap[] = [];
  for (let i = 0; i < packed.length / stride; i++) {
    const o = i * stride;
    const bandGains: number[] = [];
    for (let b = 0; b < NB; b++) bandGains.push(packed[o + 6 + b]);
    taps.push({ delay: packed[o], gain: packed[o + 1], dir: [packed[o + 2], packed[o + 3], packed[o + 4]], order: packed[o + 5], bandGains });
  }
  return taps;
}

function parse(json: unknown): Level {
  const l = JSON.parse(JSON.stringify(json));
  expect(isLevel(l)).toBe(true);
  return l as Level;
}

/**
 * Total energy of taps arriving roughly from the -z direction (in front, toward the
 * far wall) — the direction of the far-wall bounce. Weighted by the 1 kHz band gain
 * (band 4), where acoustic foam absorbs ~fully, so the metric reflects the ear's cue.
 */
function farWallEnergy(taps: Tap[]): number {
  let e = 0;
  for (const t of taps) {
    if (t.order < 1) continue; // skip the direct clap
    if (t.dir[2] > -0.6) continue; // only taps from -z (in front)
    const g = t.gain * t.bandGains[4];
    e += g * g;
  }
  return e;
}

describe('find-the-absorber wall patch', () => {
  it('the foam patch splits the -z wall into distinct WallDefs incl. the absorber', () => {
    const loaded = loadLevel(parse(findTheFoam));
    const foam = loaded.walls.filter((w) => w.absorption[4] >= 0.99); // foam ≈ 1.0 @1kHz
    expect(foam.length).toBe(1);
    expect(loaded.walls.length).toBeGreaterThan(6); // wall was split into a grid
  });

  it('drops reflection energy from the patch direction vs bare wall', () => {
    const withFoam = loadLevel(parse(findTheFoam)).walls;
    const bare = loadLevel(parse({ ...findTheFoam, absorbers: [], goal: 'beacon' })).walls;

    // Clap in front of the foam patch (x≈8), a few metres off the far wall.
    const listener = [8, 1.6, 4];
    const tapsFoam = roomTaps(withFoam, listener, listener, 2);
    const tapsBare = roomTaps(bare, listener, listener, 2);

    const eFoam = farWallEnergy(tapsFoam);
    const eBare = farWallEnergy(tapsBare);

    expect(eBare).toBeGreaterThan(0); // the bare wall echoes
    expect(eFoam).toBeLessThan(eBare * 0.25); // dead spot: >75% of that energy gone
    // eslint-disable-next-line no-console
    console.log(`far-wall 1kHz energy — bare: ${eBare.toExponential(3)}, foam: ${eFoam.toExponential(3)}, ratio: ${(eFoam / eBare).toFixed(3)}`);
  });

  it('sets the win goal to the absorber world position, no beacon', () => {
    const loaded = loadLevel(parse(findTheFoam));
    expect(loaded.game.goal).toBe('absorber');
    expect(loaded.game.goalTarget?.x).toBeCloseTo(8, 5); // 6.5 + 3/2
    expect(loaded.game.goalTarget?.z).toBeCloseTo(0, 5);
  });

  it('normal beacon levels are unchanged (no goal field)', () => {
    const loaded = loadLevel(parse({ ...findTheFoam, goal: 'beacon', absorbers: [] }));
    expect(loaded.game.goal).toBeUndefined();
    expect(loaded.game.goalTarget).toBeUndefined();
    expect(loaded.walls.length).toBe(6); // 4 faces + floor + ceiling, none split
  });
});
