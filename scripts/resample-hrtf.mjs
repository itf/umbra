/**
 * Resample a baked .hrtf file to a target sample rate (default 48000). Needed because
 * the AudioContext runs at the hardware rate (48 kHz here) and a ConvolverNode buffer
 * MUST match it — a 44.1 kHz set (CIPIC 124) crashed every room-IR builder with
 * "buffer sample rate ... does not match the context rate". Re-baking the asset to 48k
 * fixes it everywhere with zero runtime cost.
 *
 * .hrtf format: magic 'HRTF'(4), version u32, sampleRate f32, M u32(dirs), N u32(taps),
 *   then M*[az,el] f32, then M*2*N f32 IR samples (L then R per direction).
 * Each IR is resampled with Catmull-Rom cubic interpolation (good quality for the ~1.09
 * ratio + short HRIRs), taps rounded up to the new rate.
 *
 * Usage: node scripts/resample-hrtf.mjs <in.hrtf> <out.hrtf> [targetRate=48000]
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [, , inPath, outPath, rateArg] = process.argv;
if (!inPath || !outPath) { console.error('usage: node scripts/resample-hrtf.mjs <in.hrtf> <out.hrtf> [targetRate]'); process.exit(1); }
const targetRate = Number(rateArg ?? 48000);

const buf = readFileSync(inPath);
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
let o = 0;
const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
if (magic !== 'HRTF') { console.error('not an HRTF file:', magic); process.exit(1); }
o = 4;
const version = dv.getUint32(o, true); o += 4;
const srcRate = dv.getFloat32(o, true); o += 4;
const M = dv.getUint32(o, true); o += 4;
const N = dv.getUint32(o, true); o += 4;
console.log(`in: ${M} dirs, ${N} taps, ${srcRate} Hz → ${targetRate} Hz`);

if (srcRate === targetRate) { writeFileSync(outPath, buf); console.log('already at target rate; copied.'); process.exit(0); }

// positions (unchanged)
const posBytes = M * 2 * 4;
const posOffset = o;
o += posBytes;

// Catmull-Rom cubic sample of a Float32Array at fractional index x (clamped edges).
function cubic(a, x) {
  const i = Math.floor(x);
  const t = x - i;
  const p0 = a[Math.max(0, i - 1)] ?? 0;
  const p1 = a[Math.max(0, Math.min(a.length - 1, i))] ?? 0;
  const p2 = a[Math.max(0, Math.min(a.length - 1, i + 1))] ?? 0;
  const p3 = a[Math.max(0, Math.min(a.length - 1, i + 2))] ?? 0;
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

const ratio = srcRate / targetRate;           // input samples per output sample
const newN = Math.ceil(N / ratio) + 1;        // output taps
const outIrs = new Float32Array(M * 2 * newN);
for (let m = 0; m < M; m++) {
  for (let r = 0; r < 2; r++) {
    const src = new Float32Array(N);
    let so = o + ((m * 2 + r) * N) * 4;
    for (let n = 0; n < N; n++) { src[n] = dv.getFloat32(so, true); so += 4; }
    const dstBase = (m * 2 + r) * newN;
    for (let k = 0; k < newN; k++) outIrs[dstBase + k] = cubic(src, k * ratio);
  }
}

// write new file
const headerBytes = 4 + 4 + 4 + 4 + 4;
const outBuf = new ArrayBuffer(headerBytes + posBytes + M * 2 * newN * 4);
const ov = new DataView(outBuf);
let p = 0;
for (const c of 'HRTF') ov.setUint8(p++, c.charCodeAt(0));
ov.setUint32(p, version, true); p += 4;
ov.setFloat32(p, targetRate, true); p += 4;
ov.setUint32(p, M, true); p += 4;
ov.setUint32(p, newN, true); p += 4;
// copy positions verbatim
for (let i = 0; i < posBytes; i++) ov.setUint8(p + i, dv.getUint8(posOffset + i));
p += posBytes;
for (let i = 0; i < outIrs.length; i++) { ov.setFloat32(p, outIrs[i], true); p += 4; }

writeFileSync(outPath, Buffer.from(outBuf));
console.log(`wrote ${outPath}: ${M} dirs, ${newN} taps, ${targetRate} Hz (${(outBuf.byteLength / 1024 / 1024).toFixed(2)} MB)`);
