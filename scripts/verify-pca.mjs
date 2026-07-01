/**
 * Verify the baked PCA model stays within the space of REAL ears — i.e. tuning its
 * weights morphs BETWEEN measured humans, not away from them.
 *
 * Re-derives each of the 45 CIPIC subjects' magnitude features (same as the bake),
 * then for each subject:
 *   - projects onto the K principal components → weights (in std-dev units)
 *   - reconstructs mean + Σ wᵢ·scaleᵢ·eigᵢ and measures the reconstruction error
 *     vs the true feature (how well K PCs capture a real ear)
 * and reports:
 *   - the DISTRIBUTION of real-subject weights per PC (so we can confirm our ±2.5
 *     std-dev slider bound brackets real people rather than extrapolating past them)
 *   - reconstruction error vs. the trivial "everyone is the mean" baseline (PCA must
 *     beat the mean, else it's not capturing real variation).
 *
 * Usage: node scripts/verify-pca.mjs <cipic_dir> <model.bin>
 */
import { readMat5 } from './lib/mat5.mjs';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [, , cipicDir, modelPath] = process.argv;
if (!cipicDir || !modelPath) { console.error('usage: node scripts/verify-pca.mjs <cipic_dir> <model.bin>'); process.exit(1); }

// --- parse the baked model (mirror hrtfPca.ts) ---
const mb = readFileSync(modelPath);
const dv = new DataView(mb.buffer, mb.byteOffset, mb.byteLength);
let o = 4;
const ver = dv.getUint32(o, true); o += 4;
const S = dv.getUint32(o, true); o += 4;
const DIRS = dv.getUint32(o, true); o += 4;
const BINS = dv.getUint32(o, true); o += 4;
const K = dv.getUint32(o, true); o += 4;
const AZ = dv.getUint32(o, true); o += 4;
const EL = dv.getUint32(o, true); o += 4;
o += 4 * (AZ + EL); // skip grids
const FEAT = DIRS * BINS;
const mean = new Float64Array(FEAT);
for (let i = 0; i < FEAT; i++) { mean[i] = dv.getFloat32(o, true); o += 4; }
const pcs = [];
for (let kk = 0; kk < K; kk++) {
  const scale = dv.getFloat32(o, true); o += 4;
  const q = dv.getFloat32(o, true); o += 4;
  const vec = new Float64Array(FEAT);
  for (let i = 0; i < FEAT; i++) { vec[i] = (dv.getInt8(o) / 127) * q; o += 1; }
  pcs.push({ scale, vec });
}
console.log(`Model: ver ${ver}, ${S} subjects, ${DIRS} dirs × ${BINS} bins, K=${K}.`);

// --- re-derive subject features (must match bake-hrtf-pca.mjs) ---
const TAPS = 200, NFFT = 256, HALF = NFFT / 2 + 1, KEEP_BINS = BINS;
function fftMag(x) {
  const n = NFFT; const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < x.length && i < n; i++) re[i] = x[i];
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; } }
  for (let len = 2; len <= n; len <<= 1) { const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang); for (let i = 0; i < n; i += len) { let cwr = 1, cwi = 0; for (let k = 0; k < len / 2; k++) { const ur = re[i + k], ui = im[i + k]; const vr = re[i + k + len / 2] * cwr - im[i + k + len / 2] * cwi; const vi = re[i + k + len / 2] * cwi + im[i + k + len / 2] * cwr; re[i + k] = ur + vr; im[i + k] = ui + vi; re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi; const nwr = cwr * wr - cwi * wi; cwi = cwr * wi + cwi * wr; cwr = nwr; } } }
  const mag = new Float64Array(HALF); for (let i = 0; i < HALF; i++) mag[i] = Math.hypot(re[i], im[i]); return mag;
}
function toLogMagFeature(mag) { const out = new Float64Array(KEEP_BINS); for (let b = 0; b < KEEP_BINS; b++) { const frac = b / (KEEP_BINS - 1); const idx = Math.round(1 + (HALF - 2) * (Math.pow(HALF - 1, frac) - 1) / (HALF - 2)); const i = Math.max(1, Math.min(HALF - 1, idx)); out[b] = Math.log(Math.max(1e-6, mag[i])); } return out; }

