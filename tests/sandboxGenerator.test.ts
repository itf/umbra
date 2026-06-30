/**
 * SANDBOX generator: determinism + solvability + difficulty fuzzing.
 *
 * The pure generator must produce, for every (mode × difficulty), a Level that is
 * isLevel-valid, loads, and whose goal is reachable from the start. We fuzz MANY
 * seeds per (mode, difficulty) to catch bad rolls the reroll/fallback must handle.
 */
import { describe, it, expect } from 'vitest';
import {
  generateLevel,
  SANDBOX_MODES,
  DIFFICULTIES,
  sandboxShareString,
  parseSeed,
  type Difficulty,
  type SandboxMode,
} from '../src/game/sandbox';
import { isLevel } from '../src/level/schema';
import { loadLevel } from '../src/level/load';
import type { GameLevel } from '../src/game/game';
import type { Level } from '../src/level/schema';

// --- Solvability checker (same grid flood-fill the suite uses) ----------------
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
function reachable(game: GameLevel, roomSize: [number, number, number], tx: number, tz: number): boolean {
  const [W, , Dz] = roomSize;
  const walls = game.walls ?? [];
  const step = 0.25;
  const blocked = (px: number, pz: number, qx: number, qz: number) =>
    walls.some((w) => segmentsIntersect(px, pz, qx, qz, w.ax, w.az, w.bx, w.bz));
  const key = (x: number, z: number) => `${x.toFixed(2)},${z.toFixed(2)}`;
  const snap = (v: number) => Math.round((v - step / 2) / step) * step + step / 2;
  const start: [number, number] = [snap(game.start.x), snap(game.start.z)];
  const goal = key(snap(tx), snap(tz));
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
function goalTarget(game: GameLevel): { x: number; z: number } {
  if (game.goalTarget) return game.goalTarget;
  return { x: game.beacon.x, z: game.beacon.z };
}

const SEEDS_PER_CELL = 40; // fuzz 40 seeds × 4 modes × 5 difficulties = 800 levels

describe('sandbox generator — validity + solvability (fuzzed)', () => {
  for (const mode of SANDBOX_MODES) {
    for (const d of DIFFICULTIES) {
      it(`${mode} d${d}: ${SEEDS_PER_CELL} seeds all valid + solvable`, () => {
        for (let s = 0; s < SEEDS_PER_CELL; s++) {
          const seed = (s * 2654435761) >>> 0;
          const level = generateLevel({ mode, difficulty: d, seed });
          // isLevel mutates/back-fills — clone so we don't perturb the asserts below.
          expect(isLevel(JSON.parse(JSON.stringify(level))), `${mode} d${d} seed ${seed} isLevel`).toBe(true);
          const loaded = loadLevel(level);
          const t = goalTarget(loaded.game);
          expect(
            reachable(loaded.game, loaded.roomSize, t.x, t.z),
            `${mode} d${d} seed ${seed} reachable`,
          ).toBe(true);
        }
      });
    }
  }
});

describe('sandbox generator — determinism', () => {
  it('same (mode, difficulty, seed) → deep-equal Level', () => {
    for (const mode of SANDBOX_MODES) {
      for (const d of DIFFICULTIES) {
        for (const seed of [0, 1, 12345, 0xdeadbeef]) {
          const a = generateLevel({ mode, difficulty: d as Difficulty, seed });
          const b = generateLevel({ mode, difficulty: d as Difficulty, seed });
          expect(b).toEqual(a);
        }
      }
    }
  });

  it('different seeds usually give different levels', () => {
    const seen = new Set<string>();
    for (let s = 0; s < 30; s++) {
      const l = generateLevel({ mode: 'beacon', difficulty: 3, seed: s });
      seen.add(JSON.stringify(l));
    }
    expect(seen.size).toBeGreaterThan(10); // plenty of variety
  });
});

describe('sandbox generator — difficulty monotonicity (sanity)', () => {
  it('sonar clap budget is non-increasing with difficulty', () => {
    let prev = Infinity;
    for (const d of DIFFICULTIES) {
      const l = generateLevel({ mode: 'sonar', difficulty: d, seed: 7 });
      const budget = l.clapBudget ?? Infinity;
      expect(budget).toBeLessThanOrEqual(prev);
      prev = budget;
    }
  });

  it('stealth monster count tends to grow with difficulty', () => {
    const counts = DIFFICULTIES.map((d) => {
      let total = 0;
      for (let s = 0; s < 20; s++) total += generateLevel({ mode: 'stealth', difficulty: d, seed: s }).monsters.length;
      return total;
    });
    expect(counts[4]).toBeGreaterThanOrEqual(counts[0]);
  });

  it('rooms tend to grow with difficulty (area)', () => {
    const area = (d: Difficulty) => {
      let a = 0;
      for (let s = 0; s < 20; s++) {
        const r = generateLevel({ mode: 'beacon', difficulty: d, seed: s }).room;
        a += r.width * r.depth;
      }
      return a;
    };
    expect(area(5)).toBeGreaterThan(area(1));
  });
});

describe('sandbox generator — stealth has a quiet path', () => {
  // A quiet (foam) lane must connect start → exit for every stealth roll.
  function quietPath(level: Level): boolean {
    const loaded = loadLevel(level);
    const [W, , Dz] = loaded.roomSize;
    const walls = loaded.game.walls ?? [];
    const step = 0.25;
    const blocked = (px: number, pz: number, qx: number, qz: number) =>
      walls.some((w) => segmentsIntersect(px, pz, qx, qz, w.ax, w.az, w.bx, w.bz));
    const quiet = (x: number, z: number) =>
      level.floors.some((f) => f.material === 'acoustic_foam' && x >= f.x && x <= f.x + f.w && z >= f.z && z <= f.z + f.d);
    const key = (x: number, z: number) => `${x.toFixed(2)},${z.toFixed(2)}`;
    const snap = (v: number) => Math.round((v - step / 2) / step) * step + step / 2;
    const start: [number, number] = [snap(level.start.x), snap(level.start.z)];
    if (!quiet(...start)) return false;
    const goal = key(snap(level.exit!.x), snap(level.exit!.z));
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
  for (const d of DIFFICULTIES) {
    it(`stealth d${d}: quiet lane connects start→exit (30 seeds)`, () => {
      for (let s = 0; s < 30; s++) {
        const level = generateLevel({ mode: 'stealth' as SandboxMode, difficulty: d, seed: s * 99991 });
        expect(quietPath(level), `stealth d${d} seed ${s}`).toBe(true);
      }
    });
  }
});

describe('sandbox share/parse helpers', () => {
  it('share string is stable and parse round-trips a seed', () => {
    expect(sandboxShareString({ mode: 'beacon', difficulty: 3, seed: 42 })).toContain('beacon');
    expect(parseSeed('42')).toBe(42);
    expect(parseSeed('hello')).toBe(parseSeed('hello'));
  });
});
