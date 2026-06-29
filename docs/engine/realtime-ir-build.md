# Real-time room-IR build (WASM + FFT convolution)

## The bottleneck

The acoustics *solve* (image-source) is cheap (0.03–1.4 ms). The expensive step is
the **IR build** in `src/engine/acoustics/roomIr.ts` — `buildRoomIr(taps, hrtf, opts)`
collapses N taps into one stereo impulse response. Per tap it:

1. picks the HRIR pair for the tap's (head-relative) arrival direction (`nearestDir`),
2. builds a short frequency-sampled, Hann-windowed FIR (`bandFir`) matching the tap's
   8-band gains,
3. **convolves** that FIR into both ear HRIRs (the costly part),
4. scales by the broadband 1/r gain and accumulates at `round(delay × sampleRate)`,
5. for rough surfaces, spreads `s` of a reflection's energy into a short diffuse smear
   (6 jittered, decaying copies over ~20 ms; **order-0 direct path is never scattered**).

Step 3 is a direct (O(N·M)) convolution of a ~256-tap FIR into a ~256-tap HRIR, run
twice per tap (L+R) and once per scattering copy. In plain JS this dominates — ~32 ms
in the browser for a typical room (more in Node), far too slow to rebuild every frame
for continuously moving walls.

## The approach: FFT/overlap-add convolution in Rust/WASM

New Rust module `acoustics-core/src/ir_build.rs`, exposed via `lib.rs` as
`build_room_ir(...)` (additive — no existing signatures touched). It is a bit-faithful
port of the JS numerics (same `band_fir` frequency-sampling formula, same Hann window,
same scattering LCG and copy logic, same output-length formula and delay placement), so
the same taps produce a perceptually equivalent IR.

**Equivalence guarantee.** The port is sample-faithful, not just perceptual: the
scattering LCG divides in f64 then narrows to f32 to exactly match the JS `seed /
0xffffffff` (an earlier f32 divide lost mantissa bits and desynced the smear). For a
**non-scattered** IR the WASM and JS stereo outputs match sample-for-sample to <1e-4
(only FFT-vs-direct float error remains); for a scattered IR total energy matches within
a few percent and the direct-path peak position is identical. This is pinned by
`tests/roomIrEquiv.test.ts` (and the looser energy/peak check in `roomIrBench.test.ts`).

The one substitution: the per-tap convolution (FIR ⊛ HRIR) is done with **FFT-based
convolution** (`rustfft`). Per build we plan one forward + one inverse FFT at
`fft_size = next_pow2(2·hrir_len − 1)`. For each tap the FIR is transformed **once** and
reused for both L and R ears (the coloring is direction-independent), so the cost is
2 forward + 2 inverse FFTs per tap instead of an O(M²) direct convolution.

**Planner cache.** `fft_size` depends only on `hrir_len` (constant for a given HRTF
set), so the planner, the forward/inverse FFT plans and the convolver scratch buffers
are cached in a `thread_local!` keyed by `fft_size` and reused across `build_room_ir`
calls. This is what makes the moving-walls hot path (rebuild every frame) avoid
re-planning the same FFT each frame. The cached scratch (`fir_spec`/`scratch_a`) is fully
overwritten on every use, so reuse does not change the output.

`rustfft` 6 was added to `acoustics-core/Cargo.toml` (standard, pure-Rust, WASM-clean).

## JS↔WASM split (and why)

- **JS keeps** the SOFA loader and the cheap `nearestDir` linear scan + `getIrPair`.
  That scan is ~microseconds over ~2800 directions and depends on the HRTF binary
  format, which has no reason to cross the WASM boundary.
- **JS packs** per tap `[delay, gain, order, band0..7]` plus the already-selected L/R
  HRIR samples into three flat `Float32Array`s.
- **WASM owns** the expensive work: `band_fir` coloring, FFT convolution, 1/r scaling,
  accumulation, and the scattering smear. It returns `[length, left.., right..]` flat.

