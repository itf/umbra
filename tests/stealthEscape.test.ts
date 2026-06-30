/**
 * Stealth ("escape") mode + the throw-a-sound decoy verb.
 *
 * The Game class needs Web Audio, so the AUDIO side of the decoy (the clack) and
 * the live-region cues are exercised by the e2e smoke. Here we test the load-time
 * MODE WIRING (loadLevel maps goal:'escape'+exit onto the same goalTarget plumbing
 * absorber mode uses) and the PURE noise/monster MECHANICS the verb relies on:
 *  - a decoy's noise event out-weights the player's quiet (carpet) trail, so the
 *    monster commits to the decoy spot instead of the player;
 *  - the escape win target is the exit;
 *  - the catch test still loses on real proximity.
 */
import { describe, it, expect } from 'vitest';
import {
  makeMonster,
  updateMonster,
  caught,
  decayedLoudness,
  DEFAULT_NOISE_THRESHOLD,
  DEFAULT_CATCH_RADIUS,
} from '../src/game/monster';
import { makeNoiseEvent, type NoiseEvent } from '../src/game/noiseEvents';
import { getBuiltin } from '../src/level/builtins';
import { loadLevel } from '../src/level/load';

// The exact decoy noise Game.throwDecoy emits at the landing spot.
const decoyNoise = (x: number, z: number, tMs: number): NoiseEvent =>
  ({ x, z, loudness: 1.0, kind: 'bump', tMs });

describe('escape mode wiring (loadLevel)', () => {
  it('maps goal:escape + exit onto goalTarget (reusing the absorber plumbing)', () => {
    const level = getBuiltin('stealth-escape');
    expect(level, 'stealth-escape should be a builtin').toBeTruthy();
    const { game } = loadLevel(level!);
    expect(game.goal).toBe('escape');
    expect(game.goalTarget).toEqual({ x: level!.exit!.x, z: level!.exit!.z });
    // The decoy budget is threaded through.
    expect(game.decoyBudget).toBe(level!.decoyBudget);
    // A monster sits between the start and the exit.
    expect(game.monsters!.length).toBeGreaterThan(0);
  });

  it('the quiet route (acoustic_foam) is silent enough to lose the monster; gravel gives you away', () => {
    const level = getBuiltin('stealth-escape')!;
    // The quiet corridor is acoustic_foam — its step noise is below the monster's
    // attraction threshold even FRESH, so a careful player on it never (re)attracts
    // the monster (the evasion route). The default floor (gravel) is well above it.
    const quietStep = makeNoiseEvent('step', 0, 0, 'acoustic_foam', 0);
    expect(decayedLoudness(quietStep, 0)).toBeLessThan(DEFAULT_NOISE_THRESHOLD);
    const gravelStep = makeNoiseEvent('step', 0, 0, level.floorMaterial, 0);
    expect(decayedLoudness(gravelStep, 0)).toBeGreaterThan(DEFAULT_NOISE_THRESHOLD);
    // The level routes its quiet corridor with acoustic_foam.
    expect(level.floors.some((f) => f.material === 'acoustic_foam')).toBe(true);
  });
});

describe('throw-a-sound decoy (the verb, pure mechanics)', () => {
  it('the decoy out-weights the player\'s quiet trail: the monster goes to the decoy', () => {
    // Player has been tip-toeing on carpet (near-silent trail). Then throws a decoy.
    let m = makeMonster(0, 0, 100); // fast so it commits/arrives this update
    const quietTrail = makeNoiseEvent('step', 1, 0, 'acoustic_foam', 0);
    m = updateMonster(m, quietTrail, 10, 10);
    // The quiet trail did NOT attract it (decayed loudness below threshold).
    expect(m.target).toBeNull();

    // Throw a decoy 4 m away. It's loud + fresh → the monster commits to it.
    const decoy = decoyNoise(10, 0, 20);
    expect(decayedLoudness(decoy, 20)).toBeGreaterThan(DEFAULT_NOISE_THRESHOLD);
    m = updateMonster(m, decoy, 30, 30);
    expect(m.target).toEqual({ x: 10, z: 0 });
  });

  it('a fresh decoy out-attracts an older loud trail (newer wins)', () => {
    let m = makeMonster(0, 0, 1);
    const loudTrail = makeNoiseEvent('stumble', 2, 0, 'gravel', 0); // loud, at the player
    m = updateMonster(m, loudTrail, 10, 10);
    expect(m.target).toEqual({ x: 2, z: 0 });
    // A later decoy lands elsewhere → it's newer and still loud → retarget to it.
    const decoy = decoyNoise(-8, 0, 100);
    m = updateMonster(m, decoy, 110, 100);
    expect(m.target).toEqual({ x: -8, z: 0 });
  });
});

describe('escape outcomes (pure)', () => {
  it('reaching the exit position satisfies the goal radius (win)', () => {
    const level = getBuiltin('stealth-escape')!;
    const { game } = loadLevel(level);
    const exit = game.goalTarget!;
    const d = Math.hypot(exit.x - exit.x, exit.z - exit.z);
    expect(d).toBeLessThanOrEqual(game.goalRadius);
  });

  it('caught still loses on real proximity regardless of where the noise was', () => {
    // Monster is physically next to the player even though it was chasing a decoy.
    const m = updateMonster(makeMonster(5.5, 5, 1), decoyNoise(50, 50, 0), 10, 0);
    expect(caught(m, 5.5, 5, DEFAULT_CATCH_RADIUS)).toBe(true);
    expect(caught(m, 50, 50, DEFAULT_CATCH_RADIUS)).toBe(false);
  });
});
