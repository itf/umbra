# Beacon sounds

The navigation beacon used to be a single pulsed sine. It now has a small library
of synthesized **presets** plus an optional **custom audio file** per beacon.
Richer, harmonically-complex, slowly-evolving sounds localize better and fatigue
the ear less than a pure tone.

## The model

`src/game/beaconSounds.ts` mirrors the hybrid pattern of `stepSounds.ts`:

- **Pure recipe logic** (preset tables, partial/pitch math, the music-box motif)
  lives as plain data + functions and is unit-tested — no Web Audio needed.
- **`BeaconVoice`** builds the live node graph for a preset. Whatever the preset,
  it sums to **one mono output** which is connected to a caller-provided
  destination.

In the game that destination is the beacon's `HrtfSource.input`
(`src/engine/hrtf/renderer.ts`). So the preset only shapes the *dry* signal; the
existing distance gain, air lowpass, propagation delay, Doppler, and HRTF
convolution are all applied downstream, unchanged and shared by every preset. The
beacon also still fades out on win exactly as before (`beacon.output.gain`).

```
BeaconVoice (preset graph) ─► HrtfSource.input ─► [propDelay → distanceGain →
   airLowpass → HRTF convolvers] ─► output ─► master
```

`BeaconObj.freq` continues to tune pitched presets (it is the base note for
`bell`/`musicbox`/`drip` and the drone root for `hum`).

## Presets

All exposed by name via `beaconPresetNames()`; `resolveBeaconPreset(name)` maps an
unknown/missing name to the default.

| Preset     | Character                       | Synthesis sketch |
|------------|---------------------------------|------------------|
| `tone`     | Legacy pulsed sine (DEFAULT)    | One sine + a 1.6 Hz tremolo LFO on a gain. Byte-identical to the original `game.ts` beacon. |
| `pulse`    | Alias of `tone`                 | Same graph (back-compat name). |
| `bell`     | Struck metallic ring            | A few **inharmonic** partials (`bellPartials`: hum 0.5×, prime 1×, tierce 1.2×, quint 1.5×, nominal 2×, +upper) each an exp-decaying sine; re-struck every ~2.4 s. |
| `musicbox` | Bright plucked melodic motif    | One note per trigger walking the motif `[root, fifth, octave, fifth]` (`musicboxNotes`); triangle fundamental + soft octave, fast exp decay, ~0.42 s apart. |
| `drip`     | Water drip                      | A sine swept down (~2.4× → ~0.9×) through a bandpass with a fast pluck envelope; per-drip random pitch jitter; ~1.1 s apart. |
| `hum`      | Continuous low drone (easy)     | Root an octave below `freq` + 2nd/3rd harmonics, shared **slow vibrato** (0.18 Hz on detune). Good default for an always-on beacon. |

`bell`, `musicbox`, and `drip` are **pulsed** (re-triggered on an interval from
`beaconTiming`); `tone`/`pulse`/`hum` are **continuous**. `start()`/`stop()` drive
the loop and tear down oscillators / the interval.

## Custom audio file

If `BeaconObj.soundUrl` is set, the game fetches → `decodeAudioData` → caches the
buffer (a static `Map` keyed by URL, mirroring the recorded-sample path in
`footsteps.ts`), then loops it through the *same* `HrtfSource`. While the file is
loading the chosen synth preset plays as an immediate fallback; when the buffer
arrives it swaps to the looped audio. If the fetch/decode fails, the URL is cached
as failed and the synth preset simply remains. So a custom URL never leaves the
beacon silent.

## Schema + back-compat

`BeaconObj` gains two optional fields (`src/level/schema.ts`):

- `sound?: BeaconPreset` — the preset name.
- `soundUrl?: string` — the optional custom audio file.

`isLevel()` back-fills every beacon's `sound` via `resolveBeaconPreset`, so old
levels (no `sound`) and any unknown value normalize to `'tone'` — byte-identical
to the original beacon. `load.ts` forwards `sound`/`soundUrl` from the first
beacon into the `GameLevel`.

## Editor

The beacon properties panel (`src/editor/editor.ts`) adds:

- a **sound** dropdown (the preset names),
- a **custom url** text field (blank clears it), and
- a **Preview sound** button — plays the selected preset for ~2.5 s through a
  throwaway `AudioContext` (synth only; it does not fetch the custom URL).

All three round-trip through save/load and JSON export/import.

## What's tested vs ear-verified

- **Unit-tested** (`tests/beaconSounds.test.ts`): bell partial frequencies scale
  with the base and are inharmonic; semitone/music-box pitch math; preset lookup
  falls back to the default for unknown/missing names; preset list + timing;
  schema back-fill defaults old beacons to `tone`; `sound`+`soundUrl` round-trip
  through JSON.
- **Ear-verified** (the live `BeaconVoice` graph): the test env has no
  `AudioContext`, so the actual node wiring, envelopes, and the loud-vs-distinct
  balance of each preset are confirmed by listening, not by a test.
