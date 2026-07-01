/**
 * The DRY SELF-SOURCE: the sound of the probe YOU fire, localized at the spot on
 * your body it comes from (mouth/hands/foot). Played at t=0 alongside — but
 * independent of — the room-IR reflection path, so returning wall echoes are heard
 * as DISPLACED from that reference. That frontal/in-head anchor is what makes the
 * echolocation cue legible; without it the self-sound is a placeless blip the echoes
 * have nothing to sit relative to.
 *
 * Shared by BOTH clap paths so they behave identically:
 *  - the in-game "clap to hear the room" (engine/acoustics/clapRoom.ts), and
 *  - the echolocation TRAINER (debug/scenePlayer.ts) — where a legible self-click
 *    matters even more, since those exercises are pure echolocation.
 *
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
import { getIrPair, nearestDir, sphericalToVec, type HrtfSet } from '../hrtf/sofa';

export type EmitModel =
  | { model: 'inhead' }
  | { model: 'hrir'; azDeg: number; elDeg: number };

const MOUTH_EMIT: EmitModel = { model: 'inhead' };

/** Probe name → emission model. Each probe's natural body origin. */
const EMIT_MODELS: Record<string, EmitModel> = {
  mouthclick: MOUTH_EMIT,
  click: MOUTH_EMIT,
  hiss: MOUTH_EMIT,
  clap: { model: 'hrir', azDeg: 0, elDeg: -35 }, // hands at chest, below + in front
  snap: { model: 'hrir', azDeg: 0, elDeg: -8 }, // fingers up near the head, just in front
  stomp: { model: 'hrir', azDeg: 0, elDeg: -70 }, // foot, well below
};

/** Emission model for a probe (a synth name; recorded/unknown fall back to the mouth). */
export function emitModelFor(probe: string | AudioBuffer | undefined): EmitModel {
  if (typeof probe === 'string' && EMIT_MODELS[probe]) return EMIT_MODELS[probe];
  return MOUTH_EMIT;
}

/**
 * HAND-TUNED near-field pair for the in-head (mouth) click. Change these to taste —
 * this is the "manually modify it" knob for how the tongue click sits in the head.
 *   - `leadMs` : short leading zero-pad (ms, scaled by SR) before the kernel, so it
 *                doesn't sit exactly at buffer[0] (avoids a hard DC edge).
 *   - `hfTilt` : one-pole lowpass coefficient in [0,1). 0 = no coloration (bright,
 *                sits toward the front); higher = duller (more "inside the head" /
 *                bone-conducted). ~0.35 reads as a palatal click without going muddy.
 *   - `earBias`: tiny L/R gain asymmetry (0 = perfectly diotic/centred). Keep ~0;
 *                a hair (e.g. 0.02) can stop it feeling unnaturally point-collapsed.
 *   - `taps`   : kernel length in samples (short — this is a near-impulse, not an IR).
 */
export const MOUTH_NEARFIELD = { leadMs: 0.1, hfTilt: 0.35, earBias: 0.0, taps: 24 };

/**
 * PURE: build the diotic in-head near-field HRIR pair (L, R) for the mouth click.
 * No Web Audio — the caller wraps it in an AudioBuffer. A short one-pole-lowpassed
 * impulse, duplicated to both ears (with an optional hair of L/R bias).
 */
export function buildMouthNearField(sampleRate: number): { left: Float32Array; right: Float32Array } {
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

/**
 * The stereo self-source IR (as raw L/R arrays) for a probe's emit model.
 *  - 'inhead' → the hand-built diotic near-field pair (independent of the SOFA set).
 *  - 'hrir'   → the measured HRIR for the emit direction (nearest SOFA dir), or null
 *               if the set is empty / has no matching direction.
 */
export function selfSourceIr(
  emit: EmitModel,
  set: HrtfSet | null | undefined,
  sampleRate: number,
): { left: Float32Array; right: Float32Array } | null {
  if (emit.model === 'inhead') return buildMouthNearField(sampleRate);
  if (!set || set.count === 0) return null;
  const [x, y, z] = sphericalToVec(emit.azDeg, emit.elDeg);
  const idx = nearestDir(set, x, y, z);
  if (idx < 0) return null;
  const { left, right } = getIrPair(set, idx);
  // Copy out of the SOFA-backed subarrays so the caller owns independent buffers.
  return { left: new Float32Array(left), right: new Float32Array(right) };
}

/**
 * A reusable self-source node: a ConvolverNode carrying the emit-direction IR,
 * fed by the dry probe and mixed to a destination. One instance per clap path;
 * call `setProbe(name)` before each fire so the correct emit model is loaded (the
 * built IR is cached per emit key). Excitation is connected by the caller each fire
 * (a one-shot BufferSource → `input`), mirroring how claps are one-shot.
 */
export class SelfSource {
  /** Connect the dry probe excitation here (before it hits the reflection path). */
  readonly input: GainNode;
  private conv: ConvolverNode;
  private ctx: BaseAudioContext;
  private set: HrtfSet | null;
  private cache = new Map<string, AudioBuffer>();

  constructor(ctx: BaseAudioContext, set: HrtfSet | null, dest: AudioNode, gain = 1) {
    this.ctx = ctx;
    this.set = set;
    this.input = ctx.createGain();
    this.input.gain.value = gain;
    this.conv = ctx.createConvolver();
    this.conv.normalize = false;
    this.input.connect(this.conv).connect(dest);
  }

  /** Load (and cache) the self-source IR for a probe's emit model. No-op if unbuildable. */
  setProbe(probe: string | AudioBuffer | undefined): void {
    const emit = emitModelFor(probe);
    const key = emit.model === 'inhead' ? 'inhead' : `${emit.azDeg},${emit.elDeg}`;
    let buf = this.cache.get(key);
    if (!buf) {
      const ir = selfSourceIr(emit, this.set, this.ctx.sampleRate);
      if (!ir) return; // leave the previous buffer; nothing to load
      buf = this.ctx.createBuffer(2, ir.left.length, this.ctx.sampleRate);
      buf.getChannelData(0).set(ir.left);
      buf.getChannelData(1).set(ir.right);
      this.cache.set(key, buf);
    }
    this.conv.buffer = buf;
  }

  /** Whether an IR is loaded (i.e. wiring the excitation will produce sound). */
  get ready(): boolean {
    return this.conv.buffer != null;
  }
}
