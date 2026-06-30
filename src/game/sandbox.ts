/**
 * SANDBOX / FREEPLAY — a seeded, deterministic, SOLVABLE level generator.
 *
 * The player picks a MODE (beacon / absorber / sonar / stealth) and a DIFFICULTY
 * (1..5); a seed is the ONLY entropy. `generateLevel({mode,difficulty,seed})`
 * returns a `Level` that passes `isLevel` + `loadLevel` + the flood-fill
 * solvability check. Same (mode, difficulty, seed) → byte-identical Level, so a
 * fun roll can be shared/replayed by its seed.
 *
 * PURITY: no Date.now()/Math.random() — a small seeded PRNG (mulberry32 over an
 * FNV-1a hash of the inputs, mirroring src/trainer/daily.ts) drives every choice.
 *
 * SOLVABILITY: each candidate is flood-filled (the SAME grid check the tests use,
 * on `loadLevel(level).game.walls`); an unsolvable candidate deterministically
 * perturbs the seed and retries up to a cap, then falls back to a known-good
 * empty box. Stealth additionally guarantees a QUIET (foam) lane to the exit.
 *
 * GENERATION RULES (per mode) and DIFFICULTY SCALING are documented at each
 * generator below. Difficulty 1 = small, plain, generous; 5 = large, cluttered,
 * scarce. The structural shape per mode matches the hand-authored exemplars
 * (large-concrete-hall / find-the-foam / sonar-vault / stealth-escape).
 */
import type {
  Level,
  MaterialName,
  WallObj,
  WallPatch,
  BeaconObj,
  FloorZone,
  MonsterObj,
} from '../level/schema';
import { isLevel } from '../level/schema';
import { loadLevel } from '../level/load';
import type { GameLevel } from './game';

export type SandboxMode = 'beacon' | 'absorber' | 'sonar' | 'stealth';
export const SANDBOX_MODES: SandboxMode[] = ['beacon', 'absorber', 'sonar', 'stealth'];

/** Difficulty 1 (easiest) .. 5 (hardest). */
export type Difficulty = 1 | 2 | 3 | 4 | 5;
export const DIFFICULTIES: Difficulty[] = [1, 2, 3, 4, 5];

export interface GenerateParams {
  mode: SandboxMode;
  difficulty: Difficulty;
  /** 32-bit seed (the only entropy). */
  seed: number;
}

// --- Seeded PRNG (pure) ------------------------------------------------------

/** FNV-1a over a string → 32-bit seed (mirrors trainer/daily.ts dailySeed). */
export function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: a tiny, fast, well-distributed seeded PRNG. Pure. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seeded RNG with convenience helpers, all pure functions of the seed. */
class Rng {
  private r: () => number;
  constructor(seed: number) {
    this.r = mulberry32(seed >>> 0);
  }
  /** float in [0,1). */
  next(): number {
    return this.r();
  }
  /** int in [lo, hi] inclusive. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.r() * (hi - lo + 1));
  }
  /** float in [lo, hi). */
  float(lo: number, hi: number): number {
    return lo + this.r() * (hi - lo);
  }
  /** pick one element. */
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.r() * arr.length)];
  }
  /** pick `n` distinct elements (n <= arr.length). */
  pickDistinct<T>(arr: readonly T[], n: number): T[] {
    const pool = [...arr];
    const out: T[] = [];
    for (let i = 0; i < n && pool.length; i++) {
      out.push(pool.splice(Math.floor(this.r() * pool.length), 1)[0]);
    }
    return out;
  }
}

// --- Material palettes -------------------------------------------------------

/** Reflective room/wall materials — bright, give clear echoes. */
const REFLECTIVE: MaterialName[] = ['concrete', 'tile', 'brick', 'marble', 'plaster', 'rough_stone'];
/** A very absorptive material for absorber patches / quiet lanes. */
const ABSORBER_MAT: MaterialName = 'acoustic_foam';
/** Loud floors (stealth: stepping here makes noise the monster hunts). */
const LOUD_FLOOR: MaterialName[] = ['gravel', 'tile', 'concrete'];
/** Quiet floors. */
const QUIET_FLOOR: MaterialName = 'acoustic_foam';

