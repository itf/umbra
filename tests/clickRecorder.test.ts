/**
 * Pure-helper tests for clickRecorder.ts.
 *
 * No mic, no AudioContext, no getUserMedia — only the deterministic DSP helpers
 * (findPeakIndex, trimAroundPeak, applyFades, peakNormalize, processClickBuffer).
 */
import { describe, it, expect } from 'vitest';
import {
  findPeakIndex,
  trimAroundPeak,
  applyFades,
  peakNormalize,
  processClickBuffer,
} from '../src/trainer/clickRecorder';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBuf(values: number[]): Float32Array {
  return new Float32Array(values);
}

/** Impulse at `peakIdx` in a silent buffer of length `n`. */
function impulse(n: number, peakIdx: number, amplitude = 1): Float32Array {
  const buf = new Float32Array(n);
  buf[peakIdx] = amplitude;
  return buf;
}

// ---------------------------------------------------------------------------
// findPeakIndex
// ---------------------------------------------------------------------------

describe('findPeakIndex', () => {
  it('finds the index of the maximum absolute value', () => {
    expect(findPeakIndex(makeBuf([0.1, -0.9, 0.5]))).toBe(1);
    expect(findPeakIndex(makeBuf([0, 0, 1, 0]))).toBe(2);
  });

  it('returns 0 for a single-element buffer', () => {
    expect(findPeakIndex(makeBuf([0.7]))).toBe(0);
  });

  it('returns 0 for an all-zero buffer', () => {
    expect(findPeakIndex(new Float32Array(10))).toBe(0);
  });

  it('prefers the first occurrence when two samples tie', () => {
    // Both index 1 and 3 have abs = 0.8; first wins.
    expect(findPeakIndex(makeBuf([0, 0.8, 0, -0.8]))).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// trimAroundPeak
// ---------------------------------------------------------------------------

describe('trimAroundPeak', () => {
  const SR = 48000;
  const preSamples  = Math.round((5  / 1000) * SR); //  240 samples
  const postSamples = Math.round((45 / 1000) * SR); // 2160 samples

  it('returns a buffer of roughly pre + post + 1 samples for a mid-buffer peak', () => {
    // 5 s buffer; peak in the middle — plenty of room on both sides.
    const n = 5 * SR;
    const peakIdx = Math.floor(n / 2);
    const buf = impulse(n, peakIdx);
    const trimmed = trimAroundPeak(buf, peakIdx, preSamples, postSamples);
    expect(trimmed.length).toBe(preSamples + postSamples + 1);
  });

  it('clamps when peak is near the START (fewer than preSamples samples before it)', () => {
    // Peak at index 10 — only 10 samples before it, not preSamples.
    const n = 5 * SR;
    const buf = impulse(n, 10);
    const trimmed = trimAroundPeak(buf, 10, preSamples, postSamples);
    // start = max(0, 10 - preSamples) = 0
    // end   = min(n, 10 + postSamples + 1)
    expect(trimmed.length).toBe(10 + postSamples + 1);
  });

  it('clamps when peak is near the END (fewer than postSamples samples after it)', () => {
    const n = 5 * SR;
    const peakIdx = n - 10;
    const buf = impulse(n, peakIdx);
    const trimmed = trimAroundPeak(buf, peakIdx, preSamples, postSamples);
    // end clamped to n
    expect(trimmed.length).toBe(preSamples + 10);
  });

  it('never exceeds the original buffer length', () => {
    // Tiny buffer where the window is bigger than the buffer.
    const buf = new Float32Array([0, 1, 0]);
    const trimmed = trimAroundPeak(buf, 1, 5000, 5000);
    expect(trimmed.length).toBeLessThanOrEqual(buf.length);
  });

  it('the peak sample is present in the trimmed result', () => {
    const n = 4800;
    const peakIdx = 1000;
    const buf = impulse(n, peakIdx, 0.42);
    const trimmed = trimAroundPeak(buf, peakIdx, preSamples, postSamples);
    // The peak falls at offset preSamples inside the trimmed buffer
    // (if not clamped at start).
    const offsetInTrimmed = peakIdx - Math.max(0, peakIdx - preSamples);
    expect(trimmed[offsetInTrimmed]).toBeCloseTo(0.42, 5);
  });
});

// ---------------------------------------------------------------------------
// applyFades
// ---------------------------------------------------------------------------

describe('applyFades', () => {
  it('first and last sample are zero (or near-zero) after fade', () => {
    const buf = new Float32Array(1000).fill(1);
    applyFades(buf, 96); // 2 ms at 48 kHz
    expect(buf[0]).toBeCloseTo(0, 5);
    expect(buf[buf.length - 1]).toBeCloseTo(0, 5);
  });

  it('mid-buffer samples are unaffected (gain = 1)', () => {
    const n = 500;
    const fade = 10;
    const buf = new Float32Array(n).fill(1);
    applyFades(buf, fade);
    // Sample exactly at fade boundary should be ~1
    expect(buf[fade]).toBeCloseTo(1, 5);
    expect(buf[n - 1 - fade]).toBeCloseTo(1, 5);
  });

  it('clamps to half the buffer length — no aliasing on very short buffers', () => {
    // Buffer of 6 samples, fade 100 — should be clamped to 3.
    const buf = makeBuf([1, 1, 1, 1, 1, 1]);
    applyFades(buf, 100);
    // Both ends tapered, no sample is > 1 (no overflow).
    for (const x of buf) expect(x).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// peakNormalize
// ---------------------------------------------------------------------------

describe('peakNormalize', () => {
  it('normalizes peak to ~0.9 by default', () => {
    const buf = makeBuf([0, 0.5, -0.25, 0.1]);
    peakNormalize(buf);
    let peak = 0;
    for (const x of buf) { const a = Math.abs(x); if (a > peak) peak = a; }
    expect(peak).toBeCloseTo(0.9, 5);
  });

  it('normalizes to a custom target', () => {
    const buf = makeBuf([0, 0.2, -0.5]);
    peakNormalize(buf, 0.5);
    let peak = 0;
    for (const x of buf) { const a = Math.abs(x); if (a > peak) peak = a; }
    expect(peak).toBeCloseTo(0.5, 5);
  });

  it('is a no-op on a silent buffer', () => {
    const buf = new Float32Array(10);
    peakNormalize(buf);
    for (const x of buf) expect(x).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// processClickBuffer — integration of the pure pipeline
// ---------------------------------------------------------------------------

describe('processClickBuffer', () => {
  const SR = 48000;

  it('output length matches the trim window (mid-buffer peak)', () => {
    // 2 s of silence with a spike in the middle.
    const n = 2 * SR;
    const buf = impulse(n, n / 2);
    const out = processClickBuffer(buf, SR);
    const preSamples  = Math.round((5  / 1000) * SR);
    const postSamples = Math.round((45 / 1000) * SR);
    expect(out.length).toBe(preSamples + postSamples + 1);
  });

  it('peak is normalized to ~0.9 (after fades, interior peak)', () => {
    const n = 2 * SR;
    const peakIdx = n / 2;
    const buf = impulse(n, peakIdx, 0.01); // tiny amplitude, should be boosted
    const out = processClickBuffer(buf, SR);
    let peak = 0;
    for (const x of out) { const a = Math.abs(x); if (a > peak) peak = a; }
    expect(peak).toBeCloseTo(0.9, 1);
  });

  it('edges are near zero (fade applied)', () => {
    const n = 2 * SR;
    const buf = impulse(n, n / 2);
    const out = processClickBuffer(buf, SR);
    expect(Math.abs(out[0])).toBeLessThan(0.05);
    expect(Math.abs(out[out.length - 1])).toBeLessThan(0.05);
  });

  it('clamped correctly when peak is near the start of the raw buffer', () => {
    // Peak at sample 20 — only 20 samples before it.
    const n = SR; // 1 s
    const buf = impulse(n, 20);
    const out = processClickBuffer(buf, SR);
    // Should not throw and should have a sensible length.
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(n);
  });

  it('clamped correctly when peak is near the end of the raw buffer', () => {
    const n = SR;
    const buf = impulse(n, n - 5);
    const out = processClickBuffer(buf, SR);
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(n);
  });
});
