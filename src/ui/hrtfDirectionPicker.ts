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
 * Read-only ANSWER diagram: the SAME two 2D views the user answered with (top-down
 * compass + side elevation arc), overlaid with the TRUTH (accent) and the user's GUESS
 * (blue), so on reveal they can compare in the exact frames they pointed in. Mirrors the
 * picker's geometry/conventions. Returns an element to insert; call dispose() to remove.
 */
export function mountAnswerDiagram(
  host: HTMLElement,
  truth: Direction,
  guess: Direction,
): { el: HTMLElement; dispose: () => void } {
  const wrap = document.createElement('div');
  wrap.className = 'dir-picker-columns dir-answer';

  const ACCENT = 'rgba(255,209,102,1)';   // truth
  const BLUE = 'rgba(120,200,255,1)';     // guess

  // --- top-down compass answer ---
  const CW = 150, CH = 150, ccx = CW / 2, ccy = CH / 2, CR = 60;
  const compass = document.createElement('canvas');
  compass.width = CW; compass.height = CH; compass.className = 'dir-compass';
  compass.setAttribute('role', 'img');
  compass.setAttribute('aria-label', `Which way: it was ${azLabel(truth.az)}; you said ${azLabel(guess.az)}.`);
  const cc = compass.getContext('2d');
  if (cc) {
    cc.strokeStyle = 'rgba(255,255,255,0.2)'; cc.lineWidth = 1;
    cc.beginPath(); cc.arc(ccx, ccy, CR, 0, Math.PI * 2); cc.stroke();
    cc.fillStyle = 'rgba(255,255,255,0.55)'; cc.font = '10px system-ui'; cc.textAlign = 'center'; cc.textBaseline = 'middle';
    cc.fillText('front', ccx, ccy - CR - 8); cc.fillText('behind', ccx, ccy + CR + 8);
    cc.fillText('L', ccx - CR - 8, ccy); cc.fillText('R', ccx + CR + 8, ccy);
    cc.fillStyle = 'rgba(255,255,255,0.85)'; cc.beginPath(); cc.arc(ccx, ccy, 6, 0, Math.PI * 2); cc.fill();
    const ray = (az: number, r: number, color: string) => {
      const mx = ccx + Math.sin(az) * r, my = ccy - Math.cos(az) * r;
      cc.strokeStyle = color; cc.lineWidth = 2; cc.beginPath(); cc.moveTo(ccx, ccy); cc.lineTo(mx, my); cc.stroke();
      cc.fillStyle = color; cc.beginPath(); cc.arc(mx, my, 6, 0, Math.PI * 2); cc.fill();
    };
    // guess slightly shorter so both are visible if they overlap
    ray(guess.az, CR * 0.7, BLUE);
    ray(truth.az, CR, ACCENT);
  }

  // --- side elevation arc answer ---
  const AW = 130, AH = 150, acx = AW * 0.4, acy = AH / 2, AR = 58;
  const arc = document.createElement('canvas');
  arc.width = AW; arc.height = AH; arc.className = 'dir-arc';
  arc.setAttribute('role', 'img');
  arc.setAttribute('aria-label', `How high: it was ${elLabel((truth.el * 180) / Math.PI)}; you said ${elLabel((guess.el * 180) / Math.PI)}.`);
  const ac = arc.getContext('2d');
  if (ac) {
    ac.strokeStyle = 'rgba(255,255,255,0.2)'; ac.lineWidth = 1;
    ac.beginPath(); ac.arc(acx, acy, AR, -Math.PI / 2, Math.PI / 2, false); ac.stroke();
    ac.fillStyle = 'rgba(255,255,255,0.55)'; ac.font = '10px system-ui'; ac.textAlign = 'center'; ac.textBaseline = 'middle';
    ac.fillText('up', acx + 4, acy - AR - 8); ac.fillText('ahead', acx + AR + 12, acy); ac.fillText('down', acx + 4, acy + AR + 8);
    ac.fillStyle = 'rgba(255,255,255,0.85)'; ac.beginPath(); ac.arc(acx, acy, 8, 0, Math.PI * 2); ac.fill();
    const ray = (elv: number, r: number, color: string) => {
      const mx = acx + Math.cos(elv) * r, my = acy - Math.sin(elv) * r;
      ac.strokeStyle = color; ac.lineWidth = 2; ac.beginPath(); ac.moveTo(acx, acy); ac.lineTo(mx, my); ac.stroke();
      ac.fillStyle = color; ac.beginPath(); ac.arc(mx, my, 6, 0, Math.PI * 2); ac.fill();
    };
    ray(guess.el, AR * 0.7, BLUE);
    ray(truth.el, AR, ACCENT);
  }

  wrap.append(compass, arc);
  host.append(wrap);
  return { el: wrap, dispose: () => { try { wrap.remove(); } catch { /* noop */ } } };
}

