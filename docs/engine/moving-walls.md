# Moving walls

Walls that move continuously, with the room acoustics tracking them in real time:
as a sliding door opens or a maze wall shifts, the echoes/occlusion update so you
HEAR the space changing. Built directly on the foundation called out in
`docs/TECHNICAL.md` §9 (the clap/room path already runs the general solver on a
LIVE wall list) and `docs/engine/realtime-ir-build.md` (the ~6× faster WASM/FFT IR
build that made a throttled rebuild affordable).

## 1. Motion schema (`src/level/schema.ts`)

`WallObj` gains an OPTIONAL `motion?: WallMotion`. Absent ⇒ a static wall, so every
existing level loads unchanged (no `isLevel` back-fill needed — an absent optional
field is already valid; the round-trip is covered by a test).

Two kinds, both **periodic, stateless, and pure functions of time** (so geometry at
any `t` is reproducible and the acoustics can be re-driven deterministically):

- **`translate`** — the whole segment ping-pongs along `(dx, dz)` over `period`
  seconds. Phase 0 = rest; it travels to `+(dx,dz)` at the half-period and back.
  Models a shifting maze wall.
- **`slide`** — a **sliding door**. Endpoint `b` retracts toward the fixed jamb `a`,
  opening a gap of up to `openFraction` (0..1) of the segment length, then closes,
  over `period` seconds.

**Why this representation.** It is minimal, fully serializable (plain numbers, no
runtime handles), and covers both requested cases (ping-pong translate AND
open/close door) with one shared time function. Keeping it stateless means save/load
and the simulation agree exactly — there is no integrator drift, and a test can
assert the wall is at a known place at t=0 / half / full period.

## 2. Time → geometry (`src/level/load.ts`)

Pure, exported, unit-tested:

- `wallSegmentAt(wall, t)` → the wall's current 2D `{ax,az,bx,bz}` at time `t`
  (seconds). No motion ⇒ the rest segment for ALL `t` (old levels byte-identical).
  Uses a triangle `pingPong(t, period)` in `[0,1]`.
- `wallsAt(level, t)` → the full acoustic `WallDef[]` (static perimeter + interior
  walls displaced for time `t`). At `t=0` with no moving walls this equals the old
  `loadLevel().walls` exactly — `loadLevel` now builds its `walls` via `wallsAt(level, 0)`.
- `levelHasMovingWalls(level)` → cheap gate so the live loop only runs when needed.
- `movingGeometrySignature(level, t)` → the moving-geometry part of the dirty-check key.
- `liveRebuildSignature(level, t, pose)` → the FULL dirty-check key: moving geometry
  AND the quantised listener pose (see §4).

`LoadedLevel` now also carries `level` and `hasMovingWalls` so `main.ts` can re-derive
geometry from the animation clock.

## 3. Real-time rebuild architecture (`src/engine/acoustics/clapRoom.ts`)

`ClapRoom` was extended (not replaced — `clap()`, `updateRoom`, `updateGeneralRoom`
all still work) to drive the **ambient** room response continuously.

**Dual convolvers + equal-power crossfade.** The same trick `renderer.ts` uses for
moving sources. Swapping a single `ConvolverNode.buffer` mid-signal CLICKS (the
in-flight tail jumps). `ClapRoom` now holds TWO convolver chains, each with a
crossfade gain, fed by a shared `clapBus`. `swapIr(ir)` loads the new IR into the
idle chain and ramps across over 80 ms (the first ever IR loads straight into the
active chain). Mid-fade swaps just refresh the incoming buffer (no new ramp), so a
burst of rebuilds doesn't thrash the gains.

**`updateLive(walls, sig, listener, yaw, opts)`** is the moving-walls hot path:

- **THROTTLE** — rebuild at most every `minIntervalMs` (default **70 ms ≈ 14 Hz**),
  NOT every animation frame. `main.ts` calls it every frame; the throttle gates it.
- **DIRTY CHECK** — skip entirely when `sig` equals the last signature (nothing moved
  materially). A static level therefore never rebuilds here.

`main.ts` runs a `requestAnimationFrame` loop (only when `hasMovingWalls`) that
advances an animation clock from `performance.now()` and sets `WALLS = wallsAt(level, t)`
EVERY frame (so the clap button + collision recompute see live geometry for free).
The signature is only consumed at the throttle rate, so the loop builds
`liveRebuildSignature` (and calls `updateLive`) only on frames past the ~70 ms window,
avoiding a per-frame string allocation. The rAF id is stored so the loop is cancellable
and can't be started twice (a duplicate loop would double the rebuild rate). It reuses
the fast WASM IR build through the unchanged `buildRoomIr` → `ConvolverNode` pipeline.

## 4. Dirty check

The dirty check keys on the moving WALLS **and** the LISTENER POSE — because the
ambient room IR depends on both. If it keyed on walls alone, walking or turning while
walls are momentarily static would leave the room IR stale for the new pose, which
defeats the premise ("hear the space change as you move").

