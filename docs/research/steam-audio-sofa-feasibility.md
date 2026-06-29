# Steam Audio custom-SOFA HRTF feasibility (three-steam-audio WASM)

**Date:** 2026-06-29
**Method:** Source-reading + binary inspection feasibility study. emsdk (emcc 5.0.6),
cmake 3.x and python3 are present on this machine; a full test-compile of the
Steam Audio WASM was **not** performed (toolchain is available, so it is possible —
see "Build toolchain"), but the decisive facts were established by reading source and
inspecting the shipped binary, which is sufficient.

**Repos cloned (siblings of papasangre):**
- `/home/ivan/pproject/three-steam-audio` — the wrapper (kwaa/three-steam-audio).
  NOTE: this local clone is the **full source repo** with the C binding layer and
  build scripts; it is richer than the published npm `dist/` in papasangre's
  node_modules.
- `/home/ivan/pproject/steam-audio` — Valve's Steam Audio (ValveSoftware/steam-audio).

---

## Headline finding

**Custom in-memory SOFA HRTF is essentially already supported by the binary; only a
~3-line C shim change plus a small JS wrapper method are missing.** The shipped
`phonon_bindings.wasm` **already contains libmysofa and the SOFA loader code** — it is
just not reachable because the C shim hardcodes the default HRTF type.

Verified directly: `strings node_modules/three-steam-audio/dist/bindings/phonon_bindings.wasm`
contains `SOFAConventions`, `hrtfSettings->sofaData`, `hrtfSettings->sofaDataSize`,
"ARI SOFA API", and a baked path
`.../mysofa/install/wasm/.../default.sofa`. The SOFA reader is compiled in and dead
weight today.

---

## 1. Binding architecture: how `_sa_hrtf_create` wraps `iplHRTFCreate`

**Binding layer location:** `/home/ivan/pproject/three-steam-audio/bindings/bindings.c`
(765 lines). It is a thin C shim (`sa_*` functions) over Steam Audio's `ipl*` C API,
compiled to WASM with emscripten and linked against the prebuilt `libphonon.a`.

The current `sa_hrtf_create` (bindings.c lines 240–254):

```c
int sa_hrtf_create(void* ctx, int sample_rate, int frame_size, void** out_hrtf)
{
    if (!ctx || !out_hrtf) return 1;
    IPLAudioSettings audio;
    IPLHRTFSettings settings;
    memset(&audio, 0, sizeof(audio));
    memset(&settings, 0, sizeof(settings));
    audio.samplingRate = sample_rate;
    audio.frameSize = frame_size;
    settings.type = IPL_HRTFTYPE_DEFAULT;   // <-- hardcoded; this is the entire gap
    settings.volume = 1.0f;
    settings.normType = IPL_HRTFNORMTYPE_NONE;
    IPLerror error = iplHRTFCreate((IPLContext)ctx, &audio, &settings, (IPLHRTF*)out_hrtf);
    return error == IPL_STATUS_SUCCESS ? 0 : (int)error;
}
```

Exported with `EMSCRIPTEN_KEEPALIVE`; surfaces as `Module._sa_hrtf_create(ctx, sr,
frame, out_hrtf)`. The TS signature in `dist/bindings/phonon_bindings.d.ts:24` matches:
`_sa_hrtf_create(ctx, sample_rate, frame_size, out_hrtf): number` — **no SOFA argument**,
exactly as the brief stated.

**JS call site:** the worklet processor creates the HRTF, not the main thread.
`dist/steam-audio-processor.js:39–41`:

```js
const hrtf = createHandle(module, out =>
  module._sa_hrtf_create(context, sampleRate, frameSize, out))
```

So a SOFA buffer would have to be transferred into the AudioWorklet (via the worklet's
`processorOptions` / a port message) and `_malloc`'d into WASM heap before the call.

## 2. Steam Audio C API for SOFA (confirmed)

`/home/ivan/pproject/steam-audio/core/src/core/phonon.h`:
- `IPLHRTFType` enum includes `IPL_HRTFTYPE_SOFA` (line 1390).
- `IPLHRTFSettings` struct (lines 1404–1425) fields: `type`, `sofaFileName`,
  `sofaData` (`const IPLuint8*`), `sofaDataSize` (`int`), `volume`, `normType`.
- The **in-memory path exists**: docs explicitly say "Either `sofaFileName` or
  `sofaData` should be non-NULL." This is the path we need in WASM (no filesystem).

Loader implementation `core/src/core/sofa_hrtf_map.cpp`:
- Line 17 gates SOFA on OS: `#if defined(IPL_OS_WINDOWS) || ... || defined(IPL_OS_WASM)`
  — **WASM is explicitly enabled.**
- Line 37 file path: `mysofa_open_no_norm(sofaFileName, ...)`.
- Line 46 in-memory path: `mysofa_open_data_no_norm(sofaData, sofaDataSize, ...)`
  — exactly the call we rely on.

