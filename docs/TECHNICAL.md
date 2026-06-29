# Technical Documentation

A reference for engineers and agents working on this codebase. It explains the
architecture, every subsystem, the data flow, what is tested and how, the known
limitations, and where to extend things.

> For setup/build commands see the root `README.md`. For the product story see
> `docs/PRODUCT.md`.

---

## 1. What this is

An audio-only navigation game + echolocation trainer, played by sound through
headphones. The player walks toward a beacon using binaural spatial audio; rooms
have real geometry and materials so echoes encode size, shape, and surfaces. It
ships as an offline-capable PWA with three pages: the **game**, a **level
editor**, and a **debug** page.

The defining technical constraint: **there is no off-the-shelf browser engine for
this.** The W3C deliberately scoped geometry/reflections/diffraction out of Web
Audio (you only get `PannerNode` + `ConvolverNode`). So the acoustics layer is
built from scratch in Rust→WASM, informed by published algorithms (Steam Audio's
UTD diffraction, pyroomacoustics' image-source, EVERTims' architecture) rather
than depending on any of them.

---

## 2. Repository layout

```
acoustics-core/          Rust crate → WASM (the acoustics math)
  src/vec3.rs            3D vector math (Web Audio coord convention)
  src/image_source.rs    Shoebox image-source reflections + materials
  src/geometry.rs        General convex-polygon-wall image-source
  src/diffraction.rs     First-order edge diffraction (doorways/corners)
  src/lib.rs             wasm-bindgen API (flat Float32 in/out)

src/
  engine/
    audioGraph.ts        AudioContext bootstrap + master bus
    hrtf/sofa.ts         Loader for the baked HRTF binary + nearest-dir lookup
    hrtf/renderer.ts     Per-source binaural rendering (dual-convolver crossfade)
    acoustics/core.ts    JS↔WASM wrapper (computeShoeboxTaps / computeRoomTaps)
    acoustics/materials.ts  Absorption + scattering tables
    acoustics/roomIr.ts  Taps → stereo room impulse response (+ scattering)
    acoustics/clapRoom.ts   "Clap to hear the room" via the general solver
    analysis/measure.ts  Sample-analysis utils (used by tests + debug page)
  game/
    player.ts            Step state machine (pure logic; heavily tested)
    heading.ts           Rate-limited heading slew
    game.ts              Orchestrates player + audio + collision + win
    footsteps.ts         Footstep/bump/stumble synthesis (per-material)
    stepSounds.ts        Per-material sound presets
    compass.ts           Half-dial drag compass (SVG)
    turnControl.ts       (legacy) drag-anywhere turn control — used by debug only
  level/
    schema.ts            Level data model (editor ↔ game)
    storage.ts           IndexedDB save/load + JSON import/export
    load.ts              Level → game geometry + acoustics walls
  editor/                Top-down level editor (canvas)
  debug/                 Listenable scenes + measurement explorer
  main.ts                Game page entry
assets/hrtf/sadie_h3.hrtf   Pre-baked HRTF binary (committed)
scripts/bake-hrtf.mjs       SOFA(HDF5) → compact binary (build-time)
tests/                      vitest suites
```

`index.html`, `editor.html`, `debug.html` are the three Vite multi-page entries.

---

## 3. The two-layer audio architecture

Everything rests on a deliberate separation:

1. **Acoustics simulation** — "what reaches the ears, when, how filtered." Given
   geometry + a source + a listener, produce a list of **taps**: each tap is a
   `{ delay, gain, direction, per-band gains, order }`. This is the Rust/WASM core.
2. **Binaural rendering** — "make it sound like it's there." Each tap (or live
   source) is convolved through the **HRIR** for *its* arrival direction and summed
   to stereo. This is the HRTF layer.

Keeping them separate means the same acoustics output drives both real-time
sources (the beacon) and the baked clap impulse response.

### Coordinate convention
World space is the x/z plane (top-down), y is height. Matches Web Audio's listener
space: **+x right, +y up, −z forward**. Heading `yaw` is radians, 0 faces −z,
positive turns right. The editor works purely in x/z.

---

## 4. The acoustics core (Rust → WASM)

### 4.1 Image-source method
The core technique for **early reflections**. A reflection off a wall is equivalent
to a straight line from the listener to a *mirror image* of the source reflected
across that wall's plane. Recursively mirroring up to `max_order` gives 1st, 2nd,
… order reflections. Each image → one tap (delay = path length / speed of sound;
direction = bearing to the image).

