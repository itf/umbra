/**
 * Papa Sangre-style HALF compass: a semicircular dial at the top with bone-like
 * tick markers. Behaves as drag-to-rotate — drag horizontally and the arc spins,
 * turning your heading. It shows only the forward hemisphere (the top 180° arc),
 * which fits the screen better than a full circle and matches the original game.
 *
 * Not a magnetic compass — markers are relative to where you started. The fixed
 * pointer at the very top is "you / forward"; the marked arc rotates beneath it.
 *
 * Heading convention matches turnControl: yaw radians, +yaw = turning right, so
 * the arc sweeps LEFT under the fixed top pointer when you turn right.
 *
 * Accessibility: the widget is a `role="slider"` and is keyboard-FOCUSABLE
 * (tabindex=0). It exposes the live heading via aria-valuenow (degrees) and a
 * human aria-valuetext (e.g. "facing north-east"), updated on every setHeading so a
 * screen-reader user who focuses it hears the current heading. Turning itself is
 * driven by the GLOBAL arrow-key handler in main.ts (which slews the same Heading
 * and calls setHeading); the widget deliberately does NOT bind arrow keys so it
 * never double-handles them — it just reflects the value.
 */

export interface CompassOptions {
  /** Width in CSS pixels (the arc spans this; height is ~half). */
  size?: number;
  /** Radians of heading change per full-width horizontal drag. Default π (180°). */
  radiansPerWidth?: number;
  /** Called with absolute yaw (radians) when the user drags the dial. */
  onYaw?: (yaw: number) => void;
  /** Called when the user releases the dial (lets the caller stop slewing). */
  onRelease?: () => void;
}

const SVGNS = 'http://www.w3.org/2000/svg';

/** 8-point compass names (yaw=0 = start = north; +yaw clockwise). */
const COMPASS_POINTS = [
  'north', 'north-east', 'east', 'south-east',
  'south', 'south-west', 'west', 'north-west',
] as const;

/** Normalize a yaw (radians) to [0,360) degrees, with 0 = start/north. */
function yawDeg(yaw: number): number {
  return ((((yaw * 180) / Math.PI) % 360) + 360) % 360;
}

/** Human-readable heading for aria-valuetext, e.g. "30 degrees right, facing north-east". */
function headingText(yaw: number): string {
  const deg = yawDeg(yaw);
  const dir = COMPASS_POINTS[Math.round(deg / 45) % 8];
  const d = Math.round(deg);
  if (d === 0 || d === 360) return 'facing start direction (north)';
  const rel = d <= 180 ? `${d} degrees right` : `${360 - d} degrees left`;
  return `${rel}, facing ${dir}`;
}

/** The compass shows only the top arc of this many degrees (±ARC_DEG/2 from up). */
const ARC_DEG = 120;

export class Compass {
  readonly el: SVGSVGElement;
  private arc!: SVGGElement;
  private onYaw?: (yaw: number) => void;
  private onRelease?: () => void;
  private width: number;
  private height: number;
  private cx: number;
  private cy: number;
  private radius: number;
  private radiansPerWidth: number;

  private yaw = 0;
  private dragging = false;
  private pointerId: number | null = null;
  private startX = 0;
  private startYaw = 0;

  constructor(opts: CompassOptions = {}) {
    this.width = opts.size ?? 280;
    // We show only the top ARC_DEG° of the dial (a shallow arc, not a full
    // semicircle). The arc subtends ±ARC_DEG/2 from straight up; for its chord to
    // span the full width, radius = (width/2) / sin(ARC_DEG/2).
    const half = (ARC_DEG / 2) * (Math.PI / 180);
    this.radius = this.width / 2 / Math.sin(half) - 6;
    this.cx = this.width / 2;
    // The arc's geometric centre is below the widget; place it so the top of the
    // arc and its endpoints both fit. Height = sagitta (arc rise) + padding.
    const sagitta = this.radius * (1 - Math.cos(half));
    this.cy = this.radius + 14; // centre y so the arc top sits near y=14
    // The visible band runs from the arc top (y≈14) down to the flank endpoints.
    // Make the viewBox a little taller than the band so flank ticks render fully
    // and ticks rotating in from the sides aren't culled at the edge.
    this.height = Math.round(sagitta + 44);
    // Dragging one full width across the compass turns you exactly ARC_DEG°.
    this.radiansPerWidth = opts.radiansPerWidth ?? ARC_DEG * (Math.PI / 180);
    this.onYaw = opts.onYaw;
    this.onRelease = opts.onRelease;
    this.el = this.build();
    this.attachInput();
  }

  /**
   * Update displayed heading. Turning right (+yaw) rotates the dial so its markings
   * sweep so the heading you're turning toward comes up under the fixed pointer —
   * i.e. the dial turns the same way you do.
   */
  setHeading(yaw: number) {
    this.yaw = yaw;
    const deg = (yaw * 180) / Math.PI;
    this.arc.setAttribute('transform', `rotate(${-deg} ${this.cx} ${this.cy})`);
    // Reflect the live heading for assistive tech (a focused screen-reader user
    // hears their heading). aria-valuenow is the absolute compass bearing (0–359°,
    // 0 = start/north); aria-valuetext spells out the relative turn + direction.
    const bearing = Math.round(yawDeg(yaw)) % 360;
    this.el.setAttribute('aria-valuenow', String(bearing));
    this.el.setAttribute('aria-valuetext', headingText(yaw));
  }