Validation `core/src/core/api_hrtf.cpp:48–49,91–94` copies `sofaData`/`sofaDataSize`
through and rejects a SOFA type with both pointers NULL, or `sofaData != NULL` with
`sofaDataSize == 0`.

**SOFA reader dependency:** Steam Audio uses **libmysofa** (`MySOFA::MySOFA`, linked
in `core/src/core/CMakeLists.txt:624`). libmysofa pulls in **zlib**. Both are already
handled in the wrapper build (see below) and already present in the shipped binary.

## 3. Build toolchain and feasibility

**Wrapper build (`/home/ivan/pproject/three-steam-audio/Justfile`):**
1. `get_dependencies` → `python3 get_dependencies.py --platform wasm` (fetches deps:
   flatbuffers, pffft, mysofa, zlib).
2. `patch` → applies two patches from `patches/steam-audio/`: a flatbuffers-1.12
   comparator fix and an **emscripten synchronous thread-pool** patch.
3. `build-steam-audio` → `python3 build.py --platform wasm --minimal --operation
   ci_build` → produces `libphonon.a`.
4. `build-bindings` → **`emcc -O3`** compiling `bindings/bindings.c` and statically
   linking:
   - `steam-core/bin/lib/wasm/libphonon.a`
   - `deps/pffft/lib/wasm/release/libpffft.a`
   - **`deps/mysofa/lib/wasm/release/libmysofa.a`**  ← SOFA reader already linked
   - **`deps/zlib/lib/wasm/release/libz.a`**         ← mysofa's zlib dep already linked
   with `-s EXPORT_ES6=1 -s ENVIRONMENT=web,worker -s ALLOW_MEMORY_GROWTH=1`,
   exporting `_malloc`/`_free` and runtime methods (`getValue`,`setValue`,heaps).

**This means SOFA never required a new porting effort — it was compiled and linked
from day one.** The only reason it is unreachable is the hardcoded `type` in the shim.

**Toolchain on this machine:** `emcc 5.0.6` at `/home/ivan/emsdk`, `cmake` and
`python3` present. `flake.nix` shows the canonical build uses Nix-provided emscripten +
cmake with `CMAKE_POLICY_VERSION_MINIMUM=3.5` and `STEAMAUDIO_ROOT=$PWD/steam-audio`.
A from-scratch rebuild is plausible here but involves `get_dependencies.py` downloads
and the two patches; the main risk is emscripten-version drift (repo targeted an older
emscripten; 5.0.6 is newer and may need minor patch fixups). **A full rebuild is not
required to ship SOFA** if we accept editing the WASM-producing source and rebuilding
only the bindings (which still needs `libphonon.a` + the dep `.a`s — these come from
the steam-audio build, so at minimum the steam-audio WASM build must succeed once).

**Existing forks/issues:** the wrapper's own README roadmap lists SOFA as the next
unchecked item (see §5), i.e. the maintainer already intends it; the plumbing
(mysofa linked) is staged for it. No blocker found in either repo.

## 4. Exact change needed + effort/risk

**(i) C shim — expose in-memory SOFA (`bindings/bindings.c`).** Add an optional
data pointer/size, e.g. a new export:

```c
int sa_hrtf_create_sofa(void* ctx, int sample_rate, int frame_size,
                        const unsigned char* sofa_data, int sofa_size,
                        void** out_hrtf)
{
    if (!ctx || !out_hrtf || !sofa_data || sofa_size <= 0) return 1;
    IPLAudioSettings audio; IPLHRTFSettings settings;
    memset(&audio,0,sizeof(audio)); memset(&settings,0,sizeof(settings));
    audio.samplingRate = sample_rate; audio.frameSize = frame_size;
    settings.type = IPL_HRTFTYPE_SOFA;
    settings.sofaData = (const IPLuint8*)sofa_data;
    settings.sofaDataSize = sofa_size;
    settings.volume = 1.0f; settings.normType = IPL_HRTFNORMTYPE_NONE;
    IPLerror error = iplHRTFCreate((IPLContext)ctx, &audio, &settings, (IPLHRTF*)out_hrtf);
    return error == IPL_STATUS_SUCCESS ? 0 : (int)error;
}
```

Keep the existing `sa_hrtf_create` for the default path. ~12 lines. **Effort: trivial.**
Requires recompiling `bindings.c` with emcc and relinking the existing `.a`s
(`libphonon.a`, `libmysofa.a`, `libz.a`, `libpffft.a`) — the heavy steam-audio
build can be reused if those `.a`s are available; otherwise it must be run once.

**(ii) JS wrapper — pass a SOFA ArrayBuffer.** In `steam-audio-processor.js` the HRTF
is created **inside the AudioWorklet**, so the buffer must reach the worklet:
- Add a `sofaData?: ArrayBuffer` option to the world/source HRTF settings (today
  `HRTFSettings = { type?: 'default' }`).
