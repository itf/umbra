# Custom audio (recordings on game objects)

Any game object can play a **custom recorded audio file** instead of its synth
voice. The beacon and monsters both do this; future objects use the same helper.

The pattern is always the same: an object owns an `HrtfSource` for spatialization
(distance gain, air lowpass, propagation delay, Doppler, HRTF). Normally a synth
voice (`BeaconVoice`, `MonsterVoice`) feeds that source's `input`. When the object
has a `soundUrl`, we **loop the recording through the SAME input** so it gets the
identical spatial treatment — and **fall back to the synth voice** if the
fetch/decode fails or there is no URL. A custom URL never leaves the object silent.

## The reusable helper — `src/game/customAudio.ts`

```ts
loadCustomLoop(ctx, url, fetchBytes?, decode?): Promise<AudioBuffer | null>
attachCustomLoop(ctx, dest, url, onFallback, opts?): Promise<CustomLoopHandle>
clearCustomAudioCache(): void
```

- **`loadCustomLoop(ctx, url)`** — fetch + decode a URL into an `AudioBuffer`,
  **cached across all callers** by URL. Returns the buffer, or `null` if the URL is
  empty or the fetch/decode failed. A success is cached as the buffer; a **failure
  is cached as `null`** so a known-bad URL is never re-fetched.
- **`attachCustomLoop(ctx, dest, url, onFallback, opts?)`** — the high-level entry
  point. Loads (via `loadCustomLoop`), and on success starts a **looping
  `AudioBufferSourceNode`** through `dest` (an `HrtfSource.input`). On missing-url
  or failure it calls **`onFallback()`** instead. Returns a `{ source }` handle
  (the looping node, or `null` when the fallback ran) so the caller can
  `source?.stop()` on teardown.
  - `opts.shouldStart()` is checked right before starting the buffer, so a caller
    that has since torn down / won / been caught can **veto a late-arriving load**
    (yields a null source, no audio started). Defaults to always-start.
  - `opts.fetchBytes` / `opts.decode` are **injectable** (default
    `globalThis.fetch` + `ctx.decodeAudioData`), which keeps the cache + fallback
    control flow unit-testable without a real `AudioContext`.

### Semantics: fetch → decode → cache → loop → fallback

1. The synth voice starts **immediately** so the object is never silent.
2. If `soundUrl` is set, `attachCustomLoop` fetches + decodes it (cached).
3. On success, the looping buffer plays through the object's `HrtfSource.input` and
   the caller **swaps**: stops the synth voice, keeps the loop.
4. On failure / no URL, `onFallback` runs (a no-op when the synth is already the
   live fallback) and the synth simply remains.
5. `shouldStart` lets the caller drop a buffer that arrives after the object ended.

## How the beacon uses it (`game.ts`)

`startBeaconSource()` always starts the synth preset first, then — if the beacon has
a `soundUrl` — calls `attachCustomLoop` with the beacon's `HrtfSource.input`. On
success it stops the synth `BeaconVoice` and keeps the loop; `shouldStart` vetoes a
buffer that arrives after a win (the beacon has already faded). Behavior is
identical to the previous inline implementation.

## How a monster uses it (`game.ts`)

Each monster starts its synth `MonsterVoice` (`growl`/`hum` via
`resolveMonsterPreset`) immediately. If the monster has a `soundUrl`,
`attachCustomLoop` loops that recording through the **monster's** `HrtfSource.input`
— so it spatializes and **Dopplers as the monster chases**, exactly like the synth
voice would. On success the synth voice is stopped and nulled; on failure / no URL
the growl/hum stays. The one-shot **catch roar stays the synth roar**
(`MonsterVoice.roar`) regardless — it's a deliberate front-and-centre lunge cue.

## Schema field

Both `BeaconObj` and `MonsterObj` carry an optional `soundUrl?: string`
(`src/level/schema.ts`). Absent ⇒ synth voice (back-compat: old levels stay valid;
`isLevel` doesn't require it). `load.ts` forwards it: the beacon's into
`GameLevel.beacon.soundUrl`, each monster's into `MonsterSpawn.soundUrl`.

## Adding custom audio to a NEW object type (the pattern)

1. Give the object an `HrtfSource` and start its synth voice immediately.
2. Add an optional `soundUrl?: string` to its schema object, and forward it in
   `load.ts`.
3. When `soundUrl` is set, call:

   ```ts
   void attachCustomLoop(ctx, src.input, soundUrl,
     () => { /* synth already running as fallback */ },
     { shouldStart: () => !ended && entry.custom == null },
   ).then((h) => { if (h.source) { voice.stop(); entry.custom = h.source; } });
   ```

4. On teardown, `entry.custom?.stop()`.

That's it — the helper owns fetch/decode/cache/loop/fallback; the object only wires
its source + synth fallback.

## What's tested

`tests/customAudio.test.ts` (pure, injected fetch/decode — no AudioContext):

- a missing URL returns null without fetching;
- a successful decode is cached: the same URL returns the same buffer and only
  fetches/decodes **once**;
- a fetch failure and a decode failure each return null and are **cached as null**
  (no refetch);
- `attachCustomLoop` starts a looping source on success (no `onFallback`), invokes
  `onFallback` (null source) on failure / missing URL, and `shouldStart: false`
  vetoes the start (null source, no audio, no fallback).

`tests/load.test.ts`: a monster `soundUrl` round-trips through JSON + `isLevel`,
plumbs into `GameLevel`, and an old monster without it still validates (synth voice).

The live looping audio (the actual node graph, Doppler on a chasing monster, the
beacon swap) is **ear-verified** — vitest has no real `AudioContext` for the loop —
same rationale as `BeaconVoice` / `MonsterVoice`.
