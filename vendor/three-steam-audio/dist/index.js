import { c as ReverbBusNode, i as detectCapabilities, l as SteamAudioNode, o as PathingBusNode, s as ReflectionBusNode, t as createWorld, u as SteamAudioError } from "./world-Bgcj5GoD.js";
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
export { Materials, PathingBusNode, ReflectionBusNode, ReverbBusNode, SteamAudioError, SteamAudioNode, createWorld, detectCapabilities };
