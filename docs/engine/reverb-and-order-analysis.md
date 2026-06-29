# Reverb & image-source order — performance + acoustics analysis

> **UPDATE (shipped):** Energy pruning is now implemented in `Room::compute_taps`
> (`docs/engine/energy-pruning.md`) and the beacon runs at **order 3** with an
> `orderTapCap: 24` guard. Pruning makes the high-order candidate search affordable on
> absorbent/mixed rooms; cathedral (very low absorption) keeps all 57 order-3 taps and
> so auto-drops to order 1 via the guard. The recommendation below ("order 2 default")
> is superseded by "order 3 default + tap-cap fallback".


Decision doc for **Phase 2** of the modeled beacon (`src/engine/acoustics/modeledSource.ts`).
Two questions, answered with measured numbers:

- **A.** What does raising the image-source reflection order (1 → 2 → 3) actually cost on the
  heaviest authored levels, and which order fits the ~70 ms moving-source throttle budget?
- **B.** The FDN late-reverb tail is **one statistical tail for the whole room** — it does not
  model that different parts of a room reverberate differently. How real is that limitation,
  does higher image-source order help, and what's the cheapest realistic fix?

Benchmark: `tests/orderCostBench.test.ts` (`npx vitest run tests/orderCostBench.test.ts`).
It loads each builtin via `loadLevel()` (so the wall list is exactly what the solver sees —
interior walls are double-sided, both faces reflect), solves `compute_room_taps` directly off
the WASM core, and builds the beacon IR via `buildRoomIrWasm({ tail: false })`. 256-tap HRIR,
26 directions, 40-iteration mean. Node/vitest numbers run **higher than the browser** (no
JIT-warm AudioWorklet), so treat them as a conservative ceiling.

---

## Question A — cost of raising the reflection order

Measured per refresh (40-iter mean, listener at level start, source at the beacon):

| level         | walls (solver sees) | order | taps | solve ms | IR-build ms | **total ms** |
|---------------|--------------------:|------:|-----:|---------:|------------:|-------------:|
| open-street   |  9 (all double-sided)| 1    |  4   | 0.02     | 1.89        | **1.91** |
| open-street   |                      | 2    |  4   | 0.03     | 1.84        | **1.87** |
| open-street   |                      | 3    |  6   | 0.08     | 2.70        | **2.78** |
| cathedral     | 10 (4 walls+floor+ceiling step) | 1 | 15 | 0.04 | 6.75    | **6.80** |
| cathedral     |                      | 2    | 29   | 0.05     | 13.01       | **13.06** |
| cathedral     |                      | 3    | 57   | 0.10     | 24.78       | **24.88** |
| clap-maze     |  9 (perimeter+ceiling+3 brick interior) | 1 | 4 | 0.01 | 1.72 | **1.73** |
| clap-maze     |                      | 2    |  4   | 0.02     | 1.80        | **1.82** |
| clap-maze     |                      | 3    |  9   | 0.06     | 4.00        | **4.07** |

### What the numbers say

- **The solve is free.** `computeRoomTaps` is ≤ 0.10 ms everywhere, even cathedral order 3.
  The combinatorial `walls^order` candidate search is cheap because most images are culled
  (visibility / behind-wall). Tap **count** is what matters, not solve time.
- **The cost is the IR build**, and it scales ~linearly with tap count (each tap = one HRIR
  band-FIR coloring + convolution + accumulate). open-street and clap-maze stay tiny because
  their geometry yields very few valid images (open layout → few enclosing reflectors; only
  6–9 taps even at order 3). **Cathedral is the outlier**: a vast enclosed marble box returns
  15 → 29 → 57 taps, and its IR is also long (big room → late `max_delay` → long buffer), so
  every tap convolution is over a longer output. That double-whammy is why cathedral order 3
  costs ~25 ms.

### Budget verdict (~70 ms throttle, want < 10 ms to leave room for clap + monsters + FDN)