// --- Solvability check (mirrors tests/levelSolvable.test.ts) ------------------

function segmentsIntersect(
  ax: number, az: number, bx: number, bz: number,
  cx: number, cz: number, dx: number, dz: number,
): boolean {
  const ccw = (px: number, pz: number, qx: number, qz: number, rx: number, rz: number) =>
    (rz - pz) * (qx - px) > (qz - pz) * (rx - px);
  return (
    ccw(ax, az, cx, cz, dx, dz) !== ccw(bx, bz, cx, cz, dx, dz) &&
    ccw(ax, az, bx, bz, cx, cz) !== ccw(ax, az, bx, bz, dx, dz)
  );
}

/**
 * Flood-fill reachability on a 0.25 m grid using the game's collision walls.
 * `target` is the world point the player must reach (beacon / absorber face /
 * exit). Returns true if reachable from the start without crossing a wall.
 */
function targetReachable(
  game: GameLevel,
  roomSize: [number, number, number],
  target: { x: number; z: number },
): boolean {
  const [W, , Dz] = roomSize;
  const walls = game.walls ?? [];
  const step = 0.25;
  const blocked = (px: number, pz: number, qx: number, qz: number) =>
    walls.some((w) => segmentsIntersect(px, pz, qx, qz, w.ax, w.az, w.bx, w.bz));
  const key = (x: number, z: number) => `${x.toFixed(2)},${z.toFixed(2)}`;
  const snap = (v: number) => Math.round((v - step / 2) / step) * step + step / 2;
  const start: [number, number] = [snap(game.start.x), snap(game.start.z)];
  const goal = key(snap(target.x), snap(target.z));
  const seen = new Set<string>([key(...start)]);
  const queue: Array<[number, number]> = [start];
  while (queue.length) {
    const [cx, cz] = queue.shift()!;
    for (const [dx, dz] of [[step, 0], [-step, 0], [0, step], [0, -step]] as const) {
      const nx = +(cx + dx).toFixed(3), nz = +(cz + dz).toFixed(3);
      if (nx < 0 || nx > W || nz < 0 || nz > Dz) continue;
      const k = key(nx, nz);
      if (seen.has(k) || blocked(cx, cz, nx, nz)) continue;
      seen.add(k);
      queue.push([nx, nz]);
    }
  }
  return seen.has(goal);
}

/** The world target the player must reach for a given level (for solvability). */
function levelTarget(level: Level): { x: number; z: number } {
  if (level.goal === 'escape' && level.exit) return { x: level.exit.x, z: level.exit.z };
  if (level.goal === 'absorber' && level.absorbers?.[0]) {
    // The absorber patch's horizontal centre on its wall (matches load.ts).
    const p = level.absorbers[0];
    const { width: sx, depth: sz } = level.room;
    if (p.wall === '-z') return { x: p.u0 + p.uSize / 2, z: 0 };
    if (p.wall === '+z') return { x: p.u0 + p.uSize / 2, z: sz };
    if (p.wall === '-x') return { x: 0, z: p.u0 + p.uSize / 2 };
    return { x: sx, z: p.u0 + p.uSize / 2 };
  }
  const b = level.beacons[0];
  return { x: b.x, z: b.z };
}

/** Full validity gate: well-formed (isLevel), loads, and the target is reachable. */
function isCandidateGood(level: Level): boolean {
  // Deep-clone for isLevel (it back-fills/mutates).
  const clone = JSON.parse(JSON.stringify(level)) as Level;
  if (!isLevel(clone)) return false;
  let loaded;
  try {
    loaded = loadLevel(level);
  } catch {
    return false;
  }
  const target = levelTarget(level);
  if (!targetReachable(loaded.game, loaded.roomSize, target)) return false;
  // Stealth: also require a QUIET (foam) lane the whole way to the exit, so the
  // careful route is fair (not just *any* route through loud floor).
  if (level.goal === 'escape') {
    if (!quietPathExists(level, loaded)) return false;
  }
  return true;
}

