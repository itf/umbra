/**
 * "Clap to hear the room": computes the room impulse response for the listener's
 * current position via the WASM acoustics core, then plays a short impulsive
 * sound (a clap) convolved through it. The early reflections you hear encode the
 * room's size and materials — the core echolocation cue.
 */
import type { AudioGraph } from '../audioGraph';
import type { HrtfRenderer } from '../hrtf/renderer';
import { computeShoeboxTaps, computeRoomTaps, type ShoeboxParams, type WallDef, type EdgeDef } from './core';
import { buildRoomIr } from './roomIr';
import { scatteringFor, absorptionFor } from './materials';
import { resolveProbe } from '../../debug/probes';
import { getIrPair, nearestDir, sphericalToVec } from '../hrtf/sofa';

/**
 * Where your OWN probe is emitted, relative to your head. Rendering the dry probe
 * through the HRIR for this direction makes the sound you FIRE localize at the
 * spot on your body it comes from — so the returning wall echoes are heard as
 * displaced from that reference, which is what makes the echolocation cue legible.
 * Without it the self-sound is a flat, placeless blip the echoes have nothing to
 * sit "in front of".
 *
 * Each probe has a natural body origin:
 *  - a tongue/mouth CLICK: between the ears (az 0°), a bit BELOW the interaural
 *    axis (where the mouth is), essentially on the head.
 *  - a hand CLAP / snap: below AND in front (hands at chest height).
 *  - a STOMP: down and in front (foot).
 * Elevation is negative = below; a slight frontal bias is implicit in az 0°
 * (the HRTF places az-0 sources in front, not inside the head).
 */
/**
 * A self-source has one of two emission MODELS:
 *
 *  - 'inhead' — the sound is produced INSIDE the skull (a tongue/mouth click is made
 *    at the palate, between the ears). It is NOT "out in front", so a measured
 *    far-field HRIR (which carries front/pinna cues) would wrongly externalize it.
 *    Instead we HAND-BUILD a diotic near-field pair: near-identical L/R (ITD≈0 →
 *    centred), no pinna coloration, a gentle HF tilt so it reads as palatal/bone-
 *    conducted rather than a bright external click. Tunable via MOUTH_NEARFIELD.
 *
 *  - 'hrir' — the sound is produced OUT ON THE BODY (hands at chest, foot on the
 *    floor). These DO externalize, so we use the measured HRIR for their direction
 *    (az 0° front-centre; negative elevation = below the interaural axis).
 */
type EmitModel =
  | { model: 'inhead' }
  | { model: 'hrir'; azDeg: number; elDeg: number };

const MOUTH_EMIT: EmitModel = { model: 'inhead' };
const EMIT_MODELS: Record<string, EmitModel> = {
  mouthclick: MOUTH_EMIT,
  click: MOUTH_EMIT,
  hiss: MOUTH_EMIT,
  clap: { model: 'hrir', azDeg: 0, elDeg: -35 }, // hands at chest, below + in front
  snap: { model: 'hrir', azDeg: 0, elDeg: -8 }, // fingers up near the head, just in front
  stomp: { model: 'hrir', azDeg: 0, elDeg: -70 }, // foot, well below
};
/** Emission model for a probe name (recorded buffers fall back to the mouth). */
function emitModelFor(probe: string | AudioBuffer | undefined): EmitModel {
  if (typeof probe === 'string' && EMIT_MODELS[probe]) return EMIT_MODELS[probe];
  return MOUTH_EMIT;
}

/**
 * HAND-TUNED near-field pair for the in-head (mouth) click. Change these to taste —
 * this is the "manually modify it" knob for how the tongue click sits in the head.
 *   - `lead`   : short leading zero-pad (samples-ish, scaled by SR) before the kernel,
 *                so it doesn't sit exactly at buffer[0] (avoids a hard DC edge).
 *   - `hfTilt` : one-pole lowpass coefficient in [0,1). 0 = no coloration (bright,
 *                sits toward the front); higher = duller (more "inside the head" /
 *                bone-conducted). ~0.35 reads as a palatal click without going muddy.
 *   - `earBias`: tiny L/R gain asymmetry (0 = perfectly diotic/centred). Keep ~0;
 *                a hair (e.g. 0.02) can stop it feeling unnaturally point-collapsed.
 *   - `taps`   : kernel length in samples (short — this is a near-impulse, not an IR).
 */
