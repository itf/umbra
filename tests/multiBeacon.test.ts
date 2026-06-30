/**
 * MULTI-BEACON + DECOUPLED-WIN tests.
 *
 * The game now spatializes an ARRAY of uniform beacon units (each with its own
 * spatializer chosen by the same steam/modeled/interp/plain logic + its own voice),
 * and the WIN target is decoupled from any beacon (`winPoint`/`winTarget`).
 *
 * The load-mapping + win-target assertions are pure (no Web Audio). The
 * construction assertions build a REAL Game in an OfflineAudioContext (via
 * node-web-audio-api) with a real HRTF set, mirroring the artifact/wiggle tests.
 *
 * The CRITICAL guarantee under test: a length-1 beacon array is byte-identical to
 * the legacy single-beacon wiring (game.beacon deep-equals beacons[0]; winTarget
 * defaults to beacons[0]).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadLevel } from '../src/level/load';
import { getBuiltin } from '../src/level/builtins';
import { emptyLevel, type Level } from '../src/level/schema';
import { sphericalToVec, type HrtfSet } from '../src/engine/hrtf/sofa';

const here = dirname(fileURLToPath(import.meta.url));

// ---- pure load-mapping + win-target assertions -----------------------------

describe('loadLevel multi-beacon + win-target mapping', () => {
  it('maps ALL four beacon-garden beacons', () => {
    const lvl = getBuiltin('beacon-garden');
    if (!lvl) throw new Error('beacon-garden builtin missing');
    const { game } = loadLevel(lvl);
    expect(game.beacons).toHaveLength(4);
    // Each maps position/freq verbatim, in order.
    expect(game.beacons.map((b) => [b.x, b.z])).toEqual(
      lvl.beacons.map((b) => [b.x, b.z]),
    );
  });

  it('length-1 level: game.beacon deep-equals beacons[0] (byte-identical wiring)', () => {
    const lvl = emptyLevel('one-beacon'); // exactly one beacon
    const { game } = loadLevel(lvl);
    expect(game.beacons).toHaveLength(1);
    expect(game.beacon).toEqual(game.beacons[0]);
  });

  it('winTarget defaults to beacons[0] when no winPoint', () => {
    const lvl = emptyLevel('one-beacon');
    const { game } = loadLevel(lvl);
    expect(game.winTarget).toEqual({ x: game.beacons[0].x, z: game.beacons[0].z });
    expect(game.winTarget).toEqual({ x: game.beacon.x, z: game.beacon.z });
  });

  it('honours an explicit winPoint distinct from every beacon', () => {
    const lvl: Level = { ...emptyLevel('decoupled'), winPoint: { x: 1.25, z: 9.5 } };
    const { game } = loadLevel(lvl);
    expect(game.winTarget).toEqual({ x: 1.25, z: 9.5 });
    // The beacon position is unchanged (win is decoupled from it).
    expect(game.winTarget).not.toEqual({ x: game.beacon.x, z: game.beacon.z });
  });

  it('ZERO beacons: no beacon is synthesized (silent level)', () => {
    const lvl: Level = {
      ...emptyLevel('silent'),
      beacons: [],
      winPoint: { x: 3, z: 3 },
      winRadius: 1.2,
    };
    const { game } = loadLevel(lvl);
    // No audible sources — beacons[] stays empty (no legacy fallback beacon).
    expect(game.beacons).toHaveLength(0);
    // The win is the area, not a beacon.
    expect(game.winTarget).toEqual({ x: 3, z: 3 });
    expect(game.goalRadius).toBe(1.2);
  });

  it('winRadius falls back to the first beacon goalRadius, then to 0.9', () => {
    const withBeacon = loadLevel(emptyLevel('b')); // beacon goalRadius 0.8
    expect(withBeacon.game.goalRadius).toBe(0.8);
    const silent: Level = { ...emptyLevel('s'), beacons: [], winPoint: { x: 1, z: 1 } };
    expect(loadLevel(silent).game.goalRadius).toBe(0.9);
  });
});

// ---- real-Game construction (OfflineAudioContext) --------------------------

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

d('Game multi-beacon construction (OfflineAudioContext)', () => {
  let Game: typeof import('../src/game/game').Game;
  let HrtfRenderer: typeof import('../src/engine/hrtf/renderer').HrtfRenderer;
  let hrtf: HrtfSet;

  beforeAll(async () => {
    // Bring up the WASM acoustics core so the MODELED beacon path is real.
    const wasmDir = resolve(here, '../src/engine/acoustics/wasm');
    const mod = await import(resolve(wasmDir, 'acoustics_core.js'));
    await mod.default(readFileSync(resolve(wasmDir, 'acoustics_core_bg.wasm')));
    const { initAcoustics } = await import('../src/engine/acoustics/core');
    await initAcoustics().catch(() => {});
    ({ Game } = await import('../src/game/game'));
    ({ HrtfRenderer } = await import('../src/engine/hrtf/renderer'));
    hrtf = loadHrtf(resolve(here, '../assets/hrtf/sadie_h3.hrtf'));
  });

  /** A graph + renderer sharing one OfflineAudioContext at the HRTF's rate. */
  function makeGraph() {
    const ctx = new OAC(2, hrtf.sampleRate, hrtf.sampleRate);
    const master = ctx.createGain(); master.connect(ctx.destination);
    const renderer = HrtfRenderer.fromSet(ctx, hrtf);
    return { graph: { ctx, master } as any, renderer };
  }

  it('beacon-garden yields 4 units, each with a started BeaconVoice', () => {
    const { graph, renderer } = makeGraph();
    const lvl = getBuiltin('beacon-garden')!;
    const game = new Game(graph, renderer, loadLevel(lvl).game);
    const beacons = (game as any).beacons as any[];
    expect(beacons).toHaveLength(4);
    for (const u of beacons) {
      // A BeaconVoice was created + start()ed per unit (its `out` gain is connected).
      expect(u.voice).not.toBeNull();
      expect((u.voice as any).running).toBe(true);
    }
    game.destroy();
  });

  it('a geometry-bearing level gives each unit a MODELED handle (not plain)', () => {
    const { graph, renderer } = makeGraph();
    // Two beacons in a level WITH acoustic geometry → both must be modeled.
    const base = getBuiltin('beacon-garden')!;
    const loaded = loadLevel(base);
    const gl = {
      ...loaded.game,
      acousticWalls: loaded.walls,
      acousticEdges: loaded.edges,
      acousticScattering: loaded.scattering,
    };
    const game = new Game(graph, renderer, gl);
    const beacons = (game as any).beacons as any[];
    expect(beacons.length).toBeGreaterThan(1);
    for (const u of beacons) {
      expect(u.modeled).not.toBeNull();
      expect(u.plain).toBeNull();
    }
    game.destroy();
  });

  it('fade-on-win sets EVERY unit output gain target to 0', () => {
    const { graph, renderer } = makeGraph();
    const lvl = getBuiltin('beacon-garden')!;
    const loaded = loadLevel(lvl);
    // Win target = first beacon; start the player ON it so the first step wins.
    const gl = { ...loaded.game, start: { x: loaded.game.beacon.x, z: loaded.game.beacon.z, yaw: 0 } };
    let won = false;
    const game = new Game(graph, renderer, gl, { onWin: () => { won = true; } });
    const beacons = (game as any).beacons as any[];
    // Spy each unit's output gain so we can prove the win fade targets ALL of them.
    const spies = beacons.map((u) => {
      const orig = u.output.gain.setTargetAtTime.bind(u.output.gain);
      let target: number | null = null;
      u.output.gain.setTargetAtTime = (v: number, t: number, tc: number) => {
        target = v; return orig(v, t, tc);
      };
      return () => target;
    });
    // Step twice (settled foot then a real step) at the goal → checkWin fires.
    game.step('R', 0);
    game.step('L', 1000);
    expect(won).toBe(true);
    for (const getTarget of spies) {
      expect(getTarget()).toBe(0); // every unit faded to 0 on win
    }
    game.destroy();
  });

  it('ambient sources spawn a started voice and are NOT win targets', () => {
    const { graph, renderer } = makeGraph();
    const lvl: Level = {
      ...emptyLevel('amb'),
      beacons: [],
      winPoint: { x: 6, z: 2 },
      ambience: [{ id: 'fountain', x: 3, z: 5, sound: 'fountain', gain: 0.8 }],
    };
    const game = new Game(graph, renderer, loadLevel(lvl).game);
    const amb = (game as any).ambience as any[];
    expect(amb).toHaveLength(1);
    expect(amb[0].voice).not.toBeNull();
    expect((amb[0].voice as any).running).toBe(true);
    // No beacons exist (silent except the ambience).
    expect((game as any).beacons).toHaveLength(0);
    // setAmbientModulation targets the named source's duck gain + lowpass.
    game.setAmbientModulation('fountain', 0.4, 600);
    game.setAmbientModulation('nope', 0.4, 600); // unknown id is a no-op (no throw)
    game.destroy();
  });

  it('reaction events: react() while active scores a HIT, drives modulation + transients', () => {
    const { graph, renderer } = makeGraph();
    const lvl: Level = {
      ...emptyLevel('react'),
      beacons: [],
      winPoint: { x: 6, z: 2 },
      ambience: [{ id: 'fountain', x: 3, z: 5, sound: 'fountain', gain: 1 }],
      events: [{ id: 'e1', type: 'crossing', sourceId: 'fountain', start: 1, end: 3 }],
      requiredReactions: 1,
    };
    let outcome: string | null = null;
    const game = new Game(graph, renderer, loadLevel(lvl).game, {
      onReaction: (o) => { outcome = o; },
    });
    const base = (graph.ctx.currentTime * 1000);
    // Before the window: a press is a false alarm.
    expect(game.react(base + 0)).toBe('false-alarm');
    // Drive tick into the active window (start transient + duck applied), then react.
    game.tick(base + 2000);
    expect(game.react(base + 2000)).toBe('hit');
    expect(outcome).toBe('hit');
    expect(game.reactionScore().hits).toBe(1);
    // Tick past the window end → the source restores (no throw); miss count stays 0.
    game.tick(base + 3500);
    expect(game.reactionScore().misses).toBe(0);
    game.destroy();
  });
});
