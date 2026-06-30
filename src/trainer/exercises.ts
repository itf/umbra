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
import type { WallDef } from '../engine/acoustics/core';
import { MATERIALS } from '../engine/acoustics/materials';

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

export type ExerciseType =
  | 'larger' | 'wider' | 'longer' | 'carpet' | 'brick' | 'direction' | 'reflector'
  | 'distance' | 'gap' | 'material' | 'metal' | 'orientation';

export const AB_TYPES: ExerciseType[] = ['larger', 'wider', 'longer', 'carpet', 'brick', 'reflector', 'distance', 'material', 'metal'];
export const ALL_TYPES: ExerciseType[] = [...AB_TYPES, 'direction', 'gap', 'orientation'];

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
  /** Distance-drill only: the true wall-ahead distance (m) in each room, for the
   *  post-answer reveal. */
  wallDistsM?: { a: number; b: number };
}

export interface GenOptions {
  /** 0 = easiest (big contrast) .. 1 = hardest (subtle contrast). */
  difficulty?: number;
  /**
   * DISTANCE ladder (Thaler): listener-to-nearer-target distance in metres. When
   * set, the `distance` exercise places its NEAR panel this far away (and the far
   * panel proportionally beyond), so backing away with mastery shrinks the cue —
   * the adaptive 33→66→99 cm progression. Ignored by other exercises.
   */
  nearDistanceM?: number;
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

// --- Material identification (maximally-separable set) ------------------------

/**
 * MATERIAL-ID drill. Two identical rooms differ ONLY in wall material; the player
 * picks which room is the named TARGET material. The pairs are drawn from the
 * research's "maximally-separable" starter set (marble, sheet_metal, plywood_thin,
 * carpet, drapes_heavy, perforated_metal_absorber, panel_fabric_rockwool), each
 * occupying a distinct corner of brightness × spectral-tilt × diffuseness space —
 * so the drill teaches genuinely distinguishable cues rather than near-identical
 * "mirror" materials (marble≈tile≈water, foam≈rockwool≈fiberglass).
 *
 * DIFFICULTY ladders easy→hard by how far apart the two materials are:
 *   - easy: target vs a far-apart foil (e.g. marble bright/sharp vs drapes soft/dead)
 *   - hard: target vs a same-cluster near-mirror (e.g. marble vs concrete, or two
 *     dead absorbers) — these share a timbre and demand fine discrimination.
 * Each rung is a fair A/B: identical geometry, only the material differs.
 */
interface MatPair {
  /** The TARGET material the player is asked to find. */
  target: keyof typeof MATERIALS;
  /** The other ("foil") room's material. */
  foil: keyof typeof MATERIALS;
  /** Short label for the target used in the prompt. */
  label: string;
}

/** Pairs ordered easy (far-apart) → hard (same perceptual cluster). */
export const MATERIAL_LADDER: MatPair[] = [
  // EASY: opposite corners — bright/sharp vs soft/dead.
  { target: 'marble', foil: 'drapes_heavy', label: 'MARBLE (bright, sharp echo)' },
  { target: 'panel_fabric_rockwool', foil: 'marble', label: 'a DEAD wall (almost no echo)' },
  // MEDIUM: distinct tilt vs a bright reflector.
  { target: 'carpet', foil: 'sheet_metal', label: 'CARPET (highs killed, dull)' },
  { target: 'plywood_thin', foil: 'marble', label: 'a BASS-EATING panel (hollow, boomy)' },
  // HARD: same perceptual cluster — fine discrimination.
  { target: 'marble', foil: 'concrete', label: 'MARBLE (vs hard concrete)' },
  { target: 'panel_fabric_rockwool', foil: 'acoustic_foam', label: 'ROCKWOOL (vs acoustic foam)' },
];

function genMaterial(rng: Rng, difficulty: number): Question {
  const b = baseDims(rng);
  const size: [number, number, number] = [b.x, b.y, b.z];
  // Walk the ladder by difficulty (0 → easiest pair, 1 → hardest pair).
  const idx = Math.min(MATERIAL_LADDER.length - 1, Math.floor(clamp01(difficulty) * MATERIAL_LADDER.length));
  const pair = MATERIAL_LADDER[idx];
  const aIsTarget = rng() < 0.5;
  const matA = aIsTarget ? allMat(pair.target) : allMat(pair.foil);
  const matB = aIsTarget ? allMat(pair.foil) : allMat(pair.target);
  return {
    type: 'material',
    id: '',
    prompt: `Which room has ${pair.label} walls?`,
    choices: ['Room A', 'Room B'],
    correctAnswer: aIsTarget ? 'Room A' : 'Room B',
    sceneA: clapScene('material-a', 'Room A', size, matA),
    sceneB: clapScene('material-b', 'Room B', size, matB),
  };
}

/**
 * "WHICH WALL IS METAL" drill: perforated_metal_absorber has the rare INVERTED
 * spectral tilt — it swallows low-mids but REFLECTS highs, the opposite of carpet/
 * foam. The foil is carpet (the canonical HF-killing absorber), so the two share
 * "absorptive overall" but differ in which end of the spectrum survives — a
 * genuinely unusual, learnable timbre. Identical geometry; only material differs.
 */
function genMetal(rng: Rng, _difficulty: number): Question {
  const b = baseDims(rng);
  const size: [number, number, number] = [b.x, b.y, b.z];
  const aMetal = rng() < 0.5;
  const matA = aMetal ? allMat('perforated_metal_absorber') : allMat('carpet');
  const matB = aMetal ? allMat('carpet') : allMat('perforated_metal_absorber');
  return {
    type: 'metal',
    id: '',
    prompt: 'Which room has the METAL absorber (keeps the bright highs, kills lows) vs carpet (kills highs)?',
    choices: ['Room A', 'Room B'],
    correctAnswer: aMetal ? 'Room A' : 'Room B',
    sceneA: clapScene('metal-a', 'Room A', size, matA),
    sceneB: clapScene('metal-b', 'Room B', size, matB),
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

// --- Reflector localization --------------------------------------------------

/**
 * Build a small ~1 m square reflecting panel centred at (cx, cz) at ear height,
 * its face perpendicular to the listener→panel direction. A single DOUBLE-SIDED
 * quad — the solver reflects from either face (flagged via `doubleSided`), so the
 * panel echoes regardless of which side the clap is on.
 */
function makePanel(
  listener: [number, number, number],
  cx: number,
  cz: number,
  material: keyof typeof MATERIALS,
  sizeM = 1,
): WallDef[] {
  const h = sizeM / 2;
  const [lx, , lz] = listener;
  let dx = cx - lx, dz = cz - lz;
  const len = Math.hypot(dx, dz) || 1;
  dx /= len; dz /= len;
  const px = -dz, pz = dx; // width axis: perpendicular to listener→panel in xz
  const ey = 1.6;
  const vert = (s: number, y: number): [number, number, number] => [cx + px * s, ey + y, cz + pz * s];
  return [{
    verts: [vert(-h, -h), vert(h, -h), vert(h, h), vert(-h, h)],
    absorption: [...MATERIALS[material]],
    doubleSided: true,
  }];
}

/** Bearing → world panel position at `dist` (engine front = -z, right = +x). */
function bearingToPos(
  listener: [number, number, number],
  bearingDeg: number,
  dist: number,
): [number, number] {
  const [lx, , lz] = listener;
  const rad = (bearingDeg * Math.PI) / 180;
  return [lx + Math.sin(rad) * dist, lz - Math.cos(rad) * dist];
}

/**
 * REFLECTOR LOCALIZATION (the real echolocation skill): an OPEN space with one
 * small panel off to the front-left vs front-right at the same distance. The clap
 * echoes off it; the player says which SIDE the echo is on. No room, so there's no
 * loudness/room-size cue — only the direction (and a faint delay) of the single
 * reflection. The two scenes are MIRRORED (same |bearing|, same distance, same
 * material), so the only difference is left vs right — fair by construction.
 */
function genReflector(rng: Rng, difficulty: number): Question {
  // Bearing off straight-ahead: ~40° (easy, well to the side) → ~20° (hard, subtle).
  const offset = contrast(difficulty, 40, 20);
  // Panel close (2 m) so its early echo is loud and well-separated from the faint,
  // distant room reflections — the side cue is prominent, not buried.
  const dist = 2;
  const listener: [number, number, number] = [4, 1.6, 4];

  const aIsLeft = rng() < 0.5;
  // Left = negative bearing (toward -x... but engine right is +x, so LEFT is -x →
  // bearing -offset). Right = +offset.
  const leftPos = bearingToPos(listener, -offset, dist);
  const rightPos = bearingToPos(listener, +offset, dist);

  // A large, highly-ABSORBENT room encloses the listener. Two reasons: (1) the
  // image-source solver only behaves for a listener INSIDE geometry (a lone panel
  // in open space is degenerate and won't reflect symmetrically); (2) the room is
  // big + very absorbent (foam), so its own reflections are weak and far-off —
  // there's no useful size/loudness cue. The DISCRIMINATOR is a hard concrete panel
  // close to one side, whose crisp early echo stands out by DIRECTION. Both A and B
  // are the same room + same panel distance/material — only the side differs.
  const roomSize: [number, number, number] = [16, 4, 16];
  const center: [number, number, number] = [8, 1.6, 8];
  const faint = allMat('acoustic_foam');

  const scene = (id: string, pos: [number, number]): Scene => ({
    id,
    title: id,
    description: 'Clap and hear which side the panel echoes from.',
    listener: center,
    roomSize,
    materials: faint, // big absorbent room: weak, distant echoes → no size cue
    // The panel is a double-sided concrete slab (both faces reflect — see makePanel
    // / interiorWall). Inside this room the geometry is non-degenerate, so it echoes
    // crisply from its side regardless of left/right.
    extraWalls: makePanel(center, center[0] + (pos[0] - listener[0]), center[2] + (pos[1] - listener[2]), 'concrete'),
    sources: [{ pos: center, kind: 'clap', label: 'clap' }],
    // Order 1: the panel's single bright echo + the faint first-order room walls.
    // Keeping it to first order makes the panel's direct reflection the dominant
    // early cue rather than burying it under higher-order room scatter.
    maxOrder: 1,
  });

  const sceneA = scene('reflector-a', aIsLeft ? leftPos : rightPos);
  const sceneB = scene('reflector-b', aIsLeft ? rightPos : leftPos);
  return {
    type: 'reflector',
    id: '',
    prompt: 'Which room has the panel on the LEFT? (Clap and listen to the echo.)',
    choices: ['Room A', 'Room B'],
    correctAnswer: aIsLeft ? 'Room A' : 'Room B',
    sceneA,
    sceneB,
    bearingDeg: -offset, // the LEFT scene's panel bearing (for tests)
  };
}

// --- 4-way orientation classification (Thaler plank task) --------------------

/**
 * The four panel orientations from Thaler's orientation-perception task: judge a
 * plank as VERTICAL / 45° / 135° / HORIZONTAL — a 4-alternative forced choice,
 * harder than the A/B reflector drill.
 *
 * `tiltDeg` is the panel's tilt about its horizontal (left-right) axis, measured
 * from upright: 0° = a wall facing you, 90° = lying flat (floor/ceiling-like).
 * 45° tips the top toward you; 135° tips it away (past flat). Different tilts aim
 * the clap's specular reflection at different elevations (up vs back vs down), the
 * engine-supported acoustic cue that distinguishes them.
 */
export type Orientation = 'vertical' | '45' | '135' | 'horizontal';

export const ORIENTATIONS: { key: Orientation; label: string; tiltDeg: number }[] = [
  { key: 'vertical', label: 'Vertical', tiltDeg: 0 },
  { key: '45', label: '45 degrees', tiltDeg: 45 },
  { key: '135', label: '135 degrees', tiltDeg: 135 },
  { key: 'horizontal', label: 'Horizontal', tiltDeg: 90 },
];

const ORIENTATION_CHOICES = ORIENTATIONS.map((o) => o.label);

/**
 * PURE scoring: map a chosen label back to its Orientation key and compare to the
 * truth. Returns whether the pick is exactly correct (4AFC: only the exact class
 * counts — no partial credit), so chance is 25%, distinctly harder than A/B's 50%.
 */
export function classifyOrientation(chosenLabel: string, truth: Orientation): boolean {
  const picked = ORIENTATIONS.find((o) => o.label === chosenLabel)?.key;
  return picked === truth;
}

/**
 * Build a ~1 m square panel directly ahead of the listener (engine front = -z),
 * tilted about its left-right (x) axis by `tiltDeg` from upright. Double-sided so
 * it reflects regardless of tilt. The panel's centre stays at ear height; only the
 * face's elevation changes, so distance/direction are held constant and the ONLY
 * varying cue is the reflection's elevation — a fair 4-way discrimination.
 */
function makeTiltedPanel(
  listener: [number, number, number],
  distAhead: number,
  tiltDeg: number,
  material: keyof typeof MATERIALS,
  sizeM = 1,
): WallDef[] {
  const h = sizeM / 2;
  const [lx, ly, lz] = listener;
  const cx = lx;
  const cz = lz - distAhead; // straight ahead (front = -z)
  const t = (tiltDeg * Math.PI) / 180;
  // Width axis: left-right (x). Height axis: tilts in the z-y plane. At tilt 0 the
  // up axis is +y (upright wall); at tilt 90 it lies flat (up axis along z).
  const upY = Math.cos(t);
  const upZ = Math.sin(t);
  const vert = (sx: number, sUp: number): [number, number, number] =>
    [cx + sx, ly + sUp * upY, cz + sUp * upZ];
  return [{
    verts: [vert(-h, -h), vert(h, -h), vert(h, h), vert(-h, h)],
    absorption: [...MATERIALS[material]],
    doubleSided: true,
  }];
}

function genOrientation(rng: Rng, difficulty: number): Question {
  const roomSize: [number, number, number] = [16, 4, 16];
  const center: [number, number, number] = [8, 1.6, 8];
  const faint = allMat('acoustic_foam');

  // Panel close so its tilted reflection is the dominant early cue. Harder
  // difficulty pulls it slightly farther (cue weaker), keeping a gentle ramp.
  const dist = contrast(difficulty, 1.6, 2.6);
  const chosen = ORIENTATIONS[Math.floor(rng() * ORIENTATIONS.length) % ORIENTATIONS.length];

  const sceneA: Scene = {
    id: 'orientation',
    title: 'Orientation',
    description: 'Clap and judge the tilt of the panel ahead.',
    listener: center,
    roomSize,
    materials: faint, // big absorbent room → no size cue, just the panel echo
    extraWalls: makeTiltedPanel(center, dist, chosen.tiltDeg, 'concrete'),
    sources: [{ pos: center, kind: 'clap', label: 'clap' }],
    maxOrder: 1,
  };

  return {
    type: 'orientation',
    id: '',
    prompt: 'How is the panel ahead TILTED? Clap and classify: vertical, 45°, 135°, or horizontal.',
    choices: ORIENTATION_CHOICES,
    correctAnswer: chosen.label,
    sceneA,
  };
}

// --- Distance-to-wall (echo DELAY → distance) --------------------------------

/**
 * DISTANCE-TO-WALL: two large, highly-absorbent rooms, each with one hard
 * reflecting panel DIRECTLY AHEAD (engine front = -z) of the listener, at
 * different distances. The clap's reflection returns SOONER from the closer
 * wall — the trained cue is echo DELAY, the most fundamental echolocation skill.
 *
 * FAIRNESS: identical room, identical panel size + material, panel straight
 * ahead in both — only the distance differs. A closer wall is also slightly
 * louder, so to keep this a DELAY task (not loudness) we keep distances modest
 * (≈1.5–3 m) and rely on timing; loudness is a minor, deliberately-minimized
 * confound. The distance RATIO shrinks toward 1 as difficulty rises.
 *
 * Reuses genReflector's pattern: a big foam room so its own reflections are
 * faint and far-off, and the discriminating hard concrete panel (double-sided)
 * stands out. Both panels straight ahead so direction is held constant.
 */
function genDistance(rng: Rng, difficulty: number, opts: GenOptions = {}): Question {
  const roomSize: [number, number, number] = [16, 4, 16];
  const center: [number, number, number] = [8, 1.6, 8];
  const faint = allMat('acoustic_foam');

  // Near wall close-ish; far wall = near * ratio. Ratio big when easy → ~1 hard.
  // The DISTANCE LADDER (Thaler) backs the near panel away (33→66→99 cm…) via
  // `nearDistanceM`; clamped so the far panel still fits in the 16 m room.
  const near = Math.max(0.5, Math.min(6, opts.nearDistanceM ?? 1.5));
  const ratio = contrast(difficulty, 2.0, 1.3); // far/near distance ratio
  const far = near * ratio;

  const aIsClose = rng() < 0.5;
  const distA = aIsClose ? near : far;
  const distB = aIsClose ? far : near;

  // Straight ahead = engine front = -z (bearing 0).
  const aheadPanel = (dist: number) => {
    const [cx, cz] = bearingToPos(center, 0, dist);
    return makePanel(center, cx, cz, 'concrete');
  };

  const scene = (id: string, dist: number): Scene => ({
    id,
    title: id,
    description: 'Clap and hear how soon the wall ahead echoes back.',
    listener: center,
    roomSize,
    materials: faint,
    extraWalls: aheadPanel(dist),
    sources: [{ pos: center, kind: 'clap', label: 'clap' }],
    maxOrder: 1,
  });

  return {
    type: 'distance',
    id: '',
    prompt: 'Which room has the wall CLOSER ahead? (Clap and listen to how soon the echo returns.)',
    choices: ['Room A', 'Room B'],
    correctAnswer: aIsClose ? 'Room A' : 'Room B',
    sceneA: scene('distance-a', distA),
    sceneB: scene('distance-b', distB),
    wallDistsM: { a: distA, b: distB },
  };
}

// --- Find-the-gap (aperture: reflection on the wall side, silence at the gap) -

/**
 * FIND-THE-GAP: a wall spanning most of the front of the room, with a GAP
 * (opening) on the LEFT vs the RIGHT. The solid side reflects the clap; the gap
 * side is silent. The trained cue is the DIRECTION of the reflection / which
 * side is silent — NOT loudness.
 *
 * Implemented as the simpler brainstorm option: a hard panel on ONE side only
 * (the solid half), so the reflection comes from the side WITH the wall and the
 * gap is the silent side. FAIRNESS: a left/right mirror — same panel size,
 * material and distance, only the side differs (like genReflector's mirror).
 * The gap is on the OPPOSITE side from the panel.
 */
function genGap(rng: Rng, difficulty: number): Question {
  const roomSize: [number, number, number] = [16, 4, 16];
  const center: [number, number, number] = [8, 1.6, 8];
  const faint = allMat('acoustic_foam');

  // The solid half sits front-and-to-a-side: a forward distance with a lateral
  // offset. Wider lateral offset = easier (clearer side); narrower = harder.
  const dist = 2;
  const offset = contrast(difficulty, 45, 25); // bearing off straight-ahead, deg
  // Bigger half-panel so it reads as "a wall", not a small reflector.
  const panelSize = 1.6;

  const gapOnLeft = rng() < 0.5;
  // Gap on LEFT → solid wall on the RIGHT (+offset). Gap on RIGHT → wall LEFT (-offset).
  const wallBearing = gapOnLeft ? +offset : -offset;

  const scene = (id: string, bearing: number): Scene => {
    const [cx, cz] = bearingToPos(center, bearing, dist);
    return {
      id,
      title: id,
      description: 'Clap and hear which side the wall echoes from — the other side is the gap.',
      listener: center,
      roomSize,
      materials: faint,
      extraWalls: makePanel(center, cx, cz, 'concrete', panelSize),
      sources: [{ pos: center, kind: 'clap', label: 'clap' }],
      maxOrder: 1,
    };
  };

  return {
    type: 'gap',
    id: '',
    prompt: 'Which side is the GAP (opening) on? The wall echoes; the gap is silent.',
    choices: ['Left', 'Right'],
    correctAnswer: gapOnLeft ? 'Left' : 'Right',
    sceneA: scene('gap-a', wallBearing),
    // bearingDeg: the WALL's bearing (for tests). Gap is the opposite side.
    bearingDeg: wallBearing,
  };
}

// --- Entry point -------------------------------------------------------------

const GENERATORS: Record<ExerciseType, (rng: Rng, difficulty: number, opts: GenOptions) => Question> = {
  larger: genLarger,
  wider: genWider,
  longer: genLonger,
  carpet: genCarpet,
  brick: genBrick,
  direction: genDirection,
  reflector: genReflector,
  distance: genDistance,
  gap: genGap,
  material: genMaterial,
  metal: genMetal,
  orientation: genOrientation,
};

/** Single-scene exercises (one room, play once) rather than A/B. */
export const SINGLE_TYPES: ExerciseType[] = ['direction', 'gap', 'orientation'];

/**
 * Pure predicate: does this question have a genuine Room B to play?
 *
 * The "Play Room B" control must only be shown when the question actually carries
 * a second scene — gating on the live `sceneB` (not a hardcoded type list) is the
 * bug-proof source of truth, so a single-scene exercise can never surface a dead
 * Room B button (pressing which would do nothing / replay A).
 */
export function hasRoomB(q: Pick<Question, 'sceneB'>): boolean {
  return q.sceneB != null;
}

/**
 * Build a question of the given type, deterministic in `seed`. Same (type, seed,
 * difficulty) always yields the identical question.
 */
export function makeQuestion(type: ExerciseType, seed: number, opts: GenOptions = {}): Question {
  const rng = makeRng(seed);
  const q = GENERATORS[type](rng, opts.difficulty ?? 0, opts);
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
