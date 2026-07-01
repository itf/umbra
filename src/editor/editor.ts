/**
 * Level editor controller: a top-down grid map where you place a start point,
 * beacons, walls, floor zones, and monsters, then save (IndexedDB) / export-import
 * (JSON). Produces a Level (src/level/schema.ts) the game can load.
 */
import {
  emptyLevel, type Level, type MaterialName,
  type WallObj, type BeaconObj, type FloorZone, type MonsterObj, type CeilingZone,
  type WallPatch, type AmbientSource,
} from '../level/schema';
import {
  saveLevel, loadLevel, deleteLevel, listLevels, exportLevel, importLevel,
} from '../level/storage';
import { builtinLevels, getBuiltin } from '../level/builtins';
import {
  fitView, draw, screenToWorld, worldToScreen, type ViewState, MATERIAL_NAMES,
} from './view';
import { beaconPresetNames, resolveBeaconPreset, BeaconVoice, type BeaconPreset } from '../game/beaconSounds';
import { MONSTER_PRESETS, resolveMonsterPreset, MonsterVoice } from '../game/monsterSounds';
import {
  applyWallMotion, applyAbsorberProp, defaultAbsorber, lintLevel,
  applyAmbienceProp, defaultAmbience, applyEventProp, defaultEvent,
} from './apply';
import { kindLabel, objectListModel } from './objectList';

type Tool =
  | 'select' | 'start' | 'beacon' | 'wall' | 'floor' | 'ceiling' | 'monster'
  | 'absorber' | 'exit' | 'ambience' | 'win';

/** Selection id used for the level's escape `exit` Vec2 (no real object id). */
const EXIT_ID = '__exit';
/** Selection id used for the level's decoupled win point (no real object id). */
const WIN_ID = '__win';

/** Perimeter face extents (u = in-plane horizontal axis, v = height) for patches. */
function faceExtents(level: Level, wall: WallPatch['wall']): { uMax: number; vMax: number } {
  const uMax = (wall === '-x' || wall === '+x') ? level.room.depth : level.room.width;
  return { uMax, vMax: level.room.height };
}

/** Which perimeter face is a world point closest to? (for the absorber tool). */
function nearestFace(wx: number, wz: number): WallPatch['wall'] {
  const { width, depth } = level.room;
  const d: Record<WallPatch['wall'], number> = {
    '-x': Math.abs(wx), '+x': Math.abs(wx - width),
    '-z': Math.abs(wz), '+z': Math.abs(wz - depth),
  };
  return (Object.keys(d) as WallPatch['wall'][]).reduce((a, b) => (d[b] < d[a] ? b : a), '-z');
}

