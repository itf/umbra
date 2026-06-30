/**
 * OBJECTIVE binaural measurement of OUR engine (HrtfSource): render a steady tone
 * from a fixed world position and, at several listener yaws + a moved position,
 * measure ITD (interaural time diff via cross-correlation) and ILD (level diff).
 * Confirms the cue CHANGES with where the listener looks, and by how much — the
 * reference our Steam path should match or beat.
 *
 * Steam Audio CANNOT be measured here (needs the AudioWorklet + WASM + cross-origin
 * isolation, none under vitest) — this is our-engine only. Run with:
 *   npx vitest run tests/measureSpatial.test.ts
 * The numbers print via console.log (the assertions just guard the cue exists).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { HrtfSet } from '../src/engine/hrtf/sofa';
import { sphericalToVec } from '../src/engine/hrtf/sofa';

const here = dirname(fileURLToPath(import.meta.url));
let OfflineAudioContext: any = null;
try { ({ OfflineAudioContext } = await import('node-web-audio-api')); } catch { /* skip */ }

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

const run = OfflineAudioContext ? describe : describe.skip;

run('our-engine binaural cue measurement', () => {
  let hrtf: HrtfSet;
  let SR: number;
  const FREQ = 440;
  const SECS = 0.5;

  beforeAll(() => {
    hrtf = loadHrtfFromDisk(resolve(here, '../assets/hrtf/sadie_h3.hrtf'));
    SR = hrtf.sampleRate;
  });

  function itdSamples(left: Float32Array, right: Float32Array): number {
    const maxLag = Math.ceil(0.001 * SR);
    const start = Math.floor(left.length * 0.5);
    const n = Math.min(4096, left.length - start - maxLag - 1);
    let bestLag = 0, bestCorr = -Infinity;
    for (let lag = -maxLag; lag <= maxLag; lag++) {
      let c = 0;
      for (let i = 0; i < n; i++) c += left[start + i] * right[start + i + lag];
      if (c > bestCorr) { bestCorr = c; bestLag = lag; }
    }
    return bestLag; // +ve ⇒ right lags left ⇒ source on the LEFT
  }
  function rms(ch: Float32Array): number {
    const start = Math.floor(ch.length * 0.5);
    let s = 0, n = 0;
    for (let i = start; i < ch.length; i++) { s += ch[i] * ch[i]; n++; }
    return Math.sqrt(s / n);
  }

  async function measure(src: [number, number, number], lis: [number, number, number], yaw: number) {
    const { HrtfRenderer } = await import('../src/engine/hrtf/renderer');
    const ctx = new OfflineAudioContext(2, Math.floor(SECS * SR), SR);
    const r = HrtfRenderer.fromSet(ctx, hrtf);
    r.setListener({ x: lis[0], y: lis[1], z: lis[2], yaw });
    const s = r.createSource();
    const osc = ctx.createOscillator();
    osc.frequency.value = FREQ;
    osc.connect(s.input);
    s.output.connect(ctx.destination);
    osc.start();
    s.setPosition(src[0], src[1], src[2]);
    const buf = await ctx.startRendering();
    const left = buf.getChannelData(0), right = buf.getChannelData(1);
    const itd = itdSamples(left, right);
    const lRms = rms(left), rRms = rms(right);
    const ildDb = 20 * Math.log10((lRms + 1e-9) / (rRms + 1e-9));
    return { itdMs: (itd / SR) * 1000, ildDb };
  }

  it('ITD/ILD vary with head yaw toward a 5 m beacon, and with a move', async () => {
    const beacon: [number, number, number] = [0, 1.6, -5]; // 5 m straight ahead (-z)
    const lis: [number, number, number] = [0, 1.6, 0];
    const rows: Array<{ deg: number; itdMs: number; ildDb: number }> = [];
    for (const deg of [-90, -45, -20, 0, 20, 45, 90]) {
      const m = await measure(beacon, lis, (deg * Math.PI) / 180);
      rows.push({ deg, ...m });
    }
    // eslint-disable-next-line no-console
    console.log('\nOUR ENGINE — 440Hz beacon 5 m ahead, vs head yaw');
    // eslint-disable-next-line no-console
    console.log('yaw°   ITD(ms)  ILD(dB)   (+ITD ⇒ source LEFT; +ILD ⇒ left louder)');
    for (const r of rows) {
      // eslint-disable-next-line no-console
      console.log(`${String(r.deg).padStart(4)}   ${r.itdMs.toFixed(3).padStart(7)}  ${r.ildDb.toFixed(2).padStart(7)}`);
    }
    // The cue MUST change with yaw: facing right (yaw +90) puts the ahead beacon on
    // your LEFT (+ITD/+ILD); facing left (−90) puts it on your right (−ITD/−ILD).
    const right90 = rows.find((r) => r.deg === 90)!;
    const left90 = rows.find((r) => r.deg === -90)!;
    const ahead = rows.find((r) => r.deg === 0)!;
    expect(Math.abs(ahead.itdMs)).toBeLessThan(0.1); // ~centered when faced
    expect(right90.itdMs).toBeGreaterThan(left90.itdMs + 0.1); // monotonic, meaningful swing
    expect(Math.abs(right90.ildDb - left90.ildDb)).toBeGreaterThan(2); // real ILD swing

    const moved = await measure(beacon, [4, 1.6, -1], 0);
    // eslint-disable-next-line no-console
    console.log(`\nMOVED to (4,*,-1) facing forward → ITD ${moved.itdMs.toFixed(3)} ms, ILD ${moved.ildDb.toFixed(2)} dB (beacon now front-left ⇒ +)`);
    expect(moved.itdMs).toBeGreaterThan(0.05); // beacon to the left of the moved listener
  });
});
