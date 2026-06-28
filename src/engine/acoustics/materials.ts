/**
 * Per-material frequency-dependent absorption coefficients.
 *
 * Eight octave-ish bands matching the Rust core's NUM_BANDS, centered roughly at:
 *   [63, 125, 250, 500, 1k, 2k, 4k, 8k] Hz
 *
 * Values are "fraction of energy absorbed" per reflection (0 = perfectly
 * reflective, 1 = fully dead). Numbers are representative architectural-acoustics
 * figures — close enough to sound right and to make materials distinguishable by
 * ear, which is what the echolocation trainer needs.
 */
export const BANDS_HZ = [63, 125, 250, 500, 1000, 2000, 4000, 8000] as const;
export const NUM_BANDS = BANDS_HZ.length;

export type Absorption = readonly number[]; // length NUM_BANDS

export const MATERIALS: Record<string, Absorption> = {
  // Hard, bright reflectors — strong, sharp echoes.
  concrete: [0.01, 0.01, 0.02, 0.02, 0.02, 0.03, 0.04, 0.05],
  glass: [0.18, 0.06, 0.04, 0.03, 0.02, 0.02, 0.02, 0.02],
  tile: [0.01, 0.01, 0.01, 0.02, 0.02, 0.02, 0.03, 0.04],
  // Wood — warm, moderate.
  wood: [0.15, 0.11, 0.1, 0.07, 0.06, 0.07, 0.07, 0.08],
  // Soft absorbers — dull, short echoes (kills highs).
  carpet: [0.02, 0.04, 0.08, 0.2, 0.35, 0.45, 0.55, 0.6],
  curtain: [0.05, 0.12, 0.25, 0.4, 0.5, 0.6, 0.7, 0.75],
  acoustic_foam: [0.1, 0.25, 0.55, 0.8, 0.9, 0.95, 0.95, 0.95],
};

export type WallName = '-x' | '+x' | '-y' | '+y' | '-z' | '+z';
export const WALL_ORDER: WallName[] = ['-x', '+x', '-y', '+y', '-z', '+z'];

export type ShoeboxMaterialMap = Partial<Record<WallName, keyof typeof MATERIALS>>;

/**
 * Flatten a per-wall material assignment into the 6*NUM_BANDS array the WASM
 * core expects (wall-major, in WALL_ORDER). Unassigned walls default to concrete.
 */
export function packAbsorption(map: ShoeboxMaterialMap): Float32Array {
  const out = new Float32Array(6 * NUM_BANDS);
  WALL_ORDER.forEach((wall, w) => {
    const mat = MATERIALS[map[wall] ?? 'concrete'];
    for (let b = 0; b < NUM_BANDS; b++) out[w * NUM_BANDS + b] = mat[b];
  });
  return out;
}