const $ = (id: string) => document.getElementById(id)!;
const canvas = $('canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;

let level: Level = emptyLevel();
let view: ViewState;
let tool: Tool = 'select';
let material: MaterialName = 'concrete';
let selectedId: string | null = null;

// In-progress drag (for wall draw / floor draw / move).
let drag: { kind: 'wall' | 'floor' | 'ceiling' | 'move'; ax: number; az: number; id?: string } | null = null;

let nextId = 1;
const genId = (p: string) => `${p}-${Date.now()}-${nextId++}`;

// Set true once the initial boot render completes, so boot-time renders don't mark
// the (pristine) level dirty and trigger a spurious autosave / unload prompt.
let booted = false;

// ---------- rendering ----------
function resize() {
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.floor(r.width);
  canvas.height = Math.floor(r.height);
  view = fitView(level, canvas);
  render();
}
function render() {
  view = fitView(level, canvas);
  draw(ctx, canvas, level, view, { selectedId, grid: true });
  renderObjectList();
  if (booted) markDirty(); // any re-render after boot reflects an edit ⇒ autosave
}

/** Select an object by id (as if clicked on the canvas) and reveal its props. */
function selectById(id: string) {
  selectedId = id;
  renderProps();
  render();
}

/** Build the "Objects" outline: a clickable button per object, kept in sync. */
function renderObjectList() {
  const host = $('object-list');
  const entries = objectListModel(level);
  host.innerHTML = entries.map((e) =>
    `<button class="obj-item${e.id === selectedId ? ' selected' : ''}" data-id="${e.id}">${e.label}</button>`,
  ).join('');
  host.querySelectorAll<HTMLButtonElement>('.obj-item').forEach((btn) =>
    btn.addEventListener('click', () => selectById(btn.dataset.id!)));
}

// ---------- helpers ----------
function snap(v: number): number {
  return Math.round(v * 2) / 2; // 0.5 m grid
}
function worldAt(e: PointerEvent): [number, number] {
  const r = canvas.getBoundingClientRect();
  const [wx, wz] = screenToWorld(view, e.clientX - r.left, e.clientY - r.top);
  return [snap(wx), snap(wz)];
}

/** Hit-test the topmost object near a world point; returns its id or null. */
function hitTest(wx: number, wz: number): string | null {
  const near = 0.5;
  if (level.exit && Math.hypot(level.exit.x - wx, level.exit.z - wz) < near) return EXIT_ID;
  if (level.winPoint && Math.hypot(level.winPoint.x - wx, level.winPoint.z - wz) < near) return WIN_ID;
  for (const a of level.ambience ?? []) if (Math.hypot(a.x - wx, a.z - wz) < near) return a.id;
  for (const m of level.monsters) if (Math.hypot(m.x - wx, m.z - wz) < near) return m.id;
  for (const b of level.beacons) if (Math.hypot(b.x - wx, b.z - wz) < near) return b.id;
  if (Math.hypot(level.start.x - wx, level.start.z - wz) < near) return 'start';
  for (const w of level.walls) {
    if (distToSeg(wx, wz, w.ax, w.az, w.bx, w.bz) < 0.4) return w.id;
  }
  for (const c of level.ceilings) {
    if (wx >= c.x && wx <= c.x + c.w && wz >= c.z && wz <= c.z + c.d) return c.id;
  }
  for (const f of level.floors) {
    if (wx >= f.x && wx <= f.x + f.w && wz >= f.z && wz <= f.z + f.d) return f.id;
  }
  for (const p of level.absorbers ?? []) {
    const seg = absorberSeg(p);
    if (distToSeg(wx, wz, seg.ax, seg.az, seg.bx, seg.bz) < 0.4) return p.id;
  }
  return null;
}

/** The patch's footprint as a 2D segment along its perimeter face (top-down). */
function absorberSeg(p: WallPatch): { ax: number; az: number; bx: number; bz: number } {
  const { width, depth } = level.room;
  const u0 = p.u0, u1 = p.u0 + p.uSize;
  switch (p.wall) {
    case '-x': return { ax: 0, az: u0, bx: 0, bz: u1 };
    case '+x': return { ax: width, az: u0, bx: width, bz: u1 };
    case '-z': return { ax: u0, az: 0, bx: u1, bz: 0 };
    case '+z': return { ax: u0, az: depth, bx: u1, bz: depth };
  }
}
function distToSeg(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az;
  const len2 = dx * dx + dz * dz || 1;
  let t = ((px - ax) * dx + (pz - az) * dz) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}
function findObj(id: string): StartLike | null {
  if (id === 'start') return { kind: 'start', ref: level.start };
  if (id === EXIT_ID && level.exit) return { kind: 'exit', ref: level.exit };
  if (id === WIN_ID && level.winPoint) return { kind: 'win', ref: level.winPoint };
  const a = level.ambience?.find((o) => o.id === id); if (a) return { kind: 'ambience', ref: a };
  const b = level.beacons.find((o) => o.id === id); if (b) return { kind: 'beacon', ref: b };
  const w = level.walls.find((o) => o.id === id); if (w) return { kind: 'wall', ref: w };
  const f = level.floors.find((o) => o.id === id); if (f) return { kind: 'floor', ref: f };
  const c = level.ceilings.find((o) => o.id === id); if (c) return { kind: 'ceiling', ref: c };
  const m = level.monsters.find((o) => o.id === id); if (m) return { kind: 'monster', ref: m };
  const p = level.absorbers?.find((o) => o.id === id); if (p) return { kind: 'absorber', ref: p };
  return null;
}
type StartLike =
  | { kind: 'start'; ref: Level['start'] }
  | { kind: 'beacon'; ref: BeaconObj }
  | { kind: 'wall'; ref: WallObj }
  | { kind: 'floor'; ref: FloorZone }
  | { kind: 'ceiling'; ref: CeilingZone }
  | { kind: 'monster'; ref: MonsterObj }
  | { kind: 'absorber'; ref: WallPatch }
  | { kind: 'exit'; ref: NonNullable<Level['exit']> }
  | { kind: 'ambience'; ref: AmbientSource }
  | { kind: 'win'; ref: NonNullable<Level['winPoint']> };

// ---------- pointer interaction ----------
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  const [wx, wz] = worldAt(e);

  if (tool === 'select') {
    const id = hitTest(wx, wz);
    selectedId = id;
    if (id) drag = { kind: 'move', ax: wx, az: wz, id };
    renderProps(); render();
    return;
  }
  if (tool === 'start') {
    level.start.x = wx; level.start.z = wz; selectedId = 'start'; renderProps(); render(); return;
  }
  if (tool === 'beacon') {
    const b: BeaconObj = { id: genId('beacon'), x: wx, z: wz, freq: 440, goalRadius: 0.8 };
    level.beacons.push(b); selectedId = b.id; renderProps(); render(); return;
  }
  if (tool === 'exit') {
    level.exit = { x: wx, z: wz }; selectedId = EXIT_ID; renderProps(); render(); return;
  }
  if (tool === 'monster') {
    const m: MonsterObj = { id: genId('monster'), x: wx, z: wz, speed: 1.2, sound: 'growl' };
    level.monsters.push(m); selectedId = m.id; renderProps(); render(); return;
  }
  if (tool === 'ambience') {
    const a = defaultAmbience(genId('amb'), wx, wz);
    (level.ambience ??= []).push(a);
    selectedId = a.id; renderProps(); render(); return;
  }
  if (tool === 'win') {
    level.winPoint = { x: wx, z: wz };
    if (level.winRadius == null) level.winRadius = 0.9;
    selectedId = WIN_ID; renderProps(); render(); return;
  }
  if (tool === 'absorber') {
    // Place a default patch on the perimeter face nearest the click point; the author
    // then refines the wall/rectangle/material in the props panel. The click's u
    // (in-plane position) seeds the patch so it lands roughly where you clicked.
    const wall = nearestFace(wx, wz);
    const { uMax, vMax } = faceExtents(level, wall);
    const p = defaultAbsorber(genId('foam'), wall, material, uMax, vMax);
    // Centre the patch's u on the click's in-plane coordinate, clamped on-face.
    const u = (wall === '-x' || wall === '+x') ? wz : wx;
    p.u0 = Math.max(0, Math.min(uMax - p.uSize, u - p.uSize / 2));
    (level.absorbers ??= []).push(p);
    selectedId = p.id; renderProps(); render(); return;
  }
  if (tool === 'wall') { drag = { kind: 'wall', ax: wx, az: wz }; return; }
  if (tool === 'floor') { drag = { kind: 'floor', ax: wx, az: wz }; return; }
  if (tool === 'ceiling') { drag = { kind: 'ceiling', ax: wx, az: wz }; return; }
});

