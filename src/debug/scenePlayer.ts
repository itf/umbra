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
import { resolveProbe, type ProbeName } from './probes';
import { loadCustomLoop } from '../game/customAudio';
import type { SpatialBackend } from '../game/game';
import type { SteamSourceHandle } from '../engine/steamaudio/backend';

/**
 * What probe to fire through the room IR:
 *  - a synth preset name ('clap' | 'click' | 'hiss' | 'snap'),
 *  - a recorded file `{ url }` (fetched/decoded/cached via loadCustomLoop),
 *  - a pre-decoded `{ buffer }` (e.g. a user-picked File already decoded).
 */
export type ProbeSpec = ProbeName | { url: string } | { buffer: AudioBuffer };

export class ScenePlayer {
  private graph: AudioGraph;
  private renderer: HrtfRenderer;
  private scene: Scene | null = null;
  private tones: Array<{ src: HrtfSource | SteamSourceHandle; osc: OscillatorNode; lfo: OscillatorNode; pos: [number, number, number] }> = [];
  private convolver: ConvolverNode;
  private yaw = 0;
  /**
   * Optional Steam Audio backend (when the trainer's high-fidelity toggle is on).
   * When set, continuous TONE sources route through it (ray-traced occlusion +
   * reflections), and its listener + `world.step` are driven from load/setYaw/tick.
   * The clap/room-IR path is UNCHANGED — Steam Audio's reflections are parametric,
   * not a convolvable one-shot IR, so the size/material/distance/gap exercises keep
   * using our image-source IR. Null ⇒ everything is our engine (default).
   */
  private steam: SpatialBackend | null = null;
  /** The currently selected probe (default: the legacy synth clap). */
  private probe: ProbeSpec = 'clap';
  /** A recorded probe buffer once loaded, or null if none / load failed. */
  private recordedBuffer: AudioBuffer | null = null;

  constructor(graph: AudioGraph, renderer: HrtfRenderer) {
    this.graph = graph;
    this.renderer = renderer;
    this.convolver = graph.ctx.createConvolver();
    this.convolver.normalize = false;
    this.convolver.connect(graph.master);
  }

  /** Set (or clear) the Steam Audio backend used for continuous tone sources. */
  setSteamBackend(backend: SpatialBackend | null) {
    this.steam = backend;
  }

  /** Advance the Steam Audio sim (no-op when our engine is active). */
  tick(deltaSeconds = 1 / 60) {
    this.steam?.step(deltaSeconds);
  }

  /** Tear down a tone source whichever engine produced it. */
  private disposeTone(src: HrtfSource | SteamSourceHandle) {
    if ('dispose' in src) src.dispose();
    else src.disconnect();
  }

  /** Tear down the current scene's live nodes. */
  private stop() {
    for (const t of this.tones) {
      t.osc.stop();
      t.lfo.stop();
      this.disposeTone(t.src);
    }
    this.tones = [];
  }

  load(scene: Scene) {
    this.stop();
    this.scene = scene;
    this.renderer.setListener({ x: scene.listener[0], y: scene.listener[1], z: scene.listener[2], yaw: this.yaw });
    if (this.steam) {
      // Push this scene's geometry into the Steam Audio world and set its listener.
      this.steam.setGeometry(sceneWalls(scene));
      this.steam.setListener(scene.listener[0], scene.listener[1], scene.listener[2], this.yaw);
    }

    // Build continuous tone beacons. With the Steam Audio toggle on, the tone routes
    // through a Steam Audio source (ray-traced occlusion + reflections); otherwise our
    // straight-line HrtfSource.
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
      const src: HrtfSource | SteamSourceHandle = this.steam
        ? this.steam.createSource()
        : this.renderer.createSource();
      osc.connect(trem).connect(src.input);
      if (!this.steam) (src as HrtfSource).output.connect(this.graph.master); // steam wires its own output → master
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
    this.steam?.setListener(this.scene.listener[0], this.scene.listener[1], this.scene.listener[2], yaw);
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

  /**
   * Select which probe `clap()` fires:
   *  - a synth preset name, OR
   *  - `{ url }` for a recorded file (fetched/decoded/cached via loadCustomLoop),
   *  - `{ buffer }` for a pre-decoded recording (e.g. a user-picked File).
   * For a recorded probe the buffer is loaded eagerly; if the load fails we fall
   * back to the synth `clap` at fire time.
   */
  async setProbe(probe: ProbeSpec): Promise<void> {
    this.probe = probe;
    this.recordedBuffer = null;
    if (typeof probe === 'object') {
      if ('buffer' in probe) {
        this.recordedBuffer = probe.buffer;
      } else {
        // Reuse the shared fetch+decode+cache helper; null on failure.
        this.recordedBuffer = await loadCustomLoop(this.graph.ctx, probe.url);
      }
    }
  }

  /** Decode a user-picked audio File/Blob into an AudioBuffer for use as a probe. */
  async decodeFile(file: Blob): Promise<AudioBuffer> {
    const bytes = await file.arrayBuffer();
    return this.graph.ctx.decodeAudioData(bytes);
  }

  /** Build the mono excitation buffer for the current probe (synth fallback). */
  private probeBuffer(): AudioBuffer {
    const ctx = this.graph.ctx;
    if (typeof this.probe === 'object' && this.recordedBuffer) {
      return this.recordedBuffer; // recorded probe (loaded ok)
    }
    // Synth probe, or recorded-probe fallback to clap on load failure.
    const name = typeof this.probe === 'string' ? this.probe : 'clap';
    const samples = resolveProbe(name)(ctx.sampleRate);
    const buf = ctx.createBuffer(1, samples.length, ctx.sampleRate);
    buf.getChannelData(0).set(samples);
    return buf;
  }

  /**
   * Fire the currently-selected probe through the scene's room IR. The optional
   * arg is a synth preset NAME only; to use a recorded (url/buffer) probe, call
   * `setProbe(...)` first (it's async) — the type reflects that.
   */
  clap(probe?: ProbeName) {
    if (!this.scene) return;
    if (!this.scene.sources.some((s) => s.kind === 'clap')) return;
    if (probe !== undefined) this.probe = probe;
    const ctx = this.graph.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.probeBuffer();
    src.connect(this.convolver);
    src.start();
  }

  /** Whether the loaded scene has a clap to fire. */
  get hasClap(): boolean {
    return !!this.scene?.sources.some((s) => s.kind === 'clap');
  }
}
