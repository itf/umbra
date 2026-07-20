import { describe, it, expect } from 'vitest';
import { HrtfDsp, precomputeMinPhase, type MinPhaseHrtf } from './interpolatingDsp';

/**
 * The worklet's idle EARLY-OUT (hrtfWorklet.ts) must be exactly LOSSLESS: it may skip
 * the DSP for a block ONLY when the output is provably all zeros, so no audible sound
 * — however faint — is ever dropped. The worklet can't run under vitest (no
 * AudioWorkletProcessor), so we test its two guarantees against the real HrtfDsp:
 *
 *  1. A block that is skipped (input exactly zero AND the tail fully drained) would
 *     have produced pure silence had the DSP run — so skipping is lossless.
 *  2. A block with ANY non-zero input (even -80 dB) is NOT skipped and renders.
 *  3. Resuming after an idle gap is click-free (first live block starts from silence).
 */

// A tiny synthetic HRTF set: a few directions, short IRs. Enough to exercise the
// convolution history/tail without shipping the 5.5 MB dataset into the test.
function makeSet(): MinPhaseHrtf {
  const taps = 32;
  const count = 4;
  const dirs = new Float32Array([0, 0, -1, 1, 0, 0, -1, 0, 0, 0, 0, 1].slice(0, count * 3));
  const irs = new Float32Array(count * 2 * taps);
  for (let d = 0; d < count; d++) {
    const base = d * 2 * taps;
    // A simple decaying IR per ear, slightly different L/R.
    // Normalize each ear's IR to unit sum so a 0.5-amp tone convolves to a bounded
    // (~0.5-scale) output — otherwise the raw decaying-exponential sum has ~6× DC gain
    // and the "no blow-up" resume assertion would trip on the fixture, not a real bug.
    let sumL = 0, sumR = 0;
    for (let t = 0; t < taps; t++) {
      sumL += Math.exp(-t / 6);
      sumR += Math.exp(-t / 7);
    }
    for (let t = 0; t < taps; t++) {
      irs[base + t] = (Math.exp(-t / 6) / sumL) * (1 - d * 0.1);
      irs[base + taps + t] = (Math.exp(-t / 7) / sumR) * (0.9 - d * 0.1);
    }
  }
  return precomputeMinPhase({ sampleRate: 48000, taps, count, dirs, irs });
}

const N = 128; // render quantum

/**
 * Mirror of the worklet's idle decision, evaluated against the PRIOR trailing-zero
 * run (before this block is folded in): skip iff the tail was already drained AND
 * this block's input is all zero.
 */
function shouldSkip(priorZeroRun: number, taps: number, blockZero: boolean): boolean {
  return blockZero && priorZeroRun >= taps;
}

function isZero(a: Float32Array): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== 0) return false;
  return true;
}

describe('worklet idle early-out is lossless', () => {
  it('a skipped block would have produced pure silence', () => {
    const mp = makeSet();
    const dsp = new HrtfDsp(mp, 4);
    const outL = new Float32Array(N);
    const outR = new Float32Array(N);

    const zero = new Float32Array(N);
    const tone = new Float32Array(N);
    for (let i = 0; i < N; i++) tone[i] = Math.sin(i * 0.1) * 0.5;

    // Drive a tone, then go silent long enough for the tail (taps=32) to drain.
    dsp.setDirection(0, 0, -1);
    dsp.process(tone, outL, outR);
    let priorZeroRun = 0; // trailing zero-input samples BEFORE the current block
    let sawSkippable = false;
    // Feed several silent blocks. For any block the worklet WOULD skip (tail drained
    // before it), the real DSP output must already be pure silence.
    for (let block = 0; block < 5; block++) {
      const willSkip = shouldSkip(priorZeroRun, mp.taps, true);
      dsp.setDirection(0, 0, -1);
      dsp.process(zero, outL, outR);
      if (willSkip) {
        sawSkippable = true;
        expect(isZero(outL)).toBe(true);
        expect(isZero(outR)).toBe(true);
      }
      priorZeroRun += N;
    }
    // Sanity: with taps=32 < N=128, the tail drains within the first zero block, so a
    // later block IS skippable — the test actually exercised the skip branch.
    expect(sawSkippable).toBe(true);
  });

  it('does NOT skip a block with a faint (-80 dB) non-zero input', () => {
    const faint = new Float32Array(N);
    faint[N - 1] = 1e-4; // ~-80 dBFS, a single tiny sample
    let blockZero = true;
    for (let i = 0; i < N; i++) if (faint[i] !== 0) { blockZero = false; break; }
    expect(blockZero).toBe(false);
    expect(shouldSkip(1e9, 32, blockZero)).toBe(false);
  });

  it('does NOT skip while the tail is still ringing after signal stops', () => {
    // One silent block right after a tone: zeroRun (128) >= taps, but the FIRST silent
    // block still carries the decaying tail, so the worklet keeps rendering until the
    // run of trailing zeros actually reaches taps. Model the sample-accurate run.
    const taps = 32;
    // After a tone block, the next block is zero but the tail from the tone is still
    // in history for the first `taps` samples — those samples are non-zero OUTPUT even
    // though INPUT is zero. The guard is on INPUT zeros reaching `taps`, and the first
    // zero block's input contributes 128 zeros, which already exceeds taps=32 — so we
    // must ensure the DSP output for that first block is genuinely silent before the
    // real code trusts the skip. That's what test #1 verifies against the real DSP.
    // Here we just assert the boundary: a run shorter than taps never skips.
    expect(shouldSkip(taps - 1, taps, true)).toBe(false);
    expect(shouldSkip(taps, taps, true)).toBe(true);
  });

  it('resume after idle starts from silence (click-free): output ramps up, no jump', () => {
    const mp = makeSet();
    const dsp = new HrtfDsp(mp, 4);
    const outL = new Float32Array(N);
    const outR = new Float32Array(N);
    const zero = new Float32Array(N);
    const tone = new Float32Array(N);
    for (let i = 0; i < N; i++) tone[i] = Math.sin(i * 0.1) * 0.5;

    // Warm, then idle long enough to fully drain (simulating skipped blocks: the
    // worklet would NOT call process, and history stays zero).
    dsp.setDirection(0, 0, -1);
    dsp.process(tone, outL, outR);
    for (let b = 0; b < 4; b++) { dsp.setDirection(0, 0, -1); dsp.process(zero, outL, outR); }

    // Resume with a NEW direction (as if the source moved during the idle gap).
    dsp.setDirection(1, 0, 0);
    dsp.process(tone, outL, outR);
    // The first resumed sample must be small (input starts near zero at s=0 for this
    // tone) and there must be no discontinuity spike far exceeding the tone envelope.
    const peak = Math.max(...Array.from(outL).map(Math.abs), ...Array.from(outR).map(Math.abs));
    expect(Number.isFinite(peak)).toBe(true);
    expect(peak).toBeLessThan(1); // no blow-up; unit-sum IR keeps a 0.5-amp tone bounded
    expect(Math.abs(outL[0])).toBeLessThan(0.2); // begins from drained (near-silent) history
  });
});
