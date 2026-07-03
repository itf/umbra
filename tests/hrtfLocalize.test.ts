/**
 * Pure tests for the objective localization calibration core: angular error, seeded
 * test directions, winner decision, and the visualizer click→direction inverse.
 */
import { describe, it, expect } from 'vitest';
import {
  angularError,
  decomposeError,
  makeTestDirections,
  makeTargetedDirection,
  decideWinner,
  screenToDirection,
  dirToVec,
  makeBasin,
  basinRecord,
  basinNext,
  basinBucketFor,
  basinBucketValue,
  basinMean,
  basinRemainingFraction,
  seededShuffle,
  makePassOrder,
  rrNext,
  type Attempt,
  type Direction,
  type BasinConfig,
  type RoundRobin,
} from '../src/ui/hrtfLocalize';

describe('angularError', () => {
  it('is zero for identical directions', () => {
    const d: Direction = { az: 0.5, el: 0.2 };
    expect(angularError(d, d)).toBeCloseTo(0, 6);
  });
  it('is π for antipodal directions', () => {
    expect(angularError({ az: 0, el: 0 }, { az: Math.PI, el: 0 })).toBeCloseTo(Math.PI, 4);
  });
  it('is π/2 for front vs directly overhead', () => {
    expect(angularError({ az: 0, el: 0 }, { az: 0, el: Math.PI / 2 })).toBeCloseTo(Math.PI / 2, 4);
  });
});

describe('makeTestDirections', () => {
  it('is deterministic for a fixed seed', () => {
    expect(makeTestDirections(5, 42)).toEqual(makeTestDirections(5, 42));
  });
  it('keeps elevation within ±60°', () => {
    for (const d of makeTestDirections(50, 7)) {
      expect(Math.abs(d.el)).toBeLessThanOrEqual((60 * Math.PI) / 180 + 1e-9);
    }
  });
  it('spreads across BOTH sides for the small, structured seeds the UI uses', () => {
    // Regression: a plain LCG made every small seed (1, 8, 15, …) land on the LEFT.
    // The seed-mix must give a mix of left AND right azimuths.
    let left = 0, right = 0;
    for (let exIdx = 0; exIdx < 3; exIdx++) {
      for (let att = 0; att < 4; att++) {
        const seed = exIdx * 101 + att * 7 + 1; // the exact formula the UI uses
        const az = makeTestDirections(1, seed)[0].az; // 0 front, + right
        if (az > 0.15) right++; else if (az < -0.15) left++;
      }
    }
    expect(left).toBeGreaterThan(0);
    expect(right).toBeGreaterThan(0);
  });
});

describe('decomposeError', () => {
  const D = (azDeg: number, elDeg: number) => ({ az: (azDeg * Math.PI) / 180, el: (elDeg * Math.PI) / 180 });

  it('is all-zero for a perfect guess', () => {
    const e = decomposeError(D(30, 10), D(30, 10));
    expect(e.lateral).toBeCloseTo(0, 6);
    expect(e.frontBack).toBeCloseTo(0, 6);
    expect(e.updown).toBeCloseTo(0, 6);
    expect(e.total).toBeCloseTo(0, 6);
  });

  it('guessing too far RIGHT gives positive lateral', () => {
    const e = decomposeError(D(0, 0), D(30, 0)); // truth front, guess to the right
    expect(e.lateral).toBeGreaterThan(0);
  });

  it('guessing too HIGH gives positive updown', () => {
    const e = decomposeError(D(0, 0), D(0, 30));
    expect(e.updown).toBeCloseTo((30 * Math.PI) / 180, 5);
  });

  it('a front/back flip shows up as a large frontBack component', () => {
    const front = D(0, 0);       // −z
    const back = D(180, 0);      // +z
    const e = decomposeError(front, back);
    expect(Math.abs(e.frontBack)).toBeGreaterThan(1.0); // big fore/aft miss
  });

  it('down-weights lateral error when the truth is overhead (degenerate azimuth)', () => {
    const horizon = decomposeError(D(0, 0), D(20, 0));
    const overhead = decomposeError(D(0, 85), D(20, 85));
    expect(overhead.lateralWeight).toBeLessThan(horizon.lateralWeight);
    expect(overhead.lateralWeight).toBeLessThan(0.2); // near zero overhead
  });
});

