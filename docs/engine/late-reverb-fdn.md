# Late reverb — the FDN tail

The acoustics engine produces **early reflections** (image-source taps) plus a short
**diffuse scatter smear**. On their own those decay abruptly: a room "stops" instead of
ringing out. This document describes the **late reverberant tail** — a Feedback Delay
Network (FDN) rendered offline into the room IR so the late field decays smoothly.

Code: `acoustics-core/src/ir_build.rs` (`fdn_tail`, the tail section of `build_room_ir`)
and its JS mirror `src/engine/acoustics/roomIr.ts` (`fdnTail`, `eyringRt60`,
`resolveTail`). RT60 inputs are derived per-room in `clapRoom.ts`.

## Why render offline into the IR (vs a live FDN node graph)

We **render the FDN response offline and overlap-add it onto the early stereo IR**, so
the *entire* room — early reflections + late tail — remains a **single `ConvolverNode`
buffer**. This was a deliberate choice over running a live FDN node graph:

- The clap pipeline (`clapRoom.ts` → `buildRoomIr` → `ConvolverNode`) and the
  moving-walls dual-convolver **crossfade** already operate on one IR buffer. Keeping the
  tail inside that buffer means the clap, the crossfade, and the moving-walls rebuild all
  keep working **unchanged** — no new node graph, no extra routing, no second decay tail
  to crossfade independently.
- A live FDN would need its own wet send, its own parameter ramps when the room changes,
  and careful handling so its in-flight tail doesn't click when geometry moves. The
  offline tail inherits the existing 80 ms equal-power crossfade for free.

The heavy generation lives in **Rust/WASM** (`fdn_tail`), exposed through the existing
`build_room_ir` path (additive params), so it benefits from the same speed that makes
per-frame moving-wall rebuilds viable. The JS reference (`fdnTail`) mirrors it for the
fallback path and the equivalence tests.

## FDN structure

Standard Jot / EVERTims-style network:

- **N = 8 delay lines** with **mutually-prime lengths** (`[809, 877, 937, 1049, 1151,
  1249, 1373, 1499]` samples at 48 kHz, scaled to the actual sample rate). Coprimality
  maximises the echo-pattern period and modal density, so the tail sounds dense and
  smooth rather than fluttery/periodic. (~17–31 ms per line.)
- **Lossless feedback matrix**: a **Householder reflection** `M = I − (2/N)·J` (J = all
  ones). It is orthogonal, so recirculation neither adds nor removes energy on its own —
  the decay comes *only* from the per-line attenuation, which is what lets us set RT60
  precisely. Applied implicitly per line as `mixed_i = s_i − (2/N)·Σ s_j` (an O(N) mix,
  no matrix multiply).
- **Per-line broadband gain** `g_i = 10^(−3·D_i/RT60)` where `D_i` is the line delay in
  seconds. A line multiplied by `g_i` each pass loses exactly 60 dB over `RT60` seconds.
- **Per-line damping**: a one-pole lowpass in each feedback path so highs decay faster
  (air absorption + soft materials). Its Nyquist gain is chosen so the HF feedback gain
  ≈ `10^(−3·D_i/(RT60·hf_ratio))`, i.e. the highs reach −60 dB in `RT60·hf_ratio`
  seconds. `hf_ratio` defaults to **0.5** (highs decay ~2× faster than lows).
- **Decorrelated L/R output taps**: even lines → left, odd lines → right, each with a
  light (0.4) cross-feed to the other ear, giving a wide diffuse late field rather than a
  mono tail. The excitation impulse is sign-alternated across lines for further L/R
  decorrelation.

The network is excited by a **single impulse** whose amplitude is the energy the early
field hands over with (below), so the tail *starts* at the early-reflection level and
decays from there.

## RT60 from geometry + materials (Eyring)

RT60 is derived with the **Eyring** reverberation-time estimate (preferred over Sabine
for absorbent rooms; it stays finite as ᾱ→1):

```
RT60 = 0.161 · V / ( −S · ln(1 − ᾱ) )
```

- `V` = room volume (m³)
- `S` = total surface area (m²)
- `ᾱ` = mean (area-weighted) absorption coefficient at the ~1 kHz band
- `0.161 = 24·ln(10)/c`, c ≈ 343 m/s

Sabine is the ᾱ→0 limit (`−S·ln(1−ᾱ) → S·ᾱ`). `eyringRt60()` in `roomIr.ts` implements
this; air absorption is omitted at this altitude. A **large hard** room (big `V`, small
`ᾱ`) yields a long RT60; a **small absorbent** room a short one — the audible contrast we
want.

Inputs are computed per room in `clapRoom.ts`:
- **Shoebox** (`shoeboxRoom`): exact `V = xyz`, `S = 2(xy+yz+xz)`, ᾱ area-weighted from
  the six wall materials' 1 kHz absorption.
- **General walls** (`wallsRoom`): `S` = sum of polygon areas (Newell's method), ᾱ
  area-weighted from each wall's per-band absorption, `V` = bounding-box volume (a robust
  approximation for the RT estimate).

RT60 is clamped to `[0, 8]` s so a degenerate room can't generate a multi-minute IR.
Knobs on `RoomIrOptions`: `rt60` (explicit override), `rt60Scale` (multiplier),
`rt60HfRatio`, `wet`, and `tail: false` (omit the tail entirely). The tail is **on by
default**, but only when a `room` (or explicit `rt60`) is supplied — so existing callers
that pass neither (and the early-energy unit tests) are unaffected.

## Listener-local RT60

**Problem.** `wallsRoom`/`shoeboxRoom` originally returned a single whole-room
area-weighted ᾱ, independent of where you stand — so the FDN produced **one RT60
everywhere**. A carpeted alcove and the marble nave centre of the same room rang for
the same time, which is wrong: the surfaces *near you* dominate the reverberant field
you actually hear.

