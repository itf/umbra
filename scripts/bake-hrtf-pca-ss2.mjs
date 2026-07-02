/**
 * Offline PCA bake over the SS2 (Meta Reality Labs Sound Sphere 2) 78-subject HRTF
 * database → a TINY runtime asset describing how real human ears vary in the MAGNITUDE
 * domain. Replaces the HUTUBS bake: SS2 is newer (2022), native 48 kHz, eardrum-measured
 * (consistent with our SADIE default), CC-BY-4.0.
 *
 * WHY magnitude-only: the big inter-subject difference in the time domain is the ITD
 * (onset delay), which shifts in TIME — PCA is linear and would smear two differently-
 * delayed impulses into a double-peak. So we run PCA on per-direction LOG-MAGNITUDE
 * spectra ONLY (time-shift-invariant, blends cleanly); the ITD stays a separate scalar
 * knob elsewhere.
 *
 * Pipeline:
 *   read the common SS2 direction grid from subject 1's SourcePosition (subsampled to
 *     keep the model + runtime nearest-dir scan tight — SS2 has 1625 dirs)
 *   for each of 78 subjects (SOFA/HDF5 via h5wasm):
 *     for each direction on the common grid:
 *       log|FFT(hrir)| averaged L/R → magnitude feature
 *   stack → 78 × (Dirs*Bins) matrix
 *   PCA (mean + top K eigenvectors via covariance in subject space, 78×78 — cheap)
 *   + ONE extra pinna-band (4–12 kHz) PC, zeroed outside the band
 *   quantize mean + eigenvectors to int8 with per-vector scales
 *   write assets/hrtf/hrtf_pca.bin  (magic 'HPCA', v2 format hrtfPca.ts parses)
 *
 * The header stores per-direction grid az/el, so the runtime nearest-direction lookup is
 * dataset-agnostic. Azimuth is stored in the ENGINE convention (0 front, + right) — see
 * the SOFA→engine conversion — matching hrtfPca.ts's vecToAzEl at query time.
 *
 * Usage: node scripts/bake-hrtf-pca-ss2.mjs <ss2_dir> [out.bin]
 */
import { ready, FS, File } from 'h5wasm';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildFrontBackPairs, contrastSpectrum } from './lib/hrtfFrontBack.mjs';

const [, , ss2Dir, outPathArg] = process.argv;
if (!ss2Dir) {
  console.error('usage: node scripts/bake-hrtf-pca-ss2.mjs <ss2_dir> [out.bin]');
  process.exit(1);
}
const outPath = outPathArg ?? 'assets/hrtf/hrtf_pca.bin';

const TAPS = 384;      // SS2 measured IR length (48 kHz)
const SR = 48000;      // SS2 native sample rate
const NFFT = 512;      // zero-pad 384→512
const HALF = NFFT / 2 + 1; // 257
const KEEP_BINS = 48;  // downsampled log-mag points per direction
const K = 5;           // general principal components (pinna PC appended after → K+1 total)
// SS2 has 1625 directions — subsample every GRID_STRIDE-th to keep the model small and the
// runtime per-direction nearest-grid scan fast, while still spanning the full sphere.
const GRID_STRIDE = 4; // 1625 → ~407 grid directions

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
const files = readdirSync(ss2Dir).filter((d) => d.endsWith('.sofa') && !d.startsWith('._')).sort();
if (files.length === 0) { console.error('no *.sofa in', ss2Dir); process.exit(1); }
console.log(`Found ${files.length} SS2 subjects.`);

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

const first = readSofa(join(ss2Dir, files[0]));
const FULL_DIRS = first.M;
// Subsample the SS2 grid every GRID_STRIDE-th direction → the common grid we build PCA on.
const gridIdx = [];
for (let m = 0; m < FULL_DIRS; m += GRID_STRIDE) gridIdx.push(m);
const DIRS = gridIdx.length;
// Grid az/el arrays (engine convention), one entry per KEPT direction (the header stores
// per-direction az/el, so nearest-dir lookup is a flat scan, no AZxEL split).
const gridAz = new Float32Array(DIRS), gridEl = new Float32Array(DIRS);
for (let g = 0; g < DIRS; g++) {
  const m = gridIdx[g];
  const { az, el } = sofaToEngineAzEl(first.pos[m * 3], first.pos[m * 3 + 1]);
  gridAz[g] = az; gridEl[g] = el;
}
console.log(`Grid: ${DIRS} of ${FULL_DIRS} directions (stride ${GRID_STRIDE}), ${first.N} taps/ear.`);

