import { A as ReflectionConnection, B as SteamAudioCapabilities, C as PathingConnection, D as QualityPreset, E as ProbeBatchSettings, F as RuntimeSimulationSettings, G as WorldOptions, H as SteamAudioModuleOptions, I as SimulationSettings, L as Source, M as ReverbBusSettings, N as ReverbConnection, O as QuaternionLike, P as ReverbSettings, R as SourceSettings, S as PathingBusSettings, T as ProbeBatch, U as ThreeBand, V as SteamAudioModuleFactory, W as Vector3Like, _ as DynamicAcousticMeshHandle, a as ReverbBusNode, b as Listener, c as detectCapabilities, d as AcousticScene, f as AirAbsorptionSettings, g as DistanceAttenuationSettings, h as DirectSimulationSettings, i as ReflectionBusNode, j as ReflectionSettings, k as ReflectionBusSettings, l as AcousticMaterial, m as DirectOverrides, n as createWorld, o as SteamAudioNode, p as DirectOutputs, r as PathingBusNode, s as SteamAudioNodeState, t as World, u as AcousticMeshHandle, v as DynamicMeshInput, w as PathingConnectionOptions, x as PathingBakeSettings, y as HRTFSettings, z as StaticMeshInput } from "./world-GaCg0D6x.js";

//#region src/three/errors.d.ts
declare class SteamAudioError extends Error {
  readonly operation: string;
  readonly status?: number;
  constructor(operation: string, message: string, status?: number);
}
//#endregion
//#region src/three/materials.d.ts
declare const Materials: Readonly<{
  concrete: AcousticMaterial;
  generic: AcousticMaterial;
  glass: AcousticMaterial;
  metal: AcousticMaterial;
  wood: AcousticMaterial;
}>;
//#endregion
export { type AcousticMaterial, type AcousticMeshHandle, type AcousticScene, type AirAbsorptionSettings, type DirectOutputs, type DirectOverrides, type DirectSimulationSettings, type DistanceAttenuationSettings, type DynamicAcousticMeshHandle, type DynamicMeshInput, type HRTFSettings, type Listener, Materials, type PathingBakeSettings, PathingBusNode, type PathingBusSettings, type PathingConnection, type PathingConnectionOptions, type ProbeBatch, type ProbeBatchSettings, type QualityPreset, type QuaternionLike, ReflectionBusNode, type ReflectionBusSettings, type ReflectionConnection, type ReflectionSettings, ReverbBusNode, type ReverbBusSettings, type ReverbConnection, type ReverbSettings, type RuntimeSimulationSettings, type SimulationSettings, type Source, type SourceSettings, type StaticMeshInput, type SteamAudioCapabilities, SteamAudioError, type SteamAudioModuleFactory, type SteamAudioModuleOptions, SteamAudioNode, type SteamAudioNodeState, type ThreeBand, type Vector3Like, type World, type WorldOptions, createWorld, detectCapabilities };