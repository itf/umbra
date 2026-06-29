# Roadmap & Future Tasks

Concrete, actionable tasks for future engineers/agents. Grouped by area and
roughly ordered by impact. Each notes where it touches and any known approach.

Status legend: 🔴 not started · 🟡 partial · ✅ done (listed for context).

---

## Recently completed (sound-engine initiative + polish)

A focused push made the acoustics engine dynamic and physically richer. All shipped
with tests + per-feature docs under `docs/engine/`:

- ✅ **Configurable speed of sound** — `c` is a runtime parameter threaded through all
  solvers; propagation delay responds to it. `docs/engine/speed-of-sound.md`.
- ✅ **Real-time IR build (WASM + FFT)** — per-tap HRIR convolution ported to Rust/FFT,
  ~6× faster, unblocking per-frame re-solve. `docs/engine/realtime-ir-build.md`.
- ✅ **Propagation delay + Doppler** — per-source delay line; Doppler emerges from delay
  modulation (incl. listener motion). `docs/engine/doppler-and-propagation-delay.md`.
- ✅ **Moving walls** — continuous wall motion with the room IR tracked live (~14 Hz
  throttle + dual-convolver crossfade, dirty-checked on walls AND listener pose).
  `docs/engine/moving-walls.md`.
- ✅ **Audio-only listener glide** — the audio listener glides between footfalls for a
  natural direction sweep + smooth listener Doppler, discrete step mechanic untouched.
  `docs/engine/listener-glide.md`.
- ✅ **Late reverb (FDN tail)** — Eyring-RT60 FDN tail rendered into the room IR.
  `docs/engine/late-reverb-fdn.md`. (was 🔴 below)
- ✅ **Richer / custom beacon sounds** — synth presets + custom audio.
  `docs/engine/beacon-sounds.md`. (see Gameplay below)
- ✅ **Audio-artifact + clipping verification** — OfflineAudioContext stress tests (fast
  rotate/walk/glide/IR-swap → no clicks) + a master limiter (no clipping).
  `docs/engine/audio-artifacts-and-clipping.md`. (covers the "Live-render tests" item below)

In progress / next: auto-derived diffraction edges + UTD coefficient, a player
**noise-event model**, then **monster chase AI** (hunts your last noise).

---

## Gameplay

### 🔴 Monster chase AI
Monsters are **place-only** today — the editor saves them into the level
(`schema.ts` `MonsterObj`: position, speed, sound) but the game ignores them.
- Add a movement loop in `game.ts`: each monster emits a spatialized sound
  (`HrtfSource`) and moves toward the player at its `speed`.
- "Caught" when within a radius → a lose/restart state (new `onCaught` callback).
- Consider simple behaviors: line-of-"sound" chase, patrol, freeze-when-still
  (the original rewarded standing still).
- Tuning: monsters should be locatable by ear (distinct, looping sound) so the
  player can avoid them.

### ✅ Richer / custom beacon sounds — DONE
Beacons now have named synth presets plus an optional custom audio file.
- Presets (`src/game/beaconSounds.ts`): `tone`/`pulse` (legacy sine), `bell`
  (struck inharmonic partials), `musicbox` (plucked motif), `drip` (randomized
  water blip), `hum` (low harmonic drone w/ vibrato). All feed ONE mono output
  into the beacon's `HrtfSource`, so spatialization/Doppler/propagation are shared.
- `BeaconObj.sound` + `BeaconObj.soundUrl` (optional; old levels back-fill to
  `tone`). A `soundUrl` is fetched + decoded + cached and looped through the HRTF
  source, falling back to the synth preset on failure.
- Editor exposes a preset dropdown, a custom-url field, and a Preview button.
- See `docs/engine/beacon-sounds.md`.

### 🔴 Hazards and richer win/lose
- Hazard zones (pits, traps) that cost you or end the run.
- Multi-beacon levels, ordered objectives, time pressure.
- A proper level-complete / game-over flow and progression between levels.

### 🔴 Level progression / campaign
Chain levels into a sequence; carry state; a menu to pick levels. Today each level
is standalone via `?level=current`.

---

## Acoustics engine

### ✅ Real-time IR build (the key performance task) — DONE
The per-tap HRIR convolution was ported to **Rust/WASM with FFT** (overlap-add),
~6× faster than the old ~32 ms JS build (e.g. 62→10 ms), with the FFT planner cached
per HRIR size. JS does the cheap `nearestDir`; WASM does coloring/convolution/
scattering. This unblocked moving walls (per-frame re-solve under a throttle).
`docs/engine/realtime-ir-build.md`. *Follow-up lever:* the `band_fir` design is still
O(length²); pushing it onto an inverse-FFT is the documented next speedup.

