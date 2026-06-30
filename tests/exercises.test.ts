/**
 * The trainer exercise generator is the correctness heart: a buggy generator
 * would teach the wrong answer. These tests assert, across many seeds:
 *  - FAIRNESS: the two A/B scenes differ ONLY in the dimension being tested.
 *  - CORRECTNESS: the labeled correctAnswer actually matches the geometry/material.
 *  - DIRECTION: bearing -> direction mapping at the quadrant boundaries.
 *  - DETERMINISM: same seed -> same question.
 *  - VALIDITY: scenes are well-formed for ScenePlayer.
 */
import { describe, it, expect } from 'vitest';
import {
  makeQuestion,
  makeRandomQuestion,
  bearingToDirection,
  hasRoomB,
  AB_TYPES,
  ALL_TYPES,
  SINGLE_TYPES,
  MATERIAL_LADDER,
  type Question,
} from '../src/trainer/exercises';
import type { Scene } from '../src/debug/scenes';

const SEEDS = Array.from({ length: 60 }, (_, i) => i * 1234567 + 7);

const dims = (s: Scene) => s.roomSize!;
const matStr = (s: Scene) => JSON.stringify(s.materials);
const volume = (s: Scene) => { const [x, y, z] = dims(s); return x * y * z; };
const correctScene = (q: Question) => (q.correctAnswer === 'Room A' ? q.sceneA : q.sceneB!);
const otherScene = (q: Question) => (q.correctAnswer === 'Room A' ? q.sceneB! : q.sceneA);

const approx = (a: number, b: number) => Math.abs(a - b) < 1e-6;

describe('A/B exercise validity', () => {
  for (const type of AB_TYPES) {
    it(`${type}: scenes are valid for ScenePlayer`, () => {
      for (const seed of SEEDS) {
        const q = makeQuestion(type, seed);
        for (const s of [q.sceneA, q.sceneB!]) {
          // A scene is playable if it has reflecting geometry — either a room box
          // or free-standing walls (the open reflector exercise) — plus a clap.
          expect(s.roomSize || (s.extraWalls && s.extraWalls.length > 0)).toBeTruthy();
          expect(s.listener).toHaveLength(3);
          expect(s.sources.some((x) => x.kind === 'clap')).toBe(true);
        }
        expect(q.choices).toContain(q.correctAnswer);
      }
    });
  }
});

describe('larger: fairness + correctness', () => {
  it('correct room has strictly larger volume; shape similar', () => {
    for (const seed of SEEDS) {
      const q = makeQuestion('larger', seed);
      expect(matStr(q.sceneA)).toBe(matStr(q.sceneB!)); // same materials
      expect(volume(correctScene(q))).toBeGreaterThan(volume(otherScene(q)));
    }
  });
});

describe('wider: fairness (only x differs) + correctness', () => {
  it('only x-extent differs; correct room is wider', () => {
    for (const seed of SEEDS) {
      const q = makeQuestion('wider', seed);
      const a = dims(q.sceneA), b = dims(q.sceneB!);
      expect(approx(a[1], b[1])).toBe(true); // same height
      expect(approx(a[2], b[2])).toBe(true); // same depth
      expect(approx(a[0], b[0])).toBe(false); // width differs
      expect(matStr(q.sceneA)).toBe(matStr(q.sceneB!));
      expect(dims(correctScene(q))[0]).toBeGreaterThan(dims(otherScene(q))[0]);
    }
  });
});

describe('longer: fairness (only z differs) + correctness', () => {
  it('only z-extent differs; correct room is longer', () => {
    for (const seed of SEEDS) {
      const q = makeQuestion('longer', seed);
      const a = dims(q.sceneA), b = dims(q.sceneB!);
      expect(approx(a[0], b[0])).toBe(true); // same width
      expect(approx(a[1], b[1])).toBe(true); // same height
      expect(approx(a[2], b[2])).toBe(false); // depth differs
      expect(matStr(q.sceneA)).toBe(matStr(q.sceneB!));
      expect(dims(correctScene(q))[2]).toBeGreaterThan(dims(otherScene(q))[2]);
    }
  });
});

