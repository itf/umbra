/**
 * Per-material footstep + collision sound presets.
 *
 * Hybrid model: each material has a SYNTH preset (parameters for the procedural
 * footstep generator — zero assets, fully offline) and an optional `sample` URL.
 * If a sample is provided and loaded, it's used; otherwise we synthesize. This
 * lets us ship sound-free now and drop in recordings later without code changes.
 */
import type { MaterialName } from '../level/schema';

/** Parameters the procedural generator (footsteps.ts `play`) understands. */
export interface StepSynth {
  level: number;
  thumpHz: number;
  thumpLevel: number;
  noiseDur: number;
  thumpDur: number;
  lp: number; // lowpass cutoff (Hz)
  band?: boolean;
  /** crunch: extra grainy noise bursts (gravel/grass). */
  crunch?: number;
}

export interface MaterialSounds {
  step: StepSynth;
  /** Collision/bump preset (heavier, material-colored). */
  bump: StepSynth;
  /** Optional recorded samples (URLs) — used if present. */
  stepSample?: string;
  bumpSample?: string;
}

/**
 * Defaults tuned to read distinctly by ear:
 *  - hard/bright (concrete, tile, asphalt): sharp slap, higher cutoff
 *  - wood: hollow knock, mid thump
 *  - soft (carpet, grass): muffled pad, low cutoff, quiet
 *  - granular (gravel): crunchy, multiple grains
 *  - water: splashy band-passed
 */
const HARD: MaterialSounds = {
  step: { level: 0.55, thumpHz: 150, thumpLevel: 0.4, noiseDur: 0.04, thumpDur: 0.08, lp: 2600 },
  bump: { level: 0.8, thumpHz: 95, thumpLevel: 0.8, noiseDur: 0.12, thumpDur: 0.18, lp: 1400 },
};

export const STEP_SOUNDS: Record<string, MaterialSounds> = {
  concrete: HARD,
  tile: { ...HARD, step: { ...HARD.step, lp: 3000, thumpHz: 170 } },
  asphalt: { ...HARD, step: { ...HARD.step, lp: 2200, thumpHz: 130 } },
  glass: { ...HARD, step: { ...HARD.step, lp: 3400, level: 0.45 }, bump: { ...HARD.bump, lp: 2600, thumpHz: 140 } },
  rough_stone: { ...HARD, step: { ...HARD.step, lp: 2000, crunch: 0.3 } },

  wood: {
    step: { level: 0.55, thumpHz: 110, thumpLevel: 0.6, noiseDur: 0.05, thumpDur: 0.13, lp: 1600 },
    bump: { level: 0.75, thumpHz: 80, thumpLevel: 0.85, noiseDur: 0.1, thumpDur: 0.2, lp: 900 },
  },

  carpet: {
    step: { level: 0.32, thumpHz: 120, thumpLevel: 0.3, noiseDur: 0.06, thumpDur: 0.07, lp: 800 },
    bump: { level: 0.45, thumpHz: 70, thumpLevel: 0.5, noiseDur: 0.12, thumpDur: 0.16, lp: 600 },
  },
  curtain: {
    step: { level: 0.3, thumpHz: 130, thumpLevel: 0.25, noiseDur: 0.06, thumpDur: 0.06, lp: 1000, band: true },
    bump: { level: 0.4, thumpHz: 90, thumpLevel: 0.4, noiseDur: 0.14, thumpDur: 0.14, lp: 700 },
  },
  acoustic_foam: {
    step: { level: 0.28, thumpHz: 110, thumpLevel: 0.22, noiseDur: 0.05, thumpDur: 0.06, lp: 700 },
    bump: { level: 0.35, thumpHz: 70, thumpLevel: 0.35, noiseDur: 0.12, thumpDur: 0.14, lp: 550 },
  },

  grass: {
    step: { level: 0.4, thumpHz: 100, thumpLevel: 0.2, noiseDur: 0.08, thumpDur: 0.06, lp: 1200, crunch: 0.5 },
    bump: { level: 0.45, thumpHz: 80, thumpLevel: 0.3, noiseDur: 0.12, thumpDur: 0.12, lp: 900, crunch: 0.4 },
  },
  gravel: {
    step: { level: 0.5, thumpHz: 120, thumpLevel: 0.25, noiseDur: 0.09, thumpDur: 0.07, lp: 2400, crunch: 0.9 },
    bump: { level: 0.6, thumpHz: 90, thumpLevel: 0.4, noiseDur: 0.14, thumpDur: 0.12, lp: 1800, crunch: 0.8 },
  },
  water: {
    step: { level: 0.45, thumpHz: 200, thumpLevel: 0.3, noiseDur: 0.12, thumpDur: 0.1, lp: 1600, band: true, crunch: 0.3 },
    bump: { level: 0.5, thumpHz: 140, thumpLevel: 0.4, noiseDur: 0.16, thumpDur: 0.14, lp: 1200, band: true },
  },
};

/** Look up sounds for a material, falling back to concrete. */
export function soundsFor(material: MaterialName | string): MaterialSounds {
  return STEP_SOUNDS[material] ?? STEP_SOUNDS.concrete;
}
