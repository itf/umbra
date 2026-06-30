/**
 * Solvability regression for maze-style demo levels: the beacon must be REACHABLE
 * from the start without crossing a collision wall. Catches the "sealed maze" bug
 * (a serpentine whose gaps don't actually connect) at CI time, on the SAME
 * collision walls the game uses (`loadLevel(level).game.walls`).
 */
import { describe, it, expect } from 'vitest';
import { getBuiltin } from '../src/level/builtins';
import { loadLevel } from '../src/level/load';
import type { GameLevel } from '../src/game/game';

/** Segment AB vs segment CD intersection (same test the game uses for collision). */
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

/** Flood-fill on a grid; true if the beacon cell is reachable from the start. */
function beaconReachable(game: GameLevel, roomSize: [number, number, number]): boolean {
  const [W, , Dz] = roomSize;
  const walls = game.walls ?? [];
  const step = 0.25;
  const blocked = (px: number, pz: number, qx: number, qz: number) =>
    walls.some((w) => segmentsIntersect(px, pz, qx, qz, w.ax, w.az, w.bx, w.bz));

  const key = (x: number, z: number) => `${x.toFixed(2)},${z.toFixed(2)}`;
  const snap = (v: number) => Math.round((v - step / 2) / step) * step + step / 2;
  const start: [number, number] = [snap(game.start.x), snap(game.start.z)];
  // The reachability goal is the WIN target (decoupled from any beacon): silent
  // levels have no beacon, so use winTarget (which falls back to the beacon).
  const win = game.winTarget ?? { x: game.beacon.x, z: game.beacon.z };
  const goal = key(snap(win.x), snap(win.z));

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

describe('maze demo levels are solvable (beacon reachable from start)', () => {
  for (const id of [
    'clap-maze',
    's-bend-maze',
    'sonar-vault',
    'stealth-escape',
    // Cycle-6A pack — every navigable new level (beacon maze, sonar mazes,
    // moving-wall vault at its rest position, and the stealth exits).
    'beacon-warren',
    'shifting-vault',
    'sonar-tight',
    'sonar-labyrinth',
    'stealth-twin-wardens',
    'stealth-chokepoint',
    // Silent side-doorway level: the win AREA (not a beacon) must be reachable
    // through the doorway gap from the start.
    'find-the-door',
  ]) {
    it(`${id}: the beacon is reachable from the start`, () => {
      const level = getBuiltin(id);
      expect(level, `${id} should be a builtin`).toBeTruthy();
      const loaded = loadLevel(level!);
      expect(beaconReachable(loaded.game, loaded.roomSize)).toBe(true);
    });
  }
});
