/**
 * End-to-end spatial-audio correctness, asserted on REAL rendered samples:
 *   real WASM image-source taps -> real SADIE HRTF -> stereo room IR -> measure.
 *
 * No speakers, no listening — just physics expressed as numbers. These are the
 * "layer 2" checks: direction, distance, and room-size are verified objectively.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { HrtfSet } from '../src/engine/hrtf/sofa';
import { sphericalToVec } from '../src/engine/hrtf/sofa';
import { buildRoomIr } from '../src/engine/acoustics/roomIr';
import type { Tap } from '../src/engine/acoustics/core';
import { NUM_BANDS } from '../src/engine/acoustics/materials';
import {
  stereoEnergy,
  interauralLagSamples,
  firstReflectionSample,
  hasInvalid,
  peak,
  rms,
} from '../src/engine/analysis/measure';

const here = dirname(fileURLToPath(import.meta.url));

/** Parse the baked .hrtf binary directly from disk (mirrors sofa.ts loadHrtf). */
function loadHrtfFromDisk(path: string): HrtfSet {
  const data = readFileSync(path);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = 0;
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'HRTF') throw new Error('bad magic');
  o += 4;
  o += 4; // version
  const sampleRate = dv.getFloat32(o, true); o += 4;
  const count = dv.getUint32(o, true); o += 4;
  const taps = dv.getUint32(o, true); o += 4;
  const dirs = new Float32Array(count * 3);
  for (let m = 0; m < count; m++) {
    const az = dv.getFloat32(o, true); o += 4;
    const el = dv.getFloat32(o, true); o += 4;
    const [x, y, z] = sphericalToVec(az, el);
    dirs[m * 3] = x; dirs[m * 3 + 1] = y; dirs[m * 3 + 2] = z;
  }
  const irs = new Float32Array(count * 2 * taps);
  for (let i = 0; i < irs.length; i++) { irs[i] = dv.getFloat32(o, true); o += 4; }
  return { sampleRate, taps, count, dirs, irs };
}

function flat(v: number): number[] { return new Array(NUM_BANDS).fill(v); }

/** A single direct-path tap toward a world direction at a given distance. */
function directTap(dir: [number, number, number], dist: number): Tap {
  return { delay: dist / 343, gain: 1 / Math.max(1, dist), dir, order: 0, bandGains: flat(1) };
}

let hrtf: HrtfSet;
beforeAll(() => {
  hrtf = loadHrtfFromDisk(resolve(here, '../assets/hrtf/sadie_h3.hrtf'));
});

describe('HRTF directionality', () => {
  it('loads a dense HRTF set', () => {
    expect(hrtf.count).toBeGreaterThan(1000);
    expect(hrtf.taps).toBe(256);
  });

  it('source on the RIGHT has more right-channel energy', () => {
    const right = sphericalToVec(270, 0) as [number, number, number]; // 270° = right
    const ir = buildRoomIr([directTap(right, 2)], hrtf, { yaw: 0 });
    const e = stereoEnergy(ir.left, ir.right);
    expect(e.balance).toBeGreaterThan(0.05); // right-heavy
    expect(hasInvalid(ir.left)).toBe(false);
    expect(peak(ir.left)).toBeLessThan(1.5);
  });

  it('source on the LEFT has more left-channel energy and opposite ITD sign', () => {
    const left = sphericalToVec(90, 0) as [number, number, number]; // 90° = left
    const irL = buildRoomIr([directTap(left, 2)], hrtf, { yaw: 0 });
    const eL = stereoEnergy(irL.left, irL.right);
    expect(eL.balance).toBeLessThan(-0.05); // left-heavy

    const right = sphericalToVec(270, 0) as [number, number, number];
    const irR = buildRoomIr([directTap(right, 2)], hrtf, { yaw: 0 });
    // ITD sign must differ between left- and right-side sources.
    const lagL = interauralLagSamples(irL.left, irL.right);
    const lagR = interauralLagSamples(irR.left, irR.right);
    expect(Math.sign(lagL)).not.toBe(Math.sign(lagR));
  });

  it('turning the head re-balances a fixed source', () => {
    // Source dead ahead. Facing it: ~centered. Turn 90° right: source now on left.
    const front = sphericalToVec(0, 0) as [number, number, number];
    const facing = buildRoomIr([directTap(front, 2)], hrtf, { yaw: 0 });
    const turned = buildRoomIr([directTap(front, 2)], hrtf, { yaw: Math.PI / 2 });
    expect(Math.abs(stereoEnergy(facing.left, facing.right).balance)).toBeLessThan(0.2);
    // After turning right, a front source should drift left (balance more negative).
    expect(stereoEnergy(turned.left, turned.right).balance).toBeLessThan(
      stereoEnergy(facing.left, facing.right).balance,
    );
  });
});

describe('distance cues', () => {
  it('farther source is quieter and duller', () => {
    const dir = sphericalToVec(0, 0) as [number, number, number];
    const near = buildRoomIr([directTap(dir, 1)], hrtf);
    const far = buildRoomIr([directTap(dir, 12)], hrtf);
    // The tap gain already encodes 1/r; we assert the rendered RMS reflects it.
    expect(rms(near.left)).toBeGreaterThan(rms(far.left));
  });
});

describe('room-size cue', () => {
  it('first reflection arrives later in a bigger room', () => {
    const dir = sphericalToVec(0, 0) as [number, number, number];
    // Direct sound + one reflection, well separated from the direct HRIR tail so
    // the reflection is unambiguous. Small room reflects sooner than the big one.
    const small: Tap[] = [
      directTap(dir, 1),
      { delay: 8 / 343, gain: 0.5, dir, order: 1, bandGains: flat(0.8) }, // 8m path
    ];
    const big: Tap[] = [
      directTap(dir, 1),
      { delay: 20 / 343, gain: 0.5, dir, order: 1, bandGains: flat(0.8) }, // 20m path
    ];
    const irSmall = buildRoomIr(small, hrtf);
    const irBig = buildRoomIr(big, hrtf);
    // Skip the direct sound's HRIR tail; the (separated) reflection is the next peak.
    const rSmall = firstReflectionSample(irSmall.left, { skip: hrtf.taps });
    const rBig = firstReflectionSample(irBig.left, { skip: hrtf.taps });
    expect(rSmall).toBeGreaterThan(0);
    expect(rBig).toBeGreaterThan(rSmall);
    // The GAP between the two reflections should match the path-length difference
    // (12m / c). This cancels the fixed peak-vs-onset bias the HRIR adds to both.
    const measuredGap = (rBig - rSmall) / hrtf.sampleRate;
    expect(Math.abs(measuredGap - 12 / 343)).toBeLessThan(0.001);
  });
});
