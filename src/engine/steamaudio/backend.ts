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

  private constructor(world: any, three: any, master: AudioNode, opts: SteamBackendOpts) {
    this.world = world;
    this.three = three;
    this.master = master;
    this.scattering = opts.scattering ?? 0.1;
    this.useHrtf = opts.hrtf ?? true;
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
    const world = await createWorld({
      audioContext,
      ...(hrtf ? { hrtf } : {}),
      reflections: {
        maxDuration: r.maxDuration ?? 1.0,
        maxOrder: r.maxOrder ?? 2,
        maxRays: r.maxRays ?? 4096,
        diffuseSamples: r.diffuseSamples ?? 1024,
      },
    });
    const backend = new SteamAudioBackend(world, three, master, opts);
    backend.reflectionBus = world.createReflectionBus({ wet: 1 });
    backend.reverbBus = world.createReverbBus({ wet: 0.5 });
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
    const source = this.world.createSource({
      hrtf: this.useHrtf,
      distanceAttenuation: true,
      directSimulation: {
        occlusion: 'raycast',
        occlusionSamples: 32,
        airAbsorption: true,
        transmission: { type: 'frequency-dependent' },
      },
      // Keep the diffuse reflected field WELL BELOW the binaurally-panned direct
      // path. With a loud, head-locked reverberant field (the reflection/reverb
      // buses are a largely frontal/diffuse decode, not re-panned per-source with
      // head yaw), the beacon reads as "in front" no matter which way you turn — the
      // direct HRTF direction (which DOES track yaw) gets masked. A modest wet keeps
      // the room cue without drowning out the directional cue you navigate by.
      reflections: { wet: 0.25 },
    });
    const node = this.world.createNode(source);
    const input = this.master.context.createGain();
    const output = this.master.context.createGain();
    input.connect(node);
    node.connect(output);
    output.connect(this.master);
    // Bus sends well under unity so the binaural DIRECT path dominates the mix and
    // head-turns are clearly localizable (see the reflections.wet note above).
    if (node.connectReflections) node.connectReflections(this.reflectionBus, { gain: 0.35 });
    if (node.connectReverb) node.connectReverb(this.reverbBus, { gain: 0.2 });

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
        try { input.disconnect(); } catch { /* already gone */ }
        try { output.disconnect(); } catch { /* already gone */ }
        try { source.dispose?.(); } catch { /* best-effort */ }
      },
    };
  }

  /** Update the listener pose. `yaw` is radians about +y; converted to a quaternion. */
  setListener(x: number, y: number, z: number, yaw: number): void {
    const half = yaw / 2;
    // Quaternion for a rotation of `yaw` about the +y axis.
    // Update position and orientation TOGETHER in a single transform so the listener's
    // ahead/up vectors (derived from the quaternion) and position are committed atomically.
    // The library's Listener.setTransform publishes every source's head-relative binaural
    // direction immediately (publishSourceControls), so a head turn updates the perceived
    // direction the same frame — no need to wait for the async reflection callback.
    this.world.listener.setTransform(
      { x, y, z },
      { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) },
    );
  }

  /** Advance the simulation by `deltaSeconds` (occlusion raycast + reflection trace). */
  step(deltaSeconds: number): void {
    this.world.step(deltaSeconds);
  }

  dispose(): void {
    try { this.reflectionBus?.disconnect(); } catch { /* */ }
    try { this.reverbBus?.disconnect(); } catch { /* */ }
    try { this.world?.dispose?.(); } catch { /* */ }
  }
}
