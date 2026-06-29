/**
 * AUDIO-ONLY listener glide.
 *
 * The player's step mechanic is discrete: a footstep moves the LOGICAL player
 * position instantly (see player.ts). That is gameplay-correct, but it makes the
 * audio listener TELEPORT between footfalls — the direction a sound comes from
 * snaps, and listener-motion Doppler (via the delay line) becomes an instant jump
 * instead of a smooth chirp.
 *
 * This module interpolates the POSE USED FOR AUDIO (the HRTF listener + the
 * beacon source) from the old position to the new over a short window, so the
 * direction sweeps naturally and the Doppler is a smooth chirp. It does NOT touch
 * the logical player position — win-check, collision, and the clap all keep using
 * the logical (final/settled) pose. See docs/engine/listener-glide.md.
 *
 * This file is pure (no Web Audio / DOM): the glide drives an injected
 * `setAudioPose` sink, so it is deterministically unit-testable without an
 * AudioContext (mirroring how the rest of the suite avoids Web Audio).
 */

export interface AudioPose {
  x: number;
  z: number;
}

/**
 * Glide duration, ms. Step-paced so a glide feels like the weight of one stride
 * landing. Kept ≤ the rush interval (220 ms, player.ts `rushIntervalMs`) so that
 * back-to-back LEGAL steps don't normally overlap glides; if a new step lands
 * mid-glide anyway, the controller RETARGETS from the current interpolated pose
 * (no snap), so overlap is handled gracefully either way.
 */
export const STEP_GLIDE_MS = 200;

/**
 * easeOutCubic — decelerates into the destination, so the audio pose "settles"
 * onto the foot-plant (weight landing) rather than arriving at constant speed.
 * f(0)=0, f(1)=1, strictly increasing; f(0.5)=0.875 > 0.5 (past the linear
 * midpoint), i.e. it covers most of the distance early then eases in.
 */
export function easeOutCubic(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}

/**
 * Pure pose interpolation. `tNorm` is clamped to [0,1]. tNorm=0 → from, tNorm=1 →
 * to, eased so the result stays on the from→to segment and decelerates into `to`.
 */
export function glidePose(from: AudioPose, to: AudioPose, tNorm: number): AudioPose {
  const t = tNorm <= 0 ? 0 : tNorm >= 1 ? 1 : tNorm;
  const e = easeOutCubic(t);
  return {
    x: from.x + (to.x - from.x) * e,
    z: from.z + (to.z - from.z) * e,
  };
}

/**
 * Drives an audio-pose glide over time. Time is supplied by the caller (the rAF
 * loop) via `tick(nowMs)`; the controller has no clock of its own, so it is fully
 * deterministic and testable.
 *
 * - `start(from, to, nowMs)` begins (or RETARGETS) a glide. When idle, `from` is
 *   the previous destination; mid-glide, the caller passes the CURRENT
 *   interpolated pose as `from` so a retarget never snaps back to the old start.
 * - `tick(nowMs)` advances an active glide and emits the new pose via the sink.
 *   It is a NO-OP when idle (no glide active) so it never thrashes AudioParams.
 * - `current` is the last-emitted audio pose (the retarget anchor).
 *
 * Idle ticks allocate nothing (early return). While a glide is ACTIVE each tick
 * allocates one transient pose from `glidePose` (copied into the reused `cur` and
 * handed to the sink, which consumes x/z immediately); negligible, and only for
 * the ~200 ms a glide runs.
 */
export class ListenerGlide {
  private from: AudioPose;
  private to: AudioPose;
  private startMs = 0;
  private active = false;
  private cur: AudioPose;
  private readonly durationMs: number;
  private readonly sink: (pose: AudioPose) => void;

  constructor(
    initial: AudioPose,
    sink: (pose: AudioPose) => void,
    durationMs: number = STEP_GLIDE_MS,
  ) {
    this.from = { x: initial.x, z: initial.z };
    this.to = { x: initial.x, z: initial.z };
    this.cur = { x: initial.x, z: initial.z };
    this.durationMs = durationMs;
    this.sink = sink;
  }

  /** Last-emitted audio pose (where a retarget should glide FROM). */
  get current(): AudioPose {
    return { x: this.cur.x, z: this.cur.z };
  }

  /** Is a glide currently running (so the tick has work to do)? */
  get isActive(): boolean {
    return this.active;
  }

  /**
   * Begin a glide from `from` to `to` at `nowMs`. If a glide is already running,
   * this retargets it: pass the CURRENT interpolated pose as `from` to avoid a
   * snap. A zero-length glide (from == to) is collapsed to an immediate emit.
   */
  start(from: AudioPose, to: AudioPose, nowMs: number) {
    this.from = { x: from.x, z: from.z };
    this.to = { x: to.x, z: to.z };
    this.startMs = nowMs;
    if (this.durationMs <= 0 || (from.x === to.x && from.z === to.z)) {
      this.active = false;
      this.emit(to);
      return;
    }
    this.active = true;
  }

  /**
   * Advance the active glide to `nowMs`, emitting the interpolated pose. No-op
   * when idle. Once `nowMs` reaches the end of the window it emits the exact
   * destination once and goes idle (holding there).
   */
  tick(nowMs: number) {
    if (!this.active) return;
    const tNorm = (nowMs - this.startMs) / this.durationMs;
    if (tNorm >= 1) {
      this.active = false;
      this.emit(this.to);
      return;
    }
    this.emit(glidePose(this.from, this.to, tNorm));
  }

  /** Snap the audio pose immediately to `pose` (no glide); cancels any glide. */
  snap(pose: AudioPose) {
    this.active = false;
    this.from = { x: pose.x, z: pose.z };
    this.to = { x: pose.x, z: pose.z };
    this.emit(pose);
  }

  private emit(pose: AudioPose) {
    this.cur.x = pose.x;
    this.cur.z = pose.z;
    this.sink(this.cur);
  }
}
