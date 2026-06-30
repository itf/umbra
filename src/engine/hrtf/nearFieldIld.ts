/**
 * PROTOTYPE — near-field per-ear distance ILD model (NOT yet wired into the renderers).
 *
 * Why this exists
 * ---------------
 * The renderers apply ONE distance gain `g = 1/max(1,dist)` computed from the distance
 * to the HEAD CENTRE, then feed the (far-field-measured) SADIE HRTF. The measured HRTF
 * already bakes in the far-field ILD — head shadowing AND the per-ear distance difference
 * *at the measurement distance r_ref* (SADIE H3 = 1.2 m, read from the SOFA
 * SourcePosition column; see docs/product/near-field-ild-prototype.md).
 *
 * What's missing is the NEAR-FIELD per-ear distance ILD: a source close to one ear should
 * be dramatically louder in that ear. We model it as TWO ear-specific gains that REPLACE
 * the single head-centre 1/r, NORMALISED so the model is a no-op at r_ref (otherwise we'd
 * double-count the distance ILD the HRTF already contains).
 *
 * Per-ear correction (relative to head-centre 1/r):
 *   gain_ear = r_ref_thatEar / r_ear
 * where r_ear is the source→ear distance and r_ref_thatEar is what that distance WOULD have
 * been with the source at the same DIRECTION but at r_ref from the head centre. At the
 * reference shell the ratio is ≈1 (no change); beyond it the inter-ear ratio collapses
 * toward 1 (distance ILD → 0, correctly undoing the r_ref-baked difference as both ears
 * approach equal range); within it the ratio grows (near ear loud, far ear quiet).
 *
 * The total per-ear distance gain to feed the chain is then:
 *   distanceGain_ear = (1/max(1, dist_headCentre)) * (r_ref_thatEar / r_ear)
 * i.e. the existing head-centre law TIMES the normalised near-field correction, so at
 * r_ref it reduces exactly to today's behaviour.
 *
 * Geometry / head model
 * ---------------------
 * Spherical-head model (Algazi/Duda), standard head radius a = 0.0875 m (8.75 cm). Ears sit
 * at ±a on the interaural (left-right) axis from the head centre. The renderer's listener
 * space is +x RIGHT, +y UP, −z FORWARD (see sofa.ts). So:
 *   right ear = (+a, 0, 0),  left ear = (−a, 0, 0).
 */

export const DEFAULT_HEAD_RADIUS = 0.0875; // m — spherical head model (Algazi & Duda 2001)
export const SADIE_H3_R_REF = 1.2; // m — measured from SourcePosition[*][2] in sadie_h3_48k.sofa

export interface EarGains {
  /** Per-ear NORMALISED correction (r_ref_ear / r_ear); ≈1 at r_ref. */
  left: number;
  right: number;
}

/**
 * Per-ear normalised near-field correction gains for a head-relative source position.
 *
 * @param p        source position in HEAD-LOCAL coords (metres): +x right, +y up, −z fwd.
 *                 This is the renderer's `headDir` BEFORE normalisation (i.e. with the true
 *                 magnitude = distance to head centre).
 * @param rRef     HRTF measurement distance (m). For SADIE H3 = 1.2.
 * @param headRadius ear offset from head centre (m).
 * @returns { left, right } each = r_ref_thatEar / r_thatEar, ≈1 at the reference shell.
 *
 * Pure; no allocation beyond the result. Safe-guards: if the source is essentially AT an ear
 * (r_ear → 0) the gain is clamped to a finite cap so it can't blow up the mix.
 */
export function nearFieldEarGains(
  p: { x: number; y: number; z: number },
  rRef = SADIE_H3_R_REF,
  headRadius = DEFAULT_HEAD_RADIUS,
): EarGains {
  // Direction to the source from the head centre.
  const dist = Math.hypot(p.x, p.y, p.z);
  // A degenerate "at the head centre" query: no inter-ear difference.
  if (dist < 1e-6) return { left: 1, right: 1 };
  const ux = p.x / dist, uy = p.y / dist, uz = p.z / dist;

  // The reference source position for THIS direction: same direction, range = rRef.
  const refx = ux * rRef, refy = uy * rRef, refz = uz * rRef;

  const a = headRadius;
  // Right ear at (+a,0,0), left ear at (−a,0,0).
  const rRightNow = Math.hypot(p.x - a, p.y, p.z);
  const rLeftNow = Math.hypot(p.x + a, p.y, p.z);
  const rRightRef = Math.hypot(refx - a, refy, refz);
  const rLeftRef = Math.hypot(refx + a, refy, refz);

  // Cap each ratio only to prevent a divide-by-~0 blow-up when the source touches an ear.
  // Note: the near-field ILD lives in the DIFFERENCE of the two ratios, so the cap must be
  // generous (it must not clip the near ear before the ILD is realised). At 5 cm the right
  // ratio is ~22; CAP=40 (~+32 dB) leaves the full near-field ILD intact yet still bounds
  // the degenerate touch-the-ear case. Overall loudness stays bounded because integration
  // multiplies this by the head-centre 1/r law, which shrinks as the source nears the head.
  const CAP = 40;
  const right = Math.min(CAP, rRightRef / Math.max(rRightNow, 1e-4));
  const left = Math.min(CAP, rLeftRef / Math.max(rLeftNow, 1e-4));
  return { left, right };
}

/** Linear amplitude ratio → dB. */
export function toDb(ratio: number): number {
  return 20 * Math.log10(ratio);
}

/** The near-field distance-ILD (dB) the model contributes: 20log10(right/left). Positive = louder right. */
export function distanceIldDb(g: EarGains): number {
  return toDb(g.right / g.left);
}
