# Cycle 9 — Full Regression + Bundle/Perf Audit (Build 9B)

**Date:** 2026-06-29
**Scope:** Full unit + e2e + typecheck + production build/bundle audit + acoustics perf sanity,
after the cycle-8 sprint (23 builds). Verify-and-report; fix only genuine regressions.
**Verdict:** **CLEAN — no regressions found.** All suites green, typecheck clean, build succeeds,
and the default bundle is lean (three.js + Steam Audio WASM remain lazy-only, not preloaded).
Nothing was changed. A few non-blocking follow-ups are listed at the end.

---

## 1. Unit suite — `npm test`

- **573 / 573 passed**, 53 files, ~21s. Matches baseline (~573). **No failures, no flakes.**
- Heaviest: `sandboxGenerator.test.ts` (31 tests, ~19s, 800 fuzzed levels), `roomIrBench` (~5.6s).

## 2. E2E suite — `npm run e2e` (Playwright, builds + previews)

- **26 / 26 passed**, 8 workers, ~28s. Matches baseline (~26). **No failures, no flakes.**
- Covers a11y live regions, daily challenge/streak, editor, find-the-absorber, keyboard
  completion + best-time comparison, onboarding/primers, sandbox, settings, sonar-vault,
  stealth escape + decoy, TTS voice. Slowest: `sonar-vault` out-of-budget (14.5s, expected drain).

## 3. Typecheck — `npx tsc --noEmit`

- **Clean (exit 0)**, zero errors. (No `three-steam-audio/bindings.c` errors surfaced; that
  sibling-repo exclusion was a no-op this run.)

## 4. Production build + bundle audit — `npm run build`

Build **succeeds** (`✓ built in ~8.7s`, 109 modules). One expected/benign warning: the
`new URL("phonon_bindings.wasm", import.meta.url)` runtime-resolved path (Steam Audio glue),
plus the standard >500 kB chunk note for `three.module`.

### PWA artifacts — all present
`dist/sw.js`, `dist/workbox-*.js`, `dist/manifest.webmanifest`, `dist/_headers`,
`dist/hrtf-worklet.js`, and icons (`icon-192.png`, `icon-512.png`, `icon-maskable-512.png`). ✅

### Bundle bloat check — default path is LEAN ✅ (no regression)

The key regression guard ("default game must NOT eagerly pull in three.js / Steam Audio WASM")
**holds**:

- **Entry HTML (`index.html`)** scripts/modulepreloads: `main` + `materials`, `toggle`,
  `customAudio`, `monsterSounds`. **`three.module`, `phonon`, `backend`, and `index-r`
  (steam backend) are NOT preloaded by any HTML.** ✅
- **Entry/main chunk** `main-CuCJhxOX.js` = **91.35 kB (gzip 30.31 kB)** — statically imports
  only the clean `toggle` chunk (which itself has **no** static three/phonon import).
- The Steam backend is reached **only via a dynamic import**, gated on the engine toggle
  (seeded from `?engine=steam`): `main.ts:444` / `trainer.ts:186`
  `await import('./engine/steamaudio/backend')`. In the bundle:
  `main → import("./backend-*.js") → (static) three.module + index-r (phonon)`. The static
  three/phonon import lives *inside* the lazy `backend` chunk, so it only loads when steam is
  selected. ✅
- **Lazy chunks (not on default path):** `three.module-*.js` 704.88 kB (gzip 181 kB),
  `index-r-*.js` 75.33 kB (steam/phonon backend), `phonon_bindings-*.wasm` 6,055 kB,
  `steam-audio-processor-*.js` 13.93 kB, `reflection-simulator-worker-*.js` 45 kB,
  `backend-*.js` 4.29 kB.

### Precache total + largest assets

- **27 entries / 7,219.6 KiB (~7.05 MB)** precached.
- Largest precached: **phonon_bindings.wasm 5,913 KiB** · three.module.js 688 KiB ·
  acoustics_core_bg.wasm 238 KiB · main.js 89 KiB · index-r.js 74 KiB.
