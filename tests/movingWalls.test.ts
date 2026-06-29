import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { emptyLevel, type WallObj, isLevel } from '../src/level/schema';
import {
  loadLevel, wallSegmentAt, wallsAt, movingGeometrySignature, levelHasMovingWalls,
  liveRebuildSignature, POSE_POS_QUANTUM, POSE_YAW_QUANTUM,
} from '../src/level/load';
import { computeRoomTaps, initAcoustics } from '../src/engine/acoustics/core';
import { buildRoomIr } from '../src/engine/acoustics/roomIr';
import type { HrtfSet } from '../src/engine/hrtf/sofa';

beforeAll(async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const wasmDir = resolve(here, '../src/engine/acoustics/wasm');
  const mod = await import(resolve(wasmDir, 'acoustics_core.js'));
  const bytes = readFileSync(resolve(wasmDir, 'acoustics_core_bg.wasm'));
  await mod.default(bytes);
  await initAcoustics().catch(() => {});
});

const STATIC_WALL: WallObj = { id: 'w', ax: 0, az: 0, bx: 4, bz: 0, material: 'brick' };

describe('time → wall geometry (pure)', () => {
  it('a wall with no motion is static for all t', () => {
    for (const t of [0, 1, 2.5, 100]) {
      expect(wallSegmentAt(STATIC_WALL, t)).toEqual({ ax: 0, az: 0, bx: 4, bz: 0 });
    }
  });

  it('translate ping-pong: rest at 0, full offset at half period, rest at full period', () => {
    const w: WallObj = { ...STATIC_WALL, motion: { kind: 'translate', dx: 2, dz: 0, period: 4 } };
    expect(wallSegmentAt(w, 0)).toEqual({ ax: 0, az: 0, bx: 4, bz: 0 });
    // half period (t=2) → fully shifted by (dx,dz).
    expect(wallSegmentAt(w, 2)).toMatchObject({ ax: 2, bx: 6 });
    // full period (t=4) → back to rest.
    const back = wallSegmentAt(w, 4);
    expect(back.ax).toBeCloseTo(0, 6);
    expect(back.bx).toBeCloseTo(4, 6);
  });

  it('translate stays within [rest, rest+offset] bounds across a cycle', () => {
    const w: WallObj = { ...STATIC_WALL, motion: { kind: 'translate', dx: 3, dz: -1, period: 5 } };
    for (let t = 0; t <= 10; t += 0.1) {
      const s = wallSegmentAt(w, t);
      expect(s.ax).toBeGreaterThanOrEqual(-1e-9);
      expect(s.ax).toBeLessThanOrEqual(3 + 1e-9);
      expect(s.az).toBeGreaterThanOrEqual(-1 - 1e-9);
      expect(s.az).toBeLessThanOrEqual(1e-9);
    }
  });

  it('slide door: closed at 0, fully open at half period, closed again at full period', () => {
    const w: WallObj = { ...STATIC_WALL, motion: { kind: 'slide', openFraction: 1, period: 4 } };
    // closed: b at original
    expect(wallSegmentAt(w, 0)).toEqual({ ax: 0, az: 0, bx: 4, bz: 0 });
    // fully open: b retracted all the way to a (full openFraction).
    const open = wallSegmentAt(w, 2);
    expect(open.bx).toBeCloseTo(0, 6);
    expect(open.bz).toBeCloseTo(0, 6);
    // closed again
    expect(wallSegmentAt(w, 4).bx).toBeCloseTo(4, 6);
  });

  it('slide honours partial openFraction', () => {
    const w: WallObj = { ...STATIC_WALL, motion: { kind: 'slide', openFraction: 0.5, period: 4 } };
    const open = wallSegmentAt(w, 2); // max open = 50% retracted → b at x=2
    expect(open.bx).toBeCloseTo(2, 6);
  });
});

