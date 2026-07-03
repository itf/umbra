/**
 * Tests the PCA magnitude warp (personalizePcaMinPhase) against the real baked model.
 * Skips if the asset is absent.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { parsePcaModel } from '../src/engine/hrtf/hrtfPca';
import { personalizePcaMinPhase } from '../src/engine/hrtf/personalize';
import type { MinPhaseHrtf } from '../src/engine/hrtf/interpolatingDsp';

const PATH = 'assets/hrtf/hrtf_pca.bin';
const have = existsSync(PATH);

/** A small synthetic min-phase set: a few directions, short impulse per ear. */
function toySet(): MinPhaseHrtf {
  const taps = 32, count = 4;
  const irs = new Float32Array(count * 2 * taps);
  for (let m = 0; m < count; m++) {
    // a decaying impulse so it has broadband magnitude
    for (let e = 0; e < 2; e++) {
      const base = m * 2 * taps + e * taps;
      irs[base] = 1;
      irs[base + 2] = 0.5;
      irs[base + 5] = -0.25;
    }
  }
  const dirs = new Float32Array([0, 0, -1, 1, 0, 0, 0, 1, 0, -1, 0, 0]);
  return { sampleRate: 44100, taps, count, dirs, irs, itdL: new Float32Array(count), itdR: new Float32Array(count) };
}

describe.skipIf(!have)('personalizePcaMinPhase', () => {
  const buf = readFileSync(PATH);
  const model = parsePcaModel(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

  it('zero weights → unchanged IRs (structural copy)', () => {
    const set = toySet();
    const out = personalizePcaMinPhase(set, model, [0, 0, 0, 0, 0]);
    expect(out.irs).not.toBe(set.irs); // copy, not alias
    for (let i = 0; i < set.irs.length; i++) expect(out.irs[i]).toBeCloseTo(set.irs[i], 6);
  });

  it('nonzero weights change the IR and keep it finite + same length', () => {
    const set = toySet();
    const out = personalizePcaMinPhase(set, model, [2, 0, 0, 0, 0]);
    expect(out.taps).toBe(set.taps);
    expect(out.irs.length).toBe(set.irs.length);
    let changed = false;
    for (let i = 0; i < set.irs.length; i++) {
      expect(Number.isFinite(out.irs[i])).toBe(true);
      if (Math.abs(out.irs[i] - set.irs[i]) > 1e-4) changed = true;
    }
    expect(changed).toBe(true);
  });

  it('does not touch ITD', () => {
    const set = toySet();
    set.itdL[0] = 3; set.itdR[0] = 1;
    const out = personalizePcaMinPhase(set, model, [1, 1, 0, 0, 0]);
    expect(out.itdL[0]).toBe(3);
    expect(out.itdR[0]).toBe(1);
  });
});
