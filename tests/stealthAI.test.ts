/**
 * STEALTH-AI SIMULATION TESTS — headless, pure-model verification of the monster
 * chase dynamics on the stealth/escape levels (build 7A).
 *
 * Unlike `levelSolvable.test.ts` (flood-fill geometric reachability) and
 * `stealthEscape.test.ts` (unit checks of the noise/monster primitives), this
 * harness runs a STEP-BY-STEP SIMULATION of the actual monster AI against a
 * scripted "careful player" walking the intended quiet route, using:
 *   - the real per-material step-loudness mapping (`noiseEvents`),
 *   - the real floor-material lookup the game uses (topmost matching zone),
 *   - the real pure `updateMonster` AI core, ticked at the player's step cadence.
 *
 * Per level we assert THREE things, turning "reasoned but untested" tuning into
 * tests:
 *   1. CAREFUL ROUTE survivable — the foam route reaches the exit uncaught.
 *   2. LOUD (gravel) ROUTE caught — the level genuinely requires stealth (the
 *      mechanic is real, not a trivially safe map).
 *   3. (chokepoint) the DECOY works — thrown at the gateway it pulls the warden
 *      toward the decoy and away from the gate, opening a gap the player slips.
 *
 * No Web Audio. The level JSON is read via `getBuiltin` (pure); we do NOT call
 * `loadLevel` (which needs the WASM acoustics core) because everything the AI sim
 * needs — monster spawns/speed, floor zones, exit, walls — is in the JSON.
 */
import { describe, it, expect } from 'vitest';
import {
  makeMonster,
  updateMonster,
  caught,
  type MonsterState,
  DEFAULT_CATCH_RADIUS,
} from '../src/game/monster';
import { makeNoiseEvent, NoiseTracker } from '../src/game/noiseEvents';
import { getBuiltin } from '../src/level/builtins';
import type { Level } from '../src/level/schema';

// ---- sim harness -----------------------------------------------------------

/** The game's floor-material lookup: the topmost (last) matching zone wins,
 *  else the level default floor. Mirrors Game.floorMaterialAt. */
function floorMaterialAt(level: Level, x: number, z: number): string {
  const zones = level.floors ?? [];
  for (let i = zones.length - 1; i >= 0; i--) {
    const f = zones[i];
    if (x >= f.x && x <= f.x + f.w && z >= f.z && z <= f.z + f.d) return f.material;
  }
  return level.floorMaterial;
}

interface SimResult {
  caught: boolean;
  reachedExit: boolean;
  minDist: number; // closest any monster got to the player over the whole walk
  monsters: MonsterState[];
}

interface SimOpts {
  /** A scripted hook called each step (after noise emit, before the tick) e.g.
   *  to throw a decoy at a particular point. Receives the player's (x,z) and tMs. */
  onStep?: (x: number, z: number, tMs: number, noise: NoiseTracker) => void;
  /** Override per-step material (for the "loud route" control), else use the
   *  floor under the player. */
  forceMaterial?: string;
}

/**
 * Walk the player along `path` (a list of waypoints) in fixed-length sub-steps,
 * emitting a step noise from the floor material under the player at each sub-step
 * and ticking every monster with the real AI. Returns whether the player got
 * caught and how close the monsters came.
 */
function simulateWalk(
  level: Level,
  path: { x: number; z: number }[],
  opts: SimOpts = {},
): SimResult {
  const STEP_LEN = 0.6; // metres per footstep (a careful stride)
  // A deliberate, slow creep — slower (0.5 m/s) than the wardens (0.55–0.6 m/s),
  // so a player whose position the monster LOCKS ONTO (loud route) gets run down,
  // while a quiet player survives purely by never being targeted (not by outrunning).
  const STEP_MS = 1200;
  let monsters = (level.monsters ?? []).map((m) => makeMonster(m.x, m.z, m.speed));
  const noise = new NoiseTracker();
  let tMs = 0;
  let minDist = Infinity;
  let px = path[0].x;
  let pz = path[0].z;
  const exit = level.exit!;

  const tickAll = (cx: number, cz: number) => {
    monsters = monsters.map((m) =>
      updateMonster(m, noise.lastNoise(), tMs, STEP_MS),
    );
    for (const m of monsters) {
      const d = Math.hypot(m.x - cx, m.z - cz);
      if (d < minDist) minDist = d;
      if (caught(m, cx, cz, DEFAULT_CATCH_RADIUS)) return true;
    }
    return false;
  };

  for (let seg = 1; seg < path.length; seg++) {
    const a = path[seg - 1];
    const b = path[seg];
    const segLen = Math.hypot(b.x - a.x, b.z - a.z);
    const nSub = Math.max(1, Math.ceil(segLen / STEP_LEN));
    for (let i = 1; i <= nSub; i++) {
      const t = i / nSub;
      px = a.x + (b.x - a.x) * t;
      pz = a.z + (b.z - a.z) * t;
      const mat = opts.forceMaterial ?? floorMaterialAt(level, px, pz);
      noise.emit(makeNoiseEvent('step', px, pz, mat, tMs));
      opts.onStep?.(px, pz, tMs, noise);
      const gotCaught = tickAll(px, pz);
      tMs += STEP_MS;
      if (gotCaught) {
        return { caught: true, reachedExit: false, minDist, monsters };
      }
    }
  }
  const reachedExit = Math.hypot(px - exit.x, pz - exit.z) <= 1.0;
  return { caught: false, reachedExit, minDist, monsters };
}

/** A straight quiet path up the centre of a foam corridor: from start to exit. */
function straightPath(level: Level): { x: number; z: number }[] {
  return [
    { x: level.start.x, z: level.start.z },
    { x: level.exit!.x, z: level.start.z }, // sidestep onto the spine x if needed
    { x: level.exit!.x, z: level.exit!.z },
  ];
}

