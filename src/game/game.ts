/**
 * Game core: walk to the beacon. Wires the step state machine (player.ts) to
 * audio — a positioned beacon you navigate toward, spatialized footsteps, stumble
 * feedback, and win detection. The listener pose is driven by the player's
 * position + the turn control's heading.
 */
import type { AudioGraph } from '../engine/audioGraph';
import { HrtfRenderer, type HrtfSource } from '../engine/hrtf/renderer';
import type { InterpolatingHrtfRenderer, InterpolatingHrtfSource } from '../engine/hrtf/interpolatingRenderer';
import { ModeledSource } from '../engine/acoustics/modeledSource';
import { FootstepRoom } from '../engine/acoustics/footstepRoom';
import type { WallDef, EdgeDef } from '../engine/acoustics/core';
import { Player, type Foot, type StepConfig, DEFAULT_STEP_CONFIG } from './player';
import { Footsteps, type StepRoomCtx } from './footsteps';
import { ListenerGlide, type AudioPose } from './listenerGlide';
import { BeaconVoice, resolveBeaconPreset, type BeaconPreset } from './beaconSounds';
import { NoiseTracker, makeNoiseEvent, type NoiseEvent } from './noiseEvents';
import {
  makeMonster,
  updateMonster,
  caught as monsterCaught,
  decayedLoudness,
  DEFAULT_CATCH_RADIUS,
  DEFAULT_NOISE_THRESHOLD,
  type MonsterState,
} from './monster';
import { MonsterVoice, resolveMonsterPreset } from './monsterSounds';
import { attachCustomLoop } from './customAudio';
import type { LevelResult } from './scoreModel';
import type { SteamSourceHandle } from '../engine/steamaudio/backend';

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
  /**
   * "Find the absorber" mode. When set, the win target is `goalTarget` (the wall
   * region in front of an absorber patch) instead of the beacon, and the beacon is
   * silenced. Absent ⇒ normal beacon game (unchanged).
   */
  goal?: 'beacon' | 'absorber' | 'escape';
  /** World position of the goal (used when goal === 'absorber' or 'escape'). */
  goalTarget?: { x: number; z: number };
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
  /** Throw-a-sound decoy budget (undefined ⇒ unlimited). */
  decoyBudget?: number;
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

/**
 * Optional alternate spatial backend. When provided (via `?engine=steam`), the
 * beacon is rendered through Steam Audio instead of our ModeledSource/HrtfSource:
 * the dry beacon voice feeds a Steam Audio source, whose listener + source positions
 * + per-frame `step` are driven from the existing game loop. The default build never
 * provides this, so our engine stays the untouched default (no bundle/runtime cost).
 * BEACON-FIRST: monsters still use our HrtfSource (documented follow-up).
 */
export interface SpatialBackend {
  createSource(): SteamSourceHandle;
  setGeometry(walls: WallDef[]): void;
  setListener(x: number, y: number, z: number, yaw: number): void;
  step(deltaSeconds: number): void;
}

/**
 * The common shape of a positioned voice the game drives: a dry `input`, a
 * master-bound `output` gain, position updates, and teardown. Both our `HrtfSource`
 * and a Steam Audio `SteamSourceHandle` satisfy it, so the beacon AND monsters route
 * through whichever engine is selected. `output` is a `GainNode` either way (the
 * catch-fade ramps `output.gain`).
 */
export interface PositionedVoice {
  input: AudioNode;
  output: GainNode;
  setPosition(x: number, y: number, z: number): void;
  teardown(): void;
}