/**
 * STEALTH fairness: is there a path to the exit that stays on quiet (foam) floor?
 * We restrict the flood-fill to cells whose floor material is the quiet lane. The
 * lane is authored as a foam corridor, so this confirms it actually connects.
 */
function quietPathExists(level: Level, loaded: ReturnType<typeof loadLevel>): boolean {
  const [W, , Dz] = loaded.roomSize;
  const walls = loaded.game.walls ?? [];
  const step = 0.25;
  const blocked = (px: number, pz: number, qx: number, qz: number) =>
    walls.some((w) => segmentsIntersect(px, pz, qx, qz, w.ax, w.az, w.bx, w.bz));
  const quiet = (x: number, z: number): boolean =>
    level.floors.some(
      (f) => f.material === QUIET_FLOOR && x >= f.x && x <= f.x + f.w && z >= f.z && z <= f.z + f.d,
    );
  const key = (x: number, z: number) => `${x.toFixed(2)},${z.toFixed(2)}`;
  const snap = (v: number) => Math.round((v - step / 2) / step) * step + step / 2;
  const start: [number, number] = [snap(level.start.x), snap(level.start.z)];
  if (!quiet(...start)) return false;
  const t = levelTarget(level);
  const goal = key(snap(t.x), snap(t.z));
  const seen = new Set<string>([key(...start)]);
  const queue: Array<[number, number]> = [start];
  while (queue.length) {
    const [cx, cz] = queue.shift()!;
    for (const [dx, dz] of [[step, 0], [-step, 0], [0, step], [0, -step]] as const) {
      const nx = +(cx + dx).toFixed(3), nz = +(cz + dz).toFixed(3);
      if (nx < 0 || nx > W || nz < 0 || nz > Dz) continue;
      const k = key(nx, nz);
      if (seen.has(k) || blocked(cx, cz, nx, nz) || !quiet(nx, nz)) continue;
      seen.add(k);
      queue.push([nx, nz]);
    }
  }
  return seen.has(goal);
}

// --- Per-mode candidate builders ---------------------------------------------

/** Pick a room size scaled by difficulty (bigger + more variable when harder). */
function roomSize(rng: Rng, d: Difficulty): { width: number; depth: number; height: number } {
  const base = 8 + d * 2; // 10..18 baseline
  const width = Math.round(base + rng.float(-1, 3));
  const depth = Math.round(base + 2 + rng.float(0, 4 + d));
  const height = d <= 2 ? 3 : rng.pick([3, 4, 6, 8]);
  return { width, depth, height };
}

const FREQS = [262, 294, 330, 349, 392, 440, 494, 523, 587, 659];
const BEACON_SOUNDS = ['tone', 'bell', 'musicbox', 'hum', 'pulse', 'drip'] as const;

/**
 * BEACON mode: navigate to a goal tone across the room. Difficulty adds baffle
 * walls (partial barriers leaving a gap) you must route around — more + longer
 * baffles when harder. Start and beacon sit on opposite ends.
 */
function buildBeacon(rng: Rng, d: Difficulty): Level {
  const room = roomSize(rng, d);
  const [rm] = rng.pickDistinct(REFLECTIVE, 1);
  const start = { x: room.width / 2, z: room.depth - 1.5, yaw: 0 };
  const beacon: BeaconObj = {
    id: 'b1',
    x: rng.float(1.5, room.width - 1.5),
    z: 1.5,
    freq: rng.pick(FREQS),
    goalRadius: d <= 2 ? 1.0 : 0.8,
    sound: rng.pick(BEACON_SOUNDS),
  };
  // Baffles: horizontal partial walls leaving an alternating-side gap.
  const nBaffles = Math.max(0, d - 1); // 0..4
  const walls: WallObj[] = [];
  for (let i = 0; i < nBaffles; i++) {
    const z = ((i + 1) / (nBaffles + 1)) * (room.depth - 4) + 2;
    const gapW = rng.float(2.0, 3.0); // walkable opening
    const fromLeft = i % 2 === 0;
    walls.push(
      fromLeft
        ? { id: `w${i}`, ax: 0, az: z, bx: room.width - gapW, bz: z, material: rng.pick(REFLECTIVE) }
        : { id: `w${i}`, ax: gapW, az: z, bx: room.width, bz: z, material: rng.pick(REFLECTIVE) },
    );
  }
  return {
    version: 1,
    name: `Sandbox Beacon (d${d})`,
    open: false,
    room,
    roomMaterial: rm,
    floorMaterial: 'concrete',
    hasCeiling: true,
    ceilingMaterial: rm,
    goal: 'beacon',
    start,
    beacons: [beacon],
    walls,
    floors: [],
    ceilings: [],
    monsters: [],
    absorbers: [],
  };
}

