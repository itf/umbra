/**
 * A CONTINUOUS positioned source rendered through the room PHYSICS — not a
 * straight-line `HrtfSource`. Where `HrtfSource` places a sound on a direct line
 * to the listener (ignoring walls), `ModeledSource` solves the room's image-source
 * + diffraction taps every refresh and convolves the dry voice through the resulting
 * stereo IR. This gives, for free from the existing solver:
 *
 *  - OCCLUSION: the order-0 DIRECT tap is emitted by the WASM core ONLY when the
 *    source is visible (geometry.rs `if self.visible(...)`). Step behind a wall and
 *    the direct tap drops automatically — you hear only the indirect field.
 *  - DIFFRACTION: edge taps (order≥1) let the sound "leak" through openings, so a
 *    beacon behind a wall is still audible, but muffled and arriving from the gap.
 *  - MATERIAL COLORING: each tap's per-band gains already encode wall absorption
 *    (brick vs concrete), so the indirect beacon is colored correctly.
 *  - DOPPLER / PROPAGATION: `buildRoomIr` places each tap at delay = path/c, so a
 *    MOVING source Dopplers as those per-tap delays change between rebuilds and the
 *    dual-convolver crossfade ramps across — no separate DelayNode needed.
 *
 * It mirrors ClapRoom's proven dual-convolver crossfade (`swapIr`), but
 * is fed by a continuous dry input (`input`) rather than a one-shot clap. Refreshes
 * are throttled (~14 Hz) with a quantized-pose dirty check so it stays cheap.
 */
import { computeRoomTaps, DEFAULT_SPEED_OF_SOUND, type WallDef, type EdgeDef, type Tap } from './core';
import { buildRoomIr } from './roomIr';
import type { HrtfSet } from '../hrtf/sofa';
import { linearCrossfade } from '../crossfade';
import { HrtfRenderer, type HrtfSource } from '../hrtf/renderer';
import type { InterpolatingHrtfRenderer, InterpolatingHrtfSource } from '../hrtf/interpolatingRenderer';

/**
 * Number of strong reflection taps rendered as INDIVIDUAL click-free interpolating
 * sources (the rest fall into the diffuse convolver tail). Each interpolating source
 * is ~9% realtime, so N=6 is ~55% — the CPU ceiling chosen by the brief. The N
 * loudest reflections carry the directional cue; the dense weak tail is handled by
 * the existing convolver (updated rarely/yaw-independently so it never clicks).
 */
const N_REFLECT_SOURCES = 6;

/**
 * Compute reflection IMAGE-SOURCE world positions + gains for the strongest N
 * reflection taps. PURE (no Web Audio): used by the renderer AND unit-tested offline.
 *
 * Each tap carries { delay (s), gain (broadband 1/r), dir (unit listener→image-source,
 * WORLD space) }. The image source sits at distance delay*c along dir from the
 * listener, so position = listener + dir * (delay * c). Feeding that world position to
 * an InterpolatingHrtfSource reproduces BOTH the propagation delay (dist/c == tap
 * delay) and the head-tracked, continuously-interpolated HRTF direction → the
 * reflection rotates with the head and never swaps a convolver (click-free).
 *
 * Returns exactly N entries (sorted loudest-first); slots beyond the available taps
 * are marked inactive (gain 0) so the caller can ramp pooled sources to silence.
 */
export interface ReflectImage {
  active: boolean;
  pos: [number, number, number];
  gain: number;
}
export function computeReflectImages(
  reflectTaps: Tap[],
  listener: [number, number, number],
  speedOfSound: number,
  n = N_REFLECT_SOURCES,
): ReflectImage[] {
  const c = speedOfSound > 1 && Number.isFinite(speedOfSound) ? speedOfSound : DEFAULT_SPEED_OF_SOUND;
  const sorted = reflectTaps.slice().sort((a, b) => b.gain - a.gain);
  const out: ReflectImage[] = [];
  for (let i = 0; i < n; i++) {
    const t = sorted[i];
    if (!t) {
      out.push({ active: false, pos: [listener[0], listener[1], listener[2]], gain: 0 });
      continue;
    }
    const dist = t.delay * c;
    out.push({
      active: true,
      pos: [listener[0] + t.dir[0] * dist, listener[1] + t.dir[1] * dist, listener[2] + t.dir[2] * dist],
      gain: t.gain,
    });
  }
  return out;
}

