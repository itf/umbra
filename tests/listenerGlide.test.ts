import { describe, it, expect } from 'vitest';
import {
  glidePose,
  easeOutCubic,
  ListenerGlide,
  STEP_GLIDE_MS,
  type AudioPose,
} from '../src/game/listenerGlide';

describe('glidePose (pure interpolation)', () => {
  const from = { x: 0, z: 0 };
  const to = { x: 10, z: -4 };

  it('tNorm=0 returns from, tNorm=1 returns to', () => {
    expect(glidePose(from, to, 0)).toEqual(from);
    expect(glidePose(from, to, 1)).toEqual(to);
  });

  it('clamps tNorm outside [0,1]', () => {
    expect(glidePose(from, to, -1)).toEqual(from);
    expect(glidePose(from, to, 2)).toEqual(to);
  });

  it('is monotonic toward the target', () => {
    let prev = -Infinity;
    for (let t = 0; t <= 1.0001; t += 0.1) {
      const p = glidePose(from, to, t);
      expect(p.x).toBeGreaterThanOrEqual(prev);
      prev = p.x;
    }
  });

  it('stays within the from→to segment', () => {
    for (let t = 0; t <= 1; t += 0.05) {
      const p = glidePose(from, to, t);
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(10);
      // collinear: z = -0.4 * x
      expect(p.z).toBeCloseTo(-0.4 * p.x, 6);
    }
  });

  it('eases out: midpoint is past the linear midpoint', () => {
    const p = glidePose(from, to, 0.5);
    expect(p.x).toBeGreaterThan(5); // covers >half the distance by t=0.5
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875, 6);
  });

  it('easeOutCubic pins endpoints', () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
  });
});

describe('ListenerGlide controller', () => {
  function makeGlide(start: AudioPose) {
    const poses: AudioPose[] = [];
    const g = new ListenerGlide(start, (p) => poses.push({ x: p.x, z: p.z }), 200);
    return { g, poses };
  }

  it('advancing time moves the audio pose from start toward target', () => {
    const { g, poses } = makeGlide({ x: 0, z: 0 });
    g.start({ x: 0, z: 0 }, { x: 10, z: 0 }, 1000);
    g.tick(1000); // t=0
    g.tick(1100); // t=0.5
    expect(poses[poses.length - 1].x).toBeGreaterThan(0);
    expect(poses[poses.length - 1].x).toBeLessThan(10);
  });

  it('reaches the target at/after the duration and then idles', () => {
    const { g, poses } = makeGlide({ x: 0, z: 0 });
    g.start({ x: 0, z: 0 }, { x: 10, z: -2 }, 1000);
    g.tick(1200); // exactly at duration end
    expect(poses[poses.length - 1]).toEqual({ x: 10, z: -2 });
    expect(g.isActive).toBe(false);
    // Further ticks are no-ops (no new emits).
    const n = poses.length;
    g.tick(1300);
    expect(poses.length).toBe(n);
  });

  it('a retarget mid-glide starts from the current interpolated pose (no snap-back)', () => {
    const { g } = makeGlide({ x: 0, z: 0 });
    g.start({ x: 0, z: 0 }, { x: 10, z: 0 }, 0);
    g.tick(100); // midway, current x is partway to 10 (>0)
    const mid = g.current;
    expect(mid.x).toBeGreaterThan(0);
    expect(mid.x).toBeLessThan(10);
    // New step lands mid-glide: retarget FROM the current pose to a new target.
    g.start(g.current, { x: 20, z: 0 }, 100);
    // The first emit after retarget must not jump back to the old start (0).
    g.tick(110);
    expect(g.current.x).toBeGreaterThanOrEqual(mid.x - 1e-9);
    expect(g.current.x).toBeLessThan(20);
  });

  it('idle tick does nothing (no emit) before any glide starts', () => {
    const { g, poses } = makeGlide({ x: 3, z: 3 });
    g.tick(500);
    expect(poses.length).toBe(0);
    expect(g.isActive).toBe(false);
  });

  it('snap emits immediately and cancels any active glide', () => {
    const { g, poses } = makeGlide({ x: 0, z: 0 });
    g.start({ x: 0, z: 0 }, { x: 10, z: 0 }, 0);
    g.tick(50);
    g.snap({ x: 7, z: -1 });
    expect(g.isActive).toBe(false);
    expect(poses[poses.length - 1]).toEqual({ x: 7, z: -1 });
    g.tick(100); // no further movement
    expect(poses[poses.length - 1]).toEqual({ x: 7, z: -1 });
  });

  it('a zero-length glide collapses to an immediate emit at the target', () => {
    const { g, poses } = makeGlide({ x: 2, z: 2 });
    g.start({ x: 2, z: 2 }, { x: 2, z: 2 }, 0);
    expect(g.isActive).toBe(false);
    expect(poses[poses.length - 1]).toEqual({ x: 2, z: 2 });
  });

  it('STEP_GLIDE_MS is step-paced and ≤ the rush interval (220 ms)', () => {
    expect(STEP_GLIDE_MS).toBeGreaterThan(0);
    expect(STEP_GLIDE_MS).toBeLessThanOrEqual(220);
  });
});
