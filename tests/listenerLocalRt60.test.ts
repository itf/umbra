import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { buildRoomIr, eyringRt60 } from '../src/engine/acoustics/roomIr';
import { localMeanAbsorption, type SurfaceSample } from '../src/engine/acoustics/clapRoom';
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

// A carpet wall (absorption ~0.6 @1kHz) at x=-10 and a concrete wall (~0.02) at
// x=+10, both equal area. A listener near one or the other should feel that wall's
// absorption dominate.
const carpetWall: SurfaceSample = { area: 20, absorption: 0.6, centroid: [-10, 0, 0] };
const concreteWall: SurfaceSample = { area: 20, absorption: 0.02, centroid: [10, 0, 0] };
const surfaces = [carpetWall, concreteWall];

describe('listener-local mean absorption (pure)', () => {
  it('no listener → plain area-weighted whole-room mean (back-compat)', () => {
    const m = localMeanAbsorption(surfaces);
    expect(m).toBeCloseTo((0.6 + 0.02) / 2, 6); // equal areas
  });

  it('near carpet → higher absorption than near concrete', () => {
    const nearCarpet = localMeanAbsorption(surfaces, [-9, 0, 0]);
    const nearConcrete = localMeanAbsorption(surfaces, [9, 0, 0]);
    expect(nearCarpet).toBeGreaterThan(nearConcrete);
    expect(nearCarpet).toBeGreaterThan(0.4); // carpet-dominated
    expect(nearConcrete).toBeLessThan(0.2); // concrete-dominated
  });

  it('equidistant (centre) → between the two extremes', () => {
    const centre = localMeanAbsorption(surfaces, [0, 0, 0]);
    const nearCarpet = localMeanAbsorption(surfaces, [-9, 0, 0]);
    const nearConcrete = localMeanAbsorption(surfaces, [9, 0, 0]);
    expect(centre).toBeLessThan(nearCarpet);
    expect(centre).toBeGreaterThan(nearConcrete);
    expect(centre).toBeCloseTo((0.6 + 0.02) / 2, 6); // symmetric ⇒ equal weights
  });

  it('higher local absorption → shorter eyring RT60', () => {
    const V = 4000, S = 1000;
    const rtCarpet = eyringRt60(V, S, localMeanAbsorption(surfaces, [-9, 0, 0]));
    const rtConcrete = eyringRt60(V, S, localMeanAbsorption(surfaces, [9, 0, 0]));
    expect(rtCarpet).toBeLessThan(rtConcrete);
  });
});

// --- IR-level: same room, near-absorbent vs near-hard wall → shorter tail. ---
function fakeHrtf(): HrtfSet {
  const dirs = new Float32Array([0, 0, -1, 1, 0, 0, -1, 0, 0, 0, 0, 1]);
  const irs = new Float32Array(4 * 2 * 16);
  for (let m = 0; m < 4; m++) for (let r = 0; r < 2; r++) irs[(m * 2 + r) * 16] = 1;
  return { sampleRate: 48000, taps: 16, count: 4, dirs, irs };
}
const flat = (v: number) => new Array(NUM_BANDS).fill(v);
const refl = (): Tap => ({ delay: 0.01, gain: 1, dir: [0, 0, -1], order: 1, bandGains: flat(1) });
const winRms = (a: Float32Array, s: number, e: number) => {
  e = Math.min(e, a.length);
  let sum = 0, n = 0;
  for (let i = s; i < e; i++) { sum += a[i] * a[i]; n++; }
  return n > 0 ? Math.sqrt(sum / n) : 0;
};

describe('listener-local RT60 → position-dependent IR decay', () => {
  it('near absorbent wall → shorter / lower-energy tail than near hard wall', () => {
    const sr = 48000;
    const V = 4000, S = 1000;
    const aAbsorbent = localMeanAbsorption(surfaces, [-9, 0, 0]);
    const aHard = localMeanAbsorption(surfaces, [9, 0, 0]);
    const irAbsorbent = buildRoomIr([refl()], fakeHrtf(), {
      room: { volume: V, surfaceArea: S, meanAbsorption: aAbsorbent },
    });
    const irHard = buildRoomIr([refl()], fakeHrtf(), {
      room: { volume: V, surfaceArea: S, meanAbsorption: aHard },
    });
    // Harder wall → longer RT60 → longer IR + more late energy.
    expect(irHard.length).toBeGreaterThan(irAbsorbent.length);
    const lateAbsorbent = winRms(irAbsorbent.left, 0.4 * sr, 0.45 * sr);
    const lateHard = winRms(irHard.left, 0.4 * sr, 0.45 * sr);
    expect(lateHard).toBeGreaterThan(lateAbsorbent);
  });
});
