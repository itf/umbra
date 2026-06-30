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
  // Turn RIGHT: Right/Down arrows, or E. Turn LEFT: Left/Up arrows, or Q.
  // (Up/Down mirror Left/Right so either arrow axis turns; Q/E are a keyboard-home
  // alternative.) Single letter keys are matched case-insensitively.
  const k = key.length === 1 ? key.toLowerCase() : key;
  if (k === 'ArrowRight' || k === 'ArrowDown' || k === 'e') return step;
  if (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'q') return -step;
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

/**
 * The 8-point compass names, indexed by octant (0=N, 1=NE, … 7=NW). yaw=0 is the
 * START direction, which we treat as NORTH for the read-out (the dial is relative,
 * not magnetic — see compass.ts). +yaw turns right (clockwise), so increasing yaw
 * walks N→E→S→W. Exported for tests.
 */
export const COMPASS_POINTS = [
  'north', 'north-east', 'east', 'south-east',
  'south', 'south-west', 'west', 'north-west',
] as const;

/** Normalize radians to [0, 360) degrees. Pure. */
function yawToDeg(yawRad: number): number {
  return ((((yawRad * 180) / Math.PI) % 360) + 360) % 360;
}

/**
 * Index of the nearest 8-point compass detent (0=N … 7=NW) for a heading, treating
 * yaw=0 as north and +yaw as clockwise. Each octant spans 45°, centred on its
 * cardinal/ordinal; e.g. anything within ±22.5° of north → 0. Pure + unit-tested.
 */
export function compassDetent(yawRad: number): number {
  const deg = yawToDeg(yawRad);
  return Math.round(deg / 45) % 8;
}

/**
 * The nearest compass direction NAME for a heading (e.g. "north-east"). Pure.
 */
export function compassDirection(yawRad: number): string {
  return COMPASS_POINTS[compassDetent(yawRad)];
}

/**
 * Did slewing from `prevYaw` to `nextYaw` CROSS into a new 8-point detent? Returns
 * the new detent index when the nearest-direction changed, else null. Used to fire a
 * subtle cue (announce the direction) only on a detent crossing, never continuously.
 * Pure + unit-tested.
 */
export function crossedDetent(prevYaw: number, nextYaw: number): number | null {
  const a = compassDetent(prevYaw);
  const b = compassDetent(nextYaw);
  return a === b ? null : b;
}

/**
 * Spoken heading that also NAMES the nearest compass direction at a detent (G2),
 * e.g. "Turned 45 degrees right, facing north-east." yaw=0 ⇒ start/north. Pure.
 */
export function announceHeadingWithDirection(yawRad: number): string {
  const base = announceHeading(yawRad);
  const dir = compassDirection(yawRad);
  // "Facing start direction." already implies north; don't tack on "facing north".
  if (/start direction/i.test(base)) return base;
  return base.replace(/\.$/, '') + `, facing ${dir}.`;
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
