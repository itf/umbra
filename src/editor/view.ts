/**
 * Canvas view: world↔screen transform + drawing the level top-down.
 * World is the x/z plane in metres; screen is canvas pixels. We fit the room into
 * the canvas with margin and a uniform scale, so 1 metre = `scale` px.
 */
import type { Level, WallObj } from '../level/schema';
import { MATERIALS } from '../engine/acoustics/materials';

export interface ViewState {
  scale: number; // px per metre
  offsetX: number; // screen px of world x=0
  offsetY: number; // screen px of world z=0
}

/** A colour per material so floor zones / walls read at a glance. */
const MAT_COLORS: Record<string, string> = {
  concrete: '#6b6b6b',
  glass: '#4aa3c7',
  tile: '#8a8f99',
  wood: '#9b6a3a',
  carpet: '#8a5a8a',
  curtain: '#7a4a6a',
  acoustic_foam: '#4a6a4a',
};
export function matColor(name: string): string {
  return MAT_COLORS[name] ?? '#777';
}
export const MATERIAL_NAMES = Object.keys(MATERIALS);

/** Fit the level's room into the canvas, returning the transform. */
export function fitView(level: Level, canvas: HTMLCanvasElement): ViewState {
  const margin = 40;
  const w = canvas.width - margin * 2;
  const h = canvas.height - margin * 2;
  const scale = Math.min(w / level.room.width, h / level.room.depth);
  const offsetX = margin + (w - level.room.width * scale) / 2;
  const offsetY = margin + (h - level.room.depth * scale) / 2;
  return { scale, offsetX, offsetY };
}

export function worldToScreen(v: ViewState, x: number, z: number): [number, number] {
  return [v.offsetX + x * v.scale, v.offsetY + z * v.scale];
}
export function screenToWorld(v: ViewState, sx: number, sy: number): [number, number] {
  return [(sx - v.offsetX) / v.scale, (sy - v.offsetY) / v.scale];
}

export interface DrawOpts {
  selectedId: string | null;
  grid: boolean;
}

