# Audio artifacts & clipping — verification harness + master limiter

The player reported **clicks / zipper / crackle** when walking or rotating fast,
and worried about **clipping**. The existing suite asserts on captured samples and
physics, but it runs under vitest which has **no Web Audio** — so it cannot catch
runtime audio-thread artifacts (a `ConvolverNode.buffer` swap glitch, a `DelayNode`
`delayTime` zipper, an ungated gain jump) or destination clipping. This harness
closes that gap.

## Artifact classes & where each originates

| Class | Audible as | Origin in this engine |
|------|------------|-----------------------|
| **Click** | a sharp tick | Swapping a `ConvolverNode.buffer` mid-signal (HRIR direction change in `renderer.ts`; room-IR swap in `clapRoom.ts`). Both already mitigate it with a **dual-convolver equal-power crossfade** + a rate-limit. |
| **Zipper** | a buzzy ramp | `propDelay.delayTime` ramping hard when a source whips past (Doppler path, `renderer.ts`). Smoothed with `setTargetAtTime(DOPPLER_TAU=0.05)`. |
| **Crackle / fart** | gritty modulation | Re-triggering a fresh crossfade every direction change during a fast spin. Avoided by the `FADE`-window rate-limit (refresh the incoming buffer in place instead of starting a new ramp). |
| **Glide discontinuity** | a snap | The audio-listener pose jumping between footfalls. `listenerGlide.ts` interpolates the pose (easeOutCubic) and retargets from the *current* interpolated pose, so legal-fast stepping never snaps. |
| **Clip** | hard distortion | Beacon + footsteps + room reverb (+ future monster) summing past ±1.0 at the bare `GainNode → destination` master. **This was unprotected.** Fixed (Part B). |

## Offline-render harness

`tests/audioArtifacts.test.ts` + `src/engine/analysis/artifacts.ts`.

- **Web Audio in Node**: `node-web-audio-api` (native Rust-backed) provides a real
  `OfflineAudioContext`. The suite imports it dynamically and **skips the
  render block with a clear message** if it can't load on a platform (CI stays
  green); the pure detector unit-tests always run.
- It builds the **real engine graph** inside the offline context — `HrtfRenderer`
  (via the new additive `HrtfRenderer.fromSet`, which mirrors `create` minus the
  network fetch) + an `HrtfSource`, and the `ClapRoom` dual-convolver path — loads
  the real ~5.5 MB SADIE `.hrtf` from disk (as `spatial.test.ts` does), inits the
  acoustics WASM (`mod.default(bytes)` **and** `initAcoustics()` — the latter wires
  the core binding; omitting it leaves `computeRoomTaps` on an uninitialized
  instance and OOMs), then renders stress scenarios while injecting timed pose/IR
  updates via `ctx.suspend(t).then(...)` (quantized to 128-sample render blocks).

### Click-detection metric

`detectClicks(buf)` scans first differences `|x[n]-x[n-1]|` and normalizes each by
the **local RMS** over a ±64-sample window, **excluding a ±3-sample guard** at `n`
(so a 1–3-sample transient is measured against its surroundings, not against
itself). The ratio is amplitude-independent: a quiet click is still flagged.

- A band-limited sine's per-sample step is `≈ 2π·f/fs × amp`; at 1 kHz/48 k that's
  `≈ 0.18 × localRMS` → ratio ≈ 0.18.
- An equal-power crossfade between two correlated tones stays comparably smooth.
- A real buffer-swap click steps several × the local RMS → ratio ≫ 8.

**Thresholds**: synthetic unit tests use ratio **8** (clean sine & a proper
equal-power crossfade PASS; an injected spike is flagged). The real-render
scenarios use **25** — the convolver HRIR tail + delay resampling add legitimate
high-slope content, while a true swap click is far larger, so this still catches
real artifacts without false alarms. `clipCount(buf, limit)` counts `|x|>limit`.

**On the 25 threshold and its sensitivity gap**: the observed worst ratio across all
real-render scenarios is **4.1** (room-IR swap), so the 25 ceiling leaves a wide margin
— a regression that introduced an audible click (which steps well past local RMS, ratio
≫ 25) is reliably caught. The deliberate tradeoff: a *small* click in the 8–25 band would
pass the offline scenarios (only the synthetic suite guards the 8 boundary). 25 is chosen
high enough that the legitimate HRIR/delay high-slope content never false-alarms; tightening
toward the 4.1 margin would catch subtler regressions but risks flagging benign renders.
Revisit if a real artifact ever lands in that band.

