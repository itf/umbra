/**
 * AUDIO-ARTIFACT + CLIPPING harness.
 *
 * The rest of the suite asserts on IRs and physics, but it can't catch RUNTIME
 * audio-thread artifacts (clicks/zipper/crackle from buffer swaps, delay ramps,
 * gain jumps) or destination clipping, because vitest has no Web Audio. This
 * suite closes that gap: it builds the REAL engine graph (HrtfRenderer +
 * HrtfSource, ClapRoom dual-convolver path, the master limiter) inside a Node
 * `OfflineAudioContext` from `node-web-audio-api`, renders STRESS scenarios, and
 * runs the pure artifact detectors (src/engine/analysis/artifacts.ts) on the
 * Float32 output.
 *
 * If `node-web-audio-api` can't load on this platform, the offline-render block
 * is skipped with a clear message (CI stays green); the synthetic-signal unit
 * tests for the detectors still run.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { HrtfSet } from '../src/engine/hrtf/sofa';
import { sphericalToVec } from '../src/engine/hrtf/sofa';
import {
  detectClicks,
  detectClicksStereo,
  clipCount,
} from '../src/engine/analysis/artifacts';

const here = dirname(fileURLToPath(import.meta.url));

// ---- Try to load node-web-audio-api; skip the render block gracefully if not. ----
let OfflineAudioContext: any = null;
let importError = '';
try {
  ({ OfflineAudioContext } = await import('node-web-audio-api'));
} catch (e) {
  importError = (e as Error).message;
}

/** Parse the baked .hrtf binary from disk (mirrors spatial.test.ts). */
function loadHrtfFromDisk(path: string): HrtfSet {
  const data = readFileSync(path);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = 4 + 4; // magic + version
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

// =====================================================================
// PART 1 — pure detector calibration on synthetic signals (always runs)
// =====================================================================
describe('artifact detectors (synthetic)', () => {
  const SR = 48000;

  function sine(freq: number, secs: number, amp = 0.8): Float32Array {
    const n = Math.floor(secs * SR);
    const b = new Float32Array(n);
    for (let i = 0; i < n; i++) b[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
    return b;
  }

  it('a clean sine is NOT flagged as clicky', () => {
    const r = detectClicks(sine(1000, 0.2));
    expect(r.count).toBe(0);
    expect(r.maxRatio).toBeLessThan(8);
  });

  it('an equal-power crossfade between two sines is NOT flagged', () => {
    // Crossfade two correlated 1 kHz tones over 40 ms — the legitimate case the
    // renderer uses. Must PASS (no false alarm).
    const a = sine(1000, 0.2, 0.8);
    const b = sine(1000, 0.2, 0.8);
    const out = new Float32Array(a.length);
    const start = Math.floor(0.05 * SR);
    const fade = Math.floor(0.04 * SR);
    for (let i = 0; i < out.length; i++) {
      let t = (i - start) / fade;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ga = Math.cos((t * Math.PI) / 2);
      const gb = Math.sin((t * Math.PI) / 2);
      out[i] = ga * a[i] + gb * b[i];
    }
    const r = detectClicks(out);
    expect(r.count).toBe(0);
    expect(r.maxRatio).toBeLessThan(8);
  });

  it('an injected click IS flagged', () => {
    // A buffer-swap click is a sharp transient against the surrounding signal.
    const b = sine(1000, 0.2, 0.3);
    b[5000] = 1.0; // sharp out-of-trend spike
    b[5001] = -0.9;
    const r = detectClicks(b);
    expect(r.count).toBeGreaterThan(0);
    expect(r.maxRatio).toBeGreaterThan(8);
    expect(Math.abs(r.atSample - 5000)).toBeLessThanOrEqual(1);
  });

  it('clipCount finds out-of-bounds samples', () => {
    const b = new Float32Array([0.5, 1.2, -1.5, 0.9, -0.99]);
    expect(clipCount(b)).toBe(2);
    expect(clipCount(b, 1.3)).toBe(1);
  });
});

// =====================================================================
// PART 2 — real offline-render stress scenarios
// =====================================================================
const hrtfPath = resolve(here, '../assets/hrtf/sadie_h3.hrtf');
const renderDescribe = OfflineAudioContext ? describe : describe.skip;
if (!OfflineAudioContext) {
  // eslint-disable-next-line no-console
  console.warn(
    `[audioArtifacts] node-web-audio-api unavailable (${importError}); ` +
      'skipping offline-render stress scenarios. Synthetic detector tests still ran.',
  );
}

renderDescribe('offline-render stress scenarios', () => {
  let hrtf: HrtfSet;
  // Detector tuned a touch looser than synthetic because the convolver's HRIR
  // tail + delay resampling add legitimate high-slope content; a TRUE swap click
  // is many times larger so this still catches real artifacts.
  const CLICK_OPTS = { threshold: 25 };

  beforeAll(async () => {
    hrtf = loadHrtfFromDisk(hrtfPath);
    // Room-tap/IR build runs in WASM; init it from disk bytes AND wire the
    // core's binding via initAcoustics (as movingWalls.test.ts). Skipping the
    // latter leaves computeRoomTaps pointing at an uninitialized instance.
    const { initAcoustics } = await import('../src/engine/acoustics/core');
    const wasmDir = resolve(here, '../src/engine/acoustics/wasm');
    const mod = await import(resolve(wasmDir, 'acoustics_core.js'));
    const bytes = readFileSync(resolve(wasmDir, 'acoustics_core_bg.wasm'));
    await mod.default(bytes);
    await initAcoustics().catch(() => {});
  });

  // Helper: render an offline ctx while injecting timed callbacks (pose updates).
  async function renderWithSchedule(
    secs: number,
    sr: number,
    build: (ctx: any) => void,
    steps: Array<{ at: number; fn: () => void }>,
  ): Promise<{ left: Float32Array; right: Float32Array; ms: number }> {
    const ctx = new OfflineAudioContext(2, Math.floor(secs * sr), sr);
    build(ctx);
    // suspend() times must land on a 128-sample render-quantum boundary and be
    // strictly increasing; quantize and de-dup.
    const Q = 128 / sr;
    let lastQ = -1;
    for (const s of steps) {
      let at = Math.round(s.at / Q) * Q;
      if (at <= lastQ) at = lastQ + Q;
      if (at >= secs) break;
      lastQ = at;
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      ctx
        .suspend(at)
        .then(() => {
          s.fn();
          // eslint-disable-next-line @typescript-eslint/no-floating-promises
          ctx.resume();
        })
        // A suspend scheduled in the final block can resolve after rendering has
        // already finished → benign InvalidStateError; ignore it.
        .catch(() => {});
    }
    const t0 = (globalThis.performance ?? Date).now?.() ?? Date.now();
    const buf = await ctx.startRendering();
    const t1 = (globalThis.performance ?? Date).now?.() ?? Date.now();
    return {
      left: buf.getChannelData(0),
      right: buf.getChannelData(1),
      ms: t1 - t0,
    };
  }

  // A steady tone source feeding an HrtfSource — exercises the real graph.
  function buildSourceGraph(ctx: any, r: any) {
    const src = r.createSource();
    const osc = ctx.createOscillator();
    osc.frequency.value = 440;
    const drive = ctx.createGain();
    drive.gain.value = 0.5;
    osc.connect(drive).connect(src.input);
    src.output.connect(ctx.destination);
    osc.start();
    return src;
  }

  it('FAST ROTATION: 720°/s yaw spin produces no click and stays bounded', async () => {
    const { HrtfRenderer } = await import('../src/engine/hrtf/renderer');
    const SECS = 0.5;
    const sr = hrtf.sampleRate;
    let src: any;
    let r: any;
    const steps: Array<{ at: number; fn: () => void }> = [];
    const N = 100; // pose update every 5 ms → > 1 dir change/update at 720°/s
    for (let k = 1; k <= N; k++) {
      const at = (k / N) * SECS;
      steps.push({
        at,
        fn: () => {
          const yaw = (2 * Math.PI * 2) * at; // 720°/s = 2 rev/s
          r.setListener({ x: 0, y: 1.6, z: 0, yaw });
          src.setPosition(0, 1.6, -3); // fixed source ahead
        },
      });
    }
    const out = await renderWithSchedule(SECS, sr, (ctx) => {
      r = HrtfRenderer.fromSet(ctx, hrtf);
      src = buildSourceGraph(ctx, r);
      src.setPosition(0, 1.6, -3);
    }, steps);

    const click = detectClicksStereo(out.left, out.right, CLICK_OPTS);
    expect(click.count).toBe(0);
    expect(Math.max(...[out.left, out.right].map((c) => Math.max(...c.map(Math.abs))))).toBeLessThan(4);
    // eslint-disable-next-line no-console
    console.log(`[rotation] maxRatio=${click.maxRatio.toFixed(1)} renderMs=${out.ms.toFixed(1)}`);
  });

  it('FAST WALKING: source whips past the listener, delay ramps hard, no click + bounded', async () => {
    const { HrtfRenderer } = await import('../src/engine/hrtf/renderer');
    const SECS = 0.5;
    const sr = hrtf.sampleRate;
    let src: any;
    let r: any;
    const steps: Array<{ at: number; fn: () => void }> = [];
    const N = 100;
    for (let k = 1; k <= N; k++) {
      const at = (k / N) * SECS;
      steps.push({
        at,
        fn: () => {
          // Source flies from z=-10 to z=+10 across the head over 0.5 s (40 m/s).
          const z = -10 + 20 * (at / SECS);
          src.setPosition(0.2, 1.6, z);
        },
      });
    }
    const out = await renderWithSchedule(SECS, sr, (ctx) => {
      r = HrtfRenderer.fromSet(ctx, hrtf);
      r.setListener({ x: 0, y: 1.6, z: 0, yaw: 0 });
      src = buildSourceGraph(ctx, r);
      src.setPosition(0.2, 1.6, -10);
    }, steps);

    const click = detectClicksStereo(out.left, out.right, CLICK_OPTS);
    expect(click.count).toBe(0);
    expect(clipCount(out.left, 4)).toBe(0);
    // eslint-disable-next-line no-console
    console.log(`[walking] maxRatio=${click.maxRatio.toFixed(1)} renderMs=${out.ms.toFixed(1)}`);
  });

  it('ROOM IR SWAP: repeated dual-convolver IR crossfades do not click', async () => {
    const { HrtfRenderer } = await import('../src/engine/hrtf/renderer');
    const { ClapRoom } = await import('../src/engine/acoustics/clapRoom');
    const { makeLimiter, makeSafetyClip } = await import('../src/engine/audioGraph');
    const { boxRoomWalls } = await import('../src/level/load');
    const SECS = 0.4;
    const sr = hrtf.sampleRate;
    let clap: any;
    const steps: Array<{ at: number; fn: () => void }> = [];
    // Build a moving-wall room signature stream: walls shrink over time.
    const N = 12;
    for (let k = 1; k <= N; k++) {
      const at = (k / N) * SECS;
      steps.push({
        at,
        fn: () => {
          const size = 8 - 4 * (at / SECS); // box shrinks 8m → 4m
          const walls = boxRoomWalls([size, 3, size], 'concrete');
          clap.updateGeneralRoom(walls, [size / 2, 1.6, size / 2], 0, { scattering: 0.2 });
          if (k % 6 === 0) clap.clap();
        },
      });
    }
    const out = await renderWithSchedule(SECS, sr, (ctx) => {
      const master = ctx.createGain();
      const limiter = makeLimiter(ctx);
      const safetyClip = makeSafetyClip(ctx);
      master.connect(limiter).connect(safetyClip).connect(ctx.destination);
      const graph = { ctx, master, limiter, safetyClip } as any;
      const r = HrtfRenderer.fromSet(ctx, hrtf);
      clap = new ClapRoom(graph, r);
      clap.clap();
    }, steps);

    const click = detectClicksStereo(out.left, out.right, CLICK_OPTS);
    expect(click.count).toBe(0);
    // eslint-disable-next-line no-console
    console.log(`[roomswap] maxRatio=${click.maxRatio.toFixed(1)} renderMs=${out.ms.toFixed(1)}`);
  });

  it('LIMITER: summed loud sources clip WITHOUT limiter, stay in [-1,1] WITH it', async () => {
    const { makeLimiter, makeSafetyClip } = await import('../src/engine/audioGraph');
    const SECS = 0.3;
    const sr = 48000;

    function buildLoud(ctx: any, useLimiter: boolean) {
      const master = ctx.createGain();
      master.gain.value = 0.9;
      let tail: any = master;
      if (useLimiter) {
        const lim = makeLimiter(ctx);
        const safety = makeSafetyClip(ctx);
        master.connect(lim).connect(safety);
        tail = safety;
      }
      tail.connect(ctx.destination);
      // Four loud tones summing well past full scale.
      for (let i = 0; i < 4; i++) {
        const o = ctx.createOscillator();
        o.frequency.value = 220 + i * 110;
        const g = ctx.createGain();
        g.gain.value = 0.7;
        o.connect(g).connect(master);
        o.start();
      }
    }

    // Without limiter → should clip.
    const noLim = new OfflineAudioContext(1, Math.floor(SECS * sr), sr);
    buildLoud(noLim, false);
    const rawBuf = await noLim.startRendering();
    const raw = rawBuf.getChannelData(0);
    expect(clipCount(raw)).toBeGreaterThan(0); // proves the limiter has work to do

    // With limiter → no clipping.
    const withLim = new OfflineAudioContext(1, Math.floor(SECS * sr), sr);
    buildLoud(withLim, true);
    const limBuf = await withLim.startRendering();
    const lim = limBuf.getChannelData(0);
    expect(clipCount(lim)).toBe(0);
    // eslint-disable-next-line no-console
    console.log(
      `[limiter] rawClipped=${clipCount(raw)} limitedClipped=${clipCount(lim)} ` +
        `rawPeak=${Math.max(...raw.map(Math.abs)).toFixed(2)} limPeak=${Math.max(...lim.map(Math.abs)).toFixed(3)}`,
    );
  });
});