export function draw(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  level: Level,
  v: ViewState,
  opts: DrawOpts,
) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Room floor (open levels have no floor box — just a faint editor bound).
  const [rx, ry] = worldToScreen(v, 0, 0);
  const rw = level.room.width * v.scale;
  const rd = level.room.depth * v.scale;
  if (!level.open) {
    ctx.fillStyle = matColor(level.floorMaterial) + '33';
    ctx.fillRect(rx, ry, rw, rd);
  } else {
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(rx, ry, rw, rd);
  }

  // Grid (1 m).
  if (opts.grid) {
    ctx.strokeStyle = '#1c1c1c';
    ctx.lineWidth = 1;
    for (let x = 0; x <= level.room.width; x++) {
      const [sx] = worldToScreen(v, x, 0);
      ctx.beginPath(); ctx.moveTo(sx, ry); ctx.lineTo(sx, ry + rd); ctx.stroke();
    }
    for (let z = 0; z <= level.room.depth; z++) {
      const [, sy] = worldToScreen(v, 0, z);
      ctx.beginPath(); ctx.moveTo(rx, sy); ctx.lineTo(rx + rw, sy); ctx.stroke();
    }
  }

  // Floor zones.
  for (const f of level.floors) {
    const [fx, fy] = worldToScreen(v, f.x, f.z);
    ctx.fillStyle = matColor(f.material) + '66';
    ctx.fillRect(fx, fy, f.w * v.scale, f.d * v.scale);
    strokeIfSelected(ctx, opts, f.id, fx, fy, f.w * v.scale, f.d * v.scale);
  }

  // Ceiling zones (overhead) — drawn as dashed cyan rectangles with their height.
  for (const c of level.ceilings) {
    const [cx, cy] = worldToScreen(v, c.x, c.z);
    ctx.save();
    ctx.strokeStyle = c.id === opts.selectedId ? '#ffd166' : '#5bd1ff';
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(cx, cy, c.w * v.scale, c.d * v.scale);
    ctx.restore();
    label(ctx, cx + (c.w * v.scale) / 2, cy + 12, `ceil ${c.height}m`);
  }

  // Room perimeter: a solid wall when enclosed, a dashed editor-bound when open.
  if (level.open) {
    ctx.save();
    ctx.strokeStyle = '#3a3a3a';
    ctx.setLineDash([6, 6]);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(rx, ry, rw, rd);
    ctx.restore();
  } else {
    ctx.strokeStyle = matColor(level.roomMaterial);
    ctx.lineWidth = 4;
    ctx.strokeRect(rx, ry, rw, rd);
  }

  // Interior walls. Moving walls (motion set) draw DASHED with a cue: translate
  // shows a travel arrow along (dx,dz); slide shows the door's open extent + a "↔".
  for (const w of level.walls) {
    const [ax, ay] = worldToScreen(v, w.ax, w.az);
    const [bx, by] = worldToScreen(v, w.bx, w.bz);
    const sel = w.id === opts.selectedId;
    ctx.save();
    ctx.strokeStyle = sel ? '#ffd166' : matColor(w.material);
    ctx.lineWidth = sel ? 6 : 5;
    ctx.lineCap = 'round';
    if (w.motion) ctx.setLineDash([8, 5]);
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    ctx.restore();
    if (w.motion) drawWallMotion(ctx, v, w, ax, ay, bx, by);
  }

  // Absorber patches: a thick coloured segment on the perimeter face the patch sits
  // on, drawn slightly inside the wall so it reads as a panel set into the wall. The
  // label shows the material; selected patches highlight in the editor's accent.
  for (const p of level.absorbers ?? []) {
    const { width, depth } = level.room;
    const u0 = p.u0, u1 = p.u0 + p.uSize;
    let a: [number, number]; let b: [number, number];
    if (p.wall === '-x') { a = [0, u0]; b = [0, u1]; }
    else if (p.wall === '+x') { a = [width, u0]; b = [width, u1]; }
    else if (p.wall === '-z') { a = [u0, 0]; b = [u1, 0]; }
    else { a = [u0, depth]; b = [u1, depth]; }
    const [ax, ay] = worldToScreen(v, a[0], a[1]);
    const [bx, by] = worldToScreen(v, b[0], b[1]);
    ctx.save();
    ctx.strokeStyle = p.id === opts.selectedId ? '#ffd166' : matColor(p.material);
    ctx.lineWidth = 7;
    ctx.lineCap = 'butt';
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    ctx.restore();
    label(ctx, (ax + bx) / 2, (ay + by) / 2 - 10, `▥ ${p.material}`);
  }

  // Ambient (non-goal) sources — distinct blue dots so they don't read as goals.
  for (const a of level.ambience ?? []) {
    const [ax, ay] = worldToScreen(v, a.x, a.z);
    dot(ctx, ax, ay, a.id === opts.selectedId ? '#fff' : '#4f8fff', 8);
    const snd = a.soundUrl ? 'file' : a.sound;
    label(ctx, ax, ay - 14, `≋ ${snd}`);
  }

  // Win area (the decoupled winPoint + winRadius): a green target ring, distinct
  // from a beacon's amber goal ring. Drawn even with zero beacons (silent levels).
  if (level.winPoint) {
    const [wx, wy] = worldToScreen(v, level.winPoint.x, level.winPoint.z);
    const r = (level.winRadius ?? 0.9) * v.scale;
    ctx.save();
    ctx.strokeStyle = opts.selectedId === '__win' ? '#fff' : '#6ee787';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.arc(wx, wy, r, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
    dot(ctx, wx, wy, opts.selectedId === '__win' ? '#fff' : '#6ee787', 5);
    label(ctx, wx, wy - 12, '◎ WIN');
  }

  // Beacons.
  for (const b of level.beacons) {
    const [bx, by] = worldToScreen(v, b.x, b.z);
    // Goal radius.
    ctx.strokeStyle = '#ffd16688';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(bx, by, b.goalRadius * v.scale, 0, Math.PI * 2); ctx.stroke();
    dot(ctx, bx, by, b.id === opts.selectedId ? '#fff' : '#ffd166', 8);
    const snd = b.soundUrl ? 'file' : (b.sound ?? 'tone');
    label(ctx, bx, by - 14, `♪ ${b.freq}Hz ${snd}`);
  }

  // Monsters.
  for (const m of level.monsters) {
    const [mx, my] = worldToScreen(v, m.x, m.z);
    dot(ctx, mx, my, m.id === opts.selectedId ? '#fff' : '#ff5a5a', 9);
    label(ctx, mx, my - 14, `☠ ${m.sound}`);
  }

  // Escape exit (the win target in goal:'escape' mode): a distinct diamond marker.
  if (level.exit) {
    const [ex, ey] = worldToScreen(v, level.exit.x, level.exit.z);
    const selExit = opts.selectedId === '__exit';
    ctx.save();
    ctx.translate(ex, ey);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = selExit ? '#fff' : '#6ee7ff';
    ctx.fillRect(-7, -7, 14, 14);
    ctx.restore();
    label(ctx, ex, ey - 14, '⎋ EXIT');
  }

  // Start point with facing arrow.
  const [sx, sy] = worldToScreen(v, level.start.x, level.start.z);
  dot(ctx, sx, sy, opts.selectedId === 'start' ? '#fff' : '#6ee787', 9);
  const len = 22;
  const dx = Math.sin(level.start.yaw) * len;
  const dz = -Math.cos(level.start.yaw) * len;
  ctx.strokeStyle = '#6ee787'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx + dx, sy + dz); ctx.stroke();
  label(ctx, sx, sy + 18, 'START');
}