const MOUTH_NEARFIELD = { leadMs: 0.1, hfTilt: 0.35, earBias: 0.0, taps: 24 };

/**
 * Build the diotic in-head near-field HRIR pair (L, R) for the mouth click.
 * PURE — no Web Audio; the caller wraps it in an AudioBuffer. A short one-pole-
 * lowpassed impulse, duplicated to both ears (with an optional hair of L/R bias).
 */
function buildMouthNearField(sampleRate: number): { left: Float32Array; right: Float32Array } {
  const { leadMs, hfTilt, earBias, taps } = MOUTH_NEARFIELD;
  const lead = Math.max(0, Math.round((leadMs / 1000) * sampleRate));
  const n = lead + Math.max(1, taps);
  const mono = new Float32Array(n);
  // Impulse at `lead`, then a short one-pole lowpass tail (HF tilt → duller/in-head).
  let y = 0;
  for (let i = lead; i < n; i++) {
    const x = i === lead ? 1 : 0;
    y = hfTilt * y + (1 - hfTilt) * x;
    mono[i] = y;
  }
  // Normalize to unit peak so it sits at a predictable level vs the reflection path.
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(mono[i]));
  if (peak > 0) for (let i = 0; i < n; i++) mono[i] /= peak;
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  const gl = 1 - earBias, gr = 1 + earBias;
  for (let i = 0; i < n; i++) { left[i] = mono[i] * gl; right[i] = mono[i] * gr; }
  return { left, right };
}

/** Average mid-band scattering across a room's assigned wall materials. */
function representativeScattering(params: ShoeboxParams): number {
  const mats = Object.values(params.materials);
  if (mats.length === 0) return 0.1;
  let sum = 0;
  for (const m of mats) sum += scatteringFor(m as string)[4]; // ~1kHz band
  return sum / mats.length;
}

/** Room descriptor for the late-reverb RT60 (Eyring) estimate. */
type RoomGeom = { volume: number; surfaceArea: number; meanAbsorption: number };

/** A surface reduced to (area, absorption@1kHz, centroid) for local weighting. */
export interface SurfaceSample {
  area: number;
  absorption: number;
  centroid: [number, number, number];
}

/**
 * Characteristic distance (m) for the listener-local absorption falloff. Surfaces
 * closer than ~d0 dominate the effective absorption the listener experiences; far
 * ones fade out. Tuned so a wall a metre away clearly dominates one ~15 m away
 * (weight ratio ≈ (1+(15/3)^2)/(1+(1/3)^2) ≈ 26×) yet a few-metre room still blends
 * several walls. See docs/engine/late-reverb-fdn.md "Listener-local RT60".
 */
export const LOCAL_ABSORPTION_D0 = 3;

/**
 * Listener-local, distance-weighted mean absorption.
 *
 * Each surface's weight is `area / (1 + (dist/d0)^2)` where `dist` is the listener-
 * to-centroid distance — an inverse-square-ish falloff so NEAR surfaces dominate the
 * effective absorption (a carpet alcove decays faster than the marble nave centre).
 * When no listener is given, falls back to the plain AREA-weighted whole-room mean
 * (back-compat with the original `wallsRoom`/`shoeboxRoom` behaviour). PURE — unit-
 * tested without Web Audio.
 */
export function localMeanAbsorption(
  surfaces: SurfaceSample[],
  listener?: [number, number, number],
  d0: number = LOCAL_ABSORPTION_D0,
): number {
  let wsum = 0, weighted = 0;
  for (const s of surfaces) {
    let w = s.area;
    if (listener) {
      const dx = s.centroid[0] - listener[0];
      const dy = s.centroid[1] - listener[1];
      const dz = s.centroid[2] - listener[2];
      const dist2 = dx * dx + dy * dy + dz * dz;
      w = s.area / (1 + dist2 / (d0 * d0));
    }
    wsum += w;
    weighted += w * s.absorption;
  }
  return wsum > 0 ? weighted / wsum : 0.1;
}

