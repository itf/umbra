# Steam Audio backend (selectable spatial engine)

A WASM **Steam Audio** spatial-audio backend (`three-steam-audio@0.1.0-beta.1`,
Apache-2.0, ships a prebuilt 6 MB `phonon_bindings.wasm`) wired as a **selectable
alternative** to our own image-source/HRTF engine, so the two can be A/B'd by ear on
real levels and the choice deferred. This implements the toggle planned in
`docs/research/ray-traced-acoustics.md` §8 (which the spikes in §6–§7 de-risked).

**Default = our engine. No regression.** Steam Audio engages only on explicit opt-in
(the Begin-screen checkbox / `?engine=steam`), and even then loads lazily — see
*Dynamic import* below.

---

## Architecture

```
dry beacon voice ─▶ [Steam Audio source node] ─▶ output gain ─▶ master ─▶ limiter
                              │
                              ├─▶ reflection bus ─▶ master   (ray-traced reflections)
                              └─▶ reverb bus     ─▶ master   (per-source listener reverb)
```

Both engines are the same *shape* — a dry positioned source whose `input` you feed
and whose `output` is master-bound, repositioned per frame — so `game.ts` drives a
Steam Audio source exactly as it drives a `ModeledSource`/`HrtfSource`. Only the
spatializer is swapped; the dry voices, level geometry, master/limiter graph, and
per-frame position updates are shared and unchanged.

### Files
- `src/engine/steamaudio/convert.ts` — **pure** `WallDef[]` → Steam Audio scene
  converter (geometry + materials). No Web Audio / `three` / WASM imports; the one
  scene-touching function (`buildSteamScene`) takes the runtime objects as injected
  deps. **Unit-tested** (`convert.test.ts`).
- `src/engine/steamaudio/toggle.ts` — **pure** backend-selection from the `engine`
  URL param. **Unit-tested** (`toggle.test.ts`).
- `src/engine/steamaudio/backend.ts` — `SteamAudioBackend`, wrapping a Steam Audio
  `world`. Browser/integration-verified, **not** unit-tested (see *Testing*).
- `src/engine/steamaudio/shims.d.ts` — ambient `declare module` for `three` /
  `three-steam-audio` (we don't ship `@types/three`; the backend uses them via `any`).
- `src/game/game.ts` — the `SpatialBackend` seam + beacon wiring (the constructor
  takes an optional backend; when present the beacon routes through it).
- `src/main.ts` — toggle read + lazy backend construction + graceful fallback.
- `vite.config.ts` — COOP/COEP on `preview` (was `server`-only).

---

## WallDef → Steam Audio scene conversion

Our `WallDef = { verts:[x,y,z][], absorption:number[8], doubleSided? }`. Steam Audio
wants `addStaticMesh({ geometry: THREE.BufferGeometry, material: AcousticMaterial,
matrixWorld })` where `AcousticMaterial = { absorption:[lo,mid,hi], scattering:number,
transmission:[lo,mid,hi] }` (THREE-band).

**Triangulation.** Each wall is a convex polygon; we fan-triangulate it (v0-v1-v2,
v0-v2-v3, … → *n-2* triangles for an *n*-gon, so a quad → 2). We build **one mesh per
wall** (not one merged mesh) so each wall keeps its own material and so moving-wall
levels can dispose/rebuild per wall; Steam Audio rebuilds its BVH on `commit()`
either way. Our wall verts are already in **world space**, so each mesh uses an
identity `matrixWorld`.

**8-band → 3-band absorption.** Our bands are `[63,125,250,500,1k,2k,4k,8k]`. We group:
- `low`  = mean of `[63, 125, 250]`
- `mid`  = mean of `[500, 1k, 2k]`
- `high` = mean of `[4k, 8k]`

This keeps the split at the conventional low/mid (250↔500) and mid/high (2k↔4k)
octave boundaries.

**How much realism does 8→3 cost?** Measured on our actual material data, as the
per-band reflection-spectrum error (dB) introduced by the collapse:

| material | avg err | max err |
|----------|:-------:|:-------:|
| concrete | 0.03 dB | 0.06 dB |
| marble | 0.01 dB | 0.06 dB |
| brick | 0.05 dB | 0.15 dB |
| glass | 0.22 dB | 0.77 dB |
| curtain | 0.47 dB | 1.34 dB |
| carpet | 1.25 dB | 5.11 dB |

The loss is **near-zero for hard materials** (concrete/marble/brick ≤0.05 dB avg —
below the ~1 dB just-noticeable difference, i.e. inaudible) because their absorption
curves are nearly flat, so 3 points capture them. It's **largest for soft, steeply
frequency-shaped materials** (carpet's bass-reflective/treble-dead ramp) — but those
barely reflect at all (carpet absorbs 60–80% at mid/high), so the error sits on a
reflection that's already deep down. Net: the cues that carry size/distance/direction/
hardness are preserved; only fine timbre on soft surfaces degrades, and least audibly.
This is why the **trainer's material-ID drills stay on our 8-band engine** (cue
precision matters there) while the game uses Steam Audio (the 3-band loss is swamped by
the traced-reflection/diffusion gain). brick↔concrete — the one material-discrimination
pair — differs by only ~0.05 dB even at 3-band, so it survives regardless.

**Scattering → scalar.** Steam Audio takes one scattering value per material. We use
our level's representative scattering scalar (`acousticScattering`, ~1 kHz region),
matching how the engine's `representativeScattering` works. (If a per-band scattering
curve is ever attached to a `WallDef`, `scattering8toScalar` reduces it via the mean
of the mid bands `[500,1k,2k]`.)

