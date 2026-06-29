import { describe, it, expect } from 'vitest';
import {
  absorption8to3,
  scattering8toScalar,
  quadToMeshData,
  thinBoxMeshData,
  wallToMeshData,
  wallMaterial,
  buildSteamScene,
  DEFAULT_TRANSMISSION,
  THIN_WALL_THICKNESS,
  type SteamScene,
  type SceneDeps,
} from './convert';
import type { WallDef } from '../acoustics/core';

const quad = (doubleSided = false): WallDef => ({
  verts: [
    [0, 0, 0],
    [2, 0, 0],
    [2, 3, 0],
    [0, 3, 0],
  ],
  // 8 distinct bands so grouping is unambiguous.
  absorption: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
  doubleSided,
});

describe('8-band → 3-band absorption mapping', () => {
  it('groups low=[0..2], mid=[3..5], high=[6..7] by mean', () => {
    const abs = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
    const [lo, mid, hi] = absorption8to3(abs);
    expect(lo).toBeCloseTo((0.1 + 0.2 + 0.3) / 3, 6);
    expect(mid).toBeCloseTo((0.4 + 0.5 + 0.6) / 3, 6);
    expect(hi).toBeCloseTo((0.7 + 0.8) / 2, 6);
  });
});

describe('scattering 8-band → scalar', () => {
  it('uses the mean of the mid bands [3..5]', () => {
    const s = [0, 0, 0, 0.3, 0.4, 0.5, 0.9, 1];
    expect(scattering8toScalar(s)).toBeCloseTo((0.3 + 0.4 + 0.5) / 3, 6);
  });
});

describe('quad triangulation (single-sided perimeter wall)', () => {
  it('a quad → 2 triangles, vertices preserved', () => {
    const m = quadToMeshData(quad());
    expect(m.positions.length).toBe(4 * 3);
    expect(m.indices.length).toBe(2 * 3); // 2 tris
    // fan: (0,1,2),(0,2,3)
    expect(Array.from(m.indices)).toEqual([0, 1, 2, 0, 2, 3]);
    // first vertex
    expect(Array.from(m.positions.slice(0, 3))).toEqual([0, 0, 0]);
  });

  it('an n-gon → n-2 triangles', () => {
    const pentagon: WallDef = {
      verts: [
        [0, 0, 0],
        [1, 0, 0],
        [2, 1, 0],
        [1, 2, 0],
        [0, 2, 0],
      ],
      absorption: [0, 0, 0, 0, 0, 0, 0, 0],
    };
    const m = quadToMeshData(pentagon);
    expect(m.indices.length / 3).toBe(5 - 2);
  });
});

describe('double-sided wall → thin box (two-sided)', () => {
  it('emits both faces (front + back) with doubled vertex + triangle count', () => {
    const m = thinBoxMeshData(quad(true));
    expect(m.positions.length).toBe(4 * 2 * 3); // front + back vertices
    expect(m.indices.length / 3).toBe((4 - 2) * 2); // both faces
  });

  it('extrudes ±thickness/2 along the polygon normal (z for an xy quad)', () => {
    const m = thinBoxMeshData(quad(true), 0.2);
    // normal of an xy-plane quad is ±z; front face z = +0.1, back face z = -0.1
    const frontZ = m.positions[2];
    const backZ = m.positions[4 * 3 + 2];
    expect(Math.abs(frontZ)).toBeCloseTo(0.1, 6);
    expect(Math.abs(backZ)).toBeCloseTo(0.1, 6);
    expect(Math.sign(frontZ)).toBe(-Math.sign(backZ));
  });

  it('wallToMeshData picks thin-box for double-sided, fan for single-sided', () => {
    expect(wallToMeshData(quad(true)).positions.length).toBe(4 * 2 * 3);
    expect(wallToMeshData(quad(false)).positions.length).toBe(4 * 3);
  });
});

describe('wall material', () => {
  it('maps absorption + scattering scalar, default transmission', () => {
    const mat = wallMaterial(quad(), 0.12);
    expect(mat.absorption).toHaveLength(3);
    expect(mat.scattering).toBe(0.12);
    expect(mat.transmission).toEqual(DEFAULT_TRANSMISSION);
  });
});

describe('buildSteamScene', () => {
  it('adds one mesh per wall and commits, using the default thin-wall thickness', () => {
    const added: any[] = [];
    let committed = 0;
    const scene: SteamScene = {
      addStaticMesh: (a) => { added.push(a); return a; },
      commit: () => { committed++; },
    };
    const deps: SceneDeps = {
      makeGeometry: (d) => d,
      identityMatrix: () => ({ identity: true }),
    };
    const handles = buildSteamScene(scene, [quad(false), quad(true)], deps, { scattering: 0.1 });
    expect(added).toHaveLength(2);
    expect(handles).toHaveLength(2);
    expect(committed).toBe(1);
    // material carries the mapped 3-band absorption
    expect((added[0].material as any).absorption).toHaveLength(3);
    expect(THIN_WALL_THICKNESS).toBeGreaterThan(0);
  });
});
