/**
 * Player movement + the Papa Sangre step state machine.
 *
 * You walk by alternating feet: L, R, L, R… Each valid alternating step advances
 * you along your current heading. The rules that give it tension:
 *   - STRICT ALTERNATION: stepping the same foot twice in a row = a stumble.
 *   - RUSH PENALTY: stepping faster than `rushIntervalMs` = a stumble (you trip).
 *   - STRIDE SCALES WITH CADENCE: stepping at a steady, brisk-but-legal rhythm
 *     gives longer strides; dawdling gives short ones. So there's a sweet spot —
 *     rhythmic walking covers ground efficiently, rushing trips you.
 *
 * A stumble briefly freezes stepping and resets the expected foot, so recovery
 * costs a beat. Reaching the goal radius wins.
 *
 * This module is pure logic (no audio/DOM) so it can be unit-tested; the caller
 * wires footstep sounds and goal checks to the returned StepResult.
 */

export type Foot = 'L' | 'R';

export interface PlayerState {
  x: number;
  z: number;
  /** Heading radians; 0 faces -z, +yaw turns right. */
  yaw: number;
}

export interface StepConfig {
  /** Stride at the ideal cadence, metres. */
  baseStride: number;
  /** Shortest stride (very slow stepping), metres. */
  minStride: number;
  /** Longest stride (brisk, near the rush limit), metres. */
  maxStride: number;
  /** Cadence at/under this interval (ms) = rushing = stumble. */
  rushIntervalMs: number;
  /** Cadence at/over this interval (ms) = fully "rested", shortest stride. */
  slowIntervalMs: number;
  /** How long stepping is frozen after a stumble, ms. */
  stumbleFreezeMs: number;
  /**
   * If this long passes with no step, the player is considered to have STOPPED
   * and brought their feet together. The next step may then be either foot (the
   * alternation resets), and the caller is told to play a soft "feet together"
   * cue. Must be ≥ slowIntervalMs so a slow-but-continuous walk isn't treated as
   * a stop.
   */
  settleIntervalMs: number;
}

export const DEFAULT_STEP_CONFIG: StepConfig = {
  baseStride: 0.7,
  minStride: 0.35, // slow stepping is shorter, but not a crawl
  maxStride: 0.9, // brisk legal cadence
  rushIntervalMs: 220, // faster than this between steps → trip
  slowIntervalMs: 900, // slower than this → minimal stride
  stumbleFreezeMs: 600,
  settleIntervalMs: 1400, // idle this long → feet together, either foot resumes
};

export type StepOutcome =
  | { kind: 'step'; foot: Foot; stride: number; settled: boolean }
  | { kind: 'stumble'; reason: 'wrong-foot' | 'too-fast' | 'frozen' };

export interface StepResult {
  outcome: StepOutcome;
  /** Position AFTER applying the outcome (unchanged on stumble). */
  state: PlayerState;
}

export class Player {
  state: PlayerState;
  private cfg: StepConfig;
  private expectedFoot: Foot = 'L'; // first step is the left foot
  private lastStepMs: number | null = null;
  private frozenUntilMs = 0;

  constructor(start: PlayerState, cfg: StepConfig = DEFAULT_STEP_CONFIG) {
    this.state = { ...start };
    this.cfg = cfg;
  }

  setYaw(yaw: number) {
    this.state.yaw = yaw;
  }

  /**
   * Whether, at time `nowMs`, the player has settled (stood still long enough
   * that EITHER foot may lead the next step). Also true before the very first
   * step. The UI uses this to show both feet vs. only the expected one.
   */
  isSettled(nowMs: number): boolean {
    if (this.lastStepMs == null) return true;
    if (nowMs < this.frozenUntilMs) return false; // mid-stumble recovery
    return nowMs - this.lastStepMs >= this.cfg.settleIntervalMs;
  }

  /** Which foot the game expects next (for UI hints / which button glows). */
  get nextFoot(): Foot {
    return this.expectedFoot;
  }

  /**
   * Attempt a step with `foot` at time `nowMs`. Returns the outcome and the
   * resulting position. Pure given (foot, nowMs) and prior internal state.
   */
  step(foot: Foot, nowMs: number): StepResult {
    // Frozen after a recent stumble?
    if (nowMs < this.frozenUntilMs) {
      return { outcome: { kind: 'stumble', reason: 'frozen' }, state: { ...this.state } };
    }

    const interval = this.lastStepMs == null ? Infinity : nowMs - this.lastStepMs;

    // Settled: if we've been standing still long enough, the feet have come
    // together. Either foot may start the next step (alternation resets) and we
    // flag `settled` so the caller plays the soft "feet together" cue.
    const settled = interval >= this.cfg.settleIntervalMs;

    // Wrong foot → stumble (unless settled, where either foot is allowed).
    if (!settled && foot !== this.expectedFoot) {
      this.stumble(nowMs);
      return { outcome: { kind: 'stumble', reason: 'wrong-foot' }, state: { ...this.state } };
    }

    // Too fast since the last step → trip. (Can't happen when settled.)
    if (interval < this.cfg.rushIntervalMs) {
      this.stumble(nowMs);
      return { outcome: { kind: 'stumble', reason: 'too-fast' }, state: { ...this.state } };
    }

    // Valid step. Stride scales with how rhythmic (fast-but-legal) the cadence is.
    const stride = this.strideForInterval(interval);
    const dx = Math.sin(this.state.yaw) * stride; // +yaw turns right; -z is forward
    const dz = -Math.cos(this.state.yaw) * stride;
    this.state.x += dx;
    this.state.z += dz;

    this.expectedFoot = foot === 'L' ? 'R' : 'L';
    this.lastStepMs = nowMs;
    return { outcome: { kind: 'step', foot, stride, settled }, state: { ...this.state } };
  }

  private stumble(nowMs: number) {
    this.frozenUntilMs = nowMs + this.cfg.stumbleFreezeMs;
    this.expectedFoot = 'L'; // recovery restarts on the left foot
    this.lastStepMs = null;
  }

  /**
   * Map inter-step interval → stride. Brisk legal cadence (just above the rush
   * limit) → maxStride; slow (≥ slowInterval) → minStride; linear between, with
   * baseStride as the reference near the middle.
   */
  private strideForInterval(interval: number): number {
    const { rushIntervalMs, slowIntervalMs, minStride, maxStride } = this.cfg;
    if (interval >= slowIntervalMs) return minStride;
    if (interval <= rushIntervalMs) return maxStride;
    // Faster (smaller interval) → longer stride.
    const t = (interval - rushIntervalMs) / (slowIntervalMs - rushIntervalMs); // 0..1
    return maxStride + t * (minStride - maxStride);
  }

  /** Distance to a goal point. */
  distanceTo(gx: number, gz: number): number {
    return Math.hypot(gx - this.state.x, gz - this.state.z);
  }
}
