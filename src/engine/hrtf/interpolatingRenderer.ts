/**
 * Click-free interpolating HRTF renderer (AudioWorklet-based).
 *
 * Drop-in alternative to `HrtfRenderer`/`HrtfSource` (renderer.ts) for positioned
 * binaural sources. Unlike the dual-convolver `HrtfSource` — which swaps a fresh
 * ConvolverNode and crossfades on every measured-direction bucket crossing (the
 * onset-transient "square front" CLICK heard while turning) — this renderer runs ONE
 * continuous convolution inside an AudioWorklet and CONTINUOUSLY INTERPOLATES the
 * measured HRIRs (min-phase + ITD) as a function of direction. The IR changes
 * smoothly block-to-block; the convolution state is never reset → no click.
 *
 * Per-source graph (distance/Doppler/air kept as Web Audio nodes BEFORE the worklet,
 * identical behaviour to the old HrtfSource):
 *
 *   input → propDelay → distanceGain → airLowpass → worklet(HRTF) → output
 *
 * The worklet does ONLY the directional HRTF. Direction is posted to the worklet on
 * every `setPosition`. HRIR data is transferred once at init via processorOptions
 * (no SharedArrayBuffer → no cross-origin isolation requirement).
 */

import { loadHrtf, type HrtfSet } from './sofa';
import { precomputeMinPhase, type MinPhaseHrtf } from './interpolatingDsp';
import { DEFAULT_SPEED_OF_SOUND } from '../acoustics/core';
import { DEFAULT_MAX_DELAY_SEC, propagationDelaySec, clampDelaySec } from './propagation';
import type { ListenerPose } from './renderer';
import { nearFieldEarGains } from './nearFieldIld';

// The worklet is pre-bundled (esbuild) into `public/hrtf-worklet.js` by the
// `worklet` npm script (run in `dev` and `build`); served verbatim by Vite in dev
// and copied to dist/ on build. Loaded via BASE_URL so it resolves under any base
// path. (Vite's `new URL('./x.ts', import.meta.url)` inlines the worklet as a raw,
// un-transpiled data: URL that fails to load — hence the pre-bundle.)
const WORKLET_URL =
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.BASE_URL
    ? (import.meta as any).env.BASE_URL
    : '/') + 'hrtf-worklet.js';

function worldToHead(dx: number, dy: number, dz: number, yaw: number): [number, number, number] {
  const c = Math.cos(-yaw);
  const s = Math.sin(-yaw);
  return [dx * c - dz * s, dy, dx * s + dz * c];
}

export class InterpolatingHrtfRenderer {
  readonly ctx: BaseAudioContext;
  readonly set: HrtfSet;
  readonly mp: MinPhaseHrtf;
  readonly maxDelaySec: number;
  private listener: ListenerPose = { x: 0, y: 1.6, z: 0, yaw: 0 };
  private _speedOfSound = DEFAULT_SPEED_OF_SOUND;
  private moduleReady: Promise<void>;

  get speedOfSound(): number { return this._speedOfSound; }
  setSpeedOfSound(c: number) { if (c > 0 && Number.isFinite(c)) this._speedOfSound = c; }

  private constructor(ctx: BaseAudioContext, set: HrtfSet, mp: MinPhaseHrtf, maxDelaySec: number, moduleReady: Promise<void>) {
    this.ctx = ctx;
    this.set = set;
    this.mp = mp;
    this.maxDelaySec = maxDelaySec;
    this.moduleReady = moduleReady;
  }

  static async create(
    ctx: AudioContext,
    hrtfUrl: string,
    opts: { maxDelaySec?: number; k?: number } = {},
  ): Promise<InterpolatingHrtfRenderer> {
    const set = await loadHrtf(hrtfUrl);
    return InterpolatingHrtfRenderer.fromSetAsync(ctx, set, opts);
  }

  /** Build from an already-loaded set; adds the worklet module. */
  static async fromSetAsync(
    ctx: BaseAudioContext,
    set: HrtfSet,
    opts: { maxDelaySec?: number; k?: number } = {},
  ): Promise<InterpolatingHrtfRenderer> {
    const mp = precomputeMinPhase(set);
    const ready = (ctx as any).audioWorklet.addModule(WORKLET_URL);
    const r = new InterpolatingHrtfRenderer(ctx, set, mp, opts.maxDelaySec ?? DEFAULT_MAX_DELAY_SEC, ready);
    await ready;
    return r;
  }