  private build(): SVGSVGElement {
    const svg = document.createElementNS(SVGNS, 'svg') as SVGSVGElement;
    svg.setAttribute('width', String(this.width));
    svg.setAttribute('height', String(this.height));
    svg.setAttribute('viewBox', `0 0 ${this.width} ${this.height}`);
    svg.setAttribute('role', 'slider');
    svg.setAttribute('aria-label', 'Compass. Drag left or right, or use the arrow keys, to turn.');
    // Keyboard-focusable so a screen-reader user can land on it and hear the
    // heading. Turning is handled by the global arrow handler (main.ts); we expose
    // the value, not the input. aria-valuemin/max span a full compass turn (0–359°).
    svg.setAttribute('tabindex', '0');
    svg.setAttribute('aria-valuemin', '0');
    svg.setAttribute('aria-valuemax', '359');
    svg.setAttribute('aria-valuenow', '0');
    svg.setAttribute('aria-valuetext', headingText(0));
    svg.style.outline = 'none';
    svg.style.touchAction = 'none';
    svg.style.userSelect = 'none';
    svg.style.cursor = 'ew-resize';
    svg.style.display = 'block';
    svg.style.margin = '0 auto';

    const { cx, cy, radius } = this;
    const half = (ARC_DEG / 2) * (Math.PI / 180); // half the visible arc, radians
    // Endpoints of the visible arc (at ±half from straight up).
    const ex = Math.sin(half) * radius;
    const ey = Math.cos(half) * radius;
    const arcPath = `M ${cx - ex} ${cy - ey} A ${radius} ${radius} 0 0 1 ${cx + ex} ${cy - ey}`;

    // Rim: the visible 120° arc.
    const rim = document.createElementNS(SVGNS, 'path');
    rim.setAttribute('d', arcPath);
    rim.setAttribute('fill', 'none');
    rim.setAttribute('stroke', '#3a3526');
    rim.setAttribute('stroke-width', '10');
    rim.setAttribute('stroke-linecap', 'round');
    svg.appendChild(rim);

    // Rotating group: tick marks around the FULL circle. As the group rotates,
    // ticks sweep through the visible top band; the SVG's own viewport box is the
    // ONLY thing that hides the ones below — there's no separate clip on the ticks.
    const arc = document.createElementNS(SVGNS, 'g') as SVGGElement;
    for (let deg = 0; deg < 360; deg += 15) {
      const major = deg % 45 === 0;
      const a = (deg * Math.PI) / 180; // 0 = up
      const x = cx + Math.sin(a) * radius;
      const y = cy - Math.cos(a) * radius;
      const x2 = cx + Math.sin(a) * (radius - (major ? 12 : 6));
      const y2 = cy - Math.cos(a) * (radius - (major ? 12 : 6));
      const tick = document.createElementNS(SVGNS, 'line');
      tick.setAttribute('x1', String(x));
      tick.setAttribute('y1', String(y));
      tick.setAttribute('x2', String(x2));
      tick.setAttribute('y2', String(y2));
      tick.setAttribute('stroke', major ? '#d9c98a' : '#6a6248');
      tick.setAttribute('stroke-width', major ? '3' : '1.5');
      tick.setAttribute('stroke-linecap', 'round');
      arc.appendChild(tick);
    }
    // A single bright reference mark at 0° (your start heading).
    const ref = document.createElementNS(SVGNS, 'circle');
    ref.setAttribute('cx', String(cx));
    ref.setAttribute('cy', String(cy - radius));
    ref.setAttribute('r', '5');
    ref.setAttribute('fill', '#ffd166');
    arc.appendChild(ref);
    svg.appendChild(arc);
    this.arc = arc;

    // Fixed pointer at the top center = "you / forward". Does not rotate.
    const ptr = document.createElementNS(SVGNS, 'polygon');
    ptr.setAttribute('points', `${cx},${cy - radius - 12} ${cx - 7},${cy - radius + 4} ${cx + 7},${cy - radius + 4}`);
    ptr.setAttribute('fill', '#ff5a5a');
    svg.appendChild(ptr);

    return svg;
  }

  private attachInput() {
    this.el.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.pointerId = e.pointerId;
      this.startX = e.clientX;
      this.startYaw = this.yaw;
      this.el.setPointerCapture(e.pointerId);
      this.el.style.cursor = 'grabbing';
      e.preventDefault();
    });
    this.el.addEventListener('pointermove', (e) => {
      if (!this.dragging || e.pointerId !== this.pointerId) return;
      // Drag-to-rotate, screen-relative. We only EMIT the target yaw here — we do NOT
      // rotate the dial ourselves. The owner slews the heading and calls setHeading()
      // with the actual value, so the dial always shows the true (catching-up) heading
      // and, on release, stays where the heading is rather than snapping to the drag.
      const dx = e.clientX - this.startX;
      // Drag delta is NEGATED into yaw: a given drag must turn you the opposite way to
      // the previous (wrong-signed) mapping. The dial still follows the drag because
      // setHeading rotates with whatever yaw results — only the yaw's SIGN changed.
      // (Keyboard turning lives in main.ts and is intentionally left as-is.)
      const target = this.startYaw - (dx / this.width) * this.radiansPerWidth;
      this.onYaw?.(target);
      e.preventDefault();
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId !== this.pointerId) return;
      this.dragging = false;
      this.pointerId = null;
      this.el.style.cursor = 'ew-resize';
      this.onRelease?.();
    };
    this.el.addEventListener('pointerup', end);
    this.el.addEventListener('pointercancel', end);
  }
}
