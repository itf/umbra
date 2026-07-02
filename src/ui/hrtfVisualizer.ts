/**
 * A tiny 3D "where is the sound?" visualizer for the HRTF calibration screen.
 *
 * Draws the listener at the centre (a head seen from behind/above) and a moving DOT
 * for the current probe position, so a sighted user can compare where they SHOULD be
 * hearing the sound against where they DO. This is a sighted AID for tuning — the
 * game itself is eyes-free — so it's deliberately simple: an isometric-ish oblique
 * projection (look slightly down from behind the listener) onto a 2D canvas.
 *
 * Position is listener-RELATIVE, engine convention (+x right, +y up, −z front), which
 * is exactly what the free-play loop already feeds the renderer. The projection maps:
 *   • x (right)  → screen +x
 *   • z (front→back, i.e. −z is front) → screen depth, drawn as a small vertical
 *     offset + size change so front reads as "toward you/bigger, lower"
 *   • y (up)     → screen −y (up)
 *
 * A ground ellipse + vertical stalk make height legible; a front marker labels which
 * way the listener faces. Pure DOM/canvas, no audio. The projection math is factored
 * into `project()` so it's unit-testable without a real canvas.
 */

export interface Projected {
  /** Screen coordinates in canvas pixels. */
  sx: number;
  sy: number;
  /** Ground-shadow screen coords (source projected straight down to y=headY). */
  gx: number;
  gy: number;
  /** Dot radius in px (grows as the source comes toward the front/closer in depth). */
  r: number;
  /** 0 (far/behind) … 1 (near/front) — used for depth shading. */
  depth01: number;
}

export interface ProjectConfig {
  w: number;
  h: number;
  /** World metres mapped to the half-width of the plot. */
  scale: number;
  /** Listener head height in world metres (positions are absolute Y around this). */
  headY: number;
}

/**
 * Project a listener-relative position to canvas space with a fixed oblique camera
 * (behind + slightly above the listener, looking forward/down). Pure; no canvas.
 */
