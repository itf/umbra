/**
 * Reflecting footsteps: spatializes a footstep from the FOOT's landing position
 * (not the head) and convolves it through the room IR, so each step's echo reveals
 * the surrounding walls and any openings (a doorway gap) — the same "hear the room"
 * cue as the clap, but driven by your own gait.
 *
 * Unlike the clap (a deliberate one-shot at the head) footsteps fire ~1-2×/s from a
 * moving offset source, so this:
 *   - builds the IR with `source` = the foot's world position, `listener` = the head,
 *   - THROTTLES the (relatively expensive) IR rebuild: a step landing within
 *     `minIntervalMs` of the last reuses the previous IR (the foot moved <1 stride,
 *     so the reflection field is essentially unchanged) — synthesis still fires every
 *     step, only the room solve is rate-limited,
 *   - keeps a low `maxOrder` (early reflections carry the size/opening cue; the long
 *     tail does not), so the per-step cost stays near a single clap.
 *
 * The dry footstep voice is synthesized by the caller (see game/footsteps.ts): we
 * hand it the convolver INPUT to connect into, so synthesis stays in one place.
 */
import type { AudioGraph } from '../audioGraph';
import type { HrtfRenderer } from '../hrtf/renderer';
import { computeRoomTaps, type WallDef, type EdgeDef } from './core';
import { buildRoomIr } from './roomIr';
import { wallsRoom } from './clapRoom';

export interface FootstepRoomBuild {
  walls: WallDef[];
  /** Head/ear position. */
  listener: [number, number, number];
  /** Foot landing position (the sound's origin). */
  source: [number, number, number];
  /** Head yaw (radians). */
  yaw: number;
  edges?: EdgeDef[];
  maxOrder?: number;
  scattering?: number;
  speedOfSound?: number;
}

/** One room-IR convolver chain + its crossfade gain. */
interface FootChain {
  convolver: ConvolverNode;
  gain: GainNode;
}

export class FootstepRoom {
  private graph: AudioGraph;
  private renderer: HrtfRenderer;
  /** DUAL convolvers, crossfaded on each rebuild so swapping the IR never clicks. */
  private chains: [FootChain, FootChain];
  private active = 0;
  private wet: GainNode;

  // Throttle + dirty-check for the IR rebuild.
  private lastBuildMs = 0;
  private lastSig = '';
  private lastFadeT = 0;
  private built = false;

  constructor(graph: AudioGraph, renderer: HrtfRenderer) {
    this.graph = graph;
    this.renderer = renderer;
    const ctx = graph.ctx;
    this.wet = ctx.createGain();
    this.wet.gain.value = 1.0;
    this.wet.connect(graph.master);

    const makeChain = (): FootChain => {
      const convolver = ctx.createConvolver();
      convolver.normalize = false;
      const gain = ctx.createGain();
      convolver.connect(gain).connect(this.wet);
      return { convolver, gain };
    };
    this.chains = [makeChain(), makeChain()];
    this.chains[0].gain.gain.value = 1;
    this.chains[1].gain.gain.value = 0;
  }

  /**
   * Ensure the room IR is current for this pose (rebuilds at most every
   * `minIntervalMs`, and only when the quantised pose/source signature changed),
   * then return the convolver INPUT the caller should synthesize the dry footstep
   * into. Returns the currently-active convolver so the voice always lands on the
   * audible chain.
   */
  voice(build: FootstepRoomBuild, minIntervalMs = 90): AudioNode {
    this.maybeRebuild(build, minIntervalMs);
    return this.chains[this.active].convolver;
  }

  private maybeRebuild(b: FootstepRoomBuild, minIntervalMs: number) {
    const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    // Quantise pose+source to ~0.25 m / coarse yaw so micro-moves don't churn the IR.
    const q = (v: number) => Math.round(v * 4) / 4;
    const sig = [
      q(b.listener[0]), q(b.listener[2]),
      q(b.source[0]), q(b.source[1]), q(b.source[2]),
      Math.round((b.yaw % (Math.PI * 2)) * 8),
    ].join(',');
    if (this.built && (nowMs - this.lastBuildMs < minIntervalMs || sig === this.lastSig)) return;
    this.lastBuildMs = nowMs;
    this.lastSig = sig;

    const taps = computeRoomTaps({
      walls: b.walls,
      edges: b.edges,
      listener: b.listener,
      source: b.source,
      maxOrder: b.maxOrder ?? 1,
      speedOfSound: b.speedOfSound,
    });
    const ir = buildRoomIr(taps, this.renderer.set, {
      yaw: b.yaw,
      scattering: b.scattering ?? 0.1,
      room: wallsRoom(b.walls, b.listener),
    });
    this.swapIr(ir);
  }

  /** Load a freshly-built stereo IR into the idle chain and crossfade to it. */
  private swapIr(ir: { left: Float32Array; right: Float32Array; length: number; sampleRate: number }) {
    const ctx = this.graph.ctx;
    const buf = ctx.createBuffer(2, ir.length, ir.sampleRate);
    buf.getChannelData(0).set(ir.left);
    buf.getChannelData(1).set(ir.right);

    if (!this.built) {
      this.chains[this.active].convolver.buffer = buf;
      this.built = true;
      return;
    }
    const t = ctx.currentTime;
    const FADE = 0.08;
    const idle = this.active ^ 1;
    if (t - this.lastFadeT < FADE) {
      this.chains[idle].convolver.buffer = buf;
      return;
    }
    this.chains[idle].convolver.buffer = buf;
    this.chains[idle].gain.gain.cancelScheduledValues(t);
    this.chains[this.active].gain.gain.cancelScheduledValues(t);
    this.chains[idle].gain.gain.setTargetAtTime(1, t, FADE / 3);
    this.chains[this.active].gain.gain.setTargetAtTime(0, t, FADE / 3);
    this.active = idle;
    this.lastFadeT = t;
  }
}