**Fix — distance-weighted local absorption.** Only `meanAbsorption` becomes listener-
local; `V` and `S` stay global (RT60 = 0.161·V/(−S·ln(1−ᾱ)) — V and S are whole-room
properties; it's the *effective absorption the listener experiences* that varies, and
absorption is the dominant, cleanest lever). Each surface is reduced to (area,
ᾱ@1kHz, centroid) and the effective absorption is a weighted mean:

```
ᾱ_local = Σ w_i·a_i / Σ w_i        w_i = area_i / (1 + (dist_i / d0)^2)
```

where `dist_i` is the listener-to-**centroid** distance (cheap; no per-vertex work)
and `d0 = 3 m` (`LOCAL_ABSORPTION_D0`). The inverse-square-ish falloff means a near
surface dominates: a carpet wall 1 m away outweighs a concrete wall 15 m away by
≈ (1+(15/3)²)/(1+(1/3)²) ≈ **26×**. d0 = 3 m was tuned so the effect is clearly
audible (a metre-away wall dominates) yet a few-metre room still blends several walls
rather than snapping to whichever single wall is nearest.

The pure, Web-Audio-free function is `localMeanAbsorption(surfaces, listener?, d0?)`
in `clapRoom.ts`.

**Back-compat.** When **no listener** is passed, `w_i = area_i` and the formula
collapses to the original plain area-weighted whole-room mean — so callers that don't
supply a listener (and the existing whole-room tests) are unaffected.

**Wiring + cost.** The clap/ambient path has the listener, so it's threaded through:
`updateGeneralRoom`/`updateLive` call `wallsRoom(walls, listener)`. This is **~free at
runtime**: the IR already rebuilds on pose change (the dirty-check signature quantises
the listener pose), so walking from the nave into the alcove triggers a normal rebuild
that now also recomputes the local ᾱ — no new per-frame cost. The **modeled beacon**
emits no FDN tail (`tail: false` — the clap owns the room's reverb), so there is no
decay to localise on that path; the local-RT60 work lives entirely on the clap/ambient
path. If the beacon ever grows its own tail, pass `room: wallsRoom(opts.walls,
opts.listener)` there too (noted in `modeledSource.ts`).

**Tested.** `tests/listenerLocalRt60.test.ts`: (pure) a listener near a carpet wall
yields higher ᾱ → shorter RT60 than near a concrete wall, equidistant lands between,
no-listener reproduces the area-weighted mean; (IR-level) the same room with a listener
near the absorbent wall produces a shorter, lower-late-energy tail than near the hard
wall. The existing `roomIrLateReverb` whole-room tests still pass.

**Limitation that remains.** It's still a **single FDN with one decay at a time** — the
RT60 *varies as you move* but at any instant the whole tail uses one ᾱ. This is not a
true coupled-rooms / per-region model (sound leaking between a live hall and a dead
alcove with two simultaneous decays). Per-region or coupled FDNs were judged not worth
the cost/complexity for single-room levels; the distance-weighted single FDN captures
the dominant "where am I standing" cue at no extra runtime cost.

## Energy continuity (no gap, no click)

The early field and the tail must **sum smoothly**:

1. **Handover point**: the latest early reflection arrival (`max_delay`). The diffuse
   late field begins where the discrete early reflections end.
2. **Seed level**: the RMS of the early IR in a 10 ms window just before the handover
   sets the tail's excitation amplitude — so the late field **starts at roughly the
   energy the early reflections leave off with** (no level jump). The diffuse scatter
   smear has already raised this window, so the **scatter energy transitions into the
   tail** rather than the two being independent. If the early field is silent there (e.g.
   a single direct tap), the seed falls back to 10 % of the global early peak so the room
   still rings.
3. **Ramp-in**: the tail is overlap-added starting at the handover with a 5 ms raised-
   cosine ramp; since the early field is simultaneously decaying, the sum stays
   continuous — no zero-run, no click-sized jump. This is asserted by the
   `fdn_continuity_no_gap_at_handover` (Rust) and "no silent gap" (JS) tests.

## Measured cost

Representative 6×3×8 m shoebox (brick/concrete/wood), 256-tap HRIR, order 2 (25 taps),
RT60 ≈ 0.97 s, measured in vitest/Node (40-iter mean; absolute ms run higher than the
browser):

| build | time |
|-------|------|
| early-only (`tail: false`) | ~11.6 ms |
| with FDN tail | ~12.6 ms |
| **FDN overhead** | **~1.0 ms** |

The tail cost is `O(N_lines · tail_samples)` and scales linearly with RT60 (longer tail →
proportionally more samples); a 2 s room adds ~2 ms. The moving-walls path rebuilds at a
~70 ms throttle (≈14 Hz), so a ~1–2 ms tail leaves the budget intact (total build stays
well under the throttle). If a future room needs a very long RT, options are to generate
the tail at a lower rate or cache it when only the listener (not the geometry/materials)
moves — the tail depends only on RT60, not the listener pose.

## Limitations

- **Single broadband RT60** with one HF-ratio knob — not a full per-octave-band decay.
  Per-band RT (one FDN damping curve per band, or band-split tails) is the next lever.
- **RT derived from a 1 kHz mean absorption**; air absorption is not folded into the RT
  estimate (it is approximated only via the HF damping ratio).
- The late field is **decorrelated stereo**, not a fully physically-diffuse field — good
  for envelopment, but it is not a measured spatial covariance.
- **General-room volume is the bounding box**, an over-estimate for non-convex or open
  layouts; RT will read slightly long for those.
- The tail is seeded by a **single broadband impulse** at the handover; it does not carry
  the early field's exact spectral coloration into the late field beyond the HF-ratio
  damping.
