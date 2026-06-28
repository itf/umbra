/**
 * Pre-bake a SOFA (HDF5) HRIR file into a compact little-endian binary so the
 * browser never has to parse HDF5 at runtime.
 *
 * Reads the SOFA "SimpleFreeFieldHRIR" convention:
 *   Data.IR          : Float [M][R=2][N]   (M directions, L/R ears, N taps)
 *   SourcePosition   : Float [M][3]        (azimuth°, elevation°, distance m)
 *   Data.SamplingRate: scalar Hz
 *
 * Output layout (.hrtf):
 *   magic   "HRTF" (4 bytes)
 *   version u32 = 1
 *   sampleRate f32
 *   M (directions) u32
 *   N (taps per ear) u32
 *   positions: M * [az f32, el f32] (distance dropped — far-field)
 *   irs:       M * [ L[N] f32 , R[N] f32 ]
 *
 * Usage: node scripts/bake-hrtf.mjs assets/hrtf/sadie_h3_48k.sofa assets/hrtf/sadie_h3.hrtf
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { ready, FS, File } from 'h5wasm';

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error('usage: node bake-hrtf.mjs <in.sofa> <out.hrtf>');
  process.exit(1);
}

await ready;
FS.writeFile('/in.sofa', new Uint8Array(readFileSync(inPath)));
const f = new File('/in.sofa', 'r');

const irDS = f.get('Data.IR');
const posDS = f.get('SourcePosition');
const srDS = f.get('Data.SamplingRate');

const [M, R, N] = irDS.shape;
if (R !== 2) throw new Error(`expected 2 receivers (ears), got ${R}`);
const sampleRate = Number(srDS.value[0] ?? srDS.value);
const ir = irDS.value; // flat Float64/Float32, row-major [M][R][N]
const pos = posDS.value; // flat [M][3]

console.log(`SOFA: M=${M} directions, ${N} taps/ear, ${sampleRate} Hz`);

const headerBytes = 4 + 4 + 4 + 4 + 4;
const posBytes = M * 2 * 4;
const irBytes = M * 2 * N * 4;
const buf = new ArrayBuffer(headerBytes + posBytes + irBytes);
const dv = new DataView(buf);
let o = 0;
for (const c of 'HRTF') dv.setUint8(o++, c.charCodeAt(0));
dv.setUint32(o, 1, true); o += 4;
dv.setFloat32(o, sampleRate, true); o += 4;
dv.setUint32(o, M, true); o += 4;
dv.setUint32(o, N, true); o += 4;

for (let m = 0; m < M; m++) {
  dv.setFloat32(o, pos[m * 3 + 0], true); o += 4; // azimuth°
  dv.setFloat32(o, pos[m * 3 + 1], true); o += 4; // elevation°
}
for (let m = 0; m < M; m++) {
  for (let r = 0; r < 2; r++) {
    const base = (m * 2 + r) * N;
    for (let n = 0; n < N; n++) {
      dv.setFloat32(o, ir[base + n], true); o += 4;
    }
  }
}

f.close();
writeFileSync(outPath, Buffer.from(buf));
console.log(`wrote ${outPath} (${(buf.byteLength / 1024 / 1024).toFixed(2)} MB)`);
