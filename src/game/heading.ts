/**
 * Rate-limited heading. Turn controls set a TARGET yaw; the actual yaw slews
 * toward it at a capped angular velocity. This:
 *   - makes turning physically plausible (you can't snap your head instantly),
 *   - bounds how fast the HRTF direction changes, so the binaural rendering stays
 *     smooth no matter how violently the user drags (kills the fast-spin artifact).
 *
 * Call `setTarget()` from the turn controls and `tick(dtSeconds)` each frame; read
 * `current` for the value to drive the listener with.
 */
export class Heading {
  private target = 0;
  private value = 0;
  /** Max turn speed in radians/second. ~100°/s — a deliberate head-turn. */
  maxRate: number;

  constructor(initial = 0, maxRateRadPerSec = (100 * Math.PI) / 180) {
    this.target = initial;
    this.value = initial;
    this.maxRate = maxRateRadPerSec;
  }

  /** The slewed heading to render with. */
  get current(): number {
    return this.value;
  }

  /** Where the user is asking to face. */
  get desired(): number {
    return this.target;
  }

  setTarget(yaw: number) {
    this.target = yaw;
  }

  /** Snap instantly (e.g. on level start) with no slew. */
  reset(yaw: number) {
    this.target = yaw;
    this.value = yaw;
  }

  /**
   * Advance the slew by `dt` seconds. Moves `value` toward `target` by at most
   * maxRate*dt radians. Returns true if it changed (so callers can skip work when
   * settled).
   */
  tick(dt: number): boolean {
    const diff = this.target - this.value;
    if (Math.abs(diff) < 1e-4) {
      if (this.value !== this.target) this.value = this.target;
      return false;
    }
    const maxStep = this.maxRate * dt;
    const step = Math.max(-maxStep, Math.min(maxStep, diff));
    this.value += step;
    return true;
  }
}