### ✅ Late reverb (FDN tail) — DONE
An 8-line **FDN** (Householder feedback, per-line HF damping, decorrelated L/R taps)
is rendered **offline into the room IR** (so the room stays one ConvolverNode — clap +
moving-walls crossfade unchanged). RT60 is derived from geometry+materials via **Eyring**,
so a large hard room rings longer than a small absorbent one; the diffuse smear feeds
the tail for energy continuity. ~1 ms added to the IR build. `docs/engine/late-reverb-fdn.md`.

### 🟡 Better diffraction
First-order **geometric approximation** only (`diffraction.rs`).
- Replace the attenuation term with a true **UTD coefficient** (Tsingos/Steam
  Audio) for physical accuracy.
- Add **2nd-order** edge pathfinding (cap low — cost is combinatorial in finding
  which edges, not the coefficient math).
- Wire diffraction edges from the editor geometry (doorway jambs) automatically
  rather than only when explicitly provided.

### 🔴 Wire diffraction edges from level geometry
The general solver accepts diffraction `edges`, but `load.ts` doesn't yet derive
them from walls/openings. Auto-generate edges at wall ends and doorway jambs so
diffraction "just works" in authored levels.

### 🟡 Improve material data
- Replace the **estimated** outdoor surfaces (asphalt/grass/gravel/water) and all
  **scattering** values with measured sources where they exist.
- Add more surfaces as needed (metal, water with depth, foliage).
- Provenance is documented in `materials.ts`; keep flagging measured vs. estimated.

### 🔴 Non-flat / curved geometry
The solver handles convex polygons. For curved walls (a rounded plaza) or concave
rooms, add tessellation in `load.ts` (approximate curves as polygon strips) or a
ray-tracing path for diffuse reflections.

---

## HRTF / spatial audio

### 🔴 Personalized / selectable HRTF
One fixed subject (SADIE H3) today; the loader accepts arbitrary SOFA. Let users
pick a subject or upload their own SOFA (bake in-browser or server-side). This is
the main lever against **front/back confusion**.

### 🔴 Direction interpolation
`nearestDir` snaps to the closest measured direction. Interpolate between the 3
nearest measured HRIRs (barycentric) for smoother motion and fewer artifacts.

### 🟡 Elevation cues
The HRTF set has elevation data; verify and tune that up/down is conveyed (useful
for stairs, dropped ceilings, flying hazards).

---

## Level editor

### 🔴 Undo/redo and multi-select
Currently single-select, no undo. Add a command history and rubber-band select.

### 🔴 In-editor audio preview
Let the editor itself play the clap / beacon at a hovered point, so designers hear
a space without switching to the game page. (Reuse `ClapRoom.updateGeneralRoom`.)

### 🔴 Curved walls, polygons, rooms-within-rooms
Richer geometry tools beyond straight segments and axis-aligned zones.

### 🔴 Monster/beacon sound preview & properties
Once beacon/monster sounds exist, expose their selection + preview in the editor.

---

## Platform / polish

### 🔴 iOS Safari hardening
Audio needs a user gesture to start; AudioWorklet/Service-Worker behavior is
stricter. Budget device testing; the architecture anticipates it but it's untested
on-device.

### 🔴 Haptics
Step/stumble/bump haptic feedback on supported devices (the original used touch
feedback heavily).

### 🔴 Settings
Master volume, beacon volume, turn speed, rush sensitivity, HRTF subject — a
settings surface, persisted.

### 🔴 Onboarding / tutorial
A guided first-run teaching the step rhythm, turning, and clapping — eyes-free.

---

## Testing / tooling

### 🔴 Cross-check against pyroomacoustics
Validate our image-source delays/gains against the trusted Python reference
(strongest physics check). Add as an optional/CI comparison.

### 🔴 Golden-IR snapshot tests
Bake reference impulse responses for known rooms and diff against them — visual-
snapshot-style regression testing, for audio.

### ✅ Live-render (OfflineAudioContext) tests — DONE
`tests/audioArtifacts.test.ts` renders the real Web Audio graph in an
`OfflineAudioContext` (via the `node-web-audio-api` dev dep) and stress-tests the live
`HrtfSource` crossfade, propagation delay line, listener glide, and room-IR swap under
fast rotation / fast walking — asserting **no click/zipper artifacts** (a reusable
click detector in `src/engine/analysis/artifacts.ts`) and **no clipping** (a master
limiter). `docs/engine/audio-artifacts-and-clipping.md`.
*Follow-up:* extend the same harness to golden-IR snapshots (below) and the beacon presets.

---

## Known limitations (carry forward)

- IR build is JS (~32 ms) — see "Real-time IR build."
- Monsters place-only; beacon is a bare sine.
- Diffraction first-order, geometric approximation; no late reverb.
- Open-space levels: the clap uses the general solver (correct), but verify edge
  cases with no enclosing surfaces.
- One fixed HRTF subject; `nearestDir` snaps (no interpolation).
