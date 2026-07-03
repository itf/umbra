/**
 * Select diverse "base head" candidates for the HRTF calibration A/B tournament, drawn
 * from SADIE II (H4..H20) and SS2 (Meta Reality Labs Sound Sphere 2, 78 subjects) SOFAs.
 *
 * Reads each SOFA via h5wasm (like scripts/bake-hrtf.mjs), samples a COMMON set of query
 * directions by nearest-direction lookup (grids differ across datasets), extracts the
 * same log-spaced log-magnitude features used by the PCA bake, then runs a farthest-point
 * / max-min selection in that feature space so the chosen heads are maximally different
 * from each other (a small, spread-out candidate pool for perceptual selection).
 *
 * Full head pipeline after selection: bake (scripts/bake-hrtf.mjs for SADIE,
 * bake-hrtf-ss2.mjs for SS2 — both native 48 kHz, SS2 windowed 384→256 taps)
 *   → normalize-base-heads.mjs (scalar level-match to sadie_h3; otherwise the head A/B
 *     changes VOLUME, not spatial cues, and some raw heads clip past 1.0). Heads keep
 *     their full natural direction grids — no decimation.
 *
 * Usage: node scripts/select-diverse-heads-ss2.mjs <sadie_dir> <ss2_dir> [N]
 */
import { ready, FS, File } from 'h5wasm';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [, , sadieDir, ss2Dir, nArg] = process.argv;
if (!sadieDir || !ss2Dir) {
  console.error('usage: node scripts/select-diverse-heads-ss2.mjs <sadie_dir> <ss2_dir> [N]');
  process.exit(1);
}
const N_SELECT = parseInt(nArg ?? '6', 10);

/** Stable short id from an SS2 filename like "AKO536081622_1_processed.sofa" → "ss2_ako". */
function ss2Id(fn) { return `ss2_${fn.slice(0, 3).toLowerCase()}`; }

const NFFT = 512, HALF = NFFT / 2 + 1, KEEP_BINS = 48, TAPS = 256;

// Common query directions (engine az 0=front +right, el up), covering the horizontal ring
// densely (front/back cues) plus a few elevations. Nearest-dir lookup maps each into any grid.
const QUERY = [];
for (let az = -180; az < 180; az += 15) QUERY.push({ az, el: 0 });
for (const el of [-30, 30, 60]) for (let az = -180; az < 180; az += 45) QUERY.push({ az, el });
const NDIR = QUERY.length;
const FEAT = NDIR * KEEP_BINS;

function fftMag(x) {
  const n = NFFT; const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < x.length && i < n; i++) re[i] = x[i];
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; } }
  for (let len = 2; len <= n; len <<= 1) { const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang); for (let i = 0; i < n; i += len) { let cwr = 1, cwi = 0; for (let k = 0; k < len / 2; k++) { const ur = re[i + k], ui = im[i + k]; const vr = re[i + k + len / 2] * cwr - im[i + k + len / 2] * cwi; const vi = re[i + k + len / 2] * cwi + im[i + k + len / 2] * cwr; re[i + k] = ur + vr; im[i + k] = ui + vi; re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi; const nwr = cwr * wr - cwi * wi; cwi = cwr * wi + cwi * wr; cwr = nwr; } } }
  const mag = new Float64Array(HALF); for (let i = 0; i < HALF; i++) mag[i] = Math.hypot(re[i], im[i]); return mag;
}
function toLogMagFeature(mag) {
  const out = new Float64Array(KEEP_BINS);
  for (let b = 0; b < KEEP_BINS; b++) { const frac = b / (KEEP_BINS - 1); const idx = Math.round(1 + (HALF - 2) * (Math.pow(HALF - 1, frac) - 1) / (HALF - 2)); const i = Math.max(1, Math.min(HALF - 1, idx)); out[b] = Math.log(Math.max(1e-6, mag[i])); }
  return out;
}
function sofaToEngineAzEl(azSofa, elSofa) { let az = -azSofa; az = ((az + 180) % 360 + 360) % 360 - 180; return { az, el: elSofa }; }
function wrapDeg(d) { let x = d % 360; if (x > 180) x -= 360; if (x < -180) x += 360; return x; }

