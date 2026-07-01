/**
 * Offline PCA bake over the CIPIC 45-subject HRTF database → a TINY runtime asset
 * describing how real human ears vary in the MAGNITUDE domain.
 *
 * WHY magnitude-only: the big inter-subject difference in the time domain is the ITD
 * (onset delay), which shifts in TIME — PCA is linear and would smear two differently-
 * delayed impulses into a double-peak. So we run PCA on per-direction LOG-MAGNITUDE
 * spectra ONLY (time-shift-invariant, blends cleanly); the ITD stays a separate scalar
 * knob elsewhere. (This is the settled design — see personalize.ts / memory.)
 *
 * Pipeline:
 *   for each of 45 subjects:
 *     for each direction on a common grid:
 *       log|FFT(hrir)| averaged L/R → magnitude feature
 *   stack → 45 × (Dirs*Bins) matrix
 *   PCA (mean + top K eigenvectors via covariance in subject space, 45×45 — cheap)
 *   quantize mean + eigenvectors to int8 with per-vector scales
 *   write assets/hrtf/cipic_pca.bin
 *
 * The runtime applies: warped_logmag = mean + Σ wᵢ·scaleᵢ·eigᵢ, per direction, then
 * exponentiates — an A/B "which localizes better" search tunes the weights wᵢ.
 *
 * Usage: node scripts/bake-hrtf-pca.mjs <cipic_dir> [out.bin]
 */
import { readMat5 } from './lib/mat5.mjs';
import { readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [, , cipicDir, outPathArg] = process.argv;
if (!cipicDir) {
  console.error('usage: node scripts/bake-hrtf-pca.mjs <cipic_dir> [out.bin]');
  process.exit(1);
}
const outPath = outPathArg ?? 'assets/hrtf/cipic_pca.bin';

// CIPIC grid constants.
const AZ = 25, EL = 50, TAPS = 200;
// CIPIC azimuth/elevation grids (degrees) — from the CIPIC documentation.
const AZIMUTHS = [-80, -65, -55, -45, -40, -35, -30, -25, -20, -15, -10, -5, 0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 55, 65, 80];
const ELEV = Array.from({ length: EL }, (_, i) => -45 + 5.625 * i); // −45 … +230.625

// FFT bins we keep (magnitude is symmetric; keep 0..N/2). Downsample to KEEP_BINS
// log-spaced-ish points to keep the asset tiny — perceptual magnitude is smooth.
const NFFT = 256; // zero-pad 200→256
const HALF = NFFT / 2 + 1; // 129
const KEEP_BINS = 48; // downsampled magnitude points per direction
const K = 5; // number of principal components to keep

// --- tiny radix-2 FFT (magnitude only needed) ---
function fftMag(x) {
  const n = NFFT;
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < x.length && i < n; i++) re[i] = x[i];
  // bit reversal
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
    // log-spaced bin centres from bin 1..HALF-1
    const frac = b / (KEEP_BINS - 1);
    const idx = Math.round(1 + (HALF - 2) * (Math.pow(HALF - 1, frac) - 1) / (HALF - 2));
    const i = Math.max(1, Math.min(HALF - 1, idx));
    out[b] = Math.log(Math.max(1e-6, mag[i]));
  }
  return out;
}

const DIRS = AZ * EL;
const FEAT = DIRS * KEEP_BINS; // feature length per subject

// --- load all subjects ---
const subjectDirs = readdirSync(cipicDir).filter((d) => d.startsWith('subject_'));
if (subjectDirs.length === 0) { console.error('no subject_* dirs in', cipicDir); process.exit(1); }
console.log(`Found ${subjectDirs.length} subjects.`);

const X = []; // subject feature vectors
for (const sd of subjectDirs) {
  const matPath = join(cipicDir, sd, 'hrir_final.mat');
  if (!existsSync(matPath)) continue;
  const v = readMat5(matPath);
  const hl = v.hrir_l?.data, hr = v.hrir_r?.data;
  if (!hl || !hr) { console.warn('  skip', sd, '(no hrir)'); continue; }
  // hrir dims [AZ][EL][TAPS], column-major (MATLAB): index = a + AZ*(e + EL*t).
  const feat = new Float64Array(FEAT);
  let fo = 0;
  for (let a = 0; a < AZ; a++) {
    for (let e = 0; e < EL; e++) {
      const irL = new Float64Array(TAPS), irR = new Float64Array(TAPS);
      for (let t = 0; t < TAPS; t++) {
        const idx = a + AZ * (e + EL * t);
        irL[t] = hl[idx]; irR[t] = hr[idx];
      }
      const fL = toLogMagFeature(fftMag(irL));
      const fR = toLogMagFeature(fftMag(irR));
      for (let b = 0; b < KEEP_BINS; b++) feat[fo + b] = 0.5 * (fL[b] + fR[b]);
      fo += KEEP_BINS;
    }
  }
  X.push(feat);
  process.stdout.write('.');
}
console.log(`\nLoaded ${X.length} subject features (dim ${FEAT}).`);

// --- mean ---
const S = X.length;
const mean = new Float64Array(FEAT);
for (const x of X) for (let i = 0; i < FEAT; i++) mean[i] += x[i];
for (let i = 0; i < FEAT; i++) mean[i] /= S;