canvas.addEventListener('pointermove', (e) => {
  const r = canvas.getBoundingClientRect();
  const [wx, wz] = worldAt(e);
  ($('coords') as HTMLElement).textContent = `x ${wx.toFixed(1)}  z ${wz.toFixed(1)}`;

  if (!drag) return;
  if (drag.kind === 'move' && drag.id) {
    moveObject(drag.id, wx - drag.ax, wz - drag.az);
    drag.ax = wx; drag.az = wz;
    renderProps(); render();
  } else if (drag.kind === 'wall' || drag.kind === 'floor' || drag.kind === 'ceiling') {
    // Preview: redraw then overlay the in-progress shape.
    render();
    const [sx, sy] = worldToScreen(view, drag.ax, drag.az);
    const [ex, ey] = worldToScreen(view, wx, wz);
    ctx.strokeStyle = drag.kind === 'ceiling' ? '#5bd1ff' : '#ffd166';
    ctx.lineWidth = 2;
    if (drag.kind === 'wall') {
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
    } else {
      ctx.strokeRect(Math.min(sx, ex), Math.min(sy, ey), Math.abs(ex - sx), Math.abs(ey - sy));
    }
  }
  void r;
});

canvas.addEventListener('pointerup', (e) => {
  if (!drag) return;
  const [wx, wz] = worldAt(e);
  if (drag.kind === 'wall' && (wx !== drag.ax || wz !== drag.az)) {
    const w: WallObj = { id: genId('wall'), ax: drag.ax, az: drag.az, bx: wx, bz: wz, material };
    level.walls.push(w); selectedId = w.id;
  } else if (drag.kind === 'floor') {
    const x = Math.min(drag.ax, wx), z = Math.min(drag.az, wz);
    const fw = Math.abs(wx - drag.ax), d = Math.abs(wz - drag.az);
    if (fw > 0.4 && d > 0.4) {
      const f: FloorZone = { id: genId('floor'), x, z, w: fw, d, material };
      level.floors.push(f); selectedId = f.id;
    }
  } else if (drag.kind === 'ceiling') {
    const x = Math.min(drag.ax, wx), z = Math.min(drag.az, wz);
    const cw = Math.abs(wx - drag.ax), d = Math.abs(wz - drag.az);
    if (cw > 0.4 && d > 0.4) {
      const c: CeilingZone = {
        id: genId('ceiling'), x, z, w: cw, d,
        height: Math.max(1, level.room.height - 1), material,
      };
      level.ceilings.push(c); selectedId = c.id;
    }
  }
  drag = null;
  renderProps(); render();
});

function moveObject(id: string, dx: number, dz: number) {
  const o = findObj(id);
  if (!o) return;
  if (o.kind === 'wall') {
    o.ref.ax += dx; o.ref.az += dz; o.ref.bx += dx; o.ref.bz += dz;
  } else if (o.kind === 'absorber') {
    // Slide the patch along its face: u advances with the in-plane drag component,
    // clamped so it stays on-face.
    const p = o.ref;
    const { uMax } = faceExtents(level, p.wall);
    const du = (p.wall === '-x' || p.wall === '+x') ? dz : dx;
    p.u0 = Math.max(0, Math.min(uMax - p.uSize, p.u0 + du));
  } else {
    // floor / ceiling / beacon / monster / start all have x,z.
    o.ref.x += dx; o.ref.z += dz;
  }
}