- **`image_source.rs`** — the *shoebox* (axis-aligned box) special case. Closed-form
  mirroring along each axis; every image is valid (a convex empty box needs no
  visibility test), so it's very cheap. Used for simple rooms and as the test oracle.
- **`geometry.rs`** — the *general* case: arbitrary convex-polygon walls. For each
  candidate wall chain it (a) builds the image, (b) reconstructs the reflection path
  by tracing listener→image and intersecting each wall, (c) validates every bounce
  lands inside its polygon and each segment is unobstructed (visibility test). This
  is the pyroomacoustics approach. Wall normals are auto-oriented toward the room
  centroid so callers don't have to get vertex winding right.

### 4.2 Materials
Each reflection is colored by the wall's **per-octave-band absorption** (8 bands:
63 Hz–8 kHz). `band_gains[b] *= (1 − absorption[b])` per bounce. Plus a crude
distance-dependent **air absorption** (high-frequency rolloff). See §6 for the data.

### 4.3 Diffraction (`diffraction.rs`)
Sound bending around an edge (doorway jamb, corner) so a source is heard even when
the direct path is blocked. **Geometry** is the games approximation
(golden-section search finds the shortest detour source→edge→listener, setting the
delay and 1/r gain). **Attenuation** is a true **UTD coefficient** — the
half-plane / knife-edge Kouyoumjian–Pathak asymptotic with the Fresnel-integral
transition function `|H(v)| = (1/√2)·sqrt((½−C(v))² + (½−S(v))²)`, where the
Fresnel parameter `v = sign·sqrt(2δ/λ)` depends on the excess path length `δ` and
frequency. This is **continuous across the shadow boundary** (`|H(0)| = 0.5`, no
jump — the key improvement over the old heuristic), gives the correct shadow-zone
attenuation, and rolls off HF more deeply in shadow for free (since `v ∝ sqrt(f)`).
Wedge assumption: knife-edge (half-plane); first-order only.

Diffracting **edges are auto-derived from level geometry** (`load.ts`,
`diffractionEdgesAt`): each interior wall's free ends (endpoints not on the
perimeter and not shared with another wall — i.e. doorway jambs and partial-wall
ends) emit a vertical `EdgeDef`. `loadLevel` returns them in `LoadedLevel.edges`;
the clap/room path passes them through. See `docs/engine/diffraction-utd.md`.

### 4.4 WASM API (`lib.rs`)
A **flat Float32 interface** — no object marshalling across the boundary.
- `compute_shoebox_taps(roomSize, absorption, listener, source, maxOrder)`
- `compute_room_taps(verts, wallSizes, wallAbsorption, edges, listener, source, maxOrder)`
- Returns a packed `Float32Array`, `TAP_STRIDE` floats per tap:
  `[delay, gain, dirx, diry, dirz, order, band0..band7]`.

The JS side (`core.ts`) unpacks this into `Tap[]`.

---

## 5. The HRTF binaural layer

### 5.1 Why custom HRTF (not PannerNode)
`PannerNode`'s HRTF uses a single fixed averaged dataset, has bad front/back
discrimination, and is anechoic (no room). We use **measured HRIRs** (Head-Related
Impulse Responses) we can swap/personalize.

### 5.2 Data pipeline
The **SADIE II** dataset (University of York, Apache-2.0) ships as SOFA files
(HDF5 under the hood). Parsing HDF5 in-browser is heavy, so `scripts/bake-hrtf.mjs`
**pre-bakes** it at build time (via `h5wasm` in Node) into a compact little-endian
binary: header + per-direction (azimuth, elevation) + interleaved L/R impulse
responses. The runtime loads this flat file — no HDF5 parser shipped. Current
asset: 2818 directions, 256-tap IRs, 48 kHz, ~5.5 MB (committed).

### 5.3 Loader (`sofa.ts`)
Parses the binary, converts SOFA spherical coordinates to listener-space unit
vectors, and provides `nearestDir()` — a linear scan picking the measured direction
with the max dot product to a query direction. (~2800 dirs × microseconds; an
index isn't worth the complexity yet.)

### 5.4 Renderer (`renderer.ts`)
`HrtfRenderer` holds the listener pose. Each positioned source is an `HrtfSource`:
`input → distanceGain → airLowpass → [two convolver chains] → output`.

**The dual-convolver crossfade** is the key subtlety. Swapping a `ConvolverNode`'s
`buffer` mid-signal produces an audible **click** (the in-flight IR tail jumps).
With a moving source the direction index changes constantly, so we keep two
convolver chains and **equal-power crossfade** between them on direction change:
load the new HRIR into the idle chain, ramp one gain up / the other down over
~40 ms. Swaps are also **rate-limited** — during a fast turn, if we're still inside
the previous fade window we just refresh the incoming chain's buffer rather than
starting a new fade (prevents gain thrashing, the "fart" artifact).

### 5.5 Room impulse response (`roomIr.ts`)
`buildRoomIr(taps, hrtf, opts)` collapses N taps into **one stereo IR**, so playing
a clap costs a single convolution instead of N filter chains. Per tap:
1. take the HRIR pair for the tap's (head-relative) direction,
2. color it by a short FIR matching the tap's 8-band gains (frequency-sampled,
   Hann-windowed),