const GRID_AZ = 25, GRID_EL = 50;
const subjectDirs = readdirSync(cipicDir).filter((d) => d.startsWith('subject_'));
const X = [];
for (const sd of subjectDirs) {
  const p = join(cipicDir, sd, 'hrir_final.mat'); if (!existsSync(p)) continue;
  const v = readMat5(p); const hl = v.hrir_l?.data, hr = v.hrir_r?.data; if (!hl || !hr) continue;
  const feat = new Float64Array(FEAT); let fo = 0;
  for (let a = 0; a < GRID_AZ; a++) for (let e = 0; e < GRID_EL; e++) {
    const irL = new Float64Array(TAPS), irR = new Float64Array(TAPS);
    for (let t = 0; t < TAPS; t++) { const idx = a + GRID_AZ * (e + GRID_EL * t); irL[t] = hl[idx]; irR[t] = hr[idx]; }
    const fL = toLogMagFeature(fftMag(irL)), fR = toLogMagFeature(fftMag(irR));
    for (let b = 0; b < KEEP_BINS; b++) feat[fo + b] = 0.5 * (fL[b] + fR[b]);
    fo += KEEP_BINS;
  }
  X.push(feat);
}
console.log(`Re-derived ${X.length} subject features.`);

// --- project + reconstruct ---
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const rms = (a) => Math.sqrt(a.reduce((p, c) => p + c * c, 0) / a.length);

const weightsByPc = Array.from({ length: K }, () => []);
let sumMeanErr = 0, sumPcaErr = 0;
for (const x of X) {
  const c = new Float64Array(FEAT); for (let i = 0; i < FEAT; i++) c[i] = x[i] - mean[i];
  const meanErr = rms(c); // error if we just used the mean
  const recon = Float64Array.from(mean);
  for (let kk = 0; kk < K; kk++) {
    // weight in std-dev units: project centered feature onto unit eigenvector, / scale
    const proj = dot(c, pcs[kk].vec); // eig is unit-norm
    const w = proj / (pcs[kk].scale || 1);
    weightsByPc[kk].push(w);
    for (let i = 0; i < FEAT; i++) recon[i] += proj * pcs[kk].vec[i];
  }
  const resid = new Float64Array(FEAT); for (let i = 0; i < FEAT; i++) resid[i] = x[i] - recon[i];
  sumMeanErr += meanErr; sumPcaErr += rms(resid);
}
const N = X.length;
const meanErrAvg = sumMeanErr / N, pcaErrAvg = sumPcaErr / N;

console.log('\n=== Reconstruction (log-magnitude RMS error, nats) ===');
console.log(`  "everyone = mean" baseline : ${meanErrAvg.toFixed(4)}`);
console.log(`  mean + ${K} PCs            : ${pcaErrAvg.toFixed(4)}`);
console.log(`  variance explained by PCs : ${((1 - (pcaErrAvg * pcaErrAvg) / (meanErrAvg * meanErrAvg)) * 100).toFixed(1)}%`);

console.log('\n=== Real-subject weight spread per PC (std-dev units) ===');
for (let kk = 0; kk < K; kk++) {
  const w = weightsByPc[kk];
  const mn = Math.min(...w), mx = Math.max(...w);
  const mu = w.reduce((p, c) => p + c, 0) / w.length;
  const sd = Math.sqrt(w.reduce((p, c) => p + (c - mu) * (c - mu), 0) / w.length);
  console.log(`  PC${kk + 1}: real range [${mn.toFixed(2)}, ${mx.toFixed(2)}], std ${sd.toFixed(2)}  (slider bound ±2.5)`);
}
console.log('\nInterpretation: a slider weight inside the real [min,max] above morphs BETWEEN');
console.log('measured humans. The ±2.5 bound should be close to the real range — if a real');
console.log('subject reaches ±2.5, the extreme is still a real ear, not an extrapolation.');
