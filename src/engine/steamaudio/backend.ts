/**
 * SteamAudioBackend — a SELECTABLE spatial-audio backend wrapping a WASM Steam
 * Audio `world`, an ALTERNATIVE to our own `ModeledSource`/`HrtfSource`. It's
 * engaged only via `?engine=steam` (see toggle.ts); the default build never loads
 * it, so `three` (~600 KB) + the 6 MB Steam Audio WASM stay out of the default
 * bundle. Hence everything Steam-Audio- and `three`-specific is reached through a
 * DYNAMIC import inside `create()`.
 *
 * Shape parity with our engine: `createSource()` returns `{ input, output,
 * setPosition, dispose }` — `input` is where the dry beacon/footstep voice feeds,
 * `output` is master-bound — so `game.ts` drives it exactly like a `ModeledSource`.
 * Per frame the host calls `setListener(...)` + `step(dt)`.
 *
 * Graceful failure: if Steam Audio can't initialise (no cross-origin isolation, WASM
 * load failure, …), `create()` throws a clear error so the caller falls back to OUR
 * engine. The game is never left silent.
 *
 * SCOPE: the BEACON and MONSTERS both route through the selected engine — each is a
 * `createSource()` driven from the game loop. See docs/engine/steam-audio-backend.md.
 *
 * NOT unit-tested: Steam Audio needs Web Audio + a WASM worklet + cross-origin
 * isolation, none of which run under vitest. This class is browser/integration
 * verified. The pure conversion logic it relies on lives in convert.ts (tested).
 */
import type { WallDef } from '../acoustics/core';
import { buildSteamScene, type SceneDeps, type MeshData } from './convert';

/** A positioned source, shape-compatible with how game.ts drives a ModeledSource. */
export interface SteamSourceHandle {
  /** Dry voice in (synth/custom loop). */
  input: GainNode;
  /** Master-bound out (a gain, so a fade can ramp `output.gain`). */
  output: GainNode;
  setPosition(x: number, y: number, z: number): void;
  dispose(): void;
}

/** The create-time `wet` of the SHARED reflection bus (multiplied by the bus level). */
export const BUS_BASE_REFL = 1;
/** The create-time `wet` of the SHARED reverb bus (multiplied by the bus level). */
export const BUS_BASE_REVERB = 0.5;

/**
 * The pure recompute of a live source's reflect/reverb SEND gains from its stored
 * BASE sends × the new 0..1 BUS levels. Exported so the multiplier math is unit-
 * testable without a real Steam Audio world. The per-source `reflections.wet` is NOT
 * recomputed here: it's baked into the source at create() (only a REBUILD can change
 * it), and the two BUS sends are what `setBusLevels` re-scales live.
 */
export function recomputeSends(
  base: { reflectSend: number; reverbSend: number },
  reflectionBusLevel: number,
  reverbBusLevel: number,
): { reflectSend: number; reverbSend: number } {
  return {
    reflectSend: base.reflectSend * reflectionBusLevel,
    reverbSend: base.reverbSend * reverbBusLevel,
  };
}

/**
 * A live, tracked Steam Audio source whose reflect/reverb sends can be re-scaled in
 * place (the LIGHT hot-swap). Holds the connection handles returned by
 * connectReflections/connectReverb (each has a live `setGain`) plus the BASE sends so
 * a new level recomputes from the original, not the already-scaled, value.
 */
interface LiveSteamSource {
  reflConn: { setGain: (g: number) => void } | null;
  reverbConn: { setGain: (g: number) => void } | null;
  base: { reflectSend: number; reverbSend: number };
}

/** A quaternion for the listener orientation. */
export interface Quat { x: number; y: number; z: number; w: number; }

