/**
 * Monster chase AI — a PURE, testable core (no Web Audio / DOM).
 *
 * THE DEFINING MECHANIC: the monster is DEAF to the player's actual position. It
 * hunts the LAST PLACE THE PLAYER MADE NOISE (`NoiseTracker.lastNoise()`), not
 * where the player currently is. Moving carefully on soft floors emits little/no
 * noise, so a stale noise fades (via the decay in `loudnessAt`) below an attraction
 * threshold and the monster loses the trail — it lingers at the last-heard spot
 * while the quiet player sneaks away. Rushing, stumbling, or loud floors give a
 * fresh loud spike that re-attracts it.
 *
 * The audio side (a spatialized growl through an HrtfSource) lives in game.ts; this
 * module is just the deterministic state update so it can be unit-tested without
 * audio. See docs/engine/monster-chase.md.
 */
import type { NoiseEvent } from './noiseEvents';

/** Default minimum decayed loudness for a noise to attract the monster. A faded
 *  noise below this is ignored (the evasion mechanic). */
export const DEFAULT_NOISE_THRESHOLD = 0.12;

/** Default distance (m) within which the monster has "reached" its target. */
export const DEFAULT_ARRIVE_RADIUS = 0.25;

/** Default real-proximity radius (m) at which the monster catches the player. */
export const DEFAULT_CATCH_RADIUS = 0.8;

/** Monster behaviour phase (for UI / debugging / docs). */
export type MonsterPhase = 'investigate' | 'idle';

/** Immutable-ish monster state. The pure update returns a fresh value. */
export interface MonsterState {
  x: number;
  z: number;
  /** Movement speed in m/s. */
  speed: number;
  /** The (x,z) it is currently moving toward (last noise it committed to), or null. */
  target: { x: number; z: number } | null;
  /** Emission time (ms) of the noise currently being chased; -Infinity if none. */
  targetTMs: number;
  /** Current behaviour phase. */
  phase: MonsterPhase;
}

/** Tuning knobs for the pure update (all optional; sensible defaults). */
export interface MonsterTuning {
  /** Decayed-loudness floor for a noise to attract. */
  noiseThreshold?: number;
  /** Distance at which the target counts as reached → idle. */
  arriveRadius?: number;
}

/** A fresh monster at a position with a speed and no target (idle). */
export function makeMonster(x: number, z: number, speed: number): MonsterState {
  return { x, z, speed, target: null, targetTMs: -Infinity, phase: 'idle' };
}

/**
 * The decayed loudness of a noise at time `now`, mirroring
 * `NoiseTracker.loudnessAt` but as a pure function of the EVENT (so the AI core
 * needs no tracker reference). Uses the same exponential decay.
 */
import { NOISE_DECAY_MS } from './noiseEvents';
export function decayedLoudness(noise: NoiseEvent, nowMs: number): number {
  const dt = Math.max(0, nowMs - noise.tMs);
  return noise.loudness * Math.exp(-dt / NOISE_DECAY_MS);
}

/**
 * PURE update: advance the monster by `dtMs` given the latest noise (or null).
 *
 * Retargeting rule: if there's a noise that is (a) NEWER than the one currently
 * being chased and (b) still loud enough RIGHT NOW (its decayed loudness ≥
 * threshold), commit to it as the new target. A faded/stale noise below threshold
 * does NOT attract — that's the evasion mechanic.
 *
 * Movement: step toward the current target at `speed`, clamped so the monster
 * never moves more than `speed * dt` in one update. On arrival (within
 * arriveRadius) it snaps to the target and IDLES (lingers) until a fresh noise
 * arrives. No target ⇒ idle in place.
 */
export function updateMonster(
  state: MonsterState,
  noise: NoiseEvent | null,
  nowMs: number,
  dtMs: number,
  tuning: MonsterTuning = {},
): MonsterState {
  const threshold = tuning.noiseThreshold ?? DEFAULT_NOISE_THRESHOLD;
  const arrive = tuning.arriveRadius ?? DEFAULT_ARRIVE_RADIUS;

  let { target, targetTMs, phase } = state;

  // Retarget on a fresh, still-audible noise.
  if (noise && noise.tMs > targetTMs && decayedLoudness(noise, nowMs) >= threshold) {
    target = { x: noise.x, z: noise.z };
    targetTMs = noise.tMs;
    phase = 'investigate';
  }

  let { x, z } = state;
  if (target) {
    const dx = target.x - x;
    const dz = target.z - z;
    const dist = Math.hypot(dx, dz);
    const maxStep = state.speed * Math.max(0, dtMs) / 1000;
    if (dist <= arrive || dist <= maxStep) {
      // Reached the last-heard spot (already within arrive radius, or this step
      // covers the whole remaining distance) — snap and linger (idle) until a fresh
      // noise arrives.
      x = target.x;
      z = target.z;
      phase = 'idle';
    } else {
      x += (dx / dist) * maxStep;
      z += (dz / dist) * maxStep;
      phase = 'investigate';
    }
  } else {
    phase = 'idle';
  }

  return { x, z, speed: state.speed, target, targetTMs, phase };
}

/** True when the monster's REAL position is within `radius` of the player. The AI
 *  navigates by noise, but the catch test uses honest proximity — it physically
 *  reaches you. */
export function caught(
  state: MonsterState,
  playerX: number,
  playerZ: number,
  radius: number = DEFAULT_CATCH_RADIUS,
): boolean {
  return Math.hypot(state.x - playerX, state.z - playerZ) <= radius;
}
