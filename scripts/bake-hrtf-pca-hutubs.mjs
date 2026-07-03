/**
 * Offline PCA bake over the HUTUBS 96-subject HRTF database → a TINY runtime asset
 * describing how real human ears vary in the MAGNITUDE domain. Replaces the older
 * CIPIC-derived bake (scripts/bake-hrtf-pca.mjs): HUTUBS is newer, has 2× the subjects,
 * and we use no CIPIC anthropometry anywhere.
 *
 * WHY magnitude-only: the big inter-subject difference in the time domain is the ITD
 * (onset delay), which shifts in TIME — PCA is linear and would smear two differently-
 * delayed impulses into a double-peak. So we run PCA on per-direction LOG-MAGNITUDE
 * spectra ONLY (time-shift-invariant, blends cleanly); the ITD stays a separate scalar
 * knob elsewhere.
 *
 * Pipeline:
 *   read the common HUTUBS direction grid from subject 1's SourcePosition
 *   for each of 96 subjects (SOFA/HDF5 via h5wasm):
 *     for each direction on the common grid:
 *       log|FFT(hrir)| averaged L/R → magnitude feature
 *   stack → 96 × (Dirs*Bins) matrix
 *   PCA (mean + top K eigenvectors via covariance in subject space, 96×96 — cheap)
 *   + ONE extra pinna-band (4–12 kHz) PC, zeroed outside the band
 *   quantize mean + eigenvectors to int8 with per-vector scales
 *   write assets/hrtf/hrtf_pca.bin  (magic 'HPCA', same format hrtfPca.ts parses)
 *
 * Output format is identical to the old CIPIC bake (header stores the grid az/el, so the
 * runtime nearest-direction lookup is dataset-agnostic). Azimuth is stored in the ENGINE
 * convention (0 front, + right) — see the SOFA→engine conversion below — matching what
 * hrtfPca.ts's vecToAzEl produces at query time.
 *
 * Usage: node scripts/bake-hrtf-pca-hutubs.mjs <hutubs_dir> [out.bin]
 */
import { ready, FS, File } from 'h5wasm';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [, , hutubsDir, outPathArg] = process.argv;
if (!hutubsDir) {
  console.error('usage: node scripts/bake-hrtf-pca-hutubs.mjs <hutubs_dir> [out.bin]');
  process.exit(1);
}
const outPath = outPathArg ?? 'assets/hrtf/hrtf_pca.bin';

const TAPS = 256;      // HUTUBS measured IR length
const SR = 44100;      // HUTUBS "measured" set sample rate (the measured SOFAs are 44.1k)
const NFFT = 512;      // zero-pad 256→512
const HALF = NFFT / 2 + 1; // 257
const KEEP_BINS = 48;  // downsampled log-mag points per direction
const K = 5;           // general principal components (pinna PC appended after → K+1 total)

// --- tiny radix-2 FFT (magnitude only) ---
function fftMag(x) {
  const n = NFFT;
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < x.length && i < n; i++) re[i] = x[i];
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cwr - im[i + k + len / 2] * cwi;
        const vi = re[i + k + len / 2] * cwi + im[i + k + len / 2] * cwr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const nwr = cwr * wr - cwi * wi; cwi = cwr * wi + cwi * wr; cwr = nwr;
      }
    }
  }
  const mag = new Float64Array(HALF);
  for (let i = 0; i < HALF; i++) mag[i] = Math.hypot(re[i], im[i]);
  return mag;
}

/** Downsample a HALF-length magnitude to KEEP_BINS log-spaced points (log-magnitude). */
function toLogMagFeature(mag) {
  const out = new Float64Array(KEEP_BINS);
  for (let b = 0; b < KEEP_BINS; b++) {
    const frac = b / (KEEP_BINS - 1);
    const idx = Math.round(1 + (HALF - 2) * (Math.pow(HALF - 1, frac) - 1) / (HALF - 2));
    const i = Math.max(1, Math.min(HALF - 1, idx));
    out[b] = Math.log(Math.max(1e-6, mag[i]));
  }
  return out;
}

