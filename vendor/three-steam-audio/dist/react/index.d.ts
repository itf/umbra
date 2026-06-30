import { A as Source, D as ReverbSettings, R as WorldOptions, S as ReflectionBusSettings, T as ReverbBusSettings, a as SteamAudioNode, c as AcousticMaterial, i as ReverbBusNode, j as SourceSettings, r as ReflectionBusNode, t as World, y as Listener } from "../world-mNJc2wfx.js";
import { Group, Mesh, Object3D } from "three";
import { ThreeElements } from "@react-three/fiber";
import { ReactNode, Ref, RefObject } from "react";

//#region src/react/context.d.ts
interface SteamAudioContextValue {
  listener: Listener;
  scene: World['scene'];
  world: World;
}
declare const useSteamAudio: () => SteamAudioContextValue;
interface SteamAudioCommonProps {
  children?: ReactNode;
  paused?: boolean;
  updatePriority?: number;
}
type SteamAudioProps = (SteamAudioCommonProps & {
  audioContext: AudioContext;
  options?: Omit<WorldOptions, 'audioContext'>;
  world?: never;
}) | (SteamAudioCommonProps & {
  audioContext?: never;
  options?: never;
  world: World;
});
declare const SteamAudio: (props: SteamAudioProps) => import("react").JSX.Element;
//#endregion
//#region src/react/environment.d.ts
interface EnvironmentValue {
  reflectionBus?: ReflectionBusNode;
  reverbBus?: ReverbBusNode;
}
interface SteamAudioEnvironmentProps {
  children?: ReactNode;
  destination?: AudioNode | null;
  reflections?: boolean | ReflectionBusSettings;
  reverb?: false | (ReverbBusSettings & ReverbSettings);
}
declare const useSteamAudioEnvironment: () => EnvironmentValue;
declare const SteamAudioEnvironment: ({
  children,
  destination,
  reflections,
  reverb
}: SteamAudioEnvironmentProps) => import("react").JSX.Element;
//#endregion
//#region src/react/listener.d.ts
interface SteamAudioListenerProps {
  object?: RefObject<null | Object3D>;
}
declare const SteamAudioListener: ({
  object
}: SteamAudioListenerProps) => null;
//#endregion
//#region src/react/mesh.d.ts
interface AcousticMeshProps extends Omit<ThreeElements['group'], 'ref'> {
  dynamic?: boolean;
  material: ((mesh: Mesh) => AcousticMaterial | readonly AcousticMaterial[]) | AcousticMaterial | readonly AcousticMaterial[];
  ref?: Ref<Group>;
}
declare const AcousticMesh: {
  ({
    dynamic,
    material,
    ref,
    ...groupProps
  }: AcousticMeshProps): import("react").JSX.Element;
  displayName: string;
};
//#endregion
//#region src/react/source.d.ts
declare const useSteamAudioSource: (object: RefObject<null | Object3D>, settings?: SourceSettings) => {
  node: SteamAudioNode;
  source: Source;
};
interface SteamAudioSourceApi {
  group: Group;
  node: SteamAudioNode;
  source: Source;
}
interface SteamAudioSourceProps extends Omit<ThreeElements['group'], 'ref'> {
  airAbsorption?: boolean;
  destination?: AudioNode | null;
  directivity?: SourceSettings['directivity'];
  hrtf?: boolean;
  input?: AudioNode | null;
  occlusion?: 'raycast' | 'volumetric' | false;
  onReady?: (api: SteamAudioSourceApi) => void;
  ref?: Ref<Group>;
  reflections?: SourceSettings['reflections'];
  reflectionSend?: number;
  reverbSend?: number;
  settings?: SourceSettings;
  spatialBlend?: number;
  transmission?: 'frequency-dependent' | 'frequency-independent' | boolean;
}
declare const SteamAudioSource: {
  ({
    airAbsorption,
    destination,
    directivity,
    hrtf,
    input,
    occlusion,
    onReady,
    ref,
    reflections,
    reflectionSend,
    reverbSend,
    settings,
    spatialBlend,
    transmission,
    ...groupProps
  }: SteamAudioSourceProps): import("react").JSX.Element;
  displayName: string;
};
//#endregion
export { AcousticMesh, type AcousticMeshProps, SteamAudio, type SteamAudioCommonProps, type SteamAudioContextValue, SteamAudioEnvironment, type SteamAudioEnvironmentProps, SteamAudioListener, type SteamAudioListenerProps, type SteamAudioProps, SteamAudioSource, type SteamAudioSourceApi, type SteamAudioSourceProps, type World, useSteamAudio, useSteamAudioEnvironment, useSteamAudioSource };