export interface SteamBackendOpts {
  /** Use HRTF binaural rendering for sources (matches our HRTF path). */
  hrtf?: boolean;
  /** Representative scattering for walls (our `acousticScattering`). */
  scattering?: number;
  reflections?: { maxDuration?: number; maxOrder?: number; maxRays?: number; diffuseSamples?: number };
  /**
   * Feed OUR measured SADIE SOFA to Steam Audio's custom-HRTF API instead of its
   * generic built-in HRTF. Requires the SOFA-capable `three-steam-audio` fork
   * (feat/sofa-hrtf) as the resolved dependency — the published package doesn't
   * support it and may reject it, so this is OPT-IN (off by default).
   */
  sofaHrtf?: boolean;
  /**
   * Render the reflected/reverberant field as a HEAD-TRACKED Ambisonic decode
   * (order-1, `irTaps`-tap convolution) instead of the published wrapper's
   * mono-duplicated, dead-center parametric reverb. With this on, reflections rotate
   * with the listener so a stronger reflected field no longer masks the head-tracked
   * DIRECT path — which is what lets us raise reflection level back toward
   * material-driven strength (the maze-navigation fix).
   *
   * Requires the head-tracked `three-steam-audio` fork (feat/sofa-hrtf @ b3838eb,
   * vendored under vendor/three-steam-audio) as the resolved dependency. The published
   * package ignores/doesn't understand `reflections.headTracked`, so this is OPT-IN
   * (off by default) and only enabled once the fork is the dep — mirrors `sofaHrtf`.
   */
  headTrackedReflections?: boolean;
  /**
   * User-facing MULTIPLIER (0..1) on the PER-SOURCE reflected-field `wet` (the early
   * geometry field baked into each source). Default 1 (no change). Baked at source
   * create() — only a source REBUILD picks up a new value (the bus levels are live).
   */
  reflectionWetLevel?: number;
  /**
   * User-facing MULTIPLIER (0..1) on the shared REFLECTION BUS wet AND every source's
   * reflect SEND. LIVE-applicable via setBusLevels (no rebuild). Default 1 (no change).
   */
  reflectionBusLevel?: number;
  /**
   * User-facing MULTIPLIER (0..1) on the shared REVERB BUS wet AND every source's
   * reverb SEND. LIVE-applicable via setBusLevels (no rebuild). Default 1 (no change).
   */
  reverbBusLevel?: number;
}

/** URL of OUR measured SADIE SOFA (48 kHz), served from the copied assets tree. */
export const SADIE_SOFA_URL = '/assets/hrtf/sadie_h3_48k.sofa';

/** The fork's `{ type:'sofa', data }` HRTF setting; `null` means use the generic HRTF. */
export type SofaHrtfSetting = { type: 'sofa'; data: ArrayBuffer } | null;

/**
 * Fetch OUR SADIE SOFA as an ArrayBuffer for Steam Audio's custom-HRTF path.
 * Best-effort: any failure (asset missing, non-OK response, fetch throws) resolves to
 * `null` so the caller falls back to Steam's generic HRTF rather than breaking the
 * steam path. Pure-ish + injectable `fetchFn` so the fetch-or-fallback decision is
 * unit-testable without a real network.
 */
export async function loadSofaHrtf(
  fetchFn: typeof fetch = fetch,
  url: string = SADIE_SOFA_URL,
): Promise<SofaHrtfSetting> {
  try {
    const res = await fetchFn(url);
    if (!res.ok) return null;
    const data = await res.arrayBuffer();
    if (!data || data.byteLength === 0) return null;
    return { type: 'sofa', data };
  } catch {
    return null;
  }
}

export class SteamAudioBackend {
  private world: any;
  private three: any;
  private master: AudioNode;
  private reflectionBus: any;
  private reverbBus: any;
  private meshHandles: unknown[] = [];
  private scattering: number;
  private useHrtf: boolean;
  private headTracked: boolean;
  /** 0..1 multiplier on each source's baked reflected-field `wet` (rebuild to apply). */
  private reflectionWetLevel: number;
  /** 0..1 multiplier on the reflection bus wet + each source's reflect send (live). */
  private reflectionBusLevel: number;
  /** 0..1 multiplier on the reverb bus wet + each source's reverb send (live). */
  private reverbBusLevel: number;
  /**
   * Every live source created by this backend, for the LIGHT hot-swap. `setBusLevels`
   * walks this set and re-scales each source's sends; `dispose` (via the source's own
   * `dispose`) removes itself so a torn-down source is never touched.
   */
  private liveSources = new Set<LiveSteamSource>();

