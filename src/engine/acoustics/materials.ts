/**
 * Per-material acoustic properties: frequency-dependent ABSORPTION and SCATTERING.
 *
 * Eight octave bands centered at [63, 125, 250, 500, 1k, 2k, 4k, 8k] Hz.
 *
 * ABSORPTION = fraction of energy swallowed per reflection (0 = perfect mirror,
 * 1 = fully dead). Most values below are real ISO 354 / published laboratory
 * measurements (125–4000 Hz) compiled from acoustic-engineering tables; the 63 Hz
 * and 8 kHz bands are EXTRAPOLATED (63 Hz ≈ 125 Hz value; 8 kHz holds the 4 kHz
 * value), since standard tables stop at those bands.
 *   Sources: akustik.ua "Web Absorption Data" (ISO 354 compilation);
 *   acoustic-supplies.com (ASTM C423). Outdoor surfaces (asphalt/grass/gravel/
 *   water) are ESTIMATES by analogy to ISO 9613-2 ground classes.
 *
 * SCATTERING = fraction of the reflected energy that leaves DIFFUSELY (random
 * directions) rather than specularly. This is what makes a rough BRICK wall sound
 * like a soft, spread-out reflection instead of a crisp echo. There is no
 * authoritative per-material/per-band scattering table in the literature (Cox &
 * D'Antonio note this gap); these are engineering estimates anchored to the
 * established facts: smooth flat surfaces ≈ 0.05, ISO 17497-1 measured rough hard
 * surfaces (brick, exposed aggregate) ≈ 0.3–0.5, audiences > 0.5, and scattering
 * RISES with frequency (ODEON practice). We therefore store a per-band curve that
 * grows toward the high end.
 */
export const BANDS_HZ = [63, 125, 250, 500, 1000, 2000, 4000, 8000] as const;
export const NUM_BANDS = BANDS_HZ.length;

export type BandArray = readonly number[]; // length NUM_BANDS
export type Absorption = BandArray; // kept for back-compat

export interface MaterialProps {
  absorption: BandArray;
  scattering: BandArray;
}

/** Build a rising scattering curve from a mid-band (≈500–1k Hz) value `s`. */
function scatterCurve(sMid: number): number[] {
  // Low bands scatter less, high bands more (≈2× by 4–8 kHz), clamped to [0,1].
  const shape = [0.5, 0.6, 0.75, 0.9, 1.0, 1.3, 1.7, 1.9];
  return shape.map((k) => Math.max(0, Math.min(1, sMid * k)));
}

export const MATERIALS_FULL: Record<string, MaterialProps> = {
  // --- Hard, bright reflectors (smooth) — strong, sharp echoes, low scatter ---
  concrete: { absorption: [0.01, 0.01, 0.02, 0.02, 0.02, 0.03, 0.05, 0.05], scattering: scatterCurve(0.05) },
  tile: { absorption: [0.01, 0.01, 0.01, 0.01, 0.02, 0.02, 0.02, 0.02], scattering: scatterCurve(0.05) },
  glass: { absorption: [0.18, 0.18, 0.06, 0.04, 0.03, 0.02, 0.02, 0.02], scattering: scatterCurve(0.05) },
  marble: { absorption: [0.01, 0.01, 0.01, 0.01, 0.01, 0.02, 0.02, 0.02], scattering: scatterCurve(0.05) },

  // --- Brick: standard unglazed/rough. Real ISO 17497-1 scattering ~0.3–0.5. ---
  brick: { absorption: [0.05, 0.05, 0.04, 0.02, 0.04, 0.05, 0.05, 0.05], scattering: scatterCurve(0.4) },
  brick_painted: { absorption: [0.01, 0.01, 0.01, 0.02, 0.02, 0.02, 0.02, 0.02], scattering: scatterCurve(0.1) },

  plaster: { absorption: [0.02, 0.02, 0.02, 0.03, 0.04, 0.05, 0.05, 0.05], scattering: scatterCurve(0.05) },

  // --- Wood — warm, moderate ---
  wood: { absorption: [0.15, 0.15, 0.2, 0.1, 0.1, 0.1, 0.1, 0.1], scattering: scatterCurve(0.1) },
  parquet: { absorption: [0.04, 0.04, 0.04, 0.07, 0.06, 0.06, 0.07, 0.07], scattering: scatterCurve(0.1) },

  // --- Soft absorbers — dull, short echoes (kill highs) ---
  carpet: { absorption: [0.08, 0.08, 0.08, 0.3, 0.6, 0.75, 0.8, 0.8], scattering: scatterCurve(0.15) },
  curtain: { absorption: [0.05, 0.05, 0.15, 0.35, 0.4, 0.5, 0.5, 0.5], scattering: scatterCurve(0.4) },
  acoustic_foam: { absorption: [0.12, 0.18, 0.56, 0.96, 1.0, 1.0, 1.0, 1.0], scattering: scatterCurve(0.2) },

  // --- Rough stone / rubble ---
  rough_stone: { absorption: [0.02, 0.02, 0.03, 0.04, 0.05, 0.07, 0.08, 0.08], scattering: scatterCurve(0.35) },

  // --- Outdoor / street (ESTIMATES; ISO 9613-2 ground analogy) ---
  asphalt: { absorption: [0.02, 0.02, 0.02, 0.03, 0.03, 0.03, 0.04, 0.04], scattering: scatterCurve(0.07) },
  gravel: { absorption: [0.05, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.5], scattering: scatterCurve(0.5) },
  grass: { absorption: [0.1, 0.1, 0.2, 0.35, 0.5, 0.6, 0.65, 0.65], scattering: scatterCurve(0.3) },
  water: { absorption: [0.01, 0.01, 0.01, 0.01, 0.01, 0.02, 0.02, 0.02], scattering: scatterCurve(0.05) },
};

/** Back-compat: absorption-only view, as the old code expected. */
export const MATERIALS: Record<string, Absorption> = Object.fromEntries(
  Object.entries(MATERIALS_FULL).map(([k, v]) => [k, v.absorption]),
);

export function scatteringFor(name: string): BandArray {
  return (MATERIALS_FULL[name] ?? MATERIALS_FULL.concrete).scattering;
}

export function absorptionFor(name: string): BandArray {
  return (MATERIALS_FULL[name] ?? MATERIALS_FULL.concrete).absorption;
}

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