/**
 * STABLE slot assignment so a pooled reflection source never TELEPORTS its HRTF
 * direction while audible (the residual click). Given the current per-slot state
 * (`prev` — the image each slot currently HOLDS, or inactive) and the freshly-solved
 * set of strong reflections (`incoming`, in no particular slot order), produce a new
 * per-slot assignment where:
 *
 *  - Each incoming reflection is greedily matched to the EXISTING active slot whose
 *    held image is CLOSEST (so that slot's source moves a small distance, not a jump).
 *  - Unmatched incoming reflections take FREED (inactive) slots and fade IN from 0.
 *  - Slots whose held reflection departed go inactive → caller fades them to 0 and
 *    must NOT reposition them until silent (so no audible teleport).
 *
 * Greedy nearest-match over N≈6 is O(N²) and trivially cheap. PURE — unit-tested.
 *
 * Returns one entry per slot: the assigned image (active) or an inactive marker. The
 * `keepPos` flag tells the caller to LEAVE the source where it is (departing slot,
 * fading out) so it doesn't teleport while still audible.
 */
export interface SlotAssign {
  active: boolean;
  /** When active: the image this slot should render. */
  image: ReflectImage | null;
  /** When inactive: true ⇒ leave the source's last position untouched (fade out in place). */
  keepPos: boolean;
}
/**
 * Max distance (metres) between a previous slot image and an incoming reflection for
 * them to be treated as the SAME (continuing) reflection in pass 1. Beyond this, the
 * incoming reflection is a NEW identity that must fade in on a free/silent slot rather
 * than reuse (and teleport) an audible slot. Generous enough to absorb the small
 * image-source motion between 70 ms solves while turning, tight enough that an
 * unrelated reflection on the opposite wall isn't mistaken for a continuation.
 */
const REFLECT_MATCH_RADIUS = 2.0;

