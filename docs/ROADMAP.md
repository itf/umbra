# Roadmap & Future Tasks

Concrete, actionable tasks for future engineers/agents. Grouped by area and
roughly ordered by impact. Each notes where it touches and any known approach.

Status legend: 🔴 not started · 🟡 partial · ✅ done (listed for context).

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

### 🔴 Richer / custom beacon sounds
The beacon is a single pulsed sine (`game.ts`).
- Per-beacon `sound` choice in the editor (the `BeaconObj` can gain a `sound`
  field): bell, music box, water drip, hum, voice.
- Synthesized presets now (like `stepSounds.ts`), with optional **custom audio
  file** per beacon (fetched + cached, fed through the existing HRTF source).
- Richer synthesis (harmonics, slow melody) localizes better and fatigues less.

### 🔴 Hazards and richer win/lose
- Hazard zones (pits, traps) that cost you or end the run.
- Multi-beacon levels, ordered objectives, time pressure.
- A proper level-complete / game-over flow and progression between levels.

### 🔴 Level progression / campaign
Chain levels into a sequence; carry state; a menu to pick levels. Today each level
is standalone via `?level=current`.

---

## Acoustics engine

### 🔴 Real-time IR build (the key performance task)
Measured: the image-source **solve** is cheap (0.03–1.4 ms) but the **IR build**
(`roomIr.ts`, HRIR convolution in plain JS) is **~32 ms** — fine for
clap-on-demand, too slow to rebuild every frame for **continuously moving walls**.
- Port the per-tap HRIR convolution to **WASM**, or use **FFT-based** convolution
  (expected 10–50× faster).
- Alternatively throttle rebuilds to ~10 Hz and crossfade between IRs.
- Unblocks: moving doors/walls, dynamic geometry, denser scenes.

### 🔴 Late reverb (FDN tail)
Only early reflections + a short diffuse smear exist today. Add a **Feedback Delay
Network** reverb tail fed by the scattered (diffuse) energy — the EVERTims-style
architecture in the engine plan. Gives rooms a realistic decay, not just early
echoes.

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

### 🔴 Live-render (OfflineAudioContext) tests
Current sample tests assert on `buildRoomIr` output directly. Add tests that render
the actual Web Audio graph in an `OfflineAudioContext` to cover the live
`HrtfSource` crossfade path that unit tests can't reach.

---

## Known limitations (carry forward)

- IR build is JS (~32 ms) — see "Real-time IR build."
- Monsters place-only; beacon is a bare sine.
- Diffraction first-order, geometric approximation; no late reverb.
- Open-space levels: the clap uses the general solver (correct), but verify edge
  cases with no enclosing surfaces.
- One fixed HRTF subject; `nearestDir` snaps (no interpolation).
