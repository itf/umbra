/**
 * Pure, deterministic exercise generator for the Echolocation Trainer.
 *
 * Given a difficulty and a seed, `makeQuestion` returns a fully-specified
 * Question: the exercise type, the scene(s) to play through ScenePlayer, the
 * spoken prompt, the answer choices, and the correct answer.
 *
 * FAIRNESS is a guaranteed property: for every A/B exercise the two scenes
 * differ ONLY in the dimension being tested. For "wider" the rooms have the
 * same depth, height and materials and differ only in x-extent; for "carpet"
 * they have identical geometry and differ only in wall material; etc. This is
 * asserted by the tests — a generator that leaked a second cue would teach the
 * wrong listening skill.
 *
 * No module-scope randomness: callers pass a seed so questions are reproducible
 * and testable without Web Audio.
 */
import type { Scene, SceneSource } from '../debug/scenes';
import type { ShoeboxMaterialMap } from '../engine/acoustics/materials';

// --- Deterministic RNG (mulberry32) -----------------------------------------

/** A seeded RNG returning floats in [0,1). */
export type Rng = () => number;

export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Public types ------------------------------------------------------------

export type ExerciseType = 'larger' | 'wider' | 'longer' | 'carpet' | 'brick' | 'direction';

export const AB_TYPES: ExerciseType[] = ['larger', 'wider', 'longer', 'carpet', 'brick'];
export const ALL_TYPES: ExerciseType[] = [...AB_TYPES, 'direction'];

export type Direction = 'forward' | 'behind' | 'left' | 'right';

export interface Question {
  type: ExerciseType;
  /** Stable id derived from type + seed (handy for tests / UI keys). */
  id: string;
  prompt: string;
  /** Answer choices, in display order. */
  choices: string[];
  /** The choice (one of `choices`) that is correct. */
  correctAnswer: string;
  /** A/B exercises set both scenes; direction sets only sceneA. */
  sceneA: Scene;
  sceneB?: Scene;
  /** Direction-only: the source bearing in degrees, 0 = forward, +90 = right. */
  bearingDeg?: number;
}

export interface GenOptions {
  /** 0 = easiest (big contrast) .. 1 = hardest (subtle contrast). */
  difficulty?: number;
}

// --- Difficulty helpers ------------------------------------------------------

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** Linearly interpolate between an easy and a hard contrast factor. */
function contrast(difficulty: number, easy: number, hard: number): number {
  const d = clamp01(difficulty);
  return easy + (hard - easy) * d;
}

const HARD_MATS: ShoeboxMaterialMap = {
  '-x': 'concrete', '+x': 'concrete', '-z': 'concrete', '+z': 'concrete', '+y': 'concrete', '-y': 'concrete',
};

function allMat(mat: keyof typeof import('../engine/acoustics/materials').MATERIALS): ShoeboxMaterialMap {
  return { '-x': mat, '+x': mat, '-z': mat, '+z': mat, '+y': mat, '-y': mat };
}

/** A centred clap source + listener for a box of the given size. */
function clapScene(
  id: string,
  title: string,
  size: [number, number, number],
  materials: ShoeboxMaterialMap,
): Scene {
  const [sx, sy, sz] = size;
  const center: [number, number, number] = [sx / 2, Math.min(1.6, sy / 2), sz / 2];
  const sources: SceneSource[] = [{ pos: center, kind: 'clap', label: 'clap' }];
  return {
    id,
    title,
    description: title,
    listener: center,
    roomSize: size,
    materials,
    sources,
    maxOrder: 2,
  };
}

// --- A/B generators ----------------------------------------------------------

/** Base room dimensions, jittered a touch per-seed so questions vary. */
function baseDims(rng: Rng): { x: number; y: number; z: number } {
  return {
    x: 5 + rng() * 4, // 5..9
    y: 3 + rng() * 2, // 3..5
    z: 5 + rng() * 4, // 5..9
  };
}

