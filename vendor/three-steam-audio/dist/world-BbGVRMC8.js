import { Matrix4, Quaternion, Vector3 } from "three";
//#region src/three/errors.ts
var SteamAudioError = class extends Error {
	operation;
	status;
	constructor(operation, message, status) {
		super(status === void 0 ? `${operation}: ${message}` : `${operation} failed with status ${status}: ${message}`);
		this.name = "SteamAudioError";
		this.operation = operation;
		this.status = status;
	}
};
const assertNativeStatus = (operation, status) => {
	if (status !== 0) throw new SteamAudioError(operation, "Steam Audio rejected the operation", status);
};
//#endregion
//#region src/worker/audio-node.ts
const CONTROL_VALUE_COUNT = 23;
const CROSSFADE_SECONDS = .03;
var ReflectionConvolverChain = class {
	input;
	get output() {
		return this.#output;
	}
	#active = 0;
	#context;
	#convolvers = [void 0, void 0];
	#disposed = false;
	#gains;
	#output;
	constructor(context) {
		this.#context = context;
		this.input = context.createGain();
		this.#output = context.createGain();
		this.#gains = [context.createGain(), context.createGain()];
		for (const gain of this.#gains) {
			gain.gain.value = 0;
			gain.connect(this.#output);
		}
	}
	dispose() {
		if (this.#disposed) return;
		this.#disposed = true;
		try {
			this.input.disconnect();
		} catch {}
		for (const convolver of this.#convolvers) try {
			convolver?.disconnect();
		} catch {}
		for (const gain of this.#gains) try {
			gain.disconnect();
		} catch {}
		try {
			this.#output.disconnect();
		} catch {}
	}
	setIr(ir) {
		if (this.#disposed || ir.samples <= 0) return;
		const buffer = this.#context.createBuffer(2, ir.samples, this.#context.sampleRate);
		buffer.getChannelData(0).set(ir.data.subarray(0, ir.samples));
		buffer.getChannelData(1).set(ir.data.subarray(ir.samples, 2 * ir.samples));
		const next = this.#active ^ 1;
		this.#convolvers[next]?.disconnect();
		const convolver = this.#context.createConvolver();
		convolver.normalize = false;
		convolver.buffer = buffer;
		this.input.connect(convolver);
		convolver.connect(this.#gains[next]);
		this.#convolvers[next] = convolver;
		const now = this.#context.currentTime;
		const end = now + CROSSFADE_SECONDS;
		for (const g of this.#gains) g.gain.cancelScheduledValues(now);
		this.#gains[next].gain.setValueAtTime(this.#gains[next].gain.value, now);
		this.#gains[next].gain.linearRampToValueAtTime(1, end);
		this.#gains[this.#active].gain.setValueAtTime(this.#gains[this.#active].gain.value, now);
		this.#gains[this.#active].gain.linearRampToValueAtTime(0, end);
		this.#active = next;
	}
};
const MissingAudioWorkletNode = class {
	constructor() {
		throw new Error("AudioWorkletNode is not available in this environment");
	}
};
const AudioWorkletNodeBase = globalThis.AudioWorkletNode ?? MissingAudioWorkletNode;
const validateGain = (value) => {
	if (!Number.isFinite(value) || value < 0) throw new RangeError("gain must be a finite number >= 0");
	return value;
};
const disposeWorkletNode = (node, onDispose) => {
	try {
		node.disconnect();
	} catch {}
	node.port.postMessage({ type: "dispose" });
	node.port.close();
	onDispose();
};
var SteamAudioBusNode = class extends AudioWorkletNodeBase {
	#disposed = false;
	#onDispose;
	constructor(context, options) {
		super(context, "steam-audio-bus-processor", {
			channelCount: 2,
			channelCountMode: "clamped-max",
			numberOfInputs: 1,
			numberOfOutputs: 1,
			outputChannelCount: [2],
			processorOptions: { wet: validateGain(options.wet) }
		});
		this.#onDispose = options.onDispose;
	}
	dispose() {
		if (this.#disposed) return;
		this.port.postMessage({
			type: "wet",
			value: 0
		});
		this.#disposed = true;
		disposeWorkletNode(this, () => this.#onDispose(this));
	}
	setWet(wet) {
		if (this.#disposed) return;
		this.port.postMessage({
			type: "wet",
			value: validateGain(wet)
		});
	}
};
var ReflectionBusNode = class extends SteamAudioBusNode {
	constructor(context, settings = {}, onDispose = () => {}) {
		super(context, {
			onDispose,
			wet: settings.wet ?? 1
		});
	}
};
var ReverbBusNode = class extends SteamAudioBusNode {
	constructor(context, settings = {}, onDispose = () => {}) {
		super(context, {
			onDispose,
			wet: settings.wet ?? 1
		});
	}
};
var SteamAudioNode = class extends AudioWorkletNodeBase {
	ready;
	source;
	get error() {
		return this.#error;
	}
	get state() {
		return this.#state;
	}
	#controlData;
	#controlSequence;
	#disposed = false;
	#error;
	#headTracked;
	#lastReflectionIr;
	#onDispose;
	#reflectionChains = /* @__PURE__ */ new Set();
	#rejectReady;
	#resolveReady;
	#state = "initializing";
	constructor(context, options) {
		const controlBuffer = globalThis.crossOriginIsolated === true && typeof SharedArrayBuffer !== "undefined" ? new SharedArrayBuffer(96) : void 0;
		super(context, "steam-audio-processor", {
			channelCount: 2,
			channelCountMode: "clamped-max",
			numberOfInputs: 1,
			numberOfOutputs: 3,
			outputChannelCount: [
				2,
				2,
				2
			],
			processorOptions: {
				controlBuffer,
				frameSize: options.frameSize,
				headTracked: options.headTracked === true,
				reflectionOrder: options.reflectionOrder ?? 1,
				sofaData: options.sofaData,
				wasmBinary: options.wasmBinary
			}
		});
		this.source = options.source;
		this.#headTracked = options.headTracked === true;
		this.#onDispose = options.onDispose;
		this.ready = new Promise((resolve, reject) => {
			this.#resolveReady = resolve;
			this.#rejectReady = reject;
		});
		this.ready.catch(() => {});
		this.port.onmessage = ({ data }) => {
			if (data.type === "ready") {
				if (this.#state !== "initializing") return;
				this.#state = "ready";
				this.#resolveReady();
				return;
			}
			if (data.type === "error") this.#fail(String(data.message));
		};
		this.addEventListener?.("processorerror", () => {
			this.#fail("AudioWorklet processor crashed");
		});
		if (controlBuffer) {
			this.#controlSequence = new Int32Array(controlBuffer, 0, 1);
			this.#controlData = new Float32Array(controlBuffer, 4, CONTROL_VALUE_COUNT);
		}
	}
	connectReflections(bus, options = {}) {
		if (this.#headTracked) return this.#connectReflectionConvolver(bus, options.gain ?? 1);
		return this.#connectSend(bus, 1, options.gain ?? 1);
	}
	connectReverb(bus, options = {}) {
		return this.#connectSend(bus, 2, options.gain ?? 1);
	}
	dispose() {
		if (this.#disposed) return;
		this.#disposed = true;
		if (this.#state === "initializing") {
			this.#error = new SteamAudioError("AudioWorklet.initialize", "node was disposed before initialization completed");
			this.#rejectReady(this.#error);
		}
		this.#state = "disposed";
		for (const chain of this.#reflectionChains) chain.dispose();
		this.#reflectionChains.clear();
		disposeWorkletNode(this, () => this.#onDispose(this));
	}
	setControl(values) {
		if (this.#disposed) return;
		const packet = new Float32Array(CONTROL_VALUE_COUNT);
		packet[0] = values.distanceAttenuation;
		packet.set(values.airAbsorption, 1);
		packet[4] = values.directivity;
		packet[5] = values.occlusion;
		packet.set(values.transmission, 6);
		packet.set(values.direction, 9);
		packet[12] = values.spatialBlend;
		packet[13] = values.effectFlags;
		packet[14] = values.hrtf ? values.transmissionType + 1 : -(values.transmissionType + 1);
		packet.set(values.reflectionReverbTimes, 15);
		packet[18] = values.reflectionWet;
		packet.set(values.reverbReverbTimes, 19);
		packet[22] = values.reverbWet;
		if (this.#controlData && this.#controlSequence) {
			Atomics.add(this.#controlSequence, 0, 1);
			this.#controlData.set(packet);
			Atomics.add(this.#controlSequence, 0, 1);
		} else this.port.postMessage({
			type: "control",
			values: packet
		}, [packet.buffer]);
	}
	setReflectionIr(ir) {
		if (this.#disposed || !this.#headTracked) return;
		this.#lastReflectionIr = ir;
		for (const chain of this.#reflectionChains) chain.setIr(ir);
	}
	#connectReflectionConvolver(bus, initialGain) {
		if (this.#disposed) throw new Error("Cannot connect a disposed SteamAudioNode");
		if (bus.context !== this.context) throw new Error("Steam Audio send and bus must use the same AudioContext");
		const chain = new ReflectionConvolverChain(this.context);
		const gainNode = this.context.createGain();
		gainNode.gain.value = validateGain(initialGain);
		this.connect(chain.input, 1, 0);
		chain.output.connect(gainNode);
		gainNode.connect(bus);
		this.#reflectionChains.add(chain);
		if (this.#lastReflectionIr) chain.setIr(this.#lastReflectionIr);
		let connected = true;
		return {
			disconnect: () => {
				if (!connected) return;
				connected = false;
				this.#reflectionChains.delete(chain);
				try {
					this.disconnect(chain.input, 1, 0);
				} catch {}
				try {
					gainNode.disconnect(bus);
				} catch {}
				chain.dispose();
			},
			setGain: (gain) => {
				gainNode.gain.value = validateGain(gain);
			}
		};
	}
	#connectSend(bus, output, initialGain) {
		if (this.#disposed) throw new Error("Cannot connect a disposed SteamAudioNode");
		if (bus.context !== this.context) throw new Error("Steam Audio send and bus must use the same AudioContext");
		const gainNode = this.context.createGain();
		gainNode.gain.value = validateGain(initialGain);
		this.connect(gainNode, output, 0);
		gainNode.connect(bus);
		let connected = true;
		return {
			disconnect: () => {
				if (!connected) return;
				connected = false;
				try {
					this.disconnect(gainNode, output, 0);
				} catch {}
				try {
					gainNode.disconnect(bus);
				} catch {}
			},
			setGain: (gain) => {
				gainNode.gain.value = validateGain(gain);
			}
		};
	}
	#fail(message) {
		if (this.#state !== "initializing") return;
		this.#error = new SteamAudioError("AudioWorklet.initialize", message);
		this.#state = "failed";
		this.#rejectReady(this.#error);
	}
};
//#endregion
//#region src/three/geometry.ts
const identity = new Matrix4();
const scratch = new Vector3();
const assertFiniteUnit = (name, value) => {
	if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError(`${name} must be a finite number in [0, 1]`);
	return value;
};
const validateMaterial = (value, index) => {
	value.absorption.forEach((coefficient, band) => assertFiniteUnit(`material[${index}].absorption[${band}]`, coefficient));
	assertFiniteUnit(`material[${index}].scattering`, value.scattering);
	value.transmission?.forEach((coefficient, band) => assertFiniteUnit(`material[${index}].transmission[${band}]`, coefficient));
};
const getDrawRange = (geometry, elementCount) => {
	const drawStart = Math.max(0, geometry.drawRange.start);
	const requestedCount = Number.isFinite(geometry.drawRange.count) ? geometry.drawRange.count : elementCount - drawStart;
	const drawEnd = Math.min(elementCount, drawStart + Math.max(0, requestedCount));
	const triangleStart = Math.ceil(drawStart / 3) * 3;
	const triangleEnd = drawEnd - (drawEnd - triangleStart) % 3;
	const triangleCount = Math.max(0, (triangleEnd - triangleStart) / 3);
	if (triangleCount === 0) throw new Error("Acoustic geometry drawRange does not contain any complete triangles");
	return {
		triangleCount,
		triangleStart
	};
};
const convertVertices = (geometry, matrix) => {
	const position = geometry.getAttribute("position");
	const vertices = new Float32Array(position.count * 3);
	for (let vertex = 0; vertex < position.count; vertex++) {
		scratch.set(position.getX(vertex), position.getY(vertex), position.getZ(vertex)).applyMatrix4(matrix);
		vertices[vertex * 3] = scratch.x;
		vertices[vertex * 3 + 1] = scratch.y;
		vertices[vertex * 3 + 2] = scratch.z;
	}
	return vertices;
};
const buildMaterialByOffset = (groups, elementCount) => {
	const materialByOffset = /* @__PURE__ */ new Map();
	for (const group of groups) {
		const end = Math.min(group.start + group.count, elementCount);
		for (let offset = group.start; offset < end; offset++) materialByOffset.set(offset, group.materialIndex ?? 0);
	}
	return materialByOffset;
};
const convertTriangles = (geometry, materialCount, matrix) => {
	const sourceIndices = geometry.getIndex();
	const position = geometry.getAttribute("position");
	const elementCount = sourceIndices?.count ?? position.count;
	const { triangleCount, triangleStart } = getDrawRange(geometry, elementCount);
	const indices = new Int32Array(triangleCount * 3);
	const materialIndices = new Int32Array(triangleCount);
	const flipWinding = matrix.determinant() < 0;
	const materialByOffset = buildMaterialByOffset(geometry.groups, elementCount);
	for (let triangle = 0; triangle < triangleCount; triangle++) {
		const sourceOffset = triangleStart + triangle * 3;
		const a = sourceIndices ? sourceIndices.getX(sourceOffset) : sourceOffset;
		const b = sourceIndices ? sourceIndices.getX(sourceOffset + 1) : sourceOffset + 1;
		const c = sourceIndices ? sourceIndices.getX(sourceOffset + 2) : sourceOffset + 2;
		indices[triangle * 3] = a;
		indices[triangle * 3 + 1] = flipWinding ? c : b;
		indices[triangle * 3 + 2] = flipWinding ? b : c;
		const materialIndex = materialByOffset.get(sourceOffset) ?? 0;
		if (materialIndex < 0 || materialIndex >= materialCount) throw new RangeError(`Geometry group references missing acoustic material ${materialIndex}`);
		materialIndices[triangle] = materialIndex;
	}
	return {
		indices,
		materialIndices
	};
};
const matrixToRowMajor = (matrix) => {
	const source = matrix.elements;
	return new Float32Array([
		source[0],
		source[4],
		source[8],
		source[12],
		source[1],
		source[5],
		source[9],
		source[13],
		source[2],
		source[6],
		source[10],
		source[14],
		source[3],
		source[7],
		source[11],
		source[15]
	]);
};
const splitDynamicTransform = (matrixWorld) => {
	const position = new Vector3();
	const orientation = new Quaternion();
	const scale = new Vector3();
	matrixWorld.decompose(position, orientation, scale);
	if (Math.abs(scale.x) < 1e-8 || Math.abs(scale.y) < 1e-8 || Math.abs(scale.z) < 1e-8) throw new RangeError("Dynamic acoustic meshes cannot have a zero scale component");
	return {
		bakedMatrix: new Matrix4().makeScale(scale.x, scale.y, scale.z),
		rigidMatrix: new Matrix4().compose(position, orientation, new Vector3(1, 1, 1)),
		scale
	};
};
const rigidMatrixForScale = (matrixWorld, expectedScale) => {
	const next = splitDynamicTransform(matrixWorld);
	if (next.scale.distanceToSquared(expectedScale) > 1e-10) throw new Error("Changing the scale of a dynamic acoustic mesh at runtime is not supported");
	return next.rigidMatrix;
};
const convertGeometry = (geometry, materialInput, matrix = identity) => {
	if (geometry.getAttribute("position").itemSize < 3) throw new Error("Acoustic geometry requires a position attribute with itemSize >= 3");
	const materials = Array.isArray(materialInput) ? materialInput : [materialInput];
	if (materials.length === 0) throw new Error("Acoustic geometry requires at least one material");
	materials.forEach(validateMaterial);
	const vertices = convertVertices(geometry, matrix);
	const { indices, materialIndices } = convertTriangles(geometry, materials.length, matrix);
	const absorption = new Float32Array(materials.length * 3);
	const scattering = new Float32Array(materials.length);
	const transmission = new Float32Array(materials.length * 3);
	materials.forEach((value, index) => {
		absorption.set(value.absorption, index * 3);
		scattering[index] = value.scattering;
		transmission.set(value.transmission ?? [
			0,
			0,
			0
		], index * 3);
	});
	return {
		absorption,
		indices,
		materialIndices,
		scattering,
		transmission,
		vertices
	};
};
//#endregion
//#region src/worker/reflection-simulation.ts
var ReflectionSimulationWorker = class {
	#disposed = false;
	#disposeTimer;
	#error;
	#pending = false;
	#worker;
	constructor(wasmBinary, sampleRate, frameSize, maxSources, settings, onResult, sofaData) {
		this.#worker = new Worker(new URL("./reflection-simulator-worker.js", import.meta.url), { type: "module" });
		this.#worker.onmessage = ({ data }) => {
			if (data?.type === "error") {
				this.#pending = false;
				this.#error = new Error(data.message);
				return;
			}
			if (data?.type === "disposed") {
				if (this.#disposeTimer !== void 0) clearTimeout(this.#disposeTimer);
				this.#worker.terminate();
				return;
			}
			if (data?.type !== "result") return;
			this.#pending = false;
			onResult(data.outputs);
		};
		this.#worker.onerror = (event) => {
			this.#pending = false;
			this.#error = new Error(event.message || "Steam Audio reflection worker failed");
		};
		const binary = wasmBinary.slice(0);
		const transfers = [binary];
		const sofaCopy = sofaData ? sofaData.slice(0) : void 0;
		if (sofaCopy) transfers.push(sofaCopy);
		this.#worker.postMessage({
			frameSize,
			maxSources,
			sampleRate,
			settings,
			sofaData: sofaCopy,
			type: "init",
			wasmBinary: binary
		}, transfers);
	}
	addDynamicMesh(id, geometry, materialCount, transform) {
		this.#post({
			geometry,
			id,
			materialCount,
			transform: matrixToRowMajor(transform),
			type: "add-dynamic-mesh"
		});
	}
	addSource(input) {
		this.#post({
			input,
			type: "add-source"
		});
	}
	addStaticMesh(id, geometry, materialCount) {
		this.#post({
			geometry,
			id,
			materialCount,
			type: "add-static-mesh"
		});
	}
	commitScene() {
		this.#post({ type: "commit-scene" });
	}
	dispose() {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#disposeTimer = setTimeout(() => this.#worker.terminate(), 100);
		this.#worker.postMessage({ type: "dispose" });
	}
	removeMesh(id) {
		this.#post({
			id,
			type: "remove-mesh"
		});
	}
	removeSource(id) {
		this.#post({
			id,
			type: "remove-source"
		});
	}
	run() {
		if (this.#error) throw this.#error;
		if (this.#disposed || this.#pending) return;
		this.#pending = true;
		this.#worker.postMessage({ type: "run" });
	}
	setListener(position, ahead, up, settings) {
		this.#post({
			ahead,
			position,
			settings,
			type: "set-listener",
			up
		});
	}
	updateDynamicMesh(id, transform) {
		this.#post({
			id,
			transform: matrixToRowMajor(transform),
			type: "update-dynamic-mesh"
		});
	}
	updateSource(input) {
		this.#post({
			input,
			type: "update-source"
		});
	}
	#post(message) {
		if (this.#disposed) return;
		this.#worker.postMessage(message);
	}
};
const canUseReflectionWorker = () => typeof Worker !== "undefined";
//#endregion
//#region src/bindings/phonon_bindings.js
async function Module(moduleArg = {}) {
	var moduleRtn;
	var Module = moduleArg;
	var ENVIRONMENT_IS_WEB = !!globalThis.window;
	var ENVIRONMENT_IS_WORKER = !!globalThis.WorkerGlobalScope;
	globalThis.process?.versions?.node && globalThis.process?.type;
	var _scriptName = import.meta.url;
	var scriptDirectory = "";
	function locateFile(path) {
		if (Module["locateFile"]) return Module["locateFile"](path, scriptDirectory);
		return scriptDirectory + path;
	}
	var readAsync, readBinary;
	if (ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER) {
		try {
			scriptDirectory = new URL(".", _scriptName).href;
		} catch {}
		if (ENVIRONMENT_IS_WORKER) readBinary = (url) => {
			var xhr = new XMLHttpRequest();
			xhr.open("GET", url, false);
			xhr.responseType = "arraybuffer";
			xhr.send(null);
			return new Uint8Array(xhr.response);
		};
		readAsync = async (url) => {
			var response = await fetch(url, { credentials: "same-origin" });
			if (response.ok) return response.arrayBuffer();
			throw new Error(response.status + " : " + response.url);
		};
	}
	var out = console.log.bind(console);
	var err = console.error.bind(console);
	var wasmBinary;
	var ABORT = false;
	var readyPromiseResolve, readyPromiseReject;
	var runtimeInitialized = false;
	function updateMemoryViews() {
		var b = wasmMemory.buffer;
		HEAP8 = new Int8Array(b);
		HEAP16 = new Int16Array(b);
		Module["HEAPU8"] = HEAPU8 = new Uint8Array(b);
		HEAPU16 = new Uint16Array(b);
		Module["HEAP32"] = HEAP32 = new Int32Array(b);
		Module["HEAPU32"] = HEAPU32 = new Uint32Array(b);
		Module["HEAPF32"] = HEAPF32 = new Float32Array(b);
		HEAPF64 = new Float64Array(b);
		HEAP64 = new BigInt64Array(b);
		HEAPU64 = new BigUint64Array(b);
	}
	function preRun() {
		if (Module["preRun"]) {
			if (typeof Module["preRun"] == "function") Module["preRun"] = [Module["preRun"]];
			while (Module["preRun"].length) addOnPreRun(Module["preRun"].shift());
		}
		callRuntimeCallbacks(onPreRuns);
	}
	function initRuntime() {
		runtimeInitialized = true;
		if (!Module["noFSInit"] && !FS.initialized) FS.init();
		TTY.init();
		wasmExports["m"]();
		FS.ignorePermissions = false;
	}
	function postRun() {
		if (Module["postRun"]) {
			if (typeof Module["postRun"] == "function") Module["postRun"] = [Module["postRun"]];
			while (Module["postRun"].length) addOnPostRun(Module["postRun"].shift());
		}
		callRuntimeCallbacks(onPostRuns);
	}
	function abort(what) {
		Module["onAbort"]?.(what);
		what = `Aborted(${what})`;
		err(what);
		ABORT = true;
		what += ". Build with -sASSERTIONS for more info.";
		var e = new WebAssembly.RuntimeError(what);
		readyPromiseReject?.(e);
		throw e;
	}
	var wasmBinaryFile;
	function findWasmBinary() {
		if (Module["locateFile"]) return locateFile("phonon_bindings.wasm");
		return new URL("phonon_bindings.wasm", import.meta.url).href;
	}
	function getBinarySync(file) {
		if (file == wasmBinaryFile && wasmBinary) return new Uint8Array(wasmBinary);
		if (readBinary) return readBinary(file);
		throw "both async and sync fetching of the wasm failed";
	}
	async function getWasmBinary(binaryFile) {
		if (!wasmBinary) try {
			var response = await readAsync(binaryFile);
			return new Uint8Array(response);
		} catch {}
		return getBinarySync(binaryFile);
	}
	async function instantiateArrayBuffer(binaryFile, imports) {
		try {
			var binary = await getWasmBinary(binaryFile);
			return await WebAssembly.instantiate(binary, imports);
		} catch (reason) {
			err(`failed to asynchronously prepare wasm: ${reason}`);
			abort(reason);
		}
	}
	async function instantiateAsync(binary, binaryFile, imports) {
		if (!binary) try {
			var response = fetch(binaryFile, { credentials: "same-origin" });
			return await WebAssembly.instantiateStreaming(response, imports);
		} catch (reason) {
			err(`wasm streaming compile failed: ${reason}`);
			err("falling back to ArrayBuffer instantiation");
		}
		return instantiateArrayBuffer(binaryFile, imports);
	}
	function getWasmImports() {
		return { a: wasmImports };
	}
	async function createWasm() {
		function receiveInstance(instance, module) {
			wasmExports = instance.exports;
			assignWasmExports(wasmExports);
			updateMemoryViews();
			return wasmExports;
		}
		function receiveInstantiationResult(result) {
			return receiveInstance(result["instance"]);
		}
		var info = getWasmImports();
		if (Module["instantiateWasm"]) return new Promise((resolve, reject) => {
			Module["instantiateWasm"](info, (inst, mod) => {
				resolve(receiveInstance(inst, mod));
			});
		});
		wasmBinaryFile ??= findWasmBinary();
		return receiveInstantiationResult(await instantiateAsync(wasmBinary, wasmBinaryFile, info));
	}
	var HEAP16;
	var HEAP32;
	var HEAP64;
	var HEAP8;
	var HEAPF32;
	var HEAPF64;
	var HEAPU16;
	var HEAPU32;
	var HEAPU64;
	var HEAPU8;
	var callRuntimeCallbacks = (callbacks) => {
		while (callbacks.length > 0) callbacks.shift()(Module);
	};
	var onPostRuns = [];
	var addOnPostRun = (cb) => onPostRuns.push(cb);
	var onPreRuns = [];
	var addOnPreRun = (cb) => onPreRuns.push(cb);
	function getValue(ptr, type = "i8") {
		if (type.endsWith("*")) type = "*";
		switch (type) {
			case "i1": return HEAP8[ptr];
			case "i8": return HEAP8[ptr];
			case "i16": return HEAP16[ptr >> 1];
			case "i32": return HEAP32[ptr >> 2];
			case "i64": return HEAP64[ptr >> 3];
			case "float": return HEAPF32[ptr >> 2];
			case "double": return HEAPF64[ptr >> 3];
			case "*": return HEAPU32[ptr >> 2];
			default: abort(`invalid type for getValue: ${type}`);
		}
	}
	function setValue(ptr, value, type = "i8") {
		if (type.endsWith("*")) type = "*";
		switch (type) {
			case "i1":
				HEAP8[ptr] = value;
				break;
			case "i8":
				HEAP8[ptr] = value;
				break;
			case "i16":
				HEAP16[ptr >> 1] = value;
				break;
			case "i32":
				HEAP32[ptr >> 2] = value;
				break;
			case "i64":
				HEAP64[ptr >> 3] = BigInt(value);
				break;
			case "float":
				HEAPF32[ptr >> 2] = value;
				break;
			case "double":
				HEAPF64[ptr >> 3] = value;
				break;
			case "*":
				HEAPU32[ptr >> 2] = value;
				break;
			default: abort(`invalid type for setValue: ${type}`);
		}
	}
	var stackRestore = (val) => __emscripten_stack_restore(val);
	var stackSave = () => _emscripten_stack_get_current();
	class ExceptionInfo {
		constructor(excPtr) {
			this.excPtr = excPtr;
			this.ptr = excPtr - 24;
		}
		set_type(type) {
			HEAPU32[this.ptr + 4 >> 2] = type;
		}
		get_type() {
			return HEAPU32[this.ptr + 4 >> 2];
		}
		set_destructor(destructor) {
			HEAPU32[this.ptr + 8 >> 2] = destructor;
		}
		get_destructor() {
			return HEAPU32[this.ptr + 8 >> 2];
		}
		set_caught(caught) {
			caught = caught ? 1 : 0;
			HEAP8[this.ptr + 12] = caught;
		}
		get_caught() {
			return HEAP8[this.ptr + 12] != 0;
		}
		set_rethrown(rethrown) {
			rethrown = rethrown ? 1 : 0;
			HEAP8[this.ptr + 13] = rethrown;
		}
		get_rethrown() {
			return HEAP8[this.ptr + 13] != 0;
		}
		init(type, destructor) {
			this.set_adjusted_ptr(0);
			this.set_type(type);
			this.set_destructor(destructor);
		}
		set_adjusted_ptr(adjustedPtr) {
			HEAPU32[this.ptr + 16 >> 2] = adjustedPtr;
		}
		get_adjusted_ptr() {
			return HEAPU32[this.ptr + 16 >> 2];
		}
	}
	var uncaughtExceptionCount = 0;
	var ___cxa_throw = (ptr, type, destructor) => {
		new ExceptionInfo(ptr).init(type, destructor);
		uncaughtExceptionCount++;
		abort();
	};
	var syscallGetVarargI = () => {
		var ret = HEAP32[+SYSCALLS.varargs >> 2];
		SYSCALLS.varargs += 4;
		return ret;
	};
	var syscallGetVarargP = syscallGetVarargI;
	var PATH = {
		isAbs: (path) => path.charAt(0) === "/",
		splitPath: (filename) => {
			return /^(\/?|)([\s\S]*?)((?:\.{1,2}|[^\/]+?|)(\.[^.\/]*|))(?:[\/]*)$/.exec(filename).slice(1);
		},
		normalizeArray: (parts, allowAboveRoot) => {
			var up = 0;
			for (var i = parts.length - 1; i >= 0; i--) {
				var last = parts[i];
				if (last === ".") parts.splice(i, 1);
				else if (last === "..") {
					parts.splice(i, 1);
					up++;
				} else if (up) {
					parts.splice(i, 1);
					up--;
				}
			}
			if (allowAboveRoot) for (; up; up--) parts.unshift("..");
			return parts;
		},
		normalize: (path) => {
			var isAbsolute = PATH.isAbs(path), trailingSlash = path.slice(-1) === "/";
			path = PATH.normalizeArray(path.split("/").filter((p) => !!p), !isAbsolute).join("/");
			if (!path && !isAbsolute) path = ".";
			if (path && trailingSlash) path += "/";
			return (isAbsolute ? "/" : "") + path;
		},
		dirname: (path) => {
			var result = PATH.splitPath(path), root = result[0], dir = result[1];
			if (!root && !dir) return ".";
			if (dir) dir = dir.slice(0, -1);
			return root + dir;
		},
		basename: (path) => path && path.match(/([^\/]+|\/)\/*$/)[1],
		join: (...paths) => PATH.normalize(paths.join("/")),
		join2: (l, r) => PATH.normalize(l + "/" + r)
	};
	var initRandomFill = () => (view) => (crypto.getRandomValues(view), 0);
	var randomFill = (view) => (randomFill = initRandomFill())(view);
	var PATH_FS = {
		resolve: (...args) => {
			var resolvedPath = "", resolvedAbsolute = false;
			for (var i = args.length - 1; i >= -1 && !resolvedAbsolute; i--) {
				var path = i >= 0 ? args[i] : FS.cwd();
				if (typeof path != "string") throw new TypeError("Arguments to path.resolve must be strings");
				else if (!path) return "";
				resolvedPath = path + "/" + resolvedPath;
				resolvedAbsolute = PATH.isAbs(path);
			}
			resolvedPath = PATH.normalizeArray(resolvedPath.split("/").filter((p) => !!p), !resolvedAbsolute).join("/");
			return (resolvedAbsolute ? "/" : "") + resolvedPath || ".";
		},
		relative: (from, to) => {
			from = PATH_FS.resolve(from).slice(1);
			to = PATH_FS.resolve(to).slice(1);
			function trim(arr) {
				var start = 0;
				for (; start < arr.length; start++) if (arr[start] !== "") break;
				var end = arr.length - 1;
				for (; end >= 0; end--) if (arr[end] !== "") break;
				if (start > end) return [];
				return arr.slice(start, end - start + 1);
			}
			var fromParts = trim(from.split("/"));
			var toParts = trim(to.split("/"));
			var length = Math.min(fromParts.length, toParts.length);
			var samePartsLength = length;
			for (var i = 0; i < length; i++) if (fromParts[i] !== toParts[i]) {
				samePartsLength = i;
				break;
			}
			var outputParts = [];
			for (var i = samePartsLength; i < fromParts.length; i++) outputParts.push("..");
			outputParts = outputParts.concat(toParts.slice(samePartsLength));
			return outputParts.join("/");
		}
	};
	var UTF8Decoder = globalThis.TextDecoder && new TextDecoder();
	var findStringEnd = (heapOrArray, idx, maxBytesToRead, ignoreNul) => {
		var maxIdx = idx + maxBytesToRead;
		if (ignoreNul) return maxIdx;
		while (heapOrArray[idx] && !(idx >= maxIdx)) ++idx;
		return idx;
	};
	var UTF8ArrayToString = (heapOrArray, idx = 0, maxBytesToRead, ignoreNul) => {
		var endPtr = findStringEnd(heapOrArray, idx, maxBytesToRead, ignoreNul);
		if (endPtr - idx > 16 && heapOrArray.buffer && UTF8Decoder) return UTF8Decoder.decode(heapOrArray.subarray(idx, endPtr));
		var str = "";
		while (idx < endPtr) {
			var u0 = heapOrArray[idx++];
			if (!(u0 & 128)) {
				str += String.fromCharCode(u0);
				continue;
			}
			var u1 = heapOrArray[idx++] & 63;
			if ((u0 & 224) == 192) {
				str += String.fromCharCode((u0 & 31) << 6 | u1);
				continue;
			}
			var u2 = heapOrArray[idx++] & 63;
			if ((u0 & 240) == 224) u0 = (u0 & 15) << 12 | u1 << 6 | u2;
			else u0 = (u0 & 7) << 18 | u1 << 12 | u2 << 6 | heapOrArray[idx++] & 63;
			if (u0 < 65536) str += String.fromCharCode(u0);
			else {
				var ch = u0 - 65536;
				str += String.fromCharCode(55296 | ch >> 10, 56320 | ch & 1023);
			}
		}
		return str;
	};
	var FS_stdin_getChar_buffer = [];
	var lengthBytesUTF8 = (str) => {
		var len = 0;
		for (var i = 0; i < str.length; ++i) {
			var c = str.charCodeAt(i);
			if (c <= 127) len++;
			else if (c <= 2047) len += 2;
			else if (c >= 55296 && c <= 57343) {
				len += 4;
				++i;
			} else len += 3;
		}
		return len;
	};
	var stringToUTF8Array = (str, heap, outIdx, maxBytesToWrite) => {
		if (!(maxBytesToWrite > 0)) return 0;
		var startIdx = outIdx;
		var endIdx = outIdx + maxBytesToWrite - 1;
		for (var i = 0; i < str.length; ++i) {
			var u = str.codePointAt(i);
			if (u <= 127) {
				if (outIdx >= endIdx) break;
				heap[outIdx++] = u;
			} else if (u <= 2047) {
				if (outIdx + 1 >= endIdx) break;
				heap[outIdx++] = 192 | u >> 6;
				heap[outIdx++] = 128 | u & 63;
			} else if (u <= 65535) {
				if (outIdx + 2 >= endIdx) break;
				heap[outIdx++] = 224 | u >> 12;
				heap[outIdx++] = 128 | u >> 6 & 63;
				heap[outIdx++] = 128 | u & 63;
			} else {
				if (outIdx + 3 >= endIdx) break;
				heap[outIdx++] = 240 | u >> 18;
				heap[outIdx++] = 128 | u >> 12 & 63;
				heap[outIdx++] = 128 | u >> 6 & 63;
				heap[outIdx++] = 128 | u & 63;
				i++;
			}
		}
		heap[outIdx] = 0;
		return outIdx - startIdx;
	};
	var intArrayFromString = (stringy, dontAddNull, length) => {
		var len = length > 0 ? length : lengthBytesUTF8(stringy) + 1;
		var u8array = new Array(len);
		var numBytesWritten = stringToUTF8Array(stringy, u8array, 0, u8array.length);
		if (dontAddNull) u8array.length = numBytesWritten;
		return u8array;
	};
	var FS_stdin_getChar = () => {
		if (!FS_stdin_getChar_buffer.length) {
			var result = null;
			if (globalThis.window?.prompt) {
				result = window.prompt("Input: ");
				if (result !== null) result += "\n";
			}
			if (!result) return null;
			FS_stdin_getChar_buffer = intArrayFromString(result, true);
		}
		return FS_stdin_getChar_buffer.shift();
	};
	var TTY = {
		ttys: [],
		init() {},
		shutdown() {},
		register(dev, ops) {
			TTY.ttys[dev] = {
				input: [],
				output: [],
				ops
			};
			FS.registerDevice(dev, TTY.stream_ops);
		},
		stream_ops: {
			open(stream) {
				var tty = TTY.ttys[stream.node.rdev];
				if (!tty) throw new FS.ErrnoError(43);
				stream.tty = tty;
				stream.seekable = false;
			},
			close(stream) {
				stream.tty.ops.fsync(stream.tty);
			},
			fsync(stream) {
				stream.tty.ops.fsync(stream.tty);
			},
			read(stream, buffer, offset, length, pos) {
				if (!stream.tty || !stream.tty.ops.get_char) throw new FS.ErrnoError(60);
				var bytesRead = 0;
				for (var i = 0; i < length; i++) {
					var result;
					try {
						result = stream.tty.ops.get_char(stream.tty);
					} catch (e) {
						throw new FS.ErrnoError(29);
					}
					if (result === void 0 && bytesRead === 0) throw new FS.ErrnoError(6);
					if (result === null || result === void 0) break;
					bytesRead++;
					buffer[offset + i] = result;
				}
				if (bytesRead) stream.node.atime = Date.now();
				return bytesRead;
			},
			write(stream, buffer, offset, length, pos) {
				if (!stream.tty || !stream.tty.ops.put_char) throw new FS.ErrnoError(60);
				try {
					for (var i = 0; i < length; i++) stream.tty.ops.put_char(stream.tty, buffer[offset + i]);
				} catch (e) {
					throw new FS.ErrnoError(29);
				}
				if (length) stream.node.mtime = stream.node.ctime = Date.now();
				return i;
			}
		},
		default_tty_ops: {
			get_char(tty) {
				return FS_stdin_getChar();
			},
			put_char(tty, val) {
				if (val === null || val === 10) {
					out(UTF8ArrayToString(tty.output));
					tty.output = [];
				} else if (val != 0) tty.output.push(val);
			},
			fsync(tty) {
				if (tty.output?.length > 0) {
					out(UTF8ArrayToString(tty.output));
					tty.output = [];
				}
			},
			ioctl_tcgets(tty) {
				return {
					c_iflag: 25856,
					c_oflag: 5,
					c_cflag: 191,
					c_lflag: 35387,
					c_cc: [
						3,
						28,
						127,
						21,
						4,
						0,
						1,
						0,
						17,
						19,
						26,
						0,
						18,
						15,
						23,
						22,
						0,
						0,
						0,
						0,
						0,
						0,
						0,
						0,
						0,
						0,
						0,
						0,
						0,
						0,
						0,
						0
					]
				};
			},
			ioctl_tcsets(tty, optional_actions, data) {
				return 0;
			},
			ioctl_tiocgwinsz(tty) {
				return [24, 80];
			}
		},
		default_tty1_ops: {
			put_char(tty, val) {
				if (val === null || val === 10) {
					err(UTF8ArrayToString(tty.output));
					tty.output = [];
				} else if (val != 0) tty.output.push(val);
			},
			fsync(tty) {
				if (tty.output?.length > 0) {
					err(UTF8ArrayToString(tty.output));
					tty.output = [];
				}
			}
		}
	};
	var mmapAlloc = (size) => {
		abort();
	};
	var MEMFS = {
		ops_table: null,
		mount(mount) {
			return MEMFS.createNode(null, "/", 16895, 0);
		},
		createNode(parent, name, mode, dev) {
			if (FS.isBlkdev(mode) || FS.isFIFO(mode)) throw new FS.ErrnoError(63);
			MEMFS.ops_table ||= {
				dir: {
					node: {
						getattr: MEMFS.node_ops.getattr,
						setattr: MEMFS.node_ops.setattr,
						lookup: MEMFS.node_ops.lookup,
						mknod: MEMFS.node_ops.mknod,
						rename: MEMFS.node_ops.rename,
						unlink: MEMFS.node_ops.unlink,
						rmdir: MEMFS.node_ops.rmdir,
						readdir: MEMFS.node_ops.readdir,
						symlink: MEMFS.node_ops.symlink
					},
					stream: { llseek: MEMFS.stream_ops.llseek }
				},
				file: {
					node: {
						getattr: MEMFS.node_ops.getattr,
						setattr: MEMFS.node_ops.setattr
					},
					stream: {
						llseek: MEMFS.stream_ops.llseek,
						read: MEMFS.stream_ops.read,
						write: MEMFS.stream_ops.write,
						mmap: MEMFS.stream_ops.mmap,
						msync: MEMFS.stream_ops.msync
					}
				},
				link: {
					node: {
						getattr: MEMFS.node_ops.getattr,
						setattr: MEMFS.node_ops.setattr,
						readlink: MEMFS.node_ops.readlink
					},
					stream: {}
				},
				chrdev: {
					node: {
						getattr: MEMFS.node_ops.getattr,
						setattr: MEMFS.node_ops.setattr
					},
					stream: FS.chrdev_stream_ops
				}
			};
			var node = FS.createNode(parent, name, mode, dev);
			if (FS.isDir(node.mode)) {
				node.node_ops = MEMFS.ops_table.dir.node;
				node.stream_ops = MEMFS.ops_table.dir.stream;
				node.contents = {};
			} else if (FS.isFile(node.mode)) {
				node.node_ops = MEMFS.ops_table.file.node;
				node.stream_ops = MEMFS.ops_table.file.stream;
				node.usedBytes = 0;
				node.contents = MEMFS.emptyFileContents ??= new Uint8Array(0);
			} else if (FS.isLink(node.mode)) {
				node.node_ops = MEMFS.ops_table.link.node;
				node.stream_ops = MEMFS.ops_table.link.stream;
			} else if (FS.isChrdev(node.mode)) {
				node.node_ops = MEMFS.ops_table.chrdev.node;
				node.stream_ops = MEMFS.ops_table.chrdev.stream;
			}
			node.atime = node.mtime = node.ctime = Date.now();
			if (parent) {
				parent.contents[name] = node;
				parent.atime = parent.mtime = parent.ctime = node.atime;
			}
			return node;
		},
		getFileDataAsTypedArray(node) {
			return node.contents.subarray(0, node.usedBytes);
		},
		expandFileStorage(node, newCapacity) {
			var prevCapacity = node.contents.length;
			if (prevCapacity >= newCapacity) return;
			newCapacity = Math.max(newCapacity, prevCapacity * (prevCapacity < 1024 * 1024 ? 2 : 1.125) >>> 0);
			if (prevCapacity) newCapacity = Math.max(newCapacity, 256);
			var oldContents = MEMFS.getFileDataAsTypedArray(node);
			node.contents = new Uint8Array(newCapacity);
			node.contents.set(oldContents);
		},
		resizeFileStorage(node, newSize) {
			if (node.usedBytes == newSize) return;
			var oldContents = node.contents;
			node.contents = new Uint8Array(newSize);
			node.contents.set(oldContents.subarray(0, Math.min(newSize, node.usedBytes)));
			node.usedBytes = newSize;
		},
		node_ops: {
			getattr(node) {
				var attr = {};
				attr.dev = FS.isChrdev(node.mode) ? node.id : 1;
				attr.ino = node.id;
				attr.mode = node.mode;
				attr.nlink = 1;
				attr.uid = 0;
				attr.gid = 0;
				attr.rdev = node.rdev;
				if (FS.isDir(node.mode)) attr.size = 4096;
				else if (FS.isFile(node.mode)) attr.size = node.usedBytes;
				else if (FS.isLink(node.mode)) attr.size = node.link.length;
				else attr.size = 0;
				attr.atime = new Date(node.atime);
				attr.mtime = new Date(node.mtime);
				attr.ctime = new Date(node.ctime);
				attr.blksize = 4096;
				attr.blocks = Math.ceil(attr.size / attr.blksize);
				return attr;
			},
			setattr(node, attr) {
				for (const key of [
					"mode",
					"atime",
					"mtime",
					"ctime"
				]) if (attr[key] != null) node[key] = attr[key];
				if (attr.size !== void 0) MEMFS.resizeFileStorage(node, attr.size);
			},
			lookup(parent, name) {
				if (!MEMFS.doesNotExistError) {
					MEMFS.doesNotExistError = new FS.ErrnoError(44);
					MEMFS.doesNotExistError.stack = "<generic error, no stack>";
				}
				throw MEMFS.doesNotExistError;
			},
			mknod(parent, name, mode, dev) {
				return MEMFS.createNode(parent, name, mode, dev);
			},
			rename(old_node, new_dir, new_name) {
				var new_node;
				try {
					new_node = FS.lookupNode(new_dir, new_name);
				} catch (e) {}
				if (new_node) {
					if (FS.isDir(old_node.mode)) for (var i in new_node.contents) throw new FS.ErrnoError(55);
					FS.hashRemoveNode(new_node);
				}
				delete old_node.parent.contents[old_node.name];
				new_dir.contents[new_name] = old_node;
				old_node.name = new_name;
				new_dir.ctime = new_dir.mtime = old_node.parent.ctime = old_node.parent.mtime = Date.now();
			},
			unlink(parent, name) {
				delete parent.contents[name];
				parent.ctime = parent.mtime = Date.now();
			},
			rmdir(parent, name) {
				for (var i in FS.lookupNode(parent, name).contents) throw new FS.ErrnoError(55);
				delete parent.contents[name];
				parent.ctime = parent.mtime = Date.now();
			},
			readdir(node) {
				return [
					".",
					"..",
					...Object.keys(node.contents)
				];
			},
			symlink(parent, newname, oldpath) {
				var node = MEMFS.createNode(parent, newname, 41471, 0);
				node.link = oldpath;
				return node;
			},
			readlink(node) {
				if (!FS.isLink(node.mode)) throw new FS.ErrnoError(28);
				return node.link;
			}
		},
		stream_ops: {
			read(stream, buffer, offset, length, position) {
				var contents = stream.node.contents;
				if (position >= stream.node.usedBytes) return 0;
				var size = Math.min(stream.node.usedBytes - position, length);
				buffer.set(contents.subarray(position, position + size), offset);
				return size;
			},
			write(stream, buffer, offset, length, position, canOwn) {
				if (buffer.buffer === HEAP8.buffer) canOwn = false;
				if (!length) return 0;
				var node = stream.node;
				node.mtime = node.ctime = Date.now();
				if (canOwn) {
					node.contents = buffer.subarray(offset, offset + length);
					node.usedBytes = length;
				} else if (node.usedBytes === 0 && position === 0) {
					node.contents = buffer.slice(offset, offset + length);
					node.usedBytes = length;
				} else {
					MEMFS.expandFileStorage(node, position + length);
					node.contents.set(buffer.subarray(offset, offset + length), position);
					node.usedBytes = Math.max(node.usedBytes, position + length);
				}
				return length;
			},
			llseek(stream, offset, whence) {
				var position = offset;
				if (whence === 1) position += stream.position;
				else if (whence === 2) {
					if (FS.isFile(stream.node.mode)) position += stream.node.usedBytes;
				}
				if (position < 0) throw new FS.ErrnoError(28);
				return position;
			},
			mmap(stream, length, position, prot, flags) {
				if (!FS.isFile(stream.node.mode)) throw new FS.ErrnoError(43);
				var ptr;
				var allocated;
				var contents = stream.node.contents;
				if (!(flags & 2) && contents.buffer === HEAP8.buffer) {
					allocated = false;
					ptr = contents.byteOffset;
				} else {
					allocated = true;
					ptr = mmapAlloc(length);
					if (!ptr) throw new FS.ErrnoError(48);
					if (contents) {
						if (position > 0 || position + length < contents.length) if (contents.subarray) contents = contents.subarray(position, position + length);
						else contents = Array.prototype.slice.call(contents, position, position + length);
						HEAP8.set(contents, ptr);
					}
				}
				return {
					ptr,
					allocated
				};
			},
			msync(stream, buffer, offset, length, mmapFlags) {
				MEMFS.stream_ops.write(stream, buffer, 0, length, offset, false);
				return 0;
			}
		}
	};
	var FS_modeStringToFlags = (str) => {
		if (typeof str != "string") return str;
		var flags = {
			r: 0,
			"r+": 2,
			w: 577,
			"w+": 578,
			a: 1089,
			"a+": 1090
		}[str];
		if (typeof flags == "undefined") throw new Error(`Unknown file open mode: ${str}`);
		return flags;
	};
	var FS_fileDataToTypedArray = (data) => {
		if (typeof data == "string") data = intArrayFromString(data, true);
		if (!data.subarray) data = new Uint8Array(data);
		return data;
	};
	var FS_getMode = (canRead, canWrite) => {
		var mode = 0;
		if (canRead) mode |= 365;
		if (canWrite) mode |= 146;
		return mode;
	};
	var asyncLoad = async (url) => {
		var arrayBuffer = await readAsync(url);
		return new Uint8Array(arrayBuffer);
	};
	var FS_createDataFile = (...args) => FS.createDataFile(...args);
	var getUniqueRunDependency = (id) => id;
	var runDependencies = 0;
	var dependenciesFulfilled = null;
	var removeRunDependency = (id) => {
		runDependencies--;
		Module["monitorRunDependencies"]?.(runDependencies);
		if (runDependencies == 0) {
			if (dependenciesFulfilled) {
				var callback = dependenciesFulfilled;
				dependenciesFulfilled = null;
				callback();
			}
		}
	};
	var addRunDependency = (id) => {
		runDependencies++;
		Module["monitorRunDependencies"]?.(runDependencies);
	};
	var preloadPlugins = [];
	var FS_handledByPreloadPlugin = async (byteArray, fullname) => {
		if (typeof Browser != "undefined") Browser.init();
		for (var plugin of preloadPlugins) if (plugin["canHandle"](fullname)) return plugin["handle"](byteArray, fullname);
		return byteArray;
	};
	var FS_preloadFile = async (parent, name, url, canRead, canWrite, dontCreateFile, canOwn, preFinish) => {
		var fullname = name ? PATH_FS.resolve(PATH.join2(parent, name)) : parent;
		var dep = getUniqueRunDependency(`cp ${fullname}`);
		addRunDependency(dep);
		try {
			var byteArray = url;
			if (typeof url == "string") byteArray = await asyncLoad(url);
			byteArray = await FS_handledByPreloadPlugin(byteArray, fullname);
			preFinish?.();
			if (!dontCreateFile) FS_createDataFile(parent, name, byteArray, canRead, canWrite, canOwn);
		} finally {
			removeRunDependency(dep);
		}
	};
	var FS_createPreloadedFile = (parent, name, url, canRead, canWrite, onload, onerror, dontCreateFile, canOwn, preFinish) => {
		FS_preloadFile(parent, name, url, canRead, canWrite, dontCreateFile, canOwn, preFinish).then(onload).catch(onerror);
	};
	var FS = {
		root: null,
		mounts: [],
		devices: {},
		streams: [],
		nextInode: 1,
		nameTable: null,
		currentPath: "/",
		initialized: false,
		ignorePermissions: true,
		filesystems: null,
		syncFSRequests: 0,
		ErrnoError: class {
			name = "ErrnoError";
			constructor(errno) {
				this.errno = errno;
			}
		},
		FSStream: class {
			shared = {};
			get object() {
				return this.node;
			}
			set object(val) {
				this.node = val;
			}
			get isRead() {
				return (this.flags & 2097155) !== 1;
			}
			get isWrite() {
				return (this.flags & 2097155) !== 0;
			}
			get isAppend() {
				return this.flags & 1024;
			}
			get flags() {
				return this.shared.flags;
			}
			set flags(val) {
				this.shared.flags = val;
			}
			get position() {
				return this.shared.position;
			}
			set position(val) {
				this.shared.position = val;
			}
		},
		FSNode: class {
			node_ops = {};
			stream_ops = {};
			readMode = 365;
			writeMode = 146;
			mounted = null;
			constructor(parent, name, mode, rdev) {
				if (!parent) parent = this;
				this.parent = parent;
				this.mount = parent.mount;
				this.id = FS.nextInode++;
				this.name = name;
				this.mode = mode;
				this.rdev = rdev;
				this.atime = this.mtime = this.ctime = Date.now();
			}
			get read() {
				return (this.mode & this.readMode) === this.readMode;
			}
			set read(val) {
				val ? this.mode |= this.readMode : this.mode &= ~this.readMode;
			}
			get write() {
				return (this.mode & this.writeMode) === this.writeMode;
			}
			set write(val) {
				val ? this.mode |= this.writeMode : this.mode &= ~this.writeMode;
			}
			get isFolder() {
				return FS.isDir(this.mode);
			}
			get isDevice() {
				return FS.isChrdev(this.mode);
			}
		},
		lookupPath(path, opts = {}) {
			if (!path) throw new FS.ErrnoError(44);
			opts.follow_mount ??= true;
			if (!PATH.isAbs(path)) path = FS.cwd() + "/" + path;
			linkloop: for (var nlinks = 0; nlinks < 40; nlinks++) {
				var parts = path.split("/").filter((p) => !!p);
				var current = FS.root;
				var current_path = "/";
				for (var i = 0; i < parts.length; i++) {
					var islast = i === parts.length - 1;
					if (islast && opts.parent) break;
					if (parts[i] === ".") continue;
					if (parts[i] === "..") {
						current_path = PATH.dirname(current_path);
						if (FS.isRoot(current)) {
							path = current_path + "/" + parts.slice(i + 1).join("/");
							nlinks--;
							continue linkloop;
						} else current = current.parent;
						continue;
					}
					current_path = PATH.join2(current_path, parts[i]);
					try {
						current = FS.lookupNode(current, parts[i]);
					} catch (e) {
						if (e?.errno === 44 && islast && opts.noent_okay) return { path: current_path };
						throw e;
					}
					if (FS.isMountpoint(current) && (!islast || opts.follow_mount)) current = current.mounted.root;
					if (FS.isLink(current.mode) && (!islast || opts.follow)) {
						if (!current.node_ops.readlink) throw new FS.ErrnoError(52);
						var link = current.node_ops.readlink(current);
						if (!PATH.isAbs(link)) link = PATH.dirname(current_path) + "/" + link;
						path = link + "/" + parts.slice(i + 1).join("/");
						continue linkloop;
					}
				}
				return {
					path: current_path,
					node: current
				};
			}
			throw new FS.ErrnoError(32);
		},
		getPath(node) {
			var path;
			while (true) {
				if (FS.isRoot(node)) {
					var mount = node.mount.mountpoint;
					if (!path) return mount;
					return mount[mount.length - 1] !== "/" ? `${mount}/${path}` : mount + path;
				}
				path = path ? `${node.name}/${path}` : node.name;
				node = node.parent;
			}
		},
		hashName(parentid, name) {
			var hash = 0;
			for (var i = 0; i < name.length; i++) hash = (hash << 5) - hash + name.charCodeAt(i) | 0;
			return (parentid + hash >>> 0) % FS.nameTable.length;
		},
		hashAddNode(node) {
			var hash = FS.hashName(node.parent.id, node.name);
			node.name_next = FS.nameTable[hash];
			FS.nameTable[hash] = node;
		},
		hashRemoveNode(node) {
			var hash = FS.hashName(node.parent.id, node.name);
			if (FS.nameTable[hash] === node) FS.nameTable[hash] = node.name_next;
			else {
				var current = FS.nameTable[hash];
				while (current) {
					if (current.name_next === node) {
						current.name_next = node.name_next;
						break;
					}
					current = current.name_next;
				}
			}
		},
		lookupNode(parent, name) {
			var errCode = FS.mayLookup(parent);
			if (errCode) throw new FS.ErrnoError(errCode);
			var hash = FS.hashName(parent.id, name);
			for (var node = FS.nameTable[hash]; node; node = node.name_next) {
				var nodeName = node.name;
				if (node.parent.id === parent.id && nodeName === name) return node;
			}
			return FS.lookup(parent, name);
		},
		createNode(parent, name, mode, rdev) {
			var node = new FS.FSNode(parent, name, mode, rdev);
			FS.hashAddNode(node);
			return node;
		},
		destroyNode(node) {
			FS.hashRemoveNode(node);
		},
		isRoot(node) {
			return node === node.parent;
		},
		isMountpoint(node) {
			return !!node.mounted;
		},
		isFile(mode) {
			return (mode & 61440) === 32768;
		},
		isDir(mode) {
			return (mode & 61440) === 16384;
		},
		isLink(mode) {
			return (mode & 61440) === 40960;
		},
		isChrdev(mode) {
			return (mode & 61440) === 8192;
		},
		isBlkdev(mode) {
			return (mode & 61440) === 24576;
		},
		isFIFO(mode) {
			return (mode & 61440) === 4096;
		},
		isSocket(mode) {
			return (mode & 49152) === 49152;
		},
		flagsToPermissionString(flag) {
			var perms = [
				"r",
				"w",
				"rw"
			][flag & 3];
			if (flag & 512) perms += "w";
			return perms;
		},
		nodePermissions(node, perms) {
			if (FS.ignorePermissions) return 0;
			if (perms.includes("r") && !(node.mode & 292)) return 2;
			if (perms.includes("w") && !(node.mode & 146)) return 2;
			if (perms.includes("x") && !(node.mode & 73)) return 2;
			return 0;
		},
		mayLookup(dir) {
			if (!FS.isDir(dir.mode)) return 54;
			var errCode = FS.nodePermissions(dir, "x");
			if (errCode) return errCode;
			if (!dir.node_ops.lookup) return 2;
			return 0;
		},
		mayCreate(dir, name) {
			if (!FS.isDir(dir.mode)) return 54;
			try {
				FS.lookupNode(dir, name);
				return 20;
			} catch (e) {}
			return FS.nodePermissions(dir, "wx");
		},
		mayDelete(dir, name, isdir) {
			var node;
			try {
				node = FS.lookupNode(dir, name);
			} catch (e) {
				return e.errno;
			}
			var errCode = FS.nodePermissions(dir, "wx");
			if (errCode) return errCode;
			if (isdir) {
				if (!FS.isDir(node.mode)) return 54;
				if (FS.isRoot(node) || FS.getPath(node) === FS.cwd()) return 10;
			} else if (FS.isDir(node.mode)) return 31;
			return 0;
		},
		mayOpen(node, flags) {
			if (!node) return 44;
			if (FS.isLink(node.mode)) return 32;
			var mode = FS.flagsToPermissionString(flags);
			if (FS.isDir(node.mode)) {
				if (mode !== "r" || flags & 576) return 31;
			}
			return FS.nodePermissions(node, mode);
		},
		checkOpExists(op, err) {
			if (!op) throw new FS.ErrnoError(err);
			return op;
		},
		MAX_OPEN_FDS: 4096,
		nextfd() {
			for (var fd = 0; fd <= FS.MAX_OPEN_FDS; fd++) if (!FS.streams[fd]) return fd;
			throw new FS.ErrnoError(33);
		},
		getStreamChecked(fd) {
			var stream = FS.getStream(fd);
			if (!stream) throw new FS.ErrnoError(8);
			return stream;
		},
		getStream: (fd) => FS.streams[fd],
		createStream(stream, fd = -1) {
			stream = Object.assign(new FS.FSStream(), stream);
			if (fd == -1) fd = FS.nextfd();
			stream.fd = fd;
			FS.streams[fd] = stream;
			return stream;
		},
		closeStream(fd) {
			FS.streams[fd] = null;
		},
		dupStream(origStream, fd = -1) {
			var stream = FS.createStream(origStream, fd);
			stream.stream_ops?.dup?.(stream);
			return stream;
		},
		doSetAttr(stream, node, attr) {
			var setattr = stream?.stream_ops.setattr;
			var arg = setattr ? stream : node;
			setattr ??= node.node_ops.setattr;
			FS.checkOpExists(setattr, 63);
			setattr(arg, attr);
		},
		chrdev_stream_ops: {
			open(stream) {
				stream.stream_ops = FS.getDevice(stream.node.rdev).stream_ops;
				stream.stream_ops.open?.(stream);
			},
			llseek() {
				throw new FS.ErrnoError(70);
			}
		},
		major: (dev) => dev >> 8,
		minor: (dev) => dev & 255,
		makedev: (ma, mi) => ma << 8 | mi,
		registerDevice(dev, ops) {
			FS.devices[dev] = { stream_ops: ops };
		},
		getDevice: (dev) => FS.devices[dev],
		getMounts(mount) {
			var mounts = [];
			var check = [mount];
			while (check.length) {
				var m = check.pop();
				mounts.push(m);
				check.push(...m.mounts);
			}
			return mounts;
		},
		syncfs(populate, callback) {
			if (typeof populate == "function") {
				callback = populate;
				populate = false;
			}
			FS.syncFSRequests++;
			if (FS.syncFSRequests > 1) err(`warning: ${FS.syncFSRequests} FS.syncfs operations in flight at once, probably just doing extra work`);
			var mounts = FS.getMounts(FS.root.mount);
			var completed = 0;
			function doCallback(errCode) {
				FS.syncFSRequests--;
				return callback(errCode);
			}
			function done(errCode) {
				if (errCode) {
					if (!done.errored) {
						done.errored = true;
						return doCallback(errCode);
					}
					return;
				}
				if (++completed >= mounts.length) doCallback(null);
			}
			for (var mount of mounts) if (mount.type.syncfs) mount.type.syncfs(mount, populate, done);
			else done(null);
		},
		mount(type, opts, mountpoint) {
			var root = mountpoint === "/";
			var pseudo = !mountpoint;
			var node;
			if (root && FS.root) throw new FS.ErrnoError(10);
			else if (!root && !pseudo) {
				var lookup = FS.lookupPath(mountpoint, { follow_mount: false });
				mountpoint = lookup.path;
				node = lookup.node;
				if (FS.isMountpoint(node)) throw new FS.ErrnoError(10);
				if (!FS.isDir(node.mode)) throw new FS.ErrnoError(54);
			}
			var mount = {
				type,
				opts,
				mountpoint,
				mounts: []
			};
			var mountRoot = type.mount(mount);
			mountRoot.mount = mount;
			mount.root = mountRoot;
			if (root) FS.root = mountRoot;
			else if (node) {
				node.mounted = mount;
				if (node.mount) node.mount.mounts.push(mount);
			}
			return mountRoot;
		},
		unmount(mountpoint) {
			var lookup = FS.lookupPath(mountpoint, { follow_mount: false });
			if (!FS.isMountpoint(lookup.node)) throw new FS.ErrnoError(28);
			var node = lookup.node;
			var mount = node.mounted;
			var mounts = FS.getMounts(mount);
			for (var [hash, current] of Object.entries(FS.nameTable)) while (current) {
				var next = current.name_next;
				if (mounts.includes(current.mount)) FS.destroyNode(current);
				current = next;
			}
			node.mounted = null;
			var idx = node.mount.mounts.indexOf(mount);
			node.mount.mounts.splice(idx, 1);
		},
		lookup(parent, name) {
			return parent.node_ops.lookup(parent, name);
		},
		mknod(path, mode, dev) {
			var parent = FS.lookupPath(path, { parent: true }).node;
			var name = PATH.basename(path);
			if (!name) throw new FS.ErrnoError(28);
			if (name === "." || name === "..") throw new FS.ErrnoError(20);
			var errCode = FS.mayCreate(parent, name);
			if (errCode) throw new FS.ErrnoError(errCode);
			if (!parent.node_ops.mknod) throw new FS.ErrnoError(63);
			return parent.node_ops.mknod(parent, name, mode, dev);
		},
		statfs(path) {
			return FS.statfsNode(FS.lookupPath(path, { follow: true }).node);
		},
		statfsStream(stream) {
			return FS.statfsNode(stream.node);
		},
		statfsNode(node) {
			var rtn = {
				bsize: 4096,
				frsize: 4096,
				blocks: 1e6,
				bfree: 5e5,
				bavail: 5e5,
				files: FS.nextInode,
				ffree: FS.nextInode - 1,
				fsid: 42,
				flags: 2,
				namelen: 255
			};
			if (node.node_ops.statfs) Object.assign(rtn, node.node_ops.statfs(node.mount.opts.root));
			return rtn;
		},
		create(path, mode = 438) {
			mode &= 4095;
			mode |= 32768;
			return FS.mknod(path, mode, 0);
		},
		mkdir(path, mode = 511) {
			mode &= 1023;
			mode |= 16384;
			return FS.mknod(path, mode, 0);
		},
		mkdirTree(path, mode) {
			var dirs = path.split("/");
			var d = "";
			for (var dir of dirs) {
				if (!dir) continue;
				if (d || PATH.isAbs(path)) d += "/";
				d += dir;
				try {
					FS.mkdir(d, mode);
				} catch (e) {
					if (e.errno != 20) throw e;
				}
			}
		},
		mkdev(path, mode, dev) {
			if (typeof dev == "undefined") {
				dev = mode;
				mode = 438;
			}
			mode |= 8192;
			return FS.mknod(path, mode, dev);
		},
		symlink(oldpath, newpath) {
			if (!PATH_FS.resolve(oldpath)) throw new FS.ErrnoError(44);
			var parent = FS.lookupPath(newpath, { parent: true }).node;
			if (!parent) throw new FS.ErrnoError(44);
			var newname = PATH.basename(newpath);
			var errCode = FS.mayCreate(parent, newname);
			if (errCode) throw new FS.ErrnoError(errCode);
			if (!parent.node_ops.symlink) throw new FS.ErrnoError(63);
			return parent.node_ops.symlink(parent, newname, oldpath);
		},
		rename(old_path, new_path) {
			var old_dirname = PATH.dirname(old_path);
			var new_dirname = PATH.dirname(new_path);
			var old_name = PATH.basename(old_path);
			var new_name = PATH.basename(new_path);
			var lookup = FS.lookupPath(old_path, { parent: true }), old_dir = lookup.node, new_dir;
			lookup = FS.lookupPath(new_path, { parent: true });
			new_dir = lookup.node;
			if (!old_dir || !new_dir) throw new FS.ErrnoError(44);
			if (old_dir.mount !== new_dir.mount) throw new FS.ErrnoError(75);
			var old_node = FS.lookupNode(old_dir, old_name);
			var relative = PATH_FS.relative(old_path, new_dirname);
			if (relative.charAt(0) !== ".") throw new FS.ErrnoError(28);
			relative = PATH_FS.relative(new_path, old_dirname);
			if (relative.charAt(0) !== ".") throw new FS.ErrnoError(55);
			var new_node;
			try {
				new_node = FS.lookupNode(new_dir, new_name);
			} catch (e) {}
			if (old_node === new_node) return;
			var isdir = FS.isDir(old_node.mode);
			var errCode = FS.mayDelete(old_dir, old_name, isdir);
			if (errCode) throw new FS.ErrnoError(errCode);
			errCode = new_node ? FS.mayDelete(new_dir, new_name, isdir) : FS.mayCreate(new_dir, new_name);
			if (errCode) throw new FS.ErrnoError(errCode);
			if (!old_dir.node_ops.rename) throw new FS.ErrnoError(63);
			if (FS.isMountpoint(old_node) || new_node && FS.isMountpoint(new_node)) throw new FS.ErrnoError(10);
			if (new_dir !== old_dir) {
				errCode = FS.nodePermissions(old_dir, "w");
				if (errCode) throw new FS.ErrnoError(errCode);
			}
			FS.hashRemoveNode(old_node);
			try {
				old_dir.node_ops.rename(old_node, new_dir, new_name);
				old_node.parent = new_dir;
			} catch (e) {
				throw e;
			} finally {
				FS.hashAddNode(old_node);
			}
		},
		rmdir(path) {
			var parent = FS.lookupPath(path, { parent: true }).node;
			var name = PATH.basename(path);
			var node = FS.lookupNode(parent, name);
			var errCode = FS.mayDelete(parent, name, true);
			if (errCode) throw new FS.ErrnoError(errCode);
			if (!parent.node_ops.rmdir) throw new FS.ErrnoError(63);
			if (FS.isMountpoint(node)) throw new FS.ErrnoError(10);
			parent.node_ops.rmdir(parent, name);
			FS.destroyNode(node);
		},
		readdir(path) {
			var node = FS.lookupPath(path, { follow: true }).node;
			return FS.checkOpExists(node.node_ops.readdir, 54)(node);
		},
		unlink(path) {
			var parent = FS.lookupPath(path, { parent: true }).node;
			if (!parent) throw new FS.ErrnoError(44);
			var name = PATH.basename(path);
			var node = FS.lookupNode(parent, name);
			var errCode = FS.mayDelete(parent, name, false);
			if (errCode) throw new FS.ErrnoError(errCode);
			if (!parent.node_ops.unlink) throw new FS.ErrnoError(63);
			if (FS.isMountpoint(node)) throw new FS.ErrnoError(10);
			parent.node_ops.unlink(parent, name);
			FS.destroyNode(node);
		},
		readlink(path) {
			var link = FS.lookupPath(path).node;
			if (!link) throw new FS.ErrnoError(44);
			if (!link.node_ops.readlink) throw new FS.ErrnoError(28);
			return link.node_ops.readlink(link);
		},
		stat(path, dontFollow) {
			var node = FS.lookupPath(path, { follow: !dontFollow }).node;
			return FS.checkOpExists(node.node_ops.getattr, 63)(node);
		},
		fstat(fd) {
			var stream = FS.getStreamChecked(fd);
			var node = stream.node;
			var getattr = stream.stream_ops.getattr;
			var arg = getattr ? stream : node;
			getattr ??= node.node_ops.getattr;
			FS.checkOpExists(getattr, 63);
			return getattr(arg);
		},
		lstat(path) {
			return FS.stat(path, true);
		},
		doChmod(stream, node, mode, dontFollow) {
			FS.doSetAttr(stream, node, {
				mode: mode & 4095 | node.mode & -4096,
				ctime: Date.now(),
				dontFollow
			});
		},
		chmod(path, mode, dontFollow) {
			var node;
			if (typeof path == "string") node = FS.lookupPath(path, { follow: !dontFollow }).node;
			else node = path;
			FS.doChmod(null, node, mode, dontFollow);
		},
		lchmod(path, mode) {
			FS.chmod(path, mode, true);
		},
		fchmod(fd, mode) {
			var stream = FS.getStreamChecked(fd);
			FS.doChmod(stream, stream.node, mode, false);
		},
		doChown(stream, node, dontFollow) {
			FS.doSetAttr(stream, node, {
				timestamp: Date.now(),
				dontFollow
			});
		},
		chown(path, uid, gid, dontFollow) {
			var node;
			if (typeof path == "string") node = FS.lookupPath(path, { follow: !dontFollow }).node;
			else node = path;
			FS.doChown(null, node, dontFollow);
		},
		lchown(path, uid, gid) {
			FS.chown(path, uid, gid, true);
		},
		fchown(fd, uid, gid) {
			var stream = FS.getStreamChecked(fd);
			FS.doChown(stream, stream.node, false);
		},
		doTruncate(stream, node, len) {
			if (FS.isDir(node.mode)) throw new FS.ErrnoError(31);
			if (!FS.isFile(node.mode)) throw new FS.ErrnoError(28);
			var errCode = FS.nodePermissions(node, "w");
			if (errCode) throw new FS.ErrnoError(errCode);
			FS.doSetAttr(stream, node, {
				size: len,
				timestamp: Date.now()
			});
		},
		truncate(path, len) {
			if (len < 0) throw new FS.ErrnoError(28);
			var node;
			if (typeof path == "string") node = FS.lookupPath(path, { follow: true }).node;
			else node = path;
			FS.doTruncate(null, node, len);
		},
		ftruncate(fd, len) {
			var stream = FS.getStreamChecked(fd);
			if (len < 0 || (stream.flags & 2097155) === 0) throw new FS.ErrnoError(28);
			FS.doTruncate(stream, stream.node, len);
		},
		utime(path, atime, mtime) {
			var node = FS.lookupPath(path, { follow: true }).node;
			FS.checkOpExists(node.node_ops.setattr, 63)(node, {
				atime,
				mtime
			});
		},
		open(path, flags, mode = 438) {
			if (path === "") throw new FS.ErrnoError(44);
			flags = FS_modeStringToFlags(flags);
			if (flags & 64) mode = mode & 4095 | 32768;
			else mode = 0;
			var node;
			var isDirPath;
			if (typeof path == "object") node = path;
			else {
				isDirPath = path.endsWith("/");
				var lookup = FS.lookupPath(path, {
					follow: !(flags & 131072),
					noent_okay: true
				});
				node = lookup.node;
				path = lookup.path;
			}
			var created = false;
			if (flags & 64) if (node) {
				if (flags & 128) throw new FS.ErrnoError(20);
			} else if (isDirPath) throw new FS.ErrnoError(31);
			else {
				node = FS.mknod(path, mode | 511, 0);
				created = true;
			}
			if (!node) throw new FS.ErrnoError(44);
			if (FS.isChrdev(node.mode)) flags &= -513;
			if (flags & 65536 && !FS.isDir(node.mode)) throw new FS.ErrnoError(54);
			if (!created) {
				var errCode = FS.mayOpen(node, flags);
				if (errCode) throw new FS.ErrnoError(errCode);
			}
			if (flags & 512 && !created) FS.truncate(node, 0);
			flags &= -131713;
			var stream = FS.createStream({
				node,
				path: FS.getPath(node),
				flags,
				seekable: true,
				position: 0,
				stream_ops: node.stream_ops,
				ungotten: [],
				error: false
			});
			if (stream.stream_ops.open) stream.stream_ops.open(stream);
			if (created) FS.chmod(node, mode & 511);
			return stream;
		},
		close(stream) {
			if (FS.isClosed(stream)) throw new FS.ErrnoError(8);
			if (stream.getdents) stream.getdents = null;
			try {
				if (stream.stream_ops.close) stream.stream_ops.close(stream);
			} catch (e) {
				throw e;
			} finally {
				FS.closeStream(stream.fd);
			}
			stream.fd = null;
		},
		isClosed(stream) {
			return stream.fd === null;
		},
		llseek(stream, offset, whence) {
			if (FS.isClosed(stream)) throw new FS.ErrnoError(8);
			if (!stream.seekable || !stream.stream_ops.llseek) throw new FS.ErrnoError(70);
			if (whence != 0 && whence != 1 && whence != 2) throw new FS.ErrnoError(28);
			stream.position = stream.stream_ops.llseek(stream, offset, whence);
			stream.ungotten = [];
			return stream.position;
		},
		read(stream, buffer, offset, length, position) {
			if (length < 0 || position < 0) throw new FS.ErrnoError(28);
			if (FS.isClosed(stream)) throw new FS.ErrnoError(8);
			if ((stream.flags & 2097155) === 1) throw new FS.ErrnoError(8);
			if (FS.isDir(stream.node.mode)) throw new FS.ErrnoError(31);
			if (!stream.stream_ops.read) throw new FS.ErrnoError(28);
			var seeking = typeof position != "undefined";
			if (!seeking) position = stream.position;
			else if (!stream.seekable) throw new FS.ErrnoError(70);
			var bytesRead = stream.stream_ops.read(stream, buffer, offset, length, position);
			if (!seeking) stream.position += bytesRead;
			return bytesRead;
		},
		write(stream, buffer, offset, length, position, canOwn) {
			if (length < 0 || position < 0) throw new FS.ErrnoError(28);
			if (FS.isClosed(stream)) throw new FS.ErrnoError(8);
			if ((stream.flags & 2097155) === 0) throw new FS.ErrnoError(8);
			if (FS.isDir(stream.node.mode)) throw new FS.ErrnoError(31);
			if (!stream.stream_ops.write) throw new FS.ErrnoError(28);
			if (stream.seekable && stream.flags & 1024) FS.llseek(stream, 0, 2);
			var seeking = typeof position != "undefined";
			if (!seeking) position = stream.position;
			else if (!stream.seekable) throw new FS.ErrnoError(70);
			var bytesWritten = stream.stream_ops.write(stream, buffer, offset, length, position, canOwn);
			if (!seeking) stream.position += bytesWritten;
			return bytesWritten;
		},
		mmap(stream, length, position, prot, flags) {
			if ((prot & 2) !== 0 && (flags & 2) === 0 && (stream.flags & 2097155) !== 2) throw new FS.ErrnoError(2);
			if ((stream.flags & 2097155) === 1) throw new FS.ErrnoError(2);
			if (!stream.stream_ops.mmap) throw new FS.ErrnoError(43);
			if (!length) throw new FS.ErrnoError(28);
			return stream.stream_ops.mmap(stream, length, position, prot, flags);
		},
		msync(stream, buffer, offset, length, mmapFlags) {
			if (!stream.stream_ops.msync) return 0;
			return stream.stream_ops.msync(stream, buffer, offset, length, mmapFlags);
		},
		ioctl(stream, cmd, arg) {
			if (!stream.stream_ops.ioctl) throw new FS.ErrnoError(59);
			return stream.stream_ops.ioctl(stream, cmd, arg);
		},
		readFile(path, opts = {}) {
			opts.flags = opts.flags || 0;
			opts.encoding = opts.encoding || "binary";
			if (opts.encoding !== "utf8" && opts.encoding !== "binary") abort(`Invalid encoding type "${opts.encoding}"`);
			var stream = FS.open(path, opts.flags);
			var length = FS.stat(path).size;
			var buf = new Uint8Array(length);
			FS.read(stream, buf, 0, length, 0);
			if (opts.encoding === "utf8") buf = UTF8ArrayToString(buf);
			FS.close(stream);
			return buf;
		},
		writeFile(path, data, opts = {}) {
			opts.flags = opts.flags || 577;
			var stream = FS.open(path, opts.flags, opts.mode);
			data = FS_fileDataToTypedArray(data);
			FS.write(stream, data, 0, data.byteLength, void 0, opts.canOwn);
			FS.close(stream);
		},
		cwd: () => FS.currentPath,
		chdir(path) {
			var lookup = FS.lookupPath(path, { follow: true });
			if (lookup.node === null) throw new FS.ErrnoError(44);
			if (!FS.isDir(lookup.node.mode)) throw new FS.ErrnoError(54);
			var errCode = FS.nodePermissions(lookup.node, "x");
			if (errCode) throw new FS.ErrnoError(errCode);
			FS.currentPath = lookup.path;
		},
		createDefaultDirectories() {
			FS.mkdir("/tmp");
			FS.mkdir("/home");
			FS.mkdir("/home/web_user");
		},
		createDefaultDevices() {
			FS.mkdir("/dev");
			FS.registerDevice(FS.makedev(1, 3), {
				read: () => 0,
				write: (stream, buffer, offset, length, pos) => length,
				llseek: () => 0
			});
			FS.mkdev("/dev/null", FS.makedev(1, 3));
			TTY.register(FS.makedev(5, 0), TTY.default_tty_ops);
			TTY.register(FS.makedev(6, 0), TTY.default_tty1_ops);
			FS.mkdev("/dev/tty", FS.makedev(5, 0));
			FS.mkdev("/dev/tty1", FS.makedev(6, 0));
			var randomBuffer = new Uint8Array(1024), randomLeft = 0;
			var randomByte = () => {
				if (randomLeft === 0) {
					randomFill(randomBuffer);
					randomLeft = randomBuffer.byteLength;
				}
				return randomBuffer[--randomLeft];
			};
			FS.createDevice("/dev", "random", randomByte);
			FS.createDevice("/dev", "urandom", randomByte);
			FS.mkdir("/dev/shm");
			FS.mkdir("/dev/shm/tmp");
		},
		createSpecialDirectories() {
			FS.mkdir("/proc");
			var proc_self = FS.mkdir("/proc/self");
			FS.mkdir("/proc/self/fd");
			FS.mount({ mount() {
				var node = FS.createNode(proc_self, "fd", 16895, 73);
				node.stream_ops = { llseek: MEMFS.stream_ops.llseek };
				node.node_ops = {
					lookup(parent, name) {
						var fd = +name;
						var stream = FS.getStreamChecked(fd);
						var ret = {
							parent: null,
							mount: { mountpoint: "fake" },
							node_ops: { readlink: () => stream.path },
							id: fd + 1
						};
						ret.parent = ret;
						return ret;
					},
					readdir() {
						return Array.from(FS.streams.entries()).filter(([k, v]) => v).map(([k, v]) => k.toString());
					}
				};
				return node;
			} }, {}, "/proc/self/fd");
		},
		createStandardStreams(input, output, error) {
			if (input) FS.createDevice("/dev", "stdin", input);
			else FS.symlink("/dev/tty", "/dev/stdin");
			if (output) FS.createDevice("/dev", "stdout", null, output);
			else FS.symlink("/dev/tty", "/dev/stdout");
			if (error) FS.createDevice("/dev", "stderr", null, error);
			else FS.symlink("/dev/tty1", "/dev/stderr");
			FS.open("/dev/stdin", 0);
			FS.open("/dev/stdout", 1);
			FS.open("/dev/stderr", 1);
		},
		staticInit() {
			FS.nameTable = new Array(4096);
			FS.mount(MEMFS, {}, "/");
			FS.createDefaultDirectories();
			FS.createDefaultDevices();
			FS.createSpecialDirectories();
			FS.filesystems = { MEMFS };
		},
		init(input, output, error) {
			FS.initialized = true;
			input ??= Module["stdin"];
			output ??= Module["stdout"];
			error ??= Module["stderr"];
			FS.createStandardStreams(input, output, error);
		},
		quit() {
			FS.initialized = false;
			for (var stream of FS.streams) if (stream) FS.close(stream);
		},
		findObject(path, dontResolveLastLink) {
			var ret = FS.analyzePath(path, dontResolveLastLink);
			if (!ret.exists) return null;
			return ret.object;
		},
		analyzePath(path, dontResolveLastLink) {
			try {
				var lookup = FS.lookupPath(path, { follow: !dontResolveLastLink });
				path = lookup.path;
			} catch (e) {}
			var ret = {
				isRoot: false,
				exists: false,
				error: 0,
				name: null,
				path: null,
				object: null,
				parentExists: false,
				parentPath: null,
				parentObject: null
			};
			try {
				var lookup = FS.lookupPath(path, { parent: true });
				ret.parentExists = true;
				ret.parentPath = lookup.path;
				ret.parentObject = lookup.node;
				ret.name = PATH.basename(path);
				lookup = FS.lookupPath(path, { follow: !dontResolveLastLink });
				ret.exists = true;
				ret.path = lookup.path;
				ret.object = lookup.node;
				ret.name = lookup.node.name;
				ret.isRoot = lookup.path === "/";
			} catch (e) {
				ret.error = e.errno;
			}
			return ret;
		},
		createPath(parent, path, canRead, canWrite) {
			parent = typeof parent == "string" ? parent : FS.getPath(parent);
			var parts = path.split("/").reverse();
			while (parts.length) {
				var part = parts.pop();
				if (!part) continue;
				var current = PATH.join2(parent, part);
				try {
					FS.mkdir(current);
				} catch (e) {
					if (e.errno != 20) throw e;
				}
				parent = current;
			}
			return current;
		},
		createFile(parent, name, properties, canRead, canWrite) {
			var path = PATH.join2(typeof parent == "string" ? parent : FS.getPath(parent), name);
			var mode = FS_getMode(canRead, canWrite);
			return FS.create(path, mode);
		},
		createDataFile(parent, name, data, canRead, canWrite, canOwn) {
			var path = name;
			if (parent) {
				parent = typeof parent == "string" ? parent : FS.getPath(parent);
				path = name ? PATH.join2(parent, name) : parent;
			}
			var mode = FS_getMode(canRead, canWrite);
			var node = FS.create(path, mode);
			if (data) {
				data = FS_fileDataToTypedArray(data);
				FS.chmod(node, mode | 146);
				var stream = FS.open(node, 577);
				FS.write(stream, data, 0, data.length, 0, canOwn);
				FS.close(stream);
				FS.chmod(node, mode);
			}
		},
		createDevice(parent, name, input, output) {
			var path = PATH.join2(typeof parent == "string" ? parent : FS.getPath(parent), name);
			var mode = FS_getMode(!!input, !!output);
			FS.createDevice.major ??= 64;
			var dev = FS.makedev(FS.createDevice.major++, 0);
			FS.registerDevice(dev, {
				open(stream) {
					stream.seekable = false;
				},
				close(stream) {
					if (output?.buffer?.length) output(10);
				},
				read(stream, buffer, offset, length, pos) {
					var bytesRead = 0;
					for (var i = 0; i < length; i++) {
						var result;
						try {
							result = input();
						} catch (e) {
							throw new FS.ErrnoError(29);
						}
						if (result === void 0 && bytesRead === 0) throw new FS.ErrnoError(6);
						if (result === null || result === void 0) break;
						bytesRead++;
						buffer[offset + i] = result;
					}
					if (bytesRead) stream.node.atime = Date.now();
					return bytesRead;
				},
				write(stream, buffer, offset, length, pos) {
					for (var i = 0; i < length; i++) try {
						output(buffer[offset + i]);
					} catch (e) {
						throw new FS.ErrnoError(29);
					}
					if (length) stream.node.mtime = stream.node.ctime = Date.now();
					return i;
				}
			});
			return FS.mkdev(path, mode, dev);
		},
		forceLoadFile(obj) {
			if (obj.isDevice || obj.isFolder || obj.link || obj.contents) return true;
			if (globalThis.XMLHttpRequest) abort("Lazy loading should have been performed (contents set) in createLazyFile, but it was not. Lazy loading only works in web workers. Use --embed-file or --preload-file in emcc on the main thread.");
			else try {
				obj.contents = readBinary(obj.url);
			} catch (e) {
				throw new FS.ErrnoError(29);
			}
		},
		createLazyFile(parent, name, url, canRead, canWrite) {
			class LazyUint8Array {
				lengthKnown = false;
				chunks = [];
				get(idx) {
					if (idx > this.length - 1 || idx < 0) return;
					var chunkOffset = idx % this.chunkSize;
					var chunkNum = idx / this.chunkSize | 0;
					return this.getter(chunkNum)[chunkOffset];
				}
				setDataGetter(getter) {
					this.getter = getter;
				}
				cacheLength() {
					var xhr = new XMLHttpRequest();
					xhr.open("HEAD", url, false);
					xhr.send(null);
					if (!(xhr.status >= 200 && xhr.status < 300 || xhr.status === 304)) abort("Couldn't load " + url + ". Status: " + xhr.status);
					var datalength = Number(xhr.getResponseHeader("Content-length"));
					var header;
					var hasByteServing = (header = xhr.getResponseHeader("Accept-Ranges")) && header === "bytes";
					var usesGzip = (header = xhr.getResponseHeader("Content-Encoding")) && header === "gzip";
					var chunkSize = 1024 * 1024;
					if (!hasByteServing) chunkSize = datalength;
					var doXHR = (from, to) => {
						if (from > to) abort("invalid range (" + from + ", " + to + ") or no bytes requested!");
						if (to > datalength - 1) abort("only " + datalength + " bytes available! programmer error!");
						var xhr = new XMLHttpRequest();
						xhr.open("GET", url, false);
						if (datalength !== chunkSize) xhr.setRequestHeader("Range", "bytes=" + from + "-" + to);
						xhr.responseType = "arraybuffer";
						if (xhr.overrideMimeType) xhr.overrideMimeType("text/plain; charset=x-user-defined");
						xhr.send(null);
						if (!(xhr.status >= 200 && xhr.status < 300 || xhr.status === 304)) abort("Couldn't load " + url + ". Status: " + xhr.status);
						if (xhr.response !== void 0) return new Uint8Array(xhr.response || []);
						return intArrayFromString(xhr.responseText || "", true);
					};
					var lazyArray = this;
					lazyArray.setDataGetter((chunkNum) => {
						var start = chunkNum * chunkSize;
						var end = (chunkNum + 1) * chunkSize - 1;
						end = Math.min(end, datalength - 1);
						if (typeof lazyArray.chunks[chunkNum] == "undefined") lazyArray.chunks[chunkNum] = doXHR(start, end);
						if (typeof lazyArray.chunks[chunkNum] == "undefined") abort("doXHR failed!");
						return lazyArray.chunks[chunkNum];
					});
					if (usesGzip || !datalength) {
						chunkSize = datalength = 1;
						datalength = this.getter(0).length;
						chunkSize = datalength;
						out("LazyFiles on gzip forces download of the whole file when length is accessed");
					}
					this._length = datalength;
					this._chunkSize = chunkSize;
					this.lengthKnown = true;
				}
				get length() {
					if (!this.lengthKnown) this.cacheLength();
					return this._length;
				}
				get chunkSize() {
					if (!this.lengthKnown) this.cacheLength();
					return this._chunkSize;
				}
			}
			if (globalThis.XMLHttpRequest) {
				if (!ENVIRONMENT_IS_WORKER) abort("Cannot do synchronous binary XHRs outside webworkers in modern browsers. Use --embed-file or --preload-file in emcc");
				var properties = {
					isDevice: false,
					contents: new LazyUint8Array()
				};
			} else var properties = {
				isDevice: false,
				url
			};
			var node = FS.createFile(parent, name, properties, canRead, canWrite);
			if (properties.contents) node.contents = properties.contents;
			else if (properties.url) {
				node.contents = null;
				node.url = properties.url;
			}
			Object.defineProperties(node, { usedBytes: { get: function() {
				return this.contents.length;
			} } });
			var stream_ops = {};
			for (const [key, fn] of Object.entries(node.stream_ops)) stream_ops[key] = (...args) => {
				FS.forceLoadFile(node);
				return fn(...args);
			};
			function writeChunks(stream, buffer, offset, length, position) {
				var contents = stream.node.contents;
				if (position >= contents.length) return 0;
				var size = Math.min(contents.length - position, length);
				if (contents.slice) for (var i = 0; i < size; i++) buffer[offset + i] = contents[position + i];
				else for (var i = 0; i < size; i++) buffer[offset + i] = contents.get(position + i);
				return size;
			}
			stream_ops.read = (stream, buffer, offset, length, position) => {
				FS.forceLoadFile(node);
				return writeChunks(stream, buffer, offset, length, position);
			};
			stream_ops.mmap = (stream, length, position, prot, flags) => {
				FS.forceLoadFile(node);
				var ptr = mmapAlloc(length);
				if (!ptr) throw new FS.ErrnoError(48);
				writeChunks(stream, HEAP8, ptr, length, position);
				return {
					ptr,
					allocated: true
				};
			};
			node.stream_ops = stream_ops;
			return node;
		}
	};
	var UTF8ToString = (ptr, maxBytesToRead, ignoreNul) => ptr ? UTF8ArrayToString(HEAPU8, ptr, maxBytesToRead, ignoreNul) : "";
	var SYSCALLS = {
		calculateAt(dirfd, path, allowEmpty) {
			if (PATH.isAbs(path)) return path;
			var dir;
			if (dirfd === -100) dir = FS.cwd();
			else dir = SYSCALLS.getStreamFromFD(dirfd).path;
			if (path.length == 0) {
				if (!allowEmpty) throw new FS.ErrnoError(44);
				return dir;
			}
			return dir + "/" + path;
		},
		writeStat(buf, stat) {
			HEAPU32[buf >> 2] = stat.dev;
			HEAPU32[buf + 4 >> 2] = stat.mode;
			HEAPU32[buf + 8 >> 2] = stat.nlink;
			HEAPU32[buf + 12 >> 2] = stat.uid;
			HEAPU32[buf + 16 >> 2] = stat.gid;
			HEAPU32[buf + 20 >> 2] = stat.rdev;
			HEAP64[buf + 24 >> 3] = BigInt(stat.size);
			HEAP32[buf + 32 >> 2] = 4096;
			HEAP32[buf + 36 >> 2] = stat.blocks;
			var atime = stat.atime.getTime();
			var mtime = stat.mtime.getTime();
			var ctime = stat.ctime.getTime();
			HEAP64[buf + 40 >> 3] = BigInt(Math.floor(atime / 1e3));
			HEAPU32[buf + 48 >> 2] = atime % 1e3 * 1e3 * 1e3;
			HEAP64[buf + 56 >> 3] = BigInt(Math.floor(mtime / 1e3));
			HEAPU32[buf + 64 >> 2] = mtime % 1e3 * 1e3 * 1e3;
			HEAP64[buf + 72 >> 3] = BigInt(Math.floor(ctime / 1e3));
			HEAPU32[buf + 80 >> 2] = ctime % 1e3 * 1e3 * 1e3;
			HEAP64[buf + 88 >> 3] = BigInt(stat.ino);
			return 0;
		},
		writeStatFs(buf, stats) {
			HEAPU32[buf + 4 >> 2] = stats.bsize;
			HEAPU32[buf + 60 >> 2] = stats.bsize;
			HEAP64[buf + 8 >> 3] = BigInt(stats.blocks);
			HEAP64[buf + 16 >> 3] = BigInt(stats.bfree);
			HEAP64[buf + 24 >> 3] = BigInt(stats.bavail);
			HEAP64[buf + 32 >> 3] = BigInt(stats.files);
			HEAP64[buf + 40 >> 3] = BigInt(stats.ffree);
			HEAPU32[buf + 48 >> 2] = stats.fsid;
			HEAPU32[buf + 64 >> 2] = stats.flags;
			HEAPU32[buf + 56 >> 2] = stats.namelen;
		},
		doMsync(addr, stream, len, flags, offset) {
			if (!FS.isFile(stream.node.mode)) throw new FS.ErrnoError(43);
			if (flags & 2) return 0;
			var buffer = HEAPU8.slice(addr, addr + len);
			FS.msync(stream, buffer, offset, len, flags);
		},
		getStreamFromFD(fd) {
			return FS.getStreamChecked(fd);
		},
		varargs: void 0,
		getStr(ptr) {
			return UTF8ToString(ptr);
		}
	};
	function ___syscall_fcntl64(fd, cmd, varargs) {
		SYSCALLS.varargs = varargs;
		try {
			var stream = SYSCALLS.getStreamFromFD(fd);
			switch (cmd) {
				case 0:
					var arg = syscallGetVarargI();
					if (arg < 0) return -28;
					while (FS.streams[arg]) arg++;
					return FS.dupStream(stream, arg).fd;
				case 1:
				case 2: return 0;
				case 3: return stream.flags;
				case 4:
					var arg = syscallGetVarargI();
					stream.flags |= arg;
					return 0;
				case 12:
					var arg = syscallGetVarargP();
					var offset = 0;
					HEAP16[arg + offset >> 1] = 2;
					return 0;
				case 13:
				case 14: return 0;
			}
			return -28;
		} catch (e) {
			if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
			return -e.errno;
		}
	}
	function ___syscall_ioctl(fd, op, varargs) {
		SYSCALLS.varargs = varargs;
		try {
			var stream = SYSCALLS.getStreamFromFD(fd);
			switch (op) {
				case 21509:
					if (!stream.tty) return -59;
					return 0;
				case 21505:
					if (!stream.tty) return -59;
					if (stream.tty.ops.ioctl_tcgets) {
						var termios = stream.tty.ops.ioctl_tcgets(stream);
						var argp = syscallGetVarargP();
						HEAP32[argp >> 2] = termios.c_iflag || 0;
						HEAP32[argp + 4 >> 2] = termios.c_oflag || 0;
						HEAP32[argp + 8 >> 2] = termios.c_cflag || 0;
						HEAP32[argp + 12 >> 2] = termios.c_lflag || 0;
						for (var i = 0; i < 32; i++) HEAP8[argp + i + 17] = termios.c_cc[i] || 0;
						return 0;
					}
					return 0;
				case 21510:
				case 21511:
				case 21512:
					if (!stream.tty) return -59;
					return 0;
				case 21506:
				case 21507:
				case 21508:
					if (!stream.tty) return -59;
					if (stream.tty.ops.ioctl_tcsets) {
						var argp = syscallGetVarargP();
						var c_iflag = HEAP32[argp >> 2];
						var c_oflag = HEAP32[argp + 4 >> 2];
						var c_cflag = HEAP32[argp + 8 >> 2];
						var c_lflag = HEAP32[argp + 12 >> 2];
						var c_cc = [];
						for (var i = 0; i < 32; i++) c_cc.push(HEAP8[argp + i + 17]);
						return stream.tty.ops.ioctl_tcsets(stream.tty, op, {
							c_iflag,
							c_oflag,
							c_cflag,
							c_lflag,
							c_cc
						});
					}
					return 0;
				case 21519:
					if (!stream.tty) return -59;
					var argp = syscallGetVarargP();
					HEAP32[argp >> 2] = 0;
					return 0;
				case 21520:
					if (!stream.tty) return -59;
					return -28;
				case 21537:
				case 21531:
					var argp = syscallGetVarargP();
					return FS.ioctl(stream, op, argp);
				case 21523:
					if (!stream.tty) return -59;
					if (stream.tty.ops.ioctl_tiocgwinsz) {
						var winsize = stream.tty.ops.ioctl_tiocgwinsz(stream.tty);
						var argp = syscallGetVarargP();
						HEAP16[argp >> 1] = winsize[0];
						HEAP16[argp + 2 >> 1] = winsize[1];
					}
					return 0;
				case 21524:
					if (!stream.tty) return -59;
					return 0;
				case 21515:
					if (!stream.tty) return -59;
					return 0;
				default: return -28;
			}
		} catch (e) {
			if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
			return -e.errno;
		}
	}
	function ___syscall_openat(dirfd, path, flags, varargs) {
		SYSCALLS.varargs = varargs;
		try {
			path = SYSCALLS.getStr(path);
			path = SYSCALLS.calculateAt(dirfd, path);
			var mode = varargs ? syscallGetVarargI() : 0;
			return FS.open(path, flags, mode).fd;
		} catch (e) {
			if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
			return -e.errno;
		}
	}
	var __abort_js = () => abort("");
	var _emscripten_date_now = () => Date.now();
	var getHeapMax = () => 2147483648;
	var alignMemory = (size, alignment) => Math.ceil(size / alignment) * alignment;
	var growMemory = (size) => {
		var pages = (size - wasmMemory.buffer.byteLength + 65535) / 65536 | 0;
		try {
			wasmMemory.grow(pages);
			updateMemoryViews();
			return 1;
		} catch (e) {}
	};
	var _emscripten_resize_heap = (requestedSize) => {
		var oldSize = HEAPU8.length;
		requestedSize >>>= 0;
		var maxHeapSize = getHeapMax();
		if (requestedSize > maxHeapSize) return false;
		for (var cutDown = 1; cutDown <= 4; cutDown *= 2) {
			var overGrownHeapSize = oldSize * (1 + .2 / cutDown);
			overGrownHeapSize = Math.min(overGrownHeapSize, requestedSize + 100663296);
			if (growMemory(Math.min(maxHeapSize, alignMemory(Math.max(requestedSize, overGrownHeapSize), 65536)))) return true;
		}
		return false;
	};
	function _fd_close(fd) {
		try {
			var stream = SYSCALLS.getStreamFromFD(fd);
			FS.close(stream);
			return 0;
		} catch (e) {
			if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
			return e.errno;
		}
	}
	var doReadv = (stream, iov, iovcnt, offset) => {
		var ret = 0;
		for (var i = 0; i < iovcnt; i++) {
			var ptr = HEAPU32[iov >> 2];
			var len = HEAPU32[iov + 4 >> 2];
			iov += 8;
			var curr = FS.read(stream, HEAP8, ptr, len, offset);
			if (curr < 0) return -1;
			ret += curr;
			if (curr < len) break;
			if (typeof offset != "undefined") offset += curr;
		}
		return ret;
	};
	function _fd_read(fd, iov, iovcnt, pnum) {
		try {
			var num = doReadv(SYSCALLS.getStreamFromFD(fd), iov, iovcnt);
			HEAPU32[pnum >> 2] = num;
			return 0;
		} catch (e) {
			if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
			return e.errno;
		}
	}
	var INT53_MAX = 9007199254740992;
	var INT53_MIN = -9007199254740992;
	var bigintToI53Checked = (num) => num < INT53_MIN || num > INT53_MAX ? NaN : Number(num);
	function _fd_seek(fd, offset, whence, newOffset) {
		offset = bigintToI53Checked(offset);
		try {
			if (isNaN(offset)) return 61;
			var stream = SYSCALLS.getStreamFromFD(fd);
			FS.llseek(stream, offset, whence);
			HEAP64[newOffset >> 3] = BigInt(stream.position);
			if (stream.getdents && offset === 0 && whence === 0) stream.getdents = null;
			return 0;
		} catch (e) {
			if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
			return e.errno;
		}
	}
	var doWritev = (stream, iov, iovcnt, offset) => {
		var ret = 0;
		for (var i = 0; i < iovcnt; i++) {
			var ptr = HEAPU32[iov >> 2];
			var len = HEAPU32[iov + 4 >> 2];
			iov += 8;
			var curr = FS.write(stream, HEAP8, ptr, len, offset);
			if (curr < 0) return -1;
			ret += curr;
			if (curr < len) break;
			if (typeof offset != "undefined") offset += curr;
		}
		return ret;
	};
	function _fd_write(fd, iov, iovcnt, pnum) {
		try {
			var num = doWritev(SYSCALLS.getStreamFromFD(fd), iov, iovcnt);
			HEAPU32[pnum >> 2] = num;
			return 0;
		} catch (e) {
			if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
			return e.errno;
		}
	}
	var getCFunc = (ident) => {
		return Module["_" + ident];
	};
	var writeArrayToMemory = (array, buffer) => {
		HEAP8.set(array, buffer);
	};
	var stringToUTF8 = (str, outPtr, maxBytesToWrite) => stringToUTF8Array(str, HEAPU8, outPtr, maxBytesToWrite);
	var stackAlloc = (sz) => __emscripten_stack_alloc(sz);
	var stringToUTF8OnStack = (str) => {
		var size = lengthBytesUTF8(str) + 1;
		var ret = stackAlloc(size);
		stringToUTF8(str, ret, size);
		return ret;
	};
	var ccall = (ident, returnType, argTypes, args, opts) => {
		var toC = {
			string: (str) => {
				var ret = 0;
				if (str !== null && str !== void 0 && str !== 0) ret = stringToUTF8OnStack(str);
				return ret;
			},
			array: (arr) => {
				var ret = stackAlloc(arr.length);
				writeArrayToMemory(arr, ret);
				return ret;
			}
		};
		function convertReturnValue(ret) {
			if (returnType === "string") return UTF8ToString(ret);
			if (returnType === "boolean") return Boolean(ret);
			return ret;
		}
		var func = getCFunc(ident);
		var cArgs = [];
		var stack = 0;
		if (args) for (var i = 0; i < args.length; i++) {
			var converter = toC[argTypes[i]];
			if (converter) {
				if (stack === 0) stack = stackSave();
				cArgs[i] = converter(args[i]);
			} else cArgs[i] = args[i];
		}
		var ret = func(...cArgs);
		function onDone(ret) {
			if (stack !== 0) stackRestore(stack);
			return convertReturnValue(ret);
		}
		ret = onDone(ret);
		return ret;
	};
	var cwrap = (ident, returnType, argTypes, opts) => {
		var numericArgs = !argTypes || argTypes.every((type) => type === "number" || type === "boolean");
		if (returnType !== "string" && numericArgs && !opts) return getCFunc(ident);
		return (...args) => ccall(ident, returnType, argTypes, args, opts);
	};
	FS.createPreloadedFile = FS_createPreloadedFile;
	FS.preloadFile = FS_preloadFile;
	FS.staticInit();
	if (Module["noExitRuntime"]) Module["noExitRuntime"];
	if (Module["preloadPlugins"]) preloadPlugins = Module["preloadPlugins"];
	if (Module["print"]) out = Module["print"];
	if (Module["printErr"]) err = Module["printErr"];
	if (Module["wasmBinary"]) wasmBinary = Module["wasmBinary"];
	if (Module["arguments"]) Module["arguments"];
	if (Module["thisProgram"]) Module["thisProgram"];
	if (Module["preInit"]) {
		if (typeof Module["preInit"] == "function") Module["preInit"] = [Module["preInit"]];
		while (Module["preInit"].length > 0) Module["preInit"].shift()();
	}
	Module["ccall"] = ccall;
	Module["cwrap"] = cwrap;
	Module["setValue"] = setValue;
	Module["getValue"] = getValue;
	var __emscripten_stack_restore, __emscripten_stack_alloc, _emscripten_stack_get_current, wasmMemory;
	function assignWasmExports(wasmExports) {
		Module["_sa_context_create"] = wasmExports["n"];
		Module["_sa_context_release"] = wasmExports["o"];
		Module["_sa_scene_create"] = wasmExports["p"];
		Module["_sa_scene_commit"] = wasmExports["q"];
		Module["_sa_scene_release"] = wasmExports["r"];
		Module["_sa_static_mesh_create"] = wasmExports["s"];
		Module["_free"] = wasmExports["t"];
		Module["_sa_static_mesh_add"] = wasmExports["u"];
		Module["_sa_static_mesh_remove"] = wasmExports["v"];
		Module["_sa_static_mesh_release"] = wasmExports["w"];
		Module["_sa_instanced_mesh_create"] = wasmExports["x"];
		Module["_sa_instanced_mesh_update_transform"] = wasmExports["y"];
		Module["_sa_instanced_mesh_remove"] = wasmExports["z"];
		Module["_sa_instanced_mesh_release"] = wasmExports["A"];
		Module["_sa_hrtf_create"] = wasmExports["B"];
		Module["_sa_hrtf_create_sofa"] = wasmExports["C"];
		Module["_sa_hrtf_release"] = wasmExports["D"];
		Module["_sa_binaural_effect_create"] = wasmExports["E"];
		Module["_sa_binaural_effect_release"] = wasmExports["F"];
		Module["_sa_binaural_effect_apply"] = wasmExports["G"];
		Module["_sa_ambisonics_binaural_effect_create"] = wasmExports["H"];
		Module["_sa_ambisonics_binaural_effect_release"] = wasmExports["I"];
		Module["_sa_ambisonics_binaural_effect_reset"] = wasmExports["J"];
		Module["_sa_ambisonics_binaural_effect_apply"] = wasmExports["K"];
		Module["_sa_ambisonics_decode_effect_create"] = wasmExports["L"];
		Module["_sa_ambisonics_decode_effect_release"] = wasmExports["M"];
		Module["_sa_ambisonics_decode_effect_reset"] = wasmExports["N"];
		Module["_sa_ambisonics_decode_effect_apply"] = wasmExports["O"];
		Module["_sa_direct_effect_create"] = wasmExports["P"];
		Module["_sa_direct_effect_release"] = wasmExports["Q"];
		Module["_sa_direct_effect_apply"] = wasmExports["R"];
		Module["_sa_reflection_effect_create"] = wasmExports["S"];
		Module["_sa_reflection_effect_release"] = wasmExports["T"];
		Module["_sa_reflection_effect_reset"] = wasmExports["U"];
		Module["_sa_reflection_effect_apply"] = wasmExports["V"];
		Module["_sa_reflection_effect_get_tail"] = wasmExports["W"];
		Module["_sa_convolution_reflection_effect_create"] = wasmExports["X"];
		Module["_sa_source_apply_convolution_reflection"] = wasmExports["Y"];
		Module["_sa_simulator_create"] = wasmExports["Z"];
		Module["_sa_simulator_commit"] = wasmExports["_"];
		Module["_sa_simulator_release"] = wasmExports["$"];
		Module["_sa_simulator_run_direct"] = wasmExports["aa"];
		Module["_sa_simulator_run_reflections"] = wasmExports["ba"];
		Module["_sa_simulator_set_listener"] = wasmExports["ca"];
		Module["_sa_source_create"] = wasmExports["da"];
		Module["_sa_source_release"] = wasmExports["ea"];
		Module["_sa_source_set_inputs"] = wasmExports["fa"];
		Module["_malloc"] = wasmExports["ga"];
		Module["_sa_source_set_reflection_inputs"] = wasmExports["ha"];
		Module["_sa_source_get_direct_outputs"] = wasmExports["ia"];
		Module["_sa_source_get_reflection_outputs"] = wasmExports["ja"];
		Module["_sa_buffer_alloc"] = wasmExports["ka"];
		Module["_sa_buffer_free"] = wasmExports["la"];
		Module["_sa_buffer_deinterleave"] = wasmExports["ma"];
		Module["_sa_buffer_interleave"] = wasmExports["na"];
		Module["_sa_source_get_reflection_ir_size"] = wasmExports["oa"];
		Module["_sa_source_get_reflection_ir"] = wasmExports["pa"];
		__emscripten_stack_restore = wasmExports["qa"];
		__emscripten_stack_alloc = wasmExports["ra"];
		_emscripten_stack_get_current = wasmExports["sa"];
		wasmMemory = wasmExports["l"];
		wasmExports["__indirect_function_table"];
	}
	var wasmImports = {
		a: ___cxa_throw,
		d: ___syscall_fcntl64,
		h: ___syscall_ioctl,
		i: ___syscall_openat,
		e: __abort_js,
		k: _emscripten_date_now,
		j: _emscripten_resize_heap,
		b: _fd_close,
		g: _fd_read,
		f: _fd_seek,
		c: _fd_write
	};
	function run() {
		if (runDependencies > 0) {
			dependenciesFulfilled = run;
			return;
		}
		preRun();
		if (runDependencies > 0) {
			dependenciesFulfilled = run;
			return;
		}
		function doRun() {
			Module["calledRun"] = true;
			if (ABORT) return;
			initRuntime();
			readyPromiseResolve?.(Module);
			Module["onRuntimeInitialized"]?.();
			postRun();
		}
		if (Module["setStatus"]) {
			Module["setStatus"]("Running...");
			setTimeout(() => {
				setTimeout(() => Module["setStatus"](""), 1);
				doRun();
			}, 1);
		} else doRun();
	}
	var wasmExports = await createWasm();
	run();
	if (runtimeInitialized) moduleRtn = Module;
	else moduleRtn = new Promise((resolve, reject) => {
		readyPromiseResolve = resolve;
		readyPromiseReject = reject;
	});
	return moduleRtn;
}
//#endregion
//#region src/worker/runtime.ts
const defaultModuleFactory = Module;
const runtimeCache = /* @__PURE__ */ new WeakMap();
const wasmUrl = new URL("./bindings/phonon_bindings.wasm", import.meta.url);
const workletUrl = new URL("./steam-audio-processor.js", import.meta.url);
const detectCapabilities = () => {
	const isolated = globalThis.crossOriginIsolated === true;
	return {
		audioWorklet: typeof AudioWorkletNode !== "undefined",
		crossOriginIsolated: isolated,
		gpuSimulation: false,
		runtimeBaking: false,
		sharedArrayBuffer: isolated && typeof SharedArrayBuffer !== "undefined",
		webAssembly: typeof WebAssembly !== "undefined"
	};
};
const prepareRuntime = async (audioContext, moduleFactory) => {
	if (typeof WebAssembly === "undefined") throw new Error("three-steam-audio requires WebAssembly");
	if (!("audioWorklet" in audioContext) || typeof audioContext.audioWorklet.addModule !== "function") throw new Error("three-steam-audio requires AudioWorklet support");
	const wasmResponse = await fetch(wasmUrl);
	if (!wasmResponse.ok) throw new Error(`Unable to load Steam Audio WASM (${wasmResponse.status} ${wasmResponse.statusText})`);
	const wasmBinary = await wasmResponse.arrayBuffer();
	const [module] = await Promise.all([moduleFactory({
		locateFile: (path) => path.endsWith(".wasm") ? wasmUrl.href : path,
		wasmBinary
	}), audioContext.audioWorklet.addModule(workletUrl)]);
	return {
		module,
		wasmBinary
	};
};
const getPreparedRuntimePromise = (audioContext, moduleFactory = defaultModuleFactory) => {
	let byFactory = runtimeCache.get(audioContext);
	if (!byFactory) {
		byFactory = /* @__PURE__ */ new Map();
		runtimeCache.set(audioContext, byFactory);
	}
	let promise = byFactory.get(moduleFactory);
	if (!promise) {
		promise = prepareRuntime(audioContext, moduleFactory);
		byFactory.set(moduleFactory, promise);
	}
	return promise;
};
const prepareWorldRuntime = async (options) => getPreparedRuntimePromise(options.audioContext, options.moduleFactory ?? defaultModuleFactory);
//#endregion
//#region src/three/native.ts
const createHandle = (module, operation, create) => {
	const out = module._malloc(4);
	try {
		module.HEAPU32[out >>> 2] = 0;
		assertNativeStatus(operation, create(out));
		const handle = module.HEAPU32[out >>> 2];
		if (handle === 0) throw new Error(`${operation} returned a null handle`);
		return handle;
	} finally {
		module._free(out);
	}
};
const withFloatArray = (module, values, callback) => {
	const pointer = module._malloc(values.length * 4);
	try {
		module.HEAPF32.set(values, pointer >>> 2);
		return callback(pointer);
	} finally {
		module._free(pointer);
	}
};
const withIntArray = (module, values, callback) => {
	const pointer = module._malloc(values.length * 4);
	try {
		module.HEAP32.set(values, pointer >>> 2);
		return callback(pointer);
	} finally {
		module._free(pointer);
	}
};
const withOptionalFloatArray = (module, values, callback) => values ? withFloatArray(module, values, callback) : callback(0);
//#endregion
//#region src/three/world.ts
const DIRECT_DISTANCE = 1;
const DIRECT_AIR = 2;
const DIRECT_DIRECTIVITY = 4;
const DIRECT_OCCLUSION = 8;
const DIRECT_TRANSMISSION = 16;
const SIMULATION_DIRECT = 1;
const SIMULATION_REFLECTIONS = 2;
const DEFAULT_FRAME_SIZE = 1024;
const DEFAULT_MAX_SOURCES = 32;
const DEFAULT_SIMULATION_RATE = 60;
const DEFAULT_REFLECTION_RATE = 10;
const DEFAULT_MAX_OCCLUSION_SAMPLES = 128;
const QUALITY_MAX_OCCLUSION_SAMPLES = {
	high: 256,
	low: 32,
	medium: DEFAULT_MAX_OCCLUSION_SAMPLES
};
const ahead = new Vector3();
const up = new Vector3();
const orientationScratch = new Quaternion();
const clampUnit = (name, value) => {
	if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError(`${name} must be a finite number in [0, 1]`);
	return value;
};
const positive = (name, value) => {
	if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be a positive finite number`);
	return value;
};
const integer = (name, value, minimum = 1) => {
	if (!Number.isInteger(value) || value < minimum) throw new RangeError(`${name} must be an integer >= ${minimum}`);
	return value;
};
const normalizeQuaternion = (value) => {
	orientationScratch.set(value.x, value.y, value.z, value.w);
	if (orientationScratch.lengthSq() < 1e-12) throw new RangeError("orientation must not be a zero quaternion");
	return orientationScratch.normalize();
};
const directionsFromQuaternion = (value) => {
	const quaternion = normalizeQuaternion(value);
	ahead.set(0, 0, -1).applyQuaternion(quaternion);
	up.set(0, 1, 0).applyQuaternion(quaternion);
	return [ahead, up];
};
const normalizeReflectionSettings = (settings) => {
	const input = settings === true ? {} : settings === false || settings === void 0 ? void 0 : settings;
	const reverbScale = input?.reverbScale ?? [
		1,
		1,
		1
	];
	reverbScale.forEach((value, band) => {
		if (!Number.isFinite(value) || value < 0) throw new RangeError(`reflections.reverbScale[${band}] must be a finite number >= 0`);
	});
	return {
		enabled: input?.enabled ?? (settings === true || input !== void 0),
		reverbScale,
		wet: clampUnit("reflections.wet", input?.wet ?? 1)
	};
};
const normalizeSettings = (settings = {}, maximumOcclusionSamples = DEFAULT_MAX_OCCLUSION_SAMPLES) => {
	const simulation = settings.directSimulation === false ? {} : settings.directSimulation === true || settings.directSimulation === void 0 ? {} : settings.directSimulation;
	const directivity = settings.directivity ?? {};
	const normalized = {
		directivity: {
			dipolePower: directivity.dipolePower ?? 0,
			dipoleWeight: clampUnit("directivity.dipoleWeight", directivity.dipoleWeight ?? 0)
		},
		directSimulation: settings.directSimulation === false ? {
			airAbsorption: false,
			occlusion: false,
			transmission: false
		} : {
			airAbsorption: simulation.airAbsorption ?? false,
			airAbsorptionModel: simulation.airAbsorptionModel,
			occlusion: simulation.occlusion ?? false,
			occlusionRadius: simulation.occlusionRadius ?? 1,
			occlusionSamples: simulation.occlusionSamples ?? 16,
			transmission: simulation.transmission ?? false
		},
		distanceAttenuation: settings.distanceAttenuation === void 0 ? { model: "default" } : settings.distanceAttenuation,
		hrtf: settings.hrtf ?? true,
		reflections: normalizeReflectionSettings(settings.reflections),
		spatialBlend: clampUnit("spatialBlend", settings.spatialBlend ?? 1)
	};
	if (!Number.isFinite(normalized.directivity.dipolePower) || normalized.directivity.dipolePower < 0) throw new RangeError("directivity.dipolePower must be a finite number >= 0");
	const transmissionEnabled = normalized.directSimulation.transmission !== false && normalized.directSimulation.transmission !== void 0;
	const occlusionEnabled = normalized.directSimulation.occlusion !== false && normalized.directSimulation.occlusion !== void 0;
	if (transmissionEnabled && !occlusionEnabled) throw new Error("Transmission requires occlusion to be enabled");
	if (normalized.directSimulation.occlusion === "volumetric") {
		positive("directSimulation.occlusionRadius", normalized.directSimulation.occlusionRadius);
		if (integer("directSimulation.occlusionSamples", normalized.directSimulation.occlusionSamples) > maximumOcclusionSamples) throw new RangeError(`directSimulation.occlusionSamples cannot exceed World maxOcclusionSamples (${maximumOcclusionSamples})`);
	}
	return normalized;
};
const sampleCurve = (callback, maximum, count, name, minimum = 0) => {
	positive(`${name}.maxDistance`, maximum);
	integer(`${name}.samples`, count, 2);
	if (maximum <= minimum) throw new RangeError(`${name}.maxDistance must be greater than minDistance`);
	const values = new Float32Array(count);
	for (let index = 0; index < count; index++) values[index] = clampUnit(`${name}.curve result`, callback(minimum + (maximum - minimum) * index / (count - 1)));
	return values;
};
const distanceModel = (settings) => {
	if (settings === false) return {
		curve: void 0,
		maximum: 0,
		minimum: 1,
		model: 0
	};
	if (settings.model === "inverse") return {
		curve: void 0,
		maximum: 0,
		minimum: positive("distanceAttenuation.minDistance", settings.minDistance ?? 1),
		model: 1
	};
	if (settings.model === "curve") {
		positive("distanceAttenuation.minDistance", settings.minDistance);
		return {
			curve: sampleCurve(settings.curve, settings.maxDistance, settings.samples ?? 256, "distanceAttenuation", settings.minDistance),
			maximum: settings.maxDistance,
			minimum: settings.minDistance,
			model: 2
		};
	}
	return {
		curve: void 0,
		maximum: 0,
		minimum: 1,
		model: 0
	};
};
const airModel = (settings) => {
	if (!settings || !settings.model || settings.model === "default") return {
		coefficients: void 0,
		curves: void 0,
		maximum: 0,
		model: 0,
		samples: 0
	};
	if (settings.model === "exponential") {
		settings.coefficients.forEach((value, band) => clampUnit(`airAbsorption.coefficients[${band}]`, value));
		return {
			coefficients: new Float32Array(settings.coefficients),
			curves: void 0,
			maximum: 0,
			model: 1,
			samples: 0
		};
	}
	if (!("curves" in settings)) throw new Error(`Unsupported air absorption model: ${String(settings.model)}`);
	const count = settings.samples ?? 256;
	const curves = new Float32Array(count * 3);
	settings.curves.forEach((curve, band) => {
		curves.set(sampleCurve(curve, settings.maxDistance, count, `airAbsorption.curves[${band}]`), band * count);
	});
	return {
		coefficients: void 0,
		curves,
		maximum: settings.maxDistance,
		model: 2,
		samples: count
	};
};
const directEffectFlags = (settings, overrides) => {
	const direct = settings.directSimulation;
	let flags = 0;
	if (settings.distanceAttenuation !== false || overrides?.distanceAttenuation !== void 0) flags |= DIRECT_DISTANCE;
	if (direct.airAbsorption === true || overrides?.airAbsorption !== void 0) flags |= DIRECT_AIR;
	if (settings.directivity.dipoleWeight > 0 || overrides?.directivity !== void 0) flags |= DIRECT_DIRECTIVITY;
	if (direct.occlusion !== false || overrides?.occlusion !== void 0) flags |= DIRECT_OCCLUSION;
	if (direct.transmission !== false || overrides?.transmission !== void 0) flags |= DIRECT_TRANSMISSION;
	return flags;
};
var AcousticSceneImpl = class {
	#dirty = false;
	#handles = /* @__PURE__ */ new Set();
	#nextReflectionMeshId = 1;
	#pendingReleases = [];
	#world;
	constructor(world) {
		this.#world = world;
	}
	addDynamicMesh(input) {
		this.#world.assertActive("AcousticScene.addDynamicMesh");
		const transform = splitDynamicTransform(input.matrixWorld);
		const reflectionMeshId = this.#nextReflectionMeshId++;
		let currentRigidMatrix = transform.rigidMatrix.clone();
		const subScene = createHandle(this.#world.module, "iplSceneCreate", (out) => this.#world.module._sa_scene_create(this.#world.context, out));
		let staticMesh = 0;
		let instance = 0;
		try {
			const created = this.#createStaticMesh(subScene, input, transform.bakedMatrix);
			staticMesh = created.native;
			this.#world.module._sa_static_mesh_add(staticMesh, subScene);
			this.#world.module._sa_scene_commit(subScene);
			instance = createHandle(this.#world.module, "iplInstancedMeshCreate", (out) => withFloatArray(this.#world.module, matrixToRowMajor(transform.rigidMatrix), (matrixPointer) => this.#world.module._sa_instanced_mesh_create(this.#world.sceneHandle, subScene, matrixPointer, out)));
			this.#world.reflectionWorker?.addDynamicMesh(reflectionMeshId, created.converted, Array.isArray(input.material) ? input.material.length : 1, transform.rigidMatrix);
		} catch (error) {
			if (staticMesh !== 0) this.#world.module._sa_static_mesh_release(staticMesh);
			this.#world.module._sa_scene_release(subScene);
			throw error;
		}
		this.#dirty = true;
		let disposed = false;
		const handle = {
			dispose: () => {
				if (disposed) return;
				disposed = true;
				this.#world.module._sa_instanced_mesh_remove(instance, this.#world.sceneHandle);
				this.#world.reflectionWorker?.removeMesh(reflectionMeshId);
				this.#pendingReleases.push(() => {
					this.#world.module._sa_instanced_mesh_release(instance);
					this.#world.module._sa_static_mesh_release(staticMesh);
					this.#world.module._sa_scene_release(subScene);
				});
				this.#handles.delete(handle);
				this.#dirty = true;
			},
			setTransform: (matrixWorld) => {
				if (disposed) throw new SteamAudioError("DynamicAcousticMeshHandle.setTransform", "mesh has been disposed");
				const rigid = rigidMatrixForScale(matrixWorld, transform.scale);
				if (rigid.equals(currentRigidMatrix)) return;
				currentRigidMatrix = rigid.clone();
				withFloatArray(this.#world.module, matrixToRowMajor(rigid), (pointer) => this.#world.module._sa_instanced_mesh_update_transform(instance, this.#world.sceneHandle, pointer));
				this.#world.reflectionWorker?.updateDynamicMesh(reflectionMeshId, rigid);
				this.#dirty = true;
			}
		};
		this.#handles.add(handle);
		return handle;
	}
	addStaticMesh(input) {
		this.#world.assertActive("AcousticScene.addStaticMesh");
		const reflectionMeshId = this.#nextReflectionMeshId++;
		const created = this.#createStaticMesh(this.#world.sceneHandle, input, input.matrixWorld);
		const mesh = created.native;
		this.#world.module._sa_static_mesh_add(mesh, this.#world.sceneHandle);
		this.#world.reflectionWorker?.addStaticMesh(reflectionMeshId, created.converted, Array.isArray(input.material) ? input.material.length : 1);
		this.#dirty = true;
		let disposed = false;
		const handle = { dispose: () => {
			if (disposed) return;
			disposed = true;
			this.#world.module._sa_static_mesh_remove(mesh, this.#world.sceneHandle);
			this.#world.reflectionWorker?.removeMesh(reflectionMeshId);
			this.#pendingReleases.push(() => this.#world.module._sa_static_mesh_release(mesh));
			this.#handles.delete(handle);
			this.#dirty = true;
		} };
		this.#handles.add(handle);
		return handle;
	}
	commit() {
		this.#world.assertActive("AcousticScene.commit");
		if (!this.#dirty) return;
		this.#world.module._sa_scene_commit(this.#world.sceneHandle);
		this.#world.module._sa_simulator_commit(this.#world.simulator);
		this.#world.reflectionWorker?.commitScene();
		this.#dirty = false;
		for (const release of this.#pendingReleases.splice(0)) release();
	}
	dispose() {
		for (const handle of [...this.#handles]) handle.dispose();
		if (this.#dirty) this.commit();
	}
	#createStaticMesh(scene, input, matrixWorld = new Matrix4()) {
		const converted = convertGeometry(input.geometry, input.material, matrixWorld);
		const materialCount = Array.isArray(input.material) ? input.material.length : 1;
		return {
			converted,
			native: createHandle(this.#world.module, "iplStaticMeshCreate", (out) => withFloatArray(this.#world.module, converted.vertices, (vertices) => withIntArray(this.#world.module, converted.indices, (indices) => withFloatArray(this.#world.module, converted.absorption, (absorption) => withFloatArray(this.#world.module, converted.scattering, (scattering) => withFloatArray(this.#world.module, converted.transmission, (transmission) => withIntArray(this.#world.module, converted.materialIndices, (materialIndices) => this.#world.module._sa_static_mesh_create(scene, converted.vertices.length / 3, vertices, converted.indices.length / 3, indices, materialCount, absorption, scattering, transmission, materialIndices, out))))))))
		};
	}
};
var ListenerImpl = class {
	orientation = new Quaternion();
	position = new Vector3();
	#world;
	constructor(world) {
		this.#world = world;
	}
	setOrientation(orientation) {
		this.setTransform(this.position, orientation);
	}
	setPosition(position) {
		this.setTransform(position, this.orientation);
	}
	setReverb(settings) {
		this.#world.setListenerReverb(settings);
	}
	setTransform(position, orientation) {
		this.#world.assertActive("Listener.setTransform");
		this.position.set(position.x, position.y, position.z);
		this.orientation.copy(normalizeQuaternion(orientation));
		const [listenerAhead, listenerUp] = directionsFromQuaternion(this.orientation);
		this.#world.module._sa_simulator_set_listener(this.#world.simulator, this.position.x, this.position.y, this.position.z, listenerAhead.x, listenerAhead.y, listenerAhead.z, listenerUp.x, listenerUp.y, listenerUp.z, this.#world.reflectionSettings.rays, this.#world.reflectionSettings.bounces, this.#world.reflectionSettings.duration, this.#world.reflectionSettings.order, this.#world.reflectionSettings.irradianceMinDistance);
		this.#world.reflectionWorker?.setListener([
			this.position.x,
			this.position.y,
			this.position.z
		], [
			listenerAhead.x,
			listenerAhead.y,
			listenerAhead.z
		], [
			listenerUp.x,
			listenerUp.y,
			listenerUp.z
		], this.#world.reflectionSettings);
		this.#world.syncListenerReverbSource();
		this.#world.publishSourceControls();
	}
};
var SourceImpl = class {
	id;
	nodes = /* @__PURE__ */ new Set();
	get native() {
		return this.#native;
	}
	get reflectionOutputs() {
		return this.#reflectionOutputs;
	}
	get settings() {
		return this.#settings;
	}
	#disposed = false;
	#native;
	#orientation = new Quaternion();
	#outputs = {
		airAbsorption: [
			1,
			1,
			1
		],
		directivity: 1,
		distanceAttenuation: 1,
		occlusion: 1,
		transmission: [
			1,
			1,
			1
		]
	};
	#outputsPointer;
	#overrides = null;
	#position = new Vector3();
	#reflectionOutputs = [
		0,
		0,
		0
	];
	#settings;
	#world;
	constructor(world, id, settings) {
		this.#world = world;
		this.id = id;
		this.#settings = normalizeSettings(settings, world.maxOcclusionSamples);
		this.#native = createHandle(world.module, "iplSourceCreate", (out) => world.module._sa_source_create(world.simulator, SIMULATION_DIRECT | (world.mainThreadReflections ? SIMULATION_REFLECTIONS : 0), out));
		this.#outputsPointer = world.module._malloc(48);
		this.#syncInputs();
		world.reflectionWorker?.addSource(this.#reflectionWorkerInput());
	}
	assertActive(operation) {
		if (this.#disposed) throw new SteamAudioError(operation, `Source ${this.id} has been disposed`);
		this.#world.assertActive(operation);
	}
	dispose() {
		if (this.#disposed) return;
		for (const node of [...this.nodes]) node.dispose();
		this.#disposed = true;
		this.#world.module._sa_source_release(this.#native, this.#world.simulator);
		this.#world.reflectionWorker?.removeSource(this.id);
		this.#world.module._free(this.#outputsPointer);
		this.#world.removeSource(this);
	}
	getDirectOutputs(target) {
		this.assertActive("Source.getDirectOutputs");
		const output = target ?? {
			airAbsorption: [
				1,
				1,
				1
			],
			directivity: 1,
			distanceAttenuation: 1,
			occlusion: 1,
			transmission: [
				1,
				1,
				1
			]
		};
		output.distanceAttenuation = this.#outputs.distanceAttenuation;
		output.directivity = this.#outputs.directivity;
		output.occlusion = this.#outputs.occlusion;
		output.airAbsorption.splice(0, 3, ...this.#outputs.airAbsorption);
		output.transmission.splice(0, 3, ...this.#outputs.transmission);
		return output;
	}
	publishControl() {
		const direct = this.#settings.directSimulation;
		const overrides = this.#overrides;
		const result = this.#outputs;
		const direction = this.#position.clone().sub(this.#world.listenerImpl.position);
		if (direction.lengthSq() < 1e-12) direction.set(0, 0, -1);
		else direction.normalize();
		direction.applyQuaternion(this.#world.listenerImpl.orientation.clone().invert());
		for (const node of this.nodes) node.setControl({
			airAbsorption: overrides?.airAbsorption ?? result.airAbsorption,
			direction: [
				direction.x,
				direction.y,
				direction.z
			],
			directivity: overrides?.directivity ?? result.directivity,
			distanceAttenuation: overrides?.distanceAttenuation ?? result.distanceAttenuation,
			effectFlags: directEffectFlags(this.#settings, overrides),
			hrtf: this.#settings.hrtf,
			occlusion: overrides?.occlusion ?? result.occlusion,
			reflectionReverbTimes: this.#reflectionOutputs,
			reflectionWet: this.#settings.reflections.enabled ? this.#settings.reflections.wet : 0,
			reverbReverbTimes: this.#world.listenerReverbTimes,
			reverbWet: this.#world.listenerReverbEnabled ? 1 : 0,
			spatialBlend: this.#settings.spatialBlend,
			transmission: overrides?.transmission ?? result.transmission,
			transmissionType: direct.transmission !== false && direct.transmission !== void 0 && direct.transmission.type === "frequency-dependent" ? 1 : 0
		});
	}
	readOutputs() {
		const base = this.#outputsPointer;
		assertNativeStatus("iplSourceGetOutputs", this.#world.module._sa_source_get_direct_outputs(this.#native, base, base + 4, base + 16, base + 20, base + 24));
		const heap = this.#world.module.HEAPF32;
		const offset = base >>> 2;
		this.#outputs = {
			airAbsorption: [
				heap[offset + 1],
				heap[offset + 2],
				heap[offset + 3]
			],
			directivity: heap[offset + 4],
			distanceAttenuation: heap[offset],
			occlusion: heap[offset + 5],
			transmission: [
				heap[offset + 6],
				heap[offset + 7],
				heap[offset + 8]
			]
		};
		this.publishControl();
	}
	readReflectionOutputs() {
		assertNativeStatus("iplSourceGetReflectionOutputs", this.#world.module._sa_source_get_reflection_outputs(this.#native, this.#outputsPointer + 36));
		const heap = this.#world.module.HEAPF32;
		const offset = this.#outputsPointer + 36 >>> 2;
		this.#reflectionOutputs = [
			heap[offset],
			heap[offset + 1],
			heap[offset + 2]
		];
		this.publishControl();
		return this.#reflectionOutputs;
	}
	setDirectOverrides(overrides) {
		this.assertActive("Source.setDirectOverrides");
		if (overrides) {
			if (overrides.distanceAttenuation !== void 0) clampUnit("overrides.distanceAttenuation", overrides.distanceAttenuation);
			if (overrides.directivity !== void 0) clampUnit("overrides.directivity", overrides.directivity);
			if (overrides.occlusion !== void 0) clampUnit("overrides.occlusion", overrides.occlusion);
			overrides.airAbsorption?.forEach((value, band) => clampUnit(`overrides.airAbsorption[${band}]`, value));
			overrides.transmission?.forEach((value, band) => clampUnit(`overrides.transmission[${band}]`, value));
		}
		this.#overrides = overrides;
		this.publishControl();
	}
	setOrientation(orientation) {
		this.setTransform(this.#position, orientation);
	}
	setPosition(position) {
		this.setTransform(position, this.#orientation);
	}
	setReflectionOutputs(outputs, ir) {
		this.#reflectionOutputs = [...outputs];
		if (ir) for (const node of this.nodes) node.setReflectionIr(ir);
		this.publishControl();
	}
	setSettings(settings) {
		this.assertActive("Source.setSettings");
		const current = {
			directivity: this.#settings.directivity,
			directSimulation: this.#settings.directSimulation,
			distanceAttenuation: this.#settings.distanceAttenuation,
			hrtf: this.#settings.hrtf,
			reflections: this.#settings.reflections,
			spatialBlend: this.#settings.spatialBlend
		};
		const nextDirectSimulation = settings.directSimulation === false ? false : typeof settings.directSimulation === "object" ? {
			...this.#settings.directSimulation,
			...settings.directSimulation
		} : settings.directSimulation ?? current.directSimulation;
		const nextReflections = settings.reflections === false ? false : settings.reflections === true ? {
			...this.#settings.reflections,
			enabled: true
		} : typeof settings.reflections === "object" ? {
			...this.#settings.reflections,
			...settings.reflections
		} : current.reflections;
		const nextSettings = normalizeSettings({
			...current,
			...settings,
			directivity: settings.directivity ? {
				...this.#settings.directivity,
				...settings.directivity
			} : current.directivity,
			directSimulation: nextDirectSimulation,
			reflections: nextReflections
		}, this.#world.maxOcclusionSamples);
		if (nextSettings.reflections.enabled && !this.#world.reflectionSettings.enabled) throw new Error("Source reflections require World reflections to be enabled");
		this.#settings = nextSettings;
		this.#syncInputs();
		this.#world.reflectionWorker?.updateSource(this.#reflectionWorkerInput());
		this.publishControl();
	}
	setTransform(position, orientation) {
		this.assertActive("Source.setTransform");
		this.#position.set(position.x, position.y, position.z);
		this.#orientation.copy(normalizeQuaternion(orientation));
		this.#syncInputs();
		this.#world.reflectionWorker?.updateSource(this.#reflectionWorkerInput());
		this.publishControl();
	}
	#reflectionWorkerInput() {
		const [sourceAhead, sourceUp] = directionsFromQuaternion(this.#orientation);
		return {
			ahead: [
				sourceAhead.x,
				sourceAhead.y,
				sourceAhead.z
			],
			enabled: this.#settings.reflections.enabled,
			id: this.id,
			position: [
				this.#position.x,
				this.#position.y,
				this.#position.z
			],
			reverbScale: this.#settings.reflections.reverbScale,
			up: [
				sourceUp.x,
				sourceUp.y,
				sourceUp.z
			]
		};
	}
	#syncInputs() {
		const settings = this.#settings;
		const direct = settings.directSimulation;
		const distance = distanceModel(settings.distanceAttenuation);
		const air = airModel(direct.airAbsorptionModel);
		const [sourceAhead, sourceUp] = directionsFromQuaternion(this.#orientation);
		let flags = 0;
		if (settings.distanceAttenuation !== false) flags |= DIRECT_DISTANCE;
		if (direct.airAbsorption === true) flags |= DIRECT_AIR;
		if (settings.directivity.dipoleWeight > 0) flags |= DIRECT_DIRECTIVITY;
		if (direct.occlusion !== false && direct.occlusion !== void 0) flags |= DIRECT_OCCLUSION;
		if (direct.transmission !== false && direct.transmission !== void 0) flags |= DIRECT_TRANSMISSION;
		withOptionalFloatArray(this.#world.module, distance.curve, (distancePointer) => withOptionalFloatArray(this.#world.module, air.coefficients, (coefficientPointer) => withOptionalFloatArray(this.#world.module, air.curves, (airPointer) => withFloatArray(this.#world.module, settings.reflections.reverbScale, (reverbScalePointer) => this.#world.module._sa_source_set_inputs(this.#native, this.#position.x, this.#position.y, this.#position.z, sourceAhead.x, sourceAhead.y, sourceAhead.z, sourceUp.x, sourceUp.y, sourceUp.z, flags, distance.model, distance.minimum, distance.maximum, distance.curve?.length ?? 0, distancePointer, air.model, coefficientPointer, air.maximum, air.samples, airPointer, settings.directivity.dipoleWeight, settings.directivity.dipolePower, direct.occlusion === "volumetric" ? 1 : 0, direct.occlusionRadius ?? 1, direct.occlusion === "volumetric" ? direct.occlusionSamples ?? 16 : 1, direct.transmission !== false && direct.transmission !== void 0 ? 1 : 0, this.#world.mainThreadReflections ? settings.reflections.enabled ? 1 : 0 : -1, reverbScalePointer)))));
	}
};
var WorldImpl = class {
	audioContext;
	context;
	frameSize;
	listener;
	listenerImpl;
	listenerReverbEnabled = false;
	listenerReverbTimes = [
		0,
		0,
		0
	];
	mainThreadReflections;
	maxOcclusionSamples;
	maxSources;
	module;
	reflectionSettings;
	reflectionWorker;
	scene;
	sceneHandle;
	simulator;
	#accumulator = 0;
	#disposed = false;
	#listenerReverbSource;
	#nextSourceId = 1;
	#reflectionAccumulator = 0;
	#reflectionBuses = /* @__PURE__ */ new Set();
	#reflectionInterval;
	#reverbBuses = /* @__PURE__ */ new Set();
	#simulationInterval;
	#sofaData;
	#sources = /* @__PURE__ */ new Set();
	#wasmBinary;
	constructor(runtime, options) {
		this.audioContext = options.audioContext;
		this.module = runtime.module;
		this.#wasmBinary = runtime.wasmBinary;
		this.#sofaData = options.hrtf?.type === "sofa" ? options.hrtf.data : void 0;
		this.frameSize = integer("frameSize", options.frameSize ?? DEFAULT_FRAME_SIZE);
		this.maxSources = integer("maxSources", options.maxSources ?? DEFAULT_MAX_SOURCES);
		this.maxOcclusionSamples = integer("simulation.maxOcclusionSamples", options.simulation?.maxOcclusionSamples ?? QUALITY_MAX_OCCLUSION_SAMPLES[options.quality ?? "medium"]);
		this.#simulationInterval = 1 / positive("simulationRate", options.simulationRate ?? DEFAULT_SIMULATION_RATE);
		this.#reflectionInterval = 1 / positive("reflectionRate", options.reflectionRate ?? DEFAULT_REFLECTION_RATE);
		const reflectionOptions = options.reflections === false ? void 0 : options.reflections;
		const maxRays = integer("reflections.maxRays", reflectionOptions?.maxRays ?? options.simulation?.maxRays ?? 4096);
		const maxDuration = positive("reflections.maxDuration", reflectionOptions?.maxDuration ?? options.simulation?.maxDuration ?? 2);
		const maxOrder = integer("reflections.maxOrder", reflectionOptions?.maxOrder ?? options.simulation?.maxOrder ?? 1, 0);
		const diffuseSamples = integer("reflections.diffuseSamples", reflectionOptions?.diffuseSamples ?? options.simulation?.diffuseSamples ?? 32);
		const headTracked = Boolean(reflectionOptions && typeof reflectionOptions === "object" && reflectionOptions.headTracked);
		const irDuration = Math.min(positive("reflections.irDuration", reflectionOptions?.irDuration ?? .2), maxDuration);
		const irTaps = integer("reflections.irTaps", reflectionOptions?.irTaps ?? 512, 1);
		this.reflectionSettings = {
			bounces: 8,
			diffuseSamples,
			duration: maxDuration,
			enabled: reflectionOptions !== void 0,
			headTracked,
			irDuration,
			irradianceMinDistance: 1,
			irTaps,
			maxDuration,
			maxOrder,
			maxRays,
			order: maxOrder,
			rays: maxRays
		};
		const useReflectionWorker = this.reflectionSettings.enabled && canUseReflectionWorker();
		this.mainThreadReflections = this.reflectionSettings.enabled && !useReflectionWorker;
		this.context = createHandle(this.module, "iplContextCreate", (out) => this.module._sa_context_create(out));
		try {
			this.sceneHandle = createHandle(this.module, "iplSceneCreate", (out) => this.module._sa_scene_create(this.context, out));
			try {
				this.simulator = createHandle(this.module, "iplSimulatorCreate", (out) => this.module._sa_simulator_create(this.context, this.sceneHandle, this.audioContext.sampleRate, this.frameSize, this.maxSources + 1, this.maxOcclusionSamples, this.mainThreadReflections ? 1 : 0, maxRays, diffuseSamples, maxDuration, maxOrder, 1, headTracked ? 1 : 0, out));
			} catch (error) {
				this.module._sa_scene_release(this.sceneHandle);
				throw error;
			}
		} catch (error) {
			this.module._sa_context_release(this.context);
			throw error;
		}
		if (useReflectionWorker) this.reflectionWorker = new ReflectionSimulationWorker(this.#wasmBinary, this.audioContext.sampleRate, this.frameSize, this.maxSources + 1, this.reflectionSettings, (outputs) => this.#receiveReflectionOutputs(outputs), this.#sofaData);
		this.scene = new AcousticSceneImpl(this);
		this.listenerImpl = new ListenerImpl(this);
		this.listener = this.listenerImpl;
		this.listener.setTransform({
			x: 0,
			y: 0,
			z: 0
		}, {
			w: 1,
			x: 0,
			y: 0,
			z: 0
		});
	}
	assertActive(operation) {
		if (this.#disposed) throw new SteamAudioError(operation, "World has been disposed");
	}
	createNode(sourceValue) {
		this.assertActive("World.createNode");
		if (!(sourceValue instanceof SourceImpl) || !this.#sources.has(sourceValue)) throw new TypeError("World.createNode requires a Source created by this World");
		sourceValue.assertActive("World.createNode");
		const node = new SteamAudioNode(this.audioContext, {
			frameSize: this.frameSize,
			headTracked: this.reflectionSettings.headTracked,
			onDispose: (disposedNode) => sourceValue.nodes.delete(disposedNode),
			reflectionOrder: this.reflectionSettings.order,
			sofaData: this.#sofaData,
			source: sourceValue,
			wasmBinary: this.#wasmBinary
		});
		sourceValue.nodes.add(node);
		sourceValue.publishControl();
		return node;
	}
	createReflectionBus(settings) {
		this.assertActive("World.createReflectionBus");
		if (!this.reflectionSettings.enabled) throw new Error("Reflections are disabled for this World");
		const bus = new ReflectionBusNode(this.audioContext, settings, (disposed) => this.#reflectionBuses.delete(disposed));
		this.#reflectionBuses.add(bus);
		return bus;
	}
	createReverbBus(settings) {
		this.assertActive("World.createReverbBus");
		if (!this.reflectionSettings.enabled) throw new Error("Reflections are disabled for this World");
		const bus = new ReverbBusNode(this.audioContext, settings, (disposed) => this.#reverbBuses.delete(disposed));
		this.#reverbBuses.add(bus);
		return bus;
	}
	createSource(settings) {
		this.assertActive("World.createSource");
		if (this.#sources.size >= this.maxSources) throw new SteamAudioError("World.createSource", `maxSources (${this.maxSources}) exceeded`);
		const source = new SourceImpl(this, this.#nextSourceId++, settings);
		if (source.settings.reflections.enabled && !this.reflectionSettings.enabled) {
			source.dispose();
			throw new Error("Source reflections require World reflections to be enabled");
		}
		this.#sources.add(source);
		return source;
	}
	dispose() {
		if (this.#disposed) return;
		for (const source of [...this.#sources]) source.dispose();
		this.#listenerReverbSource?.dispose();
		for (const bus of [...this.#reflectionBuses]) bus.dispose();
		for (const bus of [...this.#reverbBuses]) bus.dispose();
		this.scene.dispose();
		this.reflectionWorker?.dispose();
		this.#disposed = true;
		this.module._sa_simulator_release(this.simulator);
		this.module._sa_scene_release(this.sceneHandle);
		this.module._sa_context_release(this.context);
	}
	publishSourceControls() {
		for (const source of this.#sources) source.publishControl();
	}
	removeSource(source) {
		this.#sources.delete(source);
	}
	setListenerReverb(settings) {
		this.assertActive("Listener.setReverb");
		if (settings !== false && !this.reflectionSettings.enabled) throw new Error("Reflections are disabled for this World");
		this.listenerReverbEnabled = settings !== false && (settings.enabled ?? true);
		if (this.listenerReverbEnabled && !this.#listenerReverbSource) this.#listenerReverbSource = new SourceImpl(this, 0, {
			directSimulation: false,
			reflections: {
				enabled: true,
				reverbScale: settings === false ? [
					1,
					1,
					1
				] : settings.reverbScale
			}
		});
		else if (this.#listenerReverbSource && settings !== false) this.#listenerReverbSource.setSettings({ reflections: {
			enabled: this.listenerReverbEnabled,
			reverbScale: settings.reverbScale
		} });
		else if (this.#listenerReverbSource) this.#listenerReverbSource.setSettings({ reflections: false });
		this.syncListenerReverbSource();
		for (const source of this.#sources) source.publishControl();
	}
	setReflectionSettings(settings) {
		this.assertActive("World.setReflectionSettings");
		if (settings.rays !== void 0) {
			const rays = integer("rays", settings.rays);
			if (rays > this.reflectionSettings.maxRays) throw new RangeError(`rays cannot exceed World maxRays (${this.reflectionSettings.maxRays})`);
			this.reflectionSettings.rays = rays;
		}
		if (settings.bounces !== void 0) this.reflectionSettings.bounces = integer("bounces", settings.bounces);
		if (settings.duration !== void 0) {
			const duration = positive("duration", settings.duration);
			if (duration > this.reflectionSettings.maxDuration) throw new RangeError(`duration cannot exceed World maxDuration (${this.reflectionSettings.maxDuration})`);
			this.reflectionSettings.duration = duration;
		}
		if (settings.order !== void 0) {
			const order = integer("order", settings.order, 0);
			if (order > this.reflectionSettings.maxOrder) throw new RangeError(`order cannot exceed World maxOrder (${this.reflectionSettings.maxOrder})`);
			this.reflectionSettings.order = order;
		}
		if (settings.irradianceMinDistance !== void 0) this.reflectionSettings.irradianceMinDistance = positive("irradianceMinDistance", settings.irradianceMinDistance);
		this.listenerImpl.setTransform(this.listenerImpl.position, this.listenerImpl.orientation);
	}
	step(delta) {
		this.assertActive("World.step");
		if (!Number.isFinite(delta) || delta < 0) throw new RangeError("World.step delta must be a finite number >= 0");
		if (this.audioContext.state !== "running") return;
		this.#runDirectSimulation(delta);
		this.#runReflectionSimulation(delta);
	}
	syncListenerReverbSource() {
		this.#listenerReverbSource?.setTransform(this.listenerImpl.position, this.listenerImpl.orientation);
	}
	#receiveReflectionOutputs(outputs) {
		for (const output of outputs) {
			if (output.id === 0) {
				this.listenerReverbTimes = output.reverbTimes;
				continue;
			}
			[...this.#sources].find((value) => value.id === output.id)?.setReflectionOutputs(output.reverbTimes, output.ir);
		}
		for (const source of this.#sources) source.publishControl();
	}
	#runDirectSimulation(delta) {
		this.#accumulator += delta;
		while (this.#accumulator >= this.#simulationInterval) {
			this.#accumulator -= this.#simulationInterval;
			assertNativeStatus("iplSimulatorRunDirect", this.module._sa_simulator_run_direct(this.simulator));
			for (const source of this.#sources) source.readOutputs();
		}
	}
	#runReflectionSimulation(delta) {
		if (!this.reflectionSettings.enabled) return;
		this.#reflectionAccumulator += delta;
		while (this.#reflectionAccumulator >= this.#reflectionInterval) {
			this.#reflectionAccumulator -= this.#reflectionInterval;
			if (![...this.#sources].some((source) => source.settings.reflections.enabled) && !this.listenerReverbEnabled) continue;
			if (this.reflectionWorker) {
				this.reflectionWorker.run();
				continue;
			}
			this.#runReflectionsNow();
		}
	}
	#runReflectionsNow() {
		assertNativeStatus("iplSimulatorRunReflections", this.module._sa_simulator_run_reflections(this.simulator));
		for (const source of this.#sources) if (source.settings.reflections.enabled) source.readReflectionOutputs();
		if (!this.#listenerReverbSource) return;
		this.listenerReverbTimes = [...this.#listenerReverbSource.readReflectionOutputs()];
		for (const source of this.#sources) source.publishControl();
	}
};
const createWorldFromRuntime = (runtime, options) => new WorldImpl(runtime, options);
const createWorld = async (options) => {
	return createWorldFromRuntime(await prepareWorldRuntime(options), options);
};
//#endregion
export { getPreparedRuntimePromise as a, SteamAudioNode as c, detectCapabilities as i, SteamAudioError as l, createWorldFromRuntime as n, ReflectionBusNode as o, defaultModuleFactory as r, ReverbBusNode as s, createWorld as t };
