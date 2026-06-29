/**
 * Proves the reflector-localization exercise is acoustically real: the single
 * free-standing panel actually reflects the clap, and the reflection ARRIVES from
 * the labeled side (left scene → echo from the left, i.e. -x of the listener).
 * This is the cue the exercise trains — verified through the real WASM solver, not
 * just the scene geometry.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { makeQuestion } from '../src/trainer/exercises';
import { sceneWalls, type Scene } from '../src/debug/scenes';

const here = dirname(fileURLToPath(import.meta.url));
const wasmDir = resolve(here, '../src/engine/acoustics/wasm');
let mod: typeof import('../src/engine/acoustics/wasm/acoustics_core.js');
const NB = 8;

beforeAll(async () => {
  mod = await import(resolve(wasmDir, 'acoustics_core.js'));
  await mod.default(readFileSync(resolve(wasmDir, 'acoustics_core_bg.wasm')));
});

interface Tap { delay: number; gain: number; dir: [number, number, number]; order: number }

function taps(scene: Scene): Tap[] {
  const walls = sceneWalls(scene);
  const verts: number[] = [], sizes: number[] = [], abs: number[] = [], ds: number[] = [];
  for (const w of walls) {
    sizes.push(w.verts.length);
    for (const v of w.verts) verts.push(v[0], v[1], v[2]);
    for (let b = 0; b < NB; b++) abs.push(w.absorption[b]);
    ds.push((w as { doubleSided?: boolean }).doubleSided ? 1 : 0);
  }
  const clap = scene.sources.find((s) => s.kind === 'clap')!;
  const packed = mod.compute_room_taps(
    new Float32Array(verts), new Uint32Array(sizes), new Float32Array(abs),
    new Uint32Array(ds), new Float32Array([]), new Float32Array(scene.listener), new Float32Array(clap.pos),
    scene.maxOrder, 343,
  );
  const stride = mod.tap_stride();
  const out: Tap[] = [];
  for (let i = 0; i < packed.length / stride; i++) {
    const o = i * stride;
    out.push({ delay: packed[o], gain: packed[o + 1], dir: [packed[o + 2], packed[o + 3], packed[o + 4]], order: packed[o + 5] });
  }
  return out;
}

/** Gain-weighted mean x-direction of the reflections (the net lateral echo bias). */
function reflectionBiasX(scene: Scene): number {
  const r = taps(scene).filter((t) => t.order >= 1);
  let sx = 0, sw = 0;
  for (const t of r) { sx += t.dir[0] * t.gain; sw += t.gain; }
  return sw ? sx / sw : 0;
}

describe('reflector exercise is acoustically real', () => {
  const SEEDS = [7, 99, 12345, 271828, 1000003];

  it('the panel produces reflections', () => {
    for (const seed of SEEDS) {
      const q = makeQuestion('reflector', seed);
      expect(taps(q.sceneA).filter((t) => t.order >= 1).length).toBeGreaterThan(0);
    }
  });

  it('the net echo bias is to the labeled side (left scene → -x, right scene → +x)', () => {
    for (const seed of SEEDS) {
      const q = makeQuestion('reflector', seed);
      const leftScene = q.correctAnswer === 'Room A' ? q.sceneA : q.sceneB!;
      const rightScene = q.correctAnswer === 'Room A' ? q.sceneB! : q.sceneA;
      // The enclosing room's reflections are symmetric and cancel; the off-centre
      // concrete panel biases the net lateral direction to its side.
      // Sign: the bias points to the panel's side.
      expect(reflectionBiasX(leftScene)).toBeLessThan(0);
      expect(reflectionBiasX(rightScene)).toBeGreaterThan(0);
      // Magnitude: the lateral bias is large enough to be an audible directional
      // cue (not a marginal tiebreak that a listener couldn't hear).
      expect(Math.abs(reflectionBiasX(leftScene))).toBeGreaterThan(0.1);
      expect(Math.abs(reflectionBiasX(rightScene))).toBeGreaterThan(0.1);
    }
  });
});

describe('distance exercise is acoustically real (echo DELAY)', () => {
  const SEEDS = [7, 99, 12345, 271828, 1000003];

  /** Earliest order-1 reflection delay (the wall echo arrival). */
  const firstReflectDelay = (scene: Scene): number => {
    const r = taps(scene).filter((t) => t.order >= 1);
    expect(r.length).toBeGreaterThan(0);
    return Math.min(...r.map((t) => t.delay));
  };

  it('the closer-wall room reflects SOONER than the farther one', () => {
    for (const seed of SEEDS) {
      const q = makeQuestion('distance', seed);
      const closeScene = q.correctAnswer === 'Room A' ? q.sceneA : q.sceneB!;
      const farScene = q.correctAnswer === 'Room A' ? q.sceneB! : q.sceneA;
      expect(firstReflectDelay(closeScene)).toBeLessThan(firstReflectDelay(farScene));
    }
  });
});

describe('gap exercise is acoustically real (reflection on the WALL side)', () => {
  const SEEDS = [7, 99, 12345, 271828, 1000003];

  it('the net echo bias points to the wall side (away from the gap), audibly', () => {
    for (const seed of SEEDS) {
      const q = makeQuestion('gap', seed);
      const bias = reflectionBiasX(q.sceneA);
      // Gap on LEFT → wall on RIGHT → bias toward +x. Gap on RIGHT → bias -x.
      if (q.correctAnswer === 'Left') expect(bias).toBeGreaterThan(0);
      else expect(bias).toBeLessThan(0);
      expect(Math.abs(bias)).toBeGreaterThan(0.1);
    }
  });
});