function genLarger(rng: Rng, difficulty: number): Question {
  const b = baseDims(rng);
  // Scale ALL dimensions by a factor so only total VOLUME differs in a way that
  // is geometrically similar (shape identical). factor in (1, ~2].
  const factor = contrast(difficulty, 1.8, 1.15);
  const big = factor;
  const aIsBig = rng() < 0.5;
  const sA: [number, number, number] = aIsBig ? [b.x * big, b.y * big, b.z * big] : [b.x, b.y, b.z];
  const sB: [number, number, number] = aIsBig ? [b.x, b.y, b.z] : [b.x * big, b.y * big, b.z * big];
  const sceneA = clapScene('larger-a', 'Room A', sA, HARD_MATS);
  const sceneB = clapScene('larger-b', 'Room B', sB, HARD_MATS);
  return {
    type: 'larger',
    id: '',
    prompt: 'Which room is LARGER?',
    choices: ['Room A', 'Room B'],
    correctAnswer: aIsBig ? 'Room A' : 'Room B',
    sceneA,
    sceneB,
  };
}

/** Differ ONLY in x-extent (width); depth, height, materials identical. */
function genWider(rng: Rng, difficulty: number): Question {
  const b = baseDims(rng);
  const factor = contrast(difficulty, 1.8, 1.2);
  const aWide = rng() < 0.5;
  const wx = b.x * factor;
  const sA: [number, number, number] = aWide ? [wx, b.y, b.z] : [b.x, b.y, b.z];
  const sB: [number, number, number] = aWide ? [b.x, b.y, b.z] : [wx, b.y, b.z];
  return {
    type: 'wider',
    id: '',
    prompt: 'Which room is WIDER (side to side)?',
    choices: ['Room A', 'Room B'],
    correctAnswer: aWide ? 'Room A' : 'Room B',
    sceneA: clapScene('wider-a', 'Room A', sA, HARD_MATS),
    sceneB: clapScene('wider-b', 'Room B', sB, HARD_MATS),
  };
}

/** Differ ONLY in z-extent (depth/length); width, height, materials identical. */
function genLonger(rng: Rng, difficulty: number): Question {
  const b = baseDims(rng);
  const factor = contrast(difficulty, 1.8, 1.2);
  const aLong = rng() < 0.5;
  const lz = b.z * factor;
  const sA: [number, number, number] = aLong ? [b.x, b.y, lz] : [b.x, b.y, b.z];
  const sB: [number, number, number] = aLong ? [b.x, b.y, b.z] : [b.x, b.y, lz];
  return {
    type: 'longer',
    id: '',
    prompt: 'Which room is LONGER (front to back)?',
    choices: ['Room A', 'Room B'],
    correctAnswer: aLong ? 'Room A' : 'Room B',
    sceneA: clapScene('longer-a', 'Room A', sA, HARD_MATS),
    sceneB: clapScene('longer-b', 'Room B', sB, HARD_MATS),
  };
}

/** Identical geometry; one room carpeted, the other hard (concrete). */
function genCarpet(rng: Rng, _difficulty: number): Question {
  const b = baseDims(rng);
  const size: [number, number, number] = [b.x, b.y, b.z];
  const aCarpet = rng() < 0.5;
  const matA = aCarpet ? allMat('carpet') : HARD_MATS;
  const matB = aCarpet ? HARD_MATS : allMat('carpet');
  return {
    type: 'carpet',
    id: '',
    prompt: 'Which room has CARPET (soft, dead) walls?',
    choices: ['Room A', 'Room B'],
    correctAnswer: aCarpet ? 'Room A' : 'Room B',
    sceneA: clapScene('carpet-a', 'Room A', size, matA),
    sceneB: clapScene('carpet-b', 'Room B', size, matB),
  };
}

/** Identical geometry; one room brick (scatters), the other concrete (specular). */
function genBrick(rng: Rng, _difficulty: number): Question {
  const b = baseDims(rng);
  const size: [number, number, number] = [b.x, b.y, b.z];
  const aBrick = rng() < 0.5;
  const matA = aBrick ? allMat('brick') : allMat('concrete');
  const matB = aBrick ? allMat('concrete') : allMat('brick');
  return {
    type: 'brick',
    id: '',
    prompt: 'Which room has BRICK walls (rough, scattered echo) vs CONCRETE (sharp)?',
    choices: ['Room A', 'Room B'],
    correctAnswer: aBrick ? 'Room A' : 'Room B',
    sceneA: clapScene('brick-a', 'Room A', size, matA),
    sceneB: clapScene('brick-b', 'Room B', size, matB),
  };
}

