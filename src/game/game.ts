/**
 * Game core: walk to the beacon. Wires the step state machine (player.ts) to
 * audio — a positioned beacon you navigate toward, spatialized footsteps, stumble
 * feedback, and win detection. The listener pose is driven by the player's
 * position + the turn control's heading.
 */
import type { AudioGraph } from '../engine/audioGraph';
import { HrtfRenderer, type HrtfSource } from '../engine/hrtf/renderer';
import { ModeledSource } from '../engine/acoustics/modeledSource';
import type { WallDef, EdgeDef } from '../engine/acoustics/core';
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
import { attachCustomLoop } from './customAudio';

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
  /** Optional custom audio file looped through the monster's HRTF source. */
  soundUrl?: string;
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
  /** Max clap/echo probes for the level (0/undefined ⇒ unlimited). */
  clapBudget?: number;
  /** Minimum ms between consecutive claps (0/undefined ⇒ no cooldown). */
  clapCooldownMs?: number;
  /** Speed of sound (m/s) for this level (undefined ⇒ engine default 343). */
  speedOfSound?: number;
  /**
   * Acoustic geometry for the MODELED beacon (occlusion + diffraction). When
   * present, the beacon is rendered through the room solver (`ModeledSource`)
   * instead of a straight-line `HrtfSource`, so walls occlude it and openings let
   * it diffract through. Absent ⇒ the beacon falls back to the plain HrtfSource.
   * The caller may swap `acousticWalls`/`acousticEdges` per frame (moving walls).
   */
  acousticWalls?: WallDef[];
  acousticEdges?: EdgeDef[];
  /** Representative scattering coefficient for the modeled beacon's surfaces. */
  acousticScattering?: number;
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
  /**
   * The plain straight-line beacon source — used as a FALLBACK when the level has
   * no acoustic geometry (`acousticWalls`). When geometry IS present the beacon is
   * the `modeledBeacon` below instead (occlusion + diffraction), and this is null.
   */
  private beacon: HrtfSource | null = null;
  /**
   * The MODELED beacon: the dry voice rendered through the room solver so walls
   * occlude it and openings let it diffract through. Non-null iff the level has
   * acoustic geometry. Driven by `refreshBeacon()` on the per-frame throttle.
   */
  private modeledBeacon: ModeledSource | null = null;
  /** The dry-voice input node + the master-bound output node, whichever beacon is live. */
  private beaconInput!: GainNode;
  private beaconOutput!: GainNode;
  /** The synthesized beacon voice (null while a custom audio file is playing). */
  private beaconVoice: BeaconVoice | null = null;
  /** Looping custom-audio source, when `soundUrl` loaded successfully. */
  private beaconCustom: AudioBufferSourceNode | null = null;
  private headHeight: number;
  private won = false;
  private caught = false;
  /**
   * Live monster runtime, one entry per level monster. Each has a PURE AI state
   * (monster.ts) and its own spatialized growl voice through an HrtfSource, so a
   * chasing monster Dopplers/glides as it nears. Empty (and zero per-frame cost)
   * when the level has no monsters. See docs/engine/monster-chase.md.
   */
  private monsters: {
    state: MonsterState;
    src: HrtfSource;
    /** The synth growl/hum voice. Stopped + nulled once a custom loop takes over. */
    voice: MonsterVoice | null;
    /** Looping custom-audio source, when this monster's `soundUrl` loaded. */
    custom: AudioBufferSourceNode | null;
  }[] = [];
  /** True once the game has ended, to veto late-arriving custom-audio loops. */
  private get ended() { return this.won || this.caught; }
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
    // If the level carries acoustic geometry, render the beacon through the room
    // solver (occlusion + diffraction); otherwise fall back to the plain
    // straight-line HrtfSource. Either way `beaconInput` is where the dry voice
    // feeds and `beaconOutput` is the master-bound output.
    if (level.acousticWalls && level.acousticWalls.length > 0) {
      this.modeledBeacon = new ModeledSource(graph.ctx, graph.master, renderer.set);
      this.beaconInput = this.modeledBeacon.input;
      this.beaconOutput = this.modeledBeacon.output;
      // (the initial solve happens at the end of the constructor, once the start
      // pose is set — see this.refreshBeacon() below)
    } else {
      this.beacon = renderer.createSource();
      this.beacon.output.connect(graph.master);
      this.beaconInput = this.beacon.input;
      this.beaconOutput = this.beacon.output;
    }
    this.startBeaconSource();

    // Monsters: a PURE AI state + a looping growl through its own HrtfSource so it's
    // locatable by ear and Dopplers as it chases. No-op when the level has none.
    for (const m of level.monsters ?? []) {
      const src = renderer.createSource();
      src.output.connect(graph.master);
      // Start the synth voice immediately so the monster is never silent. If a
      // `soundUrl` is set, the shared helper loops that recording through the SAME
      // HrtfSource (so it spatializes / Dopplers as the monster chases) and we swap
      // to it when it arrives; on failure/no-url the synth growl/hum stays.
      const voice = new MonsterVoice(this.graph.ctx, src.input, resolveMonsterPreset(m.sound));
      voice.start();
      src.setPosition(m.x, this.headHeight, m.z);
      const entry: (typeof this.monsters)[number] =
        { state: makeMonster(m.x, m.z, m.speed), src, voice, custom: null };
      this.monsters.push(entry);
      if (m.soundUrl) {
        void attachCustomLoop(
          this.graph.ctx,
          src.input,
          m.soundUrl,
          () => { /* keep the synth growl/hum already running */ },
          { shouldStart: () => !this.ended && entry.custom == null },
        ).then((handle) => {
          if (!handle.source) return;
          entry.voice?.stop();
          entry.voice = null;
          entry.custom = handle.source;
        });
      }
    }

    this.syncListener();
    // Solve the modeled beacon once for the start pose so the very first frame of
    // audio is already correct (occluded/diffracted as appropriate), rather than
    // silent until the first tick. No-op for the plain-HrtfSource fallback.
    this.refreshBeacon();
  }

  /**
   * Build the beacon's dry source. If the level's beacon has a `soundUrl`, try to
   * play it looped (fetch + decode, cached); otherwise — or on failure — play the
   * chosen synth preset (default 'tone'). Both feed `this.beacon.input`.
   */
  private startBeaconSource() {
    // Always start the synth preset immediately so the beacon is never silent.
    // If a custom `soundUrl` is set, the shared helper loads + loops it through the
    // SAME HrtfSource and we swap to it when it arrives; on failure the synth stays.
    this.startSynthBeacon();
    const url = this.level.beacon.soundUrl;
    if (!url) return;
    // onFallback is a no-op here: the synth is already playing as the fallback.
    // shouldStart vetoes a late buffer if the beacon was won (and faded) meanwhile.
    void attachCustomLoop(
      this.graph.ctx,
      this.beaconInput,
      url,
      () => { /* keep the synth fallback already running */ },
      { shouldStart: () => !this.won && this.beaconCustom == null },
    ).then((handle) => {
      if (!handle.source) return;
      // Swap: the custom loop is now playing, stop the synth preset.
      this.beaconVoice?.stop();
      this.beaconVoice = null;
      this.beaconCustom = handle.source;
    });
  }

  /** Start (or restart) the synthesized preset voice. */
  private startSynthBeacon() {
    const preset: BeaconPreset = resolveBeaconPreset(this.level.beacon.sound);
    this.beaconVoice?.stop();
    this.beaconVoice = new BeaconVoice(this.graph.ctx, this.beaconInput, preset, this.level.beacon.freq);
    this.beaconVoice.start();
  }

  /**
   * Apply an audio pose (interpolated x/z + the current audioYaw) to the HRTF
   * listener and reposition the beacon. This is the per-frame audio update driven
   * by the glide sink; it does NOT touch progress/win (those use the logical pose).
   */
  private applyAudioPose(pose: AudioPose) {
    this.renderer.setListener({ x: pose.x, y: this.headHeight, z: pose.z, yaw: this.audioYaw });
    if (this.beacon) {
      // Plain (fallback) beacon: straight-line spatializer, repositioned per frame.
      this.beacon.setPosition(this.level.beacon.x, this.headHeight, this.level.beacon.z);
    } else {
      // Modeled beacon: re-solve the room for the new listener pose (throttled).
      this.refreshBeacon(pose.x, pose.z);
    }
  }

  /**
   * Re-solve the MODELED beacon's room IR for the current listener pose (occlusion +
   * diffraction). Throttled + dirty-checked inside `ModeledSource.refresh`, so this
   * is safe to call from the per-frame audio path. No-op when the beacon isn't
   * modeled. `lx`/`lz` are the listener world position (logical or glide pose); the
   * beacon position comes from the level.
   */
  private refreshBeacon(lx = this.player.state.x, lz = this.player.state.z) {
    const mb = this.modeledBeacon;
    if (!mb) return;
    mb.refresh({
      walls: this.level.acousticWalls ?? [],
      edges: this.level.acousticEdges,
      listener: [lx, this.headHeight, lz],
      yaw: this.audioYaw,
      source: [this.level.beacon.x, this.headHeight, this.level.beacon.z],
      speedOfSound: this.level.speedOfSound,
      // Phase 2: full reflections at order 3. Energy pruning (geometry.rs) keeps the
      // candidate search cheap, and the `orderTapCap` guard below auto-drops to a
      // lower order on large low-absorption enclosures (cathedral-class) whose
      // high-order chains stay audible and would otherwise blow the IR-build budget.
      maxOrder: 3,
      orderTapCap: 24,
      scattering: this.level.acousticScattering ?? 0.1,
    });
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
    // Keep the modeled beacon's room IR fresh even when the glide is idle: a turning
    // listener, or moving walls (the caller may swap `acousticWalls` per frame),
    // must re-solve occlusion/diffraction. Throttled + dirty-checked inside refresh,
    // so an utterly static scene rebuilds zero times here.
    if (this.modeledBeacon) {
      const p = this.glide.current;
      this.refreshBeacon(p.x, p.z);
    }
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
        this.beaconOutput.gain.setTargetAtTime(0, t, 0.3);
        for (const mm of this.monsters) mm.src.output.gain.setTargetAtTime(0, t, 0.3);
        this.cb.onCaught?.();
      }
    }
  }

  /**
   * Update the modeled beacon's acoustic geometry (for MOVING walls): the host loop
   * passes the live wall+edge list each frame. No-op when the beacon isn't modeled.
   * The next `refreshBeacon`/`tick` re-solves with it (the geometry is part of the
   * dirty-check signature, so a real wall move triggers a rebuild).
   */
  setAcousticGeometry(walls: WallDef[], edges: EdgeDef[]) {
    this.level.acousticWalls = walls;
    this.level.acousticEdges = edges;
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
      this.beaconOutput.gain.setTargetAtTime(0, this.graph.ctx.currentTime, 0.3);
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
    this.beacon?.disconnect();
    this.modeledBeacon?.disconnect();
    for (const m of this.monsters) {
      m.voice?.stop();
      if (m.custom) {
        try { m.custom.stop(); } catch { /* already stopped */ }
        m.custom = null;
      }
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
