/**
 * Turn control: position-based relative drag.
 *
 * Dragging horizontally rotates the listener's heading by an amount proportional
 * to how far the pointer has moved from where the drag began — NOT a velocity.
 * Hold still and the heading holds; release and it stays where you left it. The
 * next drag starts fresh from the current heading. This is forgiving eyes-free:
 * "push right a little to turn right a little."
 *
 * Heading (yaw) is in radians. yaw=0 faces -z (front). Positive yaw turns the
 * listener to the RIGHT (clockwise viewed from above), so the world sweeps left.
 */

export interface TurnControlOptions {
  /**
   * How much heading change a full-width drag produces, in radians. Sensitivity
   * is screen-relative: dragging from one edge of the control to the other turns
   * you by this much, regardless of device pixel density or screen size. Default
   * π (180°) — a half-screen drag turns you a quarter turn.
   */
  radiansPerWidth?: number;
  /** Called whenever heading changes, with the absolute yaw in radians. */
  onYaw: (yaw: number) => void;
  /** Called when the user releases the drag (lets the caller stop slewing). */
  onRelease?: () => void;
}

export class TurnControl {
  private el: HTMLElement;
  private radiansPerWidth: number;
  private onYaw: (yaw: number) => void;
  private onRelease?: () => void;

  private yaw = 0; // committed heading at drag start
  private liveYaw = 0; // current heading (committed + drag delta)
  private dragStartX = 0;
  private dragWidth = 1; // element width captured at drag start
  private pointerId: number | null = null;
  private enabled = true;

  constructor(el: HTMLElement, opts: TurnControlOptions) {
    this.el = el;
    this.radiansPerWidth = opts.radiansPerWidth ?? Math.PI; // full-width drag = 180°
    this.onYaw = opts.onYaw;
    this.onRelease = opts.onRelease;

    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('pointerup', this.onUp);
    el.addEventListener('pointercancel', this.onUp);
    el.addEventListener('keydown', this.onKey);
  }

  get heading(): number {
    return this.liveYaw;
  }

  /**
   * Set heading programmatically (e.g. to sync with another turn control). This
   * does NOT fire onYaw — otherwise two controls syncing each other would recurse
   * forever. It only updates internal state and the ARIA display.
   */
  setHeading(yaw: number) {
    // Ignore programmatic sync while the user is actively dragging — otherwise it
    // would clobber the drag baseline mid-gesture and fight the finger.
    if (this.pointerId !== null) return;
    this.yaw = yaw;
    this.liveYaw = yaw;
    this.updateAria();
  }

  /** Enable/disable drag handling (used when another turn mode is active). */
  setEnabled(on: boolean) {
    this.enabled = on;
    if (!on) this.pointerId = null;
  }

  private onDown = (e: PointerEvent) => {
    if (!this.enabled) return;
    this.pointerId = e.pointerId;
    this.dragStartX = e.clientX;
    this.dragWidth = this.el.getBoundingClientRect().width || 1;
    this.yaw = this.liveYaw; // commit current heading as the new baseline
    this.el.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  private onMove = (e: PointerEvent) => {
    if (this.pointerId !== e.pointerId) return;
    const dx = e.clientX - this.dragStartX;
    // Screen-relative: a full-width drag = radiansPerWidth. Drag right turns right.
    this.liveYaw = this.yaw + (dx / this.dragWidth) * this.radiansPerWidth;
    this.emit();
    e.preventDefault();
  };

  private onUp = (e: PointerEvent) => {
    if (this.pointerId !== e.pointerId) return;
    this.yaw = this.liveYaw; // leave heading where the drag ended
    this.pointerId = null;
    this.onRelease?.();
  };

  // Keyboard fallback for desktop / switch users: arrows nudge 5°, shift = 15°.
  private onKey = (e: KeyboardEvent) => {
    const step = (e.shiftKey ? 15 : 5) * (Math.PI / 180);
    if (e.key === 'ArrowRight') this.nudge(step);
    else if (e.key === 'ArrowLeft') this.nudge(-step);
    else return;
    e.preventDefault();
  };

  private nudge(delta: number) {
    this.liveYaw += delta;
    this.yaw = this.liveYaw;
    this.emit();
  }

  private emit() {
    this.onYaw(this.liveYaw);
    this.updateAria();
  }

  /**
   * Mirror heading into the slider ARIA. No cardinal directions — headings are
   * relative to where you started, announced as degrees turned left/right.
   */
  private updateAria() {
    const deg = ((((this.liveYaw * 180) / Math.PI) % 360) + 360) % 360;
    this.el.setAttribute('aria-valuenow', String(Math.round(deg)));
    this.el.setAttribute('aria-valuetext', headingDescription(deg));
    const label = this.el.querySelector('span');
    if (label) label.textContent = `${Math.round(deg)}°`;
  }
}

/**
 * Describe a heading relative to the start direction, without cardinal points:
 * e.g. "turned 45 degrees right" / "facing start direction".
 */
export function headingDescription(deg: number): string {
  const d = Math.round(deg);
  if (d === 0) return 'facing start direction';
  // Express as the shorter turn: 0..180 right, 180..360 as left.
  if (d <= 180) return `turned ${d} degrees right`;
  return `turned ${360 - d} degrees left`;
}