  setListener(pose: ListenerPose) { this.listener = pose; }

  headDir(x: number, y: number, z: number): [number, number, number] {
    const dx = x - this.listener.x;
    const dy = y - this.listener.y;
    const dz = z - this.listener.z;
    return worldToHead(dx, dy, dz, this.listener.yaw);
  }

  distanceTo(x: number, y: number, z: number): number {
    return Math.hypot(x - this.listener.x, y - this.listener.y, z - this.listener.z);
  }

  createSource(k = 4): InterpolatingHrtfSource {
    return new InterpolatingHrtfSource(this, k);
  }

  get whenReady(): Promise<void> { return this.moduleReady; }
}

/** A single positioned binaural source rendered by the interpolating worklet. */
export class InterpolatingHrtfSource {
  readonly input: GainNode;
  readonly output: GainNode;
  private propDelay: DelayNode;
  private distanceGain: GainNode;
  private airLowpass: BiquadFilterNode;
  private node: AudioWorkletNode;
  private placed = false;
  private r: InterpolatingHrtfRenderer;

  constructor(r: InterpolatingHrtfRenderer, k: number) {
    this.r = r;
    const ctx = r.ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.propDelay = ctx.createDelay(r.maxDelaySec);
    this.distanceGain = ctx.createGain();
    this.airLowpass = ctx.createBiquadFilter();
    this.airLowpass.type = 'lowpass';
    this.airLowpass.frequency.value = 20000;

    // structured-clone the (large) min-phase data into the worklet once.
    this.node = new (globalThis as any).AudioWorkletNode(ctx, 'hrtf-interpolating', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 1,
      channelCountMode: 'explicit',
      processorOptions: { mp: r.mp, k },
    });

    this.input.connect(this.propDelay);
    this.propDelay.connect(this.distanceGain);
    this.distanceGain.connect(this.airLowpass);
    this.airLowpass.connect(this.node);
    this.node.connect(this.output);
  }

  setPosition(x: number, y: number, z: number) {
    const ctx = this.r.ctx;
    const dist = this.r.distanceTo(x, y, z);
    const DOPPLER_TAU = 0.05;
    const delaySec = clampDelaySec(propagationDelaySec(dist, this.r.speedOfSound), this.r.maxDelaySec);
    if (!this.placed) {
      this.propDelay.delayTime.setValueAtTime(delaySec, ctx.currentTime);
    } else {
      this.propDelay.delayTime.setTargetAtTime(delaySec, ctx.currentTime, DOPPLER_TAU);
    }
    this.placed = true;

    const g = 1 / Math.max(1, dist);
    this.distanceGain.gain.setTargetAtTime(g, ctx.currentTime, 0.02);
    const cutoff = Math.max(1500, 20000 - dist * 900);
    this.airLowpass.frequency.setTargetAtTime(cutoff, ctx.currentTime, 0.05);

    const [hx, hy, hz] = this.r.headDir(x, y, z);
    this.node.port.postMessage({ type: 'dir', x: hx, y: hy, z: hz });

    // NEAR-FIELD per-ear ILD. `headDir` returns the UN-normalized head-relative offset
    // (it carries distance), so it's the source position in head space. nearFieldEarGains
    // returns each ear's r_ref/r_ear CORRECTION ratio (≈1 at the 1.2 m measurement shell,
    // <1 farther — removing the residual the far-field HRTF baked in, >1 nearer — the
    // near-field boost). It multiplies the existing mono distanceGain (the common 1/r term)
    // in the worklet's L/R output, so a source close to one ear is dramatically louder in
    // that ear. Head-occlusion ILD is untouched (it lives in the HRTF, direction-based).
    const ear = nearFieldEarGains({ x: hx, y: hy, z: hz });
    this.node.port.postMessage({ type: 'earGains', left: ear.left, right: ear.right });
  }

  disconnect() {
    try { this.output.disconnect(); } catch { /* noop */ }
    try { this.node.disconnect(); } catch { /* noop */ }
  }
}
