/**
 * Tests the runtime PCA model parser + curve math against the REAL baked asset
 * (assets/hrtf/hrtf_pca.bin, SS2-derived). If the asset is absent (fresh checkout
 * without the bake), the suite skips rather than fails.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import {
  parsePcaModel, deformationCurve, nearestDirIndex, vecToAzEl, normFreqToCurveIndex,
  PC_KIND_MAGNITUDE, PC_KIND_FRONTBACK, type HrtfPcaModel,
} from '../src/engine/hrtf/hrtfPca';

const PATH = 'assets/hrtf/hrtf_pca.bin';
const have = existsSync(PATH);

describe('hemisphere-signed front/back contrast PC (synthetic model)', () => {
  // Minimal model: 1 dir, 2 bins, 2 PCs — one MAGNITUDE, one FRONT/BACK contrast.
  const mk = (): HrtfPcaModel => ({
    subjects: 1, dirs: 1, bins: 2, k: 2, az: [0], el: [0],
    mean: new Float32Array([0, 0]),
    pcs: [
      { scale: 1, vec: new Float32Array([1, 0]), kind: PC_KIND_MAGNITUDE, name: 'Overall ear shape 1' },
      { scale: 1, vec: new Float32Array([0, 1]), kind: PC_KIND_FRONTBACK, name: 'Front/back tone' },
    ],
    gridAz: 1, gridEl: 1, flatGrid: true, nfft: 512,
  });

  it('magnitude PC ignores hemisphere sign; contrast PC flips with it', () => {
    const m = mk();
    const front = deformationCurve(m, [1, 1], 0, +1); // front hemisphere
    const back = deformationCurve(m, [1, 1], 0, -1);  // back hemisphere
    // bin 0 = magnitude PC → same regardless of hemisphere
    expect(front[0]).toBeCloseTo(back[0], 6);
    expect(front[0]).toBeCloseTo(1, 6);
    // bin 1 = contrast PC → equal & OPPOSITE across hemispheres
    expect(front[1]).toBeCloseTo(1, 6);
    expect(back[1]).toBeCloseTo(-1, 6);
  });

  it('contrast contribution scales with the passed sign (fades near the median plane)', () => {
    const m = mk();
    expect(deformationCurve(m, [0, 1], 0, 0)[1]).toBeCloseTo(0, 6); // sign 0 → no contrast
    expect(deformationCurve(m, [0, 1], 0, 0.5)[1]).toBeCloseTo(0.5, 6);
  });
});

describe.skipIf(!have)('hrtf PCA model', () => {
  const buf = have ? readFileSync(PATH) : null;
  const model = () => parsePcaModel(buf!.buffer.slice(buf!.byteOffset, buf!.byteOffset + buf!.byteLength));
  const zeros = () => new Array(model().k).fill(0);

  it('parses the baked asset with sane dimensions', () => {
    const m = model();
    expect(m.subjects).toBeGreaterThanOrEqual(70); // SS2 = 78
    expect(m.k).toBeGreaterThanOrEqual(3);
    expect(m.mean.length).toBe(m.dirs * m.bins);
    expect(m.pcs.length).toBe(m.k);
    expect(m.pcs[0].vec.length).toBe(m.dirs * m.bins);
    expect(m.pcs[0].scale).toBeGreaterThan(0);
  });

  it('is a flat per-direction grid (v2+)', () => {
    const m = model();
    expect(m.flatGrid).toBe(true);
    expect(m.az.length).toBe(m.dirs);
    expect(m.el.length).toBe(m.dirs);
    expect(m.nfft).toBeGreaterThan(0);
  });

  it('carries per-PC kinds incl. at least one front/back contrast PC (v3)', () => {
    const m = model();
    for (const pc of m.pcs) expect([PC_KIND_MAGNITUDE, PC_KIND_FRONTBACK]).toContain(pc.kind);
    const nFb = m.pcs.filter((p) => p.kind === PC_KIND_FRONTBACK).length;
    expect(nFb).toBeGreaterThanOrEqual(1); // the data-driven front/back PC(s)
    expect(m.pcs.some((p) => p.kind === PC_KIND_MAGNITUDE)).toBe(true); // general + pinna
  });

  it('carries meaningful per-PC names (v4) for the manual knobs', () => {
    const m = model();
    for (const pc of m.pcs) {
      expect(typeof pc.name).toBe('string');
      expect(pc.name.length).toBeGreaterThan(0);
      expect(pc.name).not.toMatch(/^Real-ear shape/); // not the generic fallback
    }
    // The pinna PC and front/back PCs are named for what they control.
    expect(m.pcs.some((p) => /pinna/i.test(p.name))).toBe(true);
    expect(m.pcs.some((p) => /front\/back/i.test(p.name))).toBe(true);
    // Front/back-named PCs are the contrast kind.
    for (const pc of m.pcs) if (/front\/back/i.test(pc.name)) expect(pc.kind).toBe(PC_KIND_FRONTBACK);
  });

  it('zero weights → zero deformation', () => {
    const m = model();
    const curve = deformationCurve(m, zeros(), 100);
    expect(curve.every((v) => v === 0)).toBe(true);
  });

  it('nonzero weight → nonzero, and scales with the weight', () => {
    const m = model();
    const w1 = zeros(); w1[0] = 1;
    const w2 = zeros(); w2[0] = 2;
    const c1 = deformationCurve(m, w1, 100);
    const c2 = deformationCurve(m, w2, 100);
    const norm = (a: Float32Array) => Math.sqrt(a.reduce((p, c) => p + c * c, 0));
    expect(norm(c1)).toBeGreaterThan(0);
    expect(norm(c2)).toBeCloseTo(2 * norm(c1), 3); // linear in weight
  });

  it('the last PC (pinna band) only deforms mid/high frequencies', () => {
    const m = model();
    const w = zeros(); w[m.k - 1] = 2; // pinna PC is appended last
    const curve = deformationCurve(m, w, 100);
    // The lowest few log-mag bins (sub-~1 kHz) should be untouched by the pinna PC.
    const lowEnergy = Math.abs(curve[0]) + Math.abs(curve[1]) + Math.abs(curve[2]);
    const totalEnergy = curve.reduce((p, c) => p + Math.abs(c), 0);
    expect(totalEnergy).toBeGreaterThan(0);
    expect(lowEnergy).toBeLessThan(0.05 * totalEnergy);
  });

  it('nearestDirIndex lands in range for (0,0,-1) (front)', () => {
    const m = model();
    const { az, el } = vecToAzEl(0, 0, -1);
    const idx = nearestDirIndex(m, az, el);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(m.dirs);
  });

  it('normFreqToCurveIndex is monotonic and log-spaced', () => {
    const m = model();
    const lo = normFreqToCurveIndex(0.05, m.bins, m.nfft);
    const mid = normFreqToCurveIndex(0.3, m.bins, m.nfft);
    const hi = normFreqToCurveIndex(1.0, m.bins, m.nfft);
    expect(lo).toBeLessThan(mid);
    expect(mid).toBeLessThan(hi);
    expect(hi).toBeCloseTo(m.bins - 1, 5); // fnorm=1 → top curve bin
  });
});