`liveRebuildSignature(level, t, pose)` = `movingGeometrySignature(level, t)` + a
quantised pose:

- `movingGeometrySignature(level, t)` concatenates each MOVING wall's segment
  coordinates quantised to ~1 mm (`round(n*1000)`). Static walls and the perimeter
  are omitted (they never change).
- The listener pose is quantised to **5 cm in x/z** (`POSE_POS_QUANTUM`) and
  **~2.5° in yaw** (`POSE_YAW_QUANTUM`), so sub-perceptual jitter doesn't thrash
  rebuilds but real movement does.

So:

- a static level with a stationary listener yields a constant signature ⇒ **zero
  rebuilds**;
- sub-quantum jitter (walls OR pose) doesn't force a rebuild;
- a material wall move OR a material listener move changes the signature ⇒ rebuild
  (still gated by the ~70 ms/14 Hz throttle + crossfade in `ClapRoom.updateLive`);
- equal signature ⇒ identical taps for the same pose ⇒ skipping the rebuild is correct.

Pure and tested.

## 5. Measured cost

Per-rebuild = solve (`computeRoomTaps`) + `buildRoomIr` (the WASM/FFT path), 6-wall
shoebox with a sliding door, order 2, 256-tap HRIR, scattering 0.3, measured in
vitest/Node (30-iter mean; the browser is faster, Node absolute ms run high):

| Operation | Cost |
|---|---|
| Full rebuild (solve + IR build) | **~6–7 ms / rebuild** |

This is the right tradeoff and the doc says so: at ~14 Hz the per-frame budget is
never touched (one rebuild ≈ 6 ms ≪ the 70 ms throttle interval, so rebuilds never
stack), and the **crossfade** hides the IR swap. We deliberately throttle + crossfade
rather than rebuild every frame — a 60 Hz rebuild would burn ~360 ms/s of main-thread
time for no perceptible gain. (`tests/movingWalls.test.ts` prints the number and
asserts it stays under the throttle.)

## 6. Editor (`src/editor/editor.ts`)

The wall properties panel gains a `motion` selector (`none` / `translate` / `slide`).
Picking a kind seeds sensible defaults and reveals its params:

- translate: `move dx`, `move dz`, `period s`;
- slide: `open frac`, `period s`.

Reuses the existing `numRow`/`<select>` pattern and re-renders on kind change so the
right fields show. It round-trips through save/load and JSON export/import (the whole
`level` is serialized; `motion` is just another optional field).

## 7. Back-compat

- `motion` is optional; absent ⇒ static. Old saved levels load and behave identically
  (`wallsAt(level, t)` returns the same geometry for all `t`; a test asserts byte-equality
  with the pre-change `loadLevel().walls`).
- No Rust/WASM change — `cargo test` (11) and the WASM binary are untouched. The
  speed-of-sound / Doppler code was not modified.

## 8. Limitations / follow-ups

- **Image-source validity while moving.** Each rebuild re-runs the general solver
  from scratch on the current geometry, so image sources are always valid for the
  instantaneous pose. We do NOT interpolate image sources between rebuilds; the
  crossfade smooths the IR swap perceptually, not the underlying image-source set.
- **Max rebuild rate ≈ 14 Hz** (the throttle). Fast wall motion is sampled at 14 Hz;
  faster is possible (lower `minIntervalMs`) at proportional CPU cost, or push the
  `band_fir` design onto an inverse FFT (the next lever in `realtime-ir-build.md`).
- **No per-wall occlusion of the DIRECT beacon path yet.** A moving wall changes the
  ambient room IR (reflections/reverb), but the live beacon `HrtfSource` is not yet
  occluded/diffracted by a wall sliding between you and it. That needs a
  visibility/diffraction test on the direct path each frame; deferred.
- **Crossfade vs. very fast motion.** At 14 Hz with an 80 ms fade, successive fades
  can overlap; the mid-fade refresh keeps it click-free but a sustained fast slide is
  slightly smeared. Acceptable for the target motion speeds.

## 9. Tests (`tests/movingWalls.test.ts`)

Pure time→geometry (rest/half/full period for translate and slide; ping-pong bounds;
partial `openFraction`); old levels unchanged at any `t`; `isLevel` validates old
levels WITHOUT `motion` (and they load identically) and a level WITH `motion`
(field preserved); dirty-check signature (constant for static, changes on motion,
deterministic); the LIVE dirty check keying on walls AND listener pose (rebuild when
only the listener moves materially, no rebuild on sub-quantum jitter, rebuild when only
the walls move); acoustics respond to motion (`computeRoomTaps` delays DIFFER at two
times when the wall moved, IDENTICAL at t=0 vs t=period); and the per-rebuild cost
bench. Full suite: **73 JS** + **11 Rust** green; `tsc --noEmit` clean.