describe('decideWinner', () => {
  it('is undecided until both candidates have enough attempts', () => {
    const a: Attempt[] = [{ which: 'a', error: 0.1 }, { which: 'b', error: 0.1 }];
    expect(decideWinner(a, 2)).toBeNull();
  });
  it('picks the candidate with the smaller mean error', () => {
    const at: Attempt[] = [
      { which: 'a', error: 0.9 }, { which: 'a', error: 0.8 },
      { which: 'b', error: 0.2 }, { which: 'b', error: 0.1 },
    ];
    expect(decideWinner(at, 2)).toBe('b');
  });
  it('keeps A on a tie (incumbent bias)', () => {
    const at: Attempt[] = [
      { which: 'a', error: 0.30 }, { which: 'a', error: 0.30 },
      { which: 'b', error: 0.31 }, { which: 'b', error: 0.30 },
    ];
    expect(decideWinner(at, 2, 0.05)).toBe('a');
  });
});

describe('screenToDirection', () => {
  const cfg = { w: 260, h: 200, scale: 70 };
  const cx = cfg.w / 2, cy = cfg.h / 2;

  it('maps a click at the front of the ring to front, near ear level', () => {
    // In the oblique projection the front-ground point sits at the BOTTOM of the ring
    // (cy + scale*0.45), so that's where "front, ear level" is clicked — not centre.
    const frontGroundY = cy + cfg.scale * 0.45;
    const d = screenToDirection(cx, frontGroundY, cfg);
    const v = dirToVec(d);
    expect(v[2]).toBeLessThan(0); // −z = front
    expect(Math.abs(d.el)).toBeLessThan(0.2);
  });

  it('maps a click to the RIGHT to a positive-x (right) direction', () => {
    const d = screenToDirection(cx + 50, cy + 20, cfg);
    expect(dirToVec(d)[0]).toBeGreaterThan(0);
  });

  it('maps a click well ABOVE the centre to a raised elevation', () => {
    const low = screenToDirection(cx, cy + 30, cfg);
    const high = screenToDirection(cx, cy - 40, cfg);
    expect(high.el).toBeGreaterThan(low.el);
  });
});

describe('makeTargetedDirection', () => {
  const DEG = Math.PI / 180;
  // Lateral coordinate of a direction (interaural axis): |x| = |sin(az)·cos(el)|.
  const lateralMag = (d: Direction) => Math.abs(dirToVec(d)[0]);
  const SEEDS = Array.from({ length: 60 }, (_, i) => i + 1);

  it('is deterministic for a given (kind, seed)', () => {
    const a = makeTargetedDirection('frontback', 42);
    const b = makeTargetedDirection('frontback', 42);
    expect(a).toEqual(b);
  });

  it("'frontback' stays near the median plane (low lateral, front/back pole)", () => {
    for (const s of SEEDS) {
      const d = makeTargetedDirection('frontback', s);
      // low lateral (cone of confusion): |x| small
      expect(lateralMag(d)).toBeLessThan(0.5);
      // near a front/back pole: |az| within ~25° of 0 or 180°
      const nearFront = Math.abs(d.az) <= 30 * DEG;
      const nearBack = Math.abs(Math.abs(d.az) - Math.PI) <= 30 * DEG;
      expect(nearFront || nearBack).toBe(true);
      // modest elevation
      expect(Math.abs(d.el)).toBeLessThanOrEqual(30 * DEG);
    }
  });

  it("'elevation' is off the horizontal but not at the poles", () => {
    for (const s of SEEDS) {
      const d = makeTargetedDirection('elevation', s);
      expect(Math.abs(d.el)).toBeGreaterThanOrEqual(20 * DEG - 1e-9);
      expect(Math.abs(d.el)).toBeLessThanOrEqual(60 * DEG + 1e-9);
      expect(Math.abs(d.el)).toBeLessThan(Math.PI / 2 - 1e-3); // not the exact pole
    }
  });

  it("'lateral' is lateral and near-horizontal", () => {
    for (const s of SEEDS) {
      const d = makeTargetedDirection('lateral', s);
      expect(lateralMag(d)).toBeGreaterThan(0.5); // strongly to one side
      expect(Math.abs(d.el)).toBeLessThanOrEqual(15 * DEG + 1e-9);
    }
  });

  it("'balanced' spreads across all three zones over many seeds", () => {
    let fb = 0, el = 0, lat = 0;
    for (const s of SEEDS) {
      const d = makeTargetedDirection('balanced', s);
      const lm = lateralMag(d);
      if (Math.abs(d.el) >= 20 * DEG) el++;
      else if (lm < 0.5) fb++;
      else lat++;
    }
    // every zone represented (not all luck one way)
    expect(fb).toBeGreaterThan(0);
    expect(el).toBeGreaterThan(0);
    expect(lat).toBeGreaterThan(0);
  });
});

