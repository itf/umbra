/**
 * Loudness-normalize every calibration base head to sadie_h3's global RMS — a PURE SCALAR
 * level match (no spectral / diffuse-field EQ). Raw baked heads from different databases
 * have wildly different absolute loudness, which makes the head A/B change VOLUME, not just
 * spatial cues. This matches diffuse-field loudness so the A/B is about localization only.
 *
 * Reference = sadie_h3 (the default head), measured — never hardcoded. All heads (including
 * the reference) are rescaled to a COMMON target RMS so they match each other exactly. The
 * target is sadie_h3's RMS, pulled down by a small headroom factor if — and only if —
 * matching a head at the raw reference RMS would push its peak over 1.0 (sample clipping).
 * Because the SAME target is applied to every head, they stay level-matched to each other;
 * the whole set just sits a hair quieter to guarantee no clipping. Idempotent-ish: the
 * headroom converges (a normalized set has no over-1.0 head, so the factor becomes 1.0).
 *
 * Usage: node scripts/normalize-base-heads.mjs
 */
import { readHrtf, globalRms, peak, writeHrtf } from './lib/hrtfLevel.mjs';

const DIR = 'assets/hrtf';
const REFERENCE = 'sadie_h3.hrtf';
// All calibration base heads (= BASE_HRTFS), reference first. Every head is measured and
// rescaled to the common target so they match each other, not just the reference.
const HEADS = [
  'sadie_h3.hrtf',
  'cipic_124.hrtf',
  'sadie_h13.hrtf',
  'ss2_ztv.hrtf', 'ss2_gzu.hrtf', 'ss2_ynb.hrtf',
  'ss2_fzk.hrtf', 'ss2_rll.hrtf',
];
const PEAK_CEIL = 0.99; // leave a hair of headroom below full scale

// Measure every head once.
const heads = HEADS.map((f) => { const h = readHrtf(`${DIR}/${f}`); return { f, h, rms: globalRms(h.irs), peak: peak(h.irs) }; });
const refRms = heads[0].rms;

// Common target: sadie_h3's RMS, reduced just enough that NO head's peak exceeds the
// ceiling once scaled to that target. peak scales with (target/rms), so the max peak at
// target T is max_i(peak_i * T/rms_i); require that ≤ PEAK_CEIL.
let maxPeakAtRef = 0;
for (const s of heads) maxPeakAtRef = Math.max(maxPeakAtRef, s.peak * (refRms / s.rms));
const headroom = maxPeakAtRef > PEAK_CEIL ? PEAK_CEIL / maxPeakAtRef : 1;
const targetRms = refRms * headroom;
console.log(`Reference ${REFERENCE}: RMS ${refRms.toFixed(4)}, peak ${heads[0].peak.toFixed(3)}`);
console.log(`Common target RMS ${targetRms.toFixed(4)} (headroom ${headroom.toFixed(3)}, so no head clips)\n`);

console.log('file'.padEnd(18), 'RMS(before)', 'peak(before)', ' gain', 'RMS(after)', 'peak(after)');
let ok = true;
for (const s of heads) {
  const gain = targetRms / (s.rms || 1);
  for (let i = 0; i < s.h.irs.length; i++) s.h.irs[i] *= gain;
  const aRms = globalRms(s.h.irs), aPeak = peak(s.h.irs);
  writeHrtf(`${DIR}/${s.f}`, s.h, s.h.irs);
  const within = Math.abs(aRms - targetRms) / targetRms < 0.05;
  const okPeak = aPeak <= 1.0;
  if (!within || !okPeak) ok = false;
  console.log(
    s.f.padEnd(18),
    s.rms.toFixed(4).padStart(10),
    s.peak.toFixed(3).padStart(11),
    gain.toFixed(3).padStart(6),
    aRms.toFixed(4).padStart(9),
    aPeak.toFixed(3).padStart(11),
    within && okPeak ? '' : '  <-- CHECK',
  );
}
console.log(`\n${ok ? 'OK' : 'FAIL'}: all heads within 5% of the common target RMS and peak ≤ 1.0.`);
process.exit(ok ? 0 : 1);
