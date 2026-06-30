/**
 * MEASUREMENT (not an assertion-driven change): is clapRoom.ts's ~10 ms noise
 * probe masking the echo of a NEAR wall?
 *
 * An audio specialist claimed the ~10 ms decaying-noise burst in ClapRoom.clap()
 * masks the echo of any wall closer than ~1.7 m (round-trip 2·1.7/343 ≈ 10 ms),
 * hurting the near-wall distance drill. The user is skeptical: a real mouth click
 * is a short EMITTED pulse but the LISTENED percept (click + its echoes) is long,
 * and shortening the probe risks a thin/weak excitation.
 *
 * So we MEASURE rather than blindly shorten. For a single hard wall directly
 * ahead at 0.5 / 1.0 / 1.5 / 3.0 m we:
 *   1. build the room's MONO early impulse response (the taps' arrival times —
 *      tail off, no HRTF coloration needed for a timing question),
 *   2. CONVOLVE it with each candidate probe (current 10 ms decaying noise vs a
 *      windowed ~2 ms short click), and
 *   3. find the wall echo (the late, distant tap — NOT the direct/t≈0 tap) and
 *      compare its peak to the probe-excited energy of the DIRECT sound still
 *      ringing at that same instant ("probe tail" at the echo time).
 *
 * The reported number is the ECHO-TO-PROBE-TAIL ratio (dB) at the echo's arrival:
 * high (echo ≫ residual probe tail) → the echo is a distinguishable peak; low
 * (echo buried in the still-decaying probe) → masking. We print both candidates
 * at every distance so the verdict rests on numbers, not assertion.
 *
 * Needs the WASM acoustics core (room taps); inits it exactly like
 * audioArtifacts.test.ts. If node-web-audio-api is missing we still run, because
 * we don't need an AudioContext — only the pure tap+IR build and a hand-rolled
 * convolution.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { HrtfSet } from '../src/engine/hrtf/sofa';
import { sphericalToVec } from '../src/engine/hrtf/sofa';
import { computeRoomTaps, type Tap } from '../src/engine/acoustics/core';
import { buildRoomIr } from '../src/engine/acoustics/roomIr';
import { MATERIALS } from '../src/engine/acoustics/materials';

const here = dirname(fileURLToPath(import.meta.url));
const SR = 48000;
const C = 343; // speed of sound (m/s)

/** Parse the baked .hrtf binary from disk (mirrors audioArtifacts.test.ts). */
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

// --- Probe excitations (mirror clapRoom.ts shapes) ---------------------------

/** CURRENT probe: ~10 ms decaying noise, env = (1 - i/n)^2. */
function currentProbe(durSec = 0.01): Float32Array {
  const n = Math.ceil(durSec * SR);
  const b = new Float32Array(n);
  // Deterministic PRNG so the measurement is reproducible.
  let s = 12345;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  for (let i = 0; i < n; i++) {
    const env = 1 - i / n;
    b[i] = (rnd() * 2 - 1) * env * env;
  }
  return b;
}

/** CANDIDATE short probe: ~2 ms Hann-windowed noise burst (sharp but energetic). */
function shortProbe(durSec = 0.002): Float32Array {
  const n = Math.ceil(durSec * SR);
  const b = new Float32Array(n);
  let s = 12345;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)); // Hann
    b[i] = (rnd() * 2 - 1) * w;
  }
  return b;
}

/** Direct linear convolution (small signals; fine for a one-off measurement). */
function convolve(x: Float32Array, h: Float32Array): Float32Array {
  const out = new Float32Array(x.length + h.length - 1);
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    if (xi === 0) continue;
    for (let j = 0; j < h.length; j++) out[i + j] += xi * h[j];
  }
  return out;
}

/** Peak |·| in a sample window [a,b). */
function peak(buf: Float32Array, a: number, b: number): number {
  let m = 0;
  for (let i = Math.max(0, a); i < Math.min(buf.length, b); i++) m = Math.max(m, Math.abs(buf[i]));
  return m;
}

// --- Geometry: one hard wall directly ahead (engine front = -z) --------------

