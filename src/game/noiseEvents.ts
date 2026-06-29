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
 * gain), mapped across the observed range of material step levels so the quietest
 * material (acoustic_foam) → ~0 and the loudest hard floor → high. Stumbles and
 * bumps are large FIXED spikes regardless of floor (you trip loudly on carpet
 * too). See docs/engine/noise-events.md.
 */
import { STEP_SOUNDS, soundsFor } from './stepSounds';

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
// We map a material's step `level` linearly across the min/max of ALL material
// step levels in STEP_SOUNDS, so the table stays in sync if presets change.
const STEP_LEVELS = Object.values(STEP_SOUNDS).map((m) => m.step.level);
const STEP_LEVEL_MIN = Math.min(...STEP_LEVELS);
const STEP_LEVEL_MAX = Math.max(...STEP_LEVELS);

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
 * Soft floors (carpet/foam) → near 0; loud floors (gravel/concrete) → near the
 * top. Falls back to concrete for unknown materials (matching soundsFor).
 */
export function stepLoudnessForMaterial(material: string): number {
  const level = soundsFor(material).step.level;
  // Degenerate single-level table: can't normalize, so report max loudness rather
  // than leaking a raw (possibly >1) level. Shouldn't happen with the real table.
  if (STEP_LEVEL_MAX <= STEP_LEVEL_MIN) return 1;
  const t = (level - STEP_LEVEL_MIN) / (STEP_LEVEL_MAX - STEP_LEVEL_MIN);
  return Math.max(0, Math.min(1, t));
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