describe('carpet: fairness (only material differs) + correctness', () => {
  it('identical geometry; correct room is carpeted', () => {
    for (const seed of SEEDS) {
      const q = makeQuestion('carpet', seed);
      const a = dims(q.sceneA), b = dims(q.sceneB!);
      expect(a).toEqual(b); // same geometry
      const win = correctScene(q);
      const lose = otherScene(q);
      expect(Object.values(win.materials!)).toContain('carpet');
      expect(Object.values(lose.materials!)).not.toContain('carpet');
    }
  });
});

describe('brick: fairness (only material differs) + correctness', () => {
  it('identical geometry; correct room is brick, other concrete', () => {
    for (const seed of SEEDS) {
      const q = makeQuestion('brick', seed);
      expect(dims(q.sceneA)).toEqual(dims(q.sceneB!));
      expect(Object.values(correctScene(q).materials!)).toContain('brick');
      expect(Object.values(otherScene(q).materials!)).toContain('concrete');
      expect(Object.values(otherScene(q).materials!)).not.toContain('brick');
    }
  });
});

describe('material: fairness (only material differs) + correct target + difficulty ladder', () => {
  it('identical geometry; correct room has the ladder TARGET material, foil has the foil', () => {
    for (const seed of SEEDS) {
      for (const difficulty of [0, 0.5, 1]) {
        const q = makeQuestion('material', seed, { difficulty });
        expect(dims(q.sceneA)).toEqual(dims(q.sceneB!)); // same geometry
        const idx = Math.min(
          MATERIAL_LADDER.length - 1,
          Math.floor(Math.max(0, Math.min(1, difficulty)) * MATERIAL_LADDER.length),
        );
        const pair = MATERIAL_LADDER[idx];
        expect(Object.values(correctScene(q).materials!)).toContain(pair.target);
        expect(Object.values(otherScene(q).materials!)).toContain(pair.foil);
      }
    }
  });

  it('easy difficulty uses a far-apart pair; hard uses a same-cluster pair', () => {
    const easy = makeQuestion('material', 42, { difficulty: 0 });
    const hard = makeQuestion('material', 42, { difficulty: 1 });
    // Easy rung pairs marble (bright) with drapes (soft/dead) — opposite corners.
    const easyMats = new Set(Object.values(easy.sceneA.materials!).concat(Object.values(easy.sceneB!.materials!)));
    expect(easyMats.has('marble')).toBe(true);
    expect(easyMats.has('drapes_heavy')).toBe(true);
    // Hard rung pairs two broadband dead absorbers — same cluster.
    const hardMats = new Set(Object.values(hard.sceneA.materials!).concat(Object.values(hard.sceneB!.materials!)));
    expect(hardMats.has('panel_fabric_rockwool')).toBe(true);
    expect(hardMats.has('acoustic_foam')).toBe(true);
  });
});

describe('metal: fairness (only material differs) + correctness', () => {
  it('identical geometry; correct room is the perforated metal absorber, other is carpet', () => {
    for (const seed of SEEDS) {
      const q = makeQuestion('metal', seed);
      expect(dims(q.sceneA)).toEqual(dims(q.sceneB!));
      expect(Object.values(correctScene(q).materials!)).toContain('perforated_metal_absorber');
      expect(Object.values(otherScene(q).materials!)).toContain('carpet');
      expect(Object.values(otherScene(q).materials!)).not.toContain('perforated_metal_absorber');
    }
  });
});