3. scale by 1/r gain,
4. add at sample offset = round(delay × sampleRate).

**Scattering** (rough surfaces): a reflection keeps `(1−s)` of its energy as a
crisp specular tap and spreads `s` as a short **diffuse smear** — a few jittered,
decaying copies over ~20 ms. The direct path (order 0) is never scattered. `s` is a
representative scalar passed by the caller. This is what makes a brick wall sound
soft and spread-out instead of a sharp echo.

**Late reverb** (FDN tail): after the early field, an 8-line Feedback Delay Network
(mutually-prime delays, lossless Householder feedback, per-line HF damping, decorrelated
L/R taps) is rendered offline and **overlap-added onto the same stereo IR** — so the room
stays one `ConvolverNode` (clap + moving-walls crossfade unchanged). Its RT60 is an
**Eyring** estimate from room volume + surface area + mean absorption, and it is **seeded
by the early/scatter energy at the handover** so the late field starts where the early
reflections leave off (no gap/click). On by default when a `room`/`rt60` is supplied;
`tail: false` disables it. Full design: `docs/engine/late-reverb-fdn.md`.

---

## 6. Material data and provenance

`materials.ts` → `MATERIALS_FULL[name] = { absorption[8], scattering[8] }`.

- **Absorption**: real ISO 354 / ASTM C423 **lab measurements** for 125 Hz–4 kHz,
  compiled from published engineering tables (akustik.ua "Web Absorption Data",
  acoustic-supplies.com). The **63 Hz** and **8 kHz** bands are **extrapolated**
  (63 Hz ≈ 125 Hz value; 8 kHz holds the 4 kHz value) — standard tables stop there.
  Outdoor surfaces (asphalt, grass, gravel, water) are **estimates** by analogy to
  ISO 9613-2 ground classes — flagged in the code.
