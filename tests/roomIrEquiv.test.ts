/**
 * WASM-vs-JS equivalence for the room-IR builder. Pins the "faithful port" claim:
 * the FFT/WASM path must reproduce the plain-JS reference sample-for-sample on a
 * non-scattered IR, and match it in energy + direct-path placement when scattering
 * adds the jittered diffuse smear (whose LCG is shared between the two).
 *
 * Run: npx vitest run tests/roomIrEquiv.test.ts
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { buildRoomIr } from '../src/engine/acoustics/roomIr';
import type { HrtfSet } from '../src/engine/hrtf/sofa';
import { computeShoeboxTaps, initAcoustics, markAcousticsReady, type Tap } from '../src/engine/acoustics/core';

beforeAll(async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const wasmDir = resolve(here, '../src/engine/acoustics/wasm');
  const mod = await import(resolve(wasmDir, 'acoustics_core.js'));
  const bytes = readFileSync(resolve(wasmDir, 'acoustics_core_bg.wasm'));
  await mod.default(bytes);
  // In node we instantiate the module directly (the ?url init path doesn't run),
  // so mark the module ready to exercise the default WASM dispatch path.
  await initAcoustics().catch(() => {});
  markAcousticsReady();
});

function realisticHrtf(count = 26, taps = 256): HrtfSet {
  const dirs = new Float32Array(count * 3);
  const irs = new Float32Array(count * 2 * taps);
  for (let m = 0; m < count; m++) {
    const a = (m / count) * Math.PI * 2;
    dirs[m * 3] = Math.sin(a);
    dirs[m * 3 + 1] = 0;
    dirs[m * 3 + 2] = -Math.cos(a);
    for (let r = 0; r < 2; r++) {
      const base = (m * 2 + r) * taps;
      let seed = 1234 + m * 7 + r;
      for (let i = 0; i < 40; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const n = (seed / 0x7fffffff) * 2 - 1;
        irs[base + i] = n * Math.exp(-i / 12);
      }
    }
  }
  return { sampleRate: 48000, taps, count, dirs, irs };
}

function buildTaps(order: number): Tap[] {
  return computeShoeboxTaps({
    size: [6, 3, 8],
    materials: { '+x': 'brick', '-x': 'brick', '+y': 'concrete', '-y': 'concrete', '+z': 'wood', '-z': 'wood' },
    listener: [2, 1.6, 5],
    source: [4, 1.6, 2],
    maxOrder: order,
  });
}

const energy = (a: Float32Array) => a.reduce((s, v) => s + v * v, 0);
const argmax = (a: Float32Array) => {
  let bi = 0, bv = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i]) > bv) { bv = Math.abs(a[i]); bi = i; }
  return bi;
};
const maxAbsDiff = (a: Float32Array, b: Float32Array) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};

describe('roomIr WASM vs JS equivalence', () => {
  it('non-scattered IR matches sample-for-sample (~1e-4)', () => {
    const hrtf = realisticHrtf();
    const taps = buildTaps(2);
    const js = buildRoomIr(taps, hrtf, { scattering: 0, impl: 'js' });
    const wasm = buildRoomIr(taps, hrtf, { scattering: 0, impl: 'wasm' });
    expect(wasm.length).toBe(js.length);
    expect(maxAbsDiff(wasm.left, js.left)).toBeLessThan(1e-4);
    expect(maxAbsDiff(wasm.right, js.right)).toBeLessThan(1e-4);
  });

  it('scattered IR matches in energy and direct-path peak', () => {
    const hrtf = realisticHrtf();
    const taps = buildTaps(2);
    const js = buildRoomIr(taps, hrtf, { scattering: 0.5, impl: 'js' });
    const wasm = buildRoomIr(taps, hrtf, { scattering: 0.5, impl: 'wasm' });
    expect(wasm.length).toBe(js.length);
    const ej = energy(js.left) + energy(js.right);
    const ew = energy(wasm.left) + energy(wasm.right);
    expect(Math.abs(ew - ej) / ej).toBeLessThan(0.03);
    expect(argmax(wasm.left)).toBe(argmax(js.left));
  });

  it('default dispatch uses WASM once ready (matches explicit wasm path)', () => {
    const hrtf = realisticHrtf();
    const taps = buildTaps(2);
    const def = buildRoomIr(taps, hrtf, { scattering: 0 });
    const wasm = buildRoomIr(taps, hrtf, { scattering: 0, impl: 'wasm' });
    expect(maxAbsDiff(def.left, wasm.left)).toBe(0);
  });
});
