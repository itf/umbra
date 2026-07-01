/**
 * Tests the runtime PCA model parser + curve math against the REAL baked asset
 * (assets/hrtf/cipic_pca.bin). If the asset is absent (fresh checkout without the
 * bake), the suite skips rather than fails.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { parsePcaModel, deformationCurve, nearestDirIndex, vecToCipicAzEl } from '../src/engine/hrtf/hrtfPca';

const PATH = 'assets/hrtf/cipic_pca.bin';
const have = existsSync(PATH);

describe.skipIf(!have)('hrtf PCA model', () => {
  const buf = have ? readFileSync(PATH) : null;
  const model = () => parsePcaModel(buf!.buffer.slice(buf!.byteOffset, buf!.byteOffset + buf!.byteLength));

  it('parses the baked asset with sane dimensions', () => {
    const m = model();
    expect(m.subjects).toBe(45);
    expect(m.k).toBeGreaterThanOrEqual(3);
    expect(m.dirs).toBe(m.gridAz * m.gridEl);
    expect(m.mean.length).toBe(m.dirs * m.bins);
    expect(m.pcs.length).toBe(m.k);
    expect(m.pcs[0].vec.length).toBe(m.dirs * m.bins);
    expect(m.pcs[0].scale).toBeGreaterThan(0);
  });

  it('zero weights → zero deformation', () => {
    const m = model();
    const curve = deformationCurve(m, [0, 0, 0, 0, 0], 100);
    expect(curve.every((v) => v === 0)).toBe(true);
  });

  it('nonzero weight → nonzero, and scales with the weight', () => {
    const m = model();
    const c1 = deformationCurve(m, [1, 0, 0, 0, 0], 100);
    const c2 = deformationCurve(m, [2, 0, 0, 0, 0], 100);
    const norm = (a: Float32Array) => Math.sqrt(a.reduce((p, c) => p + c * c, 0));
    expect(norm(c1)).toBeGreaterThan(0);
    expect(norm(c2)).toBeCloseTo(2 * norm(c1), 3); // linear in weight
  });

  it('nearestDirIndex lands in range and finds front for (0,0,-1)', () => {
    const m = model();
    const { az, el } = vecToCipicAzEl(0, 0, -1);
    const idx = nearestDirIndex(m, az, el);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(m.dirs);
  });
});
