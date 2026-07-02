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