### Scenarios & results (this environment, Node 22 / linux x64)

| Scenario | What it stresses | Result | worst click ratio |
|----------|------------------|--------|-------------------|
| **Fast rotation** — listener yaw spins 720°/s, fixed source ahead | dual-convolver crossfade + rate-limit | **PASS** (0 clicks, bounded) | 1.3 |
| **Fast walking** — source whips z=−10→+10 in 0.5 s (40 m/s) | `propDelay` zipper / Doppler | **PASS** (0 clicks, bounded) | 1.3 |
| **Glide retarget storm** | listener-glide rapid retargets → pose stream | covered by `listenerGlide.test.ts` (pure) + the rotation/walking pose streams | — |
| **Room IR swap** — moving wall, repeated IR crossfade + claps | `ClapRoom` dual-convolver swap | **PASS** (0 clicks) | 5.6 |
| **Limiter** — 4 loud tones summed | clipping | **PASS**: raw clips 2790 samples, peak 2.24; **limited 0 clips, peak 0.835** | — |

**No real artifact found** in the renderer/clapRoom crossfade or delay paths under
these stresses — the existing dual-convolver crossfade + rate-limit + `DOPPLER_TAU`
smoothing hold up. The one **real** finding was the **unprotected master** (clip),
fixed below.

## Master limiter (clipping fix) — `src/engine/audioGraph.ts`

`master (GainNode 0.9) → destination` had no limiter; summed peaks hard-clipped.
New chain: **`master → DynamicsCompressor (limiter) → WaveShaper (safety clip) →
destination`**. The master gain knob is preserved.

- **`makeLimiter`** — `DynamicsCompressorNode`: threshold **−3 dBFS**, knee **0**
  (hard), ratio **20** (limiter, not gentle comp), attack **3 ms**, release
  **100 ms**. Pulls down sustained over-level transparently, no pumping.
- **`makeSafetyClip`** — `WaveShaperNode` with curve `tanh(1.2·x)`, `oversample
  '4x'`. **Why both:** a compressor has *no look-ahead*, so the first sample-block
  of an aligned-onset transient overshoots before the attack engages — measured up
  to **~2.0** in the harness. `tanh` is near-linear for small `|x|` (quiet audio
  untouched) and saturates smoothly to ±tanh(1.2)≈±0.83, so **any** input —
  including that overshoot — emerges strictly within [−1, 1] with **no hard-clip
  discontinuity** (a hard clip would itself click). The harness asserts the
  pre-limiter sum clips (proving the limiter does work) and the limited output has
  **0 clipped samples**.

## What's automated vs needs ear/browser

- **Automated**: discontinuity (click) detection on real rendered output for fast
  rotation, fast walking, and room-IR swaps; clip boundedness with the limiter;
  detector calibration on synthetic clean/clicky signals.
- **Needs ears / a browser**: subjective timbre of the crossfade and Doppler,
  limiter "feel" under real gameplay mixes, and any artifact specific to a real
  `AudioContext`/`AudioWorklet` scheduler that the offline render doesn't reproduce.
  Manual procedure: open the debug page, drive a fast spin + a fast walk past the
  beacon + a clap in a moving-wall level, and listen on headphones.

## Perf headroom

- **Per-frame** (`Game.tick`): `glide.tick` is pure pose interpolation (a few µs;
  a **no-op when idle**) + `applyAudioPose` (a handful of AudioParam sets). No
  buffer builds, no convolution, no WASM on the frame path — confirmed by reading
  `game.ts` / `listenerGlide.ts`.
- **Room rebuild** (`ClapRoom.updateLive`): throttled to **~14 Hz** (`minIntervalMs
  70`) with a dirty-check, *not* per frame; ~6–7 ms each (previously measured), so
  it stays well under a frame budget.
- **Offline render cost** (informational, from `node-web-audio-api`): the 0.5 s
  HRTF stress renders complete in **~10–22 ms**; the 0.4 s room-IR-swap render
  (12 WASM rebuilds + dual convolvers) in **~230 ms** of wall-clock — render-time,
  not real-time load.
