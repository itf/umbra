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
import { ReactionScorer, occlusionModulation, type ReactionEvent, type ReactionScore } from './events';
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

/** One beacon's placement + voice spec (a positioned, audible source). */
export interface BeaconSpec {
  /** Author id (from the level). Needed for SEQUENCE mode to order beacons; optional
   *  for legacy/single-beacon levels that never reference beacons by id. */
  id?: string;
  x: number; z: number; freq: number; sound?: BeaconPreset; soundUrl?: string;
}

/** One AMBIENT (non-goal) positioned source: spatialized like a beacon, never a goal. */
export interface AmbientSpec {
  id: string;
  x: number; z: number; freq: number; sound: BeaconPreset; gain: number; soundUrl?: string;
}

export interface GameLevel {
  start: { x: number; z: number; yaw: number };
  /**
   * The FIRST beacon (= `beacons[0]`). Kept as a single field for back-compat
   * readers (tests, the win-target default) — DO NOT remove. The full set the game
   * spatializes is `beacons` below; for a single-beacon level the two are the same.
   */
  beacon: BeaconSpec;
  /**
   * ALL beacons in the level. Each gets its own spatializer (chosen by the same
   * steam/modeled/interp/plain logic) + its own voice. A length-1 array behaves
   * byte-identically to the legacy single-beacon path. `beacon` mirrors `beacons[0]`.
   */
  beacons: BeaconSpec[];
  /**
   * AMBIENT (non-goal) positioned sources. Each gets its own spatializer + voice,
   * exactly like a beacon, but is NEVER a win target and never fades on win. Empty
   * (and zero cost) when the level has none. Exposed for the reaction mechanic so an
   * event can occlude/leak a named source. See Part B/C.
   */
  ambience?: AmbientSpec[];
  /**
   * REACTION EVENTS (Part C) — timed events to react to. Driven from tick(); each
   * occludes ('crossing') or leaks ('door') its named ambient source while active and
   * plays a transient at start/end. Scored via the pure ReactionScorer. Empty ⇒ none.
   */
  events?: ReactionEvent[];
  /** Win gate: minimum HITS required to win (with reaching the area). 0/undefined ⇒ ungated. */
  requiredReactions?: number;
  /**
   * DECOUPLED WIN TARGET — the place to reach to win in normal ('beacon') mode,
   * independent of any beacon. Absent ⇒ defaults to `beacons[0]` (today's
   * behaviour). 'absorber'/'escape' modes keep using `goalTarget`.
   */
  winTarget?: { x: number; z: number };
  /**
   * SEQUENCE (trail) mode: ordered beacon ids. Only the current beacon in the trail
   * sounds; reaching it (its goalRadius) silences it and starts the next. The win is
   * reaching the LAST — but the audio gating leads the player through all in order.
   * Absent/short (<2) ⇒ normal all-beacons-audible behaviour. See tickSequence().
   */
  sequence?: string[];
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
  /**
   * The level's ROOM box (width × depth × height, metres). Used by the optional
   * pathing backend to place its probe grid over the whole room — the room extent,
   * NOT the interior walls (a wall-less room still has a room). Absent ⇒ the backend
   * falls back to the wall AABB.
   */
  acousticRoomBounds?: { width: number; depth: number; height: number };
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
  /**
   * Rebuild the acoustic scene from `walls`. `roomBounds` (the level's room box) is
   * used only by the optional pathing backend to place its probe grid over the WHOLE
   * room — walls are interior dividers, not the room extent, so a wall-less room still
   * needs probes. Optional/back-compatible: our engine ignores it.
   */
  setGeometry(walls: WallDef[], roomBounds?: { width: number; depth: number; height: number }): void;
  setListener(x: number, y: number, z: number, yaw: number): void;
  step(deltaSeconds: number): void;
  /**
   * LIGHT live hot-swap of the two BUS levels (0..1 multipliers on the reflection +
   * reverb bus wets AND each source's matching send) on the already-running backend.
   * Optional: a backend that can't re-scale them omits it. Implemented by SteamAudioBackend.
   */
  setBusLevels?(reflectionBusLevel: number, reverbBusLevel: number): void;
  /**
   * Store the 0..1 per-source reflected-field `wet` multiplier. Optional. The baked
   * `wet` only changes on a source REBUILD, so the caller rebuilds after this.
   * Implemented by SteamAudioBackend.
   */
  setReflectionWetLevel?(v: number): void;
  /**
   * Release the backend's resources. Optional. Used when a backend built for a live
   * "Apply" is discarded because the run was torn down mid-build (so it isn't leaked).
   */
  dispose?(): void;
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

/**
 * One beacon's full audio runtime: the chosen spatializer (exactly one of
 * plain/interp/modeled/steam, picked by the SAME logic the single beacon used),
 * the dry-voice `input` + master-bound `output` (the fade target), and its own
 * synth voice / custom loop. A length-1 array of these reproduces the legacy
 * single-beacon wiring byte-for-byte.
 */
interface BeaconUnit {
  spec: BeaconSpec;
  input: GainNode;
  output: GainNode;
  voice: BeaconVoice | null;
  custom: AudioBufferSourceNode | null;
  plain: HrtfSource | null;
  interp: InterpolatingHrtfSource | null;
  modeled: ModeledSource | null;
  steam: SteamSourceHandle | null;
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
  /**
   * SEQUENCE (trail) mode: fired when the player reaches a trail beacon and the sound
   * advances to the next. `index` is the new (1-based) position, `total` the trail
   * length — so the host can speak "Beacon 2 of 4 — follow the next sound." Only fires
   * in sequence levels.
   */
  onSequenceAdvance?: (index: number, total: number) => void;
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
  /**
   * Fired on each react() press with its signal-detection outcome (Part C), so the
   * host can speak "Detected." / "False alarm." (eyes-free). 'ignored' = a redundant
   * press during an already-credited event (no cue needed).
   */
  onReaction?: (outcome: 'hit' | 'false-alarm' | 'ignored', score: ReactionScore) => void;
  /**
   * Fired when a reaction event ENDS with no press (a MISS), so the host can speak
   * "Missed one." Part C.
   */
  onMissed?: (score: ReactionScore) => void;
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
   * Optional CLICK-FREE interpolating HRTF renderer (?hrtf=interp). When provided
   * AND the level has no acoustic geometry/steam, beacons are rendered through the
   * AudioWorklet that continuously interpolates the measured HRIRs (no convolver
   * swap → no bucket-crossing click). Engine-level (shared by all units).
   */
  private interpRenderer: InterpolatingHrtfRenderer | null = null;
  /**
   * Optional Steam Audio backend (when `?engine=steam`). When set, each beacon is a
   * Steam Audio source driven through it. Its listener + `step` are driven each
   * frame from `tick`. Null on the default (our-engine) path. Engine-level.
   */
  private steam: SpatialBackend | null = null;
  /**
   * Every beacon, as a uniform unit. Each picks its spatializer by the SAME
   * steam/modeled/interp/plain logic and carries its own voice/custom loop. A
   * length-1 array is byte-identical to the legacy single-beacon path.
   */
  private beacons: BeaconUnit[] = [];
  private headHeight: number;
  private won = false;
  private caught = false;
  /**
   * Free-roam ("Explore") mode: once set, the win is disabled so the player can walk
   * the finished room freely with the beacons still sounding. Entered via
   * enterFreeRoam() from the post-win victory menu; never affects a normal run.
   */
  private freeRoam = false;
  /**
   * SEQUENCE (trail) mode runtime. `sequenceUnits` is the ordered beacon units the
   * trail visits (resolved from level.sequence ids); `sequenceIndex` is the current
   * target in it. Only the current unit sounds; reaching it advances the index and
   * hands audibility to the next. Empty ⇒ not a sequence level (normal behaviour).
   */
  private sequenceUnits: BeaconUnit[] = [];
  private sequenceIndex = 0;
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
  /**
   * Live AMBIENT (non-goal) sources — fountains, AC units. Each is a positioned voice
   * through the active engine plus a per-source DUCK chain (a gain + lowpass between
   * the dry voice and the spatializer) so a reaction EVENT (Part C) can occlude
   * (attenuate + muffle) or LEAK (boost + brighten) it. Keyed by id for events.
   */
  private ambience: {
    spec: AmbientSpec;
    src: PositionedVoice;
    voice: BeaconVoice | null;
    custom: AudioBufferSourceNode | null;
    /** Steady level (spec.gain) — the base the duck/leak multiplies. */
    baseGain: number;
    /** Duck/leak gain node (1 = normal). */
    duck: GainNode;
    /** Duck/leak lowpass (high cutoff = normal/bright; low = muffled). */
    lp: BiquadFilterNode;
  }[] = [];
  /** User BEACON VOLUME (0..1) — applied to every beacon voice's output, live. */
  private beaconVolume = 1;
  /**
   * Reaction mechanic (Part C). The pure scorer + the set of event ids currently in
   * their active window (to apply modulation/transients on the rising/falling edge)
   * and the set already finalized as MISS (to fire onMissed once). Inert when the
   * level has no events.
   */
  private readonly reaction: ReactionScorer;
  private reactionActive = new Set<string>();
  private reactionMissed = new Set<string>();
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
    this.reaction = new ReactionScorer(level.events ?? []);
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
    // Steam Audio path: the level geometry is pushed into the Steam Audio scene
    // ONCE (shared by all beacon sources). Per-unit sources are created below.
    if (this.steam) this.steam.setGeometry(level.acousticWalls ?? [], level.acousticRoomBounds);
    // Build one uniform unit per beacon, each choosing its spatializer by the SAME
    // steam/modeled/interp/plain logic, and start its voice. For a single-beacon
    // level this is byte-identical to the legacy singular wiring.
    for (const spec of level.beacons) {
      const u = this.makeBeaconUnit(spec);
      this.beacons.push(u);
      this.startBeaconSource(u);
    }

