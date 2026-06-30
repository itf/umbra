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
  // marble: pra marble_floor + acoustic_supplies "marble or glazed tile"; hardest reflector.
  marble: { absorption: [0.01, 0.01, 0.01, 0.01, 0.02, 0.02, 0.02, 0.02], scattering: scatterCurve(0.04) },

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
  // water: acoustic_supplies water surface (measured; refines former estimate). Near-perfect mirror.
  water: { absorption: [0.008, 0.008, 0.008, 0.013, 0.015, 0.020, 0.025, 0.025], scattering: scatterCurve(0.05) },

  // ===========================================================================
  // EXPANDED LIBRARY — researched, cited rows (see docs/product/materials-*).
  // Bands [63,125,250,500,1k,2k,4k,8k]; 63≈125 and 8k≈4k unless source measured.
  // ===========================================================================

  // --- Wood family ---
  // pra wood_1.6cm: panel resonance lifts 63-250 Hz. Warm, slightly bass-shy.
  wood_panel: { absorption: [0.18, 0.18, 0.12, 0.10, 0.09, 0.08, 0.07, 0.07], scattering: scatterCurve(0.1) },
  // pra plywood_thin: strong bass-trap (0.42@125) → boomy/drum-like. Distinct LF cue.
  plywood_thin: { absorption: [0.42, 0.42, 0.21, 0.10, 0.08, 0.06, 0.06, 0.06], scattering: scatterCurve(0.1) },
  // pra wooden_door: solid, fairly reflective, nearly flat.
  wooden_door: { absorption: [0.14, 0.14, 0.10, 0.06, 0.08, 0.10, 0.10, 0.10], scattering: scatterCurve(0.08) },

  // --- Metal ---
  // cssbi bare metal deck: very bright near-mirror, slight 125 Hz panel ring. Tinny.
  sheet_metal: { absorption: [0.13, 0.13, 0.09, 0.09, 0.09, 0.11, 0.11, 0.11], scattering: scatterCurve(0.05) },
  // commercial_acoustics perforated metal deck (75mm batts): kills lows-mids but
  // REFLECTS highs — inverted tilt vs carpet/foam. Unusual bright-but-dead cue.
  perforated_metal_absorber: { absorption: [0.73, 0.73, 0.99, 0.99, 0.89, 0.52, 0.31, 0.31], scattering: scatterCurve(0.1) },

  // --- Hard masonry-like ---
  // pra ceramic_tiles: acoustically indistinguishable from marble.
  ceramic_tile: { absorption: [0.01, 0.01, 0.01, 0.01, 0.02, 0.02, 0.02, 0.02], scattering: scatterCurve(0.05) },

  // --- Plaster / drywall family ---
  // acoustic_supplies plaster on masonry: hard, very slight HF absorption.
  plaster_smooth: { absorption: [0.01, 0.01, 0.02, 0.02, 0.03, 0.04, 0.05, 0.05], scattering: scatterCurve(0.04) },
  // acoustic_supplies plasterboard 12mm on studs: panel resonance eats bass. Hollow-wall.
  plasterboard: { absorption: [0.29, 0.29, 0.10, 0.06, 0.05, 0.04, 0.04, 0.04], scattering: scatterCurve(0.04) },
  // pra gypsum_board (perforated, mineral-fibre backing): broadband, mid-heavy dead.
  gypsum_acoustic_perforated: { absorption: [0.30, 0.30, 0.69, 1.0, 0.81, 0.66, 0.62, 0.62], scattering: scatterCurve(0.1) },
  // pra acoustical_plaster_25mm: looks hard but is broadband-absorptive. Deceptive.
  acoustical_plaster: { absorption: [0.17, 0.17, 0.36, 0.66, 0.65, 0.62, 0.68, 0.68], scattering: scatterCurve(0.06) },

  // --- Fabrics / soft absorbers ---
  // acoustic_supplies drapery 18oz pleated 50%: high scatter (folds) + mid/HF kill. Fuzzy.
  drapes_heavy: { absorption: [0.14, 0.14, 0.35, 0.53, 0.75, 0.70, 0.60, 0.60], scattering: scatterCurve(0.4) },
  // pra curtains_velvet: lighter absorber than drapes_heavy; passes more bass.
  curtains_velvet: { absorption: [0.05, 0.05, 0.12, 0.35, 0.45, 0.38, 0.36, 0.36], scattering: scatterCurve(0.4) },
  // pra panel_fabric_covered_6pcf: near-total broadband kill — the "deadest" surface.
  panel_fabric_rockwool: { absorption: [0.46, 0.46, 0.93, 1.0, 1.0, 1.0, 1.0, 1.0], scattering: scatterCurve(0.2) },
  // acoustic_supplies fiberglass board 50mm: like foam but passes more bass.
  fiberglass_board: { absorption: [0.18, 0.18, 0.76, 0.99, 0.99, 0.99, 0.99, 0.99], scattering: scatterCurve(0.15) },

  // --- Rooms full of people / ceilings ---
  // pra audience_2_m2: highly absorptive + highly diffuse (people as rough surface).
  audience_seated: { absorption: [0.26, 0.26, 0.46, 0.87, 0.99, 0.99, 0.99, 0.99], scattering: scatterCurve(0.6) },
  // pra ceiling_fissured_tile: suspended ceiling, rising-with-freq absorption. Office cue.
  ceiling_tile_fissured: { absorption: [0.49, 0.49, 0.53, 0.53, 0.75, 0.92, 0.99, 0.99], scattering: scatterCurve(0.15) },

  // --- Outdoor (flagged estimates — see materials-research.md) ---
  // snow lit. (estimated — see materials-research.md): porous absorber, "silent after snowfall".
  snow_fresh: { absorption: [0.15, 0.15, 0.25, 0.40, 0.65, 0.85, 0.90, 0.90], scattering: scatterCurve(0.4) },
  // iso9613 analogy (estimated — see materials-research.md): leafy hedges, very high scatter.
  vegetation_dense: { absorption: [0.10, 0.10, 0.20, 0.40, 0.60, 0.70, 0.75, 0.75], scattering: scatterCurve(0.5) },
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
