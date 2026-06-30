/**
 * The acoustic material library is data the whole engine trusts: a malformed
 * absorption row (wrong length, value outside [0,1]) would corrupt the WASM
 * packing and every reflection. These tests assert structural validity across
 * ALL materials and specifically check that the newly-added researched rows are
 * present, well-formed, and (for the reconciled keys) carry their updated values.
 */
import { describe, it, expect } from 'vitest';
import { MATERIALS, MATERIALS_FULL, NUM_BANDS } from '../src/engine/acoustics/materials';

const NEW_MATERIALS = [
  'wood_panel', 'plywood_thin', 'wooden_door', 'sheet_metal',
  'perforated_metal_absorber', 'ceramic_tile', 'plaster_smooth', 'plasterboard',
  'gypsum_acoustic_perforated', 'acoustical_plaster', 'drapes_heavy',
  'curtains_velvet', 'panel_fabric_rockwool', 'fiberglass_board',
  'audience_seated', 'ceiling_tile_fissured', 'snow_fresh', 'vegetation_dense',
] as const;

describe('materials: structural validity', () => {
  it('every material has an 8-band absorption in [0,1]', () => {
    for (const [name, props] of Object.entries(MATERIALS_FULL)) {
      expect(props.absorption, name).toHaveLength(NUM_BANDS);
      for (const a of props.absorption) {
        expect(a, name).toBeGreaterThanOrEqual(0);
        expect(a, name).toBeLessThanOrEqual(1);
      }
      // Scattering must also be a valid 8-band [0,1] curve.
      expect(props.scattering, name).toHaveLength(NUM_BANDS);
      for (const s of props.scattering) {
        expect(s, name).toBeGreaterThanOrEqual(0);
        expect(s, name).toBeLessThanOrEqual(1);
      }
    }
  });

  it('MATERIALS (absorption-only view) mirrors MATERIALS_FULL', () => {
    for (const [name, props] of Object.entries(MATERIALS_FULL)) {
      expect(MATERIALS[name]).toEqual(props.absorption);
    }
  });
});

describe('materials: expanded library', () => {
  it('all newly-researched materials are present and exported', () => {
    for (const name of NEW_MATERIALS) {
      expect(MATERIALS, name).toHaveProperty(name);
      expect(MATERIALS[name]).toHaveLength(NUM_BANDS);
    }
  });

  it('water/marble were reconciled to the measured/cited values (not duplicated)', () => {
    // Exactly one key each — no duplicate.
    expect(Object.keys(MATERIALS).filter((k) => k === 'water')).toHaveLength(1);
    expect(Object.keys(MATERIALS).filter((k) => k === 'marble')).toHaveLength(1);
    // water now uses the acoustic-supplies measured row (0.008 at low bands).
    expect(MATERIALS.water[0]).toBeCloseTo(0.008, 6);
    expect(MATERIALS.water[NUM_BANDS - 1]).toBeCloseTo(0.025, 6);
    // marble updated to the better-cited row (0.02 at HF).
    expect(MATERIALS.marble[NUM_BANDS - 1]).toBeCloseTo(0.02, 6);
  });

  it('perforated_metal_absorber has the inverted tilt (kills mids, reflects highs)', () => {
    const a = MATERIALS.perforated_metal_absorber;
    // Low-mid absorption is high; high-frequency absorption is much lower.
    expect(a[2]).toBeGreaterThan(0.8); // 250 Hz strongly absorbed
    expect(a[NUM_BANDS - 1]).toBeLessThan(a[2]); // 8 kHz far less absorbed → reflects highs
  });
});
