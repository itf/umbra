/**
 * HEAVY Steam hot-swap — Game.setSpatialBackend.
 *
 * Verifies the engine-swap on a RUNNING level WITHOUT restarting it:
 *  - it PRESERVES game state (won/caught/decoysLeft/audioYaw) across the swap,
 *  - it rebuilds the beacon units on the new backend (tears down + recreates),
 *  - a won run rebuilds beacons already faded (output gain 0).
 *
 * Steam Audio itself can't run headless, so the swap target is a FAKE SpatialBackend
 * whose sources are plain gain nodes — enough to verify the wiring/teardown/state
 * flow, which is what this hot-swap is about (real audio is ear-tested in preview).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadLevel } from '../src/level/load';
import { emptyLevel } from '../src/level/schema';
import { sphericalToVec, type HrtfSet } from '../src/engine/hrtf/sofa';
import type { SpatialBackend } from '../src/game/game';

const here = dirname(fileURLToPath(import.meta.url));

let OAC: any = null;
try { ({ OfflineAudioContext: OAC } = await import('node-web-audio-api')); } catch { /* skip */ }

function loadHrtf(path: string): HrtfSet {
  const data = readFileSync(path);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = 8;
  const sampleRate = dv.getFloat32(o, true); o += 4;
  const count = dv.getUint32(o, true); o += 4;
  const taps = dv.getUint32(o, true); o += 4;
  const dirs = new Float32Array(count * 3);
  for (let m = 0; m < count; m++) {
    const az = dv.getFloat32(o, true); o += 4;
    const el = dv.getFloat32(o, true); o += 4;
    const [x, y, z] = sphericalToVec(az, el);
    dirs[m * 3] = x; dirs[m * 3 + 1] = y; dirs[m * 3 + 2] = z;
  }
  const irs = new Float32Array(count * 2 * taps);
  for (let i = 0; i < irs.length; i++) { irs[i] = dv.getFloat32(o, true); o += 4; }
  return { sampleRate, taps, count, dirs, irs };
}

const d = OAC ? describe : describe.skip;

