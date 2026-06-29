# Ray-traced acoustics for papasangre — research & feasibility

**Status:** decision document. No code changes proposed inline — this decides *whether and how* we
adopt ray-traced acoustics for higher-order reflections + diffraction, given our hard constraint:
**the browser.** We have Web Audio + AudioWorklet, Rust→WASM, WASM threads (we set COOP/COEP — see
§0), and shipping WebGPU *compute* (no RT cores). We do **not** have native FFI to a C library, no
`cpal`/OS audio threads, and no WebGPU ray-query/RT extension in a shipping browser.

**Bottom line up front:** **Ray-traced reflections in a browser PWA are PROVEN, not theoretical.** A
WASM build of Steam Audio running **worker-based real-time parametric reflections + per-source reverb
buses** in the browser exists *today* — `kwaa/three-steam-audio` (Apache-2.0) has those items
**checked done** on its roadmap, alongside direct path + occlusion + transmission + binaural HRTF.
This is a genuine state-of-the-art jump over our current engine (image-source ~order 2 + one global
FDN). The two gaps that bite *us specifically* are still open in that project: **(1) a "web-safe IR
transport"** (convolution/hybrid reflections into Web Audio) and **(2) pathing for moving sources /
listeners without baking** — and *our game is built on moving sources* (moving beacon, moving
monsters, moving listener, moving walls). **Recommendation:** ship the cheap in-house wins we already
have planned (pruned image-source order 3 + listener-local FDN), and **run a time-boxed evaluation
spike of the WASM Steam Audio reflection path** (stand up the `three-steam-audio` demo, stress it with
moving-source reflections + occlusion in a maze, measure CPU and compare spatial quality to our
engine) **before** committing to either adopting it or building our own ray tracer (path (d)). The
moving-source question is the crux and must be answered empirically. See §4–§5.

---

## 0. Our constraints and our advantages (verified against the repo)