describe('basin tracking + confirm stopping', () => {
  const CFG: BasinConfig = { minPerBucket: 1, shortlistSize: 3, confirmCap: 8 };

  it('bucket mapping: value → bucket and bucket → centre are consistent', () => {
    const s = makeBasin(0, 10, 5); // buckets of width 2
    expect(basinBucketFor(s, 0)).toBe(0);
    expect(basinBucketFor(s, 9.9)).toBe(4);
    expect(basinBucketValue(s, 0)).toBeCloseTo(1, 6);   // centre of [0,2]
    expect(basinBucketValue(s, 4)).toBeCloseTo(9, 6);   // centre of [8,10]
  });

  it('discrete basin: one bucket per integer, centres are the integers', () => {
    const s = makeBasin(0, 4, 4);
    expect(basinBucketFor(s, 2, true)).toBe(2);
    expect(basinBucketValue(s, 3, true)).toBe(3);
  });

  it('explore visits every bucket before confirming', () => {
    const s = makeBasin(0, 6, 6);
    const seen = new Set<number>();
    for (let i = 0; i < 6; i++) {
      const step = basinNext(s, CFG);
      expect(step.phase).toBe('explore');
      seen.add(step.bucket);
      basinRecord(s, step.value, 0.3); // neutral error
    }
    expect(seen.size).toBe(6); // all buckets explored
  });

  it('a lucky single low-error probe does NOT override a better-HOLDING basin', () => {
    // bucket 0 holds low error across several probes; bucket 3 got one lucky 0 then bad.
    const s = makeBasin(0, 6, 6);
    // explore: give bucket 0 consistently low, bucket 3 one lucky zero, others mediocre.
    for (let i = 0; i < 6; i++) {
      const step = basinNext(s, CFG);
      const b = step.bucket;
      const err = b === 0 ? 0.10 : b === 3 ? 0.0 : 0.5;
      basinRecord(s, step.value, err);
    }
    // confirm rounds: bucket 3 now points BADLY (its single 0 was luck); bucket 0 holds.
    let step = basinNext(s, CFG);
    let guard = 0;
    while (!step.done && guard++ < 40) {
      const b = step.bucket;
      const err = b === 0 ? 0.10 : b === 3 ? 0.6 : 0.5; // bucket 3 regresses
      basinRecord(s, step.value, err);
      step = basinNext(s, CFG);
    }
    expect(step.done).toBe(true);
    // The consistently-low bucket 0 wins, not the lucky-once bucket 3.
    expect(step.bucket).toBe(0);
    expect(basinMean(s, 0)).toBeLessThan(basinMean(s, 3));
  });

  it('a bad-spot probe (high error) never becomes the chosen basin', () => {
    const s = makeBasin(0, 4, 4);
    for (let i = 0; i < 12; i++) {
      const step = basinNext(s, CFG);
      if (step.done) break;
      // bucket 1 is the good spot; bucket 2 is a bad spot (in-head, π/2).
      const err = step.bucket === 1 ? 0.08 : step.bucket === 2 ? Math.PI / 2 : 0.4;
      basinRecord(s, step.value, err);
    }
    let step = basinNext(s, CFG);
    let guard = 0;
    while (!step.done && guard++ < 40) {
      const err = step.bucket === 1 ? 0.08 : step.bucket === 2 ? Math.PI / 2 : 0.4;
      basinRecord(s, step.value, err);
      step = basinNext(s, CFG);
    }
    expect(step.bucket).toBe(1);
    expect(step.bucket).not.toBe(2);
  });

  it('commits the winning basin CENTRE value on done', () => {
    const s = makeBasin(-18, 18, 6); // e.g. frontBackTilt range
    let step = basinNext(s, CFG);
    let guard = 0;
    while (!step.done && guard++ < 60) {
      // bucket 4 (upper-mid) localizes best.
      const err = step.bucket === 4 ? 0.05 : 0.5;
      basinRecord(s, step.value, err);
      step = basinNext(s, CFG);
    }
    expect(step.done).toBe(true);
    expect(step.value).toBeCloseTo(basinBucketValue(s, step.bucket), 6);
    expect(step.bucket).toBe(4);
  });

  it('caps confirm rounds so an ambiguous basin still terminates', () => {
    const s = makeBasin(0, 6, 6);
    let steps = 0, step = basinNext(s, CFG);
    while (!step.done && steps++ < 200) {
      basinRecord(s, step.value, 0.3); // ALL buckets identical → never separates
      step = basinNext(s, CFG);
    }
    expect(step.done).toBe(true);            // terminated despite no separation
    expect(steps).toBeLessThan(6 + CFG.confirmCap + 5); // bounded: explore + confirm cap
  });

  it('remaining fraction shrinks monotonically: ~1 exploring → 0 done', () => {
    const s = makeBasin(0, 6, 6);
    const fracs: number[] = [];
    let step = basinNext(s, CFG), guard = 0;
    fracs.push(basinRemainingFraction(s, CFG));
    while (!step.done && guard++ < 60) {
      const err = step.bucket === 2 ? 0.05 : 0.5;
      basinRecord(s, step.value, err);
      fracs.push(basinRemainingFraction(s, CFG));
      step = basinNext(s, CFG);
    }
    expect(fracs[0]).toBeGreaterThan(0.8);   // starts wide
    expect(basinRemainingFraction(s, CFG)).toBe(0); // done → 0
    // non-increasing
    for (let i = 1; i < fracs.length; i++) expect(fracs[i]).toBeLessThanOrEqual(fracs[i - 1] + 1e-9);
  });

  it('basin state is JSON round-trippable (for resume persistence)', () => {
    const s = makeBasin(0, 6, 6);
    basinRecord(s, 1, 0.2); basinRecord(s, 5, 0.4);
    const clone = JSON.parse(JSON.stringify(s));
    expect(clone).toEqual(s);
    // continues identically from the reloaded state
    expect(basinNext(clone, CFG)).toEqual(basinNext(s, CFG));
  });
});