/** Centroid (mean of vertices) of a polygon. */
function polyCentroid(verts: Array<[number, number, number]>): [number, number, number] {
  let x = 0, y = 0, z = 0;
  for (const v of verts) { x += v[0]; y += v[1]; z += v[2]; }
  const n = Math.max(1, verts.length);
  return [x / n, y / n, z / n];
}

/**
 * Exact shoebox volume / surface area / 1 kHz absorption. With a `listener`, the
 * absorption is the listener-local distance-weighted mean (see localMeanAbsorption);
 * without one it is the plain area-weighted whole-room mean. V and S stay global.
 */
function shoeboxRoom(params: ShoeboxParams, listener?: [number, number, number]): RoomGeom {
  const [x, y, z] = params.size;
  // Faces in WALL_ORDER with their area + centroid (box assumed centred at origin).
  // NOTE: the listener-local weighting therefore assumes the shoebox sits at the
  // origin; if a shoebox is ever paired with a non-origin position, pass the listener
  // in box-local coords (the area-weighted/no-listener path is unaffected regardless).
  const hx = x / 2, hy = y / 2, hz = z / 2;
  const faces: Array<{ area: number; centroid: [number, number, number]; wall: '-x' | '+x' | '-y' | '+y' | '-z' | '+z' }> = [
    { area: y * z, centroid: [-hx, 0, 0], wall: '-x' },
    { area: y * z, centroid: [hx, 0, 0], wall: '+x' },
    { area: x * z, centroid: [0, -hy, 0], wall: '-y' },
    { area: x * z, centroid: [0, hy, 0], wall: '+y' },
    { area: x * y, centroid: [0, 0, -hz], wall: '-z' },
    { area: x * y, centroid: [0, 0, hz], wall: '+z' },
  ];
  const surfaces: SurfaceSample[] = faces.map((f) => ({
    area: f.area,
    absorption: absorptionFor((params.materials[f.wall] ?? 'concrete') as string)[4], // ~1 kHz
    centroid: f.centroid,
  }));
  const area = surfaces.reduce((s, f) => s + f.area, 0);
  return {
    volume: x * y * z,
    surfaceArea: area,
    meanAbsorption: localMeanAbsorption(surfaces, listener),
  };
}

/** Polygon area of a planar convex wall (Newell's method). */
function polyArea(verts: Array<[number, number, number]>): number {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % verts.length];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return 0.5 * Math.hypot(nx, ny, nz);
}

/**
 * Derive a RoomGeom from a general wall list: surface area = sum of polygon areas,
 * absorption = area-weighted mid-band absorption (walls carry per-band absorption),
 * volume = bounding-box volume (a robust approximation for the RT60 estimate).
 */
export function wallsRoom(walls: WallDef[], listener?: [number, number, number]): RoomGeom {
  let area = 0;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  const surfaces: SurfaceSample[] = [];
  for (const w of walls) {
    const a = polyArea(w.verts);
    area += a;
    surfaces.push({ area: a, absorption: w.absorption[4] ?? 0.1, centroid: polyCentroid(w.verts) });
    for (const v of w.verts) {
      minX = Math.min(minX, v[0]); maxX = Math.max(maxX, v[0]);
      minY = Math.min(minY, v[1]); maxY = Math.max(maxY, v[1]);
      minZ = Math.min(minZ, v[2]); maxZ = Math.max(maxZ, v[2]);
    }
  }
  const volume = Number.isFinite(minX)
    ? Math.max(0, maxX - minX) * Math.max(0, maxY - minY) * Math.max(0, maxZ - minZ)
    : 0;
  // V and S stay GLOBAL (whole-room); only meanAbsorption becomes listener-local.
  return { volume, surfaceArea: area, meanAbsorption: localMeanAbsorption(surfaces, listener) };
}

export interface ClapRoomConfig {
  room: ShoeboxParams; // listener/source filled per-clap from pose
  maxOrder?: number;
}

/** One room-IR convolver chain + its crossfade gain. */
interface RoomChain {
  convolver: ConvolverNode;
  gain: GainNode;
}