| level       | order 1 | order 2 | order 3 |
|-------------|:-------:|:-------:|:-------:|
| open-street | ✅ 1.9  | ✅ 1.9  | ✅ 2.8  |
| clap-maze   | ✅ 1.7  | ✅ 1.8  | ✅ 4.1  |
| cathedral   | ✅ 6.8  | ⚠️ 13.1 | ❌ 24.9 |

- **order 1 & 2 fit comfortably** on open-street and clap-maze (< 5 ms, huge headroom).
- **cathedral order 2 (~13 ms) already blows the 10 ms comfort line** and order 3 (~25 ms)
  eats a third of the whole 70 ms budget by itself — with the clap, monsters, and FDN tail
  also wanting time, **order 3 hurts on big enclosed rooms.**
- Remember the beacon IR is per-source and `tail:false`; the **clap** (which *does* carry the
  FDN tail) pays this on top in the same room. So cathedral's real headroom is tighter than
  the beacon number alone.

### "Would WASM let us do order 3/4 cheaply?" — No. The cost is combinatorial, not JS overhead.

This is worth stating plainly because it's the obvious next question. **Both halves of a refresh
are already native Rust/WASM:**

- the candidate search — `compute_room_taps` → `Room::compute_taps` in
  `acoustics-core/src/geometry.rs` — is a recursive image-source expansion in Rust;
- the IR build — `buildRoomIrWasm` → `build_room_ir` (FFT convolution) — is Rust too (the JS
  reference is only a fallback, measured at ~5.7× slower in `roomIrBench`).

There is **no JS→WASM porting win left to capture.** The measured solve is ≤ 0.10 ms even at
cathedral order 3, so the search is already as fast as native gets. The thing that grows with
order is **the algorithm**: `compute_taps` pushes a `(image, wall-chain)` for every wall at every
level, i.e. ~`walls^order` candidate chains, each validated by a visibility test
(`validate_path`). Cathedral's surviving tap count grows **15 → 29 → 57** (≈ ×2 per order); the
*candidate* count (before validation culls most) grows faster. Extrapolating the ×2 tap growth
and the ~linear IR-build cost, **cathedral order 4 lands around ~50 ms of IR build alone** —
which by itself nearly fills the 70 ms throttle, before the clap/monsters/FDN. Order 4 is not
viable on big enclosed rooms by brute force.

**What would actually make order 3/4 cheap is algorithmic, not "use WASM":**

- **Energy pruning** (biggest lever): cull a wall-chain whose accumulated absorption gain has
  dropped below an audibility threshold, *before* recursing. `compute_taps` already multiplies
  `(1−absorption)` per bounce (`band_gains[b] *= (1−absorption)`), but currently only at tap
  emission — it never stops descending a quiet chain. With low-absorption surfaces (concrete
  ~0.02, marble ~0.01) high-order paths stay loud, so this prunes less in cathedral and more in
  absorbent rooms — but combined with a distance/`1/r` cutoff it kills the long, late, quiet
  order-3/4 chains that the FDN tail is already covering anyway. **S–M effort, native to add.**
- **Early back-face / visibility culling before mirroring** — partly present (`signed_dist`
  skips images behind a single-sided face); could be tightened, but it's a constant-factor win,
  not a way to beat the exponent.
- **Per-level wall-count / tap-count cap** — the cheap, ship-now guard (below).
- **Does order 3/4 even add audible info?** Largely **no**, given the FDN. By order 3 the
  reflections are late and dense — exactly the regime the diffuse FDN tail already models as a
  smooth decay. The audible, *localizable* payoff of higher order is the order-2 mid field;
  order 3 is a marginal refinement on small rooms and inaudible-vs-FDN on large ones. So the
  honest answer is: **order 3 is affordable on small/sparse levels, order 4 needs energy
  pruning (not WASM), and neither is worth a global enable when the FDN owns the late field.**

### Recommendation (order)

