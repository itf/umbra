/**
 * Binaural HRTF rendering of positioned mono sources, replacing PannerNode.
 *
 * Each source feeds two ConvolverNodes (left/right ear) whose buffers are the
 * HRIR pair for the source's current direction relative to the listener's head.
 * The convolver outputs are panned hard-left / hard-right and summed → true
 * binaural. When the source moves enough to change the nearest measured
 * direction, we crossfade to a fresh pair of convolvers to avoid clicks.
 *
 * Distance is handled before the HRTF (gain ~1/r + a lowpass for air absorption),
 * since the HRIR encodes direction, not distance.
 */

import { getIrPair, loadHrtf, nearestDir, type HrtfSet } from './sofa';
import { DEFAULT_SPEED_OF_SOUND } from '../acoustics/core';
import { DEFAULT_MAX_DELAY_SEC, propagationDelaySec, clampDelaySec } from './propagation';
import { linearCrossfade } from '../crossfade';

export interface ListenerPose {
  x: number;
  y: number;
  z: number;
  /** Heading in radians, 0 = facing -z (front), increasing turns left (toward +x... see note). */
  yaw: number;
}

/** Rotate a world-space offset into head-local space given listener yaw (around +y). */
function worldToHead(dx: number, dy: number, dz: number, yaw: number): [number, number, number] {
  // Yaw rotates the listener's facing in the xz-plane. To express a world offset
  // in head-local coords we apply the inverse rotation.
  const c = Math.cos(-yaw);
  const s = Math.sin(-yaw);
  const x = dx * c - dz * s;
  const z = dx * s + dz * c;
  return [x, dy, z];
}

export class HrtfRenderer {
  readonly ctx: AudioContext;
  readonly set: HrtfSet;
  private listener: ListenerPose = { x: 0, y: 1.6, z: 0, yaw: 0 };

  /**
   * Speed of sound (m/s) used to turn distance into a propagation delay
   * (`delay = dist / speedOfSound`). Shared default with the acoustics core so a
   * single value governs both the baked room IR timing and live-source lag.
   * Change it via `setSpeedOfSound` (guarded to stay positive) to make sources
   * arrive sooner/later — subsequent `setPosition` calls pick it up. Read via the
   * `speedOfSound` getter.
   */
  private _speedOfSound = DEFAULT_SPEED_OF_SOUND;

  /** Current speed of sound (m/s). */
  get speedOfSound(): number {
    return this._speedOfSound;
  }

  /** Max delay each source's DelayNode is allocated; caps the farthest honest lag. */
  readonly maxDelaySec: number;

  private constructor(ctx: AudioContext, set: HrtfSet, maxDelaySec: number) {
    this.ctx = ctx;
    this.set = set;
    this.maxDelaySec = maxDelaySec;
  }

  /** Set the speed of sound; affects propagation delay on the next `setPosition`. */
  setSpeedOfSound(c: number) {
    if (c > 0 && Number.isFinite(c)) this._speedOfSound = c;
  }

  static async create(
    ctx: AudioContext,
    hrtfUrl: string,
    opts: { maxDelaySec?: number } = {},
  ): Promise<HrtfRenderer> {
    const set = await loadHrtf(hrtfUrl);
    if (set.sampleRate !== ctx.sampleRate) {
      // Convolver uses buffer's own rate via resampling on decode; we build the
      // AudioBuffer at the HRIR's native rate and the graph resamples. Warn only.
      console.warn(
        `HRTF sampleRate ${set.sampleRate} != ctx ${ctx.sampleRate}; convolution buffers will be created at HRIR rate.`,
      );
    }
    return new HrtfRenderer(ctx, set, opts.maxDelaySec ?? DEFAULT_MAX_DELAY_SEC);
  }

  /**
   * Build a renderer from an ALREADY-LOADED HrtfSet (no fetch). Used by the
   * offline-render artifact tests, which read the .hrtf from disk and render
   * inside a Node OfflineAudioContext. Mirrors `create` minus the network load.
   */
  static fromSet(ctx: AudioContext, set: HrtfSet, opts: { maxDelaySec?: number } = {}): HrtfRenderer {
    return new HrtfRenderer(ctx, set, opts.maxDelaySec ?? DEFAULT_MAX_DELAY_SEC);
  }

  setListener(pose: ListenerPose) {
    this.listener = pose;
  }