    // SEQUENCE (trail) mode: resolve the ordered unit list from the level's beacon ids
    // and silence every beacon EXCEPT the first in the trail, so only the current goal
    // sounds. Reaching it hands the sound to the next (tickSequence). No-op otherwise.
    if (level.sequence && level.sequence.length >= 2) {
      const byId = new Map(this.beacons.map((u) => [u.spec.id, u] as const));
      this.sequenceUnits = level.sequence
        .map((id) => byId.get(id))
        .filter((u): u is BeaconUnit => u != null);
      if (this.sequenceUnits.length >= 2) {
        const active = this.sequenceUnits[0];
        // Silence all trail beacons but the first (immediate — pre-play, no fade needed;
        // set .value directly so it takes effect without waiting for a render).
        for (const u of this.sequenceUnits) {
          if (u !== active) u.output.gain.value = 0;
        }
      } else {
        this.sequenceUnits = []; // fewer than 2 resolved → not a real trail
      }
    }

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

    // Ambient (non-goal) sources: a positioned voice through the active engine, with
    // a duck/leak chain (gain + lowpass) the reaction events modulate. Never a goal,
    // never fades on win. No-op when the level has none.
    for (const spec of level.ambience ?? []) {
      const src = this.makePositionedSource();
      const duck = this.graph.ctx.createGain();
      duck.gain.value = 1;
      const lp = this.graph.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 18000; // wide open = unmuffled by default
      // dry voice → duck → lowpass → spatializer input.
      duck.connect(lp).connect(src.input);
      src.setPosition(spec.x, this.headHeight, spec.z);
      const baseGain = Math.max(0, spec.gain);
      duck.gain.value = baseGain;
      const voice = new BeaconVoice(this.graph.ctx, duck, resolveBeaconPreset(spec.sound), spec.freq);
      voice.setVolume(this.beaconVolume);
      voice.start();
      const entry: (typeof this.ambience)[number] = { spec, src, voice, custom: null, baseGain, duck, lp };
      this.ambience.push(entry);
      if (spec.soundUrl) {
        void attachCustomLoop(
          this.graph.ctx, duck, spec.soundUrl,
          () => { /* keep the synth ambience already running */ },
          { shouldStart: () => entry.custom == null },
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
   * Build ONE beacon's spatializer unit, choosing exactly one engine branch by the
   * SAME priority the single beacon used: steam → modeled (acoustic geometry) →
   * interp (?hrtf=interp) → plain HrtfSource. `input` is where the dry voice feeds,
   * `output` is the master-bound gain (the fade target). The Steam scene geometry is
   * set ONCE by the caller before the unit loop (not here).
   */
  private makeBeaconUnit(spec: BeaconSpec): BeaconUnit {
    const graph = this.graph;
    const level = this.level;
    const u: BeaconUnit = {
      spec, input: null as unknown as GainNode, output: null as unknown as GainNode,
      voice: null, custom: null, plain: null, interp: null, modeled: null, steam: null,
    };
    if (this.steam) {
      // Steam Audio path: the beacon's dry voice feeds a Steam Audio source. The
      // listener + source positions + world.step are driven from the game loop.
      u.steam = this.steam.createSource();
      u.input = u.steam.input as GainNode;
      u.output = u.steam.output as GainNode;
    } else if (level.acousticWalls && level.acousticWalls.length > 0) {
      // Pass the interpolating renderer (?hrtf=interp) so the modeled beacon's
      // REFLECTIONS are rendered through the click-free, head-tracked worklet instead
      // of the convolver buffer-swap (the turn-click). null → old convolver fallback.
      u.modeled = new ModeledSource(graph.ctx, graph.master, this.renderer.set, this.interpRenderer);
      u.input = u.modeled.input;
      u.output = u.modeled.output;
      // (the initial solve happens at the end of the constructor — refreshBeacon())
    } else if (this.interpRenderer) {
      // CLICK-FREE path: render the beacon through the interpolating worklet.
      u.interp = this.interpRenderer.createSource();
      u.interp.output.connect(graph.master);
      u.input = u.interp.input;
      u.output = u.interp.output;
    } else {
      u.plain = this.renderer.createSource();
      u.plain.output.connect(graph.master);
      u.input = u.plain.input;
      u.output = u.plain.output;
    }
    return u;
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
  private startBeaconSource(u: BeaconUnit) {
    // "Find the absorber" mode: no beacon voice. The room is revealed by clapping;
    // the goal is the silent dead spot, so we never start a beacon sound.
    if (this.level.goal === 'absorber') return;
    // Always start the synth preset immediately so the beacon is never silent.
    // If a custom `soundUrl` is set, the shared helper loads + loops it through the
    // SAME source and we swap to it when it arrives; on failure the synth stays.
    this.startSynthBeacon(u);
    const url = u.spec.soundUrl;
    if (!url) return;
    // onFallback is a no-op here: the synth is already playing as the fallback.
    // shouldStart vetoes a late buffer if the beacon was won (and faded) meanwhile.
    void attachCustomLoop(
      this.graph.ctx,
      u.input,
      url,
      () => { /* keep the synth fallback already running */ },
      { shouldStart: () => !this.won && u.custom == null },
    ).then((handle) => {
      if (!handle.source) return;
      // Swap: the custom loop is now playing, stop the synth preset.
      u.voice?.stop();
      u.voice = null;
      u.custom = handle.source;
    });
  }

  /** Start (or restart) the synthesized preset voice for one unit. */
  private startSynthBeacon(u: BeaconUnit) {
    const preset: BeaconPreset = resolveBeaconPreset(u.spec.sound);
    u.voice?.stop();
    // The dry voice feeds the spatializer input directly; real 1/r distance
    // attenuation is modeled downstream in the renderer.
    u.voice = new BeaconVoice(this.graph.ctx, u.input, preset, u.spec.freq);
    u.voice.setVolume(this.beaconVolume);
    u.voice.start();
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
    // Steam Audio path: drive its (shared) listener once. world.step is pumped from
    // tick(). The HRTF renderer listener above is still updated for footsteps/monsters.
    if (this.steam) this.steam.setListener(pose.x, this.headHeight, pose.z, this.audioYaw);
    let anyModeled = false;
    for (const u of this.beacons) {
      if (u.interp) {
        u.interp.setPosition(u.spec.x, this.headHeight, u.spec.z);
      } else if (u.steam) {
        u.steam.setPosition(u.spec.x, this.headHeight, u.spec.z);
      } else if (u.plain) {
        // Plain (fallback) beacon: straight-line spatializer, repositioned per frame.
        u.plain.setPosition(u.spec.x, this.headHeight, u.spec.z);
      } else if (u.modeled) {
        anyModeled = true;
      }
    }
    // Modeled beacons: re-solve the room for the new listener pose (throttled).
    if (anyModeled) this.refreshBeacon(pose.x, pose.z);
    // Ambient sources track the listener exactly like beacons (straight-line spatial).
    for (const a of this.ambience) a.src.setPosition(a.spec.x, this.headHeight, a.spec.z);
  }

  /**
   * Apply a reaction-event modulation to a NAMED ambient source: a multiplicative
   * gain `factor` (0..N) on top of its steady level and a lowpass cutoff `cutoffHz`
   * (low ⇒ muffled/occluded; high ⇒ bright/leaking). Smoothed so it doesn't click.
   * No-op for an unknown id. Used by Part C's event loop (occlusion dip / door leak).
   */
  setAmbientModulation(id: string, factor: number, cutoffHz: number) {
    const a = this.ambience.find((e) => e.spec.id === id);
    if (!a) return;
    const t = this.graph.ctx.currentTime;
    a.duck.gain.setTargetAtTime(Math.max(0, a.baseGain * factor), t, 0.08);
    a.lp.frequency.setTargetAtTime(Math.max(80, cutoffHz), t, 0.08);
  }

  /**
   * Re-solve the MODELED beacon's room IR for the current listener pose (occlusion +
   * diffraction). Throttled + dirty-checked inside `ModeledSource.refresh`, so this
   * is safe to call from the per-frame audio path. No-op when the beacon isn't
   * modeled. `lx`/`lz` are the listener world position (logical or glide pose); the
   * beacon position comes from the level.
   */
  private refreshBeacon(lx = this.player.state.x, lz = this.player.state.z) {
    for (const u of this.beacons) {
      if (!u.modeled) continue;
      u.modeled.refresh({
        walls: this.level.acousticWalls ?? [],
        edges: this.level.acousticEdges,
        listener: [lx, this.headHeight, lz],
        yaw: this.audioYaw,
        source: [u.spec.x, this.headHeight, u.spec.z],
        speedOfSound: this.level.speedOfSound,
        // Phase 2: full reflections at order 3. Energy pruning (geometry.rs) keeps the
        // candidate search cheap, and the `orderTapCap` guard auto-drops to a lower
        // order on large low-absorption enclosures (cathedral-class) whose high-order
        // chains stay audible and would otherwise blow the IR-build budget. Each
        // ModeledSource self-throttles, so N beacons just self-pace independently.
        maxOrder: 3,
        orderTapCap: 24,
        scattering: this.level.acousticScattering ?? 0.1,
      });
    }
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
      // Order 2: second-order bounces add the corridor/opening cue worth hearing. A
      // step fires ~1-2×/s and the IR build is throttled in FootstepRoom, so this is
      // far cheaper than the beacon's continuous order-3 solve — the cost is fine.
      maxOrder: 2,
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
      beacons: this.beacons.map((u) => ({ x: u.spec.x, z: u.spec.z })),
      goal: this.level.goal ?? 'beacon',
      goalTarget: this.winTarget(),
      walls: this.level.acousticWalls ?? [],
      distance: this.player.distanceTo(this.winTarget().x, this.winTarget().z),
      engine: this.steam ? 'steam' : this.interpRenderer ? 'interp' : 'legacy',
      reflections: this.beacons.flatMap((u) => u.modeled?.debugReflections() ?? []),
      decoysLeft: this.decoysLeft,
      monsters: this.monsters.map((m) => ({ x: m.state.x, z: m.state.z })),
      ambience: this.ambience.map((a) => ({ id: a.spec.id, x: a.spec.x, z: a.spec.z })),
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
    if (this.beacons.some((u) => u.modeled)) {
      const p = this.glide.current;
      this.refreshBeacon(p.x, p.z);
    }
    this.tickReactions(nowMs);
    this.tickMonsters(nowMs);
    this.tickSequence();
  }

  /**
   * SEQUENCE (trail) mode: when the player reaches the CURRENT trail beacon (within its
   * goalRadius) and it isn't the last, fade it out and fade the NEXT one in, advancing
   * the trail. The win itself is the normal checkWin against the last beacon's position
   * (winTarget). No-op for non-sequence levels, once won/caught, or in free-roam.
   */
  private tickSequence() {
    if (this.sequenceUnits.length < 2 || this.won || this.caught || this.freeRoam) return;
    if (this.sequenceIndex >= this.sequenceUnits.length - 1) return; // last one → checkWin handles it
    const active = this.sequenceUnits[this.sequenceIndex];
    const d = this.player.distanceTo(active.spec.x, active.spec.z);
    if (d > this.level.goalRadius) return;
    // Reached this trail beacon: hand the sound to the next.
    const next = this.sequenceUnits[this.sequenceIndex + 1];
    const t = this.graph.ctx.currentTime;
    active.output.gain.setTargetAtTime(0, t, 0.25);
    next.output.gain.setTargetAtTime(1, t, 0.25);
    this.sequenceIndex++;
    this.cb.onSequenceAdvance?.(this.sequenceIndex, this.sequenceUnits.length);
  }

  /**
   * Drive the reaction events off the elapsed level clock: on an event's RISING edge
   * apply its occlusion/leak to the named ambient source + play its start transient;
   * on the FALLING edge restore the source + play the end transient; and finalize
   * any passed-by event as a MISS (spoken once). Inert when the level has no events.
   */
  private tickReactions(nowMs: number) {
    const events = this.level.events;
    if (!events || events.length === 0 || this.ended) return;
    const t = Math.max(0, (nowMs - this.startMs) / 1000);
    this.reaction.advance(t);
    // Edge-detect active windows to fire start/end audio exactly once.
    const nowActive = new Set<string>();
    for (const e of events) {
      if (t >= e.start && t < e.end) nowActive.add(e.id);
    }
    for (const e of events) {
      const wasActive = this.reactionActive.has(e.id);
      const isActive = nowActive.has(e.id);
      if (isActive && !wasActive) this.onEventStart(e);
      else if (!isActive && wasActive) this.onEventEnd(e);
    }
    this.reactionActive = nowActive;
    // Fire onMissed once per newly-finalized miss.
    const sc = this.reaction.score();
    if (sc.misses > this.reactionMissed.size) {
      // Find which events are now missed (not active, ended, never hit). We can't see
      // the scorer's internals, so just announce per new miss using the count delta.
      const newMisses = sc.misses - this.reactionMissed.size;
      for (let i = 0; i < newMisses; i++) {
        this.reactionMissed.add(`miss-${this.reactionMissed.size}`);
        reactionCue(this.graph.ctx, this.graph.master, 'miss');
        this.cb.onMissed?.(sc);
      }
    }
  }

  /**
   * An event's active window OPENED. By DEFAULT the event emits NO sound of its own —
   * it is detectable ONLY by how the SPACE changes: 'crossing' DUCKS + muffles its
   * source (a body passes between you and it); 'occlusion' is a shallower depth-tuned
   * dip; 'door' OPENS so its source LEAKS (louder + brighter). The change is smoothed
   * (setAmbientModulation) so the transition itself doesn't click. Only when the event
   * opts in with `audibleCue` do we ALSO emit the physical transient (pass-by swoosh /
   * door click) as an easier, more literal hint.
   */
  private onEventStart(e: ReactionEvent) {
    if (e.type === 'crossing') {
      this.setAmbientModulation(e.sourceId, 0.35, 700); // duck + muffle (occluded)
      if (e.audibleCue) this.playPassBy(e.sourceId);
    } else if (e.type === 'occlusion') {
      // PARTLY occluded — a shorter, shallower dip in level + highs (something
      // passes in front of the source, not fully between you and it). Depth-tuned.
      const { factor, cutoffHz } = occlusionModulation(e.depth);
      this.setAmbientModulation(e.sourceId, factor, cutoffHz);
      if (e.audibleCue) this.playPassBy(e.sourceId);
    } else {
      this.setAmbientModulation(e.sourceId, 1.6, 18000); // leak louder + brighter
      if (e.audibleCue) this.playDoorClick(this.ambientPos(e.sourceId), true);
    }
  }

  /**
   * An event's window CLOSED: restore the source to normal. Emits the closing door
   * transient only when the event opted into `audibleCue`.
   */
  private onEventEnd(e: ReactionEvent) {
    this.setAmbientModulation(e.sourceId, 1, 18000); // back to normal
    if (e.type === 'door' && e.audibleCue) this.playDoorClick(this.ambientPos(e.sourceId), false);
  }

  /** World xz of a named ambient source (for placing a transient), or the listener. */
  private ambientPos(id: string): { x: number; z: number } {
    const a = this.ambience.find((e) => e.spec.id === id);
    return a ? { x: a.spec.x, z: a.spec.z } : { x: this.player.state.x, z: this.player.state.z };
  }

  /**
   * REACT — the player pressed the react key/button. Scores the press against the
   * active events (hit / false-alarm / ignored) and reports it for a spoken cue.
   * No-op once the run has ended. Returns the outcome.
   */
  react(nowMs = this.graph.ctx.currentTime * 1000): 'hit' | 'false-alarm' | 'ignored' {
    if (this.ended) return 'ignored';
    const t = Math.max(0, (nowMs - this.startMs) / 1000);
    const outcome = this.reaction.press(t);
    // Audible cue (independent of TTS) so a press is never silent. 'ignored' is a
    // redundant press on an already-credited event — no cue, matching the spoken side.
    if (outcome !== 'ignored') reactionCue(this.graph.ctx, this.graph.master, outcome);
    this.cb.onReaction?.(outcome, this.reaction.score());
    return outcome;
  }

  /** The current reaction tally (Part C). */
  reactionScore(): ReactionScore {
    return this.reaction.score();
  }

  /**
   * A faint pass-by SWOOSH at the source — a short filtered-noise whoosh, panned to
   * the source's direction via a transient HrtfSource. The DETECTION CUE rides mostly
   * on the occlusion dip; this is the subtle physical "something moved past" hint.
   */
  private playPassBy(sourceId: string) {
    const ctx = this.graph.ctx;
    const pos = this.ambientPos(sourceId);
    const src = this.makePositionedSource();
    src.setPosition(pos.x, this.headHeight, pos.z);
    const t = ctx.currentTime;
    const n = Math.floor(ctx.sampleRate * 0.6);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1);
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(900, t);
    bp.frequency.exponentialRampToValueAtTime(1800, t + 0.5);
    bp.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.15);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
    noise.connect(bp).connect(g).connect(src.input);
    noise.start(t);
    noise.stop(t + 0.6);
    noise.onended = () => { try { src.teardown(); } catch { /* noop */ } };
  }

  /** A short door click/creak transient at the source position (open vs close pitch). */
  private playDoorClick(pos: { x: number; z: number }, opening: boolean) {
    const ctx = this.graph.ctx;
    const src = this.makePositionedSource();
    src.setPosition(pos.x, this.headHeight, pos.z);
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    const f0 = opening ? 220 : 180;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(f0 * (opening ? 1.4 : 0.6), t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.18, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    osc.connect(g).connect(src.input);
    osc.start(t);
    osc.stop(t + 0.2);
    osc.onended = () => { try { src.teardown(); } catch { /* noop */ } };
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
    // Frozen once the run is over (won/caught) AND during free-roam Explore — a
    // post-win walkthrough must never turn into a loss.
    if (this.won || this.caught || this.freeRoam) return;

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
        for (const u of this.beacons) u.output.gain.setTargetAtTime(0, t, 0.3);
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
    this.steam?.setGeometry(walls, this.level.acousticRoomBounds);
  }

  /**
   * HEAVY live hot-swap of the spatial backend (engine on/off) on a RUNNING level,
   * WITHOUT restarting it. Tears down ONLY the spatial voices (beacons + monster
   * src/voice/custom — mirroring destroy()), swaps `this.steam`, re-pushes geometry,
   * and rebuilds those voices preserving ALL game state.
   *
   * PRESERVED (never reset): won, caught, ended (derived), decoysLeft (setDecoyBudget
   * is NOT called), audioYaw, glide, noise, lastResultValue, lastTickMs, player,
   * footsteps/footstepRoom, and every monster's PURE MonsterState (reused by reference
   * so a chase in progress continues from exactly where it was).
   *
   * Edge cases honoured: beacons rebuilt already-faded (gain 0) when `this.won`;
   * monster custom-audio loops vetoed when `this.ended` so a finished run stays silent.
   */
  setSpatialBackend(steam: SpatialBackend | null) {
    // Swap the engine + re-push the current geometry into the new backend, then rebuild
    // the spatial voices against it (preserving ALL game state).
    this.steam = steam;
    if (this.steam) this.steam.setGeometry(this.level.acousticWalls ?? [], this.level.acousticRoomBounds);
    this.rebuildVoices();
  }

  /**
   * Tear down ONLY the spatial voices (beacons + monster src/voice/custom — mirroring
   * destroy()) and rebuild them against the CURRENT `this.steam` backend, preserving
   * ALL game state (won/caught/ended/decoysLeft/audioYaw/glide/noise/player/footsteps,
   * and each monster's PURE MonsterState by reference). Used by both `setSpatialBackend`
   * (after it swaps `this.steam`) and `setSteamReflectionWet` (which keeps the same
   * backend but needs new sources to bake the updated per-source reflected `wet`).
   */
  private rebuildVoices() {
    // 1) Tear down ONLY the spatial voices, mirroring destroy() (leave footsteps,
    //    glide, player, noise, and the monster STATE objects untouched).
    for (const u of this.beacons) {
      u.voice?.stop();
      u.voice = null;
      if (u.custom) {
        try { u.custom.stop(); } catch { /* already stopped */ }
        u.custom = null;
      }
      u.plain?.disconnect();
      u.interp?.output.disconnect();
      u.modeled?.disconnect();
      u.steam?.dispose();
    }
    this.beacons = [];
    // Snapshot the monster STATES (kept by reference) so the rebuilt voices resume
    // each monster exactly where its AI left off; then drop the old audio.
    const monsterStates = this.monsters.map((m) => m.state);
    for (const m of this.monsters) {
      m.voice?.stop();
      if (m.custom) {
        try { m.custom.stop(); } catch { /* already stopped */ }
        m.custom = null;
      }
      m.src.teardown();
    }
    this.monsters = [];

    // 2) Rebuild beacons through the current engine. A FINISHED run (won OR caught — both
    //    fade the beacons to 0 in their handlers) rebuilds them already muted so the
    //    swap doesn't un-mute a completed level.
    for (const spec of this.level.beacons) {
      const u = this.makeBeaconUnit(spec);
      this.beacons.push(u);
      this.startBeaconSource(u);
      if (this.ended) u.output.gain.value = 0;
    }

    // 3) Rebuild monsters AT THEIR CURRENT position, reusing the same MonsterState by
    //    reference. A finished run vetoes both the synth voice fade and custom loops.
    monsterStates.forEach((state, i) => {
      // Recover this monster's sound/soundUrl from its level spawn by index (states
      // are snapshotted in level order, so index lines up with `level.monsters`).
      const spawn = this.level.monsters?.[i];
      const src = this.makePositionedSource();
      src.setPosition(state.x, this.headHeight, state.z);
      const preset = resolveMonsterPreset(spawn?.sound ?? 'growl');
      let voice: MonsterVoice | null = null;
      if (!this.ended) {
        voice = new MonsterVoice(this.graph.ctx, src.input, preset);
        voice.start();
      }
      const entry: (typeof this.monsters)[number] = { state, src, voice, custom: null };
      this.monsters.push(entry);
      const soundUrl = spawn?.soundUrl;
      if (soundUrl) {
        void attachCustomLoop(
          this.graph.ctx,
          src.input,
          soundUrl,
          () => { /* keep the synth growl/hum already running */ },
          { shouldStart: () => !this.ended && entry.custom == null },
        ).then((handle) => {
          if (!handle.source) return;
          entry.voice?.stop();
          entry.voice = null;
          entry.custom = handle.source;
        });
      }
    });

    // 4) Re-apply the pose so the new engine's listener + sources are correct
    //    immediately (and the modeled beacon, if any, solves for the start pose).
    this.syncListener();
    this.applyAudioPose(this.glide.current);
    this.refreshBeacon();
  }

  /**
   * LIGHT live hot-swap of the two Steam BUS levels (reflection bus + reverb bus, each
   * 0..1) on the running backend — re-scales the bus wets + each source's matching send
   * in place, no rebuild. No-op when no Steam backend is active or it can't re-scale them.
   */
  setSteamBusLevels(reflectionBusLevel: number, reverbBusLevel: number) {
    this.steam?.setBusLevels?.(reflectionBusLevel, reverbBusLevel);
  }

  /**
   * Apply a new Steam PER-SOURCE reflected-field `wet` level (0..1). The baked `wet`
   * can't change in place, so this stores it on the backend and then REBUILDS the
   * spatial voices (rebuildVoices) so the new sources bake the updated wet — preserving
   * ALL game state. No-op when no Steam backend is active.
   */
  setSteamReflectionWet(v: number) {
    if (!this.steam) return;
    this.steam.setReflectionWetLevel?.(v);
    this.rebuildVoices();
  }

  /** Set the user BEACON VOLUME (0..1) — live, applies to every current beacon voice
   *  and is remembered for voices created later (e.g. on a backend rebuild). */
  setBeaconVolume(v: number) {
    this.beaconVolume = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
    for (const a of this.ambience) a.voice?.setVolume(this.beaconVolume);
  }

  /** Whether a Steam Audio backend is currently active (for the host's Apply logic). */
  get steamActive(): boolean {
    return this.steam != null;
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
    // Normal mode: the decoupled win point if set, else the first beacon (default).
    return this.level.winTarget ?? { x: this.level.beacon.x, z: this.level.beacon.z };
  }

  private checkWin() {
    if (this.freeRoam) return; // Explore mode: the goal is disabled — never re-win.
    const t = this.winTarget();
    const d = this.player.distanceTo(t.x, t.z);
    // Reaction gate: a level with `requiredReactions` only wins once that many HITS
    // are scored AND the player is in the win area. 0/undefined ⇒ ungated.
    const need = this.level.requiredReactions ?? 0;
    const reactionsMet = need <= 0 || this.reaction.score().hits >= need;
    if (d <= this.level.goalRadius && reactionsMet && !this.won) {
      this.won = true;
      // Fade ALL beacons out on win.
      const ft = this.graph.ctx.currentTime;
      for (const u of this.beacons) u.output.gain.setTargetAtTime(0, ft, 0.3);
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

  /**
   * Enter free-roam ("Explore") after a win: clear the won flag so input un-freezes,
   * disable any further win, and fade the beacons back in (checkWin faded them out on
   * arrival). The player can now walk the room with the beacons sounding, no timer,
   * no scoring. Idempotent; a no-op if the run was lost (caught) rather than won.
   */
  enterFreeRoam() {
    if (this.caught) return;
    this.won = false;
    this.freeRoam = true;
    const ft = this.graph.ctx.currentTime;
    for (const u of this.beacons) u.output.gain.setTargetAtTime(1, ft, 0.3);
  }

  destroy() {
    for (const u of this.beacons) {
      u.voice?.stop();
      u.voice = null;
      if (u.custom) {
        try { u.custom.stop(); } catch { /* already stopped */ }
        u.custom = null;
      }
      u.plain?.disconnect();
      u.interp?.output.disconnect();
      u.modeled?.disconnect();
      u.steam?.dispose();
    }
    this.beacons = [];
    for (const m of this.monsters) {
      m.voice?.stop();
      if (m.custom) {
        try { m.custom.stop(); } catch { /* already stopped */ }
        m.custom = null;
      }
      m.src.teardown();
    }
    this.monsters = [];
    for (const a of this.ambience) {
      a.voice?.stop();
      if (a.custom) {
        try { a.custom.stop(); } catch { /* already stopped */ }
        a.custom = null;
      }
      try { a.duck.disconnect(); } catch { /* noop */ }
      try { a.lp.disconnect(); } catch { /* noop */ }
      a.src.teardown();
    }
    this.ambience = [];
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

/**
 * Non-speech audio cue for a reaction outcome, through the master bus so it's
 * audible regardless of the (opt-in, default-off) TTS setting. The live region +
 * TTS still carry the words for screen-reader / eyes-free users; this is the cue
 * a sighted player actually hears. Three distinct shapes:
 *  - hit:         a bright rising two-note ping (rewarding).
 *  - false-alarm: a short low buzz (a gentle "no").
 *  - miss:        a soft descending two-note (a sigh — "that one got past you").
 */
export function reactionCue(
  ctx: BaseAudioContext,
  dest: AudioNode,
  outcome: 'hit' | 'false-alarm' | 'miss',
) {
  const t0 = ctx.currentTime;
  const out = ctx.createGain();
  out.gain.value = 0.5;
  out.connect(dest);
  // (frequency, startOffset) pairs per outcome.
  const spec: { type: OscillatorType; notes: [number, number][] } =
    outcome === 'hit'
      ? { type: 'triangle', notes: [[880, 0], [1318.5, 0.08]] }
      : outcome === 'false-alarm'
        ? { type: 'sawtooth', notes: [[180, 0]] }
        : { type: 'sine', notes: [[520, 0], [392, 0.1]] };
  let last: OscillatorNode | null = null;
  for (const [f, off] of spec.notes) {
    const t = t0 + off;
    const osc = ctx.createOscillator();
    osc.type = spec.type;
    osc.frequency.value = f;
    const env = ctx.createGain();
    const peak = outcome === 'false-alarm' ? 0.28 : 0.4;
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(peak, t + 0.01);
    env.gain.exponentialRampToValueAtTime(0.0008, t + 0.22);
    osc.connect(env).connect(out);
    osc.start(t);
    osc.stop(t + 0.26);
    last = osc;
  }
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