d('Game.setSpatialBackend (HEAVY hot-swap)', () => {
  let Game: typeof import('../src/game/game').Game;
  let HrtfRenderer: typeof import('../src/engine/hrtf/renderer').HrtfRenderer;
  let hrtf: HrtfSet;

  beforeAll(async () => {
    const wasmDir = resolve(here, '../src/engine/acoustics/wasm');
    const mod = await import(resolve(wasmDir, 'acoustics_core.js'));
    await mod.default(readFileSync(resolve(wasmDir, 'acoustics_core_bg.wasm')));
    const { initAcoustics } = await import('../src/engine/acoustics/core');
    await initAcoustics().catch(() => {});
    ({ Game } = await import('../src/game/game'));
    ({ HrtfRenderer } = await import('../src/engine/hrtf/renderer'));
    hrtf = loadHrtf(resolve(here, '../assets/hrtf/sadie_h3.hrtf'));
  });

  function makeGraph() {
    const ctx = new OAC(2, hrtf.sampleRate, hrtf.sampleRate);
    const master = ctx.createGain(); master.connect(ctx.destination);
    const renderer = HrtfRenderer.fromSet(ctx, hrtf);
    return { graph: { ctx, master } as any, renderer, ctx };
  }

  /**
   * A minimal in-memory SpatialBackend whose sources are plain gain nodes. `state`
   * tracks how many sources were created (live) and the last per-source reflection wet
   * level stored — enough to verify rebuilds + the wet-level dispatch.
   */
  function fakeBackend(ctx: any): {
    backend: SpatialBackend;
    state: { created: number; live: number; wetLevel: number | null; busLevels: [number, number] | null };
  } {
    const state = { created: 0, live: 0, wetLevel: null as number | null, busLevels: null as [number, number] | null };
    const backend: SpatialBackend = {
      createSource: () => {
        state.created += 1;
        state.live += 1;
        const input = ctx.createGain();
        const output = ctx.createGain();
        input.connect(output);
        return {
          input, output,
          setPosition: () => {},
          dispose: () => { state.live -= 1; try { input.disconnect(); } catch { /* */ } },
        };
      },
      setGeometry: () => {},
      setListener: () => {},
      step: () => {},
      setBusLevels: (refl, reverb) => { state.busLevels = [refl, reverb]; },
      setReflectionWetLevel: (v) => { state.wetLevel = v; },
    };
    return { backend, state };
  }

  it('preserves decoysLeft and rebuilds the beacon unit on swap to a fake backend', () => {
    const { graph, renderer, ctx } = makeGraph();
    const lvl = { ...emptyLevel('one'), decoyBudget: 3 };
    const game = new Game(graph, renderer, loadLevel(lvl).game);

    // Spend a decoy, so we can prove the budget survives the swap (not reset to 3).
    game.throwDecoy(0);
    expect(game.decoyBudget).toBe(2);

    const beaconsBefore = (game as any).beacons as any[];
    expect(beaconsBefore).toHaveLength(1);
    const oldUnit = beaconsBefore[0];

    const { backend } = fakeBackend(ctx);
    game.setSpatialBackend(backend);

    const beaconsAfter = (game as any).beacons as any[];
    expect(beaconsAfter).toHaveLength(1);
    // A genuinely NEW unit was built (old torn down), now using the steam branch.
    expect(beaconsAfter[0]).not.toBe(oldUnit);
    expect(beaconsAfter[0].steam).not.toBeNull();
    expect(beaconsAfter[0].voice).not.toBeNull();
    // CRITICAL: budget preserved (setDecoyBudget must NOT be called on swap).
    expect(game.decoyBudget).toBe(2);
    expect((game as any).steam).toBe(backend);
    game.destroy();
  });

  it('swapping back to null returns to our (non-steam) beacon, state intact', () => {
    const { graph, renderer, ctx } = makeGraph();
    const game = new Game(graph, renderer, loadLevel(emptyLevel('one')).game);
    const { backend } = fakeBackend(ctx);
    game.setSpatialBackend(backend);
    expect((game as any).beacons[0].steam).not.toBeNull();
    game.setSpatialBackend(null);
    const u = (game as any).beacons[0];
    expect(u.steam).toBeNull();
    expect(u.plain ?? u.interp ?? u.modeled).not.toBeNull();
    game.destroy();
  });

  it('a WON run rebuilds beacons already faded (output gain 0) and keeps won', () => {
    const { graph, renderer, ctx } = makeGraph();
    const loaded = loadLevel(emptyLevel('one'));
    // Start ON the beacon so the first real step wins.
    const gl = { ...loaded.game, start: { x: loaded.game.beacon.x, z: loaded.game.beacon.z, yaw: 0 } };
    const game = new Game(graph, renderer, gl);
    game.step('R', 0);
    game.step('L', 1000);
    expect((game as any).won).toBe(true);

    const { backend } = fakeBackend(ctx);
    game.setSpatialBackend(backend);
    // Still won after the swap, and the rebuilt beacon is muted (not re-un-muted).
    expect((game as any).won).toBe(true);
    const u = (game as any).beacons[0];
    expect(u.output.gain.value).toBe(0);
    game.destroy();
  });

  it('preserves audioYaw across the swap', () => {
    const { graph, renderer, ctx } = makeGraph();
    const game = new Game(graph, renderer, loadLevel(emptyLevel('one')).game);
    game.setYaw(1.234);
    expect((game as any).audioYaw).toBeCloseTo(1.234, 5);
    const { backend } = fakeBackend(ctx);
    game.setSpatialBackend(backend);
    expect((game as any).audioYaw).toBeCloseTo(1.234, 5);
    game.destroy();
  });

  it('setSteamReflectionWet stores the wet level + REBUILDS the voices, preserving state', () => {
    const { graph, renderer, ctx } = makeGraph();
    const lvl = { ...emptyLevel('one'), decoyBudget: 3 };
    const game = new Game(graph, renderer, loadLevel(lvl).game);
    const { backend, state } = fakeBackend(ctx);
    game.setSpatialBackend(backend);

    // Spend a decoy + turn the head so we can prove state survives the rebuild.
    game.throwDecoy(0);
    game.setYaw(0.5);
    expect(game.decoyBudget).toBe(2);

    const createdBefore = state.created;
    const oldUnit = (game as any).beacons[0];

    game.setSteamReflectionWet(0.3);

    // The backend stored the new per-source wet level…
    expect(state.wetLevel).toBe(0.3);
    // …and a genuinely NEW beacon unit was built (old one torn down) so the rebuilt
    // source bakes the updated wet. (`created` advanced; the unit object changed.)
    expect(state.created).toBeGreaterThan(createdBefore);
    const newUnit = (game as any).beacons[0];
    expect(newUnit).not.toBe(oldUnit);
    expect(newUnit.steam).not.toBeNull();
    // CRITICAL: game state preserved across the rebuild (budget + yaw, same backend).
    expect(game.decoyBudget).toBe(2);
    expect((game as any).audioYaw).toBeCloseTo(0.5, 5);
    expect((game as any).steam).toBe(backend);
    game.destroy();
  });

  it('setSteamReflectionWet is a no-op when no Steam backend is active', () => {
    const { graph, renderer } = makeGraph();
    const game = new Game(graph, renderer, loadLevel(emptyLevel('one')).game);
    const oldUnit = (game as any).beacons[0];
    // No steam backend → must NOT rebuild (would otherwise drop the our-engine voice).
    game.setSteamReflectionWet(0.3);
    expect((game as any).beacons[0]).toBe(oldUnit);
    game.destroy();
  });
});