// ---------- properties panel ----------
function renderProps() {
  const host = $('props');
  if (!selectedId) { host.innerHTML = '<p class="hint">Nothing selected.</p>'; return; }
  const o = findObj(selectedId);
  if (!o) { host.innerHTML = '<p class="hint">Nothing selected.</p>'; return; }

  // Announce WHAT is selected: a clear kind heading + the object's id.
  const heading =
    `<div class="sel-kind">${kindLabel(o.kind)}` +
    (o.kind === 'start' || o.kind === 'exit' ? '' : ` <span class="sel-id">${selectedId}</span>`) +
    '</div>';

  const rows: string[] = [];
  const numRow = (label: string, key: string, val: number, step = 0.5) =>
    `<label>${label}<input data-k="${key}" type="number" step="${step}" value="${val}"></label>`;
  const matRow = (val: string) =>
    `<label>Material<select data-k="material">${MATERIAL_NAMES.map(
      (m) => `<option ${m === val ? 'selected' : ''}>${m}</option>`,
    ).join('')}</select></label>`;

  if (o.kind === 'start') {
    rows.push(numRow('x', 'x', o.ref.x), numRow('z', 'z', o.ref.z),
      numRow('yaw°', 'yawDeg', Math.round((o.ref.yaw * 180) / Math.PI), 5));
  } else if (o.kind === 'exit') {
    rows.push(numRow('x', 'x', o.ref.x), numRow('z', 'z', o.ref.z));
  } else if (o.kind === 'beacon') {
    rows.push(numRow('x', 'x', o.ref.x), numRow('z', 'z', o.ref.z),
      numRow('freq', 'freq', o.ref.freq, 10), numRow('goal r', 'goalRadius', o.ref.goalRadius, 0.1));
    const cur = resolveBeaconPreset(o.ref.sound);
    rows.push(
      `<label>sound<select data-k="sound">${beaconPresetNames().map(
        (p) => `<option ${p === cur ? 'selected' : ''}>${p}</option>`,
      ).join('')}</select></label>`,
      `<label>custom url<input data-k="soundUrl" value="${o.ref.soundUrl ?? ''}"></label>`,
      '<button class="row-btn" id="preview-beacon">Preview sound</button>',
    );
  } else if (o.kind === 'wall') {
    rows.push(numRow('ax', 'ax', o.ref.ax), numRow('az', 'az', o.ref.az),
      numRow('bx', 'bx', o.ref.bx), numRow('bz', 'bz', o.ref.bz), matRow(o.ref.material));
    // --- Motion: none / translate (ping-pong) / slide (door) ---
    const mk = o.ref.motion?.kind ?? 'none';
    rows.push(
      `<label>motion<select data-k="motionKind">${
        ['none', 'translate', 'slide'].map(
          (k) => `<option ${k === mk ? 'selected' : ''}>${k}</option>`,
        ).join('')
      }</select></label>`,
    );
    if (o.ref.motion?.kind === 'translate') {
      rows.push(
        numRow('move dx', 'motionDx', o.ref.motion.dx, 0.5),
        numRow('move dz', 'motionDz', o.ref.motion.dz, 0.5),
        numRow('period s', 'motionPeriod', o.ref.motion.period, 0.5),
      );
    } else if (o.ref.motion?.kind === 'slide') {
      rows.push(
        numRow('open frac', 'motionOpen', o.ref.motion.openFraction, 0.1),
        numRow('period s', 'motionPeriod', o.ref.motion.period, 0.5),
      );
    }
  } else if (o.kind === 'floor') {
    rows.push(numRow('x', 'x', o.ref.x), numRow('z', 'z', o.ref.z),
      numRow('w', 'w', o.ref.w), numRow('d', 'd', o.ref.d), matRow(o.ref.material));
  } else if (o.kind === 'ceiling') {
    rows.push(numRow('x', 'x', o.ref.x), numRow('z', 'z', o.ref.z),
      numRow('w', 'w', o.ref.w), numRow('d', 'd', o.ref.d),
      numRow('height', 'height', o.ref.height), matRow(o.ref.material));
  } else if (o.kind === 'monster') {
    const mcur = resolveMonsterPreset(o.ref.sound);
    rows.push(numRow('x', 'x', o.ref.x), numRow('z', 'z', o.ref.z),
      numRow('speed', 'speed', o.ref.speed, 0.1),
      `<label>sound<select data-k="sound">${MONSTER_PRESETS.map(
        (p) => `<option ${p === mcur ? 'selected' : ''}>${p}</option>`,
      ).join('')}</select></label>`,
      `<label>custom url<input data-k="soundUrl" value="${o.ref.soundUrl ?? ''}"></label>`,
      '<button class="row-btn" id="preview-monster">Preview sound</button>');
  } else if (o.kind === 'ambience') {
    const acur = resolveBeaconPreset(o.ref.sound);
    rows.push(numRow('x', 'x', o.ref.x), numRow('z', 'z', o.ref.z),
      numRow('freq', 'freq', o.ref.freq ?? 220, 10),
      numRow('gain', 'gain', o.ref.gain ?? 1, 0.1),
      `<label>sound<select data-k="sound">${beaconPresetNames().map(
        (p) => `<option ${p === acur ? 'selected' : ''}>${p}</option>`,
      ).join('')}</select></label>`,
      `<label>custom url<input data-k="soundUrl" value="${o.ref.soundUrl ?? ''}"></label>`,
      '<button class="row-btn" id="preview-ambience">Preview sound</button>');
  } else if (o.kind === 'win') {
    rows.push(numRow('x', 'x', o.ref.x), numRow('z', 'z', o.ref.z),
      numRow('win radius', 'winRadius', level.winRadius ?? 0.9, 0.1));
  } else if (o.kind === 'absorber') {
    rows.push(
      `<label>wall<select data-k="wall">${
        (['-x', '+x', '-z', '+z'] as const).map(
          (f) => `<option ${f === o.ref.wall ? 'selected' : ''}>${f}</option>`,
        ).join('')
      }</select></label>`,
      numRow('u0 (along)', 'u0', o.ref.u0, 0.5),
      numRow('v0 (height)', 'v0', o.ref.v0, 0.1),
      numRow('u size', 'uSize', o.ref.uSize, 0.5),
      numRow('v size', 'vSize', o.ref.vSize, 0.1),
      matRow(o.ref.material));
  }
  const canDelete = o.kind !== 'start';
  host.innerHTML = heading + rows.join('') +
    (canDelete ? '<button class="row-btn" id="del-obj">Delete object</button>' : '');

  host.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-k]').forEach((el) => {
    el.addEventListener('input', () => applyProp(o, el.dataset.k!, el.value));
  });
  $('del-obj')?.addEventListener('click', () => deleteSelected());
  if (o.kind === 'beacon') {
    $('preview-beacon')?.addEventListener('click', () => previewBeacon(o.ref as BeaconObj));
  }
  if (o.kind === 'monster') {
    $('preview-monster')?.addEventListener('click', () => previewMonster(o.ref as MonsterObj));
  }
  if (o.kind === 'ambience') {
    $('preview-ambience')?.addEventListener('click', () => {
      const a = o.ref as AmbientSource;
      previewBeacon({ id: a.id, x: a.x, z: a.z, freq: a.freq ?? 220, goalRadius: 0, sound: a.sound });
    });
  }
}