/** SOFA SourcePosition (az CCW 0=front 90=left, el up) → engine-style (0 front, + right). */
function sofaToEngineAzEl(azSofa, elSofa) {
  // Engine az is + to the right; SOFA az is + to the left (CCW). Negate + wrap to (−180,180].
  let az = -azSofa;
  az = ((az + 180) % 360 + 360) % 360 - 180;
  return { az, el: elSofa };
}

await ready;

// --- read the common direction grid from the first subject ---
const files = readdirSync(hutubsDir).filter((d) => /^pp\d+\.sofa$/.test(d))
  .sort((a, b) => parseInt(a.slice(2), 10) - parseInt(b.slice(2), 10));
if (files.length === 0) { console.error('no pp*.sofa in', hutubsDir); process.exit(1); }
console.log(`Found ${files.length} HUTUBS subjects.`);

function readSofa(path) {
  FS.writeFile('/in.sofa', new Uint8Array(readFileSync(path)));
  const f = new File('/in.sofa', 'r');
  const irDS = f.get('Data.IR');
  const posDS = f.get('SourcePosition');
  const [M, R, N] = irDS.shape;
  const ir = irDS.value;   // flat [M][R][N]
  const pos = posDS.value;  // flat [M][3]
  f.close();
  return { M, R, N, ir, pos };
}

const first = readSofa(join(hutubsDir, files[0]));
const DIRS = first.M;
// Grid az/el arrays (engine convention), one entry per direction (this IS the grid — the
// header stores per-direction az/el, so nearest-dir lookup is a flat scan, no AZxEL split).
const gridAz = new Float32Array(DIRS), gridEl = new Float32Array(DIRS);
for (let m = 0; m < DIRS; m++) {
  const { az, el } = sofaToEngineAzEl(first.pos[m * 3], first.pos[m * 3 + 1]);
  gridAz[m] = az; gridEl[m] = el;
}
console.log(`Grid: ${DIRS} directions, ${first.N} taps/ear.`);

const FEAT = DIRS * KEEP_BINS;

// --- load all subjects on the common grid ---
function featuresFor(s) {
  if (s.M !== DIRS || s.N !== TAPS) return null; // guard against odd files
  const feat = new Float64Array(FEAT);
  let fo = 0;
  for (let m = 0; m < DIRS; m++) {
    const baseL = (m * 2 + 0) * s.N, baseR = (m * 2 + 1) * s.N;
    const irL = new Float64Array(TAPS), irR = new Float64Array(TAPS);
    for (let t = 0; t < TAPS; t++) { irL[t] = s.ir[baseL + t]; irR[t] = s.ir[baseR + t]; }
    const fL = toLogMagFeature(fftMag(irL));
    const fR = toLogMagFeature(fftMag(irR));
    for (let b = 0; b < KEEP_BINS; b++) feat[fo + b] = 0.5 * (fL[b] + fR[b]);
    fo += KEEP_BINS;
  }
  return feat;
}

const X = [];
for (const fn of files) {
  const s = fn === files[0] ? first : readSofa(join(hutubsDir, fn));
  const feat = featuresFor(s);
  if (!feat) { console.warn('  skip', fn, '(grid mismatch)'); continue; }
  X.push(feat);
  process.stdout.write('.');
}
console.log(`\nLoaded ${X.length} subject features (dim ${FEAT}).`);

// --- mean ---
const S = X.length;
const mean = new Float64Array(FEAT);
for (const x of X) for (let i = 0; i < FEAT; i++) mean[i] += x[i];
for (let i = 0; i < FEAT; i++) mean[i] /= S;
const Xc = X.map((x) => { const c = new Float64Array(FEAT); for (let i = 0; i < FEAT; i++) c[i] = x[i] - mean[i]; return c; });

// --- PCA via the small SxS Gram matrix (kernel-PCA trick for tall data) ---
function gramPca(centered) {
  const G = [];
  for (let i = 0; i < S; i++) {
    G[i] = new Float64Array(S);
    for (let j = 0; j < S; j++) { let s = 0; const xi = centered[i], xj = centered[j]; for (let k = 0; k < FEAT; k++) s += xi[k] * xj[k]; G[i][j] = s / S; }
  }
  return jacobiEigen(G);
}

const { vals, vecs } = gramPca(Xc);
const order = Array.from({ length: S }, (_, i) => i).sort((a, b) => vals[b] - vals[a]);

