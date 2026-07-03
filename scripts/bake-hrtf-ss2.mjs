/**
 * Bake ONE SS2 (Meta Reality Labs Sound Sphere 2) subject SOFA into our runtime .hrtf
 * binary. SS2 is native 48 kHz, eardrum-measured, 1625 directions × 384 taps. We WINDOW
 * each IR down to 256 taps (our standard head length) so runtime convolution cost is
 * unchanged — SS2 puts >99.7% of its energy in the first 256 taps and its onset peaks
 * before ~tap 61, so a 256-tap window keeps the whole main response and just drops a
 * negligible tail. A short raised-cosine fade over the last FADE taps avoids a hard cut.
 *
 * Output .hrtf layout (little-endian): magic 'HRTF'(4), version u32=1, sampleRate f32,
 *   M u32(dirs), N u32(taps=256), then M*[az,el] f32, then M*2*N f32 IR (L then R).
 * SourcePosition az is stored in DEGREES verbatim (SOFA CCW, 0=front) — matching how
 * bake-hrtf.mjs stores SADIE; the runtime converts to engine vectors from these.
 *
 * After baking heads, ALWAYS run scripts/normalize-base-heads.mjs (scalar level-match to
 * sadie_h3 + clip-safe headroom) so the head A/B changes spatial cues, not volume.
 *
 * Usage: node scripts/bake-hrtf-ss2.mjs <in.sofa> <out.hrtf>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { ready, FS, File } from 'h5wasm';
import { windowTo } from './lib/hrtfWindow.mjs';

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) { console.error('usage: node scripts/bake-hrtf-ss2.mjs <in.sofa> <out.hrtf>'); process.exit(1); }

const OUT_TAPS = 256;

await ready;
FS.writeFile('/in.sofa', new Uint8Array(readFileSync(inPath)));
const f = new File('/in.sofa', 'r');
const irDS = f.get('Data.IR');
const posDS = f.get('SourcePosition');
const srDS = f.get('Data.SamplingRate');
const [M, R, N] = irDS.shape;
if (R !== 2) throw new Error(`expected 2 receivers, got ${R}`);
const sampleRate = Number(srDS.value[0] ?? srDS.value);
const ir = irDS.value;   // flat [M][R][N]
const pos = posDS.value;  // flat [M][3]
f.close();
console.log(`SS2: M=${M} dirs, ${N} taps @ ${sampleRate} Hz → window to ${OUT_TAPS} taps`);

const headerBytes = 4 + 4 + 4 + 4 + 4;
const posBytes = M * 2 * 4;
const irBytes = M * 2 * OUT_TAPS * 4;
const buf = new ArrayBuffer(headerBytes + posBytes + irBytes);
const dv = new DataView(buf);
let o = 0;
for (const c of 'HRTF') dv.setUint8(o++, c.charCodeAt(0));
dv.setUint32(o, 1, true); o += 4;
dv.setFloat32(o, sampleRate, true); o += 4;
dv.setUint32(o, M, true); o += 4;
dv.setUint32(o, OUT_TAPS, true); o += 4;
for (let m = 0; m < M; m++) {
  dv.setFloat32(o, pos[m * 3 + 0], true); o += 4; // azimuth°
  dv.setFloat32(o, pos[m * 3 + 1], true); o += 4; // elevation°
}
const src = new Float32Array(N);
for (let m = 0; m < M; m++) {
  for (let r = 0; r < 2; r++) {
    const base = (m * 2 + r) * N;
    for (let n = 0; n < N; n++) src[n] = ir[base + n];
    const win = windowTo(src, OUT_TAPS);
    for (let n = 0; n < OUT_TAPS; n++) { dv.setFloat32(o, win[n], true); o += 4; }
  }
}
writeFileSync(outPath, Buffer.from(buf));
console.log(`wrote ${outPath} (${(buf.byteLength / 1024 / 1024).toFixed(2)} MB): ${M} dirs, ${OUT_TAPS} taps`);
