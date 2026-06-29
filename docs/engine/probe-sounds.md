# Probe ("echo") sounds

The **probe** is the excitation we fire through a scene's room impulse response to
reveal its reflections — historically a single hardcoded ~10 ms noise clap. This
makes the probe **selectable**, including the player's own **recorded** sound,
because different probes reveal reflections differently:

- a sharp **transient** (click/snap) is best for *timing* and *direction* — you
  hear the gap between the direct sound and the first reflection;
- a **sustained** hiss makes *faint* reflections audible because energy keeps
  feeding the room while the early echoes return.

## The probe model

A probe produces a short **mono excitation buffer** that is fed into the existing
`ConvolverNode` whose impulse response is the scene's room IR (from the WASM
image-source solver + HRTF). Nothing about the acoustics pipeline changes — the
probe only shapes the *dry* signal that excites it.

Three shapes of probe are supported (`ProbeSpec` in `src/debug/scenePlayer.ts`):

| Spec | Meaning |
|------|---------|
| `'clap' \| 'click' \| 'hiss' \| 'snap'` | a synth preset (pure generator) |
| `{ url }` | a recorded file, fetched/decoded/cached via `loadCustomLoop` |
| `{ buffer }` | a pre-decoded recording (e.g. a user-picked `File`) |

## Synth presets

The synth presets live in `src/debug/probes.ts` as **pure** functions
`(sampleRate: number) => Float32Array` — no `AudioContext`, so the buffer shape is
unit-testable. The noise *samples* use `Math.random` (these are excitations, not
exercise content), but the **length and envelope are deterministic** in the sample
rate, which is what the tests assert.

| Preset | Length | Character | Synthesis sketch |
|--------|--------|-----------|------------------|
| **clap** (default) | ~10 ms | the classic broadband burst | white noise × a squared linear fade — byte-compatible with the old hardcoded clap |
| **click** | ~3 ms | very short, crisp tongue-click | fast attack + sharp exp decay; mostly noise with a little tone for body |
| **hiss** | ~220 ms | sustained "shh", faint echoes ring out | lightly low-passed white noise under a raised-cosine (Hann) window — zero at both edges, no click |
| **snap** | ~12 ms | bright snappy finger-snap | fast noise burst + a short resonant ~2.2 kHz ping with exp decay |

`PROBE_PRESETS` lists `{ name, label, hint }` for UI pickers; `resolveProbe(name)`
returns the generator and **falls back to `clap`** for unknown/missing names.

## Recorded-probe path

`ScenePlayer.setProbe({ url })` reuses the shared
`loadCustomLoop(ctx, url)` helper from `src/game/customAudio.ts` (the same
fetch + decode + cache + fallback flow beacons/monsters use). The decoded buffer is
cached across callers; a failed load is cached as `null` and **falls back to the
synth `clap`** at fire time, so a missing/broken recording never breaks playback.

For a user-picked **File** (no URL), `ScenePlayer.decodeFile(file)` decodes the
Blob via `ctx.decodeAudioData`; the resulting buffer is passed back as
`{ buffer }`. The trainer decodes the file once on pick and reuses it.

## How the trainer / debug expose it

- **Trainer** (`trainer.html` / `trainer.ts`): a labelled `<select>` of
  `PROBE_PRESETS` plus a *Custom recording…* option with a URL text field and a
  file input (`accept="audio/*"`). The selected probe is applied to **both Room A
  and Room B** before each clap (`applyProbe`), so the A/B comparison stays fair.
  Labels + the existing aria-live region keep it eyes-free / screen-reader friendly.
- **Debug** (`debug.html` / `debug.ts`): a small *Probe* `<select>` next to the
  Clap button; the chosen preset is set on the player before firing.

## Clap position ("claps in different places")

The clap fires from the scene's **clap-source `pos`** — `refreshIr()` already
computes the room IR with `source: clap.pos`, so placing the clap source elsewhere
(ahead, to the side, off-centre) genuinely changes the reflection pattern you hear.
No head-centred assumption is baked in. A scene/exercise can therefore offer
"clap ahead / clap to the side" simply by moving that source's `pos`.

**Deferred:** no new UI control for moving the clap was added (the trainer's
exercises set positions through the scene generator already). What's proven instead
is the underlying claim — see the test below.

## What is tested

`tests/probes.test.ts` (pure, no Web Audio):
- every preset is non-empty, finite, non-zero energy;
- length ordering **click < clap < snap < hiss**, hiss > 100 ms, click < 10 ms;
- lengths scale with sample rate (deterministic in `sr`);
- `hiss` starts and ends at (near) zero — no edge click; transients start near zero;
- `resolveProbe` falls back to `clap` for unknown/missing names; `isProbeName` guard.

`tests/scenePlayerProbe.test.ts` (fake graph, no real `AudioContext`):
- recorded `{ url }` load **failure** → player fires a synth-clap buffer;
- recorded `{ url }` **success** → fires the recorded buffer, served from cache (one fetch);
- `decodeFile` decodes a Blob via the context; `{ buffer }` probe is fired directly;
- **clap position**: two clap-source positions in the same room yield different
  `computeRoomTaps` (delay + bearing) — proving a clap in a different place changes
  what you hear.

Ear-verified: the actual *character* of each probe.