// Lazily-created AudioContext for the editor's beacon preview.
let previewCtx: AudioContext | null = null;
let previewVoice: BeaconVoice | null = null;
function previewBeacon(b: BeaconObj) {
  previewCtx ??= new AudioContext();
  void previewCtx.resume();
  previewVoice?.stop();
  const preset: BeaconPreset = resolveBeaconPreset(b.sound);
  const gain = previewCtx.createGain();
  gain.gain.value = 0.5;
  gain.connect(previewCtx.destination);
  previewVoice = new BeaconVoice(previewCtx, gain, preset, b.freq);
  previewVoice.start();
  // Auto-stop after a couple of seconds so it's a sample, not a drone.
  window.setTimeout(() => previewVoice?.stop(), 2500);
}

// Monster-sound preview — reuses the editor's preview AudioContext (like the beacon).
let previewMonsterVoice: MonsterVoice | null = null;
function previewMonster(m: MonsterObj) {
  previewCtx ??= new AudioContext();
  void previewCtx.resume();
  previewMonsterVoice?.stop();
  const gain = previewCtx.createGain();
  gain.gain.value = 0.6;
  gain.connect(previewCtx.destination);
  previewMonsterVoice = new MonsterVoice(previewCtx, gain, resolveMonsterPreset(m.sound));
  previewMonsterVoice.start();
  window.setTimeout(() => previewMonsterVoice?.stop(), 2500);
}

function applyProp(o: StartLike, key: string, raw: string) {
  const num = parseFloat(raw);
  const r = o.ref as unknown as Record<string, unknown>;
  if (o.kind === 'absorber') {
    if (applyAbsorberProp(o.ref, key, raw, num)) {
      renderProps(); // a wall change re-clamps the rectangle preview
      render();
      return;
    }
  }
  if (o.kind === 'ambience') {
    if (applyAmbienceProp(o.ref, key, raw, num)) { render(); return; }
  }
  if (o.kind === 'win') {
    // The win point's x/z live on level.winPoint (o.ref); winRadius is a Level field.
    if (key === 'winRadius') {
      if (!Number.isNaN(num) && num > 0) level.winRadius = num;
      render(); return;
    }
    if ((key === 'x' || key === 'z') && !Number.isNaN(num)) { r[key] = num; render(); return; }
  }
  if (key === 'yawDeg') { (level.start.yaw as number) = (num * Math.PI) / 180; }
  else if (key === 'material' || key === 'sound' || key === 'soundUrl') {
    if (key === 'soundUrl' && raw === '') delete r.soundUrl;
    else r[key] = raw;
  }
  else if (o.kind === 'wall' && key.startsWith('motion')) {
    applyWallMotion(o.ref, key, raw, num);
    renderProps(); // motion-kind change toggles which param fields show
    render();
    return;
  }
  else if (!Number.isNaN(num)) { r[key] = num; }
  render();
}

function deleteSelected() {
  if (!selectedId || selectedId === 'start') return;
  if (selectedId === EXIT_ID) { delete level.exit; selectedId = null; renderProps(); render(); return; }
  if (selectedId === WIN_ID) {
    delete level.winPoint; delete level.winRadius; selectedId = null; renderProps(); render(); return;
  }
  if (level.ambience) level.ambience = level.ambience.filter((o) => o.id !== selectedId);
  level.beacons = level.beacons.filter((o) => o.id !== selectedId);
  level.walls = level.walls.filter((o) => o.id !== selectedId);
  level.floors = level.floors.filter((o) => o.id !== selectedId);
  level.ceilings = level.ceilings.filter((o) => o.id !== selectedId);
  level.monsters = level.monsters.filter((o) => o.id !== selectedId);
  if (level.absorbers) level.absorbers = level.absorbers.filter((o) => o.id !== selectedId);
  selectedId = null; renderProps(); render();
}