> **Ship Phase 2 at order 2 as the default, capped to order 1 by a tap/size budget.**

Order 2 is the sweet spot: it adds the around-the-corner early reflections that are the whole
point of Phase 2, at negligible cost on normal levels. The only failure mode is a **large
enclosed room** (cathedral-class) where tap count explodes.

Cap it by what actually drives cost — **resulting tap count**, not wall count (open-street has
9 walls but only 4 taps; cathedral has 10 but 29). Concretely, in `refresh()`:

- solve at order 2;
- if the order-2 tap count exceeds ~**24 taps** (≈ the point where IR-build crosses ~10 ms for
  a long-IR room), **drop that source to order 1** for this refresh.

This is a 3-line guard, costs nothing (the solve is ~0.05 ms so re-solving at order 1 is free),
and self-tunes: cathedral falls back to order 1 (~6.8 ms), everything else stays at order 2.
**Do not enable order 3 globally** — only worth it for small, sparse rooms, and the gain over
order 2 is marginal there.

---

## Question B — position-dependent reverberation

### The limitation is real — quote the code path

The FDN tail's RT60 is derived from **whole-room** geometry + a single area-weighted mean
absorption, with **no listener term**:

- `clapRoom.ts › wallsRoom(walls)` computes `volume` = bounding-box of all walls, `surfaceArea`
  = Σ polygon areas, `meanAbsorption` = area-weighted 1 kHz absorption **over every wall in the
  level**. The listener position is not an argument.
- `roomIr.ts › eyringRt60(volume, surfaceArea, meanAbsorption)` → one scalar RT60.
- `roomIr.ts › fdnTail(...)` renders one decay from that scalar; the only listener coupling is
  the *seed level* (RMS of the early field just before handover) — that scales loudness, **not
  the decay rate or spectrum**.

