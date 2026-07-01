/**
 * Two-input DIRECTION PICKER for the "point to the sound" localization test.
 *
 * The old single-click-on-an-oblique-diagram input was ambiguous: one 2D point had to
 * encode azimuth AND front/back AND height at once, so you couldn't cleanly say
 * "up-and-behind-left". This widget splits the choice into the two things a listener
 * actually judges separately:
 *
 *   1. a top-down COMPASS — click/drag anywhere on the ring to set the AZIMUTH (which
 *      way around you: front = top, right = right, back = bottom, left = left);
 *   2. a vertical HEIGHT slider — the ELEVATION ANGLE (−90° straight down … 0 ear level
 *      … +90° straight up).
 *
 * Together they name a full direction on the sphere unambiguously. A "This is where it
 * came from" button commits the current (azimuth, elevation) as a Direction.
 *
 * Engine/Direction convention (see hrtfLocalize): az 0 = front, +az = toward the right
 * (clockwise seen from above); el + = up. Pure geometry in compassToAz(); the DOM glue
 * is integration-verified.
 */
import type { Direction } from './hrtfLocalize';

/** Map a click at (px,py) inside a compass of the given centre+radius to an azimuth
 *  (radians, 0 = front/top, +clockwise = right). Distance from centre is ignored — only
 *  the angle matters — so a click anywhere along a bearing works. */
export function compassToAz(px: number, py: number, cx: number, cy: number): number {
  const dx = px - cx;
  const dy = py - cy;
  // Screen: +x right, +y DOWN. Front is UP (−y). Azimuth 0 = front, +clockwise.
  // atan2(right, front) = atan2(dx, -dy).
  return Math.atan2(dx, -dy);
}

/** Human label for an azimuth, for the spoken/screen readout. */
export function azLabel(azRad: number): string {
  let deg = (azRad * 180) / Math.PI;
  if (deg < 0) deg += 360;
  const dirs = ['front', 'front-right', 'right', 'back-right', 'behind', 'back-left', 'left', 'front-left'];
  const idx = Math.round(deg / 45) % 8;
  return dirs[idx];
}

/** Label for an elevation angle (degrees), for the readout. */
export function elLabel(elDeg: number): string {
  if (elDeg >= 55) return 'overhead';
  if (elDeg >= 20) return 'high';
  if (elDeg > -20) return 'ear level';
  if (elDeg > -55) return 'low';
  return 'below';
}

export interface DirectionPicker {
  el: HTMLElement;
  /** Current chosen direction. */
  get(): Direction;
  /** Reset to front / ear level for a fresh trial. */
  reset(): void;
  dispose(): void;
}

/**
 * Mount the two-input picker. `onCommit` fires when the user presses the confirm
 * button (or Enter) with the chosen direction. `say` announces changes for eyes-free
 * use. The widget keeps its own az/el state.
 */
export function mountDirectionPicker(
  host: HTMLElement,
  opts: { onCommit: (d: Direction) => void; say?: (m: string) => void },
): DirectionPicker {
  let az = 0; // radians, 0 = front
  let el = 0; // radians, 0 = ear level

  const wrap = document.createElement('div');
  wrap.className = 'dir-picker';

  // --- Compass (top-down azimuth) ---
  const W = 220, H = 220, cx = W / 2, cy = H / 2, R = 92;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  canvas.className = 'dir-compass';
  canvas.setAttribute('role', 'slider');
  canvas.setAttribute('aria-label', 'Direction around you: click front, right, behind, or left');
  canvas.tabIndex = 0;
  const ctx2d = canvas.getContext('2d');

  const drawCompass = () => {
    const c = ctx2d; if (!c) return;
    c.clearRect(0, 0, W, H);
    // ring
    c.strokeStyle = 'rgba(255,255,255,0.25)'; c.lineWidth = 2;
    c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.stroke();
    // cardinal labels
    c.fillStyle = 'rgba(255,255,255,0.6)'; c.font = '12px system-ui, sans-serif';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText('front', cx, cy - R - 10);
    c.fillText('behind', cx, cy + R + 10);
    c.fillText('L', cx - R - 10, cy);
    c.fillText('R', cx + R + 10, cy);
    // head at centre
    c.fillStyle = 'rgba(255,255,255,0.85)';
    c.beginPath(); c.arc(cx, cy, 8, 0, Math.PI * 2); c.fill();
    // chosen bearing marker
    const mx = cx + Math.sin(az) * R;
    const my = cy - Math.cos(az) * R;
    c.strokeStyle = 'rgba(255,209,102,0.6)'; c.lineWidth = 2;
    c.beginPath(); c.moveTo(cx, cy); c.lineTo(mx, my); c.stroke();
    c.fillStyle = 'rgba(255,209,102,1)';
    c.beginPath(); c.arc(mx, my, 9, 0, Math.PI * 2); c.fill();
  };

  const setAzFromEvent = (clientX: number, clientY: number) => {
    const rect = canvas.getBoundingClientRect();
    const px = ((clientX - rect.left) / rect.width) * W;
    const py = ((clientY - rect.top) / rect.height) * H;
    az = compassToAz(px, py, cx, cy);
    drawCompass();
    updateReadout();
  };

  let dragging = false;
  canvas.addEventListener('pointerdown', (e) => { dragging = true; canvas.setPointerCapture(e.pointerId); setAzFromEvent(e.clientX, e.clientY); });
  canvas.addEventListener('pointermove', (e) => { if (dragging) setAzFromEvent(e.clientX, e.clientY); });
  canvas.addEventListener('pointerup', () => { dragging = false; });
  // Keyboard: left/right arrows rotate the bearing in 15° steps.
  canvas.addEventListener('keydown', (e) => {
    const step = Math.PI / 12;
    if (e.key === 'ArrowRight') { az += step; e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { az -= step; e.preventDefault(); }
    else return;
    drawCompass(); updateReadout();
  });

  // --- Height slider (elevation angle) ---
  const heightWrap = document.createElement('div');
  heightWrap.className = 'dir-height';
  const heightLabel = document.createElement('label');
  heightLabel.textContent = 'Height';
  const height = document.createElement('input');
  height.type = 'range';
  height.min = '-90'; height.max = '90'; height.step = '5'; height.value = '0';
  height.className = 'dir-height-slider';
  height.setAttribute('aria-label', 'Height angle, from below through ear level to overhead');
  height.addEventListener('input', () => { el = (Number(height.value) * Math.PI) / 180; updateReadout(); });
  heightWrap.append(heightLabel, height);

  // --- Readout + confirm ---
  const readout = document.createElement('p');
  readout.className = 'dir-readout';
  const commit = document.createElement('button');
  commit.type = 'button';
  commit.className = 'primary';
  commit.textContent = 'This is where it came from';
  commit.addEventListener('click', () => opts.onCommit({ az, el }));

  const updateReadout = () => {
    const elDeg = (el * 180) / Math.PI;
    readout.textContent = `Pointing: ${azLabel(az)}, ${elLabel(elDeg)}.`;
  };

  drawCompass();
  updateReadout();
  const columns = document.createElement('div');
  columns.className = 'dir-picker-columns';
  columns.append(canvas, heightWrap);
  wrap.append(columns, readout, commit);
  host.append(wrap);

  return {
    el: wrap,
    get: () => ({ az, el }),
    reset() { az = 0; el = 0; height.value = '0'; drawCompass(); updateReadout(); },
    dispose() { try { wrap.remove(); } catch { /* noop */ } },
  };
}
