/**
 * Bake a single CIPIC subject's hrir_final.mat into our runtime .hrtf binary format,
 * resampled directly to 48000 Hz (the AudioContext rate — see resample-hrtf.mjs for why
 * this matters: a ConvolverNode buffer must match the context's sample rate).
 *
 * CIPIC source: standard_hrir_database/subject_NNN/hrir_final.mat, read with the
 * minimal MAT5 reader in ./lib/mat5.mjs. Fields hrir_l / hrir_r have dims [25,50,200]
 * = [AZ][EL][TAPS] stored column-major, i.e. flat index = a + 25*(e + 50*t), at 44100 Hz.
 *
 * CIPIC uses an INTERAURAL-POLAR grid (lateral angle a, polar angle e), not our engine's
 * standard vertical-polar az/el. Each grid point is converted to a unit vector with the
 * CIPIC convention (x=sin(a) right, y=cos(a)*sin(e) up, z=-cos(a)*cos(e) forward), then
 * to standard (azimuth, elevation) degrees via atan2/asin. This was verified to exactly
 * reproduce the position table already baked into assets/hrtf/cipic_124.hrtf (which used
 * a SOFA that pre-converted the same way) — see the ordering note below.
 *
 * Direction order matches cipic_124.hrtf: azimuth index descends 24→0 (CIPIC's azimuth
 * grid, 25 values, lateral angle -80..80) as the outer loop, elevation index ascends
 * 0→49 (CIPIC's elevation grid, polar angle -45+5.625*i) as the inner loop — giving
 * M = 25*50 = 1250 directions, matching cipic_124.hrtf's index-for-index layout.
 *
 * Each 200-tap 44.1 kHz IR is resampled to 48 kHz with the same Catmull-Rom cubic
 * interpolation used by resample-hrtf.mjs (helper copied here, not imported — it isn't
 * exported from that script).
 *
 * .hrtf output layout (little-endian):
 *   magic "HRTF" (4 bytes), version u32=1, sampleRate f32, M u32, N u32,
 *   positions: M * [azimuth_deg f32, elevation_deg f32],
 *   irs: M * [ L[N] f32, R[N] f32 ]
 *
 * Usage: node scripts/bake-cipic-subject.mjs <subjectNumber> <out.hrtf>
 *   e.g. node scripts/bake-cipic-subject.mjs 003 assets/hrtf/cipic_003.hrtf
 */
import { writeFileSync } from 'node:fs';
import { readMat5 } from './lib/mat5.mjs';

const [, , subjectArg, outPath] = process.argv;
if (!subjectArg || !outPath) {
  console.error('usage: node scripts/bake-cipic-subject.mjs <subjectNumber> <out.hrtf>');
  process.exit(1);
}

const subjectNum = String(subjectArg).padStart(3, '0');
const CIPIC_ROOT = process.env.CIPIC_ROOT ??
  '/tmp/claude-1000/-home-ivan-pproject-papasangre/fd0997ab-e082-4a8d-a2ae-7e534abd18d0/scratchpad/cipic/standard_hrir_database';
const matPath = `${CIPIC_ROOT}/subject_${subjectNum}/hrir_final.mat`;

const SRC_RATE = 44100;
const TARGET_RATE = 48000;

// CIPIC interaural-polar grids.
const AZ_GRID = [-80, -65, -55, -45, -40, -35, -30, -25, -20, -15, -10, -5, 0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 55, 65, 80];
const EL_GRID = Array.from({ length: 50 }, (_, i) => -45 + 5.625 * i);
const NUM_AZ = AZ_GRID.length; // 25
const NUM_EL = EL_GRID.length; // 50

function toStandardAzEl(aDeg, eDeg) {
  const a = (aDeg * Math.PI) / 180;
  const e = (eDeg * Math.PI) / 180;
  const x = Math.sin(a);
  const y = Math.cos(a) * Math.sin(e);
  const z = -Math.cos(a) * Math.cos(e);
  const az = (Math.atan2(x, -z) * 180) / Math.PI;
  const el = (Math.asin(Math.max(-1, Math.min(1, y))) * 180) / Math.PI;
  return [az, el];
}

