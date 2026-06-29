/**
 * Bundle the interpolating-HRTF AudioWorklet (TS + its DSP import) into a single,
 * dependency-free ES module under `public/` so it is served verbatim by `vite dev`
 * and copied into `dist/` by `vite build`. The renderer loads it via
 * `audioWorklet.addModule(`${BASE_URL}hrtf-worklet.js`)`.
 *
 * Why not `new URL('./hrtfWorklet.ts', import.meta.url)`? Vite inlines that small TS
 * file as a RAW (un-transpiled, un-bundled) data: URL — the worklet then fails to
 * load (TS syntax + bare relative import + wrong MIME). Bundling it ourselves with
 * esbuild guarantees a plain JS module that works in both dev and the production
 * build, with no cross-origin-isolation requirement.
 *
 * Run via the `worklet` npm script (wired into `dev` and `build`). Idempotent.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, '../src/engine/hrtf/hrtfWorklet.ts');
const outfile = resolve(here, '../public/hrtf-worklet.js');

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: 'esm',
  target: 'es2020',
  // AudioWorkletGlobalScope provides registerProcessor / AudioWorkletProcessor /
  // sampleRate; they're declared in the TS and erased here.
});

// eslint-disable-next-line no-console
console.log(`[build-worklet] wrote ${outfile}`);
