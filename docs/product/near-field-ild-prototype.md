# Near-field per-ear distance ILD — prototype + validation

**Status:** PROTOTYPE ONLY. Pure function + passing vitest. NOT wired into the renderers.
The coordinator decides integration. Files added:
- `src/engine/hrtf/nearFieldIld.ts` — the pure model.
- `tests/nearFieldIld.test.ts` — the three validations (+ guards). 6/6 pass; 626 total (was 620).

## 1. Confirmed reference distance r_ref = **1.2 m**

How I got it: parsed `assets/hrtf/sadie_h3_48k.sofa` with **h5wasm** (already a devDependency,
the same lib `scripts/bake-hrtf.mjs` uses) and read the `SourcePosition[M][3]` dataset. All
**2818** directions have the 3rd column = **1.2** (min == max == 1.2). The dataset's `Units`
attribute is `"degree, degree, metre"` and `Type` is `"spherical"`, so the 3rd value is the
radius in metres. SADIE H3 was measured on a **1.2 m** sphere. The bake step
(`bake-hrtf.mjs:16`) drops this column ("distance dropped — far-field"), which is why r_ref is
not recoverable from the runtime `.hrtf` — it must come from the SOFA (now documented here).

## 2. Head model

Spherical-head model (Algazi & Duda 2001, "The CIPIC HRTF database"; same a used by Duda's
DVF work). Standard head radius **a = 0.0875 m (8.75 cm)**. Ears sit at ±a on the interaural
(left-right) axis from the head centre. The renderer's listener space (confirmed in
`src/engine/hrtf/sofa.ts`: `+x right, +y up, −z fwd`) gives:
- right ear = (+a, 0, 0), left ear = (−a, 0, 0).

The renderer already computes the head-relative direction (`headDir` in
`interpolatingRenderer.ts`; `worldToHead` in `renderer.ts`) — the model needs the head-relative
POSITION (direction × distance-to-head-centre), which both renderers already have in hand
(`dx,dy,dz` before normalisation).

## 3. The math (`nearFieldEarGains`)

For a head-relative source position `p` (metres):
- `r_ear = |p − earPos|` for each ear (true source→ear distance).
- `r_ref_ear` = the same for a source at the **same direction** but range r_ref:
  `refPos = (p/|p|)·r_ref`, then `r_ref_ear = |refPos − earPos|`.
- **per-ear correction gain = `r_ref_ear / r_ear`** (clamped to ≤40 only to avoid a
  divide-by-~0 when a source touches an ear; the cap is generous so it never clips the ILD).

This is NORMALISED to r_ref: at the reference shell the ratio is 1 (no change — the HRTF
already bakes the distance ILD). It REPLACES the single head-centre `1/r`. The full per-ear
distance gain for integration is:

```
distanceGain_ear = (1 / max(1, dist_headCentre)) * (r_ref_ear / r_ear)
```

— today's head-centre law TIMES the normalised correction, so it reduces to current behaviour
exactly at r_ref.

## 4. The three validations (with numbers)

| # | Scenario | Result | Pass criterion |
|---|----------|--------|----------------|
| 1 | Source AT r_ref (1.2 m), several azimuths (hard right, 45° front-right, off-axis up, hard left) | both ear gains = **1.000000**, ILD = **0 dB** | ratio ≈ 1, no double-count |
| 2 | Side source at **10 m** | distance-ILD = **−1.12 dB** (NOT growing) | reduces/undoes the bake; < the 0 dB at r_ref |
| 3 | Side source **5 cm** outside the right ear (x = a+0.05) | ILD = **+11.8 dB** (right gain 22.25, left gain 5.72) | 10–12 dB, near ear dominates |

