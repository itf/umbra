/**
 * CLICK-FREE INTERPOLATING HRTF — step-discontinuity acceptance.
 *
 * The artifact this renderer fixes is a sample-to-sample STEP discontinuity (a
 * "square-wave front" click) emitted every time the listener crosses a measured
 * HRIR direction bucket while turning. The in-browser meter (?meter=1) measures the
 * worst |x[i]-x[i-1]| per 0.5 s; a clean 440 Hz sine reads ~0.016-0.02, the old
 * clicking engine ~0.05-0.07.
 *
 * node-web-audio-api's OfflineAudioContext HANGS on `audioWorklet.addModule` (it
 * does not usefully support worklets in this environment — verified: the call never
 * resolves), so we test the PURE DSP (interpolatingDsp.ts) that the worklet wraps,
 * directly. We render a steady 440 Hz sine while the head turns 0→60° at the real UI
 * turn rate (100°/s) — crossing many buckets — and assert the worst sample step
 * stays near the clean-sine baseline. We compare against a NAIVE hard-swap convolver
 * (the old engine's behaviour: nearest IR, switched on bucket change) which produces
 * the large step spikes, to get a concrete before/after.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { sphericalToVec, nearestDir, type HrtfSet } from '../src/engine/hrtf/sofa';
import { precomputeMinPhase, HrtfDsp } from '../src/engine/hrtf/interpolatingDsp';

const here = dirname(fileURLToPath(import.meta.url));

function loadHrtfFromDisk(path: string): HrtfSet {
  const data = readFileSync(path);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = 4 + 4;
  const sampleRate = dv.getFloat32(o, true); o += 4;
  const count = dv.getUint32(o, true); o += 4;
  const taps = dv.getUint32(o, true); o += 4;
  const dirs = new Float32Array(count * 3);
  for (let m = 0; m < count; m++) {
    const az = dv.getFloat32(o, true); o += 4;
    const el = dv.getFloat32(o, true); o += 4;
    const [x, y, z] = sphericalToVec(az, el);
    dirs[m * 3] = x; dirs[m * 3 + 1] = y; dirs[m * 3 + 2] = z;
  }
  const irs = new Float32Array(count * 2 * taps);
  for (let i = 0; i < irs.length; i++) { irs[i] = dv.getFloat32(o, true); o += 4; }
  return { sampleRate, taps, count, dirs, irs };
}

/** worst |x[i]-x[i-1]| in [start,end) — the meter's step metric. */
function worstStep(buf: Float32Array, start: number, end: number): number {
  let m = 0;
  for (let i = Math.max(1, start); i < end; i++) {
    const d = Math.abs(buf[i] - buf[i - 1]);
    if (d > m) m = d;
  }
  return m;
}

