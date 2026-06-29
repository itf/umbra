# Propagation delay + Doppler for live sources

## What this adds

Live `HrtfSource` rendering now models the **time sound takes to arrive**
(`delay = distance / c`) and, as a direct consequence, **Doppler** pitch shift for
moving sources (approaching = higher pitch, receding = lower). Before this change a
source 100 m away was heard instantly and moving sources had no pitch shift.

This is a pure TS-layer change. The Rust/WASM acoustics core (which already bakes
propagation delay into its room IR taps) is untouched.

## Physics: why a delay line, not a computed detune

Doppler is not modelled as a separate "detune by X cents" calculation. Instead it
**emerges** from modulating a delay line — the physically-correct mechanism:

- The pressure wave the listener hears at time `t` was emitted at `t − delay(t)`.
- If the source is approaching, `delay(t)` is shrinking. The listener replays the
  emitted signal faster than it was produced ⇒ pitch goes up. The opposite for
  receding.
- Quantitatively, a variable delay resamples its input by
  `ratio = 1 / (1 + d(delay)/dt)`. For a source approaching at radial speed `v`,
  `d(delay)/dt = −v / c`, so `ratio = c / (c − v)` — exactly the textbook Doppler
  formula for a moving source / stationary observer. This identity is asserted in
  `tests/propagation.test.ts` (`delayResampleRatio` vs `dopplerRatio`).

The Web Audio `DelayNode` does this resampling for us: smoothly changing
`delayTime` makes it interpolate between buffered samples, producing the shift "for
free." There is no second code path computing pitch — keeping the two in sync would
be a perpetual bug source, and a computed detune wouldn't be coupled to the actual
arrival lag.

## Where the DelayNode sits

```
input → propDelay → distanceGain → airLowpass → [convolver chainA / chainB] → output
        ^^^^^^^^^
        createDelay(maxDelaySec), delayTime = clamp(dist / speedOfSound)
```

`propDelay` is placed **right after `input`, before everything else**. Reasons:

- It must act on the dry mono source before the HRTF convolvers so the whole signal
  (and its Doppler-shifted spectrum) is then spatialised normally.
- Putting it ahead of `distanceGain` / `airLowpass` means those still track the same
  distance; the delay is purely the arrival-time term and doesn't interfere with the
  existing gain/lowpass `setTargetAtTime` ramps or the dual-convolver crossfade,
  which are unchanged.

## The maxDelay cap

`createDelay(maxDelaySec)` must be sized up front. Default
`DEFAULT_MAX_DELAY_SEC = 2` s ≈ **686 m** at 343 m/s — far beyond any plausible game
scene. Configurable via `HrtfRenderer.create(ctx, url, { maxDelaySec })`. Sources
farther than `maxDelaySec × c` have their delay **clamped** to the cap (they still
play, just without extra honest lag). Raising the cap only costs a little memory per
source.

## Time-constant tuning (the heart of the effect)

`setPosition` ramps `delayTime` toward `dist / c` with
`setTargetAtTime(target, now, DOPPLER_TAU)`, `DOPPLER_TAU = 0.05 s`.

This time-constant is the key tradeoff:

- **Short tau (tight tracking):** the delay follows motion closely ⇒ **strong,
  responsive Doppler**, but too short and per-frame position jumps cause audible
  zipper/clicks as the delay snaps.
- **Long tau (loose tracking):** smooth and artifact-free, but the delay lags real
  motion so the **Doppler washes out** (the pitch shift is smeared away).

`0.05 s` is the chosen sweet spot: enough smoothing to avoid zipper from
frame-quantised positions, fast enough that normal walking/running motion produces a
clearly audible shift.

The **first** placement uses `setValueAtTime` (a hard snap) instead of a ramp, so a
newly-created source doesn't audibly swoop in from zero delay. After that, every
update ramps — so a static source's delay simply settles to a constant and produces
**no pitch artifact at rest**.

## How speedOfSound flows in

- `HrtfRenderer.speedOfSound` defaults to `DEFAULT_SPEED_OF_SOUND` (343), the same
  shared constant from `src/engine/acoustics/core.ts` used by the acoustics solver
  (see `docs/engine/speed-of-sound.md`). One concept, one default, both layers.
- `setSpeedOfSound(c)` mutates it; the next `setPosition` recomputes `dist / c`, so
  changing it makes live sources audibly arrive later/sooner (and changes the
  Doppler magnitude for a given speed — a faster medium ⇒ weaker shift).
- `HrtfSource.setPosition` reads `this.r.speedOfSound` each call — no per-source copy
  to keep in sync.

## Pure helpers (`src/engine/hrtf/propagation.ts`)

The physics is extracted into pure, dependency-free functions so it is unit-tested
deterministically (vitest has no Web Audio):

- `propagationDelaySec(dist, c)` — `dist / c`.
- `clampDelaySec(delay, maxDelaySec)` — the DelayNode cap.
- `dopplerRatio(vRadial, c)` — textbook prediction `c/(c−v)`.
- `delayResampleRatio(dDelayDt)` — what a delay line produces; proven equal to the
  textbook ratio.

## What's tested vs what needs ear-verification

**Unit-tested (`tests/propagation.test.ts`, deterministic):**

- `delay == dist / c`, defaulting to 343, and slower `c` ⇒ later arrival (halving
  `c` doubles delay).
- maxDelay clamp and the 2 s ≈ 686 m relationship.
- Doppler sign (approach ⇒ >1, recede ⇒ <1, rest ⇒ 1) and the identity that the
  delay-line resampling ratio equals the textbook Doppler ratio.

The bare vitest environment ships **no `AudioContext` / `OfflineAudioContext`** (the
existing suite renders the room IR with a pure JS builder, never Web Audio), so the
live DelayNode resampling is not rendered in CI today. It is not strictly impossible
— an `OfflineAudioContext` polyfill (e.g. `node-web-audio-api` / `standardized-audio-context`)
could render a swept `delayTime` against a sine and FFT the output to confirm the
DelayNode actually resamples — but that pulls in a heavy dependency to verify one
effect that is already ear-verified, so we deferred it. The math the effect rests on
is fully tested above.

**Ear-verified on the debug page:** the actual DelayNode Doppler on a moving source
— move a source past the listener and confirm the audible approach-high/recede-low
sweep, and that changing the speed of sound shifts arrival lag and Doppler strength.

## Limitations

- **Teleporting a source** (large instantaneous position jump) makes `delayTime`
  ramp across a big gap and can produce a brief pitch glitch / sweep. If you need to
  hard-relocate a source without a Doppler swoop, recreate it (first placement snaps)
  or expose a snap path.
- **Very fast motion** can drive `delayTime` to change faster than the smoothing
  absorbs, causing artifacts; extreme speeds approaching `c` are a singularity
  (`dopplerRatio` → ∞, a sonic shock) and not meaningfully renderable.
- The delay models the **direct path only**. Reflections/Doppler on echoes come from
  the acoustics core's baked IR, not this live delay line.
- Air absorption (the lowpass) is not retuned for non-standard `c`; same caveat as in
  `docs/engine/speed-of-sound.md` — `c` affects timing, not timbre.
