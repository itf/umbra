import { c as SteamAudioNode, i as detectCapabilities, l as SteamAudioError, o as ReflectionBusNode, s as ReverbBusNode, t as createWorld } from "./world-BbGVRMC8.js";
//#region src/three/materials.ts
const material = (absorption, scattering, transmission = [
	0,
	0,
	0
]) => Object.freeze({
	absorption: Object.freeze([...absorption]),
	scattering,
	transmission: Object.freeze([...transmission])
});
const Materials = Object.freeze({
	concrete: material([
		.1,
		.05,
		.02
	], .05),
	generic: material([
		.1,
		.2,
		.3
	], .05),
	glass: material([
		.13,
		.2,
		.24
	], .05, [
		.06,
		.03,
		.02
	]),
	metal: material([
		.2,
		.07,
		.06
	], .05, [
		.03,
		.02,
		.01
	]),
	wood: material([
		.11,
		.07,
		.06
	], .05)
});
//#endregion
export { Materials, ReflectionBusNode, ReverbBusNode, SteamAudioError, SteamAudioNode, createWorld, detectCapabilities };