export class ClapRoom {
  private graph: AudioGraph;
  private renderer: HrtfRenderer;
  /**
   * DUAL convolvers, equal-power crossfaded — the same trick `renderer.ts` uses for
   * moving sources. Swapping a single ConvolverNode's `buffer` mid-signal CLICKS
   * (the in-flight tail jumps). With moving walls the room IR is rebuilt many times
   * a second, so we load each new IR into the idle chain and ramp across.
   */
  private chains: [RoomChain, RoomChain];
  private active = 0;
  private wet: GainNode;
  /** The clap excitation feeds whichever convolver(s) are live. */
  private clapBus: GainNode;
  /**
   * DRY self-source: the sound of your OWN probe, localized at the spot on your
   * body it comes from (mouth/hands/foot). The dry click convolves through a
   * short near-field HRIR for the probe's emit direction and plays at t=0, so you
   * hear it in front-and-below BEFORE the room echoes return. Its HRIR buffer is
   * (re)built per emit direction and cached. Null until the first clap builds one.
   */
  private selfDry: GainNode;
  private selfIrCache = new Map<string, AudioBuffer>();

  // --- live (moving-walls) throttle + dirty-check state ---
  private lastBuildMs = 0;
  private lastSig = '';
  private lastFadeT = 0;

  constructor(graph: AudioGraph, renderer: HrtfRenderer) {
    this.graph = graph;
    this.renderer = renderer;
    const ctx = graph.ctx;
    this.wet = ctx.createGain();
    this.wet.gain.value = 1.0;
    this.wet.connect(graph.master);
    this.clapBus = ctx.createGain();
    this.selfDry = ctx.createGain();
    this.selfDry.gain.value = 1.0;
    this.selfDry.connect(graph.master);

    const makeChain = (): RoomChain => {
      const convolver = ctx.createConvolver();
      convolver.normalize = false;
      const gain = ctx.createGain();
      this.clapBus.connect(convolver);
      convolver.connect(gain).connect(this.wet);
      return { convolver, gain };
    };
    this.chains = [makeChain(), makeChain()];
    this.chains[0].gain.gain.value = 1;
    this.chains[1].gain.gain.value = 0;
  }

  /** Load a freshly-built stereo IR into the idle chain and crossfade to it. The
   *  first ever IR loads straight into the active chain (no audible swap). */
  private swapIr(ir: { left: Float32Array; right: Float32Array; length: number; sampleRate: number }) {
    const ctx = this.graph.ctx;
    const buf = ctx.createBuffer(2, ir.length, ir.sampleRate);
    buf.getChannelData(0).set(ir.left);
    buf.getChannelData(1).set(ir.right);

    if (this.chains[this.active].convolver.buffer == null) {
      this.chains[this.active].convolver.buffer = buf;
      return;
    }
    const t = ctx.currentTime;
    const FADE = 0.08; // 80 ms equal-power-ish crossfade
    const idle = this.active ^ 1;
    // Rate-limit: if still mid-fade, just refresh the incoming buffer (no new ramp).
    if (t - this.lastFadeT < FADE) {
      this.chains[idle].convolver.buffer = buf;
      return;
    }
    this.chains[idle].convolver.buffer = buf;
    this.chains[idle].gain.gain.cancelScheduledValues(t);
    this.chains[this.active].gain.gain.cancelScheduledValues(t);
    this.chains[idle].gain.gain.setTargetAtTime(1, t, FADE / 3);
    this.chains[this.active].gain.gain.setTargetAtTime(0, t, FADE / 3);
    this.active = idle;
    this.lastFadeT = t;
  }

  /**
   * Recompute the room IR for the given shoebox + current listener pose/heading.
   * Call when the room or listener position changes; cheap enough to call on
   * each clap.
   *
   * NOTE: this shoebox path does not take a per-level `speedOfSound` (it has no
   * callers in the game today — the game uses `updateGeneralRoom`). If it's ever
   * wired up, add a speedOfSound opt here too so its clap timing matches the live
   * sources, as `updateGeneralRoom`/`updateLive` do.
   */
  updateRoom(params: ShoeboxParams, yaw: number) {
    const taps = computeShoeboxTaps(params);
    const ir = buildRoomIr(taps, this.renderer.set, {
      yaw,
      scattering: representativeScattering(params),
      room: shoeboxRoom(params),
    });
    this.swapIr(ir);
  }

