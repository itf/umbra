/**
 * Player NOISE-EVENT model — a PURE (no Web Audio / DOM) signal describing
 * WHERE the player made noise and HOW LOUD, derived from the same gameplay
 * events that drive footstep audio.
 *
 * This is the FOUNDATION for monster chase AI: the monster will hunt the LAST
 * PLACE THE PLAYER MADE NOISE (via `NoiseTracker.lastNoise()`), not the player's
 * actual position. Moving carefully on soft floors (carpet/foam) emits little
 * noise, so a monster would lose the trail; loud floors (gravel/rough_stone),
 * stumbles, and wall bumps emit big spikes that give the player away.
 *
 * Loudness is normalized to [0,1]. Step loudness is derived from the material's
 * step `level` (see stepSounds.ts — the SAME presets that set audible footstep
 * gain), but mapped through a FIXED ABSOLUTE reference range (not a fragile
 * min/max of whatever materials happen to be in the table) so the SNEAK intent is
 * intentional: soft floors (acoustic_foam, curtain, carpet, grass) land well
 * BELOW the monster's attraction threshold (DEFAULT_NOISE_THRESHOLD = 0.12) and
 * are genuinely sneakable, while hard/loud floors (concrete, tile, gravel,
 * rough_stone, wood) land comfortably above it. Stumbles and bumps are large
 * FIXED spikes regardless of floor (you trip loudly on carpet too).
 * See docs/engine/noise-events.md.
 */
import { soundsFor } from './stepSounds';

export type NoiseKind = 'step' | 'stumble' | 'bump';

/** A positioned noise the player emitted, with normalized loudness in [0,1]. */
export interface NoiseEvent {
  x: number;
  z: number;
  /** Normalized loudness in [0,1] (0 = inaudible, 1 = max spike). */
  loudness: number;
  kind: NoiseKind;
  /** Emission time, ms (same clock the caller uses for steps). */
  tMs: number;
}

// ---- material → loudness normalization -------------------------------------
// We map a material's audible step `level` through a FIXED absolute reference
// range [QUIET_FLOOR_LEVEL, LOUD_FLOOR_LEVEL] and then apply a gamma curve that
// pushes the soft end down. This is deliberately NOT a min/max of the table:
// tying "sneakable" to whatever the quietest/loudest preset happens to be made
// the outcome an accident of the spread (carpet used to normalize to ~0.148,
// ABOVE the 0.12 threshold, so soft carpet steps wrongly attracted the monster).
//
// With the current presets the soft cluster (foam 0.28, curtain 0.30,
// carpet 0.32, grass 0.40) maps well under DEFAULT_NOISE_THRESHOLD (0.12) and
// the hard/loud cluster (gravel 0.50, wood/rough_stone/tile/concrete 0.55) maps
// comfortably above it. Tuned against monster.ts's DEFAULT_NOISE_THRESHOLD.
const QUIET_FLOOR_LEVEL = 0.35; // step `level` at/below which a floor is silent-to-monster
const LOUD_FLOOR_LEVEL = 0.52; // step `level` at/above which a floor is max loudness
const LOUDNESS_GAMMA = 2.0; // >1 pushes the soft end further down

/**
 * Fixed loudness spikes for stumble / bump — large regardless of floor. A stumble
 * is the loudest event (you crash); a bump is nearly as loud.
 */
export const STUMBLE_LOUDNESS = 1.0;
export const BUMP_LOUDNESS = 0.9;

/** Time constant (ms) over which a noise's perceived loudness decays to ~37%. */
export const NOISE_DECAY_MS = 2500;

/**
 * Map a material's audible step `level` to a normalized [0,1] step loudness.
 * Soft floors (carpet/foam/grass) → well below the monster threshold (0.12);
 * loud floors (gravel/concrete) → near the top. Uses a FIXED absolute reference
 * range + gamma (see above), so the sneak intent doesn't drift if presets change.
 * Falls back to concrete for unknown materials (matching soundsFor).
 */
export function stepLoudnessForMaterial(material: string): number {
  const level = soundsFor(material).step.level;
  const t = (level - QUIET_FLOOR_LEVEL) / (LOUD_FLOOR_LEVEL - QUIET_FLOOR_LEVEL);
  const clamped = Math.max(0, Math.min(1, t));
  return Math.pow(clamped, LOUDNESS_GAMMA);
}

/**
 * Loudness for a noise of `kind`. Steps derive loudness from the floor material;
 * stumbles and bumps are fixed spikes (material is ignored for them).
 */
export function loudnessFor(kind: NoiseKind, material: string): number {
  switch (kind) {
    case 'stumble': return STUMBLE_LOUDNESS;
    case 'bump': return BUMP_LOUDNESS;
    case 'step': return stepLoudnessForMaterial(material);
  }
}

/** Build a NoiseEvent, computing loudness from kind + floor material. */
export function makeNoiseEvent(
  kind: NoiseKind,
  x: number,
  z: number,
  material: string,
  tMs: number,
): NoiseEvent {
  return { x, z, loudness: loudnessFor(kind, material), kind, tMs };
}

/**
 * Records the LAST noise event. The monster reads `lastNoise()` to decide where
 * to hunt; `loudnessAt(tMs)` exposes a decaying loudness so a stale noise is less
 * compelling than a fresh one (the EVENT loudness is unchanged; only the
 * perceived "how loud is it right now" fades).
 */
export class NoiseTracker {
  private last: NoiseEvent | null = null;
  private onNoise?: (e: NoiseEvent) => void;

  constructor(onNoise?: (e: NoiseEvent) => void) {
    this.onNoise = onNoise;
  }

  /** Record a noise event as the most recent. Newer events replace older ones. */
  emit(event: NoiseEvent): void {
    this.last = event;
    this.onNoise?.(event);
  }

  /** The most recent noise event, or null if none yet. */
  lastNoise(): NoiseEvent | null {
    return this.last;
  }

  /**
   * The last noise's loudness as perceived at `tMs`, exponentially decayed from
   * its emission. Returns 0 when there's no noise yet. Decay constant is
   * NOISE_DECAY_MS. A fresh noise is louder-now than a stale one of equal
   * emitted loudness.
   */
  loudnessAt(tMs: number): number {
    if (!this.last) return 0;
    const dt = Math.max(0, tMs - this.last.tMs);
    return this.last.loudness * Math.exp(-dt / NOISE_DECAY_MS);
  }
}