So **two listeners standing in different parts of the same room get the identical tail**
(same RT60, same HF ratio, same density). A carpeted alcove and the middle of a marble nave in
the same authored room reverberate the same. Confirmed — exactly as the user suspected.
(`docs/engine/late-reverb-fdn.md` already lists "single broadband RT60" and "bounding-box
volume" as limitations; the *position-blindness* is the deeper one.)

### Does higher image-source order help? Yes — partially, and for free

Image-source taps **are** computed from the geometry around the listener's actual position
(`compute_room_taps(listener, source, …)`). So the **early/mid reflection field already varies
with where you stand**: near a soft wall you get an early, dull reflection from it; in open
space you get later, sparser, brighter ones. Raising order extends this position-dependent part
deeper into the response (order 2–3 mid reflections), which is genuinely what makes "different
parts sound different" in the first ~50–150 ms.

**Rough split of the "different parts sound different" effect:**

- **Early + mid reflections (first ~80 ms): position-dependent, image-source — the dominant,
  most *localizable* cue.** This is where a listener perceives "I'm near a wall / in a corner /
  in the open." It already varies by position and gets richer with order. Call it **~60–70%** of
  the perceptual difference between two spots in a room.
- **Late diffuse tail (the FDN): currently position-blind.** Its contribution to *spatial
  discrimination within one room* is smaller (the late field is genuinely more diffuse and
  homogeneous in real rooms too) — but a strongly absorbing local zone (carpeted alcove) really
  does shorten the perceived decay there, which the FDN misses entirely. Call it **~30–40%**, and
  it's the part that's *qualitatively* wrong (same decay everywhere) rather than just coarse.

So **pushing image-source order up captures most of the position-dependent reverb the FDN can't**
— but it does **not** fix the case the user explicitly named (carpeted alcove vs marble hall
*decay*), because that's a late-tail/RT60 effect.

### Cheapest realistic fixes, ranked by cost/benefit

| # | fix | effort | realism bought |
|---|-----|:------:|----------------|
| **(c)** | **Rely on image-source order 2 for the position-dependent early field; keep the one FDN as a cheap diffuse floor.** | **S** (already the plan) | **High per cost.** Captures the dominant ~60–70% position cue with zero new machinery — it's just Question A's order bump. Best first move. |
| **(a)** | **Make the FDN RT60 depend on the listener's LOCAL surroundings**: weight `meanAbsorption` (and optionally local volume) by surfaces *near* the listener — e.g. distance-weighted over walls within some radius — instead of the whole-room mean. RT60 becomes `rt60(listenerPos)`. | **M** | **Medium-high.** Directly fixes the carpeted-alcove-vs-marble-hall decay the user named. One new function (`localRoomGeom(walls, listener)`), threaded where `wallsRoom` is called. The FDN itself is unchanged. The IR already rebuilds on listener move (the dirty-check keys on quantized pose), so a position-dependent RT60 costs ~nothing extra at runtime. **This is the targeted fix.** |
| **(b)** | **Per-region / per-zone RT60** (author or auto-derive zones; pick the zone the listener is in). | **M–L** | Medium. More authorable control than (a) but needs a zone model + authoring UI, and is essentially a discretized, lumpier version of (a). Skip unless levels start having sharply partitioned acoustics that (a)'s smooth weighting can't capture. |
| **(d)** | **Multiple FDNs / coupled-rooms model** (separate tails per coupled volume, cross-coupled). | **L** | High *physical* fidelity for genuinely coupled spaces (room + reverberant stairwell), but heavy: multiple tails to render, crossfade, and energy-balance, and most authored levels are single rooms where it buys little. Not justified now. |

### Recommendation (position-dependent reverb)

> **Do (c) now — it's free with Question A — and do (a) as the one targeted follow-up.**

1. **(c) first:** the order-2 bump from Question A already delivers the bulk of the
   position-dependent effect (the early/mid field), at no extra cost. Ship it.
2. **(a) next, small and high-value:** replace the whole-room `meanAbsorption` (and optionally
   the volume) in the RT60 estimate with a **listener-local, distance-weighted** version, so the
   single FDN's decay tracks where you stand. This is the only change that fixes the carpeted-
   alcove-vs-marble-hall *decay* the user explicitly called out, it reuses the existing single-
   FDN machinery (no new node graph, no extra crossfade), and the per-pose IR rebuild already in
   place means it's effectively free at runtime. Keep one global volume as a floor so a listener
   near a dead wall in a live room doesn't read implausibly dry.
3. **Skip (b) and (d)** unless authored levels gain sharply coupled sub-spaces; (a)'s smooth
   local weighting covers the realistic cases at a fraction of the effort.

---

## Combined recommendation

- **Beacon image-source order: 2 by default, auto-drop to 1 when the order-2 solve returns
  > ~24 taps** (cheap guard; the solve is ~0.05 ms so re-solving costs nothing). This keeps every
  authored level — including cathedral (falls back to ~6.8 ms) — comfortably under the 70 ms
  throttle with the clap, monsters, and FDN tail still fitting alongside. Order 3 is reserved for
  small sparse rooms only and isn't worth a global enable. **There is no WASM porting win to
  unlock higher orders — the solve is already native and ~free; the cost is the combinatorial
  candidate growth and the resulting IR-build. Order 4 would need energy pruning of quiet
  high-order chains, not a faster runtime — and the FDN tail already covers the late field those
  chains would add, so it isn't worth it.**
- **Position-dependent reverb:** the order-2 bump *is* most of the fix (the position-dependent
  early field), for free. The one worthwhile follow-up is **(a) a listener-local RT60** for the
  FDN tail — a small, single-FDN change that fixes the decay-varies-by-location case higher order
  can't. The two interact cleanly: higher order handles the early/mid position cue, local-RT60
  handles the late-tail position cue, and together they cover the user's concern without the cost
  of multiple FDNs.

*(Analysis only — no engine behavior changed. Benchmark: `tests/orderCostBench.test.ts`.)*