// ---------- toolbar wiring ----------
function setTool(t: Tool) {
  tool = t;
  document.querySelectorAll<HTMLButtonElement>('.tool').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.tool === t)));
  ($('hint') as HTMLElement).textContent =
    t === 'select' ? 'Click an object to select; drag to move.'
    : t === 'wall' ? 'Drag to draw a wall.'
    : t === 'floor' ? 'Drag to draw a floor zone.'
    : t === 'absorber' ? 'Click near a perimeter wall to place a material patch, then size it in the panel.'
    : t === 'exit' ? 'Click to place the escape exit (the win target in escape mode).'
    : t === 'ambience' ? 'Click to place an ambient (non-goal) sound source, then pick its preset in the panel.'
    : t === 'win' ? 'Click to set the win area (winPoint). Set its radius in the panel. Works with zero beacons.'
    : `Click to place a ${t}.`;
}
document.querySelectorAll<HTMLButtonElement>('.tool').forEach((b) =>
  b.addEventListener('click', () => setTool(b.dataset.tool as Tool)));

const matSel = $('material') as HTMLSelectElement;
matSel.innerHTML = MATERIAL_NAMES.map((m) => `<option>${m}</option>`).join('');
matSel.addEventListener('change', () => (material = matSel.value as MaterialName));

// Room dims.
function bindRoom(id: string, key: 'width' | 'depth' | 'height') {
  const el = $(id) as HTMLInputElement;
  el.value = String(level.room[key]);
  el.addEventListener('input', () => {
    const n = parseFloat(el.value);
    if (!Number.isNaN(n) && n > 0) { level.room[key] = n; render(); }
  });
}
bindRoom('room-w', 'width'); bindRoom('room-d', 'depth'); bindRoom('room-h', 'height');

// Default materials for the perimeter wall / floor / ceiling (schema fields that
// otherwise had no UI). Each is a material dropdown that writes the Level field.
function bindRoomMaterial(id: string, key: 'roomMaterial' | 'floorMaterial' | 'ceilingMaterial') {
  const el = $(id) as HTMLSelectElement;
  el.innerHTML = MATERIAL_NAMES.map((m) => `<option>${m}</option>`).join('');
  el.value = level[key];
  el.addEventListener('change', () => { level[key] = el.value as MaterialName; render(); });
}
bindRoomMaterial('room-mat', 'roomMaterial');
bindRoomMaterial('floor-mat', 'floorMaterial');
bindRoomMaterial('ceil-mat', 'ceilingMaterial');

// Open-space toggle: opening a level removes its ceiling by default (sky).
const openEl = $('room-open') as HTMLInputElement;
const ceilEl = $('room-ceil') as HTMLInputElement;
const ceilHEl = $('ceil-h') as HTMLInputElement;
openEl.checked = level.open;
openEl.addEventListener('change', () => {
  level.open = openEl.checked;
  if (level.open) level.hasCeiling = false;
  ceilEl.checked = level.hasCeiling;
  render();
});
// Ceiling toggle + default ceiling height.
ceilEl.checked = level.hasCeiling;
ceilEl.addEventListener('change', () => { level.hasCeiling = ceilEl.checked; render(); });
ceilHEl.value = String(level.room.height);
ceilHEl.addEventListener('input', () => {
  const n = parseFloat(ceilHEl.value);
  if (!Number.isNaN(n) && n > 0) { level.room.height = n; render(); }
});

// Speed of sound (m/s) — "alien physics". Empty ⇒ field unset (engine default
// 343). Only a finite value > 1 is stored; anything else clears it.
const sosEl = $('room-sos') as HTMLInputElement;
sosEl.value = level.speedOfSound != null ? String(level.speedOfSound) : '';
sosEl.addEventListener('input', () => {
  const n = parseFloat(sosEl.value);
  if (sosEl.value.trim() !== '' && Number.isFinite(n) && n > 1) level.speedOfSound = n;
  else delete level.speedOfSound;
});

// Objective: goal mode (beacon | absorber). Writes level.goal; 'beacon' is the
// default so we leave it implicit (delete the field) to keep old levels byte-identical.
const goalEl = $('goal-mode') as HTMLSelectElement;
goalEl.value = level.goal ?? 'beacon';
goalEl.addEventListener('change', () => {
  if (goalEl.value === 'absorber') level.goal = 'absorber';
  else if (goalEl.value === 'escape') level.goal = 'escape';
  else delete level.goal;
  markDirty(); render(); // re-render the object list "(goal)" badges
});

// Decoy budget (escape mode's stealth verb). Empty/0/invalid ⇒ field unset
// (unlimited), mirroring the clapBudget pattern so old levels stay unchanged.
const decoyEl = $('decoy-budget') as HTMLInputElement;
decoyEl.value = level.decoyBudget != null ? String(level.decoyBudget) : '';
decoyEl.addEventListener('input', () => {
  const n = parseFloat(decoyEl.value);
  if (decoyEl.value.trim() !== '' && Number.isFinite(n) && n > 0) level.decoyBudget = n;
  else delete level.decoyBudget;
  markDirty();
});

// Sonar budget: max claps + cooldown. Empty/0/invalid ⇒ field unset (unlimited /
// no cooldown), mirroring the speedOfSound pattern so old levels stay unchanged.
function bindClapField(id: string, key: 'clapBudget' | 'clapCooldownMs') {
  const el = $(id) as HTMLInputElement;
  el.value = level[key] != null ? String(level[key]) : '';
  el.addEventListener('input', () => {
    const n = parseFloat(el.value);
    if (el.value.trim() !== '' && Number.isFinite(n) && n > 0) level[key] = n;
    else delete level[key];
    markDirty();
  });
}
bindClapField('clap-budget', 'clapBudget');
bindClapField('clap-cooldown', 'clapCooldownMs');