export interface GameCallbacks {
  onStep?: (foot: Foot, stride: number) => void;
  onStumble?: (reason: string) => void;
  onWin?: () => void;
  /**
   * Fired once on a WIN, right after `onWin`, with the scored completion result
   * (elapsed time, claps used). The host records it + announces a new best. Purely
   * additive: a host that ignores it sees no behavioural difference. `clapsUsed` is
   * filled from the injected `clapsUsed` getter (0 when none was provided).
   */
  onComplete?: (result: LevelResult) => void;
  /** Fired once when a monster physically reaches the player (lose state). */
  onCaught?: () => void;
  onProgress?: (distance: number) => void;
  /** Fired whenever the player makes noise (step/stumble/bump). Foundation for monster AI. */
  onNoise?: (event: NoiseEvent) => void;
  /**
   * Fired when the player makes a noise LOUD ENOUGH for a monster to hear (its
   * decayed loudness clears the attraction threshold) — the "You were heard!" cue.
   * Only fires when the level actually has monsters. Foundation for stealth feedback.
   */
  onHeard?: (event: NoiseEvent) => void;
  /** Fired when a decoy is thrown (for the spoken "Decoy thrown." cue + budget). */
  onDecoy?: (remaining: number) => void;
}

export class Game {
  private graph: AudioGraph;
  private renderer: HrtfRenderer;
  private player: Player;
  private level: GameLevel;
  private cb: GameCallbacks;
  private footsteps: Footsteps;
  private footstepRoom: FootstepRoom | null = null;
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
   * Optional CLICK-FREE interpolating HRTF renderer (?hrtf=interp). When provided
   * AND the level has no acoustic geometry/steam, the beacon is rendered through the
   * AudioWorklet that continuously interpolates the measured HRIRs (no convolver
   * swap → no bucket-crossing click). A/B against the dual-convolver beacon above.
   */
  private interpRenderer: InterpolatingHrtfRenderer | null = null;
  private interpBeacon: InterpolatingHrtfSource | null = null;
  /**
   * The MODELED beacon: the dry voice rendered through the room solver so walls
   * occlude it and openings let it diffract through. Non-null iff the level has
   * acoustic geometry. Driven by `refreshBeacon()` on the per-frame throttle.
   */
  private modeledBeacon: ModeledSource | null = null;
  /**
   * Optional Steam Audio backend (when `?engine=steam`). When set, the beacon is a
   * `steamBeacon` source driven through it, and both `beacon`/`modeledBeacon` above
   * are null. Its listener + `step` are driven each frame from `tick`. Null on the
   * default (our-engine) path.
   */
  private steam: SpatialBackend | null = null;
  private steamBeacon: SteamSourceHandle | null = null;
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
   * Level identity + run-timing for SCORING. `levelId` labels the result (the host
   * passes the picked level's id/name); `startMs` is the monotonic level-start
   * timestamp (audio clock, ms) captured at construction; `clapsUsed` is an injected
   * getter the host wires to its ClapBudget (returns 0 when omitted, e.g. clap-free
   * levels). All additive — none of it touches navigation/win/lose behaviour.
   */
  private readonly levelId: string;
  private readonly startMs: number;
  private readonly clapsUsedFn: () => number;
  /** The scored result of the completed run, available after a win (else null). */
  private lastResultValue: LevelResult | null = null;
  /**
   * Live monster runtime, one entry per level monster. Each has a PURE AI state
   * (monster.ts) and its own spatialized growl voice through an HrtfSource, so a
   * chasing monster Dopplers/glides as it nears. Empty (and zero per-frame cost)
   * when the level has no monsters. See docs/engine/monster-chase.md.
   */
  private monsters: {
    state: MonsterState;
    src: PositionedVoice;
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
    steam: SpatialBackend | null = null,
    interpRenderer: InterpolatingHrtfRenderer | null = null,
    scoring: { levelId?: string; clapsUsed?: () => number } = {},
  ) {
    this.levelId = scoring.levelId ?? 'unknown';
    this.clapsUsedFn = scoring.clapsUsed ?? (() => 0);
    // Level-start timestamp for the completion timer (monotonic audio clock, ms).
    // Matches the clock `step()`/`tick()` default, avoiding Date.now() so the timing
    // is consistent with the rest of the game loop.
    this.startMs = graph.ctx.currentTime * 1000;
    this.interpRenderer = interpRenderer;
    this.graph = graph;
    this.renderer = renderer;
    this.level = level;
    this.cb = cb;
    this.steam = steam;
    this.headHeight = level.headHeight ?? 1.6;
    this.player = new Player({ x: level.start.x, z: level.start.z, yaw: level.start.yaw }, stepCfg);
    this.footsteps = new Footsteps(graph, renderer);
    // Reflecting footsteps: when the level has acoustic geometry, route steps through
    // a room-IR convolver sourced at the FOOT, so each step echoes off the walls and
    // openings. Without geometry (or in the trainer) Footsteps stays dry/panned.
    if ((this.level.acousticWalls?.length ?? 0) > 0) {
      this.footstepRoom = new FootstepRoom(graph, renderer);
      this.footsteps.setRoom(this.footstepRoom);
    }
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
    if (this.steam) {
      // Steam Audio path: the beacon's dry voice feeds a Steam Audio source. The
      // level geometry is pushed into the Steam Audio scene; the listener + source
      // positions + world.step are driven from the game loop (applyAudioPose/tick).
      this.steam.setGeometry(level.acousticWalls ?? []);
      this.steamBeacon = this.steam.createSource();
      this.beaconInput = this.steamBeacon.input as GainNode;
      this.beaconOutput = this.steamBeacon.output as GainNode;
    } else if (level.acousticWalls && level.acousticWalls.length > 0) {
      // Pass the interpolating renderer (?hrtf=interp) so the modeled beacon's
      // REFLECTIONS are rendered through the click-free, head-tracked worklet instead
      // of the convolver buffer-swap (the turn-click). null → old convolver fallback.
      this.modeledBeacon = new ModeledSource(graph.ctx, graph.master, renderer.set, this.interpRenderer);
      this.beaconInput = this.modeledBeacon.input;
      this.beaconOutput = this.modeledBeacon.output;
      // (the initial solve happens at the end of the constructor, once the start
      // pose is set — see this.refreshBeacon() below)
    } else if (this.interpRenderer) {
      // CLICK-FREE path: render the beacon through the interpolating worklet.
      this.interpBeacon = this.interpRenderer.createSource();
      this.interpBeacon.output.connect(graph.master);
      this.beaconInput = this.interpBeacon.input;
      this.beaconOutput = this.interpBeacon.output;
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
      // Route the monster through the SELECTED engine (Steam Audio when active, else
      // our HrtfSource), so the whole scene is spatialized by one engine.
      const src = this.makePositionedSource();
      // Start the synth voice immediately so the monster is never silent. If a
      // `soundUrl` is set, the shared helper loops that recording through the SAME
      // source (so it spatializes / Dopplers as the monster chases) and we swap
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

    this.setDecoyBudget(level.decoyBudget);
    this.syncListener();
    // Solve the modeled beacon once for the start pose so the very first frame of
    // audio is already correct (occluded/diffracted as appropriate), rather than
    // silent until the first tick. No-op for the plain-HrtfSource fallback.
    this.refreshBeacon();
  }

  /**
   * Create a positioned voice through the ACTIVE engine: a Steam Audio source when
   * `?engine=steam` is selected, otherwise our straight-line `HrtfSource`. Both
   * expose `{ input, output, setPosition, teardown }`, so callers (monsters today;
   * the beacon could share this once the modeled fallback is folded in) don't care
   * which engine is live. The output is wired to the master bus.
   */
  private makePositionedSource(): PositionedVoice {
    if (this.steam) {
      const h = this.steam.createSource();
      return { input: h.input, output: h.output, setPosition: h.setPosition, teardown: h.dispose };
    }
    const src = this.renderer.createSource();
    src.output.connect(this.graph.master);
    return {
      input: src.input,
      output: src.output,
      setPosition: (x, y, z) => src.setPosition(x, y, z),
      teardown: () => src.disconnect(),
    };
  }

  /**
   * Build the beacon's dry source. If the level's beacon has a `soundUrl`, try to
   * play it looped (fetch + decode, cached); otherwise — or on failure — play the
   * chosen synth preset (default 'tone'). Both feed `this.beacon.input`.
   */
  private startBeaconSource() {
    // "Find the absorber" mode: no beacon voice. The room is revealed by clapping;
    // the goal is the silent dead spot, so we never start a beacon sound.
    if (this.level.goal === 'absorber') return;
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
    // The dry voice feeds the spatializer input directly; real 1/r distance
    // attenuation is modeled downstream in the renderer.
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
    if (this.interpRenderer) {
      this.interpRenderer.setListener({ x: pose.x, y: this.headHeight, z: pose.z, yaw: this.audioYaw });
    }
    if (this.interpBeacon) {
      this.interpBeacon.setPosition(this.level.beacon.x, this.headHeight, this.level.beacon.z);
      return;
    }
    if (this.steam && this.steamBeacon) {
      // Steam Audio path: drive its listener + beacon source position. world.step
      // (the actual sim) is pumped from tick(). The HRTF renderer listener above is
      // still updated for footsteps/monsters (our engine), which keep using it.
      this.steam.setListener(pose.x, this.headHeight, pose.z, this.audioYaw);
      this.steamBeacon.setPosition(this.level.beacon.x, this.headHeight, this.level.beacon.z);
      return;
    }
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
   * Build the per-step reflecting-footstep context: the head (listener) at the
   * current audio pose and the sound's source at the foot position, offset slightly
   * to the stepping foot's side so L/R steps originate from where the foot lands.
   * Returns undefined when the level has no reflecting-footstep engine (stay dry).
   */
  private stepRoomCtx(footX: number, footZ: number, foot?: Foot): StepRoomCtx | undefined {
    if (!this.footstepRoom) return undefined;
    let sx = footX, sz = footZ;
    if (foot) {
      // Lateral offset (perpendicular to heading) to the foot's side, ~0.15 m.
      const side = foot === 'L' ? -0.15 : 0.15;
      sx += Math.cos(this.audioYaw) * side;
      sz += Math.sin(this.audioYaw) * side;
    }
    const lp = this.listenerPos;
    return {
      walls: this.level.acousticWalls ?? [],
      edges: this.level.acousticEdges,
      listener: [lp.x, this.headHeight, lp.z],
      // Feet are on the floor — source near ground level so floor/wall bounce is right.
      source: [sx, 0.1, sz],
      yaw: this.audioYaw,
      maxOrder: 1,
      scattering: this.level.acousticScattering ?? 0.1,
      speedOfSound: this.level.speedOfSound,
    };
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
    const t = this.winTarget();
    const d = this.player.distanceTo(t.x, t.z);
    this.cb.onProgress?.(d);
  }

  /**
   * DEBUG snapshot for the `?debug=1` overlay: the live pose + geometry + what the
   * acoustics engine is currently rendering. Read-only; safe to poll per frame.
   */
  debugState() {
    const s = this.player.state;
    return {
      player: { x: s.x, z: s.z, yaw: this.audioYaw },
      beacon: { x: this.level.beacon.x, z: this.level.beacon.z },
      goal: this.level.goal ?? 'beacon',
      goalTarget: this.winTarget(),
      walls: this.level.acousticWalls ?? [],
      distance: this.player.distanceTo(this.winTarget().x, this.winTarget().z),
      engine: this.steam ? 'steam' : this.interpRenderer ? 'interp' : 'legacy',
      reflections: this.modeledBeacon?.debugReflections() ?? [],
      decoysLeft: this.decoysLeft,
      monsters: this.monsters.map((m) => ({ x: m.state.x, z: m.state.z })),
      floors: this.level.floors ?? [],
    };
  }

  /**
   * Advance the active audio glide. Driven once per animation frame from the host
   * loop (main.ts). A no-op when no glide is running, so it never thrashes
   * AudioParams while idle.
   */
  tick(nowMs = this.graph.ctx.currentTime * 1000) {
    this.glide.tick(nowMs);
    // Steam Audio path: pump the sim (occlusion raycast + reflection trace) by the
    // per-frame dt so moving listener/source occlusion + reflections track motion.
    if (this.steam) {
      const dtMs = this.lastTickMs == null ? 16 : Math.max(0, nowMs - this.lastTickMs);
      this.steam.step(dtMs / 1000);
    }
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
    // Steam Audio: rebuild its static scene from the live walls (moving-wall levels).
    // commit() rebuilds the BVH; cheap enough at the moving-walls throttle.
    this.steam?.setGeometry(walls);
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
        this.footsteps.bump(hitWall.material, this.stepRoomCtx(before.x, before.z, foot));
        // Loud noise spike at the bump position (where the player still stands).
        this.emitNoise(makeNoiseEvent('bump', before.x, before.z, hitWall.material, nowMs));
        this.cb.onStumble?.('wall');
        this.syncListener();
        return;
      }
      // After standing still, the feet came together — soft reset cue.
      if (result.outcome.settled) this.footsteps.feetTogether(this.stepRoomCtx(s.x, s.z));
      const floorMat = this.floorMaterialAt(s.x, s.z);
      this.footsteps.step(result.outcome.foot, floorMat, this.stepRoomCtx(s.x, s.z, result.outcome.foot));
      // Positioned noise at the step's landing point; loudness from the floor
      // material (loud on gravel, near-silent on carpet/foam).
      this.emitNoise(makeNoiseEvent('step', s.x, s.z, floorMat, nowMs));
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
      this.footsteps.stumble(this.stepRoomCtx(s.x, s.z));
      // Loud noise spike at the player's position (stumbling is loud on any floor).
      this.emitNoise(makeNoiseEvent('stumble', s.x, s.z, this.floorMaterialAt(s.x, s.z), nowMs));
      this.cb.onStumble?.(result.outcome.reason);
    }
  }

  /**
   * Emit a player noise into the tracker AND, when the level has monsters, fire
   * the `onHeard` cue if this noise is loud enough RIGHT NOW to attract a monster
   * (its decayed loudness clears the attraction threshold) — the "You were heard!"
   * stealth feedback. Mirrors the monster's own retarget test so the cue and the
   * AI agree about what's audible.
   */
  private emitNoise(event: NoiseEvent) {
    this.noise.emit(event);
    if (this.monsters.length === 0) return;
    if (decayedLoudness(event, event.tMs) >= DEFAULT_NOISE_THRESHOLD) {
      this.cb.onHeard?.(event);
    }
  }

  /** Remaining decoy throws (Infinity ⇒ unlimited). */
  private decoysLeft = Infinity;
  /** Set the decoy budget (number of throws; omit/undefined ⇒ unlimited). */
  setDecoyBudget(n: number | undefined) {
    this.decoysLeft = n == null ? Infinity : Math.max(0, n);
  }
  /** Decoys still available to throw. */
  get decoyBudget(): number { return this.decoysLeft; }

  /**
   * THROW A SOUND DECOY (the stealth verb). Lands a loud one-shot noise a few
   * metres ahead of the player's facing: emits a `NoiseEvent` at the landing spot
   * (so the noise-hunting monster investigates THERE instead of the player's trail)
   * and plays a short spatialized clack at that position. Eyes-free: the caller
   * announces "Decoy thrown." via `onDecoy`. Returns false (no-op) when the run has
   * ended or the decoy budget is exhausted.
   */
  throwDecoy(nowMs = this.graph.ctx.currentTime * 1000): boolean {
    if (this.ended) return false;
    if (this.decoysLeft <= 0) return false;
    const s = this.player.state;
    // Land it DECOY_THROW_DIST metres ahead of the player's facing (yaw 0 = -z).
    const dist = 4;
    const lx = s.x + Math.sin(s.yaw) * dist;
    const lz = s.z - Math.cos(s.yaw) * dist;
    // A loud, fresh noise at the landing point — out-weighting the player's own
    // (typically quieter, fading) trail so the monster commits to the decoy.
    this.noise.emit({ x: lx, z: lz, loudness: 1.0, kind: 'bump', tMs: nowMs });
    // A short spatialized clack at the landing spot through a one-shot HRTF source.
    this.playClack(lx, lz);
    if (this.decoysLeft !== Infinity) this.decoysLeft -= 1;
    this.cb.onDecoy?.(this.decoysLeft);
    return true;
  }

  /**
   * A short pebble-clack played at world (x,z) through a transient positioned voice
   * (the active engine's spatializer), so the decoy lands audibly out there. The
   * voice tears itself down once the clack finishes. Ear-cue only (not unit-tested).
   */
  private playClack(x: number, z: number) {
    const ctx = this.graph.ctx;
    const voice = this.makePositionedSource();
    voice.setPosition(x, this.headHeight, z);
    const t = ctx.currentTime;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.8, t + 0.005);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    // A bright noise burst + a click tone for a pebble "tock".
    const n = Math.ceil(0.12 * ctx.sampleRate);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) ch[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1400;
    bp.Q.value = 1.2;
    noise.connect(bp).connect(env).connect(voice.input);
    noise.start(t);
    noise.stop(t + 0.2);
    noise.onended = () => { try { voice.teardown(); } catch { /* noop */ } };
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

  /**
   * The win target: the explicit `goalTarget` in 'absorber' (the patch) or
   * 'escape' (the exit) modes, else the beacon.
   */
  private winTarget(): { x: number; z: number } {
    if ((this.level.goal === 'absorber' || this.level.goal === 'escape') && this.level.goalTarget) {
      return this.level.goalTarget;
    }
    return { x: this.level.beacon.x, z: this.level.beacon.z };
  }

  private checkWin() {
    const t = this.winTarget();
    const d = this.player.distanceTo(t.x, t.z);
    if (d <= this.level.goalRadius && !this.won) {
      this.won = true;
      // Fade the beacon out on win.
      this.beaconOutput.gain.setTargetAtTime(0, this.graph.ctx.currentTime, 0.3);
      // Victory flourish: a short, distinct arrival chime through the master bus so
      // a win is as audible as the catch roar (it was near-silent before).
      winChime(this.graph.ctx, this.graph.master);
      this.cb.onWin?.();
      // SCORING (additive): build the completion result off the audio clock + the
      // injected clap counter, expose it via lastResult(), and hand it to the host
      // for persistence/announcement. Runs AFTER onWin so it never alters that path.
      const timeMs = Math.max(0, this.graph.ctx.currentTime * 1000 - this.startMs);
      this.lastResultValue = {
        levelId: this.levelId,
        timeMs,
        clapsUsed: Math.max(0, Math.floor(this.clapsUsedFn())),
        won: true,
      };
      this.cb.onComplete?.(this.lastResultValue);
    }
  }

  /** The scored result of the completed run (null until a win). */
  lastResult(): LevelResult | null {
    return this.lastResultValue;
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
    this.steamBeacon?.dispose();
    for (const m of this.monsters) {
      m.voice?.stop();
      if (m.custom) {
        try { m.custom.stop(); } catch { /* already stopped */ }
        m.custom = null;
      }
      m.src.teardown();
    }
    this.monsters = [];
  }
}

/**
 * A short, pleasant arrival chime played on win — a bright ascending major
 * arpeggio (root, third, fifth, octave) with a soft bell-like decay, routed to the
 * master bus front-and-centre (not spatialized) so success is unmistakable. Mirrors
 * MonsterVoice.roar's self-contained, self-cleaning shape. Ear-verified, not unit-tested.
 */
export function winChime(ctx: BaseAudioContext, dest: AudioNode) {
  const t0 = ctx.currentTime;
  const out = ctx.createGain();
  out.gain.value = 0.6;
  out.connect(dest);
  // C5 major arpeggio rolled upward.
  const notes = [523.25, 659.25, 783.99, 1046.5];
  let last: OscillatorNode | null = null;
  notes.forEach((f, i) => {
    const t = t0 + i * 0.09;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = f;
    // A soft octave shimmer on top for sparkle.
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.5, t + 0.012);
    env.gain.exponentialRampToValueAtTime(0.0008, t + 0.7);
    osc.connect(env).connect(out);
    osc.start(t);
    osc.stop(t + 0.75);
    last = osc;
  });
  if (last) (last as OscillatorNode).onended = () => { try { out.disconnect(); } catch { /* noop */ } };
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
