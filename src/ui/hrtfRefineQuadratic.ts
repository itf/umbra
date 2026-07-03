/**
 * Local QUADRATIC refinement — phase 2 of calibration, run AFTER the orthogonal-array
 * screen (hrtfCalibrateOA.ts) has found the general good region and the basin guard has
 * confirmed the error is small enough to trust.
 *
 * For each parameter, in the LOCAL neighborhood of the OA-found value, we sample the
 * angular error at a few offsets (−δ, 0, +δ), fit a parabola e(x) = a·x² + b·x + c, and
 * jump to its predicted minimum x* = −b / (2a), clamped to the neighborhood and the
 * global bounds. If the fit is not convex (a ≤ 0) or degenerate, we keep the best
 * SAMPLED point instead of trusting a bogus vertex. Confined to the neighborhood, so it
 * can only polish the region the OA already chose — it cannot wander into a far (wrong)
 * basin. Dependency-free + deterministic; a genuine Gaussian-process refiner can replace
 * this later once the whole flow is proven by ear.
 *
 * PURE: the vertex math + sample-point planning are here and unit-tested. The audio
 * (playing each sample point + reading the user's pointing error) lives in the UI, which
 * calls `planSamples` to get the points to audition and `fitVertex` to pick the winner.
 */

export interface Bounds { min: number; max: number; }

/**
 * The offsets to audition around `center` for one parameter: [−δ, 0, +δ], where δ is a
 * fraction of the parameter's range, clamped so all three stay within bounds. Returns
 * the three ABSOLUTE values to test (deduped-safe: they may coincide at a rail, which the
 * fit handles). `spanFrac` defaults to 25% of the range — a LOCAL probe, not global.
 */
export function planSamples(center: number, b: Bounds, spanFrac = 0.25): [number, number, number] {
  const range = b.max - b.min;
  const delta = range * spanFrac;
  const lo = Math.max(b.min, center - delta);
  const hi = Math.min(b.max, center + delta);
  return [lo, center, hi];
}

/**
 * Fit a parabola through three (x, error) samples and return the refined value: the
 * vertex if the parabola is convex and its vertex lies within [xs[0], xs[2]], else the
 * x of the lowest sampled error (never trust a concave/extrapolated vertex). Robust to
 * coincident x's (falls back to the argmin sample).
 */
export function fitVertex(
  xs: [number, number, number],
  errs: [number, number, number],
): number {
  // argmin sample — the safe fallback.
  let bestI = 0;
  if (errs[1] < errs[bestI]) bestI = 1;
  if (errs[2] < errs[bestI]) bestI = 2;
  const argmin = xs[bestI];

  const [x0, x1, x2] = xs;
  const [y0, y1, y2] = errs;
  // Need three distinct x's for a unique parabola.
  if (x0 === x1 || x1 === x2 || x0 === x2) return argmin;

  // Lagrange second-difference → quadratic coefficient `a` and vertex.
  const d01 = (y0 - y1) / (x0 - x1);
  const d12 = (y1 - y2) / (x1 - x2);
  const a = (d01 - d12) / (x0 - x2);
  if (!(a > 0) || !Number.isFinite(a)) return argmin; // not convex → don't trust a vertex

  // b from y = a x² + b x + c using points 0 and 1.
  const b = d01 - a * (x0 + x1);
  const vertex = -b / (2 * a);
  const lo = Math.min(x0, x2), hi = Math.max(x0, x2);
  if (!Number.isFinite(vertex) || vertex < lo || vertex > hi) return argmin; // extrapolation → distrust
  return vertex;
}