export function assignReflectSlots(prev: ReflectImage[], incoming: ReflectImage[]): SlotAssign[] {
  const nSlots = prev.length;
  const result: SlotAssign[] = prev.map(() => ({ active: false, image: null, keepPos: true }));
  const slotTaken = new Array<boolean>(nSlots).fill(false);
  const active = incoming.filter((im) => im.active);
  const placed = new Array<boolean>(active.length).fill(false);

  const dist2 = (a: [number, number, number], b: [number, number, number]) =>
    (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

  // Pass 1: match each incoming to its NEAREST currently-active slot (greedy by
  // ascending pair distance) so continuing reflections keep their slot and move only a
  // little. Build all (incoming, activeSlot) pairs, sort, take non-conflicting.
  const matchR2 = REFLECT_MATCH_RADIUS * REFLECT_MATCH_RADIUS;
  const pairs: Array<{ inc: number; slot: number; d: number }> = [];
  for (let a = 0; a < active.length; a++) {
    for (let s = 0; s < nSlots; s++) {
      if (!prev[s].active) continue;
      const d = dist2(active[a].pos, prev[s].pos);
      if (d > matchR2) continue; // too far → a NEW identity, not a continuation
      pairs.push({ inc: a, slot: s, d });
    }
  }
  pairs.sort((p, q) => p.d - q.d);
  for (const { inc, slot } of pairs) {
    if (placed[inc] || slotTaken[slot]) continue;
    placed[inc] = true;
    slotTaken[slot] = true;
    result[slot] = { active: true, image: active[inc], keepPos: false };
  }

  // Pass 2: unmatched incoming reflections (new identities) take any FREE slot and
  // fade in from 0. Prefer previously-inactive slots; reuse freed (departed) slots only
  // after — they were repositioned-safe because their gain already fell to 0.
  for (let a = 0; a < active.length; a++) {
    if (placed[a]) continue;
    let target = -1;
    for (let s = 0; s < nSlots; s++) { if (!slotTaken[s] && !prev[s].active) { target = s; break; } }
    if (target < 0) for (let s = 0; s < nSlots; s++) { if (!slotTaken[s]) { target = s; break; } }
    if (target < 0) break; // no free slot (more reflections than slots — shouldn't happen)
    slotTaken[target] = true;
    placed[a] = true;
    result[target] = { active: true, image: active[a], keepPos: false };
  }

  // Remaining untaken slots: inactive. If the slot WAS active (its reflection departed)
  // keep its position (fade out in place, no teleport); if it was already inactive,
  // there's nothing audible so position is irrelevant (keepPos stays true → untouched).
  return result;
}

/**
 * Quantisation steps for the dirty check (mirrors `load.ts`'s POSE_*_QUANTUM, kept
 * local so this engine module has no dependency on the level layer): sub-perceptual
 * pose jitter below these never forces a rebuild.
 */
const POSE_POS_QUANTUM = 0.05; // 5 cm
const POSE_YAW_QUANTUM = (2.5 * Math.PI) / 180; // ~2.5°

/**
 * Yaw quantum for the REFLECTIONS dirty check. Reflections rotate with the head but
 * we don't need to rebuild on every sub-degree turn — the field is diffuse. ~10°
 * keeps directional rotation perceptible while bounding the swap rate (and thus the
 * already-gentle reflections-only crossfade's frequency). The smooth direct path
 * carries the continuous, fine-grained localization; this only steers the ambience.
 */
const REFLECT_YAW_QUANTUM = (10 * Math.PI) / 180; // ~10°

/** One room-IR convolver chain + its crossfade gain. */
interface ModeledChain {
  convolver: ConvolverNode;
  gain: GainNode;
}

export interface ModeledRefreshOpts {
  walls: WallDef[];
  edges?: EdgeDef[];
  /** Listener (head) world position. */
  listener: [number, number, number];
  /** Listener heading (radians) so tap world-directions become head-relative. */
  yaw: number;
  /** Source (beacon) world position. */
  source: [number, number, number];
  speedOfSound?: number;
  /**
   * Image-source order. Phase 1 keeps this LOW (1) so we get the direct tap +
   * first-order edge diffraction without paying for the combinatorial reflection
   * search — Phase 2 raises it for full reflections.
   */
  maxOrder?: number;
  /** Representative scattering coefficient for the room's surfaces. */
  scattering?: number;
  /** Minimum ms between rebuilds (throttle). Default ~70 ms (~14 Hz). */
  minIntervalMs?: number;
  /**
   * SAFETY GUARD for high `maxOrder`. Energy pruning makes high order cheap on
   * absorbent rooms, but a large LOW-absorption enclosure (cathedral-class marble)
   * keeps every high-order chain audible, so its order-3 tap count — and thus the
   * IR-build cost — can still explode. When a solve at `maxOrder` returns more than
   * this many taps, we re-solve one order lower (repeating down to order 1) so the
   * per-source IR-build stays within the refresh throttle. The solve is ~0.1 ms, so
   * a fallback re-solve is effectively free. Default 24 (≈ the point where IR-build
   * crosses ~10 ms on a long-IR room). Set to 0 to disable.
   */
  orderTapCap?: number;
}

/**
 * Compute the dirty-check signature for a refresh: the QUANTIZED listener pose +
 * source position + a coarse hash of the (possibly moving) wall/edge geometry. If
 * it matches the previous signature, nothing moved materially and the rebuild is
 * skipped. Quantization (5 cm / ~2.5°) keeps sub-perceptual jitter from thrashing
 * rebuilds. PURE — unit-tested without Web Audio.
 */
export function modeledRefreshSignature(opts: ModeledRefreshOpts): string {
  const qpos = (n: number) => Math.round(n / POSE_POS_QUANTUM);
  const qyaw = Math.round(opts.yaw / POSE_YAW_QUANTUM);
  const l = opts.listener;
  const s = opts.source;
  // Geometry hash: quantize every wall/edge vertex to ~1 mm and join. Static
  // geometry yields a constant string ⇒ only pose/source changes trigger rebuilds.
  const q = (n: number) => Math.round(n * 1000);
  const geo: string[] = [];
  for (const w of opts.walls) {
    for (const v of w.verts) geo.push(`${q(v[0])},${q(v[1])},${q(v[2])}`);
  }
  for (const e of opts.edges ?? []) {
    geo.push(`${q(e[0][0])},${q(e[0][2])};${q(e[1][0])},${q(e[1][2])}`);
  }
  return (
    `${qpos(l[0])},${qpos(l[1])},${qpos(l[2])},${qyaw}` +
    `#${qpos(s[0])},${qpos(s[1])},${qpos(s[2])}` +
    `#${geo.join('|')}`
  );
}

/**
 * Compute the dirty-check signature for the REFLECTIONS rebuild. Includes yaw
 * (quantized at `REFLECT_YAW_QUANTUM`) so the reflected field ROTATES with the head
 * — a reflection off the right-hand wall must stay on your right as you turn. The
 * rebuild swaps the reflections-only IR through the dual-convolver linear crossfade;
 * because the loud DIRECT dirac is split out to its own smooth HrtfSource, the
 * crossfade now acts only on the DIFFUSE/dense reflection field, where it's gentle
 * (no clean comb null → no "silence + restart"). The yaw quantum trades a small
 * directional step for a much lower swap rate. PURE.
 */
export function modeledReflectSignature(opts: ModeledRefreshOpts): string {
  const qpos = (n: number) => Math.round(n / POSE_POS_QUANTUM);
  const qyaw = Math.round(opts.yaw / REFLECT_YAW_QUANTUM);
  const l = opts.listener;
  const s = opts.source;
  const q = (n: number) => Math.round(n * 1000);
  const geo: string[] = [];
  for (const w of opts.walls) {
    for (const v of w.verts) geo.push(`${q(v[0])},${q(v[1])},${q(v[2])}`);
  }
  for (const e of opts.edges ?? []) {
    geo.push(`${q(e[0][0])},${q(e[0][2])};${q(e[1][0])},${q(e[1][2])}`);
  }
  return (
    `${qpos(l[0])},${qpos(l[1])},${qpos(l[2])},${qyaw}` +
    `#${qpos(s[0])},${qpos(s[1])},${qpos(s[2])}` +
    `#${geo.join('|')}`
  );
}

export class ModeledSource {
  /** Connect the dry source voice (synth/custom loop) here. */
  readonly input: GainNode;
  /** Connect to the master bus. */
  readonly output: GainNode;

  private ctx: AudioContext;
  private hrtf: HrtfSet;
  /**
   * REFLECTIONS-ONLY dual convolvers, linearly crossfaded (crossfade.ts). The
   * DIRECT path is NOT here — it's rendered through `directSource` (a smooth
   * HrtfSource). These convolvers carry only the diffuse, head-angle-insensitive
   * reflections, so the whole-IR swap that used to comb/warble the whole beacon now
   * only swaps the quiet reflection field, and at a much lower rate.
   */
  private chains: [ModeledChain, ModeledChain];
  private active = 0;

  /**
   * The DIRECT path. A smooth HrtfSource (DelayNode + continuously-ramped gains +
   * rate-limited short HRIR crossfade) renders the order-0 tap — the loud thing you
   * localize — with only ~5-7% modulation on rotation, vs the ~80% from swapping the
   * whole room IR. This is the core of the warble fix.
   */
  private directRenderer: HrtfRenderer;
  private directSource: HrtfSource;
  /** Extra gain applied to the direct path so occlusion (attenuated/absent order-0
   *  tap) is mirrored: 0 when fully occluded, ramped to avoid clicks. */
  private directGain: GainNode;

  /**
   * CLICK-FREE reflection path (active when an InterpolatingHrtfRenderer is supplied,
   * i.e. ?hrtf=interp). Each of N pooled InterpolatingHrtfSources renders ONE strong
   * reflection: fed the same dry `input`, positioned at the reflection's image-source
   * world location, with a per-reflection gain. The worklet interpolates the HRTF
   * continuously and never swaps a convolver, so reflections rotate with the head
   * click-free — exactly how the direct path was fixed, applied per-reflection. When
   * present, this REPLACES the convolver `chains` swap (which is the reset-click we're
   * removing); the convolvers stay allocated but silent as the fallback.
   */
  private interp: InterpolatingHrtfRenderer | null = null;
  private reflectSources: InterpolatingHrtfSource[] = [];
  private reflectGains: GainNode[] = [];
  /** Last-solved image-source world positions per pooled source (re-applied every
   *  refresh so the HRTF direction tracks the live yaw between throttled solves). */
  private reflectImages: ReflectImage[] = [];

  // --- throttle + dirty-check state ---
  private lastBuildMs = 0;
  private lastReflectSig = '';
  private lastFadeT = 0;

  constructor(ctx: AudioContext, master: AudioNode, hrtf: HrtfSet, interp: InterpolatingHrtfRenderer | null = null) {
    this.ctx = ctx;
    this.hrtf = hrtf;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    // HEADROOM: the convolved beacon already peaks near full-scale when facing it,
    // leaving no room for crossfade/sum transients. Trim ~3 dB so the worst case
    // stays under full-scale and the safety clip never engages here.
    this.output.gain.value = 0.7;
    this.output.connect(master);

    // DIRECT path: own HrtfRenderer fed the same dry input, summed into output via
    // a directGain (used to mirror occlusion). HrtfSource owns its propagation
    // delay / Doppler + continuous HRTF direction — no whole-IR swap.
    this.directRenderer = HrtfRenderer.fromSet(ctx, hrtf);
    this.directSource = this.directRenderer.createSource();
    this.directGain = ctx.createGain();
    this.directGain.gain.value = 0;
    this.input.connect(this.directSource.input);
    this.directSource.output.connect(this.directGain).connect(this.output);

    const makeChain = (): ModeledChain => {
      const convolver = ctx.createConvolver();
      convolver.normalize = false;
      const gain = ctx.createGain();
      this.input.connect(convolver);
      convolver.connect(gain).connect(this.output);
      return { convolver, gain };
    };
    this.chains = [makeChain(), makeChain()];
    this.chains[0].gain.gain.value = 1;
    this.chains[1].gain.gain.value = 0;

    // CLICK-FREE reflection pool. ONE shared InterpolatingHrtfRenderer for the whole
    // ModeledSource (don't spin up many worklets); N pooled sources reused across
    // refreshes (never created/destroyed per refresh). Each: input → source → gain →
    // output. Gains start at 0 and ramp up as reflections appear.
    this.interp = interp;
    if (interp) {
      for (let i = 0; i < N_REFLECT_SOURCES; i++) {
        const src = interp.createSource();
        const g = ctx.createGain();
        g.gain.value = 0;
        this.input.connect(src.input);
        src.output.connect(g).connect(this.output);
        this.reflectSources.push(src);
        this.reflectGains.push(g);
        this.reflectImages.push({ active: false, pos: [0, 0, 0], gain: 0 });
      }
    }
  }

  /**
   * Re-solve the room for the current listener/source and update both paths.
   * Throttled. The DIRECT path is updated EVERY accepted refresh (it's smooth and
   * cheap), so head-shadow loudness + Doppler track continuously. The REFLECTIONS IR
   * is rebuilt only when its COARSE-yaw signature changes, so a head wiggle rarely
   * swaps it. Returns true iff anything was updated.
   */
  refresh(opts: ModeledRefreshOpts): boolean {
    // --- DIRECT path (order 0): drive the smooth HrtfSource EVERY CALL (NOT throttled).
    // CRITICAL: the direct path is the loud thing you localize, and HrtfSource only
    // renders smoothly if it's fed CONTINUOUS per-frame pose updates (like the plain
    // beacon, which is glide-driven every ~16ms). If we updated it only on the room
    // solve's 70ms / 2.5° throttle, its HRIR direction would step coarsely and its
    // internal crossfade would fire on those big infrequent steps — the audible
    // "radio failing" stutter. The HrtfSource pose update is cheap (no room solve), so
    // run it every refresh; only the expensive solve + reflection swap is throttled.
    if (opts.speedOfSound) this.directRenderer.setSpeedOfSound(opts.speedOfSound);
    this.directRenderer.setListener({
      x: opts.listener[0], y: opts.listener[1], z: opts.listener[2], yaw: opts.yaw,
    });
    this.directSource.setPosition(opts.source[0], opts.source[1], opts.source[2]);

    // CLICK-FREE reflections: re-apply each pooled source's last-solved image-source
    // WORLD position EVERY call (NOT throttled). setPosition recomputes the
    // head-relative HRTF direction against the live listener yaw, so reflections
    // rotate smoothly with the head between the throttled solves — same reasoning as
    // the direct path. The world positions themselves only change on the solve below.
    if (this.interp) {
      if (opts.speedOfSound) this.interp.setSpeedOfSound(opts.speedOfSound);
      for (let i = 0; i < this.reflectSources.length; i++) {
        const img = this.reflectImages[i];
        if (img.active) this.reflectSources[i].setPosition(img.pos[0], img.pos[1], img.pos[2]);
      }
    }

    const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const minInterval = opts.minIntervalMs ?? 70;
    if (nowMs - this.lastBuildMs < minInterval) return true; // direct updated; skip the throttled solve
    this.lastBuildMs = nowMs;

    const solveAt = (order: number) =>
      computeRoomTaps({
        walls: opts.walls,
        edges: opts.edges,
        listener: opts.listener,
        source: opts.source,
        maxOrder: order,
        speedOfSound: opts.speedOfSound,
      });
    let order = opts.maxOrder ?? 1;
    let taps = solveAt(order);
    // Tap-count safety guard: drop a level at a time until under the cap (or order 1).
    const cap = opts.orderTapCap ?? 24;
    while (cap > 0 && taps.length > cap && order > 1) {
      order -= 1;
      taps = solveAt(order);
    }

    // Mirror occlusion onto directGain: 1 when a direct (order-0) tap exists, 0 when
    // fully occluded. HrtfSource keeps its own 1/r distance law; this only gates
    // presence. Ramped to avoid clicks. (Computed on the throttled solve — occlusion
    // changes slowly enough; the smooth per-frame direction update above is what
    // matters for the stutter.)
    let directGainSum = 0;
    for (const t of taps) if (t.order === 0) directGainSum += t.gain;
    const targetDirect = directGainSum > 0 ? 1 : 0;
    this.directGain.gain.setTargetAtTime(targetDirect, this.ctx.currentTime, 0.03);

    // --- REFLECTIONS path (order >= 1): convolver IR that ROTATES with the head. ---
    // The reflected field must stay world-anchored: a reflection off the right wall
    // stays on your right as you turn. So the reflection IR IS rebuilt on yaw (coarse
    // ~10° quantum) and swapped through the dual-convolver linear crossfade. This is
    // safe now ONLY because the loud DIRECT dirac is split out to its own smooth
    // HrtfSource above — the crossfade acts on the DIFFUSE reflection field alone,
    // where dense overlapping taps don't produce the clean comb null that the direct
    // dirac did (the old whole-IR crossfade's "sudden silence + restart"). Measured:
    // reflections-only crossfade fast-ripple ~0.6 with 0% dropout, vs the whole-IR
    // null; combined with the always-on direct path the audible ripple is far lower.
    const reflectTaps = taps.filter((t: Tap) => t.order >= 1);

    // CLICK-FREE reflection path (?hrtf=interp): map the strongest N reflections onto
    // the pooled interpolating sources. This runs on EVERY accepted solve (no coarse
    // yaw quantum needed — the per-frame setPosition above carries the rotation; the
    // solve only refreshes the image-source SET as geometry/occlusion changes). Gains
    // are RAMPED (never hard-cut) so taps entering/leaving the strong set don't step.
    if (this.interp) {
      const images = computeReflectImages(
        reflectTaps, opts.listener, opts.speedOfSound ?? DEFAULT_SPEED_OF_SOUND, this.reflectSources.length,
      );
      // STABLE slot assignment: match each new reflection to the slot holding the
      // NEAREST previous reflection, so a continuing source moves a small distance
      // instead of teleporting to an unrelated reflection (the residual click). New
      // reflections fade IN from 0 on freed slots; departed slots fade OUT in place
      // (keepPos) and are NOT repositioned while still audible.
      const assign = assignReflectSlots(this.reflectImages, images);
      const t = this.ctx.currentTime;
      for (let i = 0; i < this.reflectSources.length; i++) {
        const a = assign[i];
        if (a.active && a.image) {
          // place immediately so the per-frame update has a valid target this frame.
          // Because this slot held the nearest previous reflection, the position step
          // is small → the worklet interpolates smoothly (no audible jump).
          this.reflectSources[i].setPosition(a.image.pos[0], a.image.pos[1], a.image.pos[2]);
          this.reflectImages[i] = a.image;
          this.reflectGains[i].gain.setTargetAtTime(a.image.gain, t, 0.03);
        } else {
          // Departing/empty slot: fade to 0 but DON'T move the source while audible
          // (keepPos) — the next time it's reused it will already be silent, so the
          // reposition-into-a-new-reflection happens inaudibly. Mark held image
          // inactive so it isn't matched next solve, but keep its last position for
          // the per-frame setPosition until the fade completes.
          this.reflectImages[i] = { ...this.reflectImages[i], active: false, gain: 0 };
          this.reflectGains[i].gain.setTargetAtTime(0, t, 0.03);
        }
      }
      return true; // interpolating reflections handle the field; skip the convolver swap
    }

    const reflectSig = modeledReflectSignature(opts);
    if (reflectSig === this.lastReflectSig) return true; // pose unchanged ⇒ no swap
    this.lastReflectSig = reflectSig;

    if (reflectTaps.length === 0) {
      // No reflections (e.g. open field): leave the convolver path silent. All sound
      // comes from the direct HrtfSource. Don't swap an empty IR.
      return true;
    }
    const ir = buildRoomIr(reflectTaps, this.hrtf, {
      yaw: opts.yaw, // reflections rotate with the head (world-anchored field)
      scattering: opts.scattering ?? 0.1,
      // A continuous source doesn't want the room's FDN reverb tail baked into its
      // OWN per-source IR (the clap owns the room's reverb); keep it to the early
      // field — direct + diffraction + any reflections — so the dry voice stays
      // crisp and localizable.
      //
      // LISTENER-LOCAL RT60: because the beacon emits NO FDN tail (`tail: false`),
      // there is no decay to localise here — the listener-local absorption work lives
      // entirely on the clap/ambient path (clapRoom `wallsRoom(walls, listener)`),
      // which owns the room's reverberant field. If the beacon ever grows its own
      // tail, pass `room: wallsRoom(opts.walls, opts.listener)` so it's local too.
      tail: false,
    });
    this.swapIr(ir);
    return true;
  }

  /** Load a freshly-built REFLECTIONS-ONLY stereo IR into the idle chain and
   *  crossfade to it. The first ever IR loads straight into the active chain (no
   *  audible swap). Residual comb from this crossfade is now inaudible: it acts only
   *  on the quiet, diffuse reflection field (the loud direct path bypasses it), and
   *  it fires at a much lower rate (coarse-yaw dirty check). */
  private swapIr(ir: { left: Float32Array; right: Float32Array; length: number; sampleRate: number }) {
    const ctx = this.ctx;
    const buf = ctx.createBuffer(2, ir.length, ir.sampleRate);
    buf.getChannelData(0).set(ir.left);
    buf.getChannelData(1).set(ir.right);

    if (this.chains[this.active].convolver.buffer == null) {
      this.chains[this.active].convolver.buffer = buf;
      return;
    }
    const t = ctx.currentTime;
    const FADE = 0.08; // 80 ms crossfade
    const idle = this.active ^ 1;
    // Rate-limit: if still mid-fade, DON'T touch the chains. Swapping the audible
    // chain's convolver buffer mid-fade resets the convolver (a click), and starting
    // overlapping fades lets the two chains sum ABOVE full-scale during a fast spin
    // (the audible "farting"/clipping). Drop this IR; the next refresh after the fade
    // settles picks up the latest pose.
    if (t - this.lastFadeT < FADE) return;
    this.chains[idle].convolver.buffer = buf;
    // LINEAR sum-to-1 crossfade. Across adjacent listener poses these two room IRs
    // share the same source and are dominated by the (correlated) direct + early
    // path — and `tail:false` strips the decorrelated late reverb — so their outputs
    // add as AMPLITUDE. A linear pair (g_in + g_out = 1 at every instant) keeps the
    // level flat; equal-power (sin/cos) would peak at √2 (+3 dB) → the very overshoot
    // we're removing. The old setTargetAtTime exponentials never summed to 1 mid-fade
    // (worse on back-to-back swaps), which was the clipping heard when turning.
    linearCrossfade(this.chains[idle].gain.gain, this.chains[this.active].gain.gain, t, FADE);
    this.active = idle;
    this.lastFadeT = t;
  }

  disconnect() {
    this.directSource.disconnect();
    for (const s of this.reflectSources) s.disconnect();
    this.output.disconnect();
  }
}
