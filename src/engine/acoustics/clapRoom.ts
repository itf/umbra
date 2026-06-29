/**
 * "Clap to hear the room": computes the room impulse response for the listener's
 * current position via the WASM acoustics core, then plays a short impulsive
 * sound (a clap) convolved through it. The early reflections you hear encode the
 * room's size and materials — the core echolocation cue.
 */
import type { AudioGraph } from '../audioGraph';
import type { HrtfRenderer } from '../hrtf/renderer';
import { computeShoeboxTaps, computeRoomTaps, type ShoeboxParams, type WallDef, type EdgeDef } from './core';
import { buildRoomIr } from './roomIr';
import { scatteringFor } from './materials';

/** Average mid-band scattering across a room's assigned wall materials. */
function representativeScattering(params: ShoeboxParams): number {
  const mats = Object.values(params.materials);
  if (mats.length === 0) return 0.1;
  let sum = 0;
  for (const m of mats) sum += scatteringFor(m as string)[4]; // ~1kHz band
  return sum / mats.length;
}

export interface ClapRoomConfig {
  room: ShoeboxParams; // listener/source filled per-clap from pose
  maxOrder?: number;
}

/** One room-IR convolver chain + its crossfade gain. */
interface RoomChain {
  convolver: ConvolverNode;
  gain: GainNode;
}

export class ClapRoom {
  private graph: AudioGraph;
  private renderer: HrtfRenderer;
  /**
   * DUAL convolvers, equal-power crossfaded — the same trick `renderer.ts` uses for
   * moving sources. Swapping a single ConvolverNode's `buffer` mid-signal CLICKS
   * (the in-flight tail jumps). With moving walls the room IR is rebuilt many times
   * a second, so we load each new IR into the idle chain and ramp across.
   */
  private chains: [RoomChain, RoomChain];
  private active = 0;
  private wet: GainNode;
  /** The clap excitation feeds whichever convolver(s) are live. */
  private clapBus: GainNode;

  // --- live (moving-walls) throttle + dirty-check state ---
  private lastBuildMs = 0;
  private lastSig = '';
  private lastFadeT = 0;

  constructor(graph: AudioGraph, renderer: HrtfRenderer) {
    this.graph = graph;
    this.renderer = renderer;
    const ctx = graph.ctx;
    this.wet = ctx.createGain();
    this.wet.gain.value = 1.0;
    this.wet.connect(graph.master);
    this.clapBus = ctx.createGain();

    const makeChain = (): RoomChain => {
      const convolver = ctx.createConvolver();
      convolver.normalize = false;
      const gain = ctx.createGain();
      this.clapBus.connect(convolver);
      convolver.connect(gain).connect(this.wet);
      return { convolver, gain };
    };
    this.chains = [makeChain(), makeChain()];
    this.chains[0].gain.gain.value = 1;
    this.chains[1].gain.gain.value = 0;
  }

  /** Load a freshly-built stereo IR into the idle chain and crossfade to it. The
   *  first ever IR loads straight into the active chain (no audible swap). */
  private swapIr(ir: { left: Float32Array; right: Float32Array; length: number; sampleRate: number }) {
    const ctx = this.graph.ctx;
    const buf = ctx.createBuffer(2, ir.length, ir.sampleRate);
    buf.getChannelData(0).set(ir.left);
    buf.getChannelData(1).set(ir.right);

    if (this.chains[this.active].convolver.buffer == null) {
      this.chains[this.active].convolver.buffer = buf;
      return;
    }
    const t = ctx.currentTime;
    const FADE = 0.08; // 80 ms equal-power-ish crossfade
    const idle = this.active ^ 1;
    // Rate-limit: if still mid-fade, just refresh the incoming buffer (no new ramp).
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

  /**
   * Recompute the room IR for the given shoebox + current listener pose/heading.
   * Call when the room or listener position changes; cheap enough to call on
   * each clap.
   */
  updateRoom(params: ShoeboxParams, yaw: number) {
    const taps = computeShoeboxTaps(params);
    const ir = buildRoomIr(taps, this.renderer.set, {
      yaw,
      scattering: representativeScattering(params),
    });
    this.swapIr(ir);
  }

  /**
   * Recompute the room IR from GENERAL geometry — an arbitrary wall list (+ edges)
   * at the current listener position. This is what the game uses, so open levels,
   * interior walls, stepped ceilings, and (future) MOVING walls all produce correct
   * echoes: the caller just passes the live wall list each clap.
   *
   * `scattering` is the representative coefficient for the surfaces in play (the
   * caller knows the materials; WallDefs only carry absorption).
   */
  updateGeneralRoom(
    walls: WallDef[],
    listener: [number, number, number],
    yaw: number,
    opts: { edges?: EdgeDef[]; maxOrder?: number; scattering?: number } = {},
  ) {
    const taps = computeRoomTaps({
      walls,
      edges: opts.edges,
      listener,
      source: listener, // clap originates at the head
      maxOrder: opts.maxOrder ?? 2,
    });
    const ir = buildRoomIr(taps, this.renderer.set, {
      yaw,
      scattering: opts.scattering ?? 0.1,
    });
    this.swapIr(ir);
  }

  /**
   * LIVE room update for MOVING walls. Drives the AMBIENT room response
   * continuously (not just on clap): rebuilds taps + IR and crossfades to it.
   *
   * Two cost guards make this affordable:
   *  - THROTTLE: rebuild at most every `minIntervalMs` (default ~70 ms ≈ 14 Hz),
   *    NOT every animation frame. Even at the 6× WASM build (~10 ms) a per-frame
   *    rebuild would eat the budget; 14 Hz is smooth to the ear yet cheap.
   *  - DIRTY CHECK: skip entirely when `sig` equals the last signature (nothing
   *    moved materially). `sig` keys on the MOVING walls AND the QUANTISED listener
   *    pose, so walking/turning rebuilds the ambient IR for the new pose; a static
   *    level with a stationary listener never rebuilds here.
   *
   * Returns true if it actually rebuilt (useful for tests/telemetry).
   */
  updateLive(
    walls: WallDef[],
    sig: string,
    listener: [number, number, number],
    yaw: number,
    opts: { edges?: EdgeDef[]; maxOrder?: number; scattering?: number; minIntervalMs?: number } = {},
  ): boolean {
    const nowMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const minInterval = opts.minIntervalMs ?? 70;
    if (nowMs - this.lastBuildMs < minInterval) return false;
    if (sig === this.lastSig) return false; // nothing moved
    this.lastBuildMs = nowMs;
    this.lastSig = sig;

    const taps = computeRoomTaps({
      walls,
      edges: opts.edges,
      listener,
      source: listener,
      maxOrder: opts.maxOrder ?? 2,
    });
    const ir = buildRoomIr(taps, this.renderer.set, {
      yaw,
      scattering: opts.scattering ?? 0.1,
    });
    this.swapIr(ir);
    return true;
  }

  /** Fire a clap: a few ms of shaped noise through the room IR. */
  clap() {
    const ctx = this.graph.ctx;
    const dur = 0.01;
    const n = Math.ceil(dur * ctx.sampleRate);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) {
      // Short decaying noise burst — broadband impulse to excite all reflections.
      const env = 1 - i / n;
      ch[i] = (Math.random() * 2 - 1) * env * env;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.clapBus); // feeds both convolver chains (crossfaded)
    src.start();
  }
}
