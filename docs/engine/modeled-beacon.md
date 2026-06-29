# Modeled beacon audio (Phase 1: occlusion + diffraction)

## The problem

The beacon — the sound you home in on — was a plain `HrtfSource`: a mono voice
placed on a **straight line** to the listener (`beacon.setPosition(...)` every
frame). It spatialized, Dopplered, and lost highs with distance, but it **ignored
every wall**. Stand behind a wall and the beacon came through it at full strength,
arriving from the wrong direction (straight through the wall instead of around it).
That broke the core echolocation premise: walls should *block* and *bend* sound.

## The fix: render the beacon through the room solver

`ModeledSource` (`src/engine/acoustics/modeledSource.ts`) renders the **continuous**
dry beacon voice through the same room physics the clap already uses — but refreshed
live as the listener moves. Each refresh:

1. solves `computeRoomTaps({ walls, edges, listener, source, maxOrder })` (the WASM
   image-source + diffraction core), then
2. collapses those taps into ONE per-source stereo IR via `buildRoomIr(taps, hrtfSet,
   { yaw, tail:false })` (HRIR direction + per-band material coloring + per-tap delay),
   and
3. crossfades that IR into an idle convolver.

The dry voice (synth preset or custom loop) feeds `modeledBeacon.input`;
`modeledBeacon.output → master`.

Everything the feature needs falls out of the **existing solver** — no new physics:

- **Occlusion** — the order-0 DIRECT tap is emitted by the Rust core **only** `if
  self.visible(listener, source)` (`acoustics-core/src/geometry.rs`). When a wall sits
  between you and the beacon, that tap is **dropped automatically**; you hear only the
  indirect field. Step into line of sight and it reappears.
- **Diffraction** — edge taps (order ≥ 1) at the openings' jambs/free ends let the
  beacon "leak" through gaps, so an occluded beacon is still audible, but muffled and
  arriving **from the gap**, not through the wall.
- **Material coloring** — each tap's per-band gains already encode wall absorption, so
  a beacon heard around a **brick** wall is duller than around **concrete**. Free.
- **Doppler / propagation** — `buildRoomIr` places each tap at `delay = path/c`. A
  MOVING beacon (or listener) Dopplers as those per-tap delays change between rebuilds
  and the crossfade ramps across — **no separate DelayNode needed**. (The beacon is
  static today, but the design carries motion for free.)

### Dual-convolver crossfade + throttle

`ModeledSource` mirrors `ClapRoom`'s proven dual-convolver equal-power crossfade
(`swapIr`): swapping a single `ConvolverNode.buffer` mid-signal **clicks**, so each new
IR loads into the *idle* chain and the gains ramp across (~80 ms). Refreshes are
**throttled to ~14 Hz (70 ms)** and gated by a **dirty check**
(`modeledRefreshSignature`): the quantized listener pose (5 cm / ~2.5°) + source
position + a coarse geometry hash. If nothing moved materially, no re-solve happens — a
static scene with a static listener rebuilds **zero** times. (Same idea as moving-walls'
`liveRebuildSignature`.)

### Continuous source, no reverb tail

The per-source IR is built with `tail: false` (early field only — direct + diffraction
+ any reflections). The **clap** owns the room's late reverb; baking the FDN tail into
the beacon's own IR would smear a continuously-playing voice and hurt localization.

## Wiring

- `GameLevel` gained `acousticWalls?`, `acousticEdges?`, `acousticScattering?`. When
  present, `Game` builds a `ModeledSource` for the beacon instead of an `HrtfSource`;
  when absent it falls back to the plain straight-line beacon (full back-compat).
- `main.ts` threads `WALLS`/`EDGES`/`SCATTER` (the same geometry the clap uses, with
  `SPEED_OF_SOUND`) into the level. The moving-walls live loop calls
  `game.setAcousticGeometry(WALLS, EDGES)` each frame so a beacon behind a sliding wall
  occludes/un-occludes as the wall moves.
- The beacon re-solves from the existing per-frame path: `applyAudioPose` (glide) and
  `Game.tick`, both using the listener pose, on the throttle.

### Back-compat / correctness

In an **open room with clear line of sight**, the direct tap is present and dominant,
so the beacon sounds essentially as before (direct path + maybe faint early
diffraction). **Behind a wall**, the direct tap drops and you hear the muffled,
diffracted, correctly-colored beacon arriving from the opening. **That transition is
the whole feature.**

## Performance

Measured per-refresh cost (`computeRoomTaps` solve + `buildRoomIr` WASM IR build) for
the **clap-maze** (perimeter + ceiling + 3 brick interior walls + auto edges), a
256-tap HRIR, listener behind a wall:

| Image-source order | taps | ms / refresh |
|--------------------|------|--------------|
| 1 (Phase 1)        | 4    | ~2–3 ms      |
| 2                  | 4    | ~2 ms        |
| 3                  | 9    | ~4 ms        |

Against the **70 ms** throttle budget (~14 Hz) the Phase-1 cost (~3 ms) leaves **~20×
headroom**. Even order 3 (~4 ms) is comfortably inside budget for this geometry.

### Phase-2 / FFT recommendation

**The WASM/FFT IR-build speedup is NOT a prerequisite for Phase 2.** The IR build
already runs on the FFT WASM path (`buildRoomIrWasm`, ~5–6× the JS reference). For
clap-maze-scale rooms, raising `maxOrder` for full reflections stays well under the
throttle budget. The cost driver to watch is **tap count**, which grows combinatorially
with order *and* wall count (`walls^order` candidates in the solver), so a large room
with many interior walls at order 3 could approach the budget — re-measure on the
heaviest authored level before enabling high orders globally. Recommendation: ship
Phase 2 at **order 2** first (negligible cost here), profile the heaviest level, and only
then consider order 3 or a tighter throttle.

## What is Phase 1 vs deferred

- **Phase 1 (this):** direct tap (occlusion) + first-order edge diffraction + material
  coloring + Doppler-via-delays, live-refreshed with crossfade + throttle.
- **Phase 2 (deferred):** full reflections (higher `maxOrder`) so the beacon's *early
  reflections* also reach you around corners — just raise `maxOrder` in
  `refreshBeacon`; the perf table says the budget holds.
- **Monsters (deferred):** the same `ModeledSource` could render monster growls through
  the room so they too occlude/diffract; today monsters stay on the plain `HrtfSource`.

## What is tested

`tests/modeledBeacon.test.ts`:

- **Acoustic (real WASM solver):** in clap-maze, with a wall occluding the beacon the
  order-0 direct tap is **absent** and ≥1 diffraction tap exists; with clear line of
  sight the direct tap is **present**; and the occluded beacon is materially quieter.
- **Dirty-check/throttle signature (pure):** identical when nothing moves; unchanged for
  sub-quantum jitter; changes when the listener moves/turns past the quantum, when the
  source moves, and when wall geometry moves.
- **Perf/bench:** logs the per-refresh ms and asserts it's under the 70 ms budget.

The dual-convolver crossfade + Web Audio graph is **ear/integration-verified** (vitest
has no Web Audio); the IR-build and solver math are covered by the existing
`roomIr*`/`reflectorAcoustics`/`wasmRoom` suites.
