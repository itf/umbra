/**
 * Level editor controller: a top-down grid map where you place a start point,
 * beacons, walls, floor zones, and monsters, then save (IndexedDB) / export-import
 * (JSON). Produces a Level (src/level/schema.ts) the game can load.
 */
import {
  emptyLevel, type Level, type MaterialName,
  type WallObj, type BeaconObj, type FloorZone, type MonsterObj, type CeilingZone,
} from '../level/schema';
import {
  saveLevel, loadLevel, deleteLevel, listLevels, exportLevel, importLevel,
} from '../level/storage';
import { builtinLevels, getBuiltin } from '../level/builtins';
import {
  fitView, draw, screenToWorld, worldToScreen, type ViewState, MATERIAL_NAMES,
} from './view';
import { beaconPresetNames, resolveBeaconPreset, BeaconVoice, type BeaconPreset } from '../game/beaconSounds';
import { MONSTER_PRESETS, resolveMonsterPreset } from '../game/monsterSounds';
import { applyWallMotion } from './apply';
import { kindLabel, objectListModel } from './objectList';

type Tool = 'select' | 'start' | 'beacon' | 'wall' | 'floor' | 'ceiling' | 'monster';

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
  return null;
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
  const b = level.beacons.find((o) => o.id === id); if (b) return { kind: 'beacon', ref: b };
  const w = level.walls.find((o) => o.id === id); if (w) return { kind: 'wall', ref: w };
  const f = level.floors.find((o) => o.id === id); if (f) return { kind: 'floor', ref: f };
  const c = level.ceilings.find((o) => o.id === id); if (c) return { kind: 'ceiling', ref: c };
  const m = level.monsters.find((o) => o.id === id); if (m) return { kind: 'monster', ref: m };
  return null;
}
type StartLike =
  | { kind: 'start'; ref: Level['start'] }
  | { kind: 'beacon'; ref: BeaconObj }
  | { kind: 'wall'; ref: WallObj }
  | { kind: 'floor'; ref: FloorZone }
  | { kind: 'ceiling'; ref: CeilingZone }
  | { kind: 'monster'; ref: MonsterObj };

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
  if (tool === 'monster') {
    const m: MonsterObj = { id: genId('monster'), x: wx, z: wz, speed: 1.2, sound: 'growl' };
    level.monsters.push(m); selectedId = m.id; renderProps(); render(); return;
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
    (o.kind === 'start' ? '' : ` <span class="sel-id">${selectedId}</span>`) +
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
      ).join('')}</select></label>`);
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

function applyProp(o: StartLike, key: string, raw: string) {
  const num = parseFloat(raw);
  const r = o.ref as unknown as Record<string, unknown>;
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
  level.beacons = level.beacons.filter((o) => o.id !== selectedId);
  level.walls = level.walls.filter((o) => o.id !== selectedId);
  level.floors = level.floors.filter((o) => o.id !== selectedId);
  level.ceilings = level.ceilings.filter((o) => o.id !== selectedId);
  level.monsters = level.monsters.filter((o) => o.id !== selectedId);
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
  nameEl.value = level.name; syncRoomInputs(); renderProps(); render();
});
$('btn-save').addEventListener('click', async () => {
  level.name = nameEl.value || 'Untitled';
  await saveLevel(level);
  // Also keep a "current" copy the game's ?level=current can read.
  localStorage.setItem('papasangre-current-level', JSON.stringify(level));
  await refreshLevelList();
  flashHint(`Saved "${level.name}".`);
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
  if (l) { level = l; selectedId = null; nameEl.value = l.name; syncRoomInputs(); renderProps(); render(); }
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
    selectedId = null; nameEl.value = level.name; syncRoomInputs(); renderProps(); render();
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
}
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
refreshLevelList();
