/**
 * Front/back CONTRAST feature construction for the data-driven front/back PC.
 *
 * The cue we want to capture is how the FRONT-vs-BACK spectral SHAPE differs across people.
 * Ordinary all-direction PCA averages this away. So per subject we form a contrast: for
 * each direction, pair it with its CONE-OF-CONFUSION mirror — azimuth θ ↔ (180°−θ) at the
 * SAME elevation. That mirror keeps the interaural/lateral coordinate (sin(az)·cos(el)) and
 * the elevation fixed and flips ONLY front/back (cos(az) → −cos(az)). Pairing θ ↔ −θ would
 * be the LEFT/RIGHT mirror (measures interaural differences) — the WRONG cue.
 *
 * For each matched (front, back) pair we take the per-bin log-mag difference (front − back)
 * and average over all pairs → one contrast spectrum per subject. Pure + unit-tested.
 */

/** Cone-of-confusion mirror of an azimuth (deg): θ → 180−θ, wrapped to (−180,180].
 *  Front/back flips; the lateral component sin(az) is preserved (sin(180−θ)=sin(θ)). */
export function coneMirrorAzDeg(azDeg) {
  let m = 180 - azDeg;
  m = ((m + 180) % 360 + 360) % 360 - 180;
  return m;
}

/** Nearest grid index to (azDeg, elDeg) using wrapped-azimuth + elevation angular distance.
 *  gridAz/gridEl are per-direction arrays (engine convention degrees). */
export function nearestGridIndex(gridAz, gridEl, azDeg, elDeg) {
  const wrap = (d) => { let x = d % 360; if (x > 180) x -= 360; if (x < -180) x += 360; return x; };
  let best = -1, bd = Infinity;
  for (let g = 0; g < gridAz.length; g++) {
    const d = Math.abs(wrap(gridAz[g] - azDeg)) + Math.abs(gridEl[g] - elDeg);
    if (d < bd) { bd = d; best = g; }
  }
  return { idx: best, dist: bd };
}

/**
 * Build the front↔back matched pairs over a direction grid (engine az/el degrees). Each
 * pair is [frontG, backG] where backG is the nearest grid dir to the front dir's cone
 * mirror. Only FRONT-hemisphere seeds (cos(az)>0 ⇒ −z front) that are not near the median
 * plane, and only pairs whose mirror is well-matched (small angular gap) are kept.
 *
 * Returns [{frontG, backG, azDeg, elDeg}]. Deterministic.
 */
export function buildFrontBackPairs(gridAz, gridEl, opts = {}) {
  const { minLateralGapDeg = 25, maxMatchDeg = 12 } = opts;
  const pairs = [];
  for (let g = 0; g < gridAz.length; g++) {
    const az = gridAz[g], el = gridEl[g];
    // Front hemisphere = |az| < 90°. Skip near the median plane (|az|→0 or →180: front/back
    // is maximally ambiguous AND the mirror ≈ itself), and skip near the interaural poles.
    const absAz = Math.abs(az);
    if (absAz >= 90) continue;                 // back hemisphere seed → its mirror covers it
    if (absAz < minLateralGapDeg) continue;    // too close to straight ahead
    if (absAz > 90 - 1) continue;              // ~±90 is the cone apex (mirror = self)
    const mAz = coneMirrorAzDeg(az);
    const { idx: backG, dist } = nearestGridIndex(gridAz, gridEl, mAz, el);
    if (backG < 0 || dist > maxMatchDeg) continue;
    pairs.push({ frontG: g, backG, azDeg: az, elDeg: el });
  }
  return pairs;
}

/**
 * One subject's front/back contrast spectrum: mean over pairs of (front − back) per-bin
 * log-magnitude. `featOf(g)` returns the KEEP_BINS log-mag feature for grid dir g.
 */
export function contrastSpectrum(pairs, featOf, keepBins) {
  const diff = new Float64Array(keepBins);
  for (const { frontG, backG } of pairs) {
    const f = featOf(frontG), b = featOf(backG);
    for (let i = 0; i < keepBins; i++) diff[i] += f[i] - b[i];
  }
  const n = pairs.length || 1;
  for (let i = 0; i < keepBins; i++) diff[i] /= n;
  return diff;
}
