/**
 * Objective LOCALIZATION calibration — the "point to where the sound came from"
 * mode.
 *
 * Instead of the subjective A/B ("which felt better?"), this measures how ACCURATELY
 * a candidate HRTF warp lets the listener locate a sound. For each of the two
 * candidates we play a short probe at a random direction on the 1 m shell; the
 * listener points to where they heard it (on the visualizer); we record the angular
 * ERROR. After a few trials each, the candidate with the SMALLER mean error wins —
 * an objective, non-preference verdict the staircase can consume exactly like an A/B
 * choice, and the same scorer PCA refinement will reuse.
 *
 * Pure geometry + accumulation — no audio, no DOM. Unit-tested in
 * tests/hrtfLocalize.test.ts.
 */

export type Vec3 = readonly [number, number, number];

/** A direction on the unit sphere, engine convention (+x right, +y up, −z front). */
export interface Direction {
  az: number; // radians, 0 = front, +right (clockwise seen from above)
  el: number; // radians, + up, in [−π/2, +π/2]
}

/** Unit vector for a direction (engine convention). */
export function dirToVec(d: Direction): Vec3 {
  const cosEl = Math.cos(d.el);
  return [Math.sin(d.az) * cosEl, Math.sin(d.el), -Math.cos(d.az) * cosEl];
}

/** A position on the shell at radius `r`, listener at head height `headY`. */
export function dirToPosition(d: Direction, r = 1, headY = 1.6): Vec3 {
  const [x, y, z] = dirToVec(d);
  return [x * r, headY + y * r, z * r];
}

/**
 * DECOMPOSED localization error — the three PERCEPTUAL components, each mapping to a
 * different HRTF parameter, so a trial informs the RIGHT knob instead of blaming one
 * scalar total (see the calibration design):
 *   • lateral   — signed left/right miss (interaural axis). + = guessed too far RIGHT.
 *                 Drives ITD / head-width. Weighted by how lateral the TRUTH is (near
 *                 the median plane there's little L/R info; overhead is degenerate).
 *   • frontBack — signed fore/aft miss. + = guessed too far FRONT of the truth. A sign
 *                 flip here is the classic front/back confusion → drives frontBackTilt.
 *   • updown    — signed elevation miss (radians). + = guessed too HIGH. Drives the
 *                 pinna notch / PCA. This one is well-conditioned even overhead.
 * Angles in radians. `lateralWeight` (0..1) lets a caller down-weight lateral error for
 * near-overhead/median targets where azimuth is ill-defined.
 */
export interface ErrorComponents {
  lateral: number;
  frontBack: number;
  updown: number;
  lateralWeight: number;
  /** The scalar great-circle angle too, for progress display / stop conditions. */
  total: number;
}

export function decomposeError(truth: Direction, guess: Direction): ErrorComponents {
  // Up/down: straightforward elevation difference (+ = guessed higher).
  const updown = guess.el - truth.el;
  // Lateral: the interaural (x) coordinate is sin(az)cos(el); its difference is the
  // left/right miss. + when the guess sits further right than the truth.
  const vt = dirToVec(truth), vg = dirToVec(guess);
  const lateral = Math.asin(clamp(vg[0], -1, 1)) - Math.asin(clamp(vt[0], -1, 1));
  // Front/back: −z is front. + when the guess is further front (more negative z).
  const frontBack = Math.asin(clamp(-vg[2], -1, 1)) - Math.asin(clamp(-vt[2], -1, 1));
  // Lateral information vanishes as the truth approaches straight up/down (cos el → 0):
  // there, azimuth is degenerate, so weight lateral error by cos(el) of the truth.
  const lateralWeight = Math.max(0, Math.cos(truth.el));
  return { lateral, frontBack, updown, lateralWeight, total: angularError(truth, guess) };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Great-circle angle (radians) between two directions — the localization error. */
export function angularError(a: Direction, b: Direction): number {
  const va = dirToVec(a);
  const vb = dirToVec(b);
  const dot = va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2];
  return Math.acos(Math.max(-1, Math.min(1, dot)));
}

/** Scramble a seed so SMALL, CLOSELY-SPACED seeds (1, 8, 15, …) don't correlate — a
 *  plain LCG's first output for such seeds clusters (they all landed on the LEFT side,
 *  the reported "every probe is on the left" bug). This is a MurmurHash3 finalizer. */