// Catmull-Rom cubic sample of a Float32Array at fractional index x (clamped edges).
// Copied from resample-hrtf.mjs (not exported there).
function cubic(a, x) {
  const i = Math.floor(x);
  const t = x - i;
  const p0 = a[Math.max(0, i - 1)] ?? 0;
  const p1 = a[Math.max(0, Math.min(a.length - 1, i))] ?? 0;
  const p2 = a[Math.max(0, Math.min(a.length - 1, i + 1))] ?? 0;
  const p3 = a[Math.max(0, Math.min(a.length - 1, i + 2))] ?? 0;
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

function resampleIr(src200) {
  const ratio = SRC_RATE / TARGET_RATE; // input samples per output sample
  const newN = Math.ceil(200 / ratio) + 1;
  const out = new Float32Array(newN);
  for (let k = 0; k < newN; k++) out[k] = cubic(src200, k * ratio);
  return out;
}

console.log(`reading ${matPath}`);
const vars = readMat5(matPath);
const hrirL = vars.hrir_l;
const hrirR = vars.hrir_r;
if (!hrirL || !hrirR) throw new Error('hrir_final.mat missing hrir_l/hrir_r');
const [dimA, dimE, dimT] = hrirL.dims;
if (dimA !== NUM_AZ || dimE !== NUM_EL || dimT !== 200) {
  throw new Error(`unexpected hrir dims: ${hrirL.dims}`);
}

const M = NUM_AZ * NUM_EL; // 1250
const N = resampleIr(new Float32Array(200)).length; // determine output tap count once

const positions = new Float32Array(M * 2);
const irs = new Float32Array(M * 2 * N);

let m = 0;
for (let aOrder = NUM_AZ - 1; aOrder >= 0; aOrder--) { // az index descends 24 -> 0
  for (let eIdx = 0; eIdx < NUM_EL; eIdx++) { // el index ascends 0 -> 49
    const [az, el] = toStandardAzEl(AZ_GRID[aOrder], EL_GRID[eIdx]);
    positions[m * 2 + 0] = az;
    positions[m * 2 + 1] = el;

    const srcL = new Float32Array(200);
    const srcR = new Float32Array(200);
    for (let t = 0; t < 200; t++) {
      const flatIdx = aOrder + NUM_AZ * (eIdx + NUM_EL * t); // column-major [AZ][EL][TAPS]
      srcL[t] = hrirL.data[flatIdx];
      srcR[t] = hrirR.data[flatIdx];
    }
    const outL = resampleIr(srcL);
    const outR = resampleIr(srcR);
    const base = m * 2 * N;
    irs.set(outL, base);
    irs.set(outR, base + N);

    m++;
  }
}

console.log(`CIPIC subject ${subjectNum}: M=${M} directions, ${N} taps/ear @ ${TARGET_RATE} Hz`);

const headerBytes = 4 + 4 + 4 + 4 + 4;
const posBytes = M * 2 * 4;
const irBytes = M * 2 * N * 4;
const buf = new ArrayBuffer(headerBytes + posBytes + irBytes);
const dv = new DataView(buf);
let o = 0;
for (const c of 'HRTF') dv.setUint8(o++, c.charCodeAt(0));
dv.setUint32(o, 1, true); o += 4;
dv.setFloat32(o, TARGET_RATE, true); o += 4;
dv.setUint32(o, M, true); o += 4;
dv.setUint32(o, N, true); o += 4;
for (let i = 0; i < positions.length; i++) { dv.setFloat32(o, positions[i], true); o += 4; }
for (let i = 0; i < irs.length; i++) { dv.setFloat32(o, irs[i], true); o += 4; }

writeFileSync(outPath, Buffer.from(buf));
console.log(`wrote ${outPath} (${(buf.byteLength / 1024 / 1024).toFixed(2)} MB)`);