  private constructor(world: any, three: any, master: AudioNode, opts: SteamBackendOpts) {
    this.world = world;
    this.three = three;
    this.master = master;
    this.scattering = opts.scattering ?? 0.1;
    this.useHrtf = opts.hrtf ?? true;
    this.headTracked = opts.headTrackedReflections ?? false;
    // 0..1 user multipliers; default 1 = no change to the hardcoded base sends/wets.
    this.reflectionWetLevel = opts.reflectionWetLevel ?? 1;
    this.reflectionBusLevel = opts.reflectionBusLevel ?? 1;
    this.reverbBusLevel = opts.reverbBusLevel ?? 1;
  }

  /**
   * Create a backend. Dynamically imports `three` + `three-steam-audio` (so the
   * default bundle pays nothing), spins up the Steam Audio world, and wires the
   * shared reflection + reverb buses to `master`. THROWS on failure (no cross-origin
   * isolation, WASM load error) — the caller must catch and fall back to our engine.
   */
  static async create(
    audioContext: AudioContext,
    master: AudioNode,
    opts: SteamBackendOpts = {},
  ): Promise<SteamAudioBackend> {
    if (typeof crossOriginIsolated !== 'undefined' && !crossOriginIsolated) {
      throw new Error(
        'Steam Audio needs cross-origin isolation (COOP/COEP). crossOriginIsolated is false.',
      );
    }
    // Dynamic import keeps three + the 6 MB WASM out of the default (our-engine) bundle.
    const [{ createWorld }, three] = await Promise.all([
      import('three-steam-audio'),
      import('three'),
    ]);
    const r = opts.reflections ?? {};
    // Use OUR measured SADIE HRTF (the same dataset that feeds the default engine)
    // instead of Steam's generic built-in HRTF, so the steam path spatializes with the
    // same ears. The fork's `createWorld` accepts an in-memory SOFA via
    // `hrtf: { type: 'sofa', data }`.
    //
    // OPT-IN (`opts.sofaHrtf`): the published `three-steam-audio` does NOT support
    // custom SOFA — only our fork (feat/sofa-hrtf) does — and the published version may
    // REJECT an unrecognized `{type:'sofa'}` HRTF. So this is gated OFF by default to
    // keep `npm install` against the published package working. Enable it (via
    // `?engine=steam-sofa`) only when the SOFA-capable fork is the resolved dependency.
    // Even then it's best-effort: a failed fetch falls back to the generic HRTF.
    const hrtf = opts.sofaHrtf ? await loadSofaHrtf() : null;
    // Head-tracked Ambisonic reflections (fork-only). Spread in only when opted in so an
    // unknown `headTracked`/`irTaps` can't reach (and confuse) the published package on
    // the non-opt-in path — same gating discipline as `sofaHrtf`. With `maxOrder:1` the
    // world build uses order-1 ambisonics; the worklet convolves an `irTaps`-tap IR.
    const headTracked = opts.headTrackedReflections
      ? { headTracked: true as const, irTaps: 512 }
      : {};
    const world = await createWorld({
      audioContext,
      ...(hrtf ? { hrtf } : {}),
      reflections: {
        maxDuration: r.maxDuration ?? 1.0,
        // Head-tracked decode is order-1 (`maxOrder:1`); the parametric path keeps the
        // prior default of 2.
        maxOrder: r.maxOrder ?? (opts.headTrackedReflections ? 1 : 2),
        maxRays: r.maxRays ?? 4096,
        diffuseSamples: r.diffuseSamples ?? 1024,
        ...headTracked,
      },
    });
    const backend = new SteamAudioBackend(world, three, master, opts);
    // Scale the shared bus wets by the user BUS levels (default 1 = base wets).
    backend.reflectionBus = world.createReflectionBus({ wet: BUS_BASE_REFL * backend.reflectionBusLevel });
    backend.reverbBus = world.createReverbBus({ wet: BUS_BASE_REVERB * backend.reverbBusLevel });
    backend.reflectionBus.connect(master);
    backend.reverbBus.connect(master);
    return backend;
  }

