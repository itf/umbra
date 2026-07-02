/**
 * Orthogonal-array (OA) SCREENING for HRTF calibration — the global, few-trial first
 * phase that finds the right region of a many-parameter space before any local refine.
 *
 * WHY (design rationale the user drove):
 *  - We want to tune MANY parameters at once (parametric warp + PCA weights, ~8 dims),
 *    with the FEWEST pointing trials and the MOST information per trial.
 *  - Pure gradient descent risks a bad LOCAL MINIMUM — notably the front/back & up/down
 *    confusions, where a step "downhill" locks onto a mirrored-but-wrong percept.
 *  - An orthogonal array tests a small, BALANCED subset of the full grid so that every
 *    factor's every level appears equally against every other's. From ~L trials we get an
 *    unbiased MAIN-EFFECT estimate for ALL factors at once, sampled ACROSS the whole
 *    space (incl. the flipped region) — so it locates the right basin globally without
 *    committing early. Then a Bayesian phase (separate module) refines locally.
 *  - Guard: if the best screened error is still LARGE, we are NOT yet in a good basin —
 *    do NOT hand off to local refinement; re-screen instead. `basinIsGood()` encodes it.
 *
 * This module is PURE (no audio/DOM): array design, run→params mapping, main-effect
 * estimation, predicted-best assembly, and the basin guard. Unit-tested.
 */

/** One tunable factor: a name and three candidate levels (low, mid, high). */
export interface OaFactor {
  key: string;
  levels: [number, number, number];
}

/**
 * The L18 orthogonal array (Taguchi): 18 runs covering up to 1 two-level factor + 7
 * three-level factors, each entry a level index (0..2; the first column is 0..1). We use
 * the seven 3-level columns for our factors; unused columns are simply ignored. L18 is
 * the sweet spot for ~8 factors at 3 levels — full-grid would be 3^7 = 2187 runs.
 * Rows are the standard L18 (2×3^7) design.
 */
export const L18: number[][] = [
  [0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 1, 1, 1, 1, 1, 1],
  [0, 0, 2, 2, 2, 2, 2, 2],
  [0, 1, 0, 0, 1, 1, 2, 2],
  [0, 1, 1, 1, 2, 2, 0, 0],
  [0, 1, 2, 2, 0, 0, 1, 1],
  [0, 2, 0, 1, 0, 2, 1, 2],
  [0, 2, 1, 2, 1, 0, 2, 0],
  [0, 2, 2, 0, 2, 1, 0, 1],
  [1, 0, 0, 2, 2, 1, 1, 0],
  [1, 0, 1, 0, 0, 2, 2, 1],
  [1, 0, 2, 1, 1, 0, 0, 2],
  [1, 1, 0, 1, 2, 0, 2, 1],
  [1, 1, 1, 2, 0, 1, 0, 2],
  [1, 1, 2, 0, 1, 2, 1, 0],
  [1, 2, 0, 2, 1, 2, 0, 1],
  [1, 2, 1, 0, 2, 0, 1, 2],
  [1, 2, 2, 1, 0, 1, 2, 0],
];

/** The 3-level columns of L18 we assign factors to (skip col 0, the 2-level one). */
const THREE_LEVEL_COLS = [1, 2, 3, 4, 5, 6, 7];

/** Number of OA runs for a given factor count (always the full L18 = 18 for ≤7 factors). */
export function oaRunCount(): number {
  return L18.length;
}

/**
 * Build the concrete parameter value-map for OA run `runIdx`: for each factor, look up
 * its assigned column's level in that row and read the factor's level value.
 */
export function oaRunValues(factors: OaFactor[], runIdx: number): Record<string, number> {
  if (factors.length > THREE_LEVEL_COLS.length) {
    throw new Error(`L18 supports ≤${THREE_LEVEL_COLS.length} three-level factors, got ${factors.length}`);
  }
  const row = L18[runIdx];
  const out: Record<string, number> = {};
  factors.forEach((f, i) => {
    const lvl = row[THREE_LEVEL_COLS[i]];
    out[f.key] = f.levels[lvl];
  });
  return out;
}

/**
 * Estimate each factor's MAIN EFFECT from the run responses (lower response = better,
 * since our response is angular error). Returns, per factor, the mean response at each
 * of its three levels and the best level index (min mean). Because the array is
 * orthogonal, averaging a factor's level over all runs cancels the other factors — an
 * unbiased main-effect estimate from just the L18 runs.
 */
export function estimateMainEffects(
  factors: OaFactor[],
  responses: number[],
): Array<{ key: string; levelMeans: [number, number, number]; bestLevel: 0 | 1 | 2 }> {
  return factors.map((f, i) => {
    const col = THREE_LEVEL_COLS[i];
    const sums: [number, number, number] = [0, 0, 0];
    const counts: [number, number, number] = [0, 0, 0];
    for (let r = 0; r < L18.length; r++) {
      const lvl = L18[r][col] as 0 | 1 | 2;
      if (r < responses.length && Number.isFinite(responses[r])) {
        sums[lvl] += responses[r];
        counts[lvl] += 1;
      }
    }
    const levelMeans: [number, number, number] = [
      counts[0] ? sums[0] / counts[0] : Infinity,
      counts[1] ? sums[1] / counts[1] : Infinity,
      counts[2] ? sums[2] / counts[2] : Infinity,
    ];
    let bestLevel: 0 | 1 | 2 = 0;
    if (levelMeans[1] < levelMeans[bestLevel]) bestLevel = 1;
    if (levelMeans[2] < levelMeans[bestLevel]) bestLevel = 2;
    return { key: f.key, levelMeans, bestLevel };
  });
}

/**
 * Assemble the PREDICTED-BEST parameter map by taking each factor's best level. Under an
 * additive (main-effects) model this is the OA's prediction of the global optimum region
 * — the seed the Bayesian phase refines around.
 */
export function predictedBest(factors: OaFactor[], responses: number[]): Record<string, number> {
  const effects = estimateMainEffects(factors, responses);
  const out: Record<string, number> = {};
  factors.forEach((f, i) => { out[f.key] = f.levels[effects[i].bestLevel]; });
  return out;
}

/**
 * Basin guard: are we confidently in a GOOD region, or should we re-screen? Uses the
 * BEST observed run error — if even the best OA run is far off (> `thresholdRad`), the
 * additive prediction is untrustworthy (likely a front/back or up/down confusion), so
 * refinement would just polish a wrong answer. Returns false → caller re-screens (e.g.
 * with the flipped front/back region) instead of refining. Default threshold ≈ 35°.
 */
export function basinIsGood(responses: number[], thresholdRad = (35 * Math.PI) / 180): boolean {
  const finite = responses.filter((r) => Number.isFinite(r));
  if (finite.length === 0) return false;
  return Math.min(...finite) <= thresholdRad;
}
