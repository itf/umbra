/**
 * Game core: walk to the beacon. Wires the step state machine (player.ts) to
 * audio — a positioned beacon you navigate toward, spatialized footsteps, stumble
 * feedback, and win detection. The listener pose is driven by the player's
 * position + the turn control's heading.
 */
import type { AudioGraph } from '../engine/audioGraph';
import { HrtfRenderer, type HrtfSource } from '../engine/hrtf/renderer';
import { Player, type Foot, type StepConfig, DEFAULT_STEP_CONFIG } from './player';
import { Footsteps } from './footsteps';

export interface GameLevel {
  start: { x: number; z: number; yaw: number };
  beacon: { x: number; z: number; freq: number };
  /** Win when within this many metres of the beacon. */
  goalRadius: number;
  headHeight?: number;
}

export interface GameCallbacks {
  onStep?: (foot: Foot, stride: number) => void;
  onStumble?: (reason: string) => void;
  onWin?: () => void;
  onProgress?: (distance: number) => void;
}

export class Game {
  private graph: AudioGraph;
  private renderer: HrtfRenderer;
  private player: Player;
  private level: GameLevel;
  private cb: GameCallbacks;
  private footsteps: Footsteps;
  private beacon: HrtfSource;
  private beaconOsc: OscillatorNode;
  private beaconLfo: OscillatorNode;
  private headHeight: number;
  private won = false;

  constructor(
    graph: AudioGraph,
    renderer: HrtfRenderer,
    level: GameLevel,
    cb: GameCallbacks = {},
    stepCfg: StepConfig = DEFAULT_STEP_CONFIG,
  ) {
    this.graph = graph;
    this.renderer = renderer;
    this.level = level;
    this.cb = cb;
    this.headHeight = level.headHeight ?? 1.6;
    this.player = new Player({ x: level.start.x, z: level.start.z, yaw: level.start.yaw }, stepCfg);
    this.footsteps = new Footsteps(graph, renderer);

    // Beacon: a pulsed tone at the goal, so it's easy to localize and home in on.
    const ctx = graph.ctx;
    this.beaconOsc = ctx.createOscillator();
    this.beaconOsc.type = 'sine';
    this.beaconOsc.frequency.value = level.beacon.freq;
    const trem = ctx.createGain();
    this.beaconLfo = ctx.createOscillator();
    this.beaconLfo.frequency.value = 1.6;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.5;
    this.beaconLfo.connect(lfoGain).connect(trem.gain);
    trem.gain.value = 0.5;
    this.beacon = renderer.createSource();
    this.beaconOsc.connect(trem).connect(this.beacon.input);
    this.beacon.output.connect(graph.master);
    this.beaconOsc.start();
    this.beaconLfo.start();

    this.syncListener();
  }

  /** Update the listener pose from player position + heading, reposition beacon. */
  private syncListener() {
    const s = this.player.state;
    this.renderer.setListener({ x: s.x, y: this.headHeight, z: s.z, yaw: s.yaw });
    this.beacon.setPosition(this.level.beacon.x, this.headHeight, this.level.beacon.z);
    const d = this.player.distanceTo(this.level.beacon.x, this.level.beacon.z);
    this.cb.onProgress?.(d);
  }

  /** Turn the player's head (radians). */
  setYaw(yaw: number) {
    this.player.setYaw(yaw);
    this.syncListener();
  }

  /** Take a step with the given foot at time nowMs (default: audio clock). */
  step(foot: Foot, nowMs = this.graph.ctx.currentTime * 1000) {
    if (this.won) return;
    const result = this.player.step(foot, nowMs);
    const s = this.player.state;

    if (result.outcome.kind === 'step') {
      // After standing still, the feet came together — play the soft reset cue
      // just before this (either-foot) step.
      if (result.outcome.settled) {
        this.footsteps.feetTogether({ x: s.x, y: this.headHeight, z: s.z });
      }
      this.footsteps.step(result.outcome.foot, { x: s.x, y: this.headHeight, z: s.z, yaw: s.yaw });
      this.cb.onStep?.(result.outcome.foot, result.outcome.stride);
      this.syncListener();
      this.checkWin();
    } else {
      this.footsteps.stumble({ x: s.x, y: this.headHeight, z: s.z });
      this.cb.onStumble?.(result.outcome.reason);
    }
  }

  /** Which foot is expected next (for UI hinting). */
  get nextFoot(): Foot {
    return this.player.nextFoot;
  }

  /** Whether either foot may currently lead (settled / pre-first-step). */
  isSettled(): boolean {
    return this.player.isSettled(this.graph.ctx.currentTime * 1000);
  }

  /** Current listener world pose (for the clap/echo feature). */
  get listenerPos(): { x: number; y: number; z: number; yaw: number } {
    const s = this.player.state;
    return { x: s.x, y: this.headHeight, z: s.z, yaw: s.yaw };
  }

  private checkWin() {
    const d = this.player.distanceTo(this.level.beacon.x, this.level.beacon.z);
    if (d <= this.level.goalRadius && !this.won) {
      this.won = true;
      // Fade the beacon out on win.
      this.beacon.output.gain.setTargetAtTime(0, this.graph.ctx.currentTime, 0.3);
      this.cb.onWin?.();
    }
  }

  destroy() {
    this.beaconOsc.stop();
    this.beaconLfo.stop();
    this.beacon.disconnect();
  }
}