Validation 2 nuance (important): at 10 m the *true* per-ear distance difference → 0, but the
HRTF baked **+1.27 dB** of distance-ILD at r_ref. The correction must therefore SUBTRACT that,
producing a small **negative** residual (−1.12 dB), not exactly 0. This is the correct, desired
behaviour — the model **monotonically reduces** the inter-ear distance difference as the source
recedes past r_ref, and it is monotonic in the other direction too (ILD grows 0 → 1.3 → 3.9 →
12.9 dB as a side source closes from 1.2 m → 0.13 m). Both directions are asserted in the test.

### Distance-vs-shadowing split at r_ref (the user's estimate, confirmed)

At r_ref with an exact on-axis side source, the raw per-ear distance ratio is
`(r_ref+a)/(r_ref−a) = 1.2875/1.1125`, i.e. **+1.27 dB**. The measured total side-ILD is
~**8.8 dB**. So the **distance** term is only ~**14%** (1.27 / 8.8) of the side-ILD at r_ref;
the remaining ~**7.5 dB (~86%)** is **head shadowing/diffraction**, which lives in the HRTF and
is untouched by this model. The user's "distance is a minor part" estimate is confirmed.

The payoff is purely near-field: shadowing ILD saturates near ~8.8 dB, but the distance term is
unbounded as a source approaches an ear (+11.8 dB at 5 cm, on TOP of shadowing) — exactly the
"almost touching one ear" effect that is currently missing.

## 5. Recommended integration plan

**Where the single gain becomes two — and the BLOCKER.**

Today, in both renderers, distance gain is applied as a **mono** `GainNode` BEFORE the HRTF
stage, i.e. while the signal is still a single channel:

- `interpolatingRenderer.ts`: `input → propDelay → distanceGain → airLowpass → worklet(HRTF) → output`
  — `distanceGain` set at line ~157 (`g = 1/Math.max(1,dist)`). The worklet outputs the L/R
  pair; L and R do not exist as separate channels until AFTER the worklet.
- `renderer.ts` (legacy): `… → distanceGain → airLowpass → convolver → splitter → merger → gain`
  — distance gain at line ~255; L/R become separable only at the `ChannelSplitter(2)` AFTER the
  convolver (`makeChain`).

**BLOCKER:** a single `distanceGain` upstream of the HRTF cannot carry per-ear gains, because L
and R are one channel there. The per-ear gains must be applied **after** the L/R split. Plan:

**Interpolating renderer (the live path) — recommended:**
1. Compute `{left, right}` in `setPosition` from the head-relative POSITION
   `[hx,hy,hz]·dist` (the values already computed for `headDir`), via `nearFieldEarGains`.
2. Keep the existing mono `distanceGain = 1/max(1,dist)` as-is (the common term).
3. Apply the per-ear correction AFTER the worklet, where the worklet already emits 2 channels:
   insert a `ChannelSplitter(2) → [gainL, gainR] → ChannelMerger(2)` between
   `this.node` and `this.output` (or, cleanest, post per-ear gains INTO the worklet via
   `port.postMessage` and have the worklet scale its L/R output buffers — one extra multiply per
   channel, no added nodes/latency). Ramp with `setTargetAtTime(…, 0.02)` like the existing gain
   to stay click-free.

**Legacy renderer:** apply `gainL/gainR` at the post-split point — the `splitter → merger`
in `makeChain` — i.e. `splitter.connect(merger,0,0)` becomes `splitter → gainL → merger(0)` and
`splitter → gainR → merger(1)`. Both crossfade chains need the same per-ear gains kept in sync.

**Notes for integration:**
- Net loudness stays bounded: the per-ear correction multiplies the existing `1/max(1,dist)`,
  which shrinks toward the head, and the model is a no-op at r_ref. The CAP=40 only guards the
  touch-the-ear singularity.
- Only matters within ~r_ref (1.2 m); beyond it the effect is a sub-1 dB reduction. Cheap to
  always-on.
- This adds ONLY the per-ear distance term. The near-field HRTF magnitude boost (a full DVF /
  near-field HRTF correction) is a separate, larger enhancement and is out of scope here.
