import { BufferGeometry, Matrix4, Quaternion, Vector3 } from "three";

//#region src/types.d.ts
interface AcousticMaterial {
  absorption: ThreeBand;
  scattering: number;
  transmission?: ThreeBand;
}
interface AcousticMeshHandle {
  dispose: () => void;
}
interface AcousticScene {
  addDynamicMesh: (input: DynamicMeshInput) => DynamicAcousticMeshHandle;
  addStaticMesh: (input: StaticMeshInput) => AcousticMeshHandle;
  commit: () => void;
}
type AirAbsorptionSettings = {
  coefficients: ThreeBand;
  model: 'exponential';
} | {
  curves: readonly [(distance: number) => number, (distance: number) => number, (distance: number) => number];
  maxDistance: number;
  model: 'curve';
  samples?: number;
} | {
  model?: 'default';
};
interface DirectOutputs {
  airAbsorption: [number, number, number];
  directivity: number;
  distanceAttenuation: number;
  occlusion: number;
  transmission: [number, number, number];
}
interface DirectOverrides {
  airAbsorption?: ThreeBand;
  directivity?: number;
  distanceAttenuation?: number;
  occlusion?: number;
  transmission?: ThreeBand;
}
interface DirectSimulationSettings {
  airAbsorption?: boolean;
  airAbsorptionModel?: AirAbsorptionSettings;
  occlusion?: 'raycast' | 'volumetric' | false;
  occlusionRadius?: number;
  occlusionSamples?: number;
  transmission?: false | {
    type?: 'frequency-dependent' | 'frequency-independent';
  };
}
type DistanceAttenuationSettings = {
  curve: (distance: number) => number;
  maxDistance: number;
  minDistance: number;
  model: 'curve';
  samples?: number;
} | {
  minDistance?: number;
  model: 'inverse';
} | {
  model?: 'default';
};
interface DynamicAcousticMeshHandle extends AcousticMeshHandle {
  setTransform: (matrixWorld: Matrix4) => void;
}
interface DynamicMeshInput extends StaticMeshInput {
  matrixWorld: Matrix4;
}
type HRTFSettings = {
  type?: 'default';
} | {
  data: ArrayBuffer;
  type: 'sofa';
};
interface Listener {
  setOrientation: (orientation: QuaternionLike) => void;
  setPosition: (position: Vector3Like) => void;
  setReverb: (settings: false | ReverbSettings) => void;
  setTransform: (position: Vector3Like, orientation: QuaternionLike) => void;
}
type QualityPreset = 'high' | 'low' | 'medium';
interface QuaternionLike {
  w: number;
  x: number;
  y: number;
  z: number;
}
interface ReflectionBusSettings {
  wet?: number;
}
interface ReflectionConnection {
  disconnect: () => void;
  setGain: (gain: number) => void;
}
interface ReflectionSettings {
  enabled?: boolean;
  reverbScale?: ThreeBand;
  wet?: number;
}
interface ReverbBusSettings {
  wet?: number;
}
interface PathingBusSettings {
  wet?: number;
}
type PathingConnection = ReflectionConnection;
interface PathingBakeSettings {
  numSamples?: number;
  pathRange?: number;
  radius?: number;
  threshold?: number;
  visRange?: number;
}
interface ProbeBatchSettings {
  aabb: {
    max: Vector3Like;
    min: Vector3Like;
  };
  height?: number;
  spacing?: number;
}
interface ProbeBatch {
  dispose: () => void;
  readonly numProbes: number;
  save: () => Uint8Array;
}
interface PathingConnectionOptions {
  gain?: number;
}
type ReverbConnection = ReflectionConnection;
interface ReverbSettings {
  enabled?: boolean;
  reverbScale?: ThreeBand;
}
interface RuntimeSimulationSettings {
  bounces?: number;
  duration?: number;
  irradianceMinDistance?: number;
  order?: number;
  rays?: number;
}
interface SimulationSettings {
  diffuseSamples?: number;
  maxDuration?: number;
  maxOcclusionSamples?: number;
  maxOrder?: number;
  maxRays?: number;
  pathingVisibilitySamples?: number;
  rayBatchSize?: number;
}
interface Source {
  dispose: () => void;
  getDirectOutputs: (target?: DirectOutputs) => DirectOutputs;
  readonly id: number;
  setDirectOverrides: (overrides: DirectOverrides | null) => void;
  setOrientation: (orientation: QuaternionLike) => void;
  setPosition: (position: Vector3Like) => void;
  setSettings: (settings: Partial<SourceSettings>) => void;
  setTransform: (position: Vector3Like, orientation: QuaternionLike) => void;
}
interface SourceSettings {
  directivity?: {
    dipolePower?: number;
    dipoleWeight?: number;
  };
  directSimulation?: boolean | DirectSimulationSettings;
  distanceAttenuation?: DistanceAttenuationSettings | false;
  hrtf?: boolean;
  reflections?: boolean | ReflectionSettings;
  spatialBlend?: number;
}
interface StaticMeshInput {
  geometry: BufferGeometry;
  material: AcousticMaterial | readonly AcousticMaterial[];
  matrixWorld?: Matrix4;
}
interface SteamAudioCapabilities {
  audioWorklet: boolean;
  crossOriginIsolated: boolean;
  gpuSimulation: false;
  runtimeBaking: boolean;
  sharedArrayBuffer: boolean;
  webAssembly: boolean;
}
type SteamAudioModuleFactory = (options?: SteamAudioModuleOptions) => Promise<unknown>;
interface SteamAudioModuleOptions {
  locateFile?: (path: string, prefix: string) => string;
  wasmBinary?: ArrayBuffer;
}
type ThreeBand = readonly [number, number, number];
interface Vector3Like {
  x: number;
  y: number;
  z: number;
}
interface WorldOptions {
  audioContext: AudioContext;
  frameSize?: number;
  hrtf?: HRTFSettings;
  maxSources?: number;
  moduleFactory?: SteamAudioModuleFactory;
  quality?: QualityPreset;
  reflectionRate?: number;
  reflections?: false | {
    diffuseSamples?: number;
    headTracked?: boolean;
    irTaps?: number;
    maxDuration?: number;
    maxOrder?: number;
    maxRays?: number;
  };
  simulation?: SimulationSettings;
  simulationRate?: number;
  pathing?: false | {
    maxOrder?: number;
    rate?: number;
    visRadius?: number;
    visRange?: number;
    visThreshold?: number;
  };
}
//#endregion
//#region src/three/geometry.d.ts
interface ConvertedGeometry {
  absorption: Float32Array;
  indices: Int32Array;
  materialIndices: Int32Array;
  scattering: Float32Array;
  transmission: Float32Array;
  vertices: Float32Array;
}
//#endregion
//#region src/worker/reflection-simulation.d.ts
interface ReflectionIr {
  data: Float32Array;
  samples: number;
}
interface ReflectionSourceInput {
  ahead: readonly [number, number, number];
  enabled: boolean;
  id: number;
  position: readonly [number, number, number];
  reverbScale: readonly [number, number, number];
  up: readonly [number, number, number];
}
interface ReflectionWorkerResult {
  outputs: Array<{
    id: number;
    ir?: ReflectionIr;
    reverbTimes: [number, number, number];
  }>;
  type: 'result';
}
declare class ReflectionSimulationWorker {
  #private;
  constructor(wasmBinary: ArrayBuffer, sampleRate: number, frameSize: number, maxSources: number, settings: NormalizedReflectionSimulationSettings, onResult: (result: ReflectionWorkerResult['outputs']) => void, sofaData?: ArrayBuffer);
  addDynamicMesh(id: number, geometry: ConvertedGeometry, materialCount: number, transform: Matrix4): void;
  addSource(input: ReflectionSourceInput): void;
  addStaticMesh(id: number, geometry: ConvertedGeometry, materialCount: number): void;
  commitScene(): void;
  dispose(): void;
  removeMesh(id: number): void;
  removeSource(id: number): void;
  run(): void;
  setListener(position: readonly [number, number, number], ahead: readonly [number, number, number], up: readonly [number, number, number], settings: NormalizedReflectionSimulationSettings): void;
  updateDynamicMesh(id: number, transform: Matrix4): void;
  updateSource(input: ReflectionSourceInput): void;
}
//#endregion
//#region src/bindings/phonon_bindings.d.ts
// Auto-generated from bindings/bindings.h
// Do not edit manually. Run: node scripts/generate-types.ts
interface SteamAudioBindings extends EmscriptenModule {
  HEAPF32: Float32Array;
  HEAP32: Int32Array;
  HEAPU32: Uint32Array;
  HEAPU8: Uint8Array;
  _malloc(size: number): number;
  _free(pointer: number): void;
  _sa_context_create(out_ctx: number): number;
  _sa_context_release(ctx: number): void;
  _sa_scene_create(ctx: number, out_scene: number): number;
  _sa_scene_commit(scene: number): void;
  _sa_scene_release(scene: number): void;
  _sa_static_mesh_create(scene: number, num_verts: number, verts: number, num_tris: number, indices: number, num_materials: number, absorption: number, scattering: number, transmission: number, tri_materials: number, out_mesh: number): number;
  _sa_static_mesh_add(mesh: number, scene: number): void;
  _sa_static_mesh_remove(mesh: number, scene: number): void;
  _sa_static_mesh_release(mesh: number): void;
  _sa_instanced_mesh_create(parent_scene: number, sub_scene: number, matrix_4x4: number, out_mesh: number): number;
  _sa_instanced_mesh_update_transform(mesh: number, parent_scene: number, matrix_4x4: number): void;
  _sa_instanced_mesh_remove(mesh: number, parent_scene: number): void;
  _sa_instanced_mesh_release(mesh: number): void;
  _sa_hrtf_create(ctx: number, sample_rate: number, frame_size: number, out_hrtf: number): number;
  _sa_hrtf_create_sofa(ctx: number, sample_rate: number, frame_size: number, sofa_data: number, sofa_size: number, out_hrtf: number): number;
  _sa_hrtf_release(hrtf: number): void;
  _sa_binaural_effect_create(ctx: number, sample_rate: number, frame_size: number, hrtf: number, out_effect: number): number;
  _sa_binaural_effect_release(effect: number): void;
  _sa_binaural_effect_apply(effect: number, hrtf: number, dir_x: number, dir_y: number, dir_z: number, spatial_blend: number, in_buffer: number, out_buffer: number, num_channels: number, num_samples: number): number;
  _sa_ambisonics_decode_effect_create(ctx: number, sample_rate: number, frame_size: number, hrtf: number, max_order: number, out_effect: number): number;
  _sa_ambisonics_decode_effect_release(effect: number): void;
  _sa_ambisonics_decode_effect_reset(effect: number): void;
  _sa_ambisonics_decode_effect_apply(effect: number, hrtf: number, order: number, ahead_x: number, ahead_y: number, ahead_z: number, up_x: number, up_y: number, up_z: number, binaural: number, in_buffer: number, out_buffer: number, num_samples: number): number;
  _sa_direct_effect_create(ctx: number, sample_rate: number, frame_size: number, num_channels: number, out_effect: number): number;
  _sa_direct_effect_release(effect: number): void;
  _sa_direct_effect_apply(effect: number, effect_flags: number, transmission_type: number, distance_attenuation: number, air_absorption: number, directivity: number, occlusion: number, transmission: number, in_buffer: number, out_buffer: number, num_channels: number, num_samples: number): number;
  _sa_reflection_effect_create(ctx: number, sample_rate: number, frame_size: number, num_channels: number, out_effect: number): number;
  _sa_reflection_effect_release(effect: number): void;
  _sa_reflection_effect_reset(effect: number): void;
  _sa_reflection_effect_apply(effect: number, reverb_times: number, in_buffer: number, out_buffer: number, num_samples: number): number;
  _sa_reflection_effect_get_tail(effect: number, out_buffer: number, num_samples: number): number;
  _sa_convolution_reflection_effect_create(ctx: number, sample_rate: number, frame_size: number, order: number, max_duration: number, out_effect: number): number;
  _sa_source_apply_convolution_reflection(effect: number, source: number, order: number, sample_rate: number, max_duration: number, in_buffer: number, out_buffer: number, num_samples: number): number;
  _sa_simulator_create(ctx: number, scene: number, sample_rate: number, frame_size: number, max_sources: number, max_occlusion_samples: number, reflections_enabled: number, max_rays: number, diffuse_samples: number, max_duration: number, max_order: number, reflection_threads: number, convolution: number, out_sim: number): number;
  _sa_simulator_commit(sim: number): void;
  _sa_simulator_release(sim: number): void;
  _sa_simulator_run_direct(sim: number): number;
  _sa_simulator_run_reflections(sim: number): number;
  _sa_simulator_set_listener(sim: number, x: number, y: number, z: number, ahead_x: number, ahead_y: number, ahead_z: number, up_x: number, up_y: number, up_z: number, reflection_rays: number, reflection_bounces: number, reflection_duration: number, reflection_order: number, irradiance_min_distance: number): void;
  _sa_source_create(sim: number, simulation_flags: number, out_source: number): number;
  _sa_source_release(source: number, sim: number): void;
  _sa_source_set_inputs(source: number, x: number, y: number, z: number, ahead_x: number, ahead_y: number, ahead_z: number, up_x: number, up_y: number, up_z: number, direct_flags: number, distance_model: number, min_distance: number, distance_max: number, distance_samples: number, distance_curve: number, air_model: number, air_coefficients: number, air_max: number, air_samples: number, air_curves: number, dipole_weight: number, dipole_power: number, occlusion_type: number, occlusion_radius: number, occlusion_samples: number, transmission_rays: number, reflections_enabled: number, reverb_scale: number): void;
  _sa_source_set_reflection_inputs(source: number, x: number, y: number, z: number, ahead_x: number, ahead_y: number, ahead_z: number, up_x: number, up_y: number, up_z: number, enabled: number, reverb_scale: number): void;
  _sa_source_get_direct_outputs(source: number, out_distance_att: number, out_air_absorption: number, out_directivity: number, out_occlusion: number, out_transmission: number): number;
  _sa_source_get_reflection_outputs(source: number, out_reverb_times: number): number;
  _sa_source_get_reflection_ir_size(source: number): number;
  _sa_source_get_reflection_ir(source: number, out_floats: number, max_floats: number): number;
  _sa_buffer_alloc(num_floats: number): number;
  _sa_buffer_free(buffer: number): void;
  _sa_buffer_deinterleave(interleaved: number, deinterleaved: number, num_channels: number, num_samples: number): void;
  _sa_buffer_interleave(deinterleaved: number, interleaved: number, num_channels: number, num_samples: number): void;
  _sa_probe_array_create(ctx: number, out_array: number): number;
  _sa_probe_array_generate_probes(array: number, scene: number, gen_type: number, spacing: number, height: number, transform16: number): number;
  _sa_probe_array_get_num_probes(array: number): number;
  _sa_probe_array_get_probe(array: number, index: number, out4: number): number;
  _sa_probe_array_release(array: number): void;
  _sa_probe_batch_create(ctx: number, out_batch: number): number;
  _sa_probe_batch_add_probe(batch: number, probe4: number): number;
  _sa_probe_batch_add_probe_array(batch: number, array: number): number;
  _sa_probe_batch_get_num_probes(batch: number): number;
  _sa_probe_batch_commit(batch: number): void;
  _sa_probe_batch_release(batch: number): void;
  _sa_probe_batch_save_to_buffer(ctx: number, batch: number, out_size: number): number;
  _sa_probe_batch_load_from_buffer(ctx: number, buf: number, size_bytes: number, out_batch: number): number;
  _sa_path_baker_bake(ctx: number, scene: number, batch: number, num_samples: number, radius: number, threshold: number, vis_range: number, path_range: number): number;
  _sa_path_baker_cancel_bake(ctx: number): void;
  _sa_simulator_create_pathing(ctx: number, scene: number, sample_rate: number, frame_size: number, max_sources: number, max_occlusion_samples: number, reflections_enabled: number, pathing_enabled: number, max_rays: number, diffuse_samples: number, max_duration: number, max_order: number, reflection_threads: number, convolution: number, out_sim: number): number;
  _sa_simulator_add_probe_batch(sim: number, batch: number): void;
  _sa_simulator_remove_probe_batch(sim: number, batch: number): void;
  _sa_simulator_run_pathing(sim: number): number;
  _sa_source_create_pathing(sim: number, direct_enabled: number, reflections_enabled: number, pathing_enabled: number, out_source: number): number;
  _sa_source_set_pathing_inputs(source: number, probe_batch: number, vis_radius: number, vis_threshold: number, vis_range: number, pathing_order: number, enable_validation: number, find_alternate_paths: number): void;
  _sa_source_get_pathing_outputs(source: number, out_eq3: number, out_sh: number, order: number): number;
  _sa_path_effect_create(ctx: number, sample_rate: number, frame_size: number, max_order: number, spatialize: number, hrtf: number, out_effect: number): number;
  _sa_path_effect_apply(effect: number, eq3: number, sh_coeffs: number, order: number, binaural: number, hrtf: number, lx: number, ly: number, lz: number, ax: number, ay: number, az: number, ux: number, uy: number, uz: number, normalize_eq: number, in_mono: number, out_buffer: number, num_samples: number): number;
  _sa_path_effect_get_tail_size(effect: number): number;
  _sa_path_effect_get_tail(effect: number, out_buffer: number, num_samples: number): number;
  _sa_path_effect_reset(effect: number): void;
  _sa_path_effect_release(effect: number): void;
}
//#endregion
//#region src/three/native.d.ts
type NativeModule = SteamAudioBindings;
//#endregion
//#region src/worker/runtime.d.ts
interface PreparedRuntime {
  module: NativeModule;
  wasmBinary: ArrayBuffer;
}
declare const detectCapabilities: () => SteamAudioCapabilities;
//#endregion
//#region src/worker/audio-node.d.ts
interface PathingUpdate {
  ahead: readonly [number, number, number];
  eq3: readonly [number, number, number];
  normalizeEq?: boolean;
  order: number;
  sh: Float32Array;
  up: readonly [number, number, number];
}
interface NodeControlValues {
  airAbsorption: readonly [number, number, number];
  direction: readonly [number, number, number];
  directivity: number;
  distanceAttenuation: number;
  effectFlags: number;
  hrtf: boolean;
  occlusion: number;
  reflectionReverbTimes: readonly [number, number, number];
  reflectionWet: number;
  reverbReverbTimes: readonly [number, number, number];
  reverbWet: number;
  spatialBlend: number;
  transmission: readonly [number, number, number];
  transmissionType: number;
}
type SteamAudioNodeState = 'disposed' | 'failed' | 'initializing' | 'ready';
interface NodeOptions {
  frameSize: number;
  headTracked?: boolean;
  onDispose: (node: SteamAudioNode) => void;
  pathing?: boolean;
  pathingOrder?: number;
  reflectionOrder?: number;
  sofaData?: ArrayBuffer;
  source: Source;
  wasmBinary: ArrayBuffer;
}
interface StereoReflectionIr {
  data: Float32Array;
  samples: number;
}
declare const AudioWorkletNodeBase: {
  new (context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions): AudioWorkletNode;
  prototype: AudioWorkletNode;
};
interface BusNodeOptions {
  onDispose: (node: SteamAudioBusNode) => void;
  wet: number;
}
declare class SteamAudioBusNode extends AudioWorkletNodeBase {
  #private;
  constructor(context: AudioContext, options: BusNodeOptions);
  dispose(): void;
  setWet(wet: number): void;
}
declare class ReflectionBusNode extends SteamAudioBusNode {
  constructor(context: AudioContext, settings?: ReflectionBusSettings, onDispose?: (node: SteamAudioBusNode) => void);
}
declare class PathingBusNode extends SteamAudioBusNode {
  constructor(context: AudioContext, settings?: PathingBusSettings, onDispose?: (node: SteamAudioBusNode) => void);
}
declare class ReverbBusNode extends SteamAudioBusNode {
  constructor(context: AudioContext, settings?: ReverbBusSettings, onDispose?: (node: SteamAudioBusNode) => void);
}
declare class SteamAudioNode extends AudioWorkletNodeBase {
  #private;
  readonly ready: Promise<void>;
  readonly source: Source;
  get error(): Error | undefined;
  get state(): SteamAudioNodeState;
  constructor(context: AudioContext, options: NodeOptions);
  connectReflections(bus: ReflectionBusNode, options?: {
    gain?: number;
  }): ReflectionConnection;
  connectReverb(bus: ReverbBusNode, options?: {
    gain?: number;
  }): ReverbConnection;
  connectPathing(bus: PathingBusNode, options?: {
    gain?: number;
  }): PathingConnection;
  dispose(): void;
  setControl(values: NodeControlValues): void;
  setReflectionIr(ir: StereoReflectionIr): void;
  setPathing(update: PathingUpdate): void;
}
//#endregion
//#region src/three/world.d.ts
interface NormalizedReflectionSimulationSettings {
  bounces: number;
  diffuseSamples: number;
  duration: number;
  enabled: boolean;
  headTracked: boolean;
  irDuration: number;
  irradianceMinDistance: number;
  irTaps: number;
  maxDuration: number;
  maxOrder: number;
  maxRays: number;
  order: number;
  rays: number;
}
interface NormalizedPathingSettings {
  enabled: boolean;
  maxOrder: number;
  order: number;
  rate: number;
  visRadius: number;
  visRange: number;
  visThreshold: number;
}
interface NormalizedSourceSettings {
  directivity: {
    dipolePower: number;
    dipoleWeight: number;
  };
  directSimulation: DirectSimulationSettings;
  distanceAttenuation: DistanceAttenuationSettings | false;
  hrtf: boolean;
  reflections: Required<Pick<ReflectionSettings, 'enabled' | 'reverbScale' | 'wet'>>;
  spatialBlend: number;
}
type World = Pick<WorldImpl, 'audioContext' | 'bakePathing' | 'createNode' | 'createPathingBus' | 'createProbeBatch' | 'createReflectionBus' | 'createReverbBus' | 'createSource' | 'dispose' | 'listener' | 'loadProbeBatch' | 'scene' | 'setReflectionSettings' | 'step'>;
declare class AcousticSceneImpl implements AcousticScene {
  #private;
  constructor(world: WorldImpl);
  addDynamicMesh(input: DynamicMeshInput): DynamicAcousticMeshHandle;
  addStaticMesh(input: StaticMeshInput): AcousticMeshHandle;
  commit(): void;
  dispose(): void;
}
declare class ListenerImpl implements Listener {
  #private;
  readonly orientation: Quaternion;
  readonly position: Vector3;
  constructor(world: WorldImpl);
  setOrientation(orientation: QuaternionLike): void;
  setPosition(position: Vector3Like): void;
  setReverb(settings: false | ReverbSettings): void;
  setTransform(position: Vector3Like, orientation: QuaternionLike): void;
}
declare class SourceImpl implements Source {
  #private;
  readonly id: number;
  readonly nodes: Set<SteamAudioNode>;
  get native(): number;
  get reflectionOutputs(): readonly [number, number, number];
  get settings(): NormalizedSourceSettings;
  constructor(world: WorldImpl, id: number, settings?: SourceSettings);
  assertActive(operation: string): void;
  dispose(): void;
  getDirectOutputs(target?: DirectOutputs): DirectOutputs;
  publishControl(): void;
  readOutputs(): void;
  readReflectionOutputs(): readonly [number, number, number];
  setPathingInputs(batch: number): void;
  readPathingOutputs(): void;
  setDirectOverrides(overrides: DirectOverrides | null): void;
  setOrientation(orientation: QuaternionLike): void;
  setPosition(position: Vector3Like): void;
  setReflectionOutputs(outputs: readonly [number, number, number], ir?: ReflectionIr): void;
  setSettings(settings: Partial<SourceSettings>): void;
  setTransform(position: Vector3Like, orientation: QuaternionLike): void;
}
declare class ProbeBatchImpl implements ProbeBatch {
  #private;
  readonly native: number;
  get numProbes(): number;
  private constructor();
  static generate(world: WorldImpl, settings: ProbeBatchSettings): ProbeBatchImpl;
  static load(world: WorldImpl, data: Uint8Array): ProbeBatchImpl;
  dispose(): void;
  save(): Uint8Array;
}
declare class WorldImpl {
  #private;
  readonly audioContext: AudioContext;
  readonly context: number;
  readonly frameSize: number;
  readonly listener: Listener;
  readonly listenerImpl: ListenerImpl;
  listenerReverbEnabled: boolean;
  listenerReverbTimes: [number, number, number];
  readonly mainThreadReflections: boolean;
  readonly maxOcclusionSamples: number;
  readonly pathingSettings: NormalizedPathingSettings;
  readonly maxSources: number;
  readonly module: NativeModule;
  readonly reflectionSettings: NormalizedReflectionSimulationSettings;
  readonly reflectionWorker?: ReflectionSimulationWorker;
  readonly scene: AcousticSceneImpl;
  readonly sceneHandle: number;
  readonly simulator: number;
  constructor(runtime: PreparedRuntime, options: WorldOptions);
  get pathingEq3Pointer(): number;
  get pathingShPointer(): number;
  assertActive(operation: string): void;
  createNode(sourceValue: Source): SteamAudioNode;
  createReflectionBus(settings?: ReflectionBusSettings): ReflectionBusNode;
  createReverbBus(settings?: ReverbBusSettings): ReverbBusNode;
  createPathingBus(settings?: PathingBusSettings): PathingBusNode;
  createProbeBatch(settings: ProbeBatchSettings): ProbeBatch;
  loadProbeBatch(data: Uint8Array): ProbeBatch;
  bakePathing(batch: ProbeBatch, settings?: PathingBakeSettings): void;
  releaseProbeBatch(batch: ProbeBatchImpl): void;
  createSource(settings?: SourceSettings): Source;
  dispose(): void;
  publishSourceControls(): void;
  removeSource(source: SourceImpl): void;
  setListenerReverb(settings: false | ReverbSettings): void;
  setReflectionSettings(settings: RuntimeSimulationSettings): void;
  step(delta: number): void;
  syncListenerReverbSource(): void;
}
declare const createWorld: (options: WorldOptions) => Promise<World>;
//#endregion
export { ReflectionConnection as A, SteamAudioCapabilities as B, PathingConnection as C, QualityPreset as D, ProbeBatchSettings as E, RuntimeSimulationSettings as F, WorldOptions as G, SteamAudioModuleOptions as H, SimulationSettings as I, Source as L, ReverbBusSettings as M, ReverbConnection as N, QuaternionLike as O, ReverbSettings as P, SourceSettings as R, PathingBusSettings as S, ProbeBatch as T, ThreeBand as U, SteamAudioModuleFactory as V, Vector3Like as W, DynamicAcousticMeshHandle as _, ReverbBusNode as a, Listener as b, detectCapabilities as c, AcousticScene as d, AirAbsorptionSettings as f, DistanceAttenuationSettings as g, DirectSimulationSettings as h, ReflectionBusNode as i, ReflectionSettings as j, ReflectionBusSettings as k, AcousticMaterial as l, DirectOverrides as m, createWorld as n, SteamAudioNode as o, DirectOutputs as p, PathingBusNode as r, SteamAudioNodeState as s, World as t, AcousticMeshHandle as u, DynamicMeshInput as v, PathingConnectionOptions as w, PathingBakeSettings as x, HRTFSettings as y, StaticMeshInput as z };