- The **5.8 MB SADIE HRTF** (`assets/hrtf/sadie_h3.hrtf`) is **runtime-cached, NOT precached**
  (so it is *not* in the 7.05 MB above) — expected.

> **Note (not a regression, follow-up):** the lazy Steam Audio assets (phonon WASM 5.9 MB +
> three 688 KB + steam worker/processor) **are in the SW precache** even though they never load
> on the default runtime path — they dominate the precache (~6.6 MB of 7.05 MB). This is a
> pre-existing vite-plugin-pwa glob behavior (`dist/assets/**`), not a this-session eager-load
> regression. Default *runtime* download stays lean; only the SW *precache* footprint is large.
> Candidate follow-up: exclude steam/phonon/three from `globPatterns` / precache so first-load
> install isn't ~6 MB heavier than the default engine needs. Flagged, not changed (out of scope
> for a regression fix).

## 5. Acoustics perf sanity (light) — used existing benches, no new harness

**Image-source order cost** (`orderCostBench.test.ts`, heaviest authored levels):

| level       | walls | order | taps | solve ms | IR-build ms | total ms |
|-------------|-------|-------|------|----------|-------------|----------|
| open-street | 9     | 3     | 6    | 0.10     | 2.78        | 2.87     |
| clap-maze   | 9     | 3     | 9    | 0.08     | 3.96        | 4.04     |
| cathedral   | 10    | 3     | 57   | 0.13     | **25.95**   | **26.07**|

Reflection **solve** is sub-millisecond even at order 3; cost is in IR-build, ~26 ms worst-case
(cathedral, order 3, 57 taps) — non-pathological for an offline/precomputed IR.

**Room-IR WASM vs JS** (`roomIrBench.test.ts`): order 2 — JS 187 ms / WASM 52 ms (3.6×);
order 3 — JS 623 ms / WASM 33 ms (18.9×). WASM path healthy.

**Interpolating HRTF worklet DSP** (`interpolatingHrtf.test.ts` + `audioArtifacts.test.ts`):
step-discontinuity acceptance + min-phase magnitude/ITD tests pass. Per-block render timings:
rotation 32.0 ms, walking 16.3 ms (over their full block sequences, maxRatio 0.1 — no step
spikes); roomswap stress 216.3 ms (maxRatio 4.8, an intentional hard transition). No pathological
per-block cost.

## 6. Dead-code / consistency quick scan (LIST only — not removed)

- **`BeaconVoice.setProximity`** (`src/game/beaconSounds.ts:185`) — **genuinely unused**:
  defined and mentioned only in a code comment (`game.ts:397`), never actually called
  (`grep '.setProximity('` → no real call site). Confirms the prior flag. Follow-up candidate.
- **Legacy `HrtfSource`** (`src/engine/hrtf/renderer.ts:163`) — the non-interpolating,
  buffer-swap / dual-chain (`#makeChain`) renderer. **Still in use** (tutorial, calibration,
  game beacon fallback + monsters), so not dead overall — but it is the legacy path superseded
  by `InterpolatingHrtfSource`. Its dual-convolver crossfade machinery is a consolidation
  candidate once monsters move to the interpolating renderer (documented follow-up in
  `game.ts:97`). Do not remove now (fallback + monster path depend on it).

---

## Regressions found / fixed

**None.** Nothing was changed — all gates were already green. (Per fix policy, no features added,
leaderboard/9A untouched.)

## Bottom line

573 unit + 26 e2e green, tsc clean, build green. Default bundle confirmed lean: entry/main =
91 kB, three.js + Steam Audio WASM are lazy chunks behind a dynamic `import()` gated on
`?engine=steam`, not preloaded by any entry HTML. Precache 27 entries / 7.05 MB. Perf within
normal envelope. Release-stable from a regression standpoint; two non-blocking follow-ups
(precache-excluding the lazy steam assets; removing the unused `setProximity`) flagged for PM.