describe('level geometry over time', () => {
  it('old levels (no motion) yield identical geometry to before, at any t', () => {
    const lvl = emptyLevel();
    lvl.walls.push(STATIC_WALL);
    const base = loadLevel(lvl).walls;
    for (const t of [0, 1, 3.3, 50]) {
      const at = wallsAt(lvl, t);
      expect(at).toEqual(base);
    }
    expect(levelHasMovingWalls(lvl)).toBe(false);
  });

  it('a moving wall is detected and changes geometry over time', () => {
    const lvl = emptyLevel();
    lvl.walls.push({ ...STATIC_WALL, motion: { kind: 'translate', dx: 2, dz: 0, period: 4 } });
    expect(levelHasMovingWalls(lvl)).toBe(true);
    const a = wallsAt(lvl, 0);
    const b = wallsAt(lvl, 2);
    expect(JSON.stringify(a)).not.toEqual(JSON.stringify(b));
  });

  it('isLevel: old levels without motion validate and load identically; motion is valid and preserved', () => {
    // (1) An old level with NO motion field validates and round-trips byte-identically.
    const old = emptyLevel();
    old.walls.push({ ...STATIC_WALL }); // no motion
    const oldRound = JSON.parse(JSON.stringify(old));
    expect(isLevel(oldRound)).toBe(true);
    expect(oldRound.walls[0].motion).toBeUndefined();
    expect(loadLevel(oldRound).walls).toEqual(loadLevel(old).walls);

    // (2) A level WITH motion passes isLevel and the motion field survives the round-trip.
    const moving = emptyLevel();
    moving.walls.push({ ...STATIC_WALL, motion: { kind: 'slide', openFraction: 1, period: 4 } });
    const round = JSON.parse(JSON.stringify(moving));
    expect(isLevel(round)).toBe(true);
    expect(round.walls[0].motion).toEqual({ kind: 'slide', openFraction: 1, period: 4 });
  });
});

describe('dirty-check signature', () => {
  it('static level → constant signature (no rebuild ever)', () => {
    const lvl = emptyLevel();
    lvl.walls.push(STATIC_WALL);
    expect(movingGeometrySignature(lvl, 0)).toEqual(movingGeometrySignature(lvl, 5));
    expect(movingGeometrySignature(lvl, 0)).toEqual(''); // no moving walls contribute
  });

  it('moving level → signature changes when the wall moves, stable when it does not', () => {
    const lvl = emptyLevel();
    lvl.walls.push({ ...STATIC_WALL, motion: { kind: 'translate', dx: 2, dz: 0, period: 4 } });
    const s0 = movingGeometrySignature(lvl, 0);
    const s1 = movingGeometrySignature(lvl, 2);
    expect(s0).not.toEqual(s1);
    // Same time → same signature (deterministic).
    expect(movingGeometrySignature(lvl, 2)).toEqual(s1);
  });
});

describe('live dirty-check keys on walls AND listener pose', () => {
  const POSE = { x: 3, z: 6, yaw: 0.4 };

  it('static walls + static listener → identical signature (no rebuild)', () => {
    const lvl = emptyLevel();
    lvl.walls.push(STATIC_WALL);
    expect(liveRebuildSignature(lvl, 0, POSE)).toEqual(liveRebuildSignature(lvl, 5, POSE));
  });

  it('rebuild needed when ONLY the listener moves materially (walls static)', () => {
    const lvl = emptyLevel();
    lvl.walls.push(STATIC_WALL); // no motion → geometry constant
    const base = liveRebuildSignature(lvl, 0, POSE);
    // Move well past the position quantum.
    const movedPos = liveRebuildSignature(lvl, 0, { ...POSE, x: POSE.x + POSE_POS_QUANTUM * 4 });
    expect(movedPos).not.toEqual(base);
    // Turn well past the yaw quantum.
    const movedYaw = liveRebuildSignature(lvl, 0, { ...POSE, yaw: POSE.yaw + POSE_YAW_QUANTUM * 4 });
    expect(movedYaw).not.toEqual(base);
  });

  it('no rebuild when the listener moves sub-quantum (jitter)', () => {
    const lvl = emptyLevel();
    lvl.walls.push(STATIC_WALL);
    const base = liveRebuildSignature(lvl, 0, POSE);
    const jittered = liveRebuildSignature(lvl, 0, {
      x: POSE.x + POSE_POS_QUANTUM * 0.1,
      z: POSE.z - POSE_POS_QUANTUM * 0.1,
      yaw: POSE.yaw + POSE_YAW_QUANTUM * 0.1,
    });
    expect(jittered).toEqual(base);
  });

  it('rebuild needed when ONLY the walls move (listener static)', () => {
    const lvl = emptyLevel();
    lvl.walls.push({ ...STATIC_WALL, motion: { kind: 'translate', dx: 2, dz: 0, period: 4 } });
    expect(liveRebuildSignature(lvl, 0, POSE)).not.toEqual(liveRebuildSignature(lvl, 2, POSE));
  });
});

