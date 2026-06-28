/**
 * JS wrapper around the Rust→WASM acoustics core. Initializes the module once
 * and exposes a typed `computeShoeboxTaps` that returns an array of Tap objects
 * unpacked from the flat Float32Array the WASM side produces.
 */
import init, {
  compute_shoebox_taps,
  compute_room_taps,
  tap_stride,
  num_bands,
} from './wasm/acoustics_core.js';
import wasmUrl from './wasm/acoustics_core_bg.wasm?url';
import { packAbsorption, type ShoeboxMaterialMap, NUM_BANDS } from './materials';

export interface Tap {
  delay: number; // seconds
  gain: number; // broadband 1/r
  dir: [number, number, number]; // unit vector listener→(image) source, world space
  order: number;
  bandGains: number[]; // length NUM_BANDS
}

let ready: Promise<void> | null = null;
let stride = 0;

export async function initAcoustics(): Promise<void> {
  if (!ready) {
    ready = init(wasmUrl).then(() => {
      stride = tap_stride();
      if (num_bands() !== NUM_BANDS) {
        throw new Error(`band count mismatch: wasm ${num_bands()} vs ts ${NUM_BANDS}`);
      }
    });
  }
  return ready;
}

export interface ShoeboxParams {
  size: [number, number, number];
  materials: ShoeboxMaterialMap;
  listener: [number, number, number];
  source: [number, number, number];
  maxOrder: number;
}

export function computeShoeboxTaps(p: ShoeboxParams): Tap[] {
  const absorption = packAbsorption(p.materials);
  const packed = compute_shoebox_taps(
    new Float32Array(p.size),
    absorption,
    new Float32Array(p.listener),
    new Float32Array(p.source),
    p.maxOrder,
  );

  return unpackTaps(packed);
}

/** Unpack a flat TAP_STRIDE-packed Float32Array into Tap objects. */
function unpackTaps(packed: Float32Array): Tap[] {
  const taps: Tap[] = [];
  const n = packed.length / stride;
  for (let i = 0; i < n; i++) {
    const o = i * stride;
    const bandGains: number[] = [];
    for (let b = 0; b < NUM_BANDS; b++) bandGains.push(packed[o + 6 + b]);
    taps.push({
      delay: packed[o],
      gain: packed[o + 1],
      dir: [packed[o + 2], packed[o + 3], packed[o + 4]],
      order: packed[o + 5],
      bandGains,
    });
  }
  return taps;
}

/** A convex polygonal wall: vertices (xyz each) + per-band absorption. */
export interface WallDef {
  verts: Array<[number, number, number]>;
  absorption: number[]; // length NUM_BANDS
}

/** A diffracting edge (doorway jamb / corner): two endpoints. */
export type EdgeDef = [[number, number, number], [number, number, number]];

export interface RoomParams {
  walls: WallDef[];
  edges?: EdgeDef[];
  listener: [number, number, number];
  source: [number, number, number];
  maxOrder: number;
}

/**
 * Compute taps for a general room (arbitrary convex-polygon walls) plus optional
 * first-order edge diffraction. Flattens the geometry into the arrays the WASM
 * core expects.
 */
export function computeRoomTaps(p: RoomParams): Tap[] {
  const verts: number[] = [];
  const wallSizes: number[] = [];
  const wallAbs: number[] = [];
  for (const w of p.walls) {
    wallSizes.push(w.verts.length);
    for (const v of w.verts) verts.push(v[0], v[1], v[2]);
    for (let b = 0; b < NUM_BANDS; b++) wallAbs.push(w.absorption[b]);
  }
  const edges: number[] = [];
  for (const e of p.edges ?? []) {
    edges.push(e[0][0], e[0][1], e[0][2], e[1][0], e[1][1], e[1][2]);
  }

  const packed = compute_room_taps(
    new Float32Array(verts),
    new Uint32Array(wallSizes),
    new Float32Array(wallAbs),
    new Float32Array(edges),
    new Float32Array(p.listener),
    new Float32Array(p.source),
    p.maxOrder,
  );
  return unpackTaps(packed);
}
