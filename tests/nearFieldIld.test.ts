import { describe, it, expect } from 'vitest';
import {
  nearFieldEarGains, distanceIldDb, toDb,
  SADIE_H3_R_REF, DEFAULT_HEAD_RADIUS,
} from '../src/engine/hrtf/nearFieldIld';

// Head-local: +x right, +y up, -z fwd. A "side" (right) source sits on +x.
const sideDir = { x: 1, y: 0, z: 0 };
function atRange(dir: { x: number; y: number; z: number }, r: number) {
  const len = Math.hypot(dir.x, dir.y, dir.z);
  return { x: (dir.x / len) * r, y: (dir.y / len) * r, z: (dir.z / len) * r };
}

describe('nearFieldEarGains — near-field per-ear distance ILD prototype', () => {
  it('1) at r_ref the correction is unity for both ears (no double-count of baked ILD)', () => {
    for (const dir of [
      { x: 1, y: 0, z: 0 },          // hard right
      { x: 0.7, y: 0, z: -0.7 },     // right-front 45°
      { x: 0.5, y: 0.3, z: -0.8 },   // off-axis up
      { x: -1, y: 0, z: 0 },         // hard left
    ]) {
      const g = nearFieldEarGains(atRange(dir, SADIE_H3_R_REF));
      expect(g.left).toBeCloseTo(1, 6);
      expect(g.right).toBeCloseTo(1, 6);
      expect(distanceIldDb(g)).toBeCloseTo(0, 6); // ratio L/R ≈ 1 → 0 dB
    }
  });

  it('2) far (10 m) side source: distance-ILD does NOT grow; it undoes the r_ref bake', () => {
    // At 10 m the TRUE per-ear distance difference → 0, but the HRTF baked ~+1.27 dB at
    // r_ref. So the correction REMOVES that, yielding a small NEGATIVE residual (~-1.1 dB):
    // the model reduces, never amplifies, the inter-ear distance difference as you recede.
    const far = distanceIldDb(nearFieldEarGains(atRange(sideDir, 10)));
    expect(far).toBeLessThan(0); // negative = cancelling the baked-in distance ILD
    expect(far).toBeGreaterThan(-1.3); // bounded by the ~1.27 dB the bake contained
    // And it is monotonically smaller than the on-axis r_ref value (0 dB).
    expect(far).toBeLessThan(distanceIldDb(nearFieldEarGains(atRange(sideDir, SADIE_H3_R_REF))));
  });

  it('3) very near (~5 cm from the right ear): large distance-only ILD (~10-12 dB)', () => {
    // Right ear at (+a,0,0). Place source 5 cm further out on +x: x = a + 0.05.
    const p = { x: DEFAULT_HEAD_RADIUS + 0.05, y: 0, z: 0 };
    const g = nearFieldEarGains(p);
    const ild = distanceIldDb(g); // positive: right louder
    expect(ild).toBeGreaterThan(10);
    expect(ild).toBeLessThan(13);
    // Inside r_ref BOTH ears are nearer than the reference shell, so both ratios exceed 1;
    // the near (right) ear is boosted FAR more than the far (left) ear → the ILD lives in
    // their difference, not in one being <1.
    expect(g.right).toBeGreaterThan(1);
    expect(g.left).toBeGreaterThan(1);
    expect(g.right).toBeGreaterThan(g.left * 3); // right dominates
  });

  it('monotonic: ILD grows as the side source approaches the head', () => {
    const ilds = [2.0, 1.2, 0.6, 0.3, 0.13].map(
      (r) => distanceIldDb(nearFieldEarGains(atRange(sideDir, r))),
    );
    for (let i = 1; i < ilds.length; i++) expect(ilds[i]).toBeGreaterThan(ilds[i - 1]);
  });

  it('degenerate at head centre → unity (no NaN/Inf)', () => {
    const g = nearFieldEarGains({ x: 0, y: 0, z: 0 });
    expect(g.left).toBe(1);
    expect(g.right).toBe(1);
  });

  it('reports the r_ref distance-vs-shadowing split numbers (informational)', () => {
    // At r_ref, the distance term contributes ~0 dB (by construction, validation 1).
    // The geometric inter-ear distance difference at r_ref WITHOUT normalisation:
    const a = DEFAULT_HEAD_RADIUS, r = SADIE_H3_R_REF;
    const rRight = r - a, rLeft = r + a; // side source, exact on interaural axis
    const rawDistIld = toDb(rLeft / rRight); // dB the raw 1/r would give at r_ref
    // ~1.27 dB of the measured ~8.8 dB side-ILD is the distance term; rest is shadowing.
    expect(rawDistIld).toBeGreaterThan(1.0);
    expect(rawDistIld).toBeLessThan(1.6);
  });
});
