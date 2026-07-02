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
import { personalizeMinPhase, personalizePcaMinPhase, isNeutral, pcaIsNeutral, type HrtfPersonalization } from './personalize';
import { loadPcaModel, type HrtfPcaModel } from './hrtfPca';
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
  /** Current (possibly personalized) min-phase table handed to NEW sources' worklets. */
  mp: MinPhaseHrtf;
  /** Un-warped base table, kept so live re-personalization starts from clean data. */
  private readonly baseMp: MinPhaseHrtf;
  readonly maxDelaySec: number;
  /** Live sources, so `setPersonalization` can hot-swap every worklet's HRIR table
   *  WITHOUT creating new nodes (rebuilding nodes leaked processors on the audio thread). */
  private readonly sources = new Set<InterpolatingHrtfSource>();
  private listener: ListenerPose = { x: 0, y: 1.6, z: 0, yaw: 0 };
  private _speedOfSound = DEFAULT_SPEED_OF_SOUND;
  private moduleReady: Promise<void>;
  /** Cached CIPIC PCA model (loaded on the async build when weights are used), so the
   *  synchronous live setPersonalization can apply the PCA morph without re-fetching. */
  private pcaModel: HrtfPcaModel | null = null;

  get speedOfSound(): number { return this._speedOfSound; }
  setSpeedOfSound(c: number) { if (c > 0 && Number.isFinite(c)) this._speedOfSound = c; }

  private constructor(ctx: BaseAudioContext, set: HrtfSet, mp: MinPhaseHrtf, baseMp: MinPhaseHrtf, maxDelaySec: number, moduleReady: Promise<void>) {
    this.ctx = ctx;
    this.set = set;
    this.mp = mp;
    this.baseMp = baseMp;
    this.maxDelaySec = maxDelaySec;
    this.moduleReady = moduleReady;
  }

  /**
   * LIVE re-personalization: re-warp from the pristine base table and post the new
   * HRIR table to every existing source's worklet (reusing the nodes). This is the
   * leak-free way to drive the free-play "knobs" — no new AudioWorkletNodes.
   */
  setPersonalization(p: HrtfPersonalization) {
    this.mp = this.warp(p);
    for (const s of this.sources) s.updateMp(this.mp);
  }

  /** Compose the parametric warp with the PCA magnitude morph (when weights + a cached
   *  model are present). Pure over baseMp; returns baseMp itself when fully neutral. */
  private warp(p: HrtfPersonalization): MinPhaseHrtf {
    if (isNeutral(p)) return this.baseMp;
    // The parametric front/back cue (applyFrontBackCue, tuned by frontBackTilt) and the
    // data-driven front/back CONTRAST PCs (tuned by their own PCA weights) are INDEPENDENT
    // knobs that compose additively — same hemisphere sign (tanh(−z·3)), no double-apply or
    // cancellation (review-confirmed). They are NOT coupled: the parametric cue is the proven
    // strong cue, the FB PC a small refinement on top; each is optimized on its own by the
    // A/B search.
    let mp = personalizeMinPhase(this.baseMp, p);
    if (this.pcaModel && !pcaIsNeutral(p.pcaWeights)) {
      mp = personalizePcaMinPhase(mp, this.pcaModel, p.pcaWeights!, p.frontBackBias ?? 0);
    }
    return mp;
  }

  /** Ensure the PCA model is loaded + cached, then (re)apply the given personalization
   *  so a live preview picks up PCA weights. Safe no-op if the asset is missing. */
  async ensurePcaAndApply(p: HrtfPersonalization): Promise<void> {
    if (!this.pcaModel) this.pcaModel = await loadPcaModel();
    this.setPersonalization(p);
  }

  /** @internal — sources register/unregister so setPersonalization can reach them. */
  _register(s: InterpolatingHrtfSource) { this.sources.add(s); }
  _unregister(s: InterpolatingHrtfSource) { this.sources.delete(s); }

  static async create(
    ctx: AudioContext,
    hrtfUrl: string,
    opts: { maxDelaySec?: number; k?: number; personalize?: HrtfPersonalization } = {},
  ): Promise<InterpolatingHrtfRenderer> {
    const set = await loadHrtf(hrtfUrl);
    return InterpolatingHrtfRenderer.fromSetAsync(ctx, set, opts);
  }

  /**
   * Build from an already-loaded set; adds the worklet module. When
   * `opts.personalize` is supplied and non-neutral, the baked min-phase set is
   * warped (ITD scale + elevation/front-back tilt) toward the listener's own ears
   * before it reaches the worklet — see personalize.ts. Zero runtime cost: the
   * warp happens once here, not per audio block.
   */
  static async fromSetAsync(
    ctx: BaseAudioContext,
    set: HrtfSet,
    opts: { maxDelaySec?: number; k?: number; personalize?: HrtfPersonalization } = {},
  ): Promise<InterpolatingHrtfRenderer> {
    const baseMp = precomputeMinPhase(set);
    const p = opts.personalize;
    // Load the PCA model up front only when the personalization actually uses it.
    const pcaModel = p && !pcaIsNeutral(p.pcaWeights) ? await loadPcaModel() : null;
    let mp = baseMp;
    if (p && !isNeutral(p)) {
      // Parametric front/back cue + FB contrast PCs are independent, additive knobs (see warp()).
      mp = personalizeMinPhase(baseMp, p);
      if (pcaModel && !pcaIsNeutral(p.pcaWeights)) mp = personalizePcaMinPhase(mp, pcaModel, p.pcaWeights!, p.frontBackBias ?? 0);
    }
    const ready = (ctx as any).audioWorklet.addModule(WORKLET_URL);
    const r = new InterpolatingHrtfRenderer(ctx, set, mp, baseMp, opts.maxDelaySec ?? DEFAULT_MAX_DELAY_SEC, ready);
    r.pcaModel = pcaModel;
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

    r._register(this);
  }

  /** Hot-swap this source's HRIR table in place (no new node). Used by the
   *  renderer's live setPersonalization so the knobs don't leak worklets. */
  updateMp(mp: MinPhaseHrtf) {
    this.node.port.postMessage({ type: 'mp', mp });
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

    // Inverse-distance law on AMPLITUDE (1/r), clamped to unity within 1 m. Web Audio
    // gain scales pressure amplitude, and intensity ∝ amplitude², so 1/r on amplitude IS
    // the inverse-SQUARE law for intensity (−6 dB per distance doubling). Using 1/r² here
    // would wrongly double-attenuate (−12 dB/doubling).
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
    this.r._unregister(this);
    try { this.input.disconnect(); } catch { /* noop */ }
    try { this.propDelay.disconnect(); } catch { /* noop */ }
    try { this.distanceGain.disconnect(); } catch { /* noop */ }
    try { this.airLowpass.disconnect(); } catch { /* noop */ }
    try { this.output.disconnect(); } catch { /* noop */ }
    try { this.node.disconnect(); } catch { /* noop */ }
  }
}
