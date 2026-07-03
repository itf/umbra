/**
 * Select 4 CIPIC subjects whose HRTFs are MOST DIFFERENT from each other (and from the
 * mean), for use as diverse "base head" options in the HRTF calibration picker.
 *
 * Reuses the exact log-magnitude feature extraction from bake-hrtf-pca.mjs (per-direction
 * FFT -> log|mag| -> downsampled bins, L/R averaged), then runs a farthest-point / max-min
 * selection in that feature space (Euclidean distance).
 *
 * Usage: node scripts/select-diverse-heads.mjs <cipic_dir>
 */
import { readMat5 } from './lib/mat5.mjs';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [, , cipicDirArg] = process.argv;
const cipicDir = cipicDirArg ?? '/tmp/claude-1000/-home-ivan-pproject-papasangre/fd0997ab-e082-4a8d-a2ae-7e534abd18d0/scratchpad/cipic/standard_hrir_database';
if (!existsSync(cipicDir)) {
  console.error('cipic dir not found:', cipicDir);
  process.exit(1);
}

// --- CIPIC grid constants (same as bake-hrtf-pca.mjs) ---
const AZ = 25, EL = 50, TAPS = 200;
const NFFT = 256;
const HALF = NFFT / 2 + 1;
const KEEP_BINS = 48;

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

const DIRS = AZ * EL;
const FEAT = DIRS * KEEP_BINS;

const subjectDirs = readdirSync(cipicDir).filter((d) => d.startsWith('subject_')).sort();
if (subjectDirs.length === 0) { console.error('no subject_* dirs in', cipicDir); process.exit(1); }
console.log(`Found ${subjectDirs.length} subjects.`);

const ids = [];
const X = [];
for (const sd of subjectDirs) {
  const matPath = join(cipicDir, sd, 'hrir_final.mat');
  if (!existsSync(matPath)) continue;
  const v = readMat5(matPath);
  const hl = v.hrir_l?.data, hr = v.hrir_r?.data;
  if (!hl || !hr) { console.warn('  skip', sd, '(no hrir)'); continue; }
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
  ids.push(sd.replace('subject_', ''));
  X.push(feat);
  process.stdout.write('.');
}
console.log(`\nLoaded ${X.length} subject features (dim ${FEAT}).`);

const S = X.length;
const mean = new Float64Array(FEAT);
for (const x of X) for (let i = 0; i < FEAT; i++) mean[i] += x[i];
for (let i = 0; i < FEAT; i++) mean[i] /= S;

function dist(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s);
}

const distToMean = X.map((x) => dist(x, mean));

// --- farthest-point / max-min selection ---
// 1) start from subject farthest from the mean.
let startIdx = 0;
for (let i = 1; i < S; i++) if (distToMean[i] > distToMean[startIdx]) startIdx = i;

const chosen = [startIdx];
const minDistToChosen = new Float64Array(S).fill(Infinity);
for (let i = 0; i < S; i++) minDistToChosen[i] = dist(X[i], X[startIdx]);

const K_SELECT = 4;
while (chosen.length < K_SELECT) {
  let best = -1, bestD = -1;
  for (let i = 0; i < S; i++) {
    if (chosen.includes(i)) continue;
    if (minDistToChosen[i] > bestD) { bestD = minDistToChosen[i]; best = i; }
  }
  chosen.push(best);
  for (let i = 0; i < S; i++) {
    const d = dist(X[i], X[best]);
    if (d < minDistToChosen[i]) minDistToChosen[i] = d;
  }
}

console.log('\n=== Chosen 4 subjects (farthest-point / max-min selection) ===');
for (const idx of chosen) {
  console.log(`  subject_${ids[idx]}  distToMean=${distToMean[idx].toFixed(3)}`);
}

console.log('\n=== Pairwise distances among chosen ===');
for (let a = 0; a < chosen.length; a++) {
  for (let b = a + 1; b < chosen.length; b++) {
    console.log(`  ${ids[chosen[a]]} <-> ${ids[chosen[b]]}: ${dist(X[chosen[a]], X[chosen[b]]).toFixed(3)}`);
  }
}

