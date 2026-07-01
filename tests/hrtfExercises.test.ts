/**
 * Pure geometry tests for the HRTF-game trajectories. Engine convention:
 * +x right, +y up, −z front, +z back (listener-relative). We assert each path
 * starts/ends where its prompt claims, so the 'guess' exercises have a truthful
 * correct answer and the 'ab' orbits actually traverse the sides.
 */
import { describe, it, expect } from 'vitest';
import { EXERCISES, STAIRCASE_CONFIG } from '../src/ui/hrtfExercises';

function ex(id: string) {
  const e = EXERCISES.find((x) => x.id === id);
  if (!e) throw new Error(`no exercise ${id}`);
  return e;
}

describe('exercise trajectories', () => {
  it('front/back pass starts in front (−z) and ends behind (+z)', () => {
    const e = ex('frontback-line');
    expect(e.trajectory(0)[2]).toBeLessThan(0); // front
    expect(e.trajectory(1)[2]).toBeGreaterThan(0); // back
  });

  it('overhead pass stays clearly above head height throughout', () => {
    const e = ex('elev-overhead');
    for (const t of [0, 0.5, 1]) expect(e.trajectory(t)[1]).toBeGreaterThan(1.6 + 0.5);
  });

  it('rise-ahead moves upward and stays in front', () => {
    const e = ex('elev-rise');
    expect(e.trajectory(1)[1]).toBeGreaterThan(e.trajectory(0)[1]);
    expect(e.trajectory(0)[2]).toBeLessThan(0); // in front
    expect(e.trajectory(1)[2]).toBeLessThan(0);
  });

  it('side orbit goes front → right side → back', () => {
    const e = ex('width-orbit');
    expect(e.trajectory(0)[2]).toBeLessThan(0); // front
    expect(e.trajectory(0.5)[0]).toBeGreaterThan(0.5); // right side (+x)
    expect(e.trajectory(1)[2]).toBeGreaterThan(0); // back
  });

  it('all exercises are ≤3 s and reference a configured parameter', () => {
    for (const e of EXERCISES) {
      expect(e.durationSec).toBeLessThanOrEqual(3);
      expect(STAIRCASE_CONFIG[e.param]).toBeTruthy();
    }
  });

  it('every trajectory is finite and externalized (never on the head) across t', () => {
    const HEAD_Y = 1.6;
    for (const e of EXERCISES) {
      for (let i = 0; i <= 10; i++) {
        const [x, y, z] = e.trajectory(i / 10);
        expect(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)).toBe(true);
        // 3D distance from the head (ears at HEAD_Y) — an overhead source may have
        // x≈z≈0 but is still well away vertically, so measure in 3D.
        expect(Math.hypot(x, y - HEAD_Y, z)).toBeGreaterThan(0.5);
      }
    }
  });
});
