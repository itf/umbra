import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { buildRoomIr, eyringRt60 } from '../src/engine/acoustics/roomIr';
import type { HrtfSet } from '../src/engine/hrtf/sofa';
import type { Tap } from '../src/engine/acoustics/core';
import { NUM_BANDS } from '../src/engine/acoustics/materials';

beforeAll(async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const wasmDir = resolve(here, '../src/engine/acoustics/wasm');
  const mod = await import(resolve(wasmDir, 'acoustics_core.js'));
  const bytes = readFileSync(resolve(wasmDir, 'acoustics_core_bg.wasm'));
  await mod.default(bytes);
});

function fakeHrtf(): HrtfSet {
  const dirs = new Float32Array([0, 0, -1, 1, 0, 0, -1, 0, 0, 0, 0, 1]);
  const count = 4;
  const taps = 16;
  const irs = new Float32Array(count * 2 * taps);
  for (let m = 0; m < count; m++) for (let r = 0; r < 2; r++) irs[(m * 2 + r) * taps] = 1;
  return { sampleRate: 48000, taps, count, dirs, irs };
}
const flat = (v: number) => new Array(NUM_BANDS).fill(v);
const refl = (): Tap => ({ delay: 0.01, gain: 1, dir: [0, 0, -1], order: 1, bandGains: flat(1) });
const winRms = (a: Float32Array, s: number, e: number) => {
  e = Math.min(e, a.length);
  let sum = 0, n = 0;
  for (let i = s; i < e; i++) { sum += a[i] * a[i]; n++; }
  return n > 0 ? Math.sqrt(sum / n) : 0;
};

describe('late reverb FDN tail', () => {
  it('eyringRt60: bigger/harder room → longer RT60', () => {
    const small = eyringRt60(40, 76, 0.4); // small absorbent
    const big = eyringRt60(2000, 1000, 0.05); // large hard
    expect(big).toBeGreaterThan(small);
    expect(small).toBeGreaterThan(0);
  });

  it('tail exists past the early field and decays toward zero', () => {
    const sr = 48000;
    const ir = buildRoomIr([refl()], fakeHrtf(), { rt60: 1.2, scattering: 0.3 });
    expect(ir.length / sr).toBeGreaterThan(1.0);
    expect(winRms(ir.left, 0.5 * sr, 0.55 * sr)).toBeGreaterThan(0);
    // Successive 50 ms windows mostly decrease.
    const w = 0.05 * sr;
    let prev = Infinity, dec = 0, tot = 0;
    for (let start = 0.05 * sr; start + w < ir.left.length; start += w) {
      const r = winRms(ir.left, start, start + w);
      if (r <= prev * 1.05) dec++;
      tot++;
      prev = r;
    }
    expect(dec / tot).toBeGreaterThan(0.85);
  });

  it('RT60 orders the tail length (long rings later than short)', () => {
    const sr = 48000;
    const short = buildRoomIr([refl()], fakeHrtf(), { rt60: 0.3 });
    const long = buildRoomIr([refl()], fakeHrtf(), { rt60: 2.0 });
    expect(long.length).toBeGreaterThan(short.length);
    const lateLong = winRms(long.left, 0.6 * sr, 0.65 * sr);
    const lateShort = winRms(short.left, 0.6 * sr, 0.65 * sr);
    expect(lateLong).toBeGreaterThan(lateShort);
  });

  it('energy continuity: no silent gap between early field and tail', () => {
    const sr = 48000;
    const ir = buildRoomIr([refl()], fakeHrtf(), { rt60: 1.0, scattering: 0.5 });
    const w = 0.005 * sr;
    for (let start = 0.01 * sr; start + w < 0.3 * sr; start += w) {
      expect(winRms(ir.left, start, start + w)).toBeGreaterThan(0);
    }
  });

  it('tail:false omits the tail (early-only)', () => {
    const a = buildRoomIr([refl()], fakeHrtf(), { rt60: 1.5 });
    const b = buildRoomIr([refl()], fakeHrtf(), { rt60: 1.5, tail: false });
    expect(b.length).toBeLessThan(a.length);
  });

  it('JS and WASM tail match in energy + length', () => {
    const js = buildRoomIr([refl()], fakeHrtf(), { rt60: 1.0, scattering: 0.3, impl: 'js' });
    const wasm = buildRoomIr([refl()], fakeHrtf(), { rt60: 1.0, scattering: 0.3, impl: 'wasm' });
    expect(Math.abs(wasm.length - js.length)).toBeLessThanOrEqual(1);
    const e = (a: Float32Array) => a.reduce((s, v) => s + v * v, 0);
    const ej = e(js.left) + e(js.right);
    const ew = e(wasm.left) + e(wasm.right);
    expect(Math.abs(ew - ej) / ej).toBeLessThan(0.05);
  });
});