const eigs = [];
const scales = [];
for (let kk = 0; kk < K; kk++) {
  const col = order[kk];
  const ev = new Float64Array(FEAT);
  for (let i = 0; i < S; i++) { const w = vecs[i][col]; const xi = Xc[i]; for (let f = 0; f < FEAT; f++) ev[f] += w * xi[f]; }
  let norm = 0; for (let f = 0; f < FEAT; f++) norm += ev[f] * ev[f];
  norm = Math.sqrt(norm) || 1;
  for (let f = 0; f < FEAT; f++) ev[f] /= norm;
  eigs.push(ev);
  scales.push(Math.sqrt(Math.max(0, vals[col])));
}
const totalVar = vals.reduce((p, c) => p + Math.max(0, c), 0) || 1;
console.log('Top eigenvalue variance fractions:',
  order.slice(0, K).map((c) => (Math.max(0, vals[c]) / totalVar * 100).toFixed(1) + '%').join(', '));

// --- dedicated PINNA-BAND principal component (4–12 kHz) -----------------------------
// Front/back + elevation spectral cues live in the pinna band; the general PCs spread
// their energy across the whole spectrum. This extra PC is computed on features
// RESTRICTED to the pinna band and ZEROED outside it, so tuning it deforms only that
// region — a clean "pinna shape" knob for the calibration A/B.
function featureBinHz(b) {
  const frac = b / (KEEP_BINS - 1);
  const idx = Math.round(1 + (HALF - 2) * (Math.pow(HALF - 1, frac) - 1) / (HALF - 2));
  const i = Math.max(1, Math.min(HALF - 1, idx));
  return (i / NFFT) * SR;
}
const PINNA_LO_HZ = 4000, PINNA_HI_HZ = 12000;
const pinnaBins = [];
for (let b = 0; b < KEEP_BINS; b++) { const hz = featureBinHz(b); if (hz >= PINNA_LO_HZ && hz <= PINNA_HI_HZ) pinnaBins.push(b); }
console.log(`Pinna band ${PINNA_LO_HZ}-${PINNA_HI_HZ} Hz @ ${SR} Hz → ${pinnaBins.length} of ${KEEP_BINS} feature bins (${pinnaBins[0]}..${pinnaBins[pinnaBins.length - 1]}).`);

const pinnaMask = new Uint8Array(FEAT);
for (let d = 0; d < DIRS; d++) for (const b of pinnaBins) pinnaMask[d * KEEP_BINS + b] = 1;
const Xp = Xc.map((c) => { const v = new Float64Array(FEAT); for (let i = 0; i < FEAT; i++) v[i] = pinnaMask[i] ? c[i] : 0; return v; });
const { vals: pvals, vecs: pvecs } = gramPca(Xp);
let pcol = 0; for (let i = 1; i < S; i++) if (pvals[i] > pvals[pcol]) pcol = i;
const pinnaEig = new Float64Array(FEAT);
for (let i = 0; i < S; i++) { const w = pvecs[i][pcol]; const xi = Xp[i]; for (let f = 0; f < FEAT; f++) pinnaEig[f] += w * xi[f]; }
for (let f = 0; f < FEAT; f++) if (!pinnaMask[f]) pinnaEig[f] = 0;
let pnorm = 0; for (let f = 0; f < FEAT; f++) pnorm += pinnaEig[f] * pinnaEig[f];
pnorm = Math.sqrt(pnorm) || 1;
for (let f = 0; f < FEAT; f++) pinnaEig[f] /= pnorm;
eigs.push(pinnaEig);
scales.push(Math.sqrt(Math.max(0, pvals[pcol])));
console.log(`Pinna PC: variance ${(Math.max(0, pvals[pcol]) / totalVar * 100).toFixed(1)}% (band-restricted).`);

const K_TOTAL = eigs.length;

// --- quantize to int8 (mean f32; eigs int8 + per-vector scale) ---
function quantI8(vec) {
  let amax = 0; for (const v of vec) amax = Math.max(amax, Math.abs(v));
  const q = amax || 1;
  const out = new Int8Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = Math.max(-127, Math.min(127, Math.round(vec[i] / q * 127)));
  return { out, q };
}