/**
 * ABSORBER mode ("find the foam"): a reflective box with one absorptive patch on
 * a perimeter wall — clap and walk to the dead spot. Difficulty SHRINKS the patch
 * (harder to localize) and enlarges the room (longer to search). The interior is
 * open (the patch is the puzzle), so it's always solvable; we still verify.
 */
function buildAbsorber(rng: Rng, d: Difficulty): Level {
  const room = roomSize(rng, d);
  const [rm] = rng.pickDistinct(REFLECTIVE, 1);
  const wall = rng.pick(['-z', '+z', '-x', '+x'] as const);
  const along = wall === '-z' || wall === '+z' ? room.width : room.depth;
  const uSize = Math.max(1.2, 4.0 - d * 0.5); // 3.5 (d1) .. 1.5 (d5)
  const u0 = rng.float(0.5, Math.max(0.6, along - uSize - 0.5));
  const vSize = Math.min(2.0, room.height - 0.6);
  const patch: WallPatch = { id: 'foam-1', wall, u0, v0: 0.6, uSize, vSize, material: ABSORBER_MAT };
  return {
    version: 1,
    name: `Sandbox Absorber (d${d})`,
    open: false,
    room,
    roomMaterial: rm,
    floorMaterial: 'concrete',
    hasCeiling: true,
    ceilingMaterial: rm,
    goal: 'absorber',
    absorbers: [patch],
    start: { x: room.width / 2, z: room.depth - 1.5, yaw: 0 },
    // A silent locator beacon at room centre keeps loadLevel's beacon[0] valid;
    // in absorber mode the goal target is the patch, not this beacon.
    beacons: [{ id: 'b1', x: room.width / 2, z: room.depth / 2, freq: 440, goalRadius: 1.5, sound: 'tone' }],
    walls: [],
    floors: [],
    ceilings: [],
    monsters: [],
  };
}

/**
 * SONAR mode ("clap on a budget"): a maze of staggered horizontal baffles with a
 * limited clap budget + cooldown. Difficulty adds baffles (more turns) and TIGHTENS
 * the clap budget + cooldown. Baffles alternate the gap side so there's always a
 * serpentine route (verified solvable).
 */