// Clutter (0..1): empty/0 ⇒ field unset (bare room). Mirrors the budget pattern.
const clutterEl = $('room-clutter') as HTMLInputElement;
clutterEl.value = level.clutter != null ? String(level.clutter) : '';
clutterEl.addEventListener('input', () => {
  const n = parseFloat(clutterEl.value);
  if (clutterEl.value.trim() !== '' && Number.isFinite(n) && n > 0) level.clutter = Math.min(1, n);
  else delete level.clutter;
  markDirty();
});

// Required reactions (reaction-mode win gate). Empty/0 ⇒ field unset (ungated).
const reqRxEl = $('required-reactions') as HTMLInputElement;
reqRxEl.value = level.requiredReactions != null ? String(level.requiredReactions) : '';
reqRxEl.addEventListener('input', () => {
  const n = parseFloat(reqRxEl.value);
  if (reqRxEl.value.trim() !== '' && Number.isFinite(n) && n > 0) level.requiredReactions = Math.floor(n);
  else delete level.requiredReactions;
  markDirty();
});

// --- Reaction events editor (level-global; each event names an ambient source) ---
function renderEvents() {
  const host = $('events-editor');
  const events = level.events ?? [];
  const ambOpts = (level.ambience ?? []).map((a) => a.id);
  if (events.length === 0) {
    host.innerHTML = '<p class="hint">No reaction events. Add one (needs an ambient source).</p>';
    return;
  }
  host.innerHTML = events.map((e, i) => {
    const srcOpts = (ambOpts.length ? ambOpts : [e.sourceId]).map(
      (id) => `<option ${id === e.sourceId ? 'selected' : ''}>${id}</option>`,
    ).join('');
    return `<fieldset class="event-row" data-i="${i}">
      <legend>${e.id}</legend>
      <label>type<select data-ek="type">${
        ['crossing', 'occlusion', 'door'].map((t) => `<option ${t === e.type ? 'selected' : ''}>${t}</option>`).join('')
      }</select></label>
      <label>source<select data-ek="sourceId">${srcOpts}</select></label>
      <label>start s<input data-ek="start" type="number" step="0.5" value="${e.start}"></label>
      <label>end s<input data-ek="end" type="number" step="0.5" value="${e.end}"></label>
      <button class="row-btn" data-del-event="${i}">Delete event</button>
    </fieldset>`;
  }).join('');
  host.querySelectorAll<HTMLElement>('.event-row').forEach((row) => {
    const i = Number(row.dataset.i);
    row.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-ek]').forEach((el) => {
      el.addEventListener('input', () => {
        const ev = (level.events ?? [])[i];
        if (!ev) return;
        applyEventProp(ev, el.dataset.ek!, el.value, parseFloat(el.value));
        markDirty();
        renderEvents(); // re-clamp the window display
      });
    });
    row.querySelector('[data-del-event]')?.addEventListener('click', () => {
      level.events?.splice(i, 1);
      if (level.events && level.events.length === 0) delete level.events;
      markDirty(); renderEvents(); render();
    });
  });
}
$('btn-add-event').addEventListener('click', () => {
  const firstAmb = (level.ambience ?? [])[0]?.id ?? '';
  if (!firstAmb) { flashHint('Add an ambient source first — events target one.'); return; }
  (level.events ??= []).push(defaultEvent(genId('event'), firstAmb));
  markDirty(); renderEvents();
});

// Name.
const nameEl = $('level-name') as HTMLInputElement;
nameEl.value = level.name;
nameEl.addEventListener('input', () => (level.name = nameEl.value || 'Untitled'));

// ---------- file / storage ----------
async function refreshLevelList() {
  const names = await listLevels();
  const sel = $('level-list') as HTMLSelectElement;
  // Demo (built-in) levels are read-only; selecting one loads an editable COPY.
  // Saved levels (IndexedDB) load in place. Option values are namespaced so the
  // change handler can tell them apart.
  const demos = builtinLevels()
    .map((b) => `<option value="builtin:${b.id}">${b.name}</option>`)
    .join('');
  const saved = names.map((n) => `<option value="saved:${n}">${n}</option>`).join('');
  sel.innerHTML =
    '<option value="">— load —</option>' +
    `<optgroup label="Demo levels (loads a copy)">${demos}</optgroup>` +
    (saved ? `<optgroup label="Your saved levels">${saved}</optgroup>` : '');
}