  /** Inject the `three`-backed geometry/matrix factory for convert.ts. */
  private sceneDeps(): SceneDeps {
    const THREE = this.three;
    return {
      makeGeometry: (data: MeshData) => {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
        g.setIndex(new THREE.BufferAttribute(data.indices, 1));
        g.computeVertexNormals();
        return g;
      },
      identityMatrix: () => new THREE.Matrix4(),
    };
  }

  /** Clear the current scene and rebuild it from `walls` (via convert.ts), then commit. */
  setGeometry(walls: WallDef[]): void {
    // The library has NO `scene.removeStaticMesh`; `addStaticMesh` returns an
    // AcousticMeshHandle whose `.dispose()` removes that mesh. Dispose the old
    // handles before rebuilding, or moving-wall levels would accumulate (and
    // double-occlude with) stale geometry every update.
    for (const h of this.meshHandles) {
      try { (h as { dispose?: () => void })?.dispose?.(); } catch { /* best-effort */ }
    }
    this.meshHandles = buildSteamScene(this.world.scene, walls, this.sceneDeps(), { scattering: this.scattering });
  }

  /**
   * Create a positioned source, shape-compatible with `ModeledSource`. Routes the dry
   * `input` through the Steam Audio node to `master`, and (if available) into the
   * shared reflection + reverb buses for ray-traced reflections + listener reverb.
   */
  createSource(): SteamSourceHandle {
    // Reflection levels depend on whether the field is HEAD-TRACKED:
    //
    //  - head-tracked (fork): the reflected field is an order-1 Ambisonic decode that
    //    ROTATES with the listener, so it no longer masks the (also head-tracked) direct
    //    path. We can therefore restore material-driven strength — these undo the global
    //    2ce7589 suppression and go back toward the original full-strength values
    //    (wet 0.25→0.7, reflect send 0.35→1.0, reverb send 0.2→0.4) so mazes get real
    //    geometry echo cues.
    //
    //  - NOT head-tracked (published/parametric path): the field is mono-duplicated and
    //    dead-center, so a loud reflected field reads "always in front" and masks the
    //    head-tracked direct path. Keep the suppressed values so the directional cue you
    //    navigate by dominates.
    const base = this.headTracked
      ? { wet: 0.7, reflectSend: 1.0, reverbSend: 0.4 }
      : { wet: 0.25, reflectSend: 0.35, reverbSend: 0.2 };
    // Apply the THREE user multipliers (default 1 = today's behavior):
    //  - reflections.wet (per-source baked field) × reflectionWetLevel — only a
    //    REBUILD picks up a new value, so this is read here at create() time;
    //  - reflect send × reflectionBusLevel and reverb send × reverbBusLevel — these
    //    are live-rescalable via setBusLevels from the stored base sends.
    const refl = {
      wet: base.wet * this.reflectionWetLevel,
      reflectSend: base.reflectSend * this.reflectionBusLevel,
      reverbSend: base.reverbSend * this.reverbBusLevel,
    };
    const source = this.world.createSource({
      hrtf: this.useHrtf,
      distanceAttenuation: true,
      directSimulation: {
        occlusion: 'raycast',
        occlusionSamples: 32,
        airAbsorption: true,
        transmission: { type: 'frequency-dependent' },
      },
      reflections: { wet: refl.wet },
    });
    const node = this.world.createNode(source);
    const input = this.master.context.createGain();
    const output = this.master.context.createGain();
    input.connect(node);
    node.connect(output);
    output.connect(this.master);
    // Retain the connection handles (each exposes a live `setGain`) so `setBusLevels`
    // can re-scale this source's sends in place WITHOUT calling node.setControl
    // (which would clobber the per-frame direction/occlusion the sim publishes).
    const reflConn = node.connectReflections
      ? node.connectReflections(this.reflectionBus, { gain: refl.reflectSend })
      : null;
    const reverbConn = node.connectReverb
      ? node.connectReverb(this.reverbBus, { gain: refl.reverbSend })
      : null;
    // Track this source for live level changes, keyed by its BASE (pre-multiplier)
    // sends so a future setBusLevels recomputes from the original strength.
    const live: LiveSteamSource = {
      reflConn,
      reverbConn,
      base: { reflectSend: base.reflectSend, reverbSend: base.reverbSend },
    };
    this.liveSources.add(live);

    return {
      input,
      output,
      setPosition: (x: number, y: number, z: number) => {
        // `setPosition` (Source.setTransform) recomputes + publishes the source's
        // head-relative binaural direction synchronously, so a moved source reaches
        // the worklet the same frame — no extra publish needed.
        source.setPosition({ x, y, z });
      },
      dispose: () => {
        this.liveSources.delete(live);
        try { input.disconnect(); } catch { /* already gone */ }
        try { output.disconnect(); } catch { /* already gone */ }
        try { source.dispose?.(); } catch { /* best-effort */ }
      },
    };
  }