function buildSonar(rng: Rng, d: Difficulty): Level {
  const room = roomSize(rng, d);
  room.height = 3;
  const [rm, wm] = rng.pickDistinct(REFLECTIVE, 2);
  const nWalls = 1 + d; // 2..6 baffles
  const walls: WallObj[] = [];
  const gapW = Math.max(1.6, 3.0 - d * 0.2);
  for (let i = 0; i < nWalls; i++) {
    const z = ((i + 1) / (nWalls + 1)) * room.depth;
    const fromLeft = i % 2 === 0;
    walls.push(
      fromLeft
        ? { id: `w${i}`, ax: 0, az: +z.toFixed(2), bx: +(room.width - gapW).toFixed(2), bz: +z.toFixed(2), material: i % 2 ? rm : wm }
        : { id: `w${i}`, ax: +gapW.toFixed(2), az: +z.toFixed(2), bx: room.width, bz: +z.toFixed(2), material: i % 2 ? rm : wm },
    );
  }
  // Start near the gap of the FIRST (bottom) baffle, beacon past the LAST (top).
  const firstFromLeft = true; // i=0 ⇒ gap on the right
  const start = { x: firstFromLeft ? room.width - gapW / 2 : gapW / 2, z: room.depth - 1.5, yaw: 0 };
  const lastFromLeft = (nWalls - 1) % 2 === 0;
  const beacon: BeaconObj = {
    id: 'b1',
    x: lastFromLeft ? room.width - gapW / 2 : gapW / 2,
    z: 1.5,
    freq: rng.pick(FREQS),
    goalRadius: 0.9,
    sound: 'bell',
  };
  const clapBudget = Math.max(3, 12 - d); // 11 (d1) .. 7 (d5)
  const clapCooldownMs = 1000 + d * 400; // 1.4s .. 3s
  return {
    version: 1,
    name: `Sandbox Sonar (d${d})`,
    open: false,
    room,
    roomMaterial: rm,
    floorMaterial: 'concrete',
    hasCeiling: true,
    ceilingMaterial: rm,
    goal: 'beacon',
    clapBudget,
    clapCooldownMs,
    start,
    beacons: [beacon],
    walls,
    floors: [],
    ceilings: [],
    monsters: [],
    absorbers: [],
  };
}

/**
 * STEALTH mode ("escape the hunter"): reach the exit uncaught past noise-hunting
 * monster(s). A QUIET (foam) lane runs the full length one side of the room; the
 * rest is loud floor (stepping there alerts the monster). Difficulty adds monsters
 * + speed and NARROWS the quiet lane / cuts the decoy budget. The quiet lane is
 * verified to connect start→exit (quietPathExists), so the careful route is always
 * available. NEEDS-PLAYTEST: monster placement fairness is heuristic.
 */
function buildStealth(rng: Rng, d: Difficulty): Level {
  const room = roomSize(rng, d);
  room.height = 3;
  const rm: MaterialName = 'rough_stone';
  const loud = rng.pick(LOUD_FLOOR);
  // Quiet lane down the left edge, full depth. Narrower when harder.
  const laneW = Math.max(2.0, 4.5 - d * 0.4); // 4.1 (d1) .. 2.5 (d5)
  const exit = { x: laneW / 2, z: 1.5 };
  const start = { x: laneW / 2, z: room.depth - 1.5, yaw: 0 };
  const floors: FloorZone[] = [
    { id: 'quiet-lane', x: 0.25, z: 0.5, w: laneW, d: room.depth - 1, material: QUIET_FLOOR },
    { id: 'loud-field', x: laneW + 0.25, z: 0.5, w: room.width - laneW - 0.5, d: room.depth - 1, material: loud },
  ];
  // Monsters out in the loud field (never camping the quiet lane mouth/exit).
  const nMonsters = d <= 1 ? 1 : d <= 3 ? rng.int(1, 2) : 2;
  const monsters: MonsterObj[] = [];
  for (let i = 0; i < nMonsters; i++) {
    monsters.push({
      id: `m${i}`,
      x: rng.float(laneW + 1.5, room.width - 1),
      z: rng.float(room.depth * 0.25, room.depth * 0.75),
      speed: +(0.5 + d * 0.1 + rng.float(0, 0.1)).toFixed(2),
      sound: rng.pick(['growl', 'hum', 'breath']),
    });
  }
  const decoyBudget = Math.max(0, 4 - d); // 3 (d1) .. 0 (d5)
  return {
    version: 1,
    name: `Sandbox Stealth (d${d})`,
    open: false,
    room,
    roomMaterial: rm,
    floorMaterial: loud,
    hasCeiling: true,
    ceilingMaterial: rm,
    goal: 'escape',
    exit,
    decoyBudget,
    start,
    beacons: [{ id: 'exit', x: exit.x, z: exit.z, freq: 330, goalRadius: 1.0, sound: 'hum' }],
    walls: [],
    floors,
    ceilings: [],
    monsters,
    absorbers: [],
  };
}

const BUILDERS: Record<SandboxMode, (rng: Rng, d: Difficulty) => Level> = {
  beacon: buildBeacon,
  absorber: buildAbsorber,
  sonar: buildSonar,
  stealth: buildStealth,
};