/** Draw the motion cue for a moving wall (arrow for translate, "↔" + label). */
function drawWallMotion(
  ctx: CanvasRenderingContext2D, v: ViewState, w: WallObj,
  ax: number, ay: number, bx: number, by: number,
) {
  const midx = (ax + bx) / 2, midy = (ay + by) / 2;
  ctx.save();
  ctx.strokeStyle = '#ff9ed8';
  ctx.fillStyle = '#ff9ed8';
  ctx.lineWidth = 2;
  if (w.motion!.kind === 'translate') {
    // Arrow from the wall midpoint along the travel vector (dx,dz) in px.
    const ex = midx + w.motion!.dx * v.scale;
    const ey = midy + w.motion!.dz * v.scale;
    ctx.beginPath(); ctx.moveTo(midx, midy); ctx.lineTo(ex, ey); ctx.stroke();
    const ang = Math.atan2(ey - midy, ex - midx);
    const head = 7;
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex - head * Math.cos(ang - 0.5), ey - head * Math.sin(ang - 0.5));
    ctx.lineTo(ex - head * Math.cos(ang + 0.5), ey - head * Math.sin(ang + 0.5));
    ctx.closePath(); ctx.fill();
    label(ctx, midx, midy - 8, `⇄ ${w.motion!.period}s`);
  } else {
    label(ctx, midx, midy - 8, `↔ door ${w.motion!.period}s`);
  }
  ctx.restore();
}

function dot(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, r: number) {
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
}
function label(ctx: CanvasRenderingContext2D, x: number, y: number, text: string) {
  ctx.fillStyle = '#ddd';
  ctx.font = '11px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.fillText(text, x, y);
}
function strokeIfSelected(
  ctx: CanvasRenderingContext2D, opts: DrawOpts, id: string,
  x: number, y: number, w: number, h: number,
) {
  if (id !== opts.selectedId) return;
  ctx.strokeStyle = '#ffd166'; ctx.lineWidth = 2;
  ctx.strokeRect(x, y, w, h);
}