function mix32(x: number): number {
  let h = x >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** A DETERMINISTIC shuffle of [0..n) seeded via mix32 — a Fisher–Yates driven by a
 *  mix32-seeded LCG, so the round-robin pass order is varied per pass yet reproducible
 *  (tests + resume rely on this). Returns a fresh index array. */
export function seededShuffle(n: number, seed: number): number[] {
  const out = Array.from({ length: n }, (_, i) => i);
  let s = mix32((seed >>> 0) || 1) || 1;
  const rnd = () => { s = (Math.imul(1664525, s) + 1013904223) >>> 0; return s / 0x100000000; };
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = out[i]; out[i] = out[j]; out[j] = t;
  }
  return out;
}

/**
 * Deterministic pseudo-random test directions (seeded — scripts can't use Math.random
 * reproducibly and tests need stability). Azimuth spans the FULL circle and elevation
 * −60°..+60° (matching the spiral range), so front/back and up/down are both exercised.
 * The seed is HASHED first (see mix32) so consecutive small seeds give well-spread
 * directions instead of clustering on one side.
 */
export function makeTestDirections(count: number, seed = 1): Direction[] {
  let s = mix32((seed >>> 0) || 1) || 1;
  const rnd = () => {
    // Numerical Recipes LCG on the mixed seed.
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  const out: Direction[] = [];
  for (let i = 0; i < count; i++) {
    const az = rnd() * 2 * Math.PI - Math.PI; // −π..π
    const el = (rnd() * 120 - 60) * (Math.PI / 180); // −60..+60°
    out.push({ az, el });
  }
  return out;
}

/**
 * Which region of the sphere a probe direction should be drawn from, so the trial is
 * DIAGNOSTIC for the parameter under test (a param only manifests in certain directions):
 *   • 'frontback' — front/back-ambiguous zone: near the median plane / cone of confusion
 *                   (azimuth near 0 or ±180, modest |el|). Where front/back confusion lives.
 *   • 'elevation' — off the horizontal (|el| ~20–60°, away from the degenerate poles), where
 *                   elevation / pinna-notch cues live.
 *   • 'lateral'   — lateral, near-horizontal (|az| toward ±90) where interaural (ITD/ILD)
 *                   cues dominate.
 *   • 'balanced'  — an even spread across all zones (for the base-head screen: heads must be
 *                   judged over the whole sphere, incl. front/back-ambiguous AND elevated).
 */
export type SampleKind = 'frontback' | 'elevation' | 'lateral' | 'balanced';

/**
 * A seeded, DIAGNOSTIC probe direction for the given sample kind. Uses the same mix32 seed
 * scrambling as makeTestDirections so consecutive small seeds give well-spread directions
 * and tests stay reproducible. Pure. See SampleKind for what each region targets.
 */
export function makeTargetedDirection(kind: SampleKind, seed = 1): Direction {
  let s = mix32((seed >>> 0) || 1) || 1;
  const rnd = () => { s = (Math.imul(1664525, s) + 1013904223) >>> 0; return s / 0x100000000; };
  const DEG = Math.PI / 180;
  switch (kind) {
    case 'frontback': {
      // Near the median plane: pick the front OR back pole, jitter azimuth only slightly
      // (±25°) so |lateral| stays low (the cone of confusion), with a modest elevation.
      const back = rnd() < 0.5;
      const azJit = (rnd() * 50 - 25) * DEG;            // ±25° around 0 (front) or π (back)
      const az = (back ? Math.PI : 0) + azJit;
      const el = (rnd() * 50 - 25) * DEG;               // −25..+25°
      return { az: wrapPi(az), el };
    }
    case 'elevation': {
      // Meaningful elevation (|el| 20–60°), any azimuth. Avoid the exact poles (±90°).
      const up = rnd() < 0.5 ? 1 : -1;
      const el = up * (20 + rnd() * 40) * DEG;          // ±(20..60)°
      const az = rnd() * 2 * Math.PI - Math.PI;
      return { az, el };
    }
    case 'lateral': {
      // Lateral, near horizontal: azimuth near ±90° (±25°), small elevation.
      const rightSide = rnd() < 0.5 ? 1 : -1;
      const az = rightSide * (Math.PI / 2) + (rnd() * 50 - 25) * DEG; // ±90 ±25°
      const el = (rnd() * 30 - 15) * DEG;               // −15..+15°
      return { az: wrapPi(az), el };
    }
    case 'balanced':
    default: {
      // Round-robin the three diagnostic zones by seed so a base head is judged across the
      // whole sphere (front/back-ambiguous, elevated, AND lateral), not just random luck.
      const zone = (mix32(seed) >>> 0) % 3;
      const sub = (seed * 2654435761) >>> 0; // decorrelated sub-seed for the chosen zone
      if (zone === 0) return makeTargetedDirection('frontback', sub);
      if (zone === 1) return makeTargetedDirection('elevation', sub);
      return makeTargetedDirection('lateral', sub);
    }
  }
}

/** Wrap an angle to (−π, π]. */
function wrapPi(a: number): number {
  let x = a % (2 * Math.PI);
  if (x > Math.PI) x -= 2 * Math.PI;
  if (x <= -Math.PI) x += 2 * Math.PI;
  return x;
}

/** One recorded localization attempt. */
export interface Attempt {
  which: 'a' | 'b';
  error: number; // radians
}

/**
 * Accumulate attempts and decide which candidate localized better. Returns null while
 * either candidate still has fewer than `minPerCandidate` attempts (undecided). The
 * winner is the candidate with the smaller MEAN angular error; ties (within `tolRad`)
 * resolve to 'a' (keep the incumbent), matching the staircase's "reject B unless
 * clearly better" bias.
 */
export function decideWinner(
  attempts: readonly Attempt[],
  minPerCandidate = 2,
  tolRad = 0.05,
): 'a' | 'b' | null {
  const mean = (w: 'a' | 'b') => {
    const es = attempts.filter((x) => x.which === w).map((x) => x.error);
    return es.length ? es.reduce((p, c) => p + c, 0) / es.length : NaN;
  };
  const na = attempts.filter((x) => x.which === 'a').length;
  const nb = attempts.filter((x) => x.which === 'b').length;
  if (na < minPerCandidate || nb < minPerCandidate) return null;
  const ma = mean('a');
  const mb = mean('b');
  if (mb < ma - tolRad) return 'b';
  return 'a';
}

// ============================================================================
// BASIN TRACKING + CONFIRM STOPPING
//
// A per-target (per parameter, or the base-head screen) search that, instead of a blind
// binary staircase, BUCKETS the candidate range, tallies pointing error per bucket as the
// user probes, and tracks the low-error "basin". Two phases:
//   • explore — spread probes across buckets until each candidate bucket has ≥ minPerBucket
//     samples (round-robin the least-sampled bucket), tracking a running scatter accumulator.
//   • confirm — shortlist the few lowest-mean-error buckets, re-probe them head-to-head
//     until the leader's advantage clears the noise (scatter-scaled) OR a cap; then done.
// The winner is the shortlisted bucket with the lowest mean error (ties → lowest index,
// the incumbent-bias). Confirm end = the leader beats the runner-up by ≥ its pooled scatter
// (so we don't stop while the top two are within pointing noise), or confirmCap reached.
//
// The STATE is a plain JSON-serializable object (numbers + arrays only) — the resume-
// persistence task saves/reloads exactly this. No class instances, no closures inside it.
// ============================================================================

export interface BasinState {
  /** Value range this basin partitions (e.g. a param's [min,max], or [0, nHeads] for heads). */
  min: number;
  max: number;
  /** Number of buckets across [min,max]. For a discrete set (heads) use one bucket each. */
  nBuckets: number;
  /** Per-bucket tallies (length nBuckets). errSum/errSqSum give mean + scatter. */
  counts: number[];
  errSum: number[];
  errSqSum: number[];
  /** Phase machine. */
  phase: 'explore' | 'confirm' | 'done';
  /** In confirm: the bucket indices being compared head-to-head (lowest-error shortlist). */
  shortlist: number[];
  /** Confirm-phase probe count (against the cap). */
  confirmRounds: number;
  /** The chosen bucket once phase==='done' (else -1). */
  chosen: number;
}

export interface BasinConfig {
  /** Min probes per bucket before a bucket counts as "explored". */
  minPerBucket: number;
  /** How many lowest-error buckets to carry into confirm. */
  shortlistSize: number;
  /** Max confirm-phase probes before deciding on current means. */
  confirmCap: number;
  /** Discrete basin (one bucket per integer value, e.g. candidate heads) — bucket centres
   *  are the integers themselves, not sub-divided range midpoints. */
  discrete?: boolean;
}

export const DEFAULT_BASIN_CONFIG: BasinConfig = {
  minPerBucket: 1, shortlistSize: 3, confirmCap: 8,
};

/** Fresh basin over [min,max] with nBuckets. Serializable. */
export function makeBasin(min: number, max: number, nBuckets: number): BasinState {
  return {
    min, max, nBuckets,
    counts: new Array(nBuckets).fill(0),
    errSum: new Array(nBuckets).fill(0),
    errSqSum: new Array(nBuckets).fill(0),
    phase: 'explore', shortlist: [], confirmRounds: 0, chosen: -1,
  };
}

/** The VALUE at a bucket's centre (what to probe for that bucket). Discrete → the integer. */
export function basinBucketValue(s: BasinState, bucket: number, discrete = false): number {
  if (discrete) return s.min + bucket; // buckets are consecutive integers from min
  // Continuous: bucket centre in [min,max].
  const frac = (bucket + 0.5) / s.nBuckets;
  return s.min + frac * (s.max - s.min);
}

/** Which bucket a value falls in (clamped). */
export function basinBucketFor(s: BasinState, value: number, discrete = false): number {
  if (discrete) return Math.max(0, Math.min(s.nBuckets - 1, Math.round(value - s.min)));
  const frac = (value - s.min) / (s.max - s.min || 1);
  return Math.max(0, Math.min(s.nBuckets - 1, Math.floor(frac * s.nBuckets)));
}

/** Record a probe: the candidate had `value`, the user pointed with angular `error` (rad). */
export function basinRecord(s: BasinState, value: number, error: number, discrete = false): void {
  const b = basinBucketFor(s, value, discrete);
  s.counts[b] += 1;
  s.errSum[b] += error;
  s.errSqSum[b] += error * error;
}

/** Mean error of a bucket (Infinity when unsampled → never "best"). */
export function basinMean(s: BasinState, bucket: number): number {
  const n = s.counts[bucket];
  return n > 0 ? s.errSum[bucket] / n : Infinity;
}

/** Sample scatter (std dev) of a bucket's error — the confidence/noise estimate. */
export function basinScatter(s: BasinState, bucket: number): number {
  const n = s.counts[bucket];
  if (n < 2) return Infinity; // not enough to estimate noise
  const mean = s.errSum[bucket] / n;
  const varr = Math.max(0, s.errSqSum[bucket] / n - mean * mean);
  return Math.sqrt(varr);
}

/** Buckets sorted by mean error ascending (ties → lower index); only sampled ones. */
function basinRanked(s: BasinState): number[] {
  const sampled = [];
  for (let b = 0; b < s.nBuckets; b++) if (s.counts[b] > 0) sampled.push(b);
  sampled.sort((a, b) => {
    const ma = basinMean(s, a), mb = basinMean(s, b);
    return ma !== mb ? ma - mb : a - b;
  });
  return sampled;
}

/**
 * Advance the basin state machine and return the NEXT value to probe (or the decision).
 * Call after each recorded probe. Pure w.r.t. `s` EXCEPT it mutates phase/shortlist/chosen
 * (the state transitions) — the caller owns `s` and may serialize it any time.
 *
 * Returns { done, value, bucket, phase }: when done, `value`/`bucket` is the chosen basin.
 */
export function basinNext(s: BasinState, cfg: BasinConfig = DEFAULT_BASIN_CONFIG): {
  done: boolean; value: number; bucket: number; phase: BasinState['phase'];
} {
  const discrete = !!cfg.discrete;
  const val = (b: number) => basinBucketValue(s, b, discrete);

  if (s.phase === 'explore') {
    // Any bucket still short of minPerBucket → probe the least-sampled such bucket.
    let target = -1, fewest = Infinity;
    for (let b = 0; b < s.nBuckets; b++) {
      if (s.counts[b] < cfg.minPerBucket && s.counts[b] < fewest) { fewest = s.counts[b]; target = b; }
    }
    if (target >= 0) return { done: false, value: val(target), bucket: target, phase: 'explore' };
    // All buckets explored → shortlist the lowest-error ones, enter confirm.
    s.shortlist = basinRanked(s).slice(0, Math.max(1, cfg.shortlistSize));
    s.phase = 'confirm';
    s.confirmRounds = 0;
  }

  if (s.phase === 'confirm') {
    const ranked = basinRanked(s).filter((b) => s.shortlist.includes(b));
    const leader = ranked[0];
    const runner = ranked[1];
    // A shortlisted bucket must hold up over ≥2 probes before it can win on separation — one
    // lucky low-error probe must NOT clinch it (that's the whole point of the confirm phase).
    const CONFIRM_MIN_SAMPLES = 2;
    const leaderProven = leader !== undefined && s.counts[leader] >= CONFIRM_MIN_SAMPLES;
    const runnerProven = runner === undefined || s.counts[runner] >= CONFIRM_MIN_SAMPLES;
    // Stop when the (proven) leader's lead over the runner-up clears the pooled scatter
    // (noise), or when the confirm cap is hit — then commit to the current leader.
    const leadClear = leaderProven && runnerProven && (
      runner === undefined
      || (basinMean(s, runner) - basinMean(s, leader)) >= pooledScatter(s, leader, runner)
    );
    if (leadClear || s.confirmRounds >= cfg.confirmCap) {
      s.phase = 'done';
      s.chosen = leader ?? 0;
      return { done: true, value: val(s.chosen), bucket: s.chosen, phase: 'done' };
    }
    // Otherwise re-probe the shortlisted bucket with the FEWEST samples (fair head-to-head).
    let target = s.shortlist[0], fewest = Infinity;
    for (const b of s.shortlist) if (s.counts[b] < fewest) { fewest = s.counts[b]; target = b; }
    s.confirmRounds += 1;
    return { done: false, value: val(target), bucket: target, phase: 'confirm' };
  }

  // done
  return { done: true, value: val(s.chosen < 0 ? 0 : s.chosen), bucket: Math.max(0, s.chosen), phase: 'done' };
}

/** How much SEARCH SPACE remains, 0..1, for the "shrinking" progress bar. Explore phase:
 *  fraction of buckets still under-sampled (whole range in play). Confirm phase: narrowed to
 *  the shortlist, shrinking toward the cap. Done: 0. Monotonically decreases. */
export function basinRemainingFraction(s: BasinState, cfg: BasinConfig = DEFAULT_BASIN_CONFIG): number {
  if (s.phase === 'done') return 0;
  if (s.phase === 'explore') {
    // 1 → the shortlist fraction as buckets fill (explore is the "wide" part of the search).
    let filled = 0;
    for (let b = 0; b < s.nBuckets; b++) if (s.counts[b] >= cfg.minPerBucket) filled++;
    const exploreDone = filled / s.nBuckets; // 0..1
    const shortlistFrac = Math.min(1, cfg.shortlistSize / s.nBuckets);
    return 1 - exploreDone * (1 - shortlistFrac); // 1 → shortlistFrac
  }
  // confirm: from the shortlist fraction down toward 0 as confirm rounds approach the cap.
  const shortlistFrac = Math.min(1, cfg.shortlistSize / s.nBuckets);
  const confirmProg = Math.min(1, s.confirmRounds / Math.max(1, cfg.confirmCap));
  return shortlistFrac * (1 - confirmProg);
}

// ---- INTERLEAVED ROUND-ROBIN SCHEDULER (pure; drives the pooled-factor loop) ----------

/** Serializable round-robin cursor over a factor pool. `order` is this pass's visiting
 *  order (a seededShuffle); `cursor` indexes into it; `pass` reshuffles on wrap. */
export interface RoundRobin {
  order: number[];
  cursor: number;
  pass: number;
}

/** Seed for a given pass's shuffle — stable so resume + tests reproduce the order. */
export function passOrderSeed(pass: number): number { return 1337 + pass * 101; }

/** Build the visiting order for a pass. */
export function makePassOrder(pass: number, nFactors: number): number[] {
  return seededShuffle(nFactors, passOrderSeed(pass));
}

/**
 * Pick the NEXT not-yet-converged factor round-robin, advancing (and reshuffling) passes as
 * the order is exhausted. Pure: takes the current RoundRobin + a `converged` mask, returns
 * the chosen factor index (or -1 when all converged) AND the advanced RoundRobin to store.
 * `advanceAfter` (default true) leaves the cursor PAST the chosen factor so the NEXT call
 * lands on a DIFFERENT factor — this is what interleaves factors/heads trial-to-trial.
 */
export function rrNext(
  rr: RoundRobin, converged: readonly boolean[], advanceAfter = true,
): { index: number; rr: RoundRobin } {
  const n = converged.length;
  if (n === 0 || converged.every(Boolean)) return { index: -1, rr };
  let { order, cursor, pass } = rr;
  let guard = 0;
  while (guard++ < n * 4 + 4) {
    if (cursor >= order.length) { pass++; order = makePassOrder(pass, n); cursor = 0; }
    const idx = order[cursor];
    if (converged[idx]) { cursor++; continue; }
    const nextCursor = advanceAfter ? cursor + 1 : cursor;
    return { index: idx, rr: { order, cursor: nextCursor, pass } };
  }
  return { index: -1, rr: { order, cursor, pass } };
}

/** Pooled scatter of two buckets — the noise floor the lead must clear to stop confirming.
 *  Falls back to a modest default (~5° = human pointing noise) when scatter is unknown. */
function pooledScatter(s: BasinState, a: number, b: number): number {
  const sa = basinScatter(s, a), sb = basinScatter(s, b);
  const HUMAN_NOISE = (5 * Math.PI) / 180;
  const va = Number.isFinite(sa) ? sa : HUMAN_NOISE;
  const vb = Number.isFinite(sb) ? sb : HUMAN_NOISE;
  return Math.sqrt((va * va + vb * vb) / 2);
}

/**
 * Invert the visualizer's oblique projection so a CLICK on the diagram becomes a
 * direction the user is pointing at. Mirrors hrtfVisualizer.project():
 *   sx = cx + x*scale
 *   sy = cy − relY*scale + dvY,  dvY = −z*scale*0.45
 * We fix the pointed direction to the 1 m shell (r = 1), and disambiguate depth from
 * the VERTICAL position of the click relative to the ring: clicks below the ear-line
 * ellipse read as FRONT, above as BACK — the same tilt the diagram draws. Elevation
 * then comes from how far above the projected ground point the click is.
 *
 * This is a best-effort 2D→3D map for a pointing UI; it need not be exact, only
 * monotonic (click left→az left, click high→elevation up, click low-front→front), so
 * the user can indicate a direction naturally.
 */
export function screenToDirection(
  sx: number,
  sy: number,
  cfg: { w: number; h: number; scale: number },
): Direction {
  const cx = cfg.w / 2;
  const cy = cfg.h / 2;
  const nx = (sx - cx) / cfg.scale; // world x on shell (−1..1 within ring)
  // Vertical click position splits into DEPTH (which half of the ring) and HEIGHT.
  // The ear-level ring in the diagram spans cy ± scale*0.45 vertically. We treat the
  // horizontal distance from centre as |x| and derive z from staying on the unit ring
  // when |x|<=1, choosing front vs back by whether the click is in the lower (front)
  // or upper (back) half.
  const clampedX = Math.max(-1, Math.min(1, nx));
  const lower = sy > cy; // below centre → front hemisphere
  const zMag = Math.sqrt(Math.max(0, 1 - clampedX * clampedX));
  const z = lower ? -zMag : zMag; // front = −z
  const az = Math.atan2(clampedX, -z); // matches dirToVec: x=sin(az)cosEl, −z=cos(az)cosEl
  // Height: how far the click sits ABOVE the ring line at this depth.
  const groundY = cy + -z * cfg.scale * 0.45; // = cy + dvY
  const relY = (groundY - sy) / cfg.scale; // metres above ear level on the shell
  const el = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, Math.asin(Math.max(-1, Math.min(1, relY)))));
  return { az, el };
}
