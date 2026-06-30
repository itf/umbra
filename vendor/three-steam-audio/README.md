# vendor/three-steam-audio (prebuilt fork)

Committed, prebuilt copy of the `three-steam-audio` fork
(`kwaa/three-steam-audio`, branch `feat/sofa-hrtf` @ `b3838eb`), adding two features the
published npm package (`0.1.0-beta.1`) does NOT have:

- SOFA custom HRTF (`hrtf: { type: 'sofa', data }`) — feed our measured SADIE SOFA.
- Head-tracked Ambisonic reflections (`reflections: { headTracked, maxOrder, irTaps }`)
  — the reflected field rotates with the listener instead of being mono-duplicated
  dead-center, so raising reflection level no longer masks the direct path (maze fix).

papasangre depends on this via `"three-steam-audio": "file:vendor/three-steam-audio"`,
so `npm install` from a fresh clone works with NO external path and NO build step — the
built `dist/` (tsdown JS + emscripten `phonon_bindings.{js,wasm}`) is committed here. The
fork's own `dist/` is gitignored (a build artifact), which is why we vendor the output.

## Bundle impact
The 6 MB `dist/bindings/phonon_bindings.wasm` is lazy-loaded only on `?engine=steam`
(dynamic `import('three-steam-audio')` in `src/engine/steamaudio/backend.ts`) and
excluded from the PWA precache. The default `?engine=ours` bundle ships neither `three`
nor the WASM.

## Rebuilding
Run `scripts/vendor-steam-audio.sh` from the papasangre root (needs the fork checkout +
`pnpm`; WASM rebuilds also need emsdk). `package.json` here is hand-maintained (dev/peer
`catalog:` refs stripped so plain `npm install` works) — the script does not overwrite it.
