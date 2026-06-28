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

  private constructor(ctx: AudioContext, set: HrtfSet) {
    this.ctx = ctx;
    this.set = set;
  }

  static async create(ctx: AudioContext, hrtfUrl: string): Promise<HrtfRenderer> {
    const set = await loadHrtf(hrtfUrl);
    if (set.sampleRate !== ctx.sampleRate) {
      // Convolver uses buffer's own rate via resampling on decode; we build the
      // AudioBuffer at the HRIR's native rate and the graph resamples. Warn only.
      console.warn(
        `HRTF sampleRate ${set.sampleRate} != ctx ${ctx.sampleRate}; convolution buffers will be created at HRIR rate.`,
      );
    }
    return new HrtfRenderer(ctx, set);
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
 *   input → distanceGain → airLowpass → [chainA, chainB] → output
 *
 * Swapping a ConvolverNode's buffer mid-signal produces an audible CLICK, which
 * was very noticeable while turning (the direction index changes constantly).
 * To avoid it we keep TWO convolver chains and equal-power crossfade between them
 * on each direction change: load the new HRIR into the idle chain, then ramp one
 * gain up and the other down over a few milliseconds. The result is smooth.
 */
export class HrtfSource {
  readonly input: GainNode; // connect your audio here
  readonly output: GainNode; // connect to master
  private distanceGain: GainNode;
  private airLowpass: BiquadFilterNode;
  private chains: [ConvChain, ConvChain];
  private active = 0; // index of the currently-audible chain
  private lastDirIndex = -1;
  private lastSwapTime = 0; // audio-clock time of the last committed crossfade
  private r: HrtfRenderer;

  constructor(r: HrtfRenderer) {
    this.r = r;
    const ctx = r.ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.distanceGain = ctx.createGain();
    this.airLowpass = ctx.createBiquadFilter();
    this.airLowpass.type = 'lowpass';
    this.airLowpass.frequency.value = 20000;

    this.input.connect(this.distanceGain);
    this.distanceGain.connect(this.airLowpass);

    this.chains = [this.makeChain(), this.makeChain()];
    // Start with chain 0 audible, chain 1 silent.
    this.chains[0].gain.gain.value = 1;
    this.chains[1].gain.gain.value = 0;
  }

  private makeChain(): ConvChain {
    const ctx = this.r.ctx;
    const convolver = ctx.createConvolver();
    convolver.normalize = false;
    // The convolver's two output channels ARE the two ears (our buffer packs L in
    // ch0, R in ch1); route each straight through to the matching output channel.
    const splitter = ctx.createChannelSplitter(2);
    const merger = ctx.createChannelMerger(2);
    const gain = ctx.createGain();
    this.airLowpass.connect(convolver);
    convolver.connect(splitter);
    splitter.connect(merger, 0, 0);
    splitter.connect(merger, 1, 1);
    merger.connect(gain);
    gain.connect(this.output);
    return { convolver, gain };
  }

  setPosition(x: number, y: number, z: number) {
    const ctx = this.r.ctx;
    const dist = this.r.distanceTo(x, y, z);
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
    const buf = this.r.makeConvolverBuffer(idx);

    if (this.chains[this.active].convolver.buffer == null) {
      // First placement: load directly into the active chain, no crossfade needed.
      this.chains[this.active].convolver.buffer = buf;
      this.lastSwapTime = t;
      return;
    }

    // RATE-LIMIT swaps. During a fast spin the direction index changes many times
    // per frame; starting a fresh crossfade each time thrashes the gains (the
    // "fart" sound). If we're still inside the previous fade window, just refresh
    // the chain that's already fading IN to the newest direction — no new ramp,
    // no swap. Only commit a real crossfade once the prior one has settled.
    const FADE = 0.04; // 40 ms
    const idle = this.active ^ 1;
    if (t - this.lastSwapTime < FADE) {
      // Update the incoming chain's buffer in place; its gain ramp continues.
      this.chains[idle].convolver.buffer = buf;
      return;
    }

    this.chains[idle].convolver.buffer = buf;
    // Equal-power-ish crossfade via setTargetAtTime time-constants.
    this.chains[idle].gain.gain.cancelScheduledValues(t);
    this.chains[this.active].gain.gain.cancelScheduledValues(t);
    this.chains[idle].gain.gain.setTargetAtTime(1, t, FADE / 3);
    this.chains[this.active].gain.gain.setTargetAtTime(0, t, FADE / 3);
    this.active = idle;
    this.lastSwapTime = t;
  }

  disconnect() {
    this.output.disconnect();
  }
}
