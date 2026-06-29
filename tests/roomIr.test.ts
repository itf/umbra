import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { buildRoomIr } from '../src/engine/acoustics/roomIr';
import type { HrtfSet } from '../src/engine/hrtf/sofa';
import type { Tap } from '../src/engine/acoustics/core';
import { NUM_BANDS } from '../src/engine/acoustics/materials';

// The default buildRoomIr path is now WASM; init the module from disk bytes
// (same approach as wasmRoom.test.ts — bypasses Vite's ?url).
beforeAll(async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const wasmDir = resolve(here, '../src/engine/acoustics/wasm');
  const mod = await import(resolve(wasmDir, 'acoustics_core.js'));
  const bytes = readFileSync(resolve(wasmDir, 'acoustics_core_bg.wasm'));
  await mod.default(bytes);
});

// Minimal synthetic HRTF set: a few directions, each IR a unit impulse so the
// room IR's structure (delay placement, gain) is easy to assert without real
// SADIE data. taps=1 means the HRIR is a single sample = 1.
function fakeHrtf(): HrtfSet {
  const dirs = new Float32Array([
    0, 0, -1, // front
    1, 0, 0,  // right
    -1, 0, 0, // left
    0, 0, 1,  // back
  ]);
  const count = 4;
  const taps = 16; // realistic-ish HRIR length so the band-FIR builder is valid
  // Each ear IR: a single impulse at sample 0 (rest zero) so the HRIR is an
  // identity-ish kernel and we can reason about delays/gains.
  const irs = new Float32Array(count * 2 * taps);
  for (let m = 0; m < count; m++) {
    for (let r = 0; r < 2; r++) {
      irs[(m * 2 + r) * taps + 0] = 1;
    }
  }
  return { sampleRate: 48000, taps, count, dirs, irs };
}

function flatBands(v: number): number[] {
  return new Array(NUM_BANDS).fill(v);
}

describe('buildRoomIr', () => {
  it('places tap energy at the expected sample delay', () => {
    const hrtf = fakeHrtf();
    const tap: Tap = {
      delay: 0.01, // 10 ms -> 480 samples at 48k
      gain: 0.5,
      dir: [0, 0, -1],
      order: 1,
      bandGains: flatBands(1),
    };
    const ir = buildRoomIr([tap], hrtf, { yaw: 0 });
    const expectedSample = Math.round(0.01 * hrtf.sampleRate);

    // Energy should be concentrated around the expected delay, ~zero well before.
    const before = ir.left.slice(0, expectedSample - 5).reduce((s, v) => s + Math.abs(v), 0);
    const around = ir.left
      .slice(expectedSample - 2, expectedSample + 3)
      .reduce((s, v) => s + Math.abs(v), 0);
    expect(around).toBeGreaterThan(0);
    expect(before).toBeLessThan(around * 0.05);
  });

  it('scales output by the tap broadband gain', () => {
    const hrtf = fakeHrtf();
    const base: Tap = { delay: 0.005, gain: 1, dir: [0, 0, -1], order: 0, bandGains: flatBands(1) };
    const loud = buildRoomIr([base], hrtf);
    const quiet = buildRoomIr([{ ...base, gain: 0.25 }], hrtf);
    const peak = (a: Float32Array) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    expect(peak(loud.left)).toBeGreaterThan(peak(quiet.left) * 3); // ~4x within filter tolerance
  });

  it('darker band gains reduce high-frequency content vs bright', () => {
    const hrtf = fakeHrtf();
    const dir: [number, number, number] = [0, 0, -1];
    // Bright: flat 1.0 across bands. Dark: highs rolled off.
    const bright = buildRoomIr(
      [{ delay: 0.002, gain: 1, dir, order: 1, bandGains: flatBands(1) }],
      hrtf,
    );
    const dark = buildRoomIr(
      [{ delay: 0.002, gain: 1, dir, order: 1, bandGains: [1, 1, 0.9, 0.6, 0.3, 0.15, 0.08, 0.05] }],
      hrtf,
    );
    // Crude HF measure: sum of absolute first-difference (high-freq energy).
    const hf = (a: Float32Array) => {
      let s = 0;
      for (let i = 1; i < a.length; i++) s += Math.abs(a[i] - a[i - 1]);
      return s;
    };
    expect(hf(dark.left)).toBeLessThan(hf(bright.left));
  });

  it('scattering spreads a reflection in time and lowers its peak', () => {
    const hrtf = fakeHrtf();
    const tap: Tap = { delay: 0.01, gain: 1, dir: [0, 0, -1], order: 1, bandGains: flatBands(1) };
    const crisp = buildRoomIr([tap], hrtf, { scattering: 0 });
    const rough = buildRoomIr([tap], hrtf, { scattering: 0.8 });
    const peak = (a: Float32Array) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    // A scattered reflection has a lower specular peak (energy spread into a smear).
    expect(peak(rough.left)).toBeLessThan(peak(crisp.left));
    // The smear adds energy AFTER the specular arrival that the crisp version
    // lacks — i.e. the reflection is spread out in time.
    const specSample = Math.round(0.01 * hrtf.sampleRate) + hrtf.taps + 4;
    const tail = (a: Float32Array) => {
      let s = 0;
      for (let i = specSample; i < a.length; i++) s += Math.abs(a[i]);
      return s;
    };
    expect(tail(rough.left)).toBeGreaterThan(tail(crisp.left));
  });

  it('scattering never affects the direct path (order 0)', () => {
    const hrtf = fakeHrtf();
    const direct: Tap = { delay: 0.005, gain: 1, dir: [0, 0, -1], order: 0, bandGains: flatBands(1) };
    const a = buildRoomIr([direct], hrtf, { scattering: 0 });
    const b = buildRoomIr([direct], hrtf, { scattering: 0.9 });
    const peak = (x: Float32Array) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    expect(peak(b.left)).toBeCloseTo(peak(a.left), 5);
  });
});