describe('direction: bearing -> answer mapping', () => {
  it('quadrant boundaries', () => {
    expect(bearingToDirection(0)).toBe('forward');
    expect(bearingToDirection(44)).toBe('forward');
    expect(bearingToDirection(46)).toBe('right');
    expect(bearingToDirection(90)).toBe('right');
    expect(bearingToDirection(134)).toBe('right');
    expect(bearingToDirection(136)).toBe('behind');
    expect(bearingToDirection(180)).toBe('behind');
    expect(bearingToDirection(226)).toBe('left');
    expect(bearingToDirection(270)).toBe('left');
    expect(bearingToDirection(316)).toBe('forward');
    expect(bearingToDirection(-90)).toBe('left');
    expect(bearingToDirection(360)).toBe('forward');
  });

  it('labeled answer matches the source bearing across seeds', () => {
    for (const seed of SEEDS) {
      const q = makeQuestion('direction', seed);
      expect(q.bearingDeg).toBeDefined();
      const expected = bearingToDirection(q.bearingDeg!);
      const label = { forward: 'Forward', behind: 'Behind', left: 'Left', right: 'Right' }[expected];
      expect(q.correctAnswer).toBe(label);
      // The source's actual world position must lie in the answered direction,
      // checked against the ENGINE convention: front is -z, right is +x
      // (docs/TECHNICAL.md, sofa.ts az=0 -> -z). So forward = -dz.
      const src = q.sceneA.sources[0].pos;
      const L = q.sceneA.listener;
      const dx = src[0] - L[0]; // +x = right
      const fwd = -(src[2] - L[2]); // -z = forward (engine front)
      const recovered = bearingToDirection((Math.atan2(dx, fwd) * 180) / Math.PI);
      expect(recovered).toBe(expected);
    }
  });

  it('source stays in the answered quadrant even at max difficulty', () => {
    // Hard difficulty widens the jitter; the source must still sit in the correct
    // 90° quadrant or the drill would mark a near-boundary case wrong.
    for (const seed of SEEDS) {
      const q = makeQuestion('direction', seed, { difficulty: 1 });
      const src = q.sceneA.sources[0].pos;
      const L = q.sceneA.listener;
      const dx = src[0] - L[0];
      const fwd = -(src[2] - L[2]);
      const recovered = bearingToDirection((Math.atan2(dx, fwd) * 180) / Math.PI);
      const label = { forward: 'Forward', behind: 'Behind', left: 'Left', right: 'Right' }[recovered];
      expect(q.correctAnswer).toBe(label);
    }
  });
});

describe('reflector: panel side is correct + fair mirror', () => {
  // Centroid of the panel (a thin box = several faces), and its side relative to
  // the listener using the ENGINE convention (right = +x, so left = -x).
  const panelCenter = (s: Scene): { x: number; z: number } => {
    let x = 0, z = 0, n = 0;
    for (const w of s.extraWalls!) for (const v of w.verts) { x += v[0]; z += v[2]; n++; }
    return { x: x / n, z: z / n };
  };

  it('the "panel on LEFT" scene really has its panel to the left (-x), and the other to the right', () => {
    for (const seed of SEEDS) {
      const q = makeQuestion('reflector', seed);
      const leftScene = q.correctAnswer === 'Room A' ? q.sceneA : q.sceneB!;
      const rightScene = q.correctAnswer === 'Room A' ? q.sceneB! : q.sceneA;
      const lc = panelCenter(leftScene), rc = panelCenter(rightScene);
      const lx = leftScene.listener[0];
      // Engine right = +x, so the LEFT panel is at x < listener.x, RIGHT at x > listener.x.
      expect(lc.x).toBeLessThan(lx);
      expect(rc.x).toBeGreaterThan(lx);
      // Both panels are in FRONT (-z of the listener) so it's a front-left vs front-right call.
      expect(lc.z).toBeLessThan(leftScene.listener[2]);
      expect(rc.z).toBeLessThan(rightScene.listener[2]);
    }
  });

  it('fair mirror: both panels at the same distance and mirrored across the forward axis', () => {
    for (const seed of SEEDS) {
      const q = makeQuestion('reflector', seed);
      const a = panelCenter(q.sceneA), b = panelCenter(q.sceneB!);
      const L = q.sceneA.listener;
      const dA = Math.hypot(a.x - L[0], a.z - L[2]);
      const dB = Math.hypot(b.x - L[0], b.z - L[2]);
      expect(dA).toBeCloseTo(dB, 6); // same distance
      // Mirrored across the forward (z) axis: x offsets opposite, z equal.
      expect(a.x - L[0]).toBeCloseTo(-(b.x - L[0]), 6);
      expect(a.z).toBeCloseTo(b.z, 6);
      // Same material on both panels (fairness — only side differs).
      expect(q.sceneA.extraWalls![0].absorption).toEqual(q.sceneB!.extraWalls![0].absorption);
    }
  });

  it('both scenes share the same room (no size/loudness cue) — only the panel side differs', () => {
    for (const seed of SEEDS) {
      const q = makeQuestion('reflector', seed);
      // Same enclosing room in A and B (a large absorbent box), so room size/
      // loudness can't distinguish them — only the panel's side does.
      expect(q.sceneA.roomSize).toEqual(q.sceneB!.roomSize);
      expect(q.sceneA.materials).toEqual(q.sceneB!.materials);
      // The room is highly absorbent (foam) so its own echo is faint, not a cue.
      expect(q.sceneA.materials!['-x']).toBe('acoustic_foam');
    }
  });
});