describe('seededShuffle', () => {
  it('is a permutation of [0..n)', () => {
    const p = seededShuffle(8, 42);
    expect([...p].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
  it('is deterministic for a seed, and varies by seed', () => {
    expect(seededShuffle(10, 5)).toEqual(seededShuffle(10, 5));
    expect(seededShuffle(10, 5)).not.toEqual(seededShuffle(10, 6));
  });
});

describe('rrNext — interleaved round-robin scheduler', () => {
  // Simulate the whole loop: N factors, each "converges" after `need[i]` probes.
  function runLoop(nFactors: number, need: number[], cap = 500) {
    const converged = new Array(nFactors).fill(false);
    const seen = new Array(nFactors).fill(0);
    let rr: RoundRobin = { order: makePassOrder(0, nFactors), cursor: 0, pass: 0 };
    const sequence: number[] = [];
    let guard = 0;
    while (!converged.every(Boolean) && guard++ < cap) {
      const r = rrNext(rr, converged);
      rr = r.rr;
      if (r.index < 0) break;
      seen[r.index]++;
      sequence.push(r.index);
      if (seen[r.index] >= need[r.index]) converged[r.index] = true;
    }
    return { sequence, seen, converged, passes: rr.pass };
  }

  it('every factor eventually converges (all get probed enough)', () => {
    const need = [2, 3, 2, 4, 2];
    const { converged, seen } = runLoop(5, need);
    expect(converged.every(Boolean)).toBe(true);
    for (let i = 0; i < 5; i++) expect(seen[i]).toBeGreaterThanOrEqual(need[i]);
  });

  it('interleaves: consecutive probes are DIFFERENT factors (no back-to-back same factor)', () => {
    const { sequence } = runLoop(5, [3, 3, 3, 3, 3]);
    let backToBack = 0;
    for (let i = 1; i < sequence.length; i++) if (sequence[i] === sequence[i - 1]) backToBack++;
    // With ≥2 live factors the scheduler always advances to a different one; only the very
    // tail (one factor left) can repeat. Assert essentially no back-to-back.
    expect(backToBack).toBeLessThanOrEqual(2);
  });

  it("sparses the 'head' factor (index 0) among the rest — not front-loaded as a block", () => {
    // factor 0 = base head, needs several probes; it must be spread out, not a leading run.
    const { sequence } = runLoop(5, [4, 2, 2, 2, 2]);
    // The head's probes must NOT all cluster at the front: by the time the head has been
    // probed 3×, several OTHER factors have had a turn too (interleaved, not a block).
    let headSoFar = 0, othersByThirdHead = 0;
    for (const f of sequence) {
      if (f === 0) { headSoFar++; if (headSoFar >= 3) break; }
      else othersByThirdHead++;
    }
    expect(othersByThirdHead).toBeGreaterThanOrEqual(3);
    // And while ≥2 factors are still live, the head never repeats back-to-back.
    const firstHalf = sequence.slice(0, Math.floor(sequence.length / 2));
    for (let i = 1; i < firstHalf.length; i++) {
      if (firstHalf[i] === 0) expect(firstHalf[i - 1]).not.toBe(0);
    }
  });

  it('is deterministic under the seed (same schedule every run)', () => {
    const a = runLoop(6, [2, 3, 2, 3, 2, 3]);
    const b = runLoop(6, [2, 3, 2, 3, 2, 3]);
    expect(a.sequence).toEqual(b.sequence);
  });

  it('reshuffles the visiting order each pass (varied, still deterministic)', () => {
    expect(makePassOrder(0, 7)).not.toEqual(makePassOrder(1, 7));
    expect(makePassOrder(1, 7)).toEqual(makePassOrder(1, 7));
  });

  it('returns -1 when all factors are converged', () => {
    const rr: RoundRobin = { order: makePassOrder(0, 3), cursor: 0, pass: 0 };
    expect(rrNext(rr, [true, true, true]).index).toBe(-1);
  });

  it('RoundRobin state is JSON round-trippable (resume continues identically)', () => {
    let rr: RoundRobin = { order: makePassOrder(0, 5), cursor: 0, pass: 0 };
    const converged = [false, false, false, false, false];
    // take a few steps
    for (let i = 0; i < 3; i++) rr = rrNext(rr, converged).rr;
    const clone = JSON.parse(JSON.stringify(rr));
    expect(clone).toEqual(rr);
    expect(rrNext(clone, converged)).toEqual(rrNext(rr, converged));
  });
});
