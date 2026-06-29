/**
 * Benchmark + equivalence for the room-IR build: original JS path vs the new
 * FFT/overlap-add WASM path. Uses the REAL solver to produce a representative
 * tap set (6-wall shoebox, order 2-3) and a realistic 256-tap HRIR length.
 *
 * Run: npx vitest run tests/roomIrBench.test.ts (numbers print to stderr).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { buildRoomIrJs, buildRoomIrWasm } from '../src/engine/acoustics/roomIr';
import type { HrtfSet } from '../src/engine/hrtf/sofa';
import { computeShoeboxTaps, initAcoustics, type Tap } from '../src/engine/acoustics/core';
import { NUM_BANDS } from '../src/engine/acoustics/materials';

let mod: typeof import('../src/engine/acoustics/wasm/acoustics_core.js');

beforeAll(async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const wasmDir = resolve(here, '../src/engine/acoustics/wasm');
  mod = await import(resolve(wasmDir, 'acoustics_core.js'));
  const bytes = readFileSync(resolve(wasmDir, 'acoustics_core_bg.wasm'));
  await mod.default(bytes);
  // initAcoustics() also wires the same module instance via ?url; in the test env
  // the explicit default(bytes) above is what makes build_room_ir callable.
  await initAcoustics().catch(() => {});
});

/** A semi-realistic HRTF set: 256-tap IRs, a handful of directions, smooth-ish
 * decaying impulse responses so the convolution does real work. */
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
      // short decaying noisy HRIR-ish kernel
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

function bench(fn: () => void, iters: number): number {
  fn(); // warm
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  return (performance.now() - t0) / iters;
}

describe('roomIr WASM vs JS', () => {
  it('produces a perceptually-equivalent IR (same structure, close energy)', () => {
    const hrtf = realisticHrtf();
    const taps = buildTaps(2);
    const js = buildRoomIrJs(taps, hrtf, { scattering: 0.3 });
    const wasm = buildRoomIrWasm(taps, hrtf, { scattering: 0.3 });
    expect(wasm.length).toBe(js.length);
    const energy = (a: Float32Array) => a.reduce((s, v) => s + v * v, 0);
    const ej = energy(js.left) + energy(js.right);
    const ew = energy(wasm.left) + energy(wasm.right);
    // FFT convolution vs direct convolution: same math up to float error.
    expect(Math.abs(ew - ej) / ej).toBeLessThan(0.02);
    // Peak sample within a couple of samples (delay placement identical).
    const argmax = (a: Float32Array) => {
      let bi = 0, bv = 0;
      for (let i = 0; i < a.length; i++) if (Math.abs(a[i]) > bv) { bv = Math.abs(a[i]); bi = i; }
      return bi;
    };
    expect(Math.abs(argmax(wasm.left) - argmax(js.left))).toBeLessThanOrEqual(2);
  });

  it('is meaningfully faster than the JS path', () => {
    const hrtf = realisticHrtf();
    for (const order of [2, 3]) {
      const taps = buildTaps(order);
      const jsMs = bench(() => buildRoomIrJs(taps, hrtf, { scattering: 0.3 }), 20);
      const wasmMs = bench(() => buildRoomIrWasm(taps, hrtf, { scattering: 0.3 }), 20);
      const speedup = jsMs / wasmMs;
      // eslint-disable-next-line no-console
      console.error(
        `order ${order}: ${taps.length} taps | JS ${jsMs.toFixed(2)}ms | WASM ${wasmMs.toFixed(2)}ms | ${speedup.toFixed(1)}x`,
      );
      expect(speedup).toBeGreaterThan(2);
    }
  });
});

// keep NUM_BANDS import used
void NUM_BANDS;