  /** Build an AudioBuffer (stereo: ch0=left IR, ch1=right IR) for a direction index. */
  private bufferForDir(index: number): AudioBuffer {
    const { left, right } = getIrPair(this.set, index);
    const buf = this.ctx.createBuffer(2, this.set.taps, this.set.sampleRate);
    // Copy out of the shared backing buffer into the channel-owned arrays.
    buf.getChannelData(0).set(left);
    buf.getChannelData(1).set(right);
    return buf;
  }

  /**
   * Create a positioned source. Returns a handle whose `input` you connect your
   * sound into, and which you reposition via `setPosition`. Connect `output` to
   * your master bus.
   */
  createSource(): HrtfSource {
    return new HrtfSource(this);
  }

  /** Nearest HRIR direction index for a world position, given current listener pose. */
  dirIndexFor(x: number, y: number, z: number): number {
    const dx = x - this.listener.x;
    const dy = y - this.listener.y;
    const dz = z - this.listener.z;
    const [hx, hy, hz] = worldToHead(dx, dy, dz, this.listener.yaw);
    const len = Math.hypot(hx, hy, hz) || 1;
    return nearestDir(this.set, hx / len, hy / len, hz / len);
  }

  distanceTo(x: number, y: number, z: number): number {
    return Math.hypot(x - this.listener.x, y - this.listener.y, z - this.listener.z);
  }

  makeConvolverBuffer(index: number): AudioBuffer {
    return this.bufferForDir(index);
  }
}

/** One convolver chain: convolver → splitter → merger → gain (its crossfade level). */
interface ConvChain {
  convolver: ConvolverNode;
  gain: GainNode;
}

/**
 * A single positioned binaural source.
 *
 *   input → propDelay → distanceGain → airLowpass → [chainA, chainB] → output
 *
 * `propDelay` is a variable DelayNode set to `distance / speedOfSound`: sound takes
 * time to arrive, and when the source moves the delay changes smoothly, so the
 * DelayNode resamples and produces DOPPLER for free (approaching = higher pitch).
 * See docs/engine/doppler-and-propagation-delay.md.
 *
 * Swapping a ConvolverNode's buffer mid-signal produces an audible CLICK, which
 * was very noticeable while turning (the direction index changes constantly).
 * To avoid it we keep TWO convolver chains and crossfade between them on each
 * direction change: load the new HRIR into the idle chain, then ramp one gain up and
 * the other down over a few milliseconds (a LINEAR sum-to-1 fade — see crossfade.ts
 * for why linear, not equal-power, is correct for these correlated chains). The
 * result is smooth and never overshoots full-scale on fast turns.
 */
export class HrtfSource {
  readonly input: GainNode; // connect your audio here
  readonly output: GainNode; // connect to master
  private propDelay: DelayNode;
  private distanceGain: GainNode;
  private airLowpass: BiquadFilterNode;
  /** The currently-audible chain (fully faded in). Null until first placement. */
  private current: ConvChain | null = null;
  /** A chain mid-fade-in, plus when its fade completes (so we don't stack swaps and
   *  so we know when the displaced `current` can be disposed). Null when settled. */
  private fading: { chain: ConvChain; doneAt: number; prev: ConvChain | null } | null = null;
  private lastDirIndex = -1;
  private placed = false; // has setPosition run at least once (delay snap vs ramp)
  private r: HrtfRenderer;

  constructor(r: HrtfRenderer) {
    this.r = r;
    const ctx = r.ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.propDelay = ctx.createDelay(r.maxDelaySec);
    this.distanceGain = ctx.createGain();
    this.airLowpass = ctx.createBiquadFilter();
    this.airLowpass.type = 'lowpass';
    this.airLowpass.frequency.value = 20000;

    this.input.connect(this.propDelay);
    this.propDelay.connect(this.distanceGain);
    this.distanceGain.connect(this.airLowpass);

    // Chains are created lazily on first placement (a fresh node per direction swap),
    // so nothing is wired until setPosition runs.
  }

