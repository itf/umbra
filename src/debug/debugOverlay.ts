/**
 * DEBUG-ONLY top-down minimap + live audio readout, gated behind `?debug=1`.
 *
 * Draws the room walls, the beacon, the player position + heading, and the active
 * reflection image-sources the modeled beacon is currently rendering — plus a small
 * text readout (engine, distance, heading, #reflections). Purely a development aid:
 * it polls `game.debugState()` (read-only) each frame and never affects audio.
 *
 * It is NOT created on the normal path; `main.ts` instantiates it only when
 * `?debug=1` is present. No bundle/runtime cost otherwise.
 */
import type { Game } from '../game/game';

type DebugState = ReturnType<Game['debugState']>;

export class DebugOverlay {
  private game: Game;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private readout: HTMLElement;
  private raf = 0;

  constructor(game: Game) {
    this.game = game;

    const box = document.createElement('div');
    box.style.cssText =
      'position:fixed;right:8px;bottom:8px;z-index:9999;background:rgba(0,0,0,0.7);' +
      'border:1px solid #444;border-radius:6px;padding:6px;font:11px/1.4 monospace;color:#ddd;';

    this.canvas = document.createElement('canvas');
    this.canvas.width = 200;
    this.canvas.height = 200;
    this.canvas.style.cssText = 'display:block;background:#111;border-radius:4px;';
    box.appendChild(this.canvas);

    this.readout = document.createElement('div');
    this.readout.style.cssText = 'margin-top:4px;white-space:pre;';
    box.appendChild(this.readout);

    document.body.appendChild(box);
    this.ctx = this.canvas.getContext('2d')!;

    const loop = () => { this.draw(); this.raf = requestAnimationFrame(loop); };
    this.raf = requestAnimationFrame(loop);
  }

  dispose() { cancelAnimationFrame(this.raf); }

  /** Fit the room's xz bounds (walls + beacon + player) into the canvas. */
  private bounds(s: DebugState) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    const ext = (x: number, z: number) => {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    };
    for (const w of s.walls) for (const v of w.verts) ext(v[0], v[2]);
    ext(s.beacon.x, s.beacon.z);
    ext(s.player.x, s.player.z);
    if (!isFinite(minX)) { minX = 0; maxX = 10; minZ = 0; maxZ = 10; }
    return { minX, maxX, minZ, maxZ };
  }

  private draw() {
    const s = this.game.debugState();
    const { ctx, canvas } = this;
    const M = 14; // margin px
    const b = this.bounds(s);
    const spanX = Math.max(0.1, b.maxX - b.minX);
    const spanZ = Math.max(0.1, b.maxZ - b.minZ);
    const scale = Math.min((canvas.width - 2 * M) / spanX, (canvas.height - 2 * M) / spanZ);
    // world (x,z) → screen (px). z grows downward on screen (top-down).
    const sx = (x: number) => M + (x - b.minX) * scale;
    const sz = (z: number) => M + (z - b.minZ) * scale;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // walls
    ctx.strokeStyle = '#5a8'; ctx.lineWidth = 1.5;
    for (const w of s.walls) {
      if (w.verts.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(sx(w.verts[0][0]), sz(w.verts[0][2]));
      for (let i = 1; i < w.verts.length; i++) ctx.lineTo(sx(w.verts[i][0]), sz(w.verts[i][2]));
      ctx.closePath();
      ctx.stroke();
    }

    // active reflection image-sources (orange, alpha ∝ gain)
    for (const r of s.reflections) {
      ctx.fillStyle = `rgba(255,160,40,${Math.min(1, 0.3 + r.gain)})`;
      ctx.beginPath();
      ctx.arc(sx(r.pos[0]), sz(r.pos[2]), 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    if (s.goal === 'absorber') {
      // Absorber goal (magenta) — the dead-spot wall region to walk to.
      ctx.fillStyle = '#f3f';
      ctx.beginPath();
      ctx.arc(sx(s.goalTarget.x), sz(s.goalTarget.z), 5, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // beacon (green)
      ctx.fillStyle = '#4f4';
      ctx.beginPath();
      ctx.arc(sx(s.beacon.x), sz(s.beacon.z), 4, 0, Math.PI * 2);
      ctx.fill();
    }

    // player (cyan) + heading arrow. yaw: 0 faces -z; +yaw turns right (toward +x).
    const px = sx(s.player.x), pz = sz(s.player.z);
    ctx.fillStyle = '#3cf';
    ctx.beginPath(); ctx.arc(px, pz, 4, 0, Math.PI * 2); ctx.fill();
    const hx = Math.sin(s.player.yaw), hz = -Math.cos(s.player.yaw); // forward dir in world xz
    ctx.strokeStyle = '#3cf'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(px, pz); ctx.lineTo(px + hx * 12, pz + hz * 12); ctx.stroke();

    const deg = ((s.player.yaw * 180 / Math.PI) % 360 + 360) % 360;
    this.readout.textContent =
      `engine: ${s.engine}\n` +
      `pos: ${s.player.x.toFixed(1)}, ${s.player.z.toFixed(1)}  yaw: ${deg.toFixed(0)}°\n` +
      `${s.goal === 'absorber' ? 'absorber' : 'beacon'} dist: ${s.distance.toFixed(1)} m\n` +
      `reflections: ${s.reflections.length}`;
  }
}
