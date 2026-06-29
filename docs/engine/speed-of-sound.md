# Speed of sound as a runtime parameter

## What changed

The speed of sound `c` used to compute arrival delays (`delay = path_length / c`)
is now a runtime argument threaded through the whole solver instead of a baked-in
Rust constant. Changing it makes echoes and reflections audibly arrive earlier or
later, and gives Doppler and moving-wall features a single `c` to reference.

Touched:

- `acoustics-core/src/image_source.rs` — `compute_taps(..., speed_of_sound: f32)`
- `acoustics-core/src/geometry.rs` — `Room::compute_taps(..., speed_of_sound)` and
  its internal `validate_path` / `make_tap` / `make_tap_path` helpers
- `acoustics-core/src/diffraction.rs` — `diffract_tap(..., speed_of_sound: f32)`
- `acoustics-core/src/lib.rs` — wasm-bindgen entry points `compute_shoebox_taps`
  and `compute_room_taps` gain a trailing `speed_of_sound` argument; a new
  `default_speed_of_sound()` export exposes the canonical default to JS
- `src/engine/acoustics/core.ts` — `ShoeboxParams` and `RoomParams` gain an
  optional `speedOfSound?: number` (defaults to `DEFAULT_SPEED_OF_SOUND = 343`)

The existing `SPEED_OF_SOUND` Rust constant remains as the **default value** and is
what the tests and the JS layer fall back to, so behaviour is unchanged unless a
caller passes an override.

## Input guard

A `c` of `0`, a negative, or `NaN`/`Inf` would make `delay = dist / c` produce
infinite or NaN delays and corrupt the whole tap set. Both layers therefore sanitize
the incoming value and fall back to the default (343):

- Rust: `compute_shoebox_taps` and `compute_room_taps` clamp with
  `if speed_of_sound.is_finite() && speed_of_sound > 1.0 { speed_of_sound } else { SPEED_OF_SOUND }`.
- TypeScript: `computeShoeboxTaps` / `computeRoomTaps` pass the override through a
  `sanitizeSpeed()` helper that accepts only finite values `> 1`, else `DEFAULT_SPEED_OF_SOUND`.

So a non-physical override degrades gracefully to the default rather than producing
inf/NaN audio. (The `> 1` floor also rejects absurdly small speeds that would blow up
the IR length.)

## API

Rust (wasm-bindgen):

```
compute_shoebox_taps(room_size, absorption, listener, source, max_order, speed_of_sound) -> Float32Array
compute_room_taps(verts, wall_sizes, wall_abs, edges, listener, source, max_order, speed_of_sound) -> Float32Array
default_speed_of_sound() -> f32   // 343.0
```

TypeScript:

```ts
computeShoeboxTaps({ ...params, speedOfSound?: number }): Tap[]
computeRoomTaps({ ...params, speedOfSound?: number }): Tap[]
// omitted => DEFAULT_SPEED_OF_SOUND (343)
```

## Per-level setting (editor-exposed) — "alien physics"

`c` is now a per-level authoring field, not just a solver argument:

- **Schema** — `Level.speedOfSound?: number` (m/s). Absent ⇒ the engine default
  343, so every pre-existing level is byte-identical and `isLevel` accepts levels
  with or without the field (it's optional; no rejection).
- **Load** — `loadLevel` runs it through `sanitizeLevelSpeed()` (forwards only a
  finite value `> 1`, else `undefined`), and carries the result onto both
  `LoadedLevel.speedOfSound` and `GameLevel.speedOfSound`. A `0`/negative/`NaN`/
  `Infinity` authored value collapses to `undefined` here, so a bad value can never
  reach the solver as inf/NaN (and the core re-sanitizes anyway — belt and braces).
- **Editor** — a "Speed of sound (m/s)" number input in the Room panel
  (`#room-sos`, range 100–700, placeholder `343`). Blank clears the field (default
  c); a finite `> 1` value writes `level.speedOfSound`. It reflects on load / new /
  import and round-trips through save/export JSON.

### Where it flows at runtime (both clap AND live sources)

`main.ts` reads `loaded.speedOfSound` into a module `SPEED_OF_SOUND` and applies it
in two places so the space sounds coherent:

1. **Clap / echo** — forwarded into `ClapRoom.updateGeneralRoom(..., { speedOfSound })`
   and `updateLive(..., { speedOfSound })`, which pass it to `computeRoomTaps`. So the
   clap's early-reflection timing scales with `c`.
2. **Live beacon / monster** — `renderer.setSpeedOfSound(c)` is called once after the
   renderer is created, so the HRTF propagation-delay `DelayNode` and the Doppler
   pitch use the same `c`. A slow-sound level's beacon literally arrives later and
   Dopplers harder.

A level that omits the field touches neither path (renderer keeps its 343 default,
the clap opts pass `undefined` ⇒ 343), so old levels are unchanged.

Demo levels: **Cathedral** (default c, showcases the long FDN reverb tail) and
**Slow-Sound Vault** (`speedOfSound: 150` — echoes lag, beacon late, strong Doppler).

## Physics

The default is **343 m/s**, the speed of sound in dry air at ~20 °C. It scales
roughly with temperature as `c ≈ 331.3 + 0.606·T` (T in °C): about 331 m/s at 0 °C,
~349 m/s at 30 °C. Humidity and altitude shift it slightly. Doubling `c` halves
every delay (verified by the `doubling_speed_of_sound_halves_delay` unit test).

## Tradeoff / limitation

`speed_of_sound` is a single global scalar applied per solve. It only affects the
**timing** of taps (`delay = dist / c`). It does **not** retune the per-band air
absorption, which is still fixed for normal air. So extreme values are physically
honest for delay/propagation timing only — the timbre (HF rolloff with distance)
stays calibrated for ordinary atmosphere. Use it for propagation-time effects, not
as a stand-in for a different medium's full acoustic behaviour.
