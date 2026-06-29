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
import { ListenerGlide, type AudioPose } from './listenerGlide';
import { BeaconVoice, resolveBeaconPreset, type BeaconPreset } from './beaconSounds';
import { NoiseTracker, makeNoiseEvent, type NoiseEvent } from './noiseEvents';
import {
  makeMonster,
  updateMonster,
  caught as monsterCaught,
  DEFAULT_CATCH_RADIUS,
  type MonsterState,
} from './monster';
import { MonsterVoice, resolveMonsterPreset } from './monsterSounds';

/** A wall segment for collision + material-keyed bump sounds. */
export interface CollisionWall {
  ax: number; az: number; bx: number; bz: number; material: string;
}
/** A rectangular floor zone (for per-material footstep sounds). */
export interface FloorRegion {
  x: number; z: number; w: number; d: number; material: string;
}
/** A monster placement for the chase AI (position + speed + sound label). */
export interface MonsterSpawn {
  x: number; z: number; speed: number; sound: string;
}

export interface GameLevel {
  start: { x: number; z: number; yaw: number };
  beacon: { x: number; z: number; freq: number; sound?: BeaconPreset; soundUrl?: string };
  /** Win when within this many metres of the beacon. */
  goalRadius: number;
  headHeight?: number;
  /** Default floor material when not standing in any zone. */
  floorMaterial?: string;
  /** Floor zones for per-material footsteps (optional). */
  floors?: FloorRegion[];
  /** Walls you can bump into (optional). */
  walls?: CollisionWall[];
  /** Monsters that chase the player's last noise (optional). */
  monsters?: MonsterSpawn[];
  /** Real-proximity radius (m) at which a monster catches the player. */
  catchRadius?: number;
}

export interface GameCallbacks {
  onStep?: (foot: Foot, stride: number) => void;
  onStumble?: (reason: string) => void;
  onWin?: () => void;
  /** Fired once when a monster physically reaches the player (lose state). */
  onCaught?: () => void;
  onProgress?: (distance: number) => void;
  /** Fired whenever the player makes noise (step/stumble/bump). Foundation for monster AI. */
  onNoise?: (event: NoiseEvent) => void;
}

export class Game {
  private graph: AudioGraph;
  private renderer: HrtfRenderer;
  private player: Player;
  private level: GameLevel;
  private cb: GameCallbacks;
  private footsteps: Footsteps;
  /**
   * Records the LAST positioned noise the player made (step/stumble/bump) with a
   * normalized loudness. PURE model (noiseEvents.ts), parallel to footstep audio;
   * the future monster reads `lastNoise()` to hunt the last place noise was made,
   * not the player's actual position. See docs/engine/noise-events.md.
   */
  private noise: NoiseTracker;
  private beacon: HrtfSource;
  /** The synthesized beacon voice (null while a custom audio file is playing). */
  private beaconVoice: BeaconVoice | null = null;
  /** Looping custom-audio source, when `soundUrl` loaded successfully. */
  private beaconCustom: AudioBufferSourceNode | null = null;
  /** Cache of decoded custom-audio buffers, keyed by url. */
  private static customCache = new Map<string, AudioBuffer | null>();
  private headHeight: number;
  private won = false;
  private caught = false;
  /**
   * Live monster runtime, one entry per level monster. Each has a PURE AI state
   * (monster.ts) and its own spatialized growl voice through an HrtfSource, so a
   * chasing monster Dopplers/glides as it nears. Empty (and zero per-frame cost)
   * when the level has no monsters. See docs/engine/monster-chase.md.
   */
  private monsters: { state: MonsterState; src: HrtfSource; voice: MonsterVoice }[] = [];
  /** ms timestamp of the previous tick, for per-frame dt. */
  private lastTickMs: number | null = null;
  /**
   * Audio-only listener glide. The HRTF listener + beacon follow this smoothly
   * interpolated pose across a step window; the LOGICAL player position (used for
   * win/collision/clap) is untouched. See docs/engine/listener-glide.md.
   */
  private glide: ListenerGlide;
  /** Current yaw used for the audio pose (kept separate so the glide carries x/z only). */
  private audioYaw: number;

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
    this.noise = new NoiseTracker(cb.onNoise);
    this.audioYaw = level.start.yaw;
    // The glide sink applies an interpolated x/z (with the current audioYaw) to the
    // HRTF listener and repositions the beacon — the actual per-frame audio update.
    this.glide = new ListenerGlide(
      { x: level.start.x, z: level.start.z },
      (pose) => this.applyAudioPose(pose),
    );