  /**
   * Recompute the room IR from GENERAL geometry — an arbitrary wall list (+ edges)
   * at the current listener position. This is what the game uses, so open levels,
   * interior walls, stepped ceilings, and (future) MOVING walls all produce correct
   * echoes: the caller just passes the live wall list each clap.
   *
   * `scattering` is the representative coefficient for the surfaces in play (the
   * caller knows the materials; WallDefs only carry absorption).
   */
  updateGeneralRoom(
    walls: WallDef[],
    listener: [number, number, number],
    yaw: number,
    opts: { edges?: EdgeDef[]; maxOrder?: number; scattering?: number; speedOfSound?: number } = {},
  ) {
    const taps = computeRoomTaps({
      walls,
      edges: opts.edges,
      listener,
      source: listener, // clap originates at the head
      maxOrder: opts.maxOrder ?? 2,
      speedOfSound: opts.speedOfSound,
    });
    const ir = buildRoomIr(taps, this.renderer.set, {
      yaw,
      scattering: opts.scattering ?? 0.1,
      room: wallsRoom(walls, listener),
    });
    this.swapIr(ir);
  }

  /**
   * LIVE room update for MOVING walls. Drives the AMBIENT room response
   * continuously (not just on clap): rebuilds taps + IR and crossfades to it.
   *
   * Two cost guards make this affordable:
   *  - THROTTLE: rebuild at most every `minIntervalMs` (default ~70 ms ≈ 14 Hz),
   *    NOT every animation frame. Even at the 6× WASM build (~10 ms) a per-frame
   *    rebuild would eat the budget; 14 Hz is smooth to the ear yet cheap.
   *  - DIRTY CHECK: skip entirely when `sig` equals the last signature (nothing
   *    moved materially). `sig` keys on the MOVING walls AND the QUANTISED listener
   *    pose, so walking/turning rebuilds the ambient IR for the new pose; a static
   *    level with a stationary listener never rebuilds here.
   *
   * Returns true if it actually rebuilt (useful for tests/telemetry).
   */
  updateLive(
    walls: WallDef[],
    sig: string,
    listener: [number, number, number],
    yaw: number,
    opts: { edges?: EdgeDef[]; maxOrder?: number; scattering?: number; minIntervalMs?: number; speedOfSound?: number } = {},
  ): boolean {
    const nowMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const minInterval = opts.minIntervalMs ?? 70;
    if (nowMs - this.lastBuildMs < minInterval) return false;
    if (sig === this.lastSig) return false; // nothing moved
    this.lastBuildMs = nowMs;
    this.lastSig = sig;

    const taps = computeRoomTaps({
      walls,
      edges: opts.edges,
      listener,
      source: listener,
      maxOrder: opts.maxOrder ?? 2,
      speedOfSound: opts.speedOfSound,
    });
    const ir = buildRoomIr(taps, this.renderer.set, {
      yaw,
      scattering: opts.scattering ?? 0.1,
      room: wallsRoom(walls, listener),
    });
    this.swapIr(ir);
    return true;
  }