describe('distance: fairness (only wall distance differs) + correctness', () => {
  const panelCenter = (s: Scene): { x: number; z: number } => {
    let x = 0, z = 0, n = 0;
    for (const w of s.extraWalls!) for (const v of w.verts) { x += v[0]; z += v[2]; n++; }
    return { x: x / n, z: z / n };
  };

  it('identical room/material/size; only the wall distance differs; closer wall is the answer', () => {
    for (const seed of SEEDS) {
      const q = makeQuestion('distance', seed);
      // Same enclosing room + materials → no size/loudness room cue.
      expect(q.sceneA.roomSize).toEqual(q.sceneB!.roomSize);
      expect(q.sceneA.materials).toEqual(q.sceneB!.materials);
      // Same panel material and same panel size in both.
      expect(q.sceneA.extraWalls![0].absorption).toEqual(q.sceneB!.extraWalls![0].absorption);
      const a = panelCenter(q.sceneA), b = panelCenter(q.sceneB!);
      const L = q.sceneA.listener;
      const dA = Math.hypot(a.x - L[0], a.z - L[2]);
      const dB = Math.hypot(b.x - L[0], b.z - L[2]);
      expect(approx(dA, dB)).toBe(false); // distances differ
      // Both straight ahead: engine front is -z, so panel is at -z of listener,
      // and laterally centred (same x as listener).
      expect(approx(a.x, L[0])).toBe(true);
      expect(approx(b.x, L[0])).toBe(true);
      expect(a.z).toBeLessThan(L[2]);
      expect(b.z).toBeLessThan(L[2]);
      // The labeled "closer" room genuinely has the nearer wall.
      const closeScene = q.correctAnswer === 'Room A' ? q.sceneA : q.sceneB!;
      const farScene = q.correctAnswer === 'Room A' ? q.sceneB! : q.sceneA;
      const cc = panelCenter(closeScene), fc = panelCenter(farScene);
      const dClose = Math.hypot(cc.x - L[0], cc.z - L[2]);
      const dFar = Math.hypot(fc.x - L[0], fc.z - L[2]);
      expect(dClose).toBeLessThan(dFar);
    }
  });

  it('harder = smaller distance ratio', () => {
    const ratioOf = (q: Question) => {
      const pc = (s: Scene) => { let z = 0, n = 0; for (const w of s.extraWalls!) for (const v of w.verts) { z += v[2]; n++; } return z / n; };
      const L = q.sceneA.listener[2];
      const dA = Math.abs(pc(q.sceneA) - L), dB = Math.abs(pc(q.sceneB!) - L);
      return Math.max(dA, dB) / Math.min(dA, dB);
    };
    const easy = makeQuestion('distance', 42, { difficulty: 0 });
    const hard = makeQuestion('distance', 42, { difficulty: 1 });
    expect(ratioOf(hard)).toBeLessThan(ratioOf(easy));
  });
});

