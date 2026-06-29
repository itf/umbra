import { describe, it, expect } from 'vitest';
import { emptyLevel } from '../src/level/schema';
import { loadLevel } from '../src/level/load';

describe('level → game geometry', () => {
  it('enclosed room yields a closed box (6 surfaces incl ceiling)', () => {
    const lvl = emptyLevel();
    const { walls } = loadLevel(lvl);
    // 5 perimeter (4 walls + floor) + 1 ceiling = 6.
    expect(walls.length).toBe(6);
  });

  it('open level has no perimeter or ceiling — only free walls', () => {
    const lvl = emptyLevel();
    lvl.open = true;
    lvl.hasCeiling = false;
    lvl.walls.push({ id: 'w1', ax: 1, az: 1, bx: 5, bz: 1, material: 'brick' });
    const { walls } = loadLevel(lvl);
    expect(walls.length).toBe(1); // just the one free wall
  });

  it('a dropped ceiling zone adds its plane PLUS 4 step-down side walls', () => {
    const base = loadLevel(emptyLevel()).walls.length; // 6
    const lvl = emptyLevel();
    lvl.ceilings.push({ id: 'c1', x: 2, z: 2, w: 4, d: 4, height: 1.8, material: 'wood' });
    const { walls } = loadLevel(lvl);
    // +1 lower ceiling plane + 4 connecting side walls = +5.
    expect(walls.length).toBe(base + 5);
  });

  it('a ceiling zone at room height adds only its plane (no step walls)', () => {
    const base = loadLevel(emptyLevel()).walls.length;
    const lvl = emptyLevel();
    lvl.ceilings.push({ id: 'c1', x: 2, z: 2, w: 4, d: 4, height: lvl.room.height, material: 'wood' });
    const { walls } = loadLevel(lvl);
    expect(walls.length).toBe(base + 1);
  });

  it('auto-derives diffraction edges at an interior wall\'s free ends (a doorway)', () => {
    const lvl = emptyLevel(); // 12 x 16 x 3
    // A free-standing interior wall: both ends are away from the perimeter, so
    // both are free ends (doorway jambs) → 2 vertical diffracting edges.
    lvl.walls.push({ id: 'w1', ax: 4, az: 8, bx: 8, bz: 8, material: 'brick' });
    const { edges } = loadLevel(lvl);
    expect(edges.length).toBe(2);
    // Each edge is vertical: same (x,z), y from floor (0) to room height (3).
    for (const e of edges) {
      expect(e[0][0]).toBe(e[1][0]);
      expect(e[0][2]).toBe(e[1][2]);
      expect(e[0][1]).toBe(0);
      expect(e[1][1]).toBe(lvl.room.height);
    }
    const xs = edges.map((e) => e[0][0]).sort();
    expect(xs).toEqual([4, 8]);
  });

  it('an end buried in the perimeter is NOT a free end (only the interior end is)', () => {
    const lvl = emptyLevel();
    // Wall runs from the left perimeter (x=0) into the room: only the inner end
    // at x=6 is a diffracting free end.
    lvl.walls.push({ id: 'w1', ax: 0, az: 8, bx: 6, bz: 8, material: 'brick' });
    const { edges } = loadLevel(lvl);
    expect(edges.length).toBe(1);
    expect(edges[0][0][0]).toBe(6);
  });

  it('an enclosed / perimeter-only level derives NO diffraction edges', () => {
    const { edges } = loadLevel(emptyLevel());
    expect(edges.length).toBe(0);
  });

  it('an open level with no interior walls derives no edges', () => {
    const lvl = emptyLevel();
    lvl.open = true;
    lvl.hasCeiling = false;
    const { edges } = loadLevel(lvl);
    expect(edges.length).toBe(0);
  });

  it('two interior walls sharing an endpoint (a junction) drop the shared edge', () => {
    const lvl = emptyLevel();
    // L-junction at (8,8): the meeting corner is shared, so 2 walls have 4 ends
    // but the 2 coincident ones cancel → only the 2 outer free ends emit edges.
    lvl.walls.push({ id: 'w1', ax: 4, az: 8, bx: 8, bz: 8, material: 'brick' });
    lvl.walls.push({ id: 'w2', ax: 8, az: 8, bx: 8, bz: 12, material: 'brick' });
    const { edges } = loadLevel(lvl);
    expect(edges.length).toBe(2);
    // The shared corner (8,8) is not among the emitted edges.
    const hasCorner = edges.some((e) => e[0][0] === 8 && e[0][2] === 8);
    expect(hasCorner).toBe(false);
  });

  it('plumbs monsters from Level into GameLevel', () => {
    const lvl = emptyLevel();
    lvl.monsters = [{ id: 'm1', x: 3, z: 4, speed: 1.5, sound: 'growl' }];
    const { game } = loadLevel(lvl);
    expect(game.monsters).toEqual([{ x: 3, z: 4, speed: 1.5, sound: 'growl' }]);
  });

  it('a no-monster level yields an empty monster list (inert)', () => {
    const { game } = loadLevel(emptyLevel());
    expect(game.monsters).toEqual([]);
  });

  it('reports a representative scattering coefficient', () => {
    const lvl = emptyLevel();
    lvl.roomMaterial = 'brick'; // high scatter
    const { scattering } = loadLevel(lvl);
    expect(scattering).toBeGreaterThan(0);
    expect(scattering).toBeLessThanOrEqual(1);
  });
});