// average pairwise distance across ALL 45 subjects, for context.
let sumAll = 0, cntAll = 0;
for (let a = 0; a < S; a++) for (let b = a + 1; b < S; b++) { sumAll += dist(X[a], X[b]); cntAll++; }
console.log(`\nMean pairwise distance across all ${S} subjects: ${(sumAll / cntAll).toFixed(3)}`);
let sumChosen = 0, cntChosen = 0;
for (let a = 0; a < chosen.length; a++) for (let b = a + 1; b < chosen.length; b++) { sumChosen += dist(X[chosen[a]], X[chosen[b]]); cntChosen++; }
console.log(`Mean pairwise distance among chosen 4: ${(sumChosen / cntChosen).toFixed(3)}`);

// distances sorted, to see where distToMean ranks among all 45 (context for "most different from average")
const rankedByMeanDist = ids.map((id, i) => ({ id, d: distToMean[i] })).sort((a, b) => b.d - a.d);
console.log('\nTop 8 subjects by distance-to-mean (for context):');
for (const r of rankedByMeanDist.slice(0, 8)) console.log(`  subject_${r.id}: ${r.d.toFixed(3)}`);

// --- check subject 124 ---
const idx124 = ids.indexOf('124');
if (idx124 >= 0) {
  console.log(`\nsubject_124: distToMean=${distToMean[idx124].toFixed(3)}, rank by distToMean = ${rankedByMeanDist.findIndex(r => r.id === '124') + 1}/${S}`);
  console.log('Distance from 124 to each chosen subject:');
  for (const idx of chosen) {
    console.log(`  124 <-> ${ids[idx]}: ${dist(X[idx124], X[idx]).toFixed(3)}`);
  }
  console.log(`Is 124 among chosen? ${chosen.includes(idx124)}`);
} else {
  console.log('\nsubject_124 not found in loaded set.');
}

// --- anthropometry cross-check ---
const anthroPath = '/tmp/claude-1000/-home-ivan-pproject-papasangre/fd0997ab-e082-4a8d-a2ae-7e534abd18d0/scratchpad/cipic/anthropometry/anthro.mat';
if (existsSync(anthroPath)) {
  console.log('\n=== Anthropometry cross-check ===');
  const anthro = readMat5(anthroPath);
  console.log('anthro.mat fields:', Object.keys(anthro));
  // CIPIC anthro.mat typically has: id [45x1], X (head/torso, 17 measurements) [45x17], D (pinna, 8 per ear) [45x8x2], theta [45x2x2]
  const idField = anthro.id?.data;
  const X_anthro = anthro.X?.data, X_dims = anthro.X?.dims;
  const D_anthro = anthro.D?.data, D_dims = anthro.D?.dims;
  if (idField) {
    console.log('id sample:', Array.from(idField.slice(0, 5)));
  }
  console.log('X dims:', X_dims, 'D dims:', D_dims);

  function anthroRowFor(subjIdStr, arr, dims, ncols) {
    if (!idField || !arr || !dims) return null;
    const subjId = parseInt(subjIdStr, 10);
    let rowIdx = -1;
    for (let i = 0; i < idField.length; i++) if (idField[i] === subjId) { rowIdx = i; break; }
    if (rowIdx < 0) return null;
    const nrows = dims[0];
    const row = new Float64Array(ncols);
    for (let c = 0; c < ncols; c++) row[c] = arr[rowIdx + nrows * c]; // column-major
    return row;
  }

  if (X_anthro && X_dims) {
    const ncols = X_dims[1];
    console.log(`\nHead/torso measurements (X, ${ncols} cols) for chosen subjects (NaN = missing):`);
    for (const idx of chosen) {
      const row = anthroRowFor(ids[idx], X_anthro, X_dims, ncols);
      console.log(`  subject_${ids[idx]}:`, row ? Array.from(row).map(v => Number.isNaN(v) ? 'NaN' : v.toFixed(1)).join(', ') : 'not found');
    }
    // head width is typically X column index 0 or 1 depending on doc; print a couple candidate columns
  }
  if (D_anthro && D_dims) {
    const ncols = D_dims[1] * (D_dims[2] || 1);
    console.log(`\nPinna measurements (D) for chosen subjects (flattened, NaN = missing):`);
    for (const idx of chosen) {
      const row = anthroRowFor(ids[idx], D_anthro, D_dims, ncols);
      console.log(`  subject_${ids[idx]}:`, row ? Array.from(row).map(v => Number.isNaN(v) ? 'NaN' : v.toFixed(1)).join(', ') : 'not found');
    }
  }
} else {
  console.log('\nanthro.mat not found at', anthroPath);
}