**Transmission default.** Our `WallDef` carries no transmission data (absorption
only). We default to a small non-zero `[0.02, 0.015, 0.01]` so walls aren't perfectly
opaque (a modest through-wall leak, matching our engine's behaviour) while staying
well below the reflected/occluded field so **occlusion still reads clearly**. Override
per build if measured transmission ever exists.

**Double-sided walls → thin box.** A single Steam Audio triangle reflects/occludes
from one face only. Interior / free-standing walls (`doubleSided`) must echo + occlude
from **both** sides, so we emit them as a **thin box**: the polygon extruded ±5 cm
along its normal, with both parallel faces (opposite windings). The spike's divider
used a thin box and occluded correctly from both sides. Perimeter walls (`doubleSided`
falsy — you're always inside) stay a single-sided fan quad (cheaper, and the inside
face is the only one that matters).

---

## The toggle

- **UI control:** a checkbox on the Begin screen — *"High-fidelity audio (Steam
  Audio, experimental)"* (`#engine-steam-toggle`). Unchecked = our engine (default);
  checked = Steam Audio. It is the source of truth at Begin.
- **URL param:** `?engine=steam` pre-checks the box (`?engine=ours`/absent leaves it
  unchecked), so deep links still work; the checkbox can override the param.
- **Selection** is a pure function (`selectBackend` / `selectBackendFromSearch`),
  unit-tested; it drives the toggle's initial state.
- **Scope: beacon AND monsters.** Both route through the selected engine via a shared
  `makePositionedSource()` factory in `game.ts` (a Steam Audio source when active,
  else our `HrtfSource`). Footsteps + the clap/room IR stay on our engine (they're the
  echolocation cue and the room-reverb owner). Monster sources share the one Steam
  Audio world; their positions are driven from `tickMonsters`, the world `step` from
  `tick`.
- **Per frame**, `game.ts` drives `backend.setListener(x,y,z,yaw)` +
  `beacon.setPosition(...)` from `applyAudioPose`, and `backend.step(dt)` from `tick`.
  Moving-wall levels call `backend.setGeometry(walls)` (rebuilds + commits the scene).

### Dynamic import (default bundle unaffected)
`three` (~700 KB) and the 6 MB Steam Audio WASM are pulled in **only** on the
`?engine=steam` path, via `await import('./engine/steamaudio/backend')` (which itself
dynamically imports `three` + `three-steam-audio`). Verified in the production build:
`?engine=ours` loads **no** `three`/`backend` chunks; `?engine=steam` loads both.

### Graceful fallback
If Steam Audio can't initialise — no cross-origin isolation, WASM load failure —
`SteamAudioBackend.create` throws a clear error; `main.ts` catches it, logs a
non-scary `console.warn`, and falls back to **our engine**. The game is never silent.

---

## COOP/COEP — production requirement

Steam Audio's threaded reflection sim needs `SharedArrayBuffer`, which is gated behind
**cross-origin isolation** (`crossOriginIsolated === true`), enabled by:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

These were set on `vite` `server` (dev) only; they are now **also** on `preview`. The
**deployed production host must send the same headers** (e.g. a `_headers` file on
Cloudflare Pages / Netlify, an nginx/host config, or the PWA service worker) or
`?engine=steam` will fail to init (and fall back to our engine). **Our own engine does
NOT need this**, so default production builds are unaffected.

---

## Testing — what's unit-tested vs browser-verified

**Unit-tested (vitest, pure):**
- `convert.ts`: quad → 2 tris, n-gon → n-2 tris, vertices preserved; 8→3-band
  absorption grouping; scattering scalar; double-sided → two-sided thin box (vertex +
  triangle counts, ±thickness extrusion along the normal); `buildSteamScene` adds one
  mesh per wall and commits once.
- `toggle.ts`: `engine=steam` vs `ours` vs absent/unknown selection.

**Browser / integration-verified (NOT unit-tested):** the `SteamAudioBackend` class.
Steam Audio needs Web Audio + a WASM AudioWorklet + cross-origin isolation, none of
which run under vitest — loading the WASM there would fail/hang, so we don't. Verified
via Playwright against the production `vite preview` build on `?level=clap-maze`:
`crossOriginIsolated === true`, the Steam Audio world inits, the game runs with the
beacon audible, and **zero console errors** — and `?engine=ours` still works
identically. The whole existing suite stays green and `tsc --noEmit` is clean.

---

## How to A/B by ear

1. Build + preview: `npm run build` (or `npx vite build`), then `npm run preview`.
2. Open `/?level=clap-maze&engine=steam` — beacon via Steam Audio (ray-traced
   occlusion + reflections + per-source reverb).
3. Open `/?level=clap-maze` (or `&engine=ours`) — beacon via our image-source engine.
4. Walk the same path in each and compare localizability, occlusion behind walls,
   reflection richness, and reverberance. Any level with acoustic geometry works.

---

## Follow-up (deferred)

- **A/B decision.** Whether Steam Audio becomes the default or stays a selectable
  high-fidelity mode (keeping our diffraction-rich engine for the trainer's cue
  isolation) is decided by the by-ear comparison.
- **Measured transmission** per material (replace the `DEFAULT_TRANSMISSION` constant).
