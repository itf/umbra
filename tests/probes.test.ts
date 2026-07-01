/**
 * Pure tests for the selectable probe ("echo") generators. No AudioContext: each
 * preset is a `(sampleRate) => Float32Array`, so we assert LENGTH ranges, non-zero
 * energy, and that envelopes start/end near zero (no edge click) — all of which is
 * deterministic in the sample rate even though the noise samples are random.
 *
 * Also covers `resolveProbe`'s fallback to `clap` for unknown names, and the
 * recorded-probe + clap-position control flow lives in scenePlayerProbe.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { resolveProbe, isProbeName, PROBE_PRESETS, DEFAULT_PROBE } from '../src/debug/probes';

const SR = 48000;

function energy(b: Float32Array): number {
  let e = 0;
  for (const x of b) e += x * x;
  return e;
}

describe('probe generators', () => {
  it('every preset produces non-empty, finite, non-zero-energy buffers', () => {
    for (const { name } of PROBE_PRESETS) {
      const b = resolveProbe(name)(SR);
      expect(b.length).toBeGreaterThan(0);
      expect(b.every((x) => Number.isFinite(x))).toBe(true);
      expect(energy(b)).toBeGreaterThan(0);
    }
  });

  it('length ordering: click is shortest, hiss is longest', () => {
    const len = (n: string) => resolveProbe(n)(SR).length;
    expect(len('click')).toBeLessThan(len('clap'));
    expect(len('clap')).toBeLessThan(len('snap'));
    expect(len('snap')).toBeLessThan(len('hiss'));
    // hiss is the sustained one (well over 100ms at 48k).
    expect(len('hiss')).toBeGreaterThan(0.1 * SR);
    // click is a few ms.
    expect(len('click')).toBeLessThan(0.01 * SR);
  });

  it('lengths scale with sample rate (deterministic in sr)', () => {
    expect(resolveProbe('hiss')(96000).length).toBeGreaterThan(resolveProbe('hiss')(48000).length);
  });

  it('hiss has no edge click: starts and ends at (near) zero', () => {
    const b = resolveProbe('hiss')(SR);
    expect(Math.abs(b[0])).toBeLessThan(1e-6);
    expect(Math.abs(b[b.length - 1])).toBeLessThan(1e-3);
  });

  it('transient probes also start near zero (fast attack, no leading click)', () => {
    for (const n of ['click', 'snap'] as const) {
      const b = resolveProbe(n)(SR);
      expect(Math.abs(b[0])).toBeLessThan(0.2);
    }
  });

  it('stomp is a footfall-shaped probe: normalized peak, decays to near-zero', () => {
    const b = resolveProbe('stomp')(SR);
    expect(b.length).toBeGreaterThan(0);
    let peak = 0;
    for (const v of b) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeCloseTo(1, 2); // normalized to ~unit peak
    expect(Math.abs(b[b.length - 1])).toBeLessThan(1e-2); // thump has decayed by the end
  });

  it('resolveProbe falls back to the default probe for unknown / missing names', () => {
    const defLen = resolveProbe(DEFAULT_PROBE)(SR).length;
    expect(resolveProbe('nope')(SR).length).toBe(defLen);
    expect(resolveProbe(undefined)(SR).length).toBe(defLen);
    expect(resolveProbe(42 as unknown)(SR).length).toBe(defLen);
    // The good tongue click is now the default probe.
    expect(DEFAULT_PROBE).toBe('mouthclick');
  });

  it('mouthclick preset resolves to the realistic mouth-click buffer (~3–6ms, non-zero)', () => {
    expect(isProbeName('mouthclick')).toBe(true);
    expect(PROBE_PRESETS.some((p) => p.name === 'mouthclick')).toBe(true);
    const b = resolveProbe('mouthclick')(SR);
    // 6ms render window at 48k ≈ 288 samples.
    expect(b.length).toBeGreaterThan(0.002 * SR);
    expect(b.length).toBeLessThan(0.01 * SR);
    expect(energy(b)).toBeGreaterThan(0);
    expect(b.every((x) => Number.isFinite(x))).toBe(true);
  });

  it('mouthclick varies per fire (seeded jitter) but stays the same length', () => {
    const a = resolveProbe('mouthclick')(SR);
    const c = resolveProbe('mouthclick')(SR);
    expect(a.length).toBe(c.length);
    // Fresh random seed per call ⇒ the two renders differ somewhere.
    let differs = false;
    for (let i = 0; i < a.length; i++) if (a[i] !== c[i]) { differs = true; break; }
    expect(differs).toBe(true);
  });

  it('isProbeName recognizes presets and rejects junk', () => {
    expect(isProbeName('clap')).toBe(true);
    expect(isProbeName('hiss')).toBe(true);
    expect(isProbeName('custom')).toBe(false);
    expect(isProbeName(null)).toBe(false);
  });
});