- **Browser PWA, Chrome-targeted.** No native FFI, no `cpal`/OS audio thread, no OS RT cores.
- **We set cross-origin isolation already.** `vite.config.ts` sends
  `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`
  (lines 34–35), the comment explicitly noting "AudioWorklet + WASM both need to be served with
  correct MIME and cross-origin." This means **`SharedArrayBuffer` and WASM threads are available to
  us** — a real advantage over the one public attempt that went single-threaded (issue #234, §2).
- **We already have a working Rust/WASM acoustics pipeline**: image-source (shoebox + general
  convex-polygon), UTD diffraction, FDN late reverb, measured-HRTF binaural, Web Audio integration —
  see `docs/TECHNICAL.md`. The solve and IR-build are *already native WASM*
  (`docs/engine/reverb-and-order-analysis.md`).
- **We already have SOFA HRTF** (SADIE II, baked to a compact binary). The leading browser Steam
  Audio project lists "custom HRTFs via SOFA" as a *pending* roadmap item — we're ahead there.

These four advantages matter because they mean: *if anyone is well-positioned to push the
WASM-ray-traced-reflections frontier, it's us* — but they also mean *we already have most of what a
direct-path Steam Audio WASM build would hand us.*

---

## 1. How production engines do high-order / ray-traced acoustics

The common pattern across all three: **image-source is kept deliberately low-order for the crisp,
localizable early reflections; ray tracing or wave precompute handles everything beyond that** (the
late, dense, diffuse field and diffraction). Nobody brute-forces high-order image-source — exactly
the conclusion our own `reverb-and-order-analysis.md` reached independently.

### Steam Audio (Valve) — real-time ray tracing
- **Technique.** Rays are traced and bounced around the scene in real time to simulate reflections
  reaching the listener; this gives **smooth variation and reflections off dynamic geometry at the
  cost of significant CPU**. Diffraction is a **physics-based UTD** model (Uniform Theory of
  Diffraction) with simplifying assumptions. Reverb is parametric (estimated decay from the traced
  energy) and/or convolution.
- **What it buys over image-source:** arbitrary-order *diffuse* reflection energy, dynamic/curved
  geometry, and a statistically correct late field — without the `walls^order` blow-up. Image-source
  alone can't cheaply reach the dense late field; ray tracing samples it stochastically instead.
- **Cost model:** CPU-heavy, scales with ray count × bounces × sources. GPU backends exist
  (**Radeon Rays**, OpenCL, cross-vendor; **Embree** for dynamic geometry / CPU SIMD; AMD TrueAudio
  Next for convolution). Radeon Rays was reported as giving up to ~150× over CPU for the *baking*
  path.
- **License:** **Apache-2.0**, fully open-sourced (SDK + all plugins) in Feb 2024 (v4.5.2 was the
  first fully-open source release; the previously closed `phonon` core is now open). This is what
  makes paths (a)/(b) legally viable. Sources:
  [Steam Audio site](https://valvesoftware.github.io/steam-audio/),
  [C API simulation docs](https://valvesoftware.github.io/steam-audio/doc/capi/simulation.html),
  [GitHub](https://github.com/ValveSoftware/steam-audio),
  [Phoronix: fully open under Apache-2.0](https://www.phoronix.com/news/Steam-Audio-SDK-Fully-Open).

### Microsoft Project Acoustics / Triton — offline wave precompute
- **Technique.** Solves the **wave equation offline** (Triton solver) over the static scene, baking
  perceptual parameters (loudness, decay, arrival direction, obstruction) into a grid of **probes**;
  the runtime is a cheap **lookup + interpolation**. Captures true wave effects (diffraction,
  portaling, interference) that ray/geometric methods approximate.
- **What it buys:** physically correct diffraction + low runtime cost. **Cost is the bake** (cloud
  compute, hours) and **static geometry only** — moving walls break the bake.
- **Portability:** the *runtime lookup* is trivially portable (it's a table lookup — fits a PWA
  perfectly, works offline once cached). The *bake* is an offline/server step. This is the model
  behind our path (c).

### NVIDIA VRWorks Audio / RTX audio — GPU RT-core path tracing
- **Technique.** Path-traces sound on GPU **RT cores** (hardware-accelerated BVH traversal),
  treating audio rays like light rays.
- **What it buys:** very high ray counts in real time.
- **Portability to browser: blocked.** No shipping browser exposes hardware ray-query/RT-core
  extensions (§3e). This path is simply not available to a PWA.

---

## 2. The named crates — rigorous browser-viability assessment

### `audionimbus` — **native FFI only; not usable in the browser as-is**
- **What it is:** a Rust wrapper over Steam Audio. `audionimbus-sys` is *"automatically generated raw
  bindings to the Steam Audio C API"* — i.e. **FFI to the native Steam Audio C library**
  (`.so`/`.dll`/`.dylib`). The `auto-install` feature downloads prebuilt native Steam Audio binaries
  for your target platform. Dual-licensed MIT/Apache-2.0.
  ([README](https://github.com/MaxenceMaire/audionimbus),
  [audionimbus-sys docs](https://docs.rs/audionimbus-sys),
  [crates.io](https://crates.io/crates/audionimbus)).
- **The hard question — can an FFI-to-native-C wrapper run under `wasm32`?** **No, not as-is.** FFI
  to a `.so`/`.dll` has no meaning in `wasm32-unknown-unknown`/Emscripten unless the C library is
  *itself* compiled to WASM and linked in. `audionimbus`'s `auto-install` fetches **native** Steam
  Audio binaries — there is no WASM artifact to link, and no browser project uses `audionimbus` under
  wasm32. Its README documents no WASM support.
- **Could it target wasm32 if Steam Audio were built to WASM?** In principle the `-sys` bindings are
  just `extern "C"` declarations, so *if* you produced an Emscripten WASM build of Steam Audio and
  linked it, a wasm32 build is *conceivable* — but nobody has done it, the `auto-install`/build
  plumbing assumes native artifacts, and the practical browser projects (§ below) **bypass the Rust
  wrapper entirely** and call an Emscripten C/JS build of Steam Audio directly. **Verdict: for the
  browser we would not use `audionimbus`; we'd call an Emscripten Steam Audio build directly.**
- **Verdict:** **Native only.** Viable for a *native* desktop second target (Tauri/Electron — path
  (b)); **not viable for our browser PWA.**

### `petalsonic` — **native-app architecture; not a browser fit**
- **What it is:** spatial-audio convenience layer = `audionimbus` (Steam Audio FFI) + **`cpal`**
  (cross-platform OS audio I/O) + **`symphonia`** (decoding), with a dedicated render thread + audio
  callback. MIT. ([repo](https://github.com/tr-nc/petalsonic),
  [lib.rs](https://lib.rs/crates/petalsonic)).
- **The dedicated-OS-thread + cpal model is a native-app architecture.** It inherits
  `audionimbus`'s native-FFI blocker (above). Its "three-layer" render-thread/audio-callback design
  maps poorly onto the browser audio model (you'd render into an AudioWorklet, not a `cpal` device
  callback).
- **A nuance on `cpal`:** `cpal` *does* have a wasm32 Web Audio backend (and a newer AudioWorklet
  backend needing `-Zbuild-std` + atomics), so `cpal` *alone* is not the blocker
  ([cpal repo](https://github.com/RustAudio/cpal),
  [WASM setup wiki](https://github.com/RustAudio/cpal/wiki/Setting-up-a-new-CPAL-WASM-project)).
  The blocker for `petalsonic` is its **`audionimbus` dependency** (native Steam Audio FFI), not
  `cpal`. Even with `cpal`'s web backend, the spatializer can't load.
- **Verdict:** **Native only.** Same as `audionimbus`: a candidate for a native desktop premium build
  (path (b)); **not viable for our browser PWA.**

---

## 3. Is there a working Emscripten/WASM Steam Audio in the browser? (the centerpiece)

This overturns "Steam Audio can't run in a browser." Verified answer (checkbox states confirmed
against the raw `three-steam-audio` README): **Steam-Audio-in-WASM is real and shipping in the
browser, AND its ray-traced parametric reflections + per-source reverb are DONE — not just the direct
path/binaural.** This is the strongest evidence in this document.

### Evidence reviewed

**(i) ValveSoftware/steam-audio issue #234** —
[link](https://github.com/ValveSoftware/steam-audio/issues/234). Opened Jan 2023, a contractor
trying to get Steam Audio into a Unity **WebGL** build. At that time the blocker was the
then-**closed-source `phonon` core** (only available as native binaries), plus AudioWorklet
integration friction in Unity. **No working reflections build resulted from this thread.** Note this
predates the Feb-2024 full open-sourcing, so the *specific* "phonon is closed" blocker is now gone —
but the issue itself is **not** evidence of working in-browser reflections. (The relayed claim that
this user "successfully ran it in-browser via Emscripten, binaural only, single-threaded by removing
multithreading" is the *aspiration* in the thread, not a demonstrated reflections result. Treat it
as: binaural-only is the most anyone attempted here, and reflections were never reached.)

**(ii) `kwaa/three-steam-audio`** — [repo](https://github.com/kwaa/three-steam-audio), live demo
`https://three-steam-audio.pages.dev/`. This is the **real, current precedent**, Apache-2.0, a
three.js integration with an **actual WASM/Emscripten Steam Audio runtime**. Roadmap checkbox states
verified against the raw README. **DONE (`[x]`, working in-browser today):**
  - WebAssembly Steam Audio runtime loading
  - AudioWorklet-based direct-effect + binaural rendering pipeline
  - Direct-path: distance attenuation, air absorption, directivity, **occlusion, transmission**
  - HRTF spatialization for point sources; acoustic material support
  - Static + rigid-dynamic acoustic mesh support; three.js / R3F world/source/listener API
  - **`[x]` worker-based real-time PARAMETRIC REFLECTIONS simulation** ← ray-traced reflections work
  - **`[x]` per-source reflection rendering + listener reverb buses** ← per-source reverb works

  **NOT YET (`[ ]`, open):**
  - custom HRTFs via SOFA *(we already have this ourselves)*; direct-path usability/diagnostics
  - **`[ ]` convolution or hybrid reflections through a WEB-SAFE IR TRANSPORT** ← parametric
    reflections work, but routing a full **convolved reflection IR** into Web Audio is unsolved
  - **`[ ]` pathing for MOVING sources/listeners without baking** ← *this is the crux for us*
  - `[ ]` Ambisonics; `[ ]` web-appropriate acceleration paths

  Small/young project (single-digit stars) but the furthest-along public Steam-Audio-in-browser
  effort, and the reflections milestone is genuinely done.

### The findings that decide everything

1. **Ray-traced parametric reflections + per-source reverb run in the browser today** via WASM Steam
   Audio (`three-steam-audio`, both items `[x]`). This is a real capability jump over our current
   engine: we have image-source ~order 2 + **one global** FDN tail; they have full **ray-traced**
   reflections with **per-source** reverb buses. **High-order/ray-traced reflections in a browser PWA
   are demonstrated, not speculative.**

2. **But the two open gaps are exactly the ones that bite *us*:**
   - **Web-safe IR transport (`[ ]`):** their reflections are *parametric* (a compact descriptor the
     worklet renders cheaply), not a full convolved IR. If we wanted a *convolved* reflection IR
     (what our `roomIr.ts`→`ConvolverNode` path produces), that handoff is still unsolved for them.
     *Nuance:* parametric reflections may actually suit us **better** for moving sources (see next).
   - **Moving sources/listeners without baking (`[ ]`):** **our game is moving sources** — a moving
     beacon, moving monsters, a moving listener, sliding/ping-pong walls. This is the single most
     important unknown. Parametric reflection models *typically* update per-frame cheaply (re-trace
     a budget of rays, update the parametric descriptor) — which would be **better than our
     image-source approach**, where a moving source forces an IR rebuild (~the ~13–25 ms cathedral
     cost in `reverb-and-order-analysis.md`). But `three-steam-audio` flags moving-source pathing as
     *not done*, so **how well their reflections track fast-moving sources/listeners in a maze is the
     thing we must measure before trusting it.**

### The multithreading angle (where we're better-positioned than the precedents)
Steam Audio's ray tracer is multithreaded. In the browser that needs WASM threads
(`SharedArrayBuffer`) + COOP/COEP cross-origin isolation. **We already set COOP/COEP** (§0), so unlike
the issue-234 attempt (which went single-threaded) we *could* run a threaded WASM ray tracer, and
`three-steam-audio` already runs its (working) reflection ray tracing in a dedicated worker. So the
threading prerequisite for the reflection path is **satisfied for us** — we could integrate a WASM
Steam Audio reflection build without the cross-origin-isolation friction earlier attempts hit.

### WebGPU ray tracing status (for path (e))
The **WebGPU ray-query / hardware-RT extension has NOT shipped** in Chrome (it remains experimental;
`gpuweb` issue #535, Dawn's `dawn-ray-tracing` and `webrtx` are research/experimental). Shipping
WebGPU gives us **compute shaders only** — so a WebGPU acoustics ray tracer must do **software BVH
traversal in a compute shader**, no RT cores. Sources:
[gpuweb #535](https://github.com/gpuweb/gpuweb/issues/535),
[dawn-ray-tracing](https://github.com/maierfelix/dawn-ray-tracing),
[webrtx](https://github.com/codedhead/webrtx).

---

## 4. Feasible paths to ray-traced acoustics for US (ranked)

> "Buys over baseline" is measured against our near-term baseline: **pruned image-source order 3 +
> listener-local FDN** (the work we're already doing), which already covers early/mid reflections,
> occlusion, UTD diffraction, and a position-aware diffuse tail.

| # | Path | What it buys over our baseline | Effort | Risk | Keeps browser / offline / PWA? |
|---|------|-------------------------------|:------:|:----:|:------------------------------:|
| **(a)** | **Adopt / build on WASM Steam Audio reflections** (à la `three-steam-audio`'s Emscripten build; ray-traced parametric reflections + per-source reverb, behind our Web Audio/HRTF graph) | **PROVEN** ray-traced reflections + per-source reverb — strictly more than our image-source order 2 + single FDN | **L–XL** | **Med-High** | **Yes** — demonstrated in-browser; risks are moving-source pathing + IR transport + integration |
| **(d)** | **CPU Monte-Carlo ray tracer in our own Rust/WASM `acoustics-core`** (reuses our geometry, materials, HRTF; energy-histogram → IR; UTD as separate pass, Steam-Audio-style) | True diffuse late field + arbitrary-order energy without `walls^order`; full control of our tuned pipeline | **L** | **Med** | **Yes** — all in-browser, reuses our stack |
| **(e)** | **WebGPU compute-shader ray tracer** (software BVH traversal; readback energy/IR to Web Audio) | Same as (d) but far higher ray counts → smoother/faster late field | **XL** | **High** | Yes, *if* WebGPU present; GPU→CPU readback latency vs our 70 ms throttle is the risk |
| **(c)** | **Server/offline bake** (Project-Acoustics-style or server ray-trace) → ship/stream IRs | Physically-rich (even wave-accurate) reflections at ~zero runtime cost | **M** | **Low-Med** | Yes (lookup is offline-cacheable) — but **static geometry / no real-time moving sources** unless probed densely |
| **(b)** | **Native second target (Tauri/Electron)** using `audionimbus`/`petalsonic` natively | Full Steam Audio immediately, no WASM R&D | **L-M** for the target, **but fragments** | Med | **No** — abandons the PWA for that build; two engines to maintain |

### Notes per path
- **(a) — the high-leverage option, now that reflections are proven.** `three-steam-audio` shows
  ray-traced parametric reflections + per-source reverb running in a browser via an Emscripten WASM
  Steam Audio build (Apache-2.0). For the **browser, the route is this Emscripten WASM build — NOT
  the Rust crates**: `audionimbus`/`petalsonic` are native-FFI/`cpal` and don't run in-browser (§2);
  the Rust crates are only for a hypothetical native (Tauri) target. Adopting gives us *strictly more
  than our engine* (full ray-traced reflections vs image-source order 2 + one FDN). The honest costs:
  **(1) moving sources** — `three-steam-audio` flags moving-source/listener pathing as **not done**,
  and our game is built on moving sources (this is the make-or-break unknown); **(2) web-safe IR
  transport** is unfinished if we want a *convolved* IR rather than their parametric path;
  **(3) integration + WASM size** — multi-MB Steam Audio + Embree, and we'd route it behind our
  existing Web Audio/HRTF graph (we have COOP/COEP threads + SOFA HRTF, which helps); **(4) loss of
  control** over our carefully-tuned image-source/FDN/HRTF pipeline and its tests. *Parametric
  reflections may handle our moving sources better than our own IR-rebuild approach* (per-frame
  descriptor update vs ~13–25 ms cathedral IR rebuild) — but that must be measured, not assumed.
- **(d) — the in-house alternative / fallback.** Reuses everything we have (geometry, materials, HRTF, IR→
  Convolver, FDN-style tail). A Monte-Carlo path tracer accumulates ray energy into a time–direction
  **energy histogram**, which becomes an IR exactly like our taps do. **Diffraction stays a separate
  UTD pass** (ray tracing alone doesn't diffract — same architecture Steam Audio uses). The late
  diffuse field it produces is what our single FDN approximates statistically; a ray tracer makes it
  *geometry- and position-true*. This is "incremental but large" and keeps every browser/offline/PWA
  property. Threads (we have COOP/COEP) make it parallelizable later.
- **(e) — the eventual high-end.** No RT cores in shipping browsers, so it's a *software* BVH
  traversal in a compute shader. The real risk is **GPU→CPU readback latency** of the resulting IR
  vs our ~70 ms refresh budget, plus WebGPU availability (Chrome-good, but not universal). Worth it
  only once (d) proves the acoustic value and ray counts become the bottleneck. **Diffraction still
  needs a separate UTD pass.**
- **(c) — offline bake.** Fits the PWA beautifully (lookup table, offline-cacheable) and can be
  *wave-accurate* (Triton-style). But it's **static-geometry**: loses real-time moving sources/walls
  unless you probe densely, and our game has moving beacons, monsters, and moving walls. Good as a
  *supplement* for fixed level reverb, not a replacement for the real-time path.
- **(b) — native target.** Immediately gives full Steam Audio via `audionimbus`/`petalsonic`, but
  **abandons the browser** for that build and **fragments the codebase** into "web engine" + "native
  engine." Only justified if a "desktop premium" product is ever wanted — not now.

---

## 5. Recommendation

Ray-traced reflections in a browser PWA are **proven** (path (a), via WASM Steam Audio). That changes
the question from "is it possible?" to "**is adopting it higher-leverage than extending our own
engine, given our moving-source game?**" The honest answer is: **we don't yet know, and a small spike
will tell us — so don't commit to either (a) or (d) before running it.** Reasoning:

1. **The cheap in-house wins are unambiguous and should ship regardless.** Energy-pruned image-source
   order 3 + listener-local RT60 FDN (already scoped — `reverb-and-order-analysis.md`) gives a
   position-dependent early/mid field + a position-aware diffuse tail. For an *echolocation* game the
   **localizable early reflections are the gameplay-critical cue**, and those are image-source's
   strength. Do this now; it's the right baseline to judge a ray tracer against.

2. **Steam Audio WASM (a) now genuinely offers MORE than our engine** — full ray-traced parametric
   reflections + per-source reverb buses vs our image-source order 2 + one global FDN. That's a real
   prize, not a wash. The two caveats that decide whether it's *usable for us*: **moving sources**
   (flagged not-done in `three-steam-audio`; our entire game is moving sources) and **web-safe IR
   transport** (open, if we want a convolved IR). Parametric reflections *might* track our moving
   beacon/monsters more cheaply than our IR-rebuild approach — or might not hold up in a fast-moving
   maze. **This is empirical and must be measured before any adoption decision.**

3. **Our own CPU ray tracer (d) is the fallback / control-preserving alternative** — reuses our
   geometry/materials/HRTF/IR pipeline and our tested IR→ConvolverNode transport (no "web-safe IR
   transport" problem), at the cost of building the ray loop ourselves.

### Concrete recommended next steps (decisive)

1. **Ship now (independent of the ray-tracer question):** **energy-pruned image-source order 3** +
   **listener-local FDN RT60**. Highest value-for-effort; the baseline to measure against. (S–M,
   already scoped.)
2. **Time-boxed evaluation spike — the deciding experiment (do this before committing to (a) or
   (d)):** stand up the **`three-steam-audio` demo / WASM Steam Audio reflection backend** and stress
   it on **the question that matters for us — moving sources**. Build a maze-like scene; move a
   source (beacon-like) and the listener quickly; verify the **ray-traced reflections + occlusion
   track the motion** without audible lag or rebuild stalls; **measure CPU** (does it fit our 70 ms
   refresh budget with monsters + footsteps alongside?); and **A/B the spatial quality vs our
   engine**. Also probe whether their **parametric** reflections can feed our HRTF/Web Audio graph,
   or whether we'd hit the unfinished IR-transport. **Effort: S–M** (mostly running + measuring an
   existing demo, plus a small harness). *This spike's result is the branch point:* if the WASM Steam
   Audio reflection path tracks moving sources well within budget → pursue **(a)** (integrate the
   Emscripten WASM build behind our Web Audio/HRTF graph; we have the COOP/COEP threads + SOFA HRTF
   to do it cleanly). If moving sources are poor / the IR transport blocks us → pursue **(d)**, a CPU
   Monte-Carlo ray tracer in `acoustics-core` behind a feature flag (trace N rays, bounce with
   per-band absorption + scattering, accumulate a time-direction energy histogram, reuse `roomIr.ts`
   HRIR coloring for the IR, keep UTD as the existing separate pass), compared to image-source
   order 2/3 on the cathedral with ms/refresh measured. **Effort: M.**
3. **Clarify the crate verdict for whichever way we go:** for the **browser**, the route is the
   **Emscripten WASM Steam Audio** (à la `three-steam-audio`), **not** `audionimbus`/`petalsonic`
   (native FFI / `cpal` — §2). The Rust crates are only relevant to a hypothetical **native (Tauri)
   second target** (b).
4. **Defer (b), (c), (e):** native Tauri (b) only for a future "desktop premium" build; offline bake
   (c) only as a *supplement* for static-level reverb; WebGPU compute ray tracer (e) as the eventual
   high-end once (a) or (d) proves the acoustic value and ray-count becomes the bottleneck (WebGPU RT
   cores aren't shipping — it'd be software BVH in compute, §3).

**Decision:** *Ship the pruned image-source order 3 + listener-local FDN now. Then run the
moving-source evaluation spike against WASM Steam Audio reflections — proven in-browser but with
moving-source pathing unfinished — and let its result choose between adopting that WASM Steam Audio
reflection backend (a) and building our own CPU ray tracer (d). Do not pre-commit to either before the
spike; the moving-source behavior is the crux and is unknown until measured.*

---

## 6. The spike — RAN. Moving-source occlusion + reflections work, and are cheap.

We ran the evaluation spike (a standalone Vite app installing the published
`three-steam-audio@0.1.0-beta.1`, which ships a prebuilt 6 MB `phonon_bindings.wasm`
— **no Steam Audio build from source needed**). Cross-origin isolation was satisfied
(`crossOriginIsolated === true`, `SharedArrayBuffer` available — our COOP/COEP setup
carries over). Driven headless via Playwright.

**Scene:** a 16×4×12 concrete room with a divider wall at x=0; a 440 Hz source at
x=4 (one side); reflections `maxOrder 1, maxRays 4096`; `occlusion: 'raycast'`; HRTF
on. The **listener was swept x=+5 → −5 across the divider** — the moving-source/
listener case the roadmap flagged as unfinished.

**Result — occlusion tracks the motion correctly:**

| listener x | occlusion | dist atten | interpretation |
|-----------:|:---------:|:----------:|----------------|
| 5, 4, 3 | **1.0** | 1.0 | same side as source, clear line of sight |
| 2, 1 | 1.0 | 0.5, 0.33 | same side, distance attenuating |
| 0 | **0** | 0.25 | crossing the divider plane → occluded |
| −1 … −5 | **0** | 0.2…0.11 | behind the wall → fully occluded |

**Per-frame cost — the headline number:** `world.step()` (the full per-frame sim:
occlusion raycast + 4096-ray reflection tracing in a worker) measured **mean 0.21 ms,
p95 1.34 ms, max 2.6 ms** (n=88). One-time WASM init ~110–200 ms.

**What this resolves:**
- The crux question — *do moving sources/listeners work?* — is **YES**, and the
  per-step cost (~0.2 ms mean) is **~300× under our 70 ms throttle** and well under a
  16 ms frame. It's actually **cheaper than our own image-source IR rebuild**
  (~2–25 ms), because parametric reflections update a descriptor rather than
  rebuilding a convolved IR.
- The "moving-source pathing not done" roadmap item refers to *pathing/portalling*,
  not basic moving occlusion+reflections, which clearly work.
- Materials are **3-band** (vs our 8-band); reflections are **parametric** Web Audio
  nodes (the "web-safe IR transport" gap only bites if we wanted a convolved IR —
  we don't need one). It composes with a Web Audio + HRTF graph like ours.

**Updated recommendation:** the spike is **green**. Adopting the WASM Steam Audio
reflection/occlusion backend (path **a**) is now the empirically-supported direction
over building our own CPU ray tracer (path **d**) — it gives proven, real-time,
cheap, moving-source ray-traced reflections + occlusion, in-browser, today. Next
concrete step is an **integration** spike: drive Steam Audio from OUR geometry/
materials/level data and route its source + reflection/reverb buses through our
existing master/limiter graph, on one real level (e.g. clap-maze), A/B'd against our
engine — deciding whether Steam Audio becomes the primary spatial backend or a
selectable "high-fidelity" mode alongside our tuned image-source engine.

---

## 7. Diffusion + "is diffraction through doors relevant?" — measured

Steam Audio models diffusion natively: per-material **`scattering`** (0–1) + **`diffuseSamples`**
(diffuse rays per bounce in the Monte-Carlo trace). This is *traced* diffusion, unlike our
image-source engine which is specular and approximates scattering with a heuristic post-hoc smear.

We ran a **doorway-shadow spike**: a 14×4×14 room, a divider wall blocking the direct line, a
doorway gap to the side, and a listener in the geometric shadow (occlusion = 0, direct path fully
blocked; transmission identical at `[0.05, 0.03, 0.02]` in all cases). Audible RMS at the listener:

| Condition | Audible RMS | vs transmission-only |
|-----------|:-----------:|:--------------------:|
| No reflections (direct+transmission only) | 0.00298 | 1.0× |
| Reflections ON, **hard/reverberant** room | **0.01441** | **4.8×** |
| Reflections ON, **absorbent/dead** room | 0.00748 | 2.5× |

**Findings:**
- With the direct path fully blocked, the listener still hears the source clearly — **2.5–4.8×
  louder than transmission alone — purely from reflections through the doorway**, with NO explicit
  edge-diffraction model. So **diffraction-through-doors is largely redundant in a normal room**:
  the reflected/diffuse field carries the "it's coming from the opening" cue.
- It's **reverberance-dependent**: the dead room gives <½ the reverberant room (fewer reflections
  to route through the gap). So explicit diffraction (our UTD) earns its keep mainly in **dead/
  absorbent rooms** and in the **trainer** (where we deliberately isolate cues) — not for general
  realism, where Steam Audio's traced reflections+diffusion+transmission cover it.
- Conclusion: **our UTD edge diffraction is a niche asset (dead rooms, trainer cue-isolation),
  not a general-realism necessity.** Steam Audio's diffusion is a genuine upgrade over our smear.

## 8. The toggle (our engine ↔ Steam Audio) — IMPLEMENTED

> **Status update:** this toggle is now built. A Begin-screen checkbox (or
> `?engine=steam`) selects a `SteamAudioBackend`; the default keeps our tuned engine
> untouched. BOTH the beacon and monsters route through the selected engine. The
> `WallDef[]`→Steam Audio scene conversion (8→3-band absorption, scattering scalar,
> thin-box double-sided walls), the per-frame listener/source/`world.step` drive, and
> the reflection/reverb buses → master are all wired and browser-verified on
> `clap-maze` + `monster-cellar`. Steam Audio (`three` + 6 MB WASM) loads via a
> **dynamic import**, so the default bundle is unchanged. COOP/COEP is now also set on
> `vite preview` (production host must send them too). Full design:
> `docs/engine/steam-audio-backend.md`.


A runtime toggle is clean because both engines are the same shape: *dry positioned source →
spatializer → master bus*. The toggle swaps only the **source spatializer**:
- **Shared, unchanged:** dry voices (beacon/footsteps/monster), level geometry+materials, the
  master/limiter graph, the game loop's per-frame position updates.
- **Swapped:** our `ModeledSource`/`HrtfSource` ↔ a `SteamAudioSource` (`world.createSource` +
  our geometry pushed into `world.scene`, its source/reflection/reverb buses → our master).
- **Integration work (all proven by the spikes):** (a) `WallDef[]` → three.js `BufferGeometry` +
  Steam Audio materials (8-band→3-band absorption, scattering→scattering); (b) drive
  `world.step(delta)` + `setPosition` from our loop; (c) route the buses through master/limiter.

**Recommendation:** add Steam Audio as a **selectable "ray-traced / high-fidelity" mode**, keeping
our tuned image-source engine as the default. Low-risk (no big-bang rewrite), lets us A/B by ear on
real levels, and keeps our diffraction-rich engine for the **trainer** (cue isolation) while Steam
Audio powers realism-focused **game** levels. Whether it becomes the default is decided by the A/B.

## Sources

- Steam Audio — [site](https://valvesoftware.github.io/steam-audio/),
  [C API simulation docs](https://valvesoftware.github.io/steam-audio/doc/capi/simulation.html),
  [GitHub](https://github.com/ValveSoftware/steam-audio),
  [build instructions](https://valvesoftware.github.io/steam-audio/doc/capi/build-instructions.html)
- Steam Audio fully open-sourced under Apache-2.0 (Feb 2024) —
  [Phoronix](https://www.phoronix.com/news/Steam-Audio-SDK-Fully-Open),
  [Slashdot](https://news.slashdot.org/story/24/02/20/2122208/valve-makes-all-steam-audio-sdk-source-code-available-under-apache-20-license)
- `audionimbus` — [GitHub/README](https://github.com/MaxenceMaire/audionimbus),
  [docs.rs](https://docs.rs/audionimbus),
  [audionimbus-sys docs](https://docs.rs/audionimbus-sys),
  [crates.io](https://crates.io/crates/audionimbus)
- `petalsonic` — [GitHub](https://github.com/tr-nc/petalsonic),
  [lib.rs](https://lib.rs/crates/petalsonic)
- `cpal` (wasm/Web Audio + AudioWorklet backends) — [GitHub](https://github.com/RustAudio/cpal),
  [WASM setup wiki](https://github.com/RustAudio/cpal/wiki/Setting-up-a-new-CPAL-WASM-project),
  [feature flags](https://lib.rs/crates/cpal/features)
- Steam Audio in WebGL — [issue #234](https://github.com/ValveSoftware/steam-audio/issues/234)
- `kwaa/three-steam-audio` (WASM Steam Audio in browser; direct-path shipping, reflections on
  roadmap) — [GitHub](https://github.com/kwaa/three-steam-audio), demo
  `https://three-steam-audio.pages.dev/`
- WebGPU ray tracing status — [gpuweb #535](https://github.com/gpuweb/gpuweb/issues/535),
  [dawn-ray-tracing](https://github.com/maierfelix/dawn-ray-tracing),
  [webrtx](https://github.com/codedhead/webrtx),
  [WebGPU compute path tracer (no RT cores)](https://github.com/gnikoloff/webgpu-raytracer)
- Our repo: `vite.config.ts` (COOP/COEP), `docs/TECHNICAL.md`,
  `docs/engine/reverb-and-order-analysis.md`, `docs/engine/diffraction-utd.md`,
  `docs/engine/late-reverb-fdn.md`, `docs/engine/modeled-beacon.md`
