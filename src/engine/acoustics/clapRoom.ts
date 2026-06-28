/**
 * "Clap to hear the room": computes the room impulse response for the listener's
 * current position via the WASM acoustics core, then plays a short impulsive
 * sound (a clap) convolved through it. The early reflections you hear encode the
 * room's size and materials — the core echolocation cue.
 */
import type { AudioGraph } from '../audioGraph';
import type { HrtfRenderer } from '../hrtf/renderer';
import { computeShoeboxTaps, type ShoeboxParams } from './core';
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

export class ClapRoom {
  private graph: AudioGraph;
  private renderer: HrtfRenderer;
  private convolver: ConvolverNode;
  private wet: GainNode;

  constructor(graph: AudioGraph, renderer: HrtfRenderer) {
    this.graph = graph;
    this.renderer = renderer;
    this.convolver = graph.ctx.createConvolver();
    this.convolver.normalize = false;
    this.wet = graph.ctx.createGain();
    this.wet.gain.value = 1.0;
    this.convolver.connect(this.wet).connect(graph.master);
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
    const buf = this.graph.ctx.createBuffer(2, ir.length, ir.sampleRate);
    buf.getChannelData(0).set(ir.left);
    buf.getChannelData(1).set(ir.right);
    this.convolver.buffer = buf;
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
    src.connect(this.convolver);
    src.start();
  }
}
