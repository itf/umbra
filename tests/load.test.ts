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

  it('reports a representative scattering coefficient', () => {
    const lvl = emptyLevel();
    lvl.roomMaterial = 'brick'; // high scatter
    const { scattering } = loadLevel(lvl);
    expect(scattering).toBeGreaterThan(0);
    expect(scattering).toBeLessThanOrEqual(1);
  });
});
