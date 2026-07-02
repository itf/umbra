/**
 * Window/truncate an HRIR to a shorter tap count with a raised-cosine fade at the tail,
 * so a longer measured IR (e.g. SS2's 384 taps) fits our standard 256-tap runtime length
 * without a hard discontinuity. The onset is preserved verbatim — we only taper the LAST
 * `fade` taps of the kept window down to zero. Safe when nearly all energy sits within
 * `outTaps` (verified for SS2: >99.7% of energy in the first 256 taps, onset peaks <~61).
 */

/** Return a new Float32Array of length `outTaps`: src[0..outTaps) with a cosine fade over
 *  the final `fade` taps. If src is shorter than outTaps it's zero-padded (no fade needed). */
export function windowTo(src, outTaps, fade = 32) {
  const out = new Float32Array(outTaps);
  const n = Math.min(outTaps, src.length);
  for (let i = 0; i < n; i++) out[i] = src[i];
  if (src.length <= outTaps) return out; // nothing truncated → no taper
  const fStart = Math.max(0, outTaps - fade);
  for (let i = fStart; i < outTaps; i++) {
    // raised cosine from 1 at fStart to 0 at the last tap
    const t = (i - fStart) / (outTaps - fStart); // 0..~1
    out[i] *= 0.5 * (1 + Math.cos(Math.PI * t));
  }
  return out;
}
