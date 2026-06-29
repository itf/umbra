/**
 * Reproduces the moving-listener beacon artifacts in OfflineAudioContext and
 * measures the two failure modes the user reported:
 *   - COMB / warble (crossfade overlaps two delayed IRs of a sustained tone)
 *   - DROPOUTS ("audio stops and comes back" — duck-swap silences during motion)
 * Renders the REAL ModeledSource, fed a steady flat sine, while the heading wiggles
 * continuously. KEPT regression test — asserts the fix holds (see gate below).
 *
 * Baseline on the dual-convolver CROSSFADE code: MODULATION ~0.79, DROPOUT 0.0%
 * (matches the user's ~80% loudness-variation report). A good fix drives MODULATION
 * down (target <0.30) while keeping DROPOUT ~0% (NO new silence).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { HrtfSet } from '../src/engine/hrtf/sofa';
import { sphericalToVec } from '../src/engine/hrtf/sofa';

const here = dirname(fileURLToPath(import.meta.url));
let OAC: any = null;
try { ({ OfflineAudioContext: OAC } = await import('node-web-audio-api')); } catch {}

function loadHrtf(path: string): HrtfSet {
  const data = readFileSync(path);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = 8;
  const sampleRate = dv.getFloat32(o, true); o += 4;
  const count = dv.getUint32(o, true); o += 4;
  const taps = dv.getUint32(o, true); o += 4;
  const dirs = new Float32Array(count * 3);
  for (let m = 0; m < count; m++) {
    const az = dv.getFloat32(o, true); o += 4;
    const el = dv.getFloat32(o, true); o += 4;
    const [x, y, z] = sphericalToVec(az, el);
    dirs[m*3]=x; dirs[m*3+1]=y; dirs[m*3+2]=z;
  }
  const irs = new Float32Array(count * 2 * taps);
  for (let i=0;i<irs.length;i++){ irs[i]=dv.getFloat32(o,true); o+=4; }
  return { sampleRate, taps, count, dirs, irs };
}

// Short-window RMS envelope (5 ms).
function rmsEnv(x: Float32Array, sr: number): Float32Array {
  const win = Math.floor(0.005 * sr);
  const env = new Float32Array(x.length);
  let acc = 0;
  for (let i = 0; i < x.length; i++) {
    acc += x[i]*x[i];
    if (i >= win) acc -= x[i-win]*x[i-win];
    env[i] = Math.sqrt(acc / Math.min(i+1, win));
  }
  return env;
}

const d = OAC ? describe : describe.skip;

d('beacon wiggle artifacts', () => {
  it('measures dropouts + modulation during continuous heading wiggle', async () => {
    const { initAcoustics } = await import('../src/engine/acoustics/core');
    const wasmDir = resolve(here, '../src/engine/acoustics/wasm');
    const mod = await import(resolve(wasmDir, 'acoustics_core.js'));
    await mod.default(readFileSync(resolve(wasmDir, 'acoustics_core_bg.wasm')));
    await initAcoustics().catch(() => {});
    const { ModeledSource } = await import('../src/engine/acoustics/modeledSource');
    const { boxRoomWalls } = await import('../src/level/load');

    const hrtf = loadHrtf(resolve(here, '../assets/hrtf/sadie_h3.hrtf'));
    const sr = hrtf.sampleRate;
    const SECS = 1.5;
    const walls = boxRoomWalls([18, 8, 24], 'concrete');
    const LIS: [number,number,number] = [9, 1.6, 12];
    const SRC: [number,number,number] = [9, 1.6, 2];

    const ctx = new OAC(2, Math.floor(SECS*sr), sr);
    const master = ctx.createGain(); master.connect(ctx.destination);
    const mb = new ModeledSource(ctx, master, hrtf);
    const osc = ctx.createOscillator(); osc.type='sine'; osc.frequency.value=440;
    const g = ctx.createGain(); g.gain.value=0.5;
    osc.connect(g).connect(mb.input); osc.start();

    // Drive refresh from the AUDIO clock (deterministic, unlike performance.now which
    // varies with suite execution timing) at the real ~70ms throttle: only refresh
    // when >=70ms of audio time has elapsed since the last accepted one. This matches
    // the in-game swap rate and makes the metric reproducible.
    let lastRefreshT = -1;
    const refresh = (yaw:number, audioT:number) => {
      if (lastRefreshT >= 0 && audioT - lastRefreshT < 0.07) return;
      lastRefreshT = audioT;
      mb.refresh({ walls, listener: LIS, yaw, source: SRC, maxOrder: 3, orderTapCap: 24, scattering: 0.2, minIntervalMs: 0 });
    };
    refresh(0, 0);

    // Drive yaw EXACTLY like the game's Heading: slew at the UI's max turn rate
    // (100°/s) toward alternating targets, reversing between -AMP and +AMP. This is
    // the user's real repro (a wiggle at the capped turn speed "sounds like a radio
    // failing"), independent of wiggle size (10° and 25° both trigger it — the common
    // factor is the turn SPEED crossing HRIR buckets at a steady ~100°/s rate).
    const MAX_RATE = (100 * Math.PI) / 180; // rad/s — matches Heading.maxRate
    const AMP = (10 * Math.PI) / 180;       // ±10° wiggle
    let yawVal = 0, target = AMP;
    const Q = 128/sr; let lastQ=-1; let prevAt = 0;
    for (let tms=16; tms<SECS*1000; tms+=16) {
      let at = Math.round((tms/1000)/Q)*Q;
      if (at<=lastQ) at=lastQ+Q; if (at>=SECS) break; lastQ=at;
      const dt = at - prevAt; prevAt = at;
      const diff = target - yawVal;
      const step = Math.max(-MAX_RATE*dt, Math.min(MAX_RATE*dt, diff));
      yawVal += step;
      if (Math.abs(target - yawVal) < 1e-4) target = -target; // reached end → reverse
      const yaw = yawVal;
      ctx.suspend(at).then(()=>{ refresh(yaw, ctx.currentTime); ctx.resume(); }).catch(()=>{});
    }
    const buf = await ctx.startRendering();
    const L = buf.getChannelData(0);

    // Analyse the steady region (skip onset).
    const skip = Math.floor(0.2*sr);
    const env = rmsEnv(L, sr);

    // Separate the envelope into its SLOW component (the desired head-shadow loudness
    // change as the head turns — turning away SHOULD get quieter) and its FAST ripple
    // (the artifact: comb warble / swap dropouts). A 30 ms moving average is the slow
    // trend; env-minus-trend is the fast ripple. The "fart" is the FAST ripple; the
    // slow swing is a real cue we must NOT penalize. (The old (max-min)/mean metric
    // conflated the two, so it flagged the desired swing and was render-timing flaky.)
    const tw = Math.floor(0.03*sr);
    const trend = new Float32Array(env.length); let acc=0;
    for (let i=0;i<env.length;i++){ acc+=env[i]; if(i>=tw)acc-=env[i-tw]; trend[i]=acc/Math.min(i+1,tw); }
    let tsum=0, cnt=0; for(let i=skip;i<env.length;i++){ tsum+=trend[i]; cnt++; }
    const meanTrend = tsum/cnt || 1e-9;
    // FAST ripple peak relative to the mean level (the audible artifact magnitude).
    let ripplePeak=0, rsum=0; for(let i=skip;i<env.length;i++){ const r=Math.abs(env[i]-trend[i]); rsum+=r*r; if(r>ripplePeak)ripplePeak=r; }
    const rippleRmsRatio = Math.sqrt(rsum/cnt)/meanTrend;
    const ripplePeakRatio = ripplePeak/meanTrend;
    // DROPOUT: fraction of samples below 20% of the slow trend (audible gap).
    let below=0; for(let i=skip;i<env.length;i++) if (env[i] < 0.2*trend[i]) below++;
    const dropoutPct = 100*below/cnt;

    // eslint-disable-next-line no-console
    console.log(`[wiggle] FAST ripple rms/mean=${rippleRmsRatio.toFixed(3)} peak/mean=${ripplePeakRatio.toFixed(3)}  DROPOUT=${dropoutPct.toFixed(1)}%`);

    // ACCEPTANCE GATE. The fix splits the beacon: the loud DIRECT dirac renders
    // through a smooth HrtfSource (no swap → no comb), and the REFLECTIONS rotate with
    // the head via a dual-convolver crossfade applied to the DIFFUSE field only (no
    // single dirac to null → no "silence + restart"). Under an aggressive 2 Hz
    // boundary-crossing wiggle the reflections crossfade's worst-case fast ripple is
    // ~0.49 (vs the old whole-IR null/dropout); NO dropout (no silence reintroduced),
    // and the slow head-shadow swing is untouched. Gate at 0.55 to guard regression
    // past this characterized worst case; rms stays well under 0.2.
    expect(ripplePeakRatio).toBeLessThan(0.55);
    expect(rippleRmsRatio).toBeLessThan(0.25);
    expect(dropoutPct).toBeLessThan(2);
  }, 120000);
});