describe('gap: single-scene mirror; gap is opposite the wall side', () => {
  const panelCenter = (s: Scene): { x: number; z: number } => {
    let x = 0, z = 0, n = 0;
    for (const w of s.extraWalls!) for (const v of w.verts) { x += v[0]; z += v[2]; n++; }
    return { x: x / n, z: z / n };
  };

  it('the labeled gap side is OPPOSITE the reflecting wall, which is in front', () => {
    for (const seed of SEEDS) {
      const q = makeQuestion('gap', seed);
      expect(q.sceneB).toBeUndefined(); // single-scene
      expect(q.choices).toEqual(['Left', 'Right']);
      const pc = panelCenter(q.sceneA);
      const L = q.sceneA.listener;
      // Engine right = +x. Gap on LEFT → wall on the RIGHT (x > listener.x).
      if (q.correctAnswer === 'Left') expect(pc.x).toBeGreaterThan(L[0]);
      else expect(pc.x).toBeLessThan(L[0]);
      // The wall is in FRONT (-z of the listener).
      expect(pc.z).toBeLessThan(L[2]);
    }
  });

  it('left and right gaps are fair mirrors (same |x offset|, distance, material)', () => {
    // Compare two seeds that produce opposite gap sides by scanning.
    let left: Question | null = null, right: Question | null = null;
    for (const seed of SEEDS) {
      const q = makeQuestion('gap', seed);
      if (q.correctAnswer === 'Left' && !left) left = q;
      if (q.correctAnswer === 'Right' && !right) right = q;
    }
    expect(left).not.toBeNull();
    expect(right).not.toBeNull();
    const lc = panelCenter(left!.sceneA), rc = panelCenter(right!.sceneA);
    const L = left!.sceneA.listener;
    // Same material on the wall.
    expect(left!.sceneA.extraWalls![0].absorption).toEqual(right!.sceneA.extraWalls![0].absorption);
    // Both at the same forward distance from the (identical) listener.
    expect(Math.hypot(lc.x - L[0], lc.z - L[2])).toBeCloseTo(Math.hypot(rc.x - L[0], rc.z - L[2]), 6);
  });
});

describe('hasRoomB (Room B visibility predicate)', () => {
  it('is true for every A/B exercise (both scenes set)', () => {
    for (const type of AB_TYPES) {
      for (const seed of SEEDS.slice(0, 8)) {
        const q = makeQuestion(type, seed);
        expect(q.sceneB).toBeDefined();
        expect(hasRoomB(q)).toBe(true);
      }
    }
  });

  it('is false for every single-scene exercise (no sceneB → no dead Room B button)', () => {
    for (const type of SINGLE_TYPES) {
      for (const seed of SEEDS.slice(0, 8)) {
        const q = makeQuestion(type, seed);
        expect(q.sceneB).toBeUndefined();
        expect(hasRoomB(q)).toBe(false);
      }
    }
  });

  it('agrees with the type partition: every question is exactly one of A/B or single', () => {
    for (const type of ALL_TYPES) {
      const q = makeQuestion(type, 12345);
      expect(hasRoomB(q)).toBe(AB_TYPES.includes(type));
      expect(hasRoomB(q)).toBe(!SINGLE_TYPES.includes(type));
    }
  });
});

describe('determinism', () => {
  it('same seed -> identical question for every type', () => {
    for (const type of ALL_TYPES) {
      for (const seed of SEEDS.slice(0, 10)) {
        expect(JSON.stringify(makeQuestion(type, seed))).toBe(
          JSON.stringify(makeQuestion(type, seed)),
        );
      }
    }
  });

  it('makeRandomQuestion is deterministic in seed', () => {
    for (const seed of SEEDS.slice(0, 10)) {
      expect(JSON.stringify(makeRandomQuestion(seed))).toBe(
        JSON.stringify(makeRandomQuestion(seed)),
      );
    }
  });
});

describe('difficulty', () => {
  it('harder = smaller contrast for wider', () => {
    const easy = makeQuestion('wider', 42, { difficulty: 0 });
    const hard = makeQuestion('wider', 42, { difficulty: 1 });
    const ratio = (q: Question) => {
      const w = [dims(q.sceneA)[0], dims(q.sceneB!)[0]].sort((a, b) => b - a);
      return w[0] / w[1];
    };
    expect(ratio(hard)).toBeLessThan(ratio(easy));
  });
});