const FEAT = DIRS * KEEP_BINS;

// --- load all subjects on the common grid ---
function featuresFor(s) {
  if (s.M !== FULL_DIRS || s.N !== TAPS) return null; // guard against odd files
  const feat = new Float64Array(FEAT);
  let fo = 0;
  for (let g = 0; g < DIRS; g++) {
    const m = gridIdx[g];
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
  const s = fn === files[0] ? first : readSofa(join(ss2Dir, fn));
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

// Per-PC application KIND (written to the v3 header, read by hrtfPca.ts):
//  0 = MAGNITUDE — deform every direction's magnitude by +weight·eig (the classic PCs).
//  1 = FRONT/BACK CONTRAST — a hemisphere-SIGNED deformation: +weight·eig on the front
//      hemisphere, −weight·eig on the back (it's a contrast axis, not an absolute shape).
const KIND_MAGNITUDE = 0;
const KIND_FB = 1;

// Candidate GENERAL PCs (pruned later, on the correlation evidence). Final component set
// (eigs/scales/kinds) is assembled after the pinna + front/back PCs + analysis.
const genEigs = [];
const genScales = [];
const genVarPct = [];
for (let kk = 0; kk < K; kk++) {
  const col = order[kk];
  const ev = new Float64Array(FEAT);
  for (let i = 0; i < S; i++) { const w = vecs[i][col]; const xi = Xc[i]; for (let f = 0; f < FEAT; f++) ev[f] += w * xi[f]; }
  let norm = 0; for (let f = 0; f < FEAT; f++) norm += ev[f] * ev[f];
  norm = Math.sqrt(norm) || 1;
  for (let f = 0; f < FEAT; f++) ev[f] /= norm;
  genEigs.push(ev);
  genScales.push(Math.sqrt(Math.max(0, vals[col])));
  genVarPct.push(Math.max(0, vals[col]) / (vals.reduce((p, c) => p + Math.max(0, c), 0) || 1) * 100);
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
const pinnaScale = Math.sqrt(Math.max(0, pvals[pcol]));
const pinnaVarPct = Math.max(0, pvals[pcol]) / totalVar * 100;
console.log(`Pinna PC: variance ${pinnaVarPct.toFixed(1)}% (band-restricted).`);

// --- data-driven FRONT/BACK CONTRAST principal component(s) ---------------------------
// The general PCs average over all directions, so they wash OUT how front-vs-back spectral
// SHAPE differs across people. To capture it we build a CONTRAST feature per subject using
// the CONE-OF-CONFUSION mirror: az θ ↔ (180°−θ) at the SAME elevation, which keeps the
// interaural/lateral coordinate + elevation fixed and flips ONLY front/back (NOT θ↔−θ,
// which is the L/R mirror = interaural cue, wrong). Per subject we average the per-bin
// log-mag difference (front − back) over all matched pairs → one contrast spectrum, then
// PCA those across the 78 subjects. We keep EVERY contrast PC whose variance fraction
// clears >8% (pinna PC ballpark); if none clear it, keep the top 1 (front/back is the
// point). Band-target to where the SS2 data actually HAS front/back energy: ~3–9 kHz.
// (Measured: the mean contrast is +4.7 dB @4k, +2 dB @8k with inter-subject std up to
// 2.2 dB @8k; the ~1 kHz Blauert band is weak in SS2 — mean −0.36 dB, sign flips 750–
// 1125 Hz — so we DON'T waste the PC's weight there.) Zero outside; runtime signs it per
// hemisphere (+ front, − back) — see KIND_FB.
const fbPairs = buildFrontBackPairs(Array.from(gridAz), Array.from(gridEl));
const FB_LO_HZ = 3000, FB_HI_HZ = 9000;
const fbBins = [];
for (let b = 0; b < KEEP_BINS; b++) { const hz = featureBinHz(b); if (hz >= FB_LO_HZ && hz <= FB_HI_HZ) fbBins.push(b); }
console.log(`Front/back: ${fbPairs.length} cone-mirror pairs (θ↔180−θ, el fixed); band ${FB_LO_HZ}-${FB_HI_HZ} Hz → bins ${fbBins[0]}..${fbBins[fbBins.length - 1]}.`);
// Per subject: contrast spectrum (mean front−back log-mag over pairs).
const fbFeat = X.map((x) => contrastSpectrum(fbPairs, (g) => x.subarray(g * KEEP_BINS, g * KEEP_BINS + KEEP_BINS), KEEP_BINS));
// Center + subject-space Gram PCA over the KEEP_BINS contrast vectors.
const fbMean = new Float64Array(KEEP_BINS);
for (const d of fbFeat) for (let b = 0; b < KEEP_BINS; b++) fbMean[b] += d[b];
for (let b = 0; b < KEEP_BINS; b++) fbMean[b] /= S;
const fbC = fbFeat.map((d) => { const c = new Float64Array(KEEP_BINS); for (let b = 0; b < KEEP_BINS; b++) c[b] = d[b] - fbMean[b]; return c; });
const fbGram = [];
for (let i = 0; i < S; i++) { fbGram[i] = new Float64Array(S); for (let j = 0; j < S; j++) { let s = 0; for (let b = 0; b < KEEP_BINS; b++) s += fbC[i][b] * fbC[j][b]; fbGram[i][j] = s / S; } }
const { vals: fbVals, vecs: fbVecs } = jacobiEigen(fbGram);
const fbOrder = Array.from({ length: S }, (_, i) => i).sort((a, b) => fbVals[b] - fbVals[a]);
const fbTotalVar = fbVals.reduce((p, c) => p + Math.max(0, c), 0) || 1;
const fbBandMask = new Uint8Array(KEEP_BINS); for (const b of fbBins) fbBandMask[b] = 1;
const FB_VAR_GATE = 0.08; // keep contrast PCs above 8% of the contrast variance
const fbKept = [];
for (let r = 0; r < S; r++) {
  const col = fbOrder[r];
  const frac = Math.max(0, fbVals[col]) / fbTotalVar;
  if (r > 0 && frac < FB_VAR_GATE) break; // r=0 always considered; later ones must clear the gate
  // Reconstruct the contrast curve, band-limit, normalize over the CONTRAST BAND only.
  // CRITICAL: runtime deformationCurve reads a SINGLE direction's KEEP_BINS slice, so the
  // per-direction slice must carry the TRUE contrast magnitude. Normalizing the curve over
  // KEEP_BINS (not the tiled dirs×bins FEAT vector) is what makes `scale`×eig ≈ real dB —
  // the old FEAT-wide unit-L2 normalization divided every bin by √DIRS≈20×, so the applied
  // deformation was ~0.3 dB instead of ~6 dB. The curve is tiled into every direction (each
  // direction's slice is the same band-limited curve); the runtime signs it per hemisphere.
  const curve = new Float64Array(KEEP_BINS);
  for (let i = 0; i < S; i++) { const w = fbVecs[i][col]; for (let b = 0; b < KEEP_BINS; b++) curve[b] += w * fbC[i][b]; }
  for (let b = 0; b < KEEP_BINS; b++) if (!fbBandMask[b]) curve[b] = 0;
  let cn = 0; for (let b = 0; b < KEEP_BINS; b++) cn += curve[b] * curve[b]; cn = Math.sqrt(cn) || 1;
  for (let b = 0; b < KEEP_BINS; b++) curve[b] /= cn; // unit over the band → true per-dir dB
  const eig = new Float64Array(FEAT);
  for (let d = 0; d < DIRS; d++) for (let b = 0; b < KEEP_BINS; b++) eig[d * KEEP_BINS + b] = curve[b];
  // NO FEAT-wide renormalization here (that was the √DIRS dilution bug).
  fbKept.push({ eig, scale: Math.sqrt(Math.max(0, fbVals[col])), frac });
  if (r === 0 && frac < FB_VAR_GATE) { // top PC below gate: keep it anyway, then stop
    console.log(`Front/back: top contrast PC only ${(frac * 100).toFixed(1)}% (< ${FB_VAR_GATE * 100}% gate) — keeping it anyway (front/back is the point).`);
    break;
  }
}
// Prune redundant front/back contrast PCs: two contrast PCs that are ≥0.85 collinear are
// the same axis — keep only the higher-variance one (no point spending A/B trials on both).
const cos = (a, b) => { let d = 0, na = 0, nb = 0; for (let i = 0; i < FEAT; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return Math.abs(d) / (Math.sqrt(na * nb) || 1); };
const FB_COLLINEAR = 0.85;
const fbFinal = [];
for (const cand of fbKept) {
  const dup = fbFinal.find((k) => cos(k.eig, cand.eig) >= FB_COLLINEAR);
  if (dup) { console.log(`  drop front/back PC (${(cand.frac * 100).toFixed(1)}%): ${cos(dup.eig, cand.eig).toFixed(2)} collinear with a kept one.`); continue; }
  fbFinal.push(cand);
}
const N_FB = fbFinal.length;
for (const { frac } of fbFinal) console.log(`Front/back CONTRAST PC kept: ${(frac * 100).toFixed(1)}% of front/back-difference variance (hemisphere-signed at runtime).`);
console.log(`Front/back contrast PCs: ${fbKept.length} cleared the ${FB_VAR_GATE * 100}% gate → ${N_FB} kept after collinearity prune.`);

// ============================ CORRELATION / REDUNDANCY ANALYSIS ======================
// Correlation + band-overlap over ALL candidates (general PCs, pinna, kept FB PCs), to
// decide which GENERAL PCs are redundant enough to drop.
function bandEnergyFrac(eig, bins) {
  const mask = new Uint8Array(KEEP_BINS); for (const b of bins) mask[b] = 1;
  let inb = 0, tot = 0;
  for (let d = 0; d < DIRS; d++) for (let b = 0; b < KEEP_BINS; b++) { const v = eig[d * KEEP_BINS + b] ** 2; tot += v; if (mask[b]) inb += v; }
  return inb / (tot || 1);
}
const targeted = [{ name: 'Pinna', eig: pinnaEig }, ...fbFinal.map((f, i) => ({ name: N_FB > 1 ? `FB${i + 1}` : 'FB', eig: f.eig }))];
const candNames = genEigs.map((_, i) => `G${i + 1}`).concat(targeted.map((t) => t.name));
const candEigs = genEigs.concat(targeted.map((t) => t.eig));
console.log('\n=== |cosine| correlation between candidate PCs ===');
console.log('       ' + candNames.map((n) => n.padStart(6)).join(''));
for (let i = 0; i < candEigs.length; i++) {
  let row = candNames[i].padStart(6) + ' ';
  for (let j = 0; j < candEigs.length; j++) row += (i === j ? '  1.00' : cos(candEigs[i], candEigs[j]).toFixed(2).padStart(6));
  console.log(row);
}
console.log('\n=== general-PC keep/drop decision ===');
console.log('       var%  maxCorr(targeted)  inFBband  inPinnaBand  →');
// Drop a GENERAL PC when it's low-variance AND its spectral territory is already covered:
// either it correlates >CORR_DROP with a targeted PC, or ≥BAND_DROP of its energy sits
// inside the cue bands the pinna/front-back PCs now own. A low-var PC that is INDEPENDENT
// of everything (unique) is KEPT — variance alone never drops it.
const VAR_LOW = 6.0, CORR_DROP = 0.35, BAND_DROP = 0.85;
const keepGen = [];
for (let i = 0; i < genEigs.length; i++) {
  let maxCorr = 0; for (const t of targeted) maxCorr = Math.max(maxCorr, cos(genEigs[i], t.eig));
  const fbE = bandEnergyFrac(genEigs[i], fbBins), pinE = bandEnergyFrac(genEigs[i], pinnaBins);
  const inBands = fbE + pinE; // both cue bands are disjoint here
  const lowVar = genVarPct[i] < VAR_LOW;
  const redundant = maxCorr > CORR_DROP || inBands >= BAND_DROP;
  const drop = lowVar && redundant;
  if (!drop) keepGen.push(i);
  console.log(`  G${i + 1}  ${genVarPct[i].toFixed(1).padStart(5)}  ${maxCorr.toFixed(2).padStart(15)}   ${(fbE * 100).toFixed(0).padStart(6)}%   ${(pinE * 100).toFixed(0).padStart(8)}%   ${drop ? 'DROP (low-var + covered)' : (lowVar ? 'KEEP (low-var but UNIQUE)' : 'KEEP (high-var)')}`);
}
console.log('');

// ---- assemble the FINAL component set: kept general PCs, pinna, kept front/back PCs ----
// Each PC also carries a SHORT, user-facing NAME (written to the v4 header) so the manual
// knobs + factor labels read meaningfully instead of "Real-ear shape N". Names describe
// what the knob perceptually controls, not the math.
const eigs = [], scales = [], kinds = [], names = [];
let genN = 0;
for (const i of keepGen) { eigs.push(genEigs[i]); scales.push(genScales[i]); kinds.push(KIND_MAGNITUDE); names.push(`Overall ear shape ${++genN}`); }
eigs.push(pinnaEig); scales.push(pinnaScale); kinds.push(KIND_MAGNITUDE); names.push('Pinna notch (up/down)');
let fbN = 0;
for (const f of fbFinal) { eigs.push(f.eig); scales.push(f.scale); kinds.push(KIND_FB); names.push(N_FB > 1 ? `Front/back tone ${++fbN}` : 'Front/back tone'); }
const K_TOTAL = eigs.length;
console.log(`Final component set: ${keepGen.length} general + 1 pinna + ${N_FB} front/back = ${K_TOTAL} PCs.`);
console.log('PC names:', names.map((n, i) => `${i}:${n}`).join(', '));

// --- quantize to int8 (mean f32; eigs int8 + per-vector scale) ---
function quantI8(vec) {
  let amax = 0; for (const v of vec) amax = Math.max(amax, Math.abs(v));
  const q = amax || 1;
  const out = new Int8Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = Math.max(-127, Math.min(127, Math.round(vec[i] / q * 127)));
  return { out, q };
}

// header (VERSION 4): magic 'HPCA'(4) ver u32(=4), NFFT u32, S u32, DIRS u32, KEEP_BINS u32,
//   K u32, gridAzN u32, gridElN u32, then az f32[gridAzN], el f32[gridElN], mean f32[FEAT],
//   then per-PC: eigScale f32, quantScale f32, KIND u8, NAMELEN u8, name UTF-8[NAMELEN],
//   eig int8[FEAT].
// v4 adds the per-PC NAME (length-prefixed UTF-8) for meaningful knob labels. v3 = kind
// byte, no name. v2 = flat grid + NFFT, no kind. v1 = legacy CIPIC factored grid.
const GRID_N = DIRS;
const nameBufs = names.map((n) => Buffer.from(n, 'utf8').subarray(0, 255));
// header u32s: ver, NFFT, S, DIRS, KEEP_BINS, K, gridAzN, gridElN = 8 u32 (+ 4-byte magic)
const headerBytes = 4 + 8 * 4;
const gridN = 4 * (GRID_N + GRID_N);
const meanN = 4 * FEAT;
let pcN = 0;
for (let kk = 0; kk < K_TOTAL; kk++) pcN += 4 + 4 + 1 + 1 + nameBufs[kk].length + FEAT; // scale,q,kind,namelen,name,eig
const buf = Buffer.alloc(headerBytes + gridN + meanN + pcN);
let o = 0;
buf.write('HPCA', o); o += 4;
buf.writeUInt32LE(4, o); o += 4;      // version 4
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
  buf.writeUInt8(kinds[kk], o); o += 1;              // application kind
  buf.writeUInt8(nameBufs[kk].length, o); o += 1;    // name length
  nameBufs[kk].copy(buf, o); o += nameBufs[kk].length; // name UTF-8
  for (let i = 0; i < FEAT; i++) { buf.writeInt8(out[i], o); o += 1; }
}
writeFileSync(outPath, buf);
console.log(`Wrote ${outPath} (${(buf.length / 1024).toFixed(0)} KB): mean + ${K_TOTAL} PCs (${keepGen.length} general + 1 pinna + ${N_FB} front/back), ${DIRS} dirs × ${KEEP_BINS} bins, ${S} subjects.`);

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