This keeps the SOFA/HRTF code JS-only while moving 100% of the per-tap arithmetic into
Rust. (Alternative: ship the whole HRIR table into WASM and do `nearestDir` there too —
rejected: it would marshal ~5.5 MB and duplicate the loader for no speed gain, since the
scan is already negligible.)

## Call path

`clapRoom.ts` / callers → `buildRoomIr(taps, hrtf, opts)`
→ default dispatches to `buildRoomIrWasm` (JS resolves HRIR pairs, packs flat, calls
WASM `build_room_ir`) → splits the returned flat buffer into `{left, right}`.

`buildRoomIr` falls back to the JS reference `buildRoomIrJs` **only** when the WASM module
isn't initialized yet (`isAcousticsReady()` is false, checked via the flag `initAcoustics()`
sets) — so early-startup callers never hard-fail. Once WASM is ready, an error thrown by
`build_room_ir` is **not** swallowed: it propagates rather than silently substituting a
(potentially divergent) JS IR, so real WASM bugs surface instead of producing wrong audio.
Force a path with `buildRoomIr(taps, hrtf, { impl: 'js' | 'wasm' })`. The public signature
is unchanged for existing callers.

The WASM output's length is read as `out[0] | 0` (it's transported as a float) and the
floored integer is used for all downstream slicing.

## Measured before/after

Representative 6-wall shoebox (6×3×8 m, brick/concrete/wood), 256-tap HRIR, scattering
0.3, measured in vitest/Node (20-iter mean; absolute ms are higher than the browser but
the *ratio* is the point). See `tests/roomIrBench.test.ts`.

| Order | Taps | JS build | WASM build | Speedup |
|------:|-----:|---------:|-----------:|--------:|
| 2     | 25   | 61.7 ms  | 10.2 ms    | 6.0×    |
| 3     | 63   | 153 ms   | 25.6 ms    | 6.0×    |

(Measured after caching the FFT planner — at least as fast as the per-build-planner
version, slightly faster on these repeated-call benchmarks.)

Equivalence: a non-scattered IR matches sample-for-sample to <1e-4; with scattering,
total IR energy matches within a few percent and the direct-path peak position is
identical (see `tests/roomIrEquiv.test.ts`).

### Crossover

WASM wins from very low tap counts upward — there is no FFT-overhead penalty at the tap
counts that occur in practice (10–100+ taps), because each tap's convolution is the unit
of work and FFT beats direct convolution at the 256-sample HRIR length regardless of how
many taps there are. The fixed per-build cost is one FFT plan (cached for the build). For
a degenerate 1–2 tap IR the two paths are both sub-millisecond and the difference is
irrelevant.

## Remaining limitations

- **`band_fir` is still O(length²) per tap** and now the dominant term in the WASM path
  (the FFTs are cheap by comparison). It is a frequency-sampling FIR design that could
  itself be done with an inverse FFT of the sampled magnitude; left as the next lever
  since it must stay bit-equivalent to the JS reference the tests assert against.
- **HRIR marshalling**: JS copies the selected L/R HRIR samples (hrir_len each) per tap
  across the boundary. For ~100 taps × 256 samples × 2 that's ~50 K floats — negligible,
  but it scales with tap count.
- The WASM path requires `initAcoustics()` to have run; until then callers transparently
  use the JS fallback. (FFT planning is now cached in a `thread_local!` keyed by
  `fft_size`, so the steady moving-wall loop re-plans nothing per frame.)

## How this unblocks moving walls

The clap/IR pipeline (`clapRoom.ts` → `buildRoomIr` → `ConvolverNode`) was already the
moving-walls foundation; the IR build was the single ~32 ms blocker called out in
`docs/TECHNICAL.md` §9/§11. At ~6× faster the build drops into a budget where geometry
can re-solve and the IR can rebuild on a tight throttle (with the existing crossfade)
rather than only on-demand per clap. Pushing the `band_fir` design onto FFT next would
take it further into per-frame territory.