  /**
   * Fire a clap: a shaped excitation through the room IR.
   *
   * PROBE SELECTION: `opts.probe` chooses the excitation, so the player can pick the
   * probe they fire (Settings' probe chooser → this):
   *   - undefined ⇒ the legacy noise-burst clap (byte-UNCHANGED default),
   *   - a synth PROBE NAME string ('clap' | 'click' | 'mouthclick' | …) ⇒ resolved via
   *     resolveProbe() (game/debug share one catalog),
   *   - a pre-decoded AudioBuffer ⇒ played directly (recorded CC click probes; the
   *     caller loads + caches the .ogg since decode is async — see main.ts setupClap).
   */
  /**
   * The near-field HRIR (stereo) for an emit direction, as an AudioBuffer, cached.
   * We reuse the loaded SOFA set: pick the nearest measured direction to (az,el)
   * and use its L/R pair. That carries the correct ITD≈0 / gentle below-elevation
   * pinna cue so the dry probe images at the mouth/hands/foot rather than inside
   * the head. (Measured HRIRs are far-field; at these tiny distances the near-field
   * ILD boost is minor and we accept the far-field pair — the DIRECTION is what
   * localizes it, and that's exactly right here.)
   */
  private selfIr(emit: EmitModel): AudioBuffer | null {
    const ctx = this.graph.ctx;
    // In-head mouth click: a hand-built diotic near-field pair, NOT a measured HRIR
    // (a far-field HRIR would externalize what is produced inside the skull).
    if (emit.model === 'inhead') {
      const key = 'inhead';
      const cached = this.selfIrCache.get(key);
      if (cached) return cached;
      const { left, right } = buildMouthNearField(ctx.sampleRate);
      const buf = ctx.createBuffer(2, left.length, ctx.sampleRate);
      buf.getChannelData(0).set(left);
      buf.getChannelData(1).set(right);
      this.selfIrCache.set(key, buf);
      return buf;
    }
    const key = `${emit.azDeg},${emit.elDeg}`;
    const cached = this.selfIrCache.get(key);
    if (cached) return cached;
    const set = this.renderer.set;
    if (!set || set.count === 0) return null;
    const [x, y, z] = sphericalToVec(emit.azDeg, emit.elDeg);
    const idx = nearestDir(set, x, y, z);
    if (idx < 0) return null;
    const { left, right } = getIrPair(set, idx);
    const buf = ctx.createBuffer(2, set.taps, set.sampleRate);
    buf.getChannelData(0).set(left);
    buf.getChannelData(1).set(right);
    this.selfIrCache.set(key, buf);
    return buf;
  }

  clap(opts: { probe?: string | AudioBuffer } = {}) {
    const ctx = this.graph.ctx;
    let buf: AudioBuffer;
    const probe = opts.probe;
    // Duck-type the buffer (global `AudioBuffer` isn't defined in the node test env,
    // where buffers come from node-web-audio-api's context, so `instanceof` throws).
    if (probe != null && typeof probe !== 'string') {
      buf = probe; // a recorded probe the caller already decoded
    } else if (typeof probe === 'string') {
      // A synth preset (clap/click/hiss/snap/stomp/mouthclick) from the shared catalog.
      const data = resolveProbe(probe)(ctx.sampleRate);
      buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
      buf.getChannelData(0).set(data);
    } else {
      const dur = 0.01;
      const n = Math.ceil(dur * ctx.sampleRate);
      buf = ctx.createBuffer(1, n, ctx.sampleRate);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < n; i++) {
        // Short decaying noise burst — broadband impulse to excite all reflections.
        // Length (~10 ms) is kept deliberately: a real mouth click spans up to ~50 ms,
        // and shortening it thins the excitation. (Probe-masking claim measured + rejected.)
        const env = 1 - i / n;
        ch[i] = (Math.random() * 2 - 1) * env * env;
      }
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;

    // GENTLE HF PRE-EMPHASIS: a modest high-shelf (+6 dB above ~1 kHz) on the clap
    // excitation, so the echo carries more energy where material + pinna cues live
    // (carpet/brick/metal differ mostly above ~1–4 kHz; a flat-white probe under-
    // weights exactly that band). One transient BiquadFilter per clap — cheap — sits
    // between the noise source and the clapBus, leaving the dual-convolver/crossfade
    // path untouched. Tasteful, not harsh (NEEDS the user's ears to fine-tune).
    const shelf = ctx.createBiquadFilter();
    shelf.type = 'highshelf';
    shelf.frequency.value = 1000;
    shelf.gain.value = 6;

    src.connect(shelf);
    shelf.connect(this.clapBus); // feeds both convolver chains (crossfaded)

    // DRY SELF-SOURCE: the same excitation, convolved through the near-field HRIR
    // for this probe's emit direction (mouth/hands/foot), played at t=0. This is
    // the sound of your OWN probe, localized in-front-and-below — the reference the
    // room echoes are heard to displace from. Uses the RAW click (not the HF-shelved
    // one) since that shelf exists to brighten the ECHO, not what leaves your body.
    const selfIr = this.selfIr(emitModelFor(probe));
    if (selfIr) {
      const conv = ctx.createConvolver();
      conv.normalize = false;
      conv.buffer = selfIr;
      src.connect(conv).connect(this.selfDry);
    }

    src.start();
  }
}