export function project(
  x: number,
  y: number,
  z: number,
  cfg: ProjectConfig,
): Projected {
  const cx = cfg.w / 2;
  const cy = cfg.h / 2;
  const px = cfg.scale; // px per metre horizontally
  // Oblique top-down camera: FRONT (−z) is drawn UP/away (smaller sy), BACK (+z) is
  // drawn DOWN/toward the viewer — the natural map-like orientation (front = forwards).
  // 0.45 = the vertical squash of the tilt.
  const dvY = z * px * 0.45;
  const relY = y - cfg.headY; // height above ear level, metres
  const sx = cx + x * px;
  // Screen y grows DOWN: height moves the dot UP (subtract), depth tilt moves it as dvY.
  const sy = cy - relY * px + dvY;
  const gx = sx;
  const gy = cy + dvY; // ground shadow at the ear-level plane, same depth offset
  // Depth 0..1 assuming the ~1 m calibration shell: z=−1 (front)→1, z=+1 (back)→0.
  const depth01 = clamp01(0.5 - z * 0.5);
  const r = 5 + 7 * depth01; // 5..12 px — nearer/front reads bigger
  return { sx, sy, gx, gy, r, depth01 };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * Mount a canvas visualizer into `host`. Call `set(x,y,z)` each animation frame with
 * the current listener-relative source position; call `dispose()` to remove it.
 */
export function mountVisualizer(
  host: HTMLElement,
  opts: {
    /** When set, the canvas is CLICKABLE: a click reports its pixel coords so the
     *  caller can inverse-project them to a pointed direction (localization mode). */
    onPick?: (sx: number, sy: number, cfg: { w: number; h: number; scale: number }) => void;
  } = {},
): {
  el: HTMLCanvasElement;
  set: (x: number, y: number, z: number) => void;
  /** Draw a secondary "guess" marker (the user's pointed direction), or clear it. */
  setGuess: (pos: { x: number; y: number; z: number } | null) => void;
  /** Show/hide the moving source dot (hidden while the user is pointing "blind"). */
  showSource: (on: boolean) => void;
  dispose: () => void;
} {
  const canvas = document.createElement('canvas');
  canvas.className = 'hrtf-viz';
  // Backing store sized for crispness; CSS controls display size.
  const W = 260, H = 200;
  canvas.width = W;
  canvas.height = H;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute(
    'aria-label',
    'Diagram showing where the calibration sound is around your head.',
  );
  host.append(canvas);
  const ctx = canvas.getContext('2d');
  const cfg: ProjectConfig = { w: W, h: H, scale: 70, headY: 1.6 };

  let cur = { x: 0, y: cfg.headY, z: -1 };
  let guess: { x: number; y: number; z: number } | null = null;
  let sourceVisible = true;

  let onClick: ((e: MouseEvent) => void) | null = null;
  if (opts.onPick) {
    canvas.style.cursor = 'crosshair';
    onClick = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      // Map CSS pixels to backing-store pixels.
      const sx = ((e.clientX - rect.left) / rect.width) * W;
      const sy = ((e.clientY - rect.top) / rect.height) * H;
      opts.onPick!(sx, sy, { w: W, h: H, scale: cfg.scale });
    };
    canvas.addEventListener('click', onClick);
  }

  function draw() {
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    const cx = W / 2, cy = H / 2;

    // Ground reference ellipse (the 1 m ear-level ring) for depth grounding.
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(cx, cy, cfg.scale, cfg.scale * 0.45, 0, 0, Math.PI * 2);
    ctx.stroke();

    // FRONT (−z) is UP/away; BACK (+z) is toward the viewer/bottom.
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('front', cx, cy - cfg.scale * 0.45 - 6);
    ctx.fillText('back', cx, cy + cfg.scale * 0.45 + 14);

    // Head at centre (listener).
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.arc(cx, cy, 12, 0, Math.PI * 2);
    ctx.fill();
    // little nose pointing UP (front) so orientation is unambiguous.
    ctx.beginPath();
    ctx.moveTo(cx, cy - 12);
    ctx.lineTo(cx - 4, cy - 6);
    ctx.lineTo(cx + 4, cy - 6);
    ctx.closePath();
    ctx.fill();

    // The user's GUESS marker (localization mode) — a hollow ring with a RAY from the
    // head, so it clearly reads as "you're pointing THIS way" (not just a floating dot).
    if (guess) {
      const g = project(guess.x, guess.y, guess.z, cfg);
      ctx.strokeStyle = 'rgba(120,200,255,0.9)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(g.sx, g.sy); ctx.stroke(); // head → guess ray
      ctx.beginPath(); ctx.arc(g.sx, g.sy, g.r + 3, 0, Math.PI * 2); ctx.stroke();
      ctx.lineWidth = 1;
    }

    if (!sourceVisible) return;

    const p = project(cur.x, cur.y, cur.z, cfg);

    // RAY from the head to the source — makes it unmistakable the sound comes FROM that
    // direction (a bare dot didn't convey "the noise is over there"). Plus a vertical
    // stalk to the ground shadow for height.
    ctx.strokeStyle = 'rgba(255,209,102,0.7)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(p.sx, p.sy); ctx.stroke();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,209,102,0.35)';
    ctx.beginPath();
    ctx.moveTo(p.gx, p.gy);
    ctx.lineTo(p.sx, p.sy);
    ctx.stroke();
    // Ground shadow.
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath();
    ctx.ellipse(p.gx, p.gy, p.r * 0.8, p.r * 0.35, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.stroke();

    // The source dot — accent colour, brighter when nearer/front.
    const a = 0.5 + 0.5 * p.depth01;
    ctx.fillStyle = `rgba(255,209,102,${a.toFixed(2)})`;
    ctx.beginPath();
    ctx.arc(p.sx, p.sy, p.r, 0, Math.PI * 2);
    ctx.fill();
  }

  draw();

  return {
    el: canvas,
    set(x, y, z) {
      cur = { x, y, z };
      draw();
    },
    setGuess(pos) {
      guess = pos;
      draw();
    },
    showSource(on) {
      sourceVisible = on;
      draw();
    },
    dispose() {
      if (onClick) { try { canvas.removeEventListener('click', onClick); } catch { /* noop */ } }
      try { canvas.remove(); } catch { /* noop */ }
    },
  };
}
