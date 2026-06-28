/**
 * Plays a listenable debug Scene through the real acoustics + HRTF pipeline.
 *
 * - 'tone' sources become continuous positioned HRTF beacons you can turn toward.
 * - 'clap' sources fire an impulse through the scene's room impulse response, so
 *   you hear reflections/material/size/diffraction.
 * The room IR is computed via the general WASM solver (walls + edges) so every
 * scene — including free objects and infinite space — uses the same path.
 */
import type { AudioGraph } from '../engine/audioGraph';
import { HrtfRenderer, type HrtfSource } from '../engine/hrtf/renderer';
import { computeRoomTaps } from '../engine/acoustics/core';
import { buildRoomIr } from '../engine/acoustics/roomIr';
import { type Scene, sceneWalls } from './scenes';

export class ScenePlayer {
  private graph: AudioGraph;
  private renderer: HrtfRenderer;
  private scene: Scene | null = null;
  private tones: Array<{ src: HrtfSource; osc: OscillatorNode; lfo: OscillatorNode; pos: [number, number, number] }> = [];
  private convolver: ConvolverNode;
  private yaw = 0;

  constructor(graph: AudioGraph, renderer: HrtfRenderer) {
    this.graph = graph;
    this.renderer = renderer;
    this.convolver = graph.ctx.createConvolver();
    this.convolver.normalize = false;
    this.convolver.connect(graph.master);
  }

  /** Tear down the current scene's live nodes. */
  private stop() {
    for (const t of this.tones) {
      t.osc.stop();
      t.lfo.stop();
      t.src.disconnect();
    }
    this.tones = [];
  }

  load(scene: Scene) {
    this.stop();
    this.scene = scene;
    this.renderer.setListener({ x: scene.listener[0], y: scene.listener[1], z: scene.listener[2], yaw: this.yaw });

    // Build continuous tone beacons.
    for (const s of scene.sources) {
      if (s.kind !== 'tone') continue;
      const ctx = this.graph.ctx;
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = s.freq ?? 440;
      const trem = ctx.createGain();
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 2.2;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 0.5;
      lfo.connect(lfoGain).connect(trem.gain);
      trem.gain.value = 0.5;
      const src = this.renderer.createSource();
      osc.connect(trem).connect(src.input);
      src.output.connect(this.graph.master);
      osc.start();
      lfo.start();
      this.tones.push({ src, osc, lfo, pos: s.pos });
    }

    this.refreshIr();
    this.updatePositions();
  }

  setYaw(yaw: number) {
    this.yaw = yaw;
    if (!this.scene) return;
    this.renderer.setListener({
      x: this.scene.listener[0],
      y: this.scene.listener[1],
      z: this.scene.listener[2],
      yaw,
    });
    this.updatePositions();
    this.refreshIr(); // reflections are head-relative, so rebuild on turn
  }

  private updatePositions() {
    for (const t of this.tones) t.src.setPosition(t.pos[0], t.pos[1], t.pos[2]);
  }

  /** Recompute the scene's room IR for clap sources at the current head yaw. */
  private refreshIr() {
    if (!this.scene) return;
    const scene = this.scene;
    const clap = scene.sources.find((s) => s.kind === 'clap');
    if (!clap) {
      this.convolver.buffer = null;
      return;
    }
    const taps = computeRoomTaps({
      walls: sceneWalls(scene),
      edges: scene.edges,
      listener: scene.listener,
      source: clap.pos,
      maxOrder: scene.maxOrder,
    });
    if (taps.length === 0) {
      this.convolver.buffer = null;
      return;
    }
    const ir = buildRoomIr(taps, this.renderer.set, { yaw: this.yaw });
    const buf = this.graph.ctx.createBuffer(2, ir.length, ir.sampleRate);
    buf.getChannelData(0).set(ir.left);
    buf.getChannelData(1).set(ir.right);
    this.convolver.buffer = buf;
  }

  /** Fire any clap source in the scene through the room IR. */
  clap() {
    if (!this.scene) return;
    if (!this.scene.sources.some((s) => s.kind === 'clap')) return;
    const ctx = this.graph.ctx;
    const n = Math.ceil(0.01 * ctx.sampleRate);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) {
      const env = 1 - i / n;
      ch[i] = (Math.random() * 2 - 1) * env * env;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.convolver);
    src.start();
  }

  /** Whether the loaded scene has a clap to fire. */
  get hasClap(): boolean {
    return !!this.scene?.sources.some((s) => s.kind === 'clap');
  }
}