// header (VERSION 2): magic 'HPCA'(4) ver u32(=2), NFFT u32, S u32, DIRS u32, KEEP_BINS u32,
//   K u32, gridAzN u32, gridElN u32, then az f32[gridAzN], el f32[gridElN], mean f32[FEAT],
//   then per-PC: eigScale f32, quantScale f32, eig int8[FEAT].
// v2 adds NFFT (so the runtime knows the feature log-freq base = NFFT/2) and uses a FLAT
// per-direction grid: gridAzN = gridElN = DIRS, az/el hold one entry per direction, so
// nearestDirIndex scans directly with no AZ×EL factorization. (v1 = legacy CIPIC bake.)
const GRID_N = DIRS;
// header u32s: ver, NFFT, S, DIRS, KEEP_BINS, K, gridAzN, gridElN = 8 u32 (+ 4-byte magic)
const headerBytes = 4 + 8 * 4;
const gridN = 4 * (GRID_N + GRID_N);
const meanN = 4 * FEAT;
const pcN = K_TOTAL * (4 + 4 + FEAT);
const buf = Buffer.alloc(headerBytes + gridN + meanN + pcN);
let o = 0;
buf.write('HPCA', o); o += 4;
buf.writeUInt32LE(2, o); o += 4;      // version 2
buf.writeUInt32LE(NFFT, o); o += 4;   // bake FFT size (feature log base = NFFT/2)
buf.writeUInt32LE(S, o); o += 4;
buf.writeUInt32LE(DIRS, o); o += 4;
buf.writeUInt32LE(KEEP_BINS, o); o += 4;
buf.writeUInt32LE(K_TOTAL, o); o += 4;
buf.writeUInt32LE(GRID_N, o); o += 4; // gridAz length (= DIRS, flat per-dir grid)
buf.writeUInt32LE(GRID_N, o); o += 4; // gridEl length (= DIRS)
for (let m = 0; m < GRID_N; m++) { buf.writeFloatLE(gridAz[m], o); o += 4; }
for (let m = 0; m < GRID_N; m++) { buf.writeFloatLE(gridEl[m], o); o += 4; }
for (let i = 0; i < FEAT; i++) { buf.writeFloatLE(mean[i], o); o += 4; }
for (let kk = 0; kk < K_TOTAL; kk++) {
  const { out, q } = quantI8(eigs[kk]);
  buf.writeFloatLE(scales[kk], o); o += 4;
  buf.writeFloatLE(q, o); o += 4;
  for (let i = 0; i < FEAT; i++) { buf.writeInt8(out[i], o); o += 1; }
}
writeFileSync(outPath, buf);
console.log(`Wrote ${outPath} (${(buf.length / 1024).toFixed(0)} KB): mean + ${K_TOTAL} PCs (${K} general + 1 pinna), ${DIRS} dirs × ${KEEP_BINS} bins, ${S} subjects.`);

// --- Jacobi eigensolver for small symmetric matrices ---
function jacobiEigen(Ain) {
  const n = Ain.length;
  const A = Ain.map((r) => Float64Array.from(r));
  const V = Array.from({ length: n }, (_, i) => { const r = new Float64Array(n); r[i] = 1; return r; });
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += A[p][q] * A[p][q];
    if (off < 1e-18) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(A[p][q]) < 1e-20) continue;
        const app = A[p][p], aqq = A[q][q], apq = A[p][q];
        const phi = 0.5 * Math.atan2(2 * apq, aqq - app);
        const c = Math.cos(phi), s = Math.sin(phi);
        for (let k = 0; k < n; k++) { const akp = A[k][p], akq = A[k][q]; A[k][p] = c * akp - s * akq; A[k][q] = s * akp + c * akq; }
        for (let k = 0; k < n; k++) { const apk = A[p][k], aqk = A[q][k]; A[p][k] = c * apk - s * aqk; A[q][k] = s * apk + c * aqk; }
        for (let k = 0; k < n; k++) { const vkp = V[k][p], vkq = V[k][q]; V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq; }
      }
    }
  }
  const vals = new Float64Array(n);
  for (let i = 0; i < n; i++) vals[i] = A[i][i];
  return { vals, vecs: V };
}