- Transfer the ArrayBuffer to the worklet (processorOptions or postMessage; transfer,
  don't copy — ~6–12 MB).
- In the processor: `_malloc(size)`, `HEAPU8.set(new Uint8Array(buf), ptr)`, call
  `_sa_hrtf_create_sofa(ctx, sr, frame, ptr, size, out)`, then `_free(ptr)` after
  the HRTF is built. Update `phonon_bindings.d.ts`.
**Effort: small–moderate** (the worklet transfer + heap marshalling is the only
fiddly part; ~30–60 lines across processor + world + types).

**(iii) Other quick-win roadmap items:** see §5 — the only other arguably-quick one is
"better validation/diagnostics"; the rest (convolution IR transport, pathing,
Ambisonics) are substantial and out of scope.

**WASM size impact:** **zero additional** — mysofa+zlib are *already* in the 6.0 MB
binary. Adding the new shim export changes size by bytes. (If anything, SOFA is
already paying its size cost whether or not we use it.)

**Risks:**
- Worklet ArrayBuffer transfer plumbing (main → node → worklet) is the most error-prone
  piece; needs the buffer present before `_sa_hrtf_create*` runs.
- SADIE `.sofa` must be a libmysofa-compatible SimpleFreeFieldHRIR convention at a
  sample rate Steam Audio resamples from; mismatch yields an `iplHRTFCreate` error code
  (handle the non-zero return → `node.ready` rejects).
- If we must rebuild `libphonon.a` from scratch, emscripten 5.0.6 vs the repo's pinned
  toolchain is the main schedule risk (patch fixups).
- npm package ships only `dist/`; to change the WASM we must build from the *source*
  repo (the sibling clone) or vendor a patched `dist/` into papasangre.

## 5. Roadmap gap list (wrapper README, lines 132–155)

Incomplete (`[ ]`) items:
- **Add support for custom HRTFs via SOFA files.**  ← our target
- Improve direct-path usability with better validation, diagnostics, and
  browser/runtime error handling.
- Add convolution or hybrid reflections through a web-safe IR transport.
- Add pathing for moving sources and listeners without introducing baking workflows.
- Add Ambisonics support.
- Investigate web-appropriate acceleration paths after the runtime feature set is stable.

(Completed already: WASM runtime, AudioWorklet binaural pipeline, direct-path sim,
built-in HRTF, materials, static + rigid dynamic meshes, Three/R3F API, worker
parametric reflections, reflection/reverb buses.)
Non-goals: probe/baked workflows, Unity-style editor authoring.

## 6. License confirmation

- **Steam Audio:** Apache-2.0 (`steam-audio/LICENSE.md`). Permits fork, modify,
  rebuild, redistribute (incl. modified WASM) with attribution + NOTICE.
- **three-steam-audio:** Apache-2.0 (`three-steam-audio/LICENSE`).
- libmysofa is BSD-style; zlib is zlib-license — both permissive and already embedded.
- The wrapper README already carries the required Steam Audio / Valve trademark
  acknowledgement; preserve it in any redistribution.

**Conclusion: no licensing blocker** to forking, rebuilding, and shipping a modified
WASM in papasangre.

---

## Difficulty rating: **EASY → low-MODERATE**

Justification: the underlying SOFA capability is fully present and *already compiled
into the shipped binary* (mysofa + in-memory `sofaData` path, WASM explicitly enabled
in the SOFA OS gate). The C-side change is ~12 lines. The only real work and risk is
(a) producing a rebuilt WASM at all (needs the steam-audio WASM build to run once, where
emscripten-version drift is the schedule risk) and (b) wiring an ArrayBuffer through the
AudioWorklet to the heap. Nothing is **blocked**.

## Recommendation

**Not worth rebuilding the WASM for SOFA — for our use case keep the custom
interpolating-worklet renderer as the default; treat Steam-SOFA as an optional,
later experiment.**

Reasoning:
- We already have a **click-free, SADIE-HRTF interpolating worklet** that is the
  papasangre default; `?engine=steam` is an *optional* high-fidelity backend. The user
  value of making the optional backend also use our SADIE HRTF is marginal versus the
  default already doing so.
- The win is real but modest: Steam Audio's binaural would then use *our* measured HRTF
  instead of its generic one — nice for A/B fidelity comparisons, not a gameplay change.
- Cost is dominated not by the (trivial) code change but by owning a **forked/rebuilt
  WASM toolchain** (emscripten build of steam-audio + dep fetching + two patches +
  vendoring a non-npm `dist/`). That is ongoing maintenance for an optional feature.
- If/when we do it: it is a clean, well-scoped task (one new `sa_hrtf_create_sofa`
  export + worklet buffer transfer), zero WASM size cost, and Apache-2.0-clean. A good
  candidate for a follow-up spike, ideally upstreamed as a PR against the wrapper's own
  open roadmap item rather than maintained as a private fork.

**Suggested trigger to revisit:** if we want a rigorous A/B of Steam Audio's
reflections/occlusion *combined with* our measured SADIE HRTF, or if the wrapper
maintainer lands the roadmap SOFA item upstream (then it is just a version bump).