/**
 * Mount the two-input picker. `onCommit` fires when the user presses the confirm
 * button (or Enter) with the chosen direction. `say` announces changes for eyes-free
 * use. The widget keeps its own az/el state.
 */
export function mountDirectionPicker(
  host: HTMLElement,
  opts: {
    onCommit: (d: Direction) => void;
    /** Live callback on every compass/arc change, so a 3D reference model can mirror the
     *  current aim as the user moves the controls. */
    onChange?: (d: Direction) => void;
    /** The listener couldn't EXTERNALIZE the sound — it seemed to come from inside their
     *  head, with no direction. That's a strong NEGATIVE signal about the candidate (an
     *  externalization failure), not a skip. When absent, the button is hidden. */
    onInHead?: () => void;
    /** An extra button (e.g. "Play again") rendered on the SAME row as the confirm button. */
    extraAction?: HTMLElement;
    say?: (m: string) => void;
  },
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
    // The ACTIVE ring shrinks with elevation — on a sphere the circle of possible
    // azimuths at a given height is cos(elevation) of the equator, collapsing to a point
    // directly overhead. Scaling the ring this way makes the two controls read as ONE
    // sphere. A small floor keeps it visible/clickable even near straight up/down.
    const ringR = R * Math.max(0.14, Math.cos(el));
    // Faint full-size reference ring (the equator) so the shrink is legible.
    c.strokeStyle = 'rgba(255,255,255,0.08)'; c.lineWidth = 1;
    c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.stroke();
    // active ring at the current height
    c.strokeStyle = 'rgba(255,255,255,0.25)'; c.lineWidth = 2;
    c.beginPath(); c.arc(cx, cy, ringR, 0, Math.PI * 2); c.stroke();
    // cardinal labels (fixed at the reference radius — they're constant directions)
    c.fillStyle = 'rgba(255,255,255,0.6)'; c.font = '12px system-ui, sans-serif';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText('front', cx, cy - R - 10);
    c.fillText('behind', cx, cy + R + 10);
    c.fillText('L', cx - R - 10, cy);
    c.fillText('R', cx + R + 10, cy);
    // head at centre
    c.fillStyle = 'rgba(255,255,255,0.85)';
    c.beginPath(); c.arc(cx, cy, 8, 0, Math.PI * 2); c.fill();
    // chosen bearing marker — on the shrunken ring
    const mx = cx + Math.sin(az) * ringR;
    const my = cy - Math.cos(az) * ringR;
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

  // --- Height: a SIDE-VIEW head with an elevation ARC (a semicircle you drag along),
  // much clearer than a vertical slider. The head faces RIGHT (its nose = "ahead"); the
  // arc sweeps from BELOW (bottom) through AHEAD (right) to OVERHEAD (top). A dot on the
  // arc is the chosen elevation angle. Keyboard up/down also nudges it.
  const heightWrap = document.createElement('div');
  heightWrap.className = 'dir-height';
  const heightLabel = document.createElement('span');
  heightLabel.className = 'dir-subtitle';
  heightLabel.textContent = 'How high?';
  const HW = 150, HH = 200, hcx = HW * 0.42, hcy = HH / 2, hR = 78;
  const arc = document.createElement('canvas');
  arc.width = HW; arc.height = HH;
  arc.className = 'dir-arc';
  arc.setAttribute('role', 'slider');
  arc.setAttribute('aria-label', 'Height angle: drag on the arc from below through ahead to overhead');
  arc.tabIndex = 0;
  const arcCtx = arc.getContext('2d');

  const drawArc = () => {
    const c = arcCtx; if (!c) return;
    c.clearRect(0, 0, HW, HH);
    // The elevation arc: a right-side semicircle from straight down (−90°) to straight
    // up (+90°). Screen angle: el=+90 → top, el=0 → right (ahead), el=−90 → bottom.
    c.strokeStyle = 'rgba(255,255,255,0.25)'; c.lineWidth = 2;
    c.beginPath();
    c.arc(hcx, hcy, hR, -Math.PI / 2, Math.PI / 2, false); // right half
    c.stroke();
    // labels
    c.fillStyle = 'rgba(255,255,255,0.6)'; c.font = '11px system-ui, sans-serif';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText('up', hcx + 6, hcy - hR - 10);
    c.fillText('ahead', hcx + hR + 16, hcy);
    c.fillText('down', hcx + 6, hcy + hR + 10);
    // side-view head facing right (a circle + a little nose triangle).
    c.fillStyle = 'rgba(255,255,255,0.85)';
    c.beginPath(); c.arc(hcx, hcy, 14, 0, Math.PI * 2); c.fill();
    c.beginPath(); c.moveTo(hcx + 14, hcy); c.lineTo(hcx + 22, hcy - 4); c.lineTo(hcx + 22, hcy + 4); c.closePath(); c.fill();
    // marker on the arc for the current elevation.
    const mx = hcx + Math.cos(el) * hR;
    const my = hcy - Math.sin(el) * hR;
    c.strokeStyle = 'rgba(255,209,102,0.6)'; c.lineWidth = 2;
    c.beginPath(); c.moveTo(hcx, hcy); c.lineTo(mx, my); c.stroke();
    c.fillStyle = 'rgba(255,209,102,1)';
    c.beginPath(); c.arc(mx, my, 9, 0, Math.PI * 2); c.fill();
  };

  const setElFromEvent = (clientX: number, clientY: number) => {
    const rect = arc.getBoundingClientRect();
    const px = ((clientX - rect.left) / rect.width) * HW;
    const py = ((clientY - rect.top) / rect.height) * HH;
    // angle from head centre; screen +x = ahead, screen −y (up) = higher elevation.
    let a = Math.atan2(-(py - hcy), px - hcx); // −π..π, 0 = ahead, +up
    a = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, a)); // clamp to the semicircle
    el = a;
    drawArc(); drawCompass(); updateReadout();
  };
  let draggingArc = false;
  arc.addEventListener('pointerdown', (e) => { draggingArc = true; arc.setPointerCapture(e.pointerId); setElFromEvent(e.clientX, e.clientY); });
  arc.addEventListener('pointermove', (e) => { if (draggingArc) setElFromEvent(e.clientX, e.clientY); });
  arc.addEventListener('pointerup', () => { draggingArc = false; });
  arc.addEventListener('keydown', (e) => {
    const step = Math.PI / 12;
    if (e.key === 'ArrowUp') { el = Math.min(Math.PI / 2, el + step); e.preventDefault(); }
    else if (e.key === 'ArrowDown') { el = Math.max(-Math.PI / 2, el - step); e.preventDefault(); }
    else return;
    drawArc(); drawCompass(); updateReadout();
  });
  heightWrap.append(heightLabel, arc);

  // --- Readout + confirm ---
  const readout = document.createElement('p');
  readout.className = 'dir-readout';
  const commit = document.createElement('button');
  commit.type = 'button';
  commit.className = 'primary';
  commit.textContent = 'This is where it came from';
  commit.addEventListener('click', () => opts.onCommit({ az, el }));

  // "Inside my head" — externalization failure. A distinct, non-primary button so it's
  // available without competing with the normal pointing answer.
  let inHeadBtn: HTMLButtonElement | null = null;
  if (opts.onInHead) {
    inHeadBtn = document.createElement('button');
    inHeadBtn.type = 'button';
    inHeadBtn.className = 'secondary dir-inhead';
    inHeadBtn.textContent = 'It was inside my head (no direction)';
    inHeadBtn.addEventListener('click', () => opts.onInHead?.());
  }

  const updateReadout = () => {
    const elDeg = (el * 180) / Math.PI;
    readout.textContent = `Pointing: ${azLabel(az)}, ${elLabel(elDeg)}.`;
    opts.onChange?.({ az, el }); // live: let a 3D reference model mirror the current aim
  };

  drawCompass();
  drawArc();
  updateReadout();
  // Label the compass column too, so the two inputs read as "which way?" + "how high?".
  const compassWrap = document.createElement('div');
  compassWrap.className = 'dir-compasscol';
  const compassLabel = document.createElement('span');
  compassLabel.className = 'dir-subtitle';
  compassLabel.textContent = 'Which way?';
  compassWrap.append(compassLabel, canvas);
  const columns = document.createElement('div');
  columns.className = 'dir-picker-columns';
  columns.append(compassWrap, heightWrap);
  // Confirm + any extra action (e.g. "Play again") share one row.
  const actionRow = document.createElement('div');
  actionRow.className = 'dir-actions';
  actionRow.append(commit);
  if (opts.extraAction) actionRow.append(opts.extraAction);
  wrap.append(columns, readout, actionRow);
  if (inHeadBtn) wrap.append(inHeadBtn);
  host.append(wrap);

  return {
    el: wrap,
    get: () => ({ az, el }),
    reset() { az = 0; el = 0; drawCompass(); drawArc(); updateReadout(); },
    dispose() { try { wrap.remove(); } catch { /* noop */ } },
  };
}
