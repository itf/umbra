/**
 * Tiny vanilla canvas-2D sparkline for the trainer progress dashboard. The data
 * prep (`sparklinePoints`) is pure + tested in trainerStore; this file is only the
 * drawing, which is decorative — the accessible truth is the spoken `trendSummary`
 * text alongside it (canvas alone is invisible to screen readers).
 */
import { sparklinePoints, type ExerciseProgress } from './trainerStore';

/**
 * Draw an exercise's threshold trend into a canvas. Y is FLIPPED so a lower
 * threshold (better) sits HIGHER on screen — the line rising = improving. No-op
 * when there's no history or no 2D context.
 */
export function drawSparkline(canvas: HTMLCanvasElement, p: ExerciseProgress): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const pts = sparklinePoints(p.thresholdLog);
  if (pts.length === 0) return;

  const pad = 3;
  const px = (x: number) => pad + x * (w - 2 * pad);
  // y is the threshold in [0,1]; 0 (best) → top, 1 (worst) → bottom.
  const py = (y: number) => pad + y * (h - 2 * pad);

  // Baseline (faint).
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad, h - pad);
  ctx.lineTo(w - pad, h - pad);
  ctx.stroke();

  // Trend line.
  ctx.strokeStyle = '#5bd1ff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  pts.forEach((pt, i) => {
    const x = px(pt.x);
    const y = py(pt.y);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Mark the latest point.
  const lastPt = pts[pts.length - 1];
  ctx.fillStyle = '#ffd166';
  ctx.beginPath();
  ctx.arc(px(lastPt.x), py(lastPt.y), 3, 0, Math.PI * 2);
  ctx.fill();
}