// centered
const Xc = X.map((x) => { const c = new Float64Array(FEAT); for (let i = 0; i < FEAT; i++) c[i] = x[i] - mean[i]; return c; });

// --- PCA via the small SxS Gram matrix (S=45 ≪ FEAT), then map back to feature space ---
// G[i][j] = <Xc_i, Xc_j>. Eigenvectors of G give combinations of samples that are the
// principal directions in feature space (kernel-PCA trick for tall data).
const G = [];
for (let i = 0; i < S; i++) {
  G[i] = new Float64Array(S);
  for (let j = 0; j < S; j++) {
    let s = 0; const xi = Xc[i], xj = Xc[j];
    for (let k = 0; k < FEAT; k++) s += xi[k] * xj[k];
    G[i][j] = s / S;
  }
}
// Jacobi eigen-decomposition of the symmetric SxS matrix.
const { vals, vecs } = jacobiEigen(G);
// sort desc by eigenvalue
const order = Array.from({ length: S }, (_, i) => i).sort((a, b) => vals[b] - vals[a]);

// Build feature-space eigenvectors: eig_k ∝ Σ_i vecs[i][k] * Xc_i, then normalize.
const eigs = [];
const scales = [];
for (let kk = 0; kk < K; kk++) {
  const col = order[kk];
  const ev = new Float64Array(FEAT);
  for (let i = 0; i < S; i++) {
    const w = vecs[i][col];
    const xi = Xc[i];
    for (let f = 0; f < FEAT; f++) ev[f] += w * xi[f];
  }
  // normalize to unit L2
  let norm = 0; for (let f = 0; f < FEAT; f++) norm += ev[f] * ev[f];
  norm = Math.sqrt(norm) || 1;
  for (let f = 0; f < FEAT; f++) ev[f] /= norm;
  eigs.push(ev);
  // A perceptually useful weight range ≈ ±sqrt(eigenvalue) (1 std dev of real ears).
  scales.push(Math.sqrt(Math.max(0, vals[col])));
}
const totalVar = vals.reduce((p, c) => p + Math.max(0, c), 0) || 1;
console.log('Top eigenvalue variance fractions:',
  order.slice(0, K).map((c) => (Math.max(0, vals[c]) / totalVar * 100).toFixed(1) + '%').join(', '));

// --- quantize to int8 (mean as f32 for accuracy; eigs int8 + per-vector scale) ---
function quantI8(vec) {
  let amax = 0; for (const v of vec) amax = Math.max(amax, Math.abs(v));
  const q = amax || 1;
  const out = new Int8Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = Math.max(-127, Math.min(127, Math.round(vec[i] / q * 127)));
  return { out, q };
}

// header: magic 'HPCA'(4) ver u32, S u32, DIRS u32, KEEP_BINS u32, K u32
// then AZ u32, EL u32 (grid dims), then AZIMUTHS(f32*AZ), ELEV(f32*EL)
// then mean f32[FEAT]
// then per-PC: eigScale f32, quantScale f32, eig int8[FEAT]
const headerN = 4 + 4 * 6 + 4 * 2;
const gridN = 4 * (AZ + EL);
const meanN = 4 * FEAT;
const pcN = K * (4 + 4 + FEAT);
const buf = Buffer.alloc(headerN + gridN + meanN + pcN);
let o = 0;
buf.write('HPCA', o); o += 4;
buf.writeUInt32LE(1, o); o += 4;
buf.writeUInt32LE(S, o); o += 4;
buf.writeUInt32LE(DIRS, o); o += 4;
buf.writeUInt32LE(KEEP_BINS, o); o += 4;
buf.writeUInt32LE(K, o); o += 4;
buf.writeUInt32LE(AZ, o); o += 4;
buf.writeUInt32LE(EL, o); o += 4;
for (const a of AZIMUTHS) { buf.writeFloatLE(a, o); o += 4; }
for (const e of ELEV) { buf.writeFloatLE(e, o); o += 4; }
for (let i = 0; i < FEAT; i++) { buf.writeFloatLE(mean[i], o); o += 4; }
for (let kk = 0; kk < K; kk++) {
  const { out, q } = quantI8(eigs[kk]);
  buf.writeFloatLE(scales[kk], o); o += 4; // eigScale (std dev in log-mag units)
  buf.writeFloatLE(q, o); o += 4;          // quant scale
  for (let i = 0; i < FEAT; i++) { buf.writeInt8(out[i], o); o += 1; }
}
writeFileSync(outPath, buf);
console.log(`Wrote ${outPath} (${(buf.length / 1024).toFixed(0)} KB): mean + ${K} PCs, ${DIRS} dirs × ${KEEP_BINS} bins.`);

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
        for (let k = 0; k < n; k++) {
          const akp = A[k][p], akq = A[k][q];
          A[k][p] = c * akp - s * akq; A[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = A[p][k], aqk = A[q][k];
          A[p][k] = c * apk - s * aqk; A[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k][p], vkq = V[k][q];
          V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const vals = new Float64Array(n);
  for (let i = 0; i < n; i++) vals[i] = A[i][i];
  return { vals, vecs: V };
}