// ---- per-level tests -------------------------------------------------------

const STEALTH_LEVELS = ['stealth-escape', 'stealth-twin-wardens', 'stealth-chokepoint'];
// Levels whose quiet route is survivable by stealth ALONE (no decoy). The
// chokepoint is excluded: its single warden physically occupies the only gateway,
// so it REQUIRES a decoy to clear (covered by the decoy test below, plus a
// no-decoy negative control).
const FOAM_SURVIVABLE = ['stealth-escape', 'stealth-twin-wardens'];

describe('stealth-AI simulation — careful route survivable', () => {
  for (const id of FOAM_SURVIVABLE) {
    it(`${id}: a careful player on the quiet (foam) route reaches the exit uncaught`, () => {
      const level = getBuiltin(id)!;
      expect(level, `${id} should be a builtin`).toBeTruthy();
      // The careful player walks up the foam spine (at the exit's x) to the exit.
      const path = straightPath(level);
      // Sanity: the route is actually over foam at its waypoints.
      const midZ = (level.start.z + level.exit!.z) / 2;
      expect(floorMaterialAt(level, level.exit!.x, midZ)).toBe('acoustic_foam');

      const res = simulateWalk(level, path);
      expect(res.caught, `${id}: should NOT be caught on the quiet route`).toBe(false);
      expect(res.reachedExit, `${id}: should reach the exit`).toBe(true);
    });
  }
});

describe('stealth-AI simulation — loud route is detected (mechanic is real)', () => {
  for (const id of STEALTH_LEVELS) {
    it(`${id}: a player making loud (gravel) steps the whole way IS caught`, () => {
      const level = getBuiltin(id)!;
      const path = straightPath(level);
      // Force every step to be loud gravel — the negative control. A genuinely
      // stealth-requiring level must catch this player.
      const res = simulateWalk(level, path, { forceMaterial: 'gravel' });
      expect(res.caught, `${id}: the loud route should be caught (level requires stealth)`).toBe(true);
    });
  }
});

describe('stealth-AI simulation — chokepoint requires the decoy', () => {
  it('stealth-chokepoint: WITHOUT a decoy, the gateway warden catches the careful player', () => {
    // The warden physically occupies the only gateway on the foam spine, so even a
    // silent player walking straight up the spine runs into it — the decoy is
    // mandatory, not optional (this is the level's whole premise).
    const level = getBuiltin('stealth-chokepoint')!;
    const res = simulateWalk(level, straightPath(level));
    expect(res.caught, 'no-decoy careful walk should be caught at the gate').toBe(true);
  });
});

describe('stealth-AI simulation — the decoy verb (chokepoint)', () => {
  it('stealth-chokepoint: a decoy at the gateway pulls the warden off the gate, opening a gap', () => {
    const level = getBuiltin('stealth-chokepoint')!;
    const gateZ = 10; // the gateway wall row

    // Reproduce Game.throwDecoy: a loud, fresh bump 4 m AHEAD of the player
    // (yaw 0 → -z). The player throws as they approach the gate, landing the
    // decoy off to the side (toward an x the warden will chase away from centre).
    let decoyThrown = false;
    const decoyX = 1.5; // off to the left, well away from the exit's x (=6)
    let monsters = level.monsters!.map((m) => makeMonster(m.x, m.z, m.speed));
    const noise = new NoiseTracker();
    const STEP_MS = 1200;
    let tMs = 0;

    // Player creeps up the foam spine; when just below the gate, throw the decoy.
    const path = straightPath(level);
    const STEP_LEN = 0.6;
    let px = path[0].x;
    let pz = path[0].z;
    let wardenAtThrow: MonsterState | null = null;
    let caughtFlag = false;

    for (let seg = 1; seg < path.length && !caughtFlag; seg++) {
      const a = path[seg - 1];
      const b = path[seg];
      const segLen = Math.hypot(b.x - a.x, b.z - a.z);
      const nSub = Math.max(1, Math.ceil(segLen / STEP_LEN));
      for (let i = 1; i <= nSub && !caughtFlag; i++) {
        const t = i / nSub;
        px = a.x + (b.x - a.x) * t;
        pz = a.z + (b.z - a.z) * t;
        noise.emit(makeNoiseEvent('step', px, pz, floorMaterialAt(level, px, pz), tMs));
        // Throw the decoy once, when approaching the gate from below.
        if (!decoyThrown && pz <= gateZ + 1.5 && pz > gateZ) {
          noise.emit({ x: decoyX, z: gateZ, loudness: 1.0, kind: 'bump', tMs });
          decoyThrown = true;
          wardenAtThrow = monsters[0];
        }
        monsters = monsters.map((m) => updateMonster(m, noise.lastNoise(), tMs, STEP_MS));
        for (const m of monsters) {
          if (caught(m, px, pz, DEFAULT_CATCH_RADIUS)) caughtFlag = true;
        }
        tMs += STEP_MS;
      }
    }

    expect(decoyThrown, 'the decoy should have been thrown at the gate').toBe(true);
    const warden = monsters[0];
    // The warden committed to the decoy: its TARGET is the decoy spot.
    expect(warden.target).not.toBeNull();
    expect(warden.target!.x).toBeCloseTo(decoyX, 5);
    // And it physically moved toward the decoy x (away from the gate centre/exit x=6).
    expect(wardenAtThrow).not.toBeNull();
    expect(warden.x).toBeLessThan(wardenAtThrow!.x);
    // The player slipped through uncaught.
    expect(caughtFlag, 'the player should slip through after the decoy').toBe(false);
  });
});
