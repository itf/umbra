# Audio regression investigation (fb183e3..HEAD)

Read/diagnose only — no code changed. Two regressions investigated.

Engine map for reference:
- `?engine=ours` (default): `ModeledSource` (src/engine/acoustics/modeledSource.ts)
  driving the click-free interpolating HRTF worklet (src/engine/hrtf/*). The
  beacon's dry voice feeds `beaconProxGain → beaconInput (= ModeledSource.input)`.
- `?engine=steam`: `SteamAudioBackend` (src/engine/steamaudio/backend.ts).
- Master chain: `master (GainNode) → DynamicsCompressor limiter → tanh safety clip`
  (src/engine/audioGraph.ts:37). Limiter: threshold **-3 dBFS**, ratio 20, attack
  3 ms, release 100 ms.

---

## Regression 1 (HIGH): default beacon crackles at rest

### What was ruled OUT (with evidence)

- **Interpolating HRTF worklet (suspect #2): clean.** `hrtfWorklet.ts:49` calls
  `dsp.setDirection(...)` every block unconditionally, and `setDirection`
  (interpolatingDsp.ts:292-294) swaps `cur↔prev` every block. But at a FIXED
  direction the recomputed `curL/curR` are bit-identical to `prevL/prevR` (knn is a
  pure function of the direction), so the per-block crossfade is an identity and
  produces no discontinuity. I confirmed this with an offline probe: 400 blocks of a
  440 Hz tone at a fixed direction through `HrtfDsp`, measuring max per-sample step
  in the output. Result: **maxJump = 0.0152, below the expected smooth per-sample
  delta of 0.0288** for that tone — i.e. no extra discontinuity injected. The worklet
  is quiescent at rest. (This matches the brief: it predates fb183e3.)

- **`ModeledSource` DSP path: unchanged since fb183e3.**
  `git log fb183e3..HEAD -- src/engine/acoustics/modeledSource.ts roomIr.ts
  interpolatingRenderer.ts` is **empty**. The modeled-beacon solve/crossfade/reflect
  path is byte-identical to the clean baseline, so it is not the regression.

- **Warmer cue re-scheduled every frame at rest (suspect #1): does NOT happen.**
  `reportProgress()` (game.ts:507) — which re-ramps `beaconProxGain` — is called only
  from `syncListener`, `setYaw`, `setWarmerCue`, and `step` — i.e. on step/turn, never
  from `tick()` (game.ts:554; `tick` does NOT call `reportProgress`). Keyboard turning
  (main.ts:810-826) only calls `setYaw` while `heading.tick()` returns true, i.e. while
  actively slewing; `Heading.tick` (heading.ts:130) returns false once settled
  (`|diff| < 1e-4`). So at rest the proximity gain is NOT re-scheduled, and there is no
  per-frame scheduling churn. `proximityGain` (beaconSounds.ts:111) is pure and finite
  (NaN-guarded), constant at a fixed distance — no jitter.

- **Companion/TTS (suspect #3):** not a continuous audio-thread signal; not crackle.

### Root cause (most defensible)

The regression is the **steady-state gain boost** the warmer cue applies, not
scheduling churn. Commit **`006e625`** added the "getting warmer" cue; **`491b969` /
`04a1b21`** refactored it into a shared `beaconProxGain` GainNode interposed between
the dry beacon voice(s) and the spatializer input
(game.ts:399-401 `startBeaconSource`, game.ts:431 `startSynthBeacon`).

`beaconProxGain.gain` ranges **1.0 → 1.8×** (`proximityGain` `maxGain = 1.8`,
beaconSounds.ts:111-125). When you stop NEAR the beacon, that gain settles at up to
**1.8× (≈ +5 dB)** and stays there while stationary.

The dry synth voice already runs near full scale before the boost:
- the `chord` preset sums harmonics (amps 1.0/0.4/0.22/… each ×0.5) → `mix.gain 0.5`
  → `out.gain 1` (beaconSounds.ts:~80-114), peaking near ±1.0 and amplitude-beating;
- the default tone has a 1.6 Hz tremolo LFO (`trem.gain 0.5 ± 0.5`,
  beaconSounds.ts:57-65), so its envelope swings 0→1.0.

Multiplying that by 1.8× pushes the dry beacon to ~+5 dB over full scale, sustained,
RIGHT before the HRTF convolution. Web Audio is float internally (no hard clip at the
convolver), but the over-range signal then hits the master limiter
(audioGraph.ts:37): threshold -3 dBFS, ratio 20, **attack 3 ms**. A sustained +5 dB
input keeps the limiter in continuous heavy gain reduction, and its 3 ms attack tracks
every tremolo/chord-beat peak → audible **gain pumping / crackle**, plus harmonic
distortion from the downstream `tanh(1.2·x)` safety clip on the peaks. This is heard
while parked near the beacon — i.e. "even when not moving" — and is genuinely NEW in
fb183e3..HEAD (the 1.8× node did not exist at fb183e3).

Severity scales with proximity (worst right at the goal) and is loudest on the
`chord`/tremolo presets, which is consistent with "a bit of crackling."

### Cheapest fix (recommended; pick one)

1. **Add headroom so the boosted peak can't exceed unity (preferred).** Lower the
   beacon dry level by the cue's max boost: in `startBeaconSource`
   (game.ts:399-401) start `beaconProxGain.gain` mapped into **[1/1.8 … 1.0]** instead
   of [1.0 … 1.8]. Concretely, scale `proximityGain`'s output by `1/1.8` at the call
   site (game.ts:521) — `const g = (this.warmerCueOn ? proximityGain(d) : 1) / 1.8;` —
   so near = unity and far = ~0.55× (quieter when far, never boosted over unity).
   Keeps the loudness CONTRAST that conveys "warmer" while guaranteeing the spatializer
   never sees > full scale. Net level can be trimmed back at `graph.master` if desired.

2. **Reduce the boost range.** In `proximityGain` (beaconSounds.ts:114) drop
   `maxGain` from **1.8 → ~1.25** so the worst-case sustained over-range is ~+2 dB
   rather than +5 dB. Cheaper but only mitigates.

3. **Trim the dry voice.** Lower `BeaconVoice` `out.gain.value` (beaconSounds.ts:17)
   from `1` to ~`0.55` so even ×1.8 stays ≤ unity. Equivalent to (1) but global.

Option 1 is the smallest, most targeted change and preserves the warmer-cue contrast.
Verification: extend `tests/audioArtifacts.test.ts` with a STATIONARY render — beacon
near the listener, listener fixed, `warmerCueOn`, render ~1 s — and assert
`clipCount`/limiter gain-reduction stays near zero and `detectClicksStereo` is clean.

---

## Regression 2 (MEDIUM): Steam path mazes hard to navigate

### Current values (read from source)

- **Transmission (the leak-through-walls term):**
  `DEFAULT_TRANSMISSION = [0.02, 0.015, 0.01]` (3-band) in
  src/engine/steamaudio/convert.ts:53, applied to every wall material
  (convert.ts:79-84, used at convert.ts:217). Direct-path simulation uses
  `transmission: { type: 'frequency-dependent' }` and `occlusion: 'raycast'`,
  `occlusionSamples: 32` (backend.ts:190-194).
- **Reflections / reverberant field (the geometry/echo cues):**
  world build `maxOrder: 2`, `maxDuration: 1.0 s`, `maxRays: 4096`,
  `diffuseSamples: 1024` (backend.ts:139-144). Per-source reflected field
  `reflections: { wet: 0.25 }` (backend.ts:202). Bus sends:
  `connectReflections(..., { gain: 0.35 })` and `connectReverb(..., { gain: 0.2 })`
  (backend.ts:212-213). Buses created at `reflectionBus wet:1`, `reverbBus wet:0.5`
  (backend.ts:147-148).
- **Wall sidedness — CONFIRMED correct, NOT the bug.** Interior walls are built by
  `interiorWall()` (src/level/load.ts:210-219) which ALWAYS sets `doubleSided: true`
  (load.ts:218); convert.ts then emits those as a **thin box** that occludes/reflects
  from both faces (convert.ts:175-177 `wallMeshData`). So interior maze partitions DO
  occlude from both sides. Double-sidedness is not the leak.

### Is it a regression in fb183e3..HEAD?

**Not a fb183e3..HEAD regression** — `git log fb183e3..HEAD -- backend.ts convert.ts`
is empty; both files last changed at/around **2ce7589**, which predates this cycle's
beacon work. This is a **pre-existing tuning + wrapper-architecture issue**. 2ce7589
deliberately LOWERED the reflected field globally (`reflections.wet 0.25`, sends
0.35/0.2) to fix "beacon always reads in front." That was the wrong lever (see below):
it killed the symptom by suppressing MATERIAL-DRIVEN reflection energy everywhere,
making every room equally dry and starving corridors of the echo cues a maze needs.

### Root cause of the "always in front" masking, and why the 2ce7589 fix was wrong

I read the wrapper internals to check whether the reflected field can be head-tracked:

- **The reflected/reverb field is rendered MONO and duplicated to both ears — it is
  dead-center and does NOT rotate with the head.** In
  `node_modules/three-steam-audio/dist/steam-audio-processor.js` the reflection/reverb
  effect (`_sa_reflection_effect_apply`, lines ~258-272) is the **parametric Eyring
  reverb** path: it takes only a mono input + a 3-band `reverbTimes` vector — **no
  listener orientation, no ahead/up vectors, no ambisonic coefficients**. Its output is
  then written identically to L and R (lines ~308-312:
  `reflectionLeft = reflectionRight = reflectionSample`). There is **no ambisonic
  symbol anywhere** in the package (`grep -i ambisonic` → nothing). So a loud reflected
  field sits centered/diffuse in front and masks the (correct) head-tracked binaural
  DIRECT path — that is the real cause of "always in front," exactly as hypothesized.

- **Head-tracking the reflected field is NOT possible in this wrapper.** This is
  `three-steam-audio@0.1.0-beta.1`. Steam Audio's SDK supports an ambisonic
  ray-traced reflection effect that WOULD rotate with the listener, but this wrapper
  does not expose/compile it — it only exposes the parametric reverb effect, whose
  per-source output is a 3-band reverb-time triple
  (reflection-simulator-worker.js:142-153 `_sa_source_get_reflection_outputs` →
  `reverbTimes` only). **Recommendation #1 (head-track the reflected field) is
  therefore infeasible with the current dependency.** It would require either upgrading
  to / forking a `three-steam-audio` build that exposes the ambisonic reflection effect
  and an ambisonic→binaural decode rotated by `listener.orientation`, or bypassing the
  bus and rendering Steam's reflection IR through our OWN renderer. Both are large.

- **Reflection LEVEL *is* material-driven (good news).** Per-wall absorption +
  scattering from convert.ts feed the ray-traced simulator
  (reflection-simulator-worker.js:43-62 `createStaticMesh` passes `absorption`,
  `scattering`, `materialIndices`), and the sim returns the per-source `reverbTimes`
  that set the parametric field's decay/strength. So a concrete S-bend already wants
  long, strong echoes and carpet wants short ones — **the material differentiation
  exists in the sim**. The flat `wet`/send scalars (backend.ts:202/212-213) then scale
  that whole field down UNIFORMLY, which is precisely the 2ce7589 mistake: it throttles
  the material-driven energy with a global constant instead of fixing placement.

### Recommendation (priority order)

1. **Head-track the reflected field — INFEASIBLE in this wrapper.** Stated explicitly
   as a wrapper limitation (see above). Worth a backlog spike: evaluate a
   `three-steam-audio` build (or fork) exposing the ambisonic reflection effect; only
   then can full-strength, material-driven reflections return without re-masking
   direction. Until then, fall through to the tuning below.

2. **Lower transmission — do this regardless; it's the primary maze-killer.**
   `DEFAULT_TRANSMISSION = [0.02, 0.015, 0.01]` (convert.ts:53) lets the direct beacon
   bleed audibly THROUGH interior walls, so in an S-bend the beacon's apparent direction
   points straight at the goal through the partition rather than at the opening —
   ambiguous exactly where the maze needs it sharp. Interior walls already occlude both
   sides (confirmed), so the leak is purely the transmission coefficient.
   **Recommend ~5× lower: `[0.004, 0.003, 0.002]`** (keep non-zero so a thin wall isn't
   acoustically invisible). This sharpens "where is the opening" independent of the
   reflection problem and is the single highest-value change.

3. **Least-bad reflection tuning, given (1) is blocked.** Because the field can't be
   placed correctly, we're stuck trading "geometry cues" against "direction masking"
   with one global knob. Two viable paths:
   - **(a) Modest global raise** for some corridor feel: `reflections.wet 0.25 → ~0.32`,
     reflect send `0.35 → ~0.42`, reverb `0.2 → ~0.25` (backend.ts:202, 212-213), keeping
     it clearly below the direct path so "always in front" doesn't return. A/B head-turn
     localizability after each nudge. This is a compromise, not a fix.
   - **(b, preferred) Make the reflection send LEVEL-DEPENDENT** rather than a flat
     global. Since the masking comes from the field being centered, the safe way to give
     mazes more echo is to raise the send ONLY where direction is less load-bearing or
     where geometry cues matter most — e.g. a higher reflect send for `kind:'maze'`
     levels and the lower value for open rooms (plumb a per-level `reflectionSend` from
     the level def through `SteamBackendOpts` → backend.ts:212). This restores
     corridor echo for mazes while leaving open rooms at the direction-clear setting.
     It does NOT fix placement, but it stops one global number from having to serve both
     room types.

This is the optional engine (default is the interpolating one), so the bar is
"navigable + useful A/B," not perfect. Concrete cheapest near-term combination:
**(2) lower transmission to `[0.004,0.003,0.002]`** + **(3b) per-level reflection send,
higher for mazes** — and file the ambisonic-reflection wrapper upgrade (1) as the real
long-term fix.