// --- Public API --------------------------------------------------------------

/** Max reroll attempts before falling back to a guaranteed-good simple layout. */
const MAX_ATTEMPTS = 24;

/**
 * A guaranteed-good, dead-simple fallback level per mode: an empty (or minimal)
 * box that always passes the solvability + validity gates. Used only when every
 * reroll fails (should be vanishingly rare). Deterministic in (mode,difficulty).
 */
function fallbackLevel(mode: SandboxMode, d: Difficulty, seed: number): Level {
  const room = { width: 12, depth: 16, height: 3 };
  const base: Level = {
    version: 1,
    name: `Sandbox ${mode} (d${d}, fallback)`,
    open: false,
    room,
    roomMaterial: 'concrete',
    floorMaterial: 'concrete',
    hasCeiling: true,
    ceilingMaterial: 'concrete',
    start: { x: 6, z: 14, yaw: 0 },
    beacons: [{ id: 'b1', x: 6, z: 2, freq: 440, goalRadius: 1.0, sound: 'tone' }],
    walls: [],
    floors: [],
    ceilings: [],
    monsters: [],
    absorbers: [],
  };
  if (mode === 'absorber') {
    base.goal = 'absorber';
    base.absorbers = [{ id: 'foam-1', wall: '-z', u0: 4.5, v0: 0.6, uSize: 3, vSize: 1.8, material: ABSORBER_MAT }];
    base.beacons[0].goalRadius = 1.5;
  } else if (mode === 'sonar') {
    base.goal = 'beacon';
    base.clapBudget = Math.max(3, 12 - d);
    base.clapCooldownMs = 1000 + d * 400;
  } else if (mode === 'stealth') {
    base.goal = 'escape';
    base.exit = { x: 2, z: 1.5 };
    base.beacons[0] = { id: 'exit', x: 2, z: 1.5, freq: 330, goalRadius: 1.0, sound: 'hum' };
    base.start = { x: 2, z: 14, yaw: 0 };
    base.floors = [{ id: 'quiet-lane', x: 0.25, z: 0.5, w: 4, d: 15, material: QUIET_FLOOR }];
    base.decoyBudget = Math.max(0, 4 - d);
    base.monsters = [{ id: 'm0', x: 8, z: 8, speed: 0.6, sound: 'growl' }];
  }
  void seed;
  return base;
}

/**
 * PURE: generate a deterministic, SOLVABLE Level from (mode, difficulty, seed).
 *
 * Same inputs ⇒ identical Level. A candidate is built from a seeded RNG, then
 * validated (isLevel + loadLevel + flood-fill reachability, plus a quiet-lane
 * check for stealth). If it fails, the seed is deterministically perturbed and
 * the build retried up to MAX_ATTEMPTS; if all fail, a known-good fallback box is
 * returned. The build's name encodes mode+difficulty for the picker/announcer.
 */
export function generateLevel(params: GenerateParams): Level {
  const { mode, difficulty, seed } = params;
  const build = BUILDERS[mode];
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // Decorrelate each attempt's seed deterministically (so retries are stable).
    const attemptSeed = hashSeed(`${mode}|${difficulty}|${seed >>> 0}|${attempt}`);
    const rng = new Rng(attemptSeed);
    const candidate = build(rng, difficulty);
    if (isCandidateGood(candidate)) return candidate;
  }
  return fallbackLevel(mode, difficulty, seed);
}

/** A short, copy-pasteable share string for a generated level. */
export function sandboxShareString(p: GenerateParams): string {
  return `papasangre sandbox ${p.mode} d${p.difficulty} #${(p.seed >>> 0).toString(36)}`;
}

/** Parse a seed from arbitrary user text (a number, base36, or hashed string). */
export function parseSeed(text: string): number {
  const t = text.trim();
  if (/^\d+$/.test(t)) return Number(t) >>> 0;
  // base36 (#xxxx) or any string → stable hash.
  return hashSeed(t.replace(/^#/, ''));
}