- **Scattering**: there is **no authoritative per-band scattering table** in the
  literature (Cox & D'Antonio note this gap). Values are engineering estimates
  anchored to the established facts: smooth flat ≈ 0.05; **rough brick 0.3–0.5
  (ISO 17497-1 measured)**; audiences > 0.5; scattering rises with frequency.
  Stored as `scatterCurve(midValue)` — a rising-with-frequency curve from a single
  mid-band value (the ODEON approach).

`MATERIALS` (absorption-only) is kept as a back-compat view. `scatteringFor(name)`
returns the scattering curve.

When improving this data: replace the estimated outdoor + all scattering values
with measured sources where available; the structure already supports per-band
scattering.

---

## 7. The game

### 7.1 Step state machine (`player.ts`) — pure logic, the most-tested module
Papa Sangre's signature mechanic. `Player.step(foot, nowMs)` returns a `StepOutcome`:
- **Strict alternation**: must alternate L,R,L,R. Same foot twice → `stumble`
  (`wrong-foot`).
- **Rush penalty**: stepping faster than `rushIntervalMs` (220 ms) → `stumble`
  (`too-fast`).
- **Stride scales with cadence**: brisk-but-legal rhythm → longer stride (up to
  `maxStride` 0.9 m); slow → shorter (down to `minStride` 0.35 m). There's a sweet
  spot — rhythmic walking is efficient, rushing trips you.
- **Settling**: after `settleIntervalMs` (1.4 s) idle, the feet come together; the
  next step may be **either foot** (alternation resets) and `settled: true` is
  flagged so the UI shows both feet and plays a soft "feet together" cue.
- A stumble freezes stepping for `stumbleFreezeMs` (600 ms).

The player is pure (no audio/DOM), so it is unit-tested exhaustively.

### 7.2 Game orchestration (`game.ts`)
Wires the player to audio. On each `step`:
- captures pre-position; runs `player.step`;
- **wall collision**: if the move crosses a wall (`segmentsIntersect`), undo the
  move and play a material-keyed **bump** + a `'wall'` stumble (you can't walk
  through walls);
- otherwise plays a footstep using the **floor material under the player**
  (`floorMaterialAt` → floor-zone lookup), updates the listener pose, checks win.
The beacon is an `HrtfSource` fed by a chosen synth **preset** (or a looped custom
audio file) — see `docs/engine/beacon-sounds.md`; win = within `goalRadius`.

### 7.3 Turning (`heading.ts` + `compass.ts`)
Turn input sets a **target** heading; `Heading` slews the actual heading toward it
at a capped **angular velocity** (~100°/s). This makes turning physically plausible
*and* bounds how fast the HRTF direction changes, which keeps the binaural render
smooth no matter how fast the user drags (the rate-limiting is the real fix for
spin artifacts; the dual-convolver crossfade is the second layer).

The **compass** is the only turn control: a half-dial (top ~120° arc) drag-to-rotate
SVG. Both the dial and the audio follow the *slewed* heading, so they move in
lockstep and catch up to the drag together; releasing stops the turn where it is.

### 7.4 Footsteps (`footsteps.ts` + `stepSounds.ts`)
Foot sounds are barely directional, so they are NOT run through the HRTF convolver
(it colored them oddly at close range) — they use a light `StereoPanner` + procedural
synthesis (noise transient + low thump; granular "crunch" grains for gravel/grass).
**Per-material presets** in `stepSounds.ts`. **Hybrid**: a recorded sample URL
(`stepSample`/`bumpSample`) is used if present (fetched + cached), else synth.

---

## 8. Levels and the editor

### 8.1 Schema (`schema.ts`)
`Level` = room dims + an `open` flag (no enclosing box → street/field) + `hasCeiling`
+ materials + `start`, `beacons[]`, `walls[]`, `floors[]` (material zones),
`ceilings[]` (per-location height/material zones), `monsters[]` (place-only). `isLevel`
back-fills fields added over time so old saved levels still load.

### 8.2 Storage (`storage.ts`)
IndexedDB keyed by level name (save/load/list/delete) + JSON export/import. The
editor also writes a `"current"` copy to localStorage that the game reads via
`?level=current`.

### 8.3 Loader (`load.ts`) — Level → runtime
`loadLevel(level)` produces `{ game, walls, roomSize, scattering }`:
- **`game`**: GameLevel with start/beacon/goal + floor zones + collision walls
  (interior walls + perimeter segments unless open).
- **`walls`**: the acoustic geometry as polygon `WallDef[]` — perimeter (skipped if
  open) + floor + ceiling + interior walls. **Dropped ceiling zones** emit their
  lower plane **plus 4 vertical step-down side walls** so the lower region is
  acoustically enclosed, not a floating plane.
- **`scattering`**: representative mid-band scattering averaged across the level's
  materials.

### 8.4 Editor (`editor/`)
A top-down canvas (`view.ts` world↔screen + drawing; `editor.ts` controller). Tools:
select/move, start, beacon, wall (drag), floor zone (drag rect), ceiling zone (drag
rect + height), monster. Properties panel edits exact values. Room panel: open-space
toggle, dimensions, ceiling toggle/height. The material palette is driven from
`MATERIALS`, so new materials appear automatically.

---

## 9. The clap and the moving-walls path

`clapRoom.ts` `updateGeneralRoom(walls, listener, yaw, {edges, maxOrder, scattering})`
runs the **general solver** on the **live wall list**, builds the room IR (with
scattering), and loads it into a `ConvolverNode`. `main.ts` holds `WALLS` (the
current geometry) and recomputes per clap.

**This is the moving-walls foundation**: when geometry changes, update `WALLS` and
the next recompute reflects it. No special-casing needed. Now built out — walls can
carry an optional `motion` (sliding door / ping-pong translate); `ClapRoom.updateLive`
drives the ambient room IR continuously on a ~14 Hz throttle + dual-convolver
crossfade, with a dirty check. See `docs/engine/moving-walls.md`.

### Measured performance (see §11)
- Image-source solve: **0.03–1.4 ms** (cheap).
- IR build: **~32 ms** (HRIR convolution in JS — the bottleneck).
Fine for clap-on-demand; continuously moving walls would need the IR build moved to
WASM/FFT or throttled + crossfaded.

---

## 10. Testing — what and how

42 JS tests (vitest) + 8 Rust tests (cargo). The philosophy: **audio correctness is
verified on captured samples and physics, not by listening.** Spatial audio is math;
the tests assert on the numbers.

| Suite | What it proves |
|---|---|
| `acoustics-core` (Rust) | image-source delays = path/c; box yields 6 first-order reflections; glass reflects brighter than carpet; diffraction longer/quieter/duller; grazing edge ≈ unity; wall normals inward |
| `spatial.test.ts` | On the REAL SADIE HRTF: right source → right-ear energy; L/R sources → opposite ITD signs; head-turn re-balances a fixed source; farther = quieter; reflection gap matches path-length physics |
| `roomIr.test.ts` | tap energy lands at the right delay; gain scales linearly; darker band gains reduce HF; scattering lowers peak + adds a smear tail; scattering never touches the direct path |
| `wasmRoom.test.ts` | the JS↔WASM general-room round-trip (6 reflections; edge adds a diffraction tap) |
| `scenes.test.ts` | every debug scene produces valid taps; doorway diffracts; in-room object has more reflections than in-void |
| `player.test.ts` | the whole step machine: alternation, wrong-foot/rush stumbles, freeze, stride-scales-with-cadence, settling, heading, goal approach |
| `heading.test.ts` | slew never exceeds maxRate; reaches target; can't teleport on a huge drag; reset snaps |
| `load.test.ts` | enclosed = 6 surfaces; open = free walls only; dropped ceiling = plane + 4 step walls; flush ceiling = plane only; scattering reported |

`measure.ts` provides the analysis primitives (RMS, L/R energy balance, interaural
lag via cross-correlation, band energy via DFT, first-reflection finder), shared by
tests and the debug page so "what the test checks" equals "what you see on screen."

**What is NOT automatically tested**: perceptual quality / front-back confusion (a
listening test by nature) and the live `HrtfSource` crossfade timing (audio-thread
behavior). The debug page (`/debug.html`) exists for human verification of these.

---

## 11. Performance characteristics

| Operation | Cost | Notes |
|---|---|---|
| Shoebox solve, order 2 | 0.09 ms | the common case |
| General room + 6 walls, order 2 | 0.19 ms | |
| Order 3 / big rooms | 0.4–1.4 ms | combinatorial in pathfinding |
| **IR build (taps → stereo IR)** | **~32 ms** | dominant cost; plain-JS HRIR convolution |

Implications: clap-on-demand and static/occasionally-changing geometry are fine.
For continuously moving walls, optimize the IR build (move HRIR convolution to
WASM, or FFT convolution — 10–50× expected) or throttle to ~10 Hz and crossfade.

---

## 12. Known limitations & follow-ups

- **IR build is JS** (~32 ms) — the one perf item for real-time moving geometry.
- **Monsters are place-only** — the editor saves them; the game has no chase AI yet.
- **Beacon sounds**: per-beacon synth presets (tone/bell/musicbox/drip/hum) +
  optional custom audio file (`docs/engine/beacon-sounds.md`).
- **Diffraction is first-order, geometric approximation** — no true UTD coefficient,
  no 2nd-order; cap is intentional (cost is combinatorial in edge pathfinding).
- **Late reverb**: an FDN tail (8 mutually-prime delay lines, Householder feedback,
  per-line HF damping) is rendered offline and overlap-added onto the early IR, fed by
  the early/scatter energy at handover; RT60 is an Eyring estimate from room volume +
  surface area + mean absorption. Single broadband RT (one HF-ratio knob), not per-band;
  see `docs/engine/late-reverb-fdn.md`.
- **HRTF is one fixed subject** (SADIE H3) — the loader accepts arbitrary SOFA, so
  per-user personalization is a future lever (the main fix for front/back confusion).
- **The debug page's `turnControl.ts`** is the legacy drag-anywhere control; the game
  uses the compass only.

---

## 13. How to extend (pointers)

- **New material**: add to `MATERIALS_FULL` (absorption + scattering) and, for
  footsteps, a preset in `stepSounds.ts`. It auto-appears in the editor palette.
- **New acoustic geometry kind** (ramp, curved wall): add to `schema.ts`, render in
  the editor `view.ts`, and emit `WallDef`s in `load.ts`. The general solver takes
  any convex polygon.
- **Monster AI**: monsters are already in the schema/level; add a movement + catch
  loop in `game.ts` and a spatialized sound source.
- **Real-time moving walls**: port the HRIR convolution in `roomIr.ts` to WASM (or
  FFT), then recompute `WALLS` + IR on a throttle with a crossfade.
- **Better diffraction**: replace the attenuation term in `diffraction.rs` with a
  UTD coefficient; add 2nd-order edge pathfinding.
- **Late reverb**: add an FDN tail fed by the diffuse (scattered) energy.