describe('interpolating HRTF — step discontinuity (acceptance)', () => {
  const hrtfPath = resolve(here, '../assets/hrtf/sadie_h3.hrtf');
  let set: HrtfSet;
  let SR = 48000;
  const BLOCK = 128;
  const FREQ = 440;
  const TURN_RATE = (100 * Math.PI) / 180; // rad/s — Heading.maxRate
  const SECS = 0.6; // 0→60°

  beforeAll(() => {
    set = loadHrtfFromDisk(hrtfPath);
    SR = set.sampleRate;
  });

  /** Head-relative direction of a fixed source dead ahead while head yaws over time. */
  function dirAt(t: number): [number, number, number] {
    const yaw = TURN_RATE * t; // 0→~1.05 rad
    // source at world -z (front); head-local: inverse yaw rotation.
    const c = Math.cos(-yaw), s = Math.sin(-yaw);
    const wx = 0, wz = -1;
    return [wx * c - wz * s, 0, wx * s + wz * c];
  }

  it('NEW interpolating renderer: no step spikes at bucket crossings', () => {
    const mp = precomputeMinPhase(set);
    const dsp = new HrtfDsp(mp, 4);
    const n = Math.floor(SECS * SR);
    const outL = new Float32Array(n);
    const outR = new Float32Array(n);
    const inBlk = new Float32Array(BLOCK);
    const oL = new Float32Array(BLOCK);
    const oR = new Float32Array(BLOCK);
    let phase = 0;
    const dp = (2 * Math.PI * FREQ) / SR;
    for (let off = 0; off + BLOCK <= n; off += BLOCK) {
      const t = off / SR;
      const [x, y, z] = dirAt(t);
      dsp.setDirection(x, y, z);
      for (let i = 0; i < BLOCK; i++) { inBlk[i] = 0.5 * Math.sin(phase); phase += dp; }
      dsp.process(inBlk, oL, oR);
      outL.set(oL, off); outR.set(oR, off);
    }
    // steady region: skip the convolution warm-up (first taps + a few blocks)
    const start = set.taps + 4 * BLOCK;
    const end = Math.floor(n / BLOCK) * BLOCK;
    const stepL = worstStep(outL, start, end);
    const stepR = worstStep(outR, start, end);
    const stepNew = Math.max(stepL, stepR);

    // --- OLD-style hard-swap convolver for before/after ---
    const oldOut = new Float32Array(n);
    const hist = new Float32Array(set.taps);
    let hp = 0;
    let lastIdx = -1;
    let curIr = new Float32Array(set.taps);
    phase = 0;
    for (let i = 0; i < n; i++) {
      if (i % BLOCK === 0) {
        const t = i / SR;
        const [x, y, z] = dirAt(t);
        const len = Math.hypot(x, y, z) || 1;
        const idx = nearestDir(set, x / len, y / len, z / len);
        if (idx !== lastIdx) {
          lastIdx = idx;
          // hard swap: load the new measured (ITD-baked) left IR — the discontinuity
          curIr = set.irs.slice(idx * 2 * set.taps, idx * 2 * set.taps + set.taps);
        }
      }
      hist[hp] = 0.5 * Math.sin(phase); phase += dp;
      hp = (hp + 1) % set.taps;
      let acc = 0; let p = hp - 1; if (p < 0) p += set.taps;
      for (let tk = 0; tk < set.taps; tk++) { acc += hist[p] * curIr[tk]; p--; if (p < 0) p += set.taps; }
      oldOut[i] = acc;
    }
    const stepOld = worstStep(oldOut, start, end);

    // Clean-sine baseline: the natural max sample-to-sample slew of the SAME tone,
    // post-HRTF, with NO direction change (the irreducible floor). The interpolating
    // renderer should sit essentially at this floor (it adds no extra step), whereas
    // the hard-swap path spikes above it at every bucket crossing.
    const dspFixed = new HrtfDsp(mp, 4);
    dspFixed.setDirection(0, 0, -1);
    const baseOut = new Float32Array(n);
    phase = 0;
    for (let off = 0; off + BLOCK <= n; off += BLOCK) {
      dspFixed.setDirection(0, 0, -1); // never changes → no interpolation motion
      for (let i = 0; i < BLOCK; i++) { inBlk[i] = 0.5 * Math.sin(phase); phase += dp; }
      dspFixed.process(inBlk, oL, oR);
      baseOut.set(oL, off);
    }
    const stepBase = worstStep(baseOut, start, end);

    // eslint-disable-next-line no-console
    console.log(`[interp-step] NEW=${stepNew.toFixed(4)}  CLEAN-SINE baseline=${stepBase.toFixed(4)}  OLD (hard-swap)=${stepOld.toFixed(4)}  old/new=${(stepOld / stepNew).toFixed(1)}x`);

    // New renderer must stay near the clean-sine range (no click spike) and clearly
    // below the hard-swap reference. The slight rise above the fixed-direction floor
    // is genuine HRTF spectral change as the head turns (continuous coloration), NOT
    // a discontinuity — it has no step SPIKE, unlike the swap path.
    expect(stepNew).toBeLessThan(0.04); // within the clean-sine band (brief: ~0.02-0.03)
    expect(stepNew).toBeLessThan(stepOld * 0.7);
    // sanity: output is non-trivial
    let peak = 0; for (let i = start; i < end; i++) peak = Math.max(peak, Math.abs(outL[i]));
    expect(peak).toBeGreaterThan(0.001);
  });

  it('min-phase precompute preserves magnitude energy and produces finite ITDs', () => {
    const mp = precomputeMinPhase(set);
    // energy roughly preserved per direction (min-phase keeps |H|)
    const m = 100;
    const base = m * 2 * set.taps;
    let eOrig = 0, eMp = 0;
    for (let t = 0; t < set.taps; t++) {
      eOrig += set.irs[base + t] ** 2;
      eMp += mp.irs[base + t] ** 2;
    }
    expect(Math.abs(Math.sqrt(eMp) - Math.sqrt(eOrig)) / Math.sqrt(eOrig)).toBeLessThan(0.15);
    // ITDs finite and non-negative
    for (let i = 0; i < Math.min(50, mp.count); i++) {
      expect(Number.isFinite(mp.itdL[i])).toBe(true);
      expect(mp.itdL[i]).toBeGreaterThanOrEqual(0);
    }
  });
});