  /** Update the listener pose. `yaw` is radians about +y; converted to a quaternion. */
  setListener(x: number, y: number, z: number, yaw: number): void {
    const half = yaw / 2;
    // Quaternion for a rotation of −yaw about +y. The NEGATION is essential: this
    // game's `yaw` convention is ahead = (sin yaw, 0, −cos yaw) — i.e. yaw=+90° faces
    // +x (RIGHT), which is what our own HRTF engine is tuned to. Steam derives the
    // listener's ahead as (0,0,−1)·q; with the three.js-standard +yaw quaternion that
    // gives −x at +90° (LEFT) — a left/right MIRROR vs the game. Negating the y term
    // (q = rot(−yaw)) makes Steam's ahead match the game's, so azimuth is correctly
    // sided. (up = (0,1,0)·q is unaffected — the rotation axis.)
    // Update position + orientation TOGETHER so ahead/up and position commit atomically;
    // setTransform publishes every source's head-relative binaural direction immediately
    // (publishSourceControls), so a head turn updates the perceived direction that frame.
    this.world.listener.setTransform(
      { x, y, z },
      { x: 0, y: -Math.sin(half), z: 0, w: Math.cos(half) },
    );
  }

  /** Advance the simulation by `deltaSeconds` (occlusion raycast + reflection trace). */
  step(deltaSeconds: number): void {
    this.world.step(deltaSeconds);
  }

  /**
   * LIGHT live hot-swap of the two BUS levels on a RUNNING level. Stores the new 0..1
   * multipliers (so any source created later uses them), re-scales BOTH shared bus wets
   * (BUS_BASE × level via bus.setWet), AND re-scales every live source's reflect/reverb
   * SEND from its stored base × the new bus level via the retained connection handle's
   * `setGain`. Does NOT touch each source's `wet` (baked at create — needs a rebuild)
   * or call node.setControl (which would clobber per-frame direction/occlusion).
   */
  setBusLevels(reflectionBusLevel: number, reverbBusLevel: number): void {
    this.reflectionBusLevel = reflectionBusLevel;
    this.reverbBusLevel = reverbBusLevel;
    try { this.reflectionBus?.setWet?.(BUS_BASE_REFL * reflectionBusLevel); } catch { /* best-effort */ }
    try { this.reverbBus?.setWet?.(BUS_BASE_REVERB * reverbBusLevel); } catch { /* best-effort */ }
    for (const s of this.liveSources) {
      const sends = recomputeSends(s.base, reflectionBusLevel, reverbBusLevel);
      try { s.reflConn?.setGain(sends.reflectSend); } catch { /* best-effort */ }
      try { s.reverbConn?.setGain(sends.reverbSend); } catch { /* best-effort */ }
    }
  }

  /**
   * Store the new 0..1 per-source reflected-field `wet` multiplier so that sources
   * created AFTER this (i.e. on the next REBUILD) bake the new wet at create(). Does
   * NOT touch already-created sources — `wet` can't be changed in place, so the caller
   * (Game.setSteamReflectionWet) rebuilds the voices after calling this.
   */
  setReflectionWetLevel(v: number): void {
    this.reflectionWetLevel = v;
  }

  dispose(): void {
    this.liveSources.clear();
    try { this.reflectionBus?.disconnect(); } catch { /* */ }
    try { this.reverbBus?.disconnect(); } catch { /* */ }
    try { this.world?.dispose?.(); } catch { /* */ }
  }
}
