import { describe, it, expect } from 'vitest';
import { offAxisStartYaw, MIN_START_OFFSET, MAX_START_OFFSET } from '../src/level/load';

/** Signed smallest angle from heading `yaw` to the bearing of `target` from `start`. */
function offAxisAngle(
  start: { x: number; z: number },
  yaw: number,
  target: { x: number; z: number },
): number {
  const bearing = Math.atan2(target.x - start.x, -(target.z - start.z));
  let d = bearing - yaw;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return Math.abs(d);
}

describe('offAxisStartYaw — the goal must never be dead-ahead at start', () => {
  it('nudges a straight-ahead goal to between MIN and MAX offset off the heading', () => {
    // Start facing -z (yaw 0); goal straight ahead at -z (dead-on).
    const start = { x: 5, z: 10, yaw: 0 };
    const target = { x: 5, z: 2 }; // directly in front (−z)
    const yaw = offAxisStartYaw(start, target);
    const off = offAxisAngle(start, yaw, target);
    expect(off).toBeGreaterThan(MIN_START_OFFSET - 1e-9);
    expect(off).toBeLessThanOrEqual(MAX_START_OFFSET + 1e-9);
  });

  it('leaves a start yaw unchanged when the goal is ALREADY more than 5° off', () => {
    const start = { x: 5, z: 10, yaw: 0 }; // facing -z
    const target = { x: 12, z: 10 };        // 90° to the right — already well off-axis
    expect(offAxisStartYaw(start, target)).toBe(0);
  });

  it('a goal just past 5° off is left alone (no needless spin)', () => {
    // Put the goal ~10° to the right of -z: bearing ≈ +10°, heading 0 → 10° off (>5°).
    const ten = (10 * Math.PI) / 180;
    const start = { x: 0, z: 0, yaw: 0 };
    const target = { x: Math.sin(ten) * 5, z: -Math.cos(ten) * 5 };
    expect(offAxisStartYaw(start, target)).toBe(0);
  });

  it('never turns MORE than MAX_START_OFFSET, and always clears MIN, for many geometries', () => {
    for (let i = 0; i < 60; i++) {
      const start = { x: (i % 7) + 1, z: (i % 5) + 1, yaw: (i / 3) % (Math.PI * 2) };
      // Force a near-dead-ahead goal so the nudge path runs: place it along the heading.
      const dist = 4;
      const target = {
        x: start.x + Math.sin(start.yaw) * dist,
        z: start.z - Math.cos(start.yaw) * dist,
      };
      const yaw = offAxisStartYaw(start, target);
      const off = offAxisAngle(start, yaw, target);
      expect(off).toBeGreaterThan(MIN_START_OFFSET - 1e-6);
      expect(off).toBeLessThanOrEqual(MAX_START_OFFSET + 1e-6);
    }
  });

  it('is deterministic: same inputs → same yaw', () => {
    const start = { x: 3, z: 8, yaw: 0.2 };
    const target = { x: 3.1, z: 1 };
    expect(offAxisStartYaw(start, target)).toBe(offAxisStartYaw(start, target));
  });

  it('keeps the authored yaw when the player starts on top of the goal', () => {
    const start = { x: 4, z: 4, yaw: 1.1 };
    expect(offAxisStartYaw(start, { x: 4, z: 4 })).toBe(1.1);
  });
});
