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
/**
 * Heading change for one arrow-key turn nudge, in radians. Right turns positive
 * (clockwise from above), left negative. Shift = a larger 15° step, else 5° — the
 * same feel as TurnControl's keyboard fallback. Pure + unit-tested.
 */
export function keyTurnDelta(key: string, shift: boolean): number {
  const step = (shift ? 15 : 5) * (Math.PI / 180);
  if (key === 'ArrowRight') return step;
  if (key === 'ArrowLeft') return -step;
  return 0;
}

/**
 * Spoken heading relative to the start direction (matches turnControl's
 * `headingDescription`, but takes radians). yaw=0 ⇒ "facing start direction".
 * Pure + unit-tested.
 */
export function announceHeading(yawRad: number): string {
  const deg = ((((yawRad * 180) / Math.PI) % 360) + 360) % 360;
  const d = Math.round(deg);
  if (d === 0 || d === 360) return 'Facing start direction.';
  if (d <= 180) return `Turned ${d} degrees right.`;
  return `Turned ${360 - d} degrees left.`;
}

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
