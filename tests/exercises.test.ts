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
  AB_TYPES,
  ALL_TYPES,
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
          expect(s.roomSize).toBeTruthy();
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
