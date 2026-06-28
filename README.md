# Papa Sangre–style Audio Navigator (PWA)

An audio-only navigation game and echolocation trainer, played by sound through
headphones. Walk to a beacon using binaural spatial audio; estimate room size and
materials from echoes. Built as an offline-capable PWA.

## Docs

- [`docs/PRODUCT.md`](docs/PRODUCT.md) — what it is, who it's for, the product story.
- [`docs/TECHNICAL.md`](docs/TECHNICAL.md) — architecture, subsystems, testing, perf.
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — future tasks and known limitations.

## Tech

- **Custom HRTF binaural rendering** from the SADIE II dataset (no `PannerNode`).
- **Rust → WASM acoustics core**: image-source early reflections (shoebox + general
  convex-polygon geometry), per-band material absorption, and first-order edge
  diffraction for doorways/corners.
- **Papa Sangre step controls**: alternate left/right footprints to walk; rushing
  trips you; a half-dial compass to turn.
- **Level editor**: top-down grid editor for walls, floors, beacons, start, and
  monsters (place-only), with JSON export/import and IndexedDB storage.

## Pages

- `/` — the game (`?level=current` loads the level designed in the editor)
- `/editor.html` — the level editor
- `/debug.html` — listenable acoustic scenes + a measurement explorer

## Setup

```sh
npm install
npm run wasm        # build the Rust acoustics core → src/engine/acoustics/wasm/
npm run dev         # Vite dev server
```

The generated WASM (`src/engine/acoustics/wasm/`) is git-ignored — run `npm run wasm`
after cloning. The baked HRTF binary (`assets/hrtf/sadie_h3.hrtf`) **is** committed.
To regenerate it from the original SOFA file:

```sh
# download a SADIE II subject SOFA from https://zenodo.org/records/10886409
node scripts/bake-hrtf.mjs assets/hrtf/<subject>.sofa assets/hrtf/sadie_h3.hrtf
```

## Tests

```sh
npm test                       # vitest (JS): HRTF, room IR, scenes, player, heading
cd acoustics-core && cargo test  # Rust: image-source, geometry, diffraction
```

## Credits

HRTF data: SADIE II Database, University of York (Apache-2.0),
<https://www.york.ac.uk/sadie-project/database.html>.