describe('acoustics respond to motion', () => {
  const listener: [number, number, number] = [3, 1.6, 6];

  it('moving wall produces DIFFERENT taps at two times; identical when unmoved', () => {
    const lvl = emptyLevel();
    lvl.walls.push({ ...STATIC_WALL, ax: 1, az: 3, bx: 5, bz: 3, motion: { kind: 'translate', dx: 0, dz: 2, period: 4 } });

    const tapsAt = (t: number) =>
      computeRoomTaps({ walls: wallsAt(lvl, t), listener, source: listener, maxOrder: 2 });

    const t0 = tapsAt(0);
    const tHalf = tapsAt(2); // wall fully shifted
    const delays0 = t0.map((x) => x.delay).sort((a, b) => a - b);
    const delaysHalf = tHalf.map((x) => x.delay).sort((a, b) => a - b);
    expect(delays0).not.toEqual(delaysHalf);

    // Identical when geometry is the same (t=0 vs t=period).
    const tFull = tapsAt(4);
    const delaysFull = tFull.map((x) => x.delay).sort((a, b) => a - b);
    delays0.forEach((d, i) => expect(delaysFull[i]).toBeCloseTo(d, 5));
  });
});

/** Minimal 256-tap HRTF so the IR build does real convolution work. */
function realisticHrtf(count = 26, taps = 256): HrtfSet {
  const dirs = new Float32Array(count * 3);
  const irs = new Float32Array(count * 2 * taps);
  for (let m = 0; m < count; m++) {
    const a = (m / count) * Math.PI * 2;
    dirs[m * 3] = Math.sin(a); dirs[m * 3 + 1] = 0; dirs[m * 3 + 2] = -Math.cos(a);
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

describe('per-rebuild cost (solve + IR build) for a moving-wall room', () => {
  it('fits the throttle budget', () => {
    const hrtf = realisticHrtf();
    const lvl = emptyLevel();
    lvl.room = { width: 6, depth: 8, height: 3 };
    lvl.walls.push({ id: 'd', ax: 1, az: 4, bx: 5, bz: 4, material: 'wood', motion: { kind: 'slide', openFraction: 1, period: 4 } });
    const listener: [number, number, number] = [3, 1.6, 6];

    const rebuild = (t: number) => {
      const walls = wallsAt(lvl, t);
      const taps = computeRoomTaps({ walls, listener, source: listener, maxOrder: 2 });
      buildRoomIr(taps, hrtf, { yaw: 0, scattering: 0.3 });
    };
    // warm
    for (let i = 0; i < 3; i++) rebuild(i * 0.1);
    const iters = 30;
    const t0 = performance.now();
    for (let i = 0; i < iters; i++) rebuild(0.05 + i * 0.05);
    const perMs = (performance.now() - t0) / iters;
    // eslint-disable-next-line no-console
    console.error(`moving-wall rebuild (solve+IR, order 2): ${perMs.toFixed(2)} ms/rebuild`);
    // Generous ceiling — Node is slower than the browser; the point is it is well
    // under the 70 ms throttle interval (~14 Hz), so a rebuild never stacks.
    expect(perMs).toBeLessThan(70);
  });
});
