import { A as Source, C as ReflectionConnection, D as ReverbSettings, E as ReverbConnection, F as SteamAudioModuleOptions, I as ThreeBand, L as Vector3Like, M as StaticMeshInput, N as SteamAudioCapabilities, O as RuntimeSimulationSettings, P as SteamAudioModuleFactory, R as WorldOptions, S as ReflectionBusSettings, T as ReverbBusSettings, _ as DynamicMeshInput, a as SteamAudioNode, b as QualityPreset, c as AcousticMaterial, d as AirAbsorptionSettings, f as DirectOutputs, g as DynamicAcousticMeshHandle, h as DistanceAttenuationSettings, i as ReverbBusNode, j as SourceSettings, k as SimulationSettings, l as AcousticMeshHandle, m as DirectSimulationSettings, n as createWorld, o as SteamAudioNodeState, p as DirectOverrides, r as ReflectionBusNode, s as detectCapabilities, t as World, u as AcousticScene, v as HRTFSettings, w as ReflectionSettings, x as QuaternionLike, y as Listener } from "./world-BMEhnL5j.js";

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
export { type AcousticMaterial, type AcousticMeshHandle, type AcousticScene, type AirAbsorptionSettings, type DirectOutputs, type DirectOverrides, type DirectSimulationSettings, type DistanceAttenuationSettings, type DynamicAcousticMeshHandle, type DynamicMeshInput, type HRTFSettings, type Listener, Materials, type QualityPreset, type QuaternionLike, ReflectionBusNode, type ReflectionBusSettings, type ReflectionConnection, type ReflectionSettings, ReverbBusNode, type ReverbBusSettings, type ReverbConnection, type ReverbSettings, type RuntimeSimulationSettings, type SimulationSettings, type Source, type SourceSettings, type StaticMeshInput, type SteamAudioCapabilities, SteamAudioError, type SteamAudioModuleFactory, type SteamAudioModuleOptions, SteamAudioNode, type SteamAudioNodeState, type ThreeBand, type Vector3Like, type World, type WorldOptions, createWorld, detectCapabilities };