    // Beacon at the goal — easy to localize and home in on. Its dry signal comes
    // from the chosen synth preset (or a looped custom audio file); either way it
    // feeds the HrtfSource so all spatial/Doppler/propagation work is shared.
    this.beacon = renderer.createSource();
    this.beacon.output.connect(graph.master);
    this.startBeaconSource();

    // Monsters: a PURE AI state + a looping growl through its own HrtfSource so it's
    // locatable by ear and Dopplers as it chases. No-op when the level has none.
    for (const m of level.monsters ?? []) {
      const src = renderer.createSource();
      src.output.connect(graph.master);
      const voice = new MonsterVoice(this.graph.ctx, src.input, resolveMonsterPreset(m.sound));
      voice.start();
      src.setPosition(m.x, this.headHeight, m.z);
      this.monsters.push({ state: makeMonster(m.x, m.z, m.speed), src, voice });
    }

    this.syncListener();
  }

  /**
   * Build the beacon's dry source. If the level's beacon has a `soundUrl`, try to
   * play it looped (fetch + decode, cached); otherwise — or on failure — play the
   * chosen synth preset (default 'tone'). Both feed `this.beacon.input`.
   */
  private startBeaconSource() {
    const url = this.level.beacon.soundUrl;
    if (url) {
      this.playCustomBeacon(url);
      // While the custom file loads, run the synth preset as an immediate
      // fallback; if/when the buffer arrives, we swap to it.
    }
    this.startSynthBeacon();
  }

  /** Start (or restart) the synthesized preset voice. */
  private startSynthBeacon() {
    const preset: BeaconPreset = resolveBeaconPreset(this.level.beacon.sound);
    this.beaconVoice?.stop();
    this.beaconVoice = new BeaconVoice(this.graph.ctx, this.beacon.input, preset, this.level.beacon.freq);
    this.beaconVoice.start();
  }

  /** Fetch + decode (cached) the custom audio and loop it through the beacon. */
  private playCustomBeacon(url: string) {
    const cached = Game.customCache.get(url);
    if (cached) { this.swapToCustom(cached); return; }
    if (cached === null) return; // known-failed; stick with synth
    if (Game.customCache.has(url)) return; // in flight
    Game.customCache.set(url, null); // mark in-flight / failed-until-resolved
    fetch(url)
      .then((r) => r.arrayBuffer())
      .then((b) => this.graph.ctx.decodeAudioData(b))
      .then((buf) => {
        Game.customCache.set(url, buf);
        if (!this.won) this.swapToCustom(buf);
      })
      .catch(() => { Game.customCache.set(url, null); /* keep the synth fallback */ });
  }

  /** Replace the synth voice with a looped custom buffer. */
  private swapToCustom(buf: AudioBuffer) {
    if (this.beaconCustom) return; // already swapped
    this.beaconVoice?.stop();
    this.beaconVoice = null;
    const src = this.graph.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(this.beacon.input);
    src.start();
    this.beaconCustom = src;
  }

  /**
   * Apply an audio pose (interpolated x/z + the current audioYaw) to the HRTF
   * listener and reposition the beacon. This is the per-frame audio update driven
   * by the glide sink; it does NOT touch progress/win (those use the logical pose).
   */
  private applyAudioPose(pose: AudioPose) {
    this.renderer.setListener({ x: pose.x, y: this.headHeight, z: pose.z, yaw: this.audioYaw });
    this.beacon.setPosition(this.level.beacon.x, this.headHeight, this.level.beacon.z);
  }

  /**
   * Snap the audio listener immediately to the LOGICAL player position (no glide).
   * For callers that change the pose without a step (yaw turn, wall bump) so the
   * audio reflects it at once.
   */
  private syncListener() {
    const s = this.player.state;
    this.audioYaw = s.yaw;
    this.glide.snap({ x: s.x, z: s.z });
    this.reportProgress();
  }

  /** Report closing distance from the LOGICAL position (never the mid-glide pose). */
  private reportProgress() {
    const d = this.player.distanceTo(this.level.beacon.x, this.level.beacon.z);
    this.cb.onProgress?.(d);
  }

  /**
   * Advance the active audio glide. Driven once per animation frame from the host
   * loop (main.ts). A no-op when no glide is running, so it never thrashes
   * AudioParams while idle.
   */
  tick(nowMs = this.graph.ctx.currentTime * 1000) {
    this.glide.tick(nowMs);
    this.tickMonsters(nowMs);
  }

  /**
   * Advance every monster's AI by the per-frame dt: feed it the LAST noise the
   * player made (it hunts that, not the player), move it toward its target,
   * reposition its spatial voice, and run the real-proximity catch test against the
   * player. Frozen once won or caught. Entirely skipped when there are no monsters.
   */
  private tickMonsters(nowMs: number) {
    if (this.monsters.length === 0) { this.lastTickMs = nowMs; return; }
    const dtMs = this.lastTickMs == null ? 0 : Math.max(0, nowMs - this.lastTickMs);
    this.lastTickMs = nowMs;
    if (this.won || this.caught) return;

    const noise = this.noise.lastNoise();
    const p = this.player.state;
    const radius = this.level.catchRadius ?? DEFAULT_CATCH_RADIUS;
    for (const m of this.monsters) {
      m.state = updateMonster(m.state, noise, nowMs, dtMs);
      m.src.setPosition(m.state.x, this.headHeight, m.state.z);
      if (!this.caught && monsterCaught(m.state, p.x, p.z, radius)) {
        this.caught = true;
        // A loud CATCH roar, front-and-centre on the master bus (not spatialized)
        // so the lunge is unmistakable — played BEFORE fading the chase audio.
        MonsterVoice.roar(this.graph.ctx, this.graph.master);
        // Then freeze + fade the looping chase audio (mirrors win).
        const t = this.graph.ctx.currentTime;
        this.beacon.output.gain.setTargetAtTime(0, t, 0.3);
        for (const mm of this.monsters) mm.src.output.gain.setTargetAtTime(0, t, 0.3);
        this.cb.onCaught?.();
      }
    }
  }

  /** Turn the player's head (radians). Audio yaw follows immediately (no position glide). */
  setYaw(yaw: number) {
    this.player.setYaw(yaw);
    this.audioYaw = yaw;
    // Re-apply at the current audio pose so the new yaw takes effect at once,
    // whether or not a position glide is in flight.
    this.applyAudioPose(this.glide.current);
    this.reportProgress();
  }

  /** Take a step with the given foot at time nowMs (default: audio clock). */
  step(foot: Foot, nowMs = this.graph.ctx.currentTime * 1000) {
    if (this.won || this.caught) return;
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
        // Loud noise spike at the bump position (where the player still stands).
        this.noise.emit(makeNoiseEvent('bump', before.x, before.z, hitWall.material, nowMs));
        this.cb.onStumble?.('wall');
        this.syncListener();
        return;
      }
      // After standing still, the feet came together — soft reset cue.
      if (result.outcome.settled) this.footsteps.feetTogether();
      const floorMat = this.floorMaterialAt(s.x, s.z);
      this.footsteps.step(result.outcome.foot, floorMat);
      // Positioned noise at the step's landing point; loudness from the floor
      // material (loud on gravel, near-silent on carpet/foam).
      this.noise.emit(makeNoiseEvent('step', s.x, s.z, floorMat, nowMs));
      this.cb.onStep?.(result.outcome.foot, result.outcome.stride);
      // AUDIO-ONLY glide: sweep the audio listener from where it currently IS
      // (the glide's current pose — so a step landing mid-glide retargets without
      // snapping back to `before`) toward the new logical position over the step
      // window. Win/progress still use the logical (final) position.
      this.audioYaw = s.yaw;
      this.glide.start(this.glide.current, { x: s.x, z: s.z }, nowMs);
      this.reportProgress();
      this.checkWin();
    } else {
      this.footsteps.stumble();
      // Loud noise spike at the player's position (stumbling is loud on any floor).
      this.noise.emit(makeNoiseEvent('stumble', s.x, s.z, this.floorMaterialAt(s.x, s.z), nowMs));
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

  /**
   * The last positioned noise the player made (step/stumble/bump), or null if
   * none yet. The future monster hunts THIS, not the player's actual position.
   */
  lastNoise(): NoiseEvent | null {
    return this.noise.lastNoise();
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
    this.beaconVoice?.stop();
    this.beaconVoice = null;
    if (this.beaconCustom) {
      try { this.beaconCustom.stop(); } catch { /* already stopped */ }
      this.beaconCustom = null;
    }
    this.beacon.disconnect();
    for (const m of this.monsters) {
      m.voice.stop();
      m.src.disconnect();
    }
    this.monsters = [];
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
