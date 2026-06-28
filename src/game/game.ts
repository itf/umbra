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

/** A wall segment for collision + material-keyed bump sounds. */
export interface CollisionWall {
  ax: number; az: number; bx: number; bz: number; material: string;
}
/** A rectangular floor zone (for per-material footstep sounds). */
export interface FloorRegion {
  x: number; z: number; w: number; d: number; material: string;
}

export interface GameLevel {
  start: { x: number; z: number; yaw: number };
  beacon: { x: number; z: number; freq: number };
  /** Win when within this many metres of the beacon. */
  goalRadius: number;
  headHeight?: number;
  /** Default floor material when not standing in any zone. */
  floorMaterial?: string;
  /** Floor zones for per-material footsteps (optional). */
  floors?: FloorRegion[];
  /** Walls you can bump into (optional). */
  walls?: CollisionWall[];
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
    const before = { x: this.player.state.x, z: this.player.state.z };
    const result = this.player.step(foot, nowMs);
    const s = this.player.state;

    if (result.outcome.kind === 'step') {
      // Wall collision: if this step would cross a wall, undo the move and bump
      // into it (material-keyed sound) instead of walking through.
      const hitWall = this.crossedWall(before.x, before.z, s.x, s.z);
      if (hitWall) {
        this.player.state.x = before.x;
        this.player.state.z = before.z;
        this.footsteps.bump(hitWall.material);
        this.cb.onStumble?.('wall');
        this.syncListener();
        return;
      }
      // After standing still, the feet came together — soft reset cue.
      if (result.outcome.settled) this.footsteps.feetTogether();
      this.footsteps.step(result.outcome.foot, this.floorMaterialAt(s.x, s.z));
      this.cb.onStep?.(result.outcome.foot, result.outcome.stride);
      this.syncListener();
      this.checkWin();
    } else {
      this.footsteps.stumble();
      this.cb.onStumble?.(result.outcome.reason);
    }
  }

  /** Floor material at a point: the topmost matching floor zone, else default. */
  private floorMaterialAt(x: number, z: number): string {
    const zones = this.level.floors ?? [];
    for (let i = zones.length - 1; i >= 0; i--) {
      const f = zones[i];
      if (x >= f.x && x <= f.x + f.w && z >= f.z && z <= f.z + f.d) return f.material;
    }
    return this.level.floorMaterial ?? 'concrete';
  }

  /** Returns the wall a move (ax,az)->(bx,bz) crosses, if any. */
  private crossedWall(ax: number, az: number, bx: number, bz: number): CollisionWall | null {
    for (const w of this.level.walls ?? []) {
      if (segmentsIntersect(ax, az, bx, bz, w.ax, w.az, w.bx, w.bz)) return w;
    }
    return null;
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

/** 2D segment intersection test (standard orientation method). */
function segmentsIntersect(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): boolean {
  const o = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) =>
    Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
  const o1 = o(ax, ay, bx, by, cx, cy);
  const o2 = o(ax, ay, bx, by, dx, dy);
  const o3 = o(cx, cy, dx, dy, ax, ay);
  const o4 = o(cx, cy, dx, dy, bx, by);
  return o1 !== o2 && o3 !== o4;
}
