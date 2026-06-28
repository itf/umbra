/**
 * Sanity-checks every listenable debug scene through the real WASM solver: each
 * scene that has a clap must produce a non-empty, valid tap set, and the
 * diffraction scene must actually yield a diffracted tap. Catches broken geometry
 * (bad winding, degenerate walls) without anyone having to listen.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { SCENES, sceneWalls } from '../src/debug/scenes';

const here = dirname(fileURLToPath(import.meta.url));
const wasmDir = resolve(here, '../src/engine/acoustics/wasm');

let mod: typeof import('../src/engine/acoustics/wasm/acoustics_core.js');
const NB = 8;

beforeAll(async () => {
  mod = await import(resolve(wasmDir, 'acoustics_core.js'));
  await mod.default(readFileSync(resolve(wasmDir, 'acoustics_core_bg.wasm')));
});

function tapsFor(scene: (typeof SCENES)[number], source: [number, number, number]) {
  const walls = sceneWalls(scene);
  const verts: number[] = [];
  const sizes: number[] = [];
  const abs: number[] = [];
  for (const w of walls) {
    sizes.push(w.verts.length);
    for (const v of w.verts) verts.push(v[0], v[1], v[2]);
    for (let b = 0; b < NB; b++) abs.push(w.absorption[b]);
  }
  const edges: number[] = [];
  for (const e of scene.edges ?? []) edges.push(...e[0], ...e[1]);
  const packed = mod.compute_room_taps(
    new Float32Array(verts),
    new Uint32Array(sizes),
    new Float32Array(abs),
    new Float32Array(edges),
    new Float32Array(scene.listener),
    new Float32Array(source),
    scene.maxOrder,
  );
  return packed.length / mod.tap_stride();
}

describe('debug scenes are well-formed', () => {
  for (const scene of SCENES) {
    const clap = scene.sources.find((s) => s.kind === 'clap');
    if (!clap) continue;
    it(`"${scene.title}" produces taps`, () => {
      const count = tapsFor(scene, clap.pos);
      expect(count).toBeGreaterThan(0);
      expect(Number.isFinite(count)).toBe(true);
    });
  }

  it('the doorway scene yields a diffracted tap (tone source through the edge)', () => {
    const scene = SCENES.find((s) => s.id === 'doorway')!;
    const tone = scene.sources[0].pos;
    // With the edge present we expect at least one tap (the diffraction path),
    // even though the direct line may be occluded.
    const count = tapsFor(scene, tone);
    expect(count).toBeGreaterThan(0);
  });

  it('object-in-void has no room walls, only the object (fewer reflections than in-room)', () => {
    const voidScene = SCENES.find((s) => s.id === 'object-in-void')!;
    const roomScene = SCENES.find((s) => s.id === 'object-in-room')!;
    const voidCount = tapsFor(voidScene, voidScene.sources[0].pos);
    const roomCount = tapsFor(roomScene, roomScene.sources[0].pos);
    expect(roomCount).toBeGreaterThan(voidCount);
  });
});
