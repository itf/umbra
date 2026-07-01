import { a as getPreparedRuntimePromise, n as createWorldFromRuntime, r as defaultModuleFactory } from "../world-Bgcj5GoD.js";
import { Quaternion, Vector3 } from "three";
import { useFrame } from "@react-three/fiber";
import { createContext, use, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef } from "react";
import { jsx } from "react/jsx-runtime";
//#region src/react/resource-cache.ts
var RenderResourceCache = class {
	#abandonedReleaseDelay;
	#byOwner = /* @__PURE__ */ new WeakMap();
	#releaseDelay;
	constructor(releaseDelay = 50, abandonedReleaseDelay = 3e4) {
		this.#abandonedReleaseDelay = abandonedReleaseDelay;
		this.#releaseDelay = releaseDelay;
	}
	get(owner, id, create, dispose) {
		let byId = this.#byOwner.get(owner);
		if (!byId) {
			byId = /* @__PURE__ */ new Map();
			this.#byOwner.set(owner, byId);
		}
		let entry = byId.get(id);
		if (!entry) {
			entry = {
				dispose,
				references: 0,
				remove: () => byId.delete(id),
				resource: create()
			};
			byId.set(id, entry);
			this.#scheduleRelease(entry, this.#abandonedReleaseDelay);
		}
		return entry;
	}
	retain(entry) {
		const managed = entry;
		if (managed.timer !== void 0) clearTimeout(managed.timer);
		managed.timer = void 0;
		managed.references++;
		return () => {
			managed.references--;
			this.#scheduleRelease(managed);
		};
	}
	#scheduleRelease(entry, delay = this.#releaseDelay) {
		entry.timer = setTimeout(() => {
			if (entry.references !== 0) return;
			entry.dispose(entry.resource);
			entry.remove();
		}, delay);
	}
};
//#endregion
//#region src/react/context.tsx
const SteamAudioContext = createContext(null);
const useInternalContext = (component) => {
	const value = use(SteamAudioContext);
	if (!value) throw new Error(`${component} must be used inside <SteamAudio>`);
	return value;
};
const useSteamAudio = () => {
	const { listener, scene, world } = useInternalContext("useSteamAudio");
	return {
		listener,
		scene,
		world
	};
};
const SteamAudioProvider = ({ children, paused = false, updatePriority = -100, world }) => {
	const synchronizersRef = useRef({
		dynamic: /* @__PURE__ */ new Set(),
		source: /* @__PURE__ */ new Set()
	});
	const listenerCountRef = useRef(0);
	const warnedRef = useRef(false);
	const listenerObjectRef = useRef(void 0);
	const listenerPosition = useMemo(() => new Vector3(), []);
	const listenerOrientation = useMemo(() => new Quaternion(), []);
	const register = useCallback((kind, synchronizer) => {
		synchronizersRef.current[kind].add(synchronizer);
		return () => synchronizersRef.current[kind].delete(synchronizer);
	}, []);
	const setListenerMounted = useCallback((mounted) => {
		if (mounted && listenerCountRef.current > 0) throw new Error("Only one <SteamAudioListener> may be mounted per <SteamAudio>");
		listenerCountRef.current += mounted ? 1 : -1;
	}, []);
	useFrame((state, delta) => {
		if (paused) return;
		state.scene.updateWorldMatrix(true, true);
		if (listenerCountRef.current > 0) {
			const object = listenerObjectRef.current;
			let target = object?.current ?? state.camera;
			if (object && !object.current) {
				if (!warnedRef.current) {
					warnedRef.current = true;
					console.warn("SteamAudioListener object ref is null; retaining the last listener transform");
				}
			} else {
				if (state.gl.xr.isPresenting) target = state.gl.xr.getCamera();
				target.getWorldPosition(listenerPosition);
				target.getWorldQuaternion(listenerOrientation);
				world.listener.setTransform(listenerPosition, listenerOrientation);
			}
		}
		for (const synchronizer of synchronizersRef.current.dynamic) synchronizer(state);
		for (const synchronizer of synchronizersRef.current.source) synchronizer(state);
		world.scene.commit();
		world.step(delta);
	}, updatePriority);
	useEffect(() => () => {
		queueMicrotask(() => {
			try {
				world.scene.commit();
			} catch {}
		});
	}, [world]);
	return /* @__PURE__ */ jsx(SteamAudioContext, {
		value: useMemo(() => ({
			listener: world.listener,
			listenerObjectRef,
			register,
			scene: world.scene,
			setListenerMounted,
			world
		}), [
			register,
			setListenerMounted,
			world
		]),
		children
	});
};
const ownedWorlds = new RenderResourceCache();
const getOwnedWorld = (id, props, runtime) => {
	const moduleFactory = props.options?.moduleFactory ?? defaultModuleFactory;
	return ownedWorlds.get(props.audioContext, id, () => createWorldFromRuntime(runtime, {
		...props.options,
		audioContext: props.audioContext,
		moduleFactory
	}), (world) => world.dispose());
};
const SteamAudioOwned = (props) => {
	const moduleFactory = props.options?.moduleFactory ?? defaultModuleFactory;
	const runtime = use(getPreparedRuntimePromise(props.audioContext, moduleFactory));
	const entry = getOwnedWorld(useId(), props, runtime);
	useEffect(() => ownedWorlds.retain(entry), [entry]);
	return /* @__PURE__ */ jsx(SteamAudioProvider, {
		...props,
		world: entry.resource
	});
};
const SteamAudio = (props) => {
	if (props.world) return /* @__PURE__ */ jsx(SteamAudioProvider, {
		...props,
		world: props.world
	});
	return /* @__PURE__ */ jsx(SteamAudioOwned, { ...props });
};
//#endregion
//#region src/react/environment.tsx
const EnvironmentContext = createContext(null);
const resources = new RenderResourceCache();
const useSteamAudioEnvironment = () => use(EnvironmentContext) ?? {};
const SteamAudioEnvironment = ({ children, destination, reflections = false, reverb = false }) => {
	const { world } = useInternalContext("SteamAudioEnvironment");
	const id = useId();
	const entry = resources.get(world, id, () => {
		const reflectionBus = reflections !== false ? world.createReflectionBus(reflections === true ? void 0 : reflections) : void 0;
		const reverbBus = reverb !== false ? world.createReverbBus(reverb) : void 0;
		return {
			dispose: () => {
				reflectionBus?.dispose();
				reverbBus?.dispose();
			},
			reflectionBus,
			reverbBus
		};
	}, (resource) => resource.dispose());
	useEffect(() => resources.retain(entry), [entry]);
	useEffect(() => {
		world.listener.setReverb(reverb !== false ? {
			enabled: reverb.enabled,
			reverbScale: reverb.reverbScale
		} : false);
		return () => world.listener.setReverb(false);
	}, [reverb, world.listener]);
	useEffect(() => {
		const output = destination === void 0 ? world.audioContext.destination : destination;
		if (!output) return;
		entry.resource.reflectionBus?.connect(output);
		entry.resource.reverbBus?.connect(output);
		return () => {
			try {
				entry.resource.reflectionBus?.disconnect(output);
			} catch {}
			try {
				entry.resource.reverbBus?.disconnect(output);
			} catch {}
		};
	}, [
		destination,
		entry.resource,
		world.audioContext.destination
	]);
	return /* @__PURE__ */ jsx(EnvironmentContext, {
		value: useMemo(() => ({
			reflectionBus: entry.resource.reflectionBus,
			reverbBus: entry.resource.reverbBus
		}), [entry.resource]),
		children
	});
};
//#endregion
//#region src/react/listener.tsx
const SteamAudioListener = ({ object }) => {
	const { listenerObjectRef, setListenerMounted } = useInternalContext("SteamAudioListener");
	useEffect(() => {
		listenerObjectRef.current = object;
		setListenerMounted(true);
		return () => {
			setListenerMounted(false);
			listenerObjectRef.current = void 0;
		};
	}, [
		object,
		setListenerMounted,
		listenerObjectRef
	]);
	return null;
};
//#endregion
//#region src/react/shared.ts
const setForwardedRef = (ref, value) => {
	if (typeof ref === "function") ref(value);
	else if (ref) ref.current = value;
};
//#endregion
//#region src/react/mesh.tsx
const AcousticMesh = ({ dynamic = false, material, ref, ...groupProps }) => {
	const groupRef = useRef(null);
	const entriesRef = useRef(null);
	if (entriesRef.current === null) entriesRef.current = /* @__PURE__ */ new Map();
	const entries = entriesRef.current;
	const { register, scene } = useInternalContext("AcousticMesh");
	const setGroupRef = useCallback((group) => {
		groupRef.current = group;
		setForwardedRef(ref, group);
	}, [ref]);
	useLayoutEffect(() => {
		const group = groupRef.current;
		if (!group) return;
		const present = /* @__PURE__ */ new Set();
		group.updateWorldMatrix(true, true);
		group.traverse((object) => {
			const mesh = object;
			if (!mesh.isMesh) return;
			if (mesh.isSkinnedMesh) throw new Error("AcousticMesh does not support SkinnedMesh in the MVP");
			if (mesh.morphTargetInfluences !== void 0 && mesh.morphTargetInfluences.length > 0) throw new Error("AcousticMesh does not support morph targets in the MVP");
			present.add(mesh);
			const resolvedMaterial = typeof material === "function" ? material(mesh) : material;
			const previous = entries.get(mesh);
			if (previous && previous.dynamic === dynamic && previous.geometry === mesh.geometry && previous.material === resolvedMaterial) return;
			const replacement = dynamic ? scene.addDynamicMesh({
				geometry: mesh.geometry,
				material: resolvedMaterial,
				matrixWorld: mesh.matrixWorld
			}) : scene.addStaticMesh({
				geometry: mesh.geometry,
				material: resolvedMaterial,
				matrixWorld: mesh.matrixWorld
			});
			previous?.handle.dispose();
			entries.set(mesh, {
				dynamic,
				geometry: mesh.geometry,
				handle: replacement,
				material: resolvedMaterial,
				mesh
			});
		});
		for (const [mesh, entry] of entries) if (!present.has(mesh)) {
			entry.handle.dispose();
			entries.delete(mesh);
		}
	});
	useEffect(() => register("dynamic", () => {
		for (const entry of entries.values()) if (entry.dynamic) entry.handle.setTransform(entry.mesh.matrixWorld);
	}), [entries, register]);
	useEffect(() => () => {
		for (const entry of entries.values()) entry.handle.dispose();
		entries.clear();
	}, [entries]);
	return /* @__PURE__ */ jsx("group", {
		...groupProps,
		ref: setGroupRef
	});
};
AcousticMesh.displayName = "AcousticMesh";
//#endregion
//#region src/worker/audio-connections.ts
const connectManagedAudioEdges = (input, node, destination) => {
	input?.connect(node);
	if (destination) node.connect(destination);
	return () => {
		if (input) try {
			input.disconnect(node);
		} catch {}
		if (destination) try {
			node.disconnect(destination);
		} catch {}
	};
};
//#endregion
//#region src/react/source.tsx
const sourceResources = new RenderResourceCache();
const disposeSourceResource = (resource) => {
	resource.node.dispose();
	resource.source.dispose();
};
const getSourceResource = (world, id, create) => sourceResources.get(world, id, create, disposeSourceResource);
const useSteamAudioSource = (object, settings) => {
	const { register, world } = useInternalContext("useSteamAudioSource");
	const entry = getSourceResource(world, useId(), () => {
		const source = world.createSource(settings);
		return {
			node: world.createNode(source),
			source
		};
	});
	const api = entry.resource;
	const position = useMemo(() => new Vector3(), []);
	const orientation = useMemo(() => new Quaternion(), []);
	useEffect(() => sourceResources.retain(entry), [entry]);
	useEffect(() => {
		if (!settings) return;
		api.source.setSettings(settings);
	}, [api.source, settings]);
	useEffect(() => register("source", () => {
		const target = object.current;
		if (!target) return;
		target.getWorldPosition(position);
		target.getWorldQuaternion(orientation);
		api.source.setTransform(position, orientation);
	}), [
		api.source,
		object,
		orientation,
		position,
		register
	]);
	return api;
};
const SteamAudioSource = ({ airAbsorption, destination, directivity, hrtf, input, occlusion, onReady, ref, reflections, reflectionSend, reverbSend, settings, spatialBlend, transmission, ...groupProps }) => {
	const groupRef = useRef(null);
	const { world } = useInternalContext("SteamAudioSource");
	const environment = useSteamAudioEnvironment();
	const api = useSteamAudioSource(groupRef, useMemo(() => {
		const direct = typeof settings?.directSimulation === "object" ? settings.directSimulation : {};
		const hasDirectProps = airAbsorption !== void 0 || occlusion !== void 0 || transmission !== void 0;
		const directSimulation = settings?.directSimulation === false && !hasDirectProps ? false : {
			...direct,
			airAbsorption: airAbsorption ?? direct.airAbsorption,
			occlusion: occlusion ?? direct.occlusion,
			transmission: transmission === void 0 ? direct.transmission : transmission === false ? false : { type: transmission === true ? "frequency-independent" : transmission }
		};
		return {
			...settings,
			directivity: directivity ?? settings?.directivity,
			directSimulation,
			hrtf: hrtf ?? settings?.hrtf,
			reflections: reflections ?? settings?.reflections,
			spatialBlend: spatialBlend ?? settings?.spatialBlend
		};
	}, [
		airAbsorption,
		directivity,
		hrtf,
		occlusion,
		reflections,
		settings,
		spatialBlend,
		transmission
	]));
	const setGroupRef = useCallback((group) => {
		groupRef.current = group;
		setForwardedRef(ref, group);
		if (group) onReady?.({
			...api,
			group
		});
	}, [
		api,
		onReady,
		ref
	]);
	useEffect(() => {
		const output = destination === void 0 ? world.audioContext.destination : destination;
		return connectManagedAudioEdges(input, api.node, output);
	}, [
		api.node,
		destination,
		input,
		world.audioContext.destination
	]);
	useEffect(() => {
		if (!environment.reflectionBus || reflectionSend === void 0) return;
		const connection = api.node.connectReflections(environment.reflectionBus, { gain: reflectionSend });
		return () => connection.disconnect();
	}, [
		api.node,
		environment.reflectionBus,
		reflectionSend
	]);
	useEffect(() => {
		if (!environment.reverbBus || reverbSend === void 0) return;
		const connection = api.node.connectReverb(environment.reverbBus, { gain: reverbSend });
		return () => connection.disconnect();
	}, [
		api.node,
		environment.reverbBus,
		reverbSend
	]);
	return /* @__PURE__ */ jsx("group", {
		...groupProps,
		ref: setGroupRef
	});
};
SteamAudioSource.displayName = "SteamAudioSource";
//#endregion
export { AcousticMesh, SteamAudio, SteamAudioEnvironment, SteamAudioListener, SteamAudioSource, useSteamAudio, useSteamAudioEnvironment, useSteamAudioSource };