await ready;
function readSofa(path) {
  FS.writeFile('/in.sofa', new Uint8Array(readFileSync(path)));
  const f = new File('/in.sofa', 'r');
  const irDS = f.get('Data.IR'), posDS = f.get('SourcePosition');
  const [M, R, N] = irDS.shape; const ir = irDS.value, pos = posDS.value;
  f.close();
  return { M, R, N, ir, pos };
}

/** Feature vector for one SOFA subject on the common QUERY directions. */
function featuresFor(s) {
  // Precompute engine az/el per grid direction, then nearest-lookup for each query.
  const gaz = new Float64Array(s.M), gel = new Float64Array(s.M);
  for (let m = 0; m < s.M; m++) { const { az, el } = sofaToEngineAzEl(s.pos[m * 3], s.pos[m * 3 + 1]); gaz[m] = az; gel[m] = el; }
  const feat = new Float64Array(FEAT);
  let fo = 0;
  for (const q of QUERY) {
    let best = 0, bd = Infinity;
    for (let m = 0; m < s.M; m++) { const d = Math.abs(wrapDeg(gaz[m] - q.az)) + Math.abs(gel[m] - q.el); if (d < bd) { bd = d; best = m; } }
    const baseL = (best * 2 + 0) * s.N, baseR = (best * 2 + 1) * s.N;
    const irL = new Float64Array(TAPS), irR = new Float64Array(TAPS);
    for (let t = 0; t < TAPS && t < s.N; t++) { irL[t] = s.ir[baseL + t]; irR[t] = s.ir[baseR + t]; }
    const fL = toLogMagFeature(fftMag(irL)), fR = toLogMagFeature(fftMag(irR));
    for (let b = 0; b < KEEP_BINS; b++) feat[fo + b] = 0.5 * (fL[b] + fR[b]);
    fo += KEEP_BINS;
  }
  return feat;
}

// --- gather candidates ---
const cands = []; // { id, label, path, feat }
for (const fn of readdirSync(sadieDir).filter((d) => /^H\d+\.sofa$/.test(d)).sort((a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10))) {
  const num = fn.slice(1).replace('.sofa', '');
  cands.push({ id: `sadie_h${num}`, label: `SADIE H${num}`, path: join(sadieDir, fn) });
}
for (const fn of readdirSync(ss2Dir).filter((d) => d.endsWith('.sofa') && !d.startsWith('._')).sort()) {
  const id = ss2Id(fn);
  cands.push({ id, label: `SS2 ${fn.slice(0, 3)}`, path: join(ss2Dir, fn) });
}
console.log(`Candidates: ${cands.length} (SADIE + SS2). Extracting features on ${NDIR} common dirs…`);
for (const c of cands) { c.feat = featuresFor(readSofa(c.path)); process.stdout.write('.'); }
console.log('');

const dist = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; } return Math.sqrt(s); };

// --- farthest-point / max-min selection, seeded from the subject farthest from the mean ---
const S = cands.length;
const mean = new Float64Array(FEAT);
for (const c of cands) for (let i = 0; i < FEAT; i++) mean[i] += c.feat[i];
for (let i = 0; i < FEAT; i++) mean[i] /= S;
let startIdx = 0, startD = -1;
for (let i = 0; i < S; i++) { const d = dist(cands[i].feat, mean); if (d > startD) { startD = d; startIdx = i; } }

const chosen = [startIdx];
const minD = new Float64Array(S);
for (let i = 0; i < S; i++) minD[i] = dist(cands[i].feat, cands[startIdx].feat);
while (chosen.length < N_SELECT) {
  let best = -1, bestD = -1;
  for (let i = 0; i < S; i++) { if (chosen.includes(i)) continue; if (minD[i] > bestD) { bestD = minD[i]; best = i; } }
  chosen.push(best);
  for (let i = 0; i < S; i++) { const d = dist(cands[i].feat, cands[best].feat); if (d < minD[i]) minD[i] = d; }
}

console.log(`\n=== Selected ${N_SELECT} diverse heads (max-min) ===`);
for (const idx of chosen) console.log(`  ${cands[idx].id}\t${cands[idx].path}`);
console.log('\nJSON:');
console.log(JSON.stringify(chosen.map((idx) => ({ id: cands[idx].id, label: cands[idx].label, path: cands[idx].path }))));