$('btn-new').addEventListener('click', () => {
  level = emptyLevel(); selectedId = null;
  nameEl.value = level.name; syncRoomInputs(); renderProps(); render(); markClean();
});
$('btn-save').addEventListener('click', async () => {
  level.name = nameEl.value || 'Untitled';
  await saveLevel(level);
  // Also keep a "current" copy the game's ?level=current can read.
  localStorage.setItem('papasangre-current-level', JSON.stringify(level));
  await refreshLevelList();
  markClean();
  // Non-blocking lint: surface likely authoring mistakes without preventing the save.
  const warnings = lintLevel(level);
  if (warnings.length) flashHint(`Saved "${level.name}". ⚠ ${warnings.join(' ')}`);
  else flashHint(`Saved "${level.name}".`);
});
($('level-list') as HTMLSelectElement).addEventListener('change', async (e) => {
  const sel = e.target as HTMLSelectElement;
  const value = sel.value;
  if (!value) return;
  let l: typeof level | undefined;
  if (value.startsWith('builtin:')) {
    // Built-in demos are read-only — load an editable COPY (deep-cloned by
    // getBuiltin) with a distinct name so saving won't clobber anything.
    const base = getBuiltin(value.slice('builtin:'.length));
    if (base) { l = base; l.name = `${base.name} (copy)`; }
  } else if (value.startsWith('saved:')) {
    l = await loadLevel(value.slice('saved:'.length));
  }
  if (l) { level = l; selectedId = null; nameEl.value = l.name; syncRoomInputs(); renderProps(); render(); markClean(); }
  sel.value = ''; // reset so re-selecting the same entry fires change again
});
$('btn-delete').addEventListener('click', async () => {
  const name = nameEl.value;
  if (name) { await deleteLevel(name); await refreshLevelList(); flashHint(`Deleted "${name}".`); }
});
$('btn-export').addEventListener('click', () => {
  const blob = new Blob([exportLevel(level)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${level.name.replace(/\s+/g, '-').toLowerCase()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});
$('btn-import').addEventListener('click', () => ($('file-input') as HTMLInputElement).click());
($('file-input') as HTMLInputElement).addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    level = importLevel(await file.text());
    selectedId = null; nameEl.value = level.name; syncRoomInputs(); renderProps(); render(); markClean();
    flashHint(`Imported "${level.name}".`);
  } catch (err) {
    flashHint('Import failed: ' + (err as Error).message);
  }
});
// Play uses the saved "current" level.
$('btn-play').addEventListener('click', () => {
  localStorage.setItem('papasangre-current-level', JSON.stringify(level));
});

function syncRoomInputs() {
  ($('room-w') as HTMLInputElement).value = String(level.room.width);
  ($('room-d') as HTMLInputElement).value = String(level.room.depth);
  ($('room-h') as HTMLInputElement).value = String(level.room.height);
  ($('ceil-h') as HTMLInputElement).value = String(level.room.height);
  ($('room-open') as HTMLInputElement).checked = !!level.open;
  ($('room-ceil') as HTMLInputElement).checked = !!level.hasCeiling;
  ($('room-mat') as HTMLSelectElement).value = level.roomMaterial;
  ($('floor-mat') as HTMLSelectElement).value = level.floorMaterial;
  ($('ceil-mat') as HTMLSelectElement).value = level.ceilingMaterial;
  ($('room-sos') as HTMLInputElement).value =
    level.speedOfSound != null ? String(level.speedOfSound) : '';
  ($('goal-mode') as HTMLSelectElement).value = level.goal ?? 'beacon';
  ($('decoy-budget') as HTMLInputElement).value =
    level.decoyBudget != null ? String(level.decoyBudget) : '';
  ($('clap-budget') as HTMLInputElement).value =
    level.clapBudget != null ? String(level.clapBudget) : '';
  ($('clap-cooldown') as HTMLInputElement).value =
    level.clapCooldownMs != null ? String(level.clapCooldownMs) : '';
  ($('room-clutter') as HTMLInputElement).value =
    level.clutter != null ? String(level.clutter) : '';
  ($('required-reactions') as HTMLInputElement).value =
    level.requiredReactions != null ? String(level.requiredReactions) : '';
  renderEvents();
}
// ---------- autosave + unsaved-changes guard ----------
// Debounced autosave to the "current" slot (what the game's ?level=current reads),
// plus a beforeunload guard so a reload doesn't silently lose work. `dirty` tracks
// whether there are edits since the last explicit Save.
let dirty = false;
let autosaveTimer = 0;
function markDirty() {
  dirty = true;
  clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem('papasangre-current-level', JSON.stringify(level));
      localStorage.setItem('papasangre-editor-autosave', JSON.stringify(level));
    } catch { /* storage full / unavailable — best-effort */ }
  }, 800);
}
/** Clear the dirty flag after an explicit Save / New / Load. */
function markClean() { dirty = false; clearTimeout(autosaveTimer); }
window.addEventListener('beforeunload', (e) => {
  if (!dirty) return;
  e.preventDefault();
  e.returnValue = ''; // triggers the browser's "unsaved changes" prompt
});

let hintTimer = 0;
function flashHint(msg: string) {
  const el = $('hint') as HTMLElement;
  el.textContent = msg;
  clearTimeout(hintTimer);
  hintTimer = window.setTimeout(() => (el.textContent = 'Ready.'), 2500);
}

// Delete/backspace removes selection.
window.addEventListener('keydown', (e) => {
  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId && document.activeElement === canvas) {
    e.preventDefault(); deleteSelected();
  }
});

// ---------- boot ----------
window.addEventListener('resize', resize);
setTool('select');
resize();
renderProps();
renderEvents();
refreshLevelList();
booted = true; // boot renders done; subsequent renders are real edits (autosave on)