/** A ~1 m double-sided concrete panel `dist` m ahead of the listener at center. */
function aheadPanelWalls(center: [number, number, number], dist: number) {
  const [lx, , lz] = center;
  const cx = lx, cz = lz - dist; // front = -z
  const h = 0.5;
  const ey = 1.6;
  // Panel face perpendicular to listener→panel (which is -z), so it spans x and y.
  const v = (sx: number, sy: number): [number, number, number] => [cx + sx, ey + sy, cz];
  return [{
    verts: [v(-h, -h), v(h, -h), v(h, h), v(-h, h)] as Array<[number, number, number]>,
    absorption: [...MATERIALS.concrete],
    doubleSided: true,
  }];
}

describe('probe masking measurement (single wall ahead)', () => {
  let hrtf: HrtfSet;

  beforeAll(async () => {
    const hrtfPath = resolve(here, '../assets/hrtf/sadie_h3.hrtf');
    hrtf = loadHrtfFromDisk(hrtfPath);
    const { initAcoustics } = await import('../src/engine/acoustics/core');
    const wasmDir = resolve(here, '../src/engine/acoustics/wasm');
    const mod = await import(resolve(wasmDir, 'acoustics_core.js'));
    const bytes = readFileSync(resolve(wasmDir, 'acoustics_core_bg.wasm'));
    await mod.default(bytes);
    await initAcoustics().catch(() => {});
  });

  it('reports echo-to-probe-tail ratio at near distances for both probes', () => {
    const distances = [0.5, 1.0, 1.5, 3.0];
    // Reuse the distance drill's room: big absorbent box, listener centred.
    const center: [number, number, number] = [8, 1.6, 8];

    const current = currentProbe(0.01);
    const short = shortProbe(0.002);

    // eslint-disable-next-line no-console
    console.log(
      '\n[probeMasking] wall directly ahead. echo round-trip Δt = 2·d/343.\n' +
      'ratio = echo-peak / probe-energy-still-ringing-at-echo-time (dB); higher = more separable.',
    );

    for (const d of distances) {
      const walls = aheadPanelWalls(center, d);
      const taps: Tap[] = computeRoomTaps({
        walls,
        listener: center,
        source: center,
        maxOrder: 1,
      });
      // Mono early IR (timing only): tail off, no yaw. We collapse the stereo IR
      // to mono (L+R) — the question is "when does energy arrive", not "where".
      const ir = buildRoomIr(taps, hrtf, { tail: false });
      const mono = new Float32Array(ir.length);
      for (let i = 0; i < ir.length; i++) mono[i] = ir.left[i] + ir.right[i];

      const expectedDt = (2 * d) / C; // s
      const echoSample = Math.round(expectedDt * SR);

      // The room IR itself: where is the echo tap vs the direct tap?
      // Direct path length ≈ 0 (source==listener) → tap near t=0; echo near 2d/c.
      const dtMs = expectedDt * 1000;

      for (const [name, probe] of [['current(10ms)', current], ['short(2ms)', short]] as const) {
        const y = convolve(mono, probe);
        // Window around the echo arrival (±0.5 ms) for its peak.
        const win = Math.round(0.0005 * SR);
        const echoPeak = peak(y, echoSample - win, echoSample + win);
        // "Probe tail at the echo time": how much of the DIRECT sound's probe is
        // STILL ringing when the echo arrives. The direct burst starts at the
        // direct tap (~t0). We measure residual probe-driven energy in the same
        // ±0.5 ms window but ONLY from the direct excitation — approximated by the
        // probe's own amplitude at sample-offset echoSample (its decay tail),
        // scaled by the direct tap's gain (the t≈0 IR peak).
        const directPeak = peak(mono, 0, win * 2);
        // Residual probe amplitude at the echo offset (the masking tail).
        const tailAmp = echoSample < probe.length
          ? peak(probe, echoSample - win, echoSample + win) * directPeak
          : 0;
        const ratioDb = tailAmp > 0
          ? 20 * Math.log10(echoPeak / tailAmp)
          : Infinity; // probe already silent by echo time → no masking at all
        // eslint-disable-next-line no-console
        console.log(
          `  d=${d.toFixed(1)}m Δt=${dtMs.toFixed(1)}ms  ${name.padEnd(13)}  ` +
          `echoPeak=${echoPeak.toExponential(2)}  probeTail=${tailAmp.toExponential(2)}  ` +
          `ratio=${ratioDb === Infinity ? 'inf (probe over)' : ratioDb.toFixed(1) + ' dB'}`,
        );
        // Sanity: there IS a measurable echo at every distance for both probes.
        expect(echoPeak).toBeGreaterThan(0);
      }
    }
  });
});
