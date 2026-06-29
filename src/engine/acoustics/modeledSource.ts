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
 * It mirrors ClapRoom's proven dual-convolver equal-power crossfade (`swapIr`), but
 * is fed by a continuous dry input (`input`) rather than a one-shot clap. Refreshes
 * are throttled (~14 Hz) with a quantized-pose dirty check so it stays cheap.
 */
import { computeRoomTaps, type WallDef, type EdgeDef } from './core';
import { buildRoomIr } from './roomIr';
import type { HrtfSet } from '../hrtf/sofa';

/**
 * Quantisation steps for the dirty check (mirrors `load.ts`'s POSE_*_QUANTUM, kept
 * local so this engine module has no dependency on the level layer): sub-perceptual
 * pose jitter below these never forces a rebuild.
 */
const POSE_POS_QUANTUM = 0.05; // 5 cm
const POSE_YAW_QUANTUM = (2.5 * Math.PI) / 180; // ~2.5°

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

export class ModeledSource {
  /** Connect the dry source voice (synth/custom loop) here. */
  readonly input: GainNode;
  /** Connect to the master bus. */
  readonly output: GainNode;

  private ctx: AudioContext;
  private hrtf: HrtfSet;
  /**
   * DUAL convolvers, equal-power crossfaded — copied from ClapRoom/renderer. Swapping
   * a single ConvolverNode's buffer mid-signal CLICKS; loading each new IR into the
   * idle chain and ramping across is click-free.
   */
  private chains: [ModeledChain, ModeledChain];
  private active = 0;

  // --- throttle + dirty-check state ---
  private lastBuildMs = 0;
  private lastSig = '';
  private lastFadeT = 0;

  constructor(ctx: AudioContext, master: AudioNode, hrtf: HrtfSet) {
    this.ctx = ctx;
    this.hrtf = hrtf;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.output.connect(master);

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
  }

  /**
   * Re-solve the room for the current listener/source and crossfade to the new IR.
   * Throttled + dirty-checked: returns true iff it actually rebuilt. Cheap to call
   * every frame.
   */
  refresh(opts: ModeledRefreshOpts): boolean {
    const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const minInterval = opts.minIntervalMs ?? 70;
    if (nowMs - this.lastBuildMs < minInterval) return false;
    const sig = modeledRefreshSignature(opts);
    if (sig === this.lastSig) return false; // nothing moved materially
    this.lastBuildMs = nowMs;
    this.lastSig = sig;

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
    const ir = buildRoomIr(taps, this.hrtf, {
      yaw: opts.yaw,
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

  /** Load a freshly-built stereo IR into the idle chain and crossfade to it. The
   *  first ever IR loads straight into the active chain (no audible swap). */
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

  disconnect() {
    this.output.disconnect();
  }
}