// --- Direction generator -----------------------------------------------------

/**
 * Map a bearing (deg, 0 = straight ahead / +z, +90 = right / +x) to one of the
 * four cardinal answers using 90°-wide quadrants centred on each direction.
 */
export function bearingToDirection(bearingDeg: number): Direction {
  const a = ((bearingDeg % 360) + 360) % 360; // [0,360)
  if (a >= 315 || a < 45) return 'forward';
  if (a < 135) return 'right';
  if (a < 225) return 'behind';
  return 'left';
}

const DIRECTION_CHOICES = ['Forward', 'Behind', 'Left', 'Right'];

function genDirection(rng: Rng, difficulty: number): Question {
  const dirs: Direction[] = ['forward', 'behind', 'left', 'right'];
  const chosen = dirs[Math.floor(rng() * dirs.length) % dirs.length];
  const center = { forward: 0, right: 90, behind: 180, left: 270 }[chosen];
  // Jitter within the quadrant; smaller jitter when easy (closer to dead-on),
  // wider when hard (nearer the boundary, harder to call).
  const half = contrast(difficulty, 10, 40); // degrees off centre
  const bearingDeg = center + (rng() * 2 - 1) * half;

  // Place the source 3 m away at that bearing. The listener faces the engine's
  // FRONT, which is -z (see docs/TECHNICAL.md coord convention + sofa.ts: az=0 ->
  // -z front). So bearing 0 (forward) must put the source at -z, 90 (right) at +x.
  const size: [number, number, number] = [8, 3, 8];
  const lx = size[0] / 2, lz = size[2] / 2, ly = 1.6;
  const rad = (bearingDeg * Math.PI) / 180;
  const dist = 3;
  const sx = lx + Math.sin(rad) * dist; // bearing 90° = +x = right
  const sz = lz - Math.cos(rad) * dist; // bearing 0° = -z = forward (engine front)
  const sources: SceneSource[] = [{ pos: [sx, ly, sz], kind: 'tone', freq: 440, label: 'source' }];
  const sceneA: Scene = {
    id: 'direction',
    title: 'Direction',
    description: 'Where is the sound?',
    listener: [lx, ly, lz],
    roomSize: size,
    materials: allMat('carpet'), // dry so direction is clear, not echo
    sources,
    maxOrder: 1,
  };
  const answer = bearingToDirection(bearingDeg);
  const label = { forward: 'Forward', behind: 'Behind', left: 'Left', right: 'Right' }[answer];
  return {
    type: 'direction',
    id: '',
    prompt: 'Which direction is the sound coming from?',
    choices: DIRECTION_CHOICES,
    correctAnswer: label,
    sceneA,
    bearingDeg,
  };
}

// --- Entry point -------------------------------------------------------------

const GENERATORS: Record<ExerciseType, (rng: Rng, difficulty: number) => Question> = {
  larger: genLarger,
  wider: genWider,
  longer: genLonger,
  carpet: genCarpet,
  brick: genBrick,
  direction: genDirection,
};

/**
 * Build a question of the given type, deterministic in `seed`. Same (type, seed,
 * difficulty) always yields the identical question.
 */
export function makeQuestion(type: ExerciseType, seed: number, opts: GenOptions = {}): Question {
  const rng = makeRng(seed);
  const q = GENERATORS[type](rng, opts.difficulty ?? 0);
  q.id = `${type}-${seed >>> 0}`;
  return q;
}

/** Pick a question type deterministically from a seed, then build it. */
export function makeRandomQuestion(seed: number, opts: GenOptions & { types?: ExerciseType[] } = {}): Question {
  const types = opts.types ?? ALL_TYPES;
  const rng = makeRng(seed ^ 0x9e3779b9);
  const type = types[Math.floor(rng() * types.length) % types.length];
  return makeQuestion(type, seed, opts);
}
