# Material Acoustics Research — Expanded Absorption Library

Goal: expand `src/engine/acoustics/materials.ts` with a richer, realistic palette using
**authoritative, openly-usable** absorption data, mapped onto our 8 octave bands
`[63, 125, 250, 500, 1000, 2000, 4000, 8000] Hz`, each with a scattering estimate.

The ready-to-merge data lives in [`materials-proposed.json`](./materials-proposed.json),
shaped to match `MaterialProps` (an `absorption` array + a `scattering` array; the JSON
also records `scattering_mid`, the single value you feed to `scatterCurve()` in
`materials.ts`).

**Do not** edit `materials.ts` from this doc — these are proposals for review.

---

## Sources (all openly accessible)

| Tag | Source | What it gives |
|---|---|---|
| **pra** | [pyroomacoustics materials DB (LCAV)](https://github.com/LCAV/pyroomacoustics/blob/master/pyroomacoustics/data/materials.json) | Open material library, 7-band `[125..8000]`, itself compiled from standard architectural-acoustics tables. Most authoritative open dataset for this task. |
| **acoustic_supplies** | [acoustic-supplies.com absorption chart](https://www.acoustic-supplies.com/absorption-coefficient-chart/) | ASTM C423 compilation, 6-band `[125..4000]`. Already cited by `materials.ts`. |
| **commercial_acoustics** | [commercial-acoustics.com chart](https://commercial-acoustics.com/sound-advice/sound-absorption-coefficient-chart/) | ASTM C423 treatments incl. perforated metal deck. |
| **cssbi** | [CSSBI Facts 16-18 (PDF)](https://www.agwaymetals.com/wp-content/uploads/2020/04/CSSBI-Facts16-18.pdf) | Bare/perforated steel deck field data. |
| **snow** | [In-situ acoustics of deep snow, J. Sound & Vib. 1991](https://www.sciencedirect.com/science/article/abs/pii/0003682X9190018A) (+ snow-microstructure work) | Qualitative α-vs-frequency for fresh snow → fitted estimate. |
| **iso9613** | ISO 9613-2 ground classes (porous vs hard) | Outdoor-surface analogy, as already used for grass/gravel in `materials.ts`. |

---

## Band-mapping method (6/7-band → our 8 bands)

Standard ISO 354 / ASTM C423 tables stop at 125 Hz low and usually 4 kHz high. We follow
the **existing convention documented at the top of `materials.ts`**:

- **63 Hz** = copy of the 125 Hz value (no measured data exists below 125 Hz in these tables;
  extrapolating a porous trend downward would be guesswork, and most materials are flat-ish there).
- **8 kHz** = copy of the 4 kHz value — **unless** the source is a pyroomacoustics 7-band
  entry that already measured 8 kHz, in which case the real value is used.
- Where a source omits an intermediate band, none was interpolated — every interior band in
  the proposals is a measured value (no fabricated mid-bands).

**Scattering**: there is no authoritative per-material scattering table (Cox & D'Antonio note
this gap, as the file's header already says). We assign a single mid-band value anchored to
established facts (smooth flat ≈ 0.05; ISO 17497-1 rough hard ≈ 0.3–0.5; audiences > 0.5;
rises with frequency), then expand via the file's `scatterCurve()`.

---

## Proposed materials

Absorption shown at the 6 standard bands `125/250/500/1k/2k/4k` (the 63 Hz and 8 kHz
extrapolations are in the JSON). "Est." = estimated, see notes.

| Material | 125 | 250 | 500 | 1k | 2k | 4k | Scatter (mid) | Source |
|---|---|---|---|---|---|---|---|---|
| wood_panel | 0.18 | 0.12 | 0.10 | 0.09 | 0.08 | 0.07 | 0.10 | pra |
| plywood_thin | 0.42 | 0.21 | 0.10 | 0.08 | 0.06 | 0.06 | 0.10 | pra |
| wooden_door | 0.14 | 0.10 | 0.06 | 0.08 | 0.10 | 0.10 | 0.08 | pra |
| sheet_metal | 0.13 | 0.09 | 0.09 | 0.09 | 0.11 | 0.11 | 0.05 | cssbi |
| perforated_metal_absorber | 0.73 | 0.99 | 0.99 | 0.89 | 0.52 | 0.31 | 0.10 | commercial_acoustics |
| water | 0.008 | 0.008 | 0.013 | 0.015 | 0.020 | 0.025 | 0.05 | acoustic_supplies |
| marble | 0.01 | 0.01 | 0.01 | 0.01 | 0.02 | 0.02 | 0.04 | pra / acoustic_supplies |
| ceramic_tile | 0.01 | 0.01 | 0.01 | 0.02 | 0.02 | 0.02 | 0.05 | pra |
| plaster_smooth | 0.01 | 0.02 | 0.02 | 0.03 | 0.04 | 0.05 | 0.04 | acoustic_supplies |
| plasterboard | 0.29 | 0.10 | 0.06 | 0.05 | 0.04 | 0.04 | 0.04 | acoustic_supplies |
| gypsum_acoustic_perforated | 0.30 | 0.69 | 1.00 | 0.81 | 0.66 | 0.62 | 0.10 | pra |
| acoustical_plaster | 0.17 | 0.36 | 0.66 | 0.65 | 0.62 | 0.68 | 0.06 | pra |
| drapes_heavy | 0.14 | 0.35 | 0.53 | 0.75 | 0.70 | 0.60 | 0.40 | acoustic_supplies |
| curtains_velvet | 0.05 | 0.12 | 0.35 | 0.45 | 0.38 | 0.36 | 0.40 | pra |
| panel_fabric_rockwool | 0.46 | 0.93 | 1.00 | 1.00 | 1.00 | 1.00 | 0.20 | pra |
| fiberglass_board | 0.18 | 0.76 | 0.99 | 0.99 | 0.99 | 0.99 | 0.15 | acoustic_supplies |
| audience_seated | 0.26 | 0.46 | 0.87 | 0.99 | 0.99 | 0.99 | 0.60 | pra |
| ceiling_tile_fissured | 0.49 | 0.53 | 0.53 | 0.75 | 0.92 | 0.99 | 0.15 | pra |
| snow_fresh (Est.) | 0.15 | 0.25 | 0.40 | 0.65 | 0.85 | 0.90 | 0.40 | snow lit. |
| vegetation_dense (Est.) | 0.10 | 0.20 | 0.40 | 0.60 | 0.70 | 0.75 | 0.50 | iso9613 analogy |

Two estimates are flagged and justified:

- **snow_fresh** — no ISO 354 row exists. Fitted to the literature finding that fresh,
  high-porosity snow has α < 0.4 below 1 kHz, rising to ~0.85–0.9 above 1 kHz. Shaped like a
  porous outdoor absorber. Anchored qualitatively, not measured.
- **vegetation_dense** — anchored to the existing `grass` row in `materials.ts`
  `[0.1,0.2,0.35,0.5,0.6,0.65]`, with mid/HF absorption raised and scatter pushed to 0.5 to
  represent leafy hedges/foliage (rough, granular). Estimate, not a single measurement.

`gravel`, `asphalt`, `grass` already exist in `materials.ts` and were not duplicated.

---

## Echolocation distinctness — which materials sound CLEARLY different

For the trainer's material-ID exercise, what matters is the **spectral tilt** of the echo
(does it keep highs or kill them?), the **overall echo strength** (bright vs dead), and the
**diffuseness** (crisp vs smeared by scattering). Three perceptual axes:

1. **Brightness / strength** — total reflected energy.
2. **Spectral tilt** — HF-preserving (metallic, glassy) vs HF-killing (carpet, foam) vs the
   rarer LF-killing tilt (panel resonators, perforated absorbers).
3. **Diffuseness** — low-scatter sharp slap vs high-scatter smeared wash.

### Easy-to-learn, clearly distinct anchors (use these as the "obvious" palette)

| Class | Material | Why it stands out |
|---|---|---|
| Mirror-bright, sharp | **marble / ceramic_tile / water** | Near-zero absorption, low scatter → crisp loud slap. The reference "hard" sound. |
| Bright + metallic ring | **sheet_metal** | Flat bright like tile but with a 125 Hz panel ring; lowest scatter → "tinny." |
| Dead + diffuse | **panel_fabric_rockwool** | Near-total broadband kill → almost no echo. Reference "dead." |
| HF-killed, dull | **carpet (existing) / fiberglass_board** | Strong rising HF absorption → muffled, no sparkle. |
| Soft + smeared | **drapes_heavy** | High scatter (folds) + mid/HF absorption → fuzzy, spread reflection, no slap. |
| Inverted tilt (rare cue) | **perforated_metal_absorber** | Kills low-mids but REFLECTS highs — opposite of carpet. A genuinely unusual, learnable timbre. |
| Bass-eater | **plywood_thin / plasterboard** | α≈0.3–0.42 @125 Hz only → boomy/hollow loss of bass, bright elsewhere. |

### Hard-to-tell-apart pairs (avoid pairing in the same drill, or use as "expert" level)

- **marble ≈ ceramic_tile ≈ water ≈ glass(existing)** — all are flat, near-zero-absorption
  specular mirrors. By ear, essentially identical; they differ only in scattering if the tile
  has grout/relief. Pick ONE as the canonical bright surface.
- **plaster_smooth ≈ wooden_door ≈ painted brick/concrete (existing)** — all hard, nearly
  flat, mild HF absorption. Differences are within measurement noise perceptually.
- **acoustic_foam (existing) ≈ panel_fabric_rockwool ≈ fiberglass_board** — all broadband
  near-total absorbers; distinguishable only at low frequency (fiberglass and rockwool pass
  more bass than foam). A subtle, expert-level discrimination.
- **curtains_velvet ≈ curtain (existing)** — same family, velvet just passes a bit more bass.
- **snow_fresh ≈ grass/vegetation (existing/proposed)** — all porous outdoor absorbers with a
  similar rising tilt; snow is more aggressive above 1 kHz but the family timbre is shared.

### Recommended "material-ID" starter set (maximally separable)

`marble` (bright/sharp), `sheet_metal` (bright/ringing), `plywood_thin` (bass-eater),
`carpet` (HF-killed), `drapes_heavy` (soft/diffuse), `perforated_metal_absorber`
(inverted tilt), `panel_fabric_rockwool` (dead). These seven occupy distinct corners of the
brightness × tilt × diffuseness space and should be reliably learnable.

---

## Merge notes

- `materials.ts` generates `scattering` from a single mid value via `scatterCurve(sMid)`.
  When merging, call `scatterCurve(scattering_mid)` rather than copying the expanded
  `scattering` array verbatim, to stay consistent with the existing entries.
- `water` and `marble` here refine/confirm rows that already exist — reconcile rather than
  duplicate. `water` in particular replaces the current pure-estimate with the
  acoustic-supplies measured row.
- All keys use the existing snake_case convention.