  /**
   * Build a fully-formed chain for `buf` and connect it. CRITICAL: the convolver's
   * `.buffer` is set BEFORE it is wired into the live `airLowpass` feed, so the
   * convolution never undergoes a mid-stream buffer RESET (reloading a live
   * ConvolverNode's `.buffer` drops/discontinues a frame of audio — the "square-wave
   * front" click heard when crossing HRIR direction buckets). A fresh node per swap
   * starts clean; the old one is faded out and disposed.
   */
  private makeChain(buf: AudioBuffer | null, initialGain: number): ConvChain {
    const ctx = this.r.ctx;
    const convolver = ctx.createConvolver();
    convolver.normalize = false;
    if (buf) convolver.buffer = buf; // set buffer BEFORE connecting (no live reset)
    // The convolver's two output channels ARE the two ears (our buffer packs L in
    // ch0, R in ch1); route each straight through to the matching output channel.
    const splitter = ctx.createChannelSplitter(2);
    const merger = ctx.createChannelMerger(2);
    const gain = ctx.createGain();
    gain.gain.value = initialGain;
    convolver.connect(splitter);
    splitter.connect(merger, 0, 0);
    splitter.connect(merger, 1, 1);
    merger.connect(gain);
    gain.connect(this.output);
    this.airLowpass.connect(convolver); // connect to the live feed LAST
    return { convolver, gain };
  }

  /** Disconnect + drop a chain's nodes (after its fade-out completes). */
  private disposeChain(chain: ConvChain) {
    try { this.airLowpass.disconnect(chain.convolver); } catch { /* already gone */ }
    try { chain.gain.disconnect(); } catch { /* already gone */ }
  }

  setPosition(x: number, y: number, z: number) {
    const ctx = this.r.ctx;
    const dist = this.r.distanceTo(x, y, z);

    // Propagation delay: sound takes dist/c to arrive. Ramp the delayTime smoothly
    // toward the target so the DelayNode resamples ⇒ Doppler emerges from the
    // modulation (the physically-correct path; we do NOT compute a separate detune).
    // Tuning: DOPPLER_TAU is the setTargetAtTime time-constant. SHORT ⇒ delay tracks
    // motion tightly ⇒ strong Doppler, but too short risks zipper/click artifacts;
    // LONG ⇒ smooth but the pitch shift washes out. ~0.05 s is the sweet spot.
    const DOPPLER_TAU = 0.05;
    const delaySec = clampDelaySec(
      propagationDelaySec(dist, this.r.speedOfSound),
      this.r.maxDelaySec,
    );
    if (!this.placed) {
      // First placement: snap the delay so we don't hear it swoop in from zero.
      this.propDelay.delayTime.setValueAtTime(delaySec, ctx.currentTime);
    } else {
      this.propDelay.delayTime.setTargetAtTime(delaySec, ctx.currentTime, DOPPLER_TAU);
    }
    this.placed = true;

    // 1/r distance law, clamped near the head; reference distance 1m.
    const g = 1 / Math.max(1, dist);
    this.distanceGain.gain.setTargetAtTime(g, ctx.currentTime, 0.02);

    // Air absorption: distant sources lose highs. Map distance → cutoff.
    const cutoff = Math.max(1500, 20000 - dist * 900);
    this.airLowpass.frequency.setTargetAtTime(cutoff, ctx.currentTime, 0.05);

    const idx = this.r.dirIndexFor(x, y, z);
    if (idx === this.lastDirIndex || idx < 0) return;
    this.lastDirIndex = idx;

    const t = ctx.currentTime;
    const FADE = 0.04; // 40 ms

    // Retire a completed fade-in: its `prev` chain is fully silent now → dispose it,
    // and the faded-in chain becomes `current`.
    if (this.fading && t >= this.fading.doneAt) {
      if (this.fading.prev) this.disposeChain(this.fading.prev);
      this.current = this.fading.chain;
      this.fading = null;
    }

    const buf = this.r.makeConvolverBuffer(idx);

    if (!this.current && !this.fading) {
      // First placement: a single chain at full gain, no crossfade.
      this.current = this.makeChain(buf, 1);
      return;
    }

    // RATE-LIMIT: if a fade is still in flight, DON'T start another (stacking fades
    // thrashes the gains). Drop this update; the next direction change after the fade
    // settles picks up the latest pose.
    if (this.fading) return;

    // FRESH-NODE crossfade. Build a brand-new chain with `buf` already loaded BEFORE
    // it's wired to the live feed — so the new convolution starts clean with no
    // mid-stream buffer RESET (the reset was the "square-wave front" click). Fade the
    // new chain in from 0 and the current chain out to 0 (linear sum-to-1: the two
    // HRIR chains carry the SAME source at adjacent directions, so amplitudes add).
    const incoming = this.makeChain(buf, 0);
    const outgoing = this.current!;
    linearCrossfade(incoming.gain.gain, outgoing.gain.gain, t, FADE);
    this.fading = { chain: incoming, doneAt: t + FADE, prev: outgoing };
    this.current = null; // `outgoing` lives on as fading.prev until the fade completes
  }

  disconnect() {
    this.output.disconnect();
  }
}
