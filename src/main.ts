import { startAudio, type AudioGraph } from './engine/audioGraph';
import { HrtfRenderer } from './engine/hrtf/renderer';
import { Compass } from './game/compass';
import { initAcoustics } from './engine/acoustics/core';
import { ClapRoom } from './engine/acoustics/clapRoom';
import type { WallDef, EdgeDef } from './engine/acoustics/core';
import { Game, type GameLevel } from './game/game';
import { Heading } from './game/heading';
import { currentEditorLevel, loadLevel, boxRoomWalls, wallsAt, diffractionEdgesAt, liveRebuildSignature } from './level/load';
import { getBuiltin, builtinLevels } from './level/builtins';
import { loadLevel as loadSavedLevel, listLevels } from './level/storage';
import type { Level } from './level/schema';
import { renderLevelPicker, type PickerSelection } from './ui/levelPicker';

const HRTF_URL = '/assets/hrtf/sadie_h3.hrtf';

const statusEl = document.getElementById('status')!;
const alertsEl = document.getElementById('alerts')!;
const pickerScreen = document.getElementById('picker-screen')!;
const startScreen = document.getElementById('start-screen')!;
const gameScreen = document.getElementById('game-screen')!;
const startButton = document.getElementById('start-button') as HTMLButtonElement;
const backButton = document.getElementById('back-to-picker') as HTMLButtonElement | null;
const startLevelName = document.getElementById('start-level-name');

function say(msg: string) {
  statusEl.textContent = msg;
}
function alert(msg: string) {
  alertsEl.textContent = msg;
}

// Default level: a 8×10 m room; start at one end, beacon at the far end. If the
// page was opened with ?level=current, load the level designed in the editor
// (stored in localStorage) instead.
let ROOM: [number, number, number] = [8, 3, 10];
let LEVEL: GameLevel = {
  start: { x: 4, z: 8.5, yaw: 0 }, // facing -z (toward the beacon end)
  beacon: { x: 4, z: 1.5, freq: 440 },
  goalRadius: 0.8,
};
// Acoustic geometry for the clap (the general solver). Defaults to the built-in
// room's 6 walls; replaced by the editor level's geometry when loaded.
let WALLS: WallDef[] = boxRoomWalls(ROOM, 'concrete');
let EDGES: EdgeDef[] = [];
let SCATTER = 0.05;
// The source level + a moving-walls flag, so the live IR loop can re-derive
// geometry from the animation clock. Null when running the built-in default room.
let SRC_LEVEL: Level | null = null;
let HAS_MOVING_WALLS = false;
// rAF handle for the moving-walls live loop, so it is cancellable and can't be
// started twice (a duplicate loop would double the rebuild rate).
let liveRafId: number | null = null;

/**
 * Apply a chosen Level to the module-level game state. Called when a level is
 * picked (or preselected via ?level=…), BEFORE the Begin gesture — Begin still
 * owns the user-gesture-to-start-audio step.
 */
function applyLevel(level: Level, displayName: string) {
  const loaded = loadLevel(level);
  LEVEL = loaded.game;
  ROOM = loaded.roomSize;
  WALLS = loaded.walls;
  EDGES = loaded.edges;
  SCATTER = loaded.scattering;
  SRC_LEVEL = loaded.level;
  HAS_MOVING_WALLS = loaded.hasMovingWalls;
  if (startLevelName) startLevelName.textContent = `Now playing: ${displayName}`;
}

/** Reveal the Begin screen for a chosen level (hides the picker). */
function showStartScreen() {
  pickerScreen.hidden = true;
  startScreen.hidden = false;
  startButton.disabled = false;
  startButton.focus();
}

/** Show the picker (the default entry point), hiding the Begin screen. */
function showPicker() {
  startScreen.hidden = true;
  pickerScreen.hidden = false;
}

/** Resolve a picker selection (builtin id or saved name) to a Level. */
async function resolveSelection(sel: PickerSelection): Promise<Level | undefined> {
  if (sel.source === 'builtin') return getBuiltin(sel.ref);
  return loadSavedLevel(sel.ref);
}

async function mountPicker() {
  const host = document.getElementById('level-picker');
  if (!host) return;
  let saved: string[] = [];
  try {
    saved = await listLevels();
  } catch {
    saved = []; // IndexedDB unavailable (e.g. private mode) — just show builtins.
  }
  renderLevelPicker(host, {
    builtins: builtinLevels(),
    savedNames: saved,
    onSelect: async (sel) => {
      const level = await resolveSelection(sel);
      if (!level) {
        alert(`Could not load "${sel.label}".`);
        return;
      }
      applyLevel(level, sel.label);
      showStartScreen();
    },
  });
}

backButton?.addEventListener('click', showPicker);

// Entry point. `?level=current` loads the editor's working level; `?level=<id>`
// loads a bundled demo; otherwise show the picker. A preselected level jumps
// straight to the Begin screen (the audio still waits for the Begin gesture).
{
  const param = new URLSearchParams(location.search).get('level');
  if (param === 'current') {
    const edited = currentEditorLevel();
    if (edited) {
      applyLevel(edited, edited.name || 'Editor level');
      showStartScreen();
    } else {
      void mountPicker();
    }
  } else if (param) {
    const builtin = getBuiltin(param);
    if (builtin) {
      applyLevel(builtin, builtin.name);
      showStartScreen();
    } else {
      void mountPicker(); // unknown id → fall back to the picker
    }
  } else {
    void mountPicker();
  }
}

startButton.addEventListener('click', async () => {
  startButton.disabled = true;
  say('Loading spatial audio…');
  try {
    const graph = await startAudio();
    const { ctx } = graph;
    const renderer = await HrtfRenderer.create(ctx, HRTF_URL);
    await initAcoustics();

    startScreen.hidden = true;
    gameScreen.hidden = false;

    // The run's end-state. `ended` freezes input (step buttons stop responding);
    // `outcome` distinguishes a win from being caught, so messaging/future logic
    // never has to overload one flag for both.
    let ended = false;
    let outcome: 'won' | 'caught' | null = null;
    // End the run with a distinct, spoken outcome (this is an eyes-free game, so
    // win vs. caught must be clearly announced, not just visually alerted).
    const endRun = (result: 'won' | 'caught') => {
      ended = true;
      outcome = result;
      say(outcome === 'won' ? 'You win.' : 'Caught!');
    };
    const game = new Game(graph, renderer, LEVEL, {
      onStep: (foot, stride) =>
        say(`Step ${foot === 'L' ? 'left' : 'right'} (${stride.toFixed(2)} m).`),
      onStumble: (reason) =>
        alert(
          reason === 'wall'
            ? 'You bumped into a wall.'
            : reason === 'too-fast'
              ? 'You stumbled — slow down!'
              : reason === 'wrong-foot'
                ? 'Wrong foot — alternate left and right.'
                : 'Recovering…',
        ),
      onWin: () => {
        endRun('won');
        alert('You reached the beacon. Level complete!');
      },
      onCaught: () => {
        // The monster physically reached you — a loss, distinct from a win.
        endRun('caught');
        alert('A monster caught you. Press start to try again.');
      },
      onProgress: (d) => updateFootHints(d),
    });

    // --- Turn control: the compass dial (only turn control) ---
    setupTurning(game);

    // --- Step buttons ---
    const stepLeft = document.getElementById('step-left') as HTMLButtonElement;
    const stepRight = document.getElementById('step-right') as HTMLButtonElement;
    const doStep = (foot: 'L' | 'R') => {
      if (ended) return;
      game.step(foot);
      updateFeet(game); // refresh immediately after a step
    };
    // pointerdown (not click) for tight rhythm response.
    stepLeft.addEventListener('pointerdown', (e) => { e.preventDefault(); doStep('L'); });
    stepRight.addEventListener('pointerdown', (e) => { e.preventDefault(); doStep('R'); });
    // Keyboard step keys (arrows are reserved for turning): A = left, L = right.
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (e.key === 'a' || e.key === 'A') doStep('L');
      else if (e.key === 'l' || e.key === 'L') doStep('R');
    });

    // --- Clap to hear the room (echo button) ---
    setupClap(graph, renderer, game);

    // Foot display loop: only the expected foot shows while walking; after the
    // player settles (idle ~1.4s) BOTH feet appear so either can lead. Polled so
    // the time-based settle transition happens on its own.
    const footLoop = () => {
      // Advance the audio-only listener glide each frame (no-op when idle), so the
      // HRTF listener + beacon sweep smoothly between footfalls instead of teleporting.
      game.tick();
      updateFeet(game);
      requestAnimationFrame(footLoop);
    };
    footLoop();
    say('Walk to the beacon ahead. Alternate left and right steps — and don\'t rush.');
  } catch (err) {
    console.error(err);
    alert('Could not start audio: ' + (err as Error).message);
    startButton.disabled = false;
  }
});

/**
 * Show/hide the footprints. While walking, only the expected foot is visible (the
 * other is hidden); once settled (idle), BOTH show so either foot can lead. The
 * visible foot(s) glow as "active".
 */
function updateFeet(game: Game) {
  const l = document.getElementById('step-left')!;
  const r = document.getElementById('step-right')!;
  const settled = game.isSettled();
  const next = game.nextFoot;

  const leftShown = settled || next === 'L';
  const rightShown = settled || next === 'R';
  l.classList.toggle('hidden', !leftShown);
  r.classList.toggle('hidden', !rightShown);
  // The foot(s) you may press glow as active.
  l.classList.toggle('active', leftShown);
  r.classList.toggle('active', rightShown);
}

/** Announce closing distance at coarse thresholds (eyes-free progress feedback). */
let lastBand = -1;
function updateFootHints(distance: number) {
  const band = distance < 1 ? 0 : distance < 3 ? 1 : distance < 6 ? 2 : 3;
  if (band !== lastBand) {
    lastBand = band;
    const labels = ['Almost there', 'Close', 'Getting closer', 'Far'];
    say(`${labels[band]} — ${distance.toFixed(1)} m to the beacon.`);
  }
}

function setupTurning(game: Game) {
  const turnPad = document.getElementById('turn-pad')!;

  // Rate-limited heading: the compass sets a TARGET; the actual heading slews
  // toward it at a capped angular speed (physically plausible, and it keeps the
  // HRTF direction changing slowly so fast drags don't cause audio artifacts).
  const heading = new Heading(LEVEL.start.yaw);

  // The compass is the only turn control. Dragging one full compass width turns
  // you exactly ARC_DEG (120°). The dial + audio both follow the SLEWED heading.
  const compass = new Compass({
    size: 300,
    onYaw: (yaw) => heading.setTarget(yaw),
    // On release, stop where the heading actually IS — snap the target to the
    // current slewed value so it doesn't keep coasting toward the last drag point.
    onRelease: () => heading.setTarget(heading.current),
  });
  turnPad.appendChild(compass.el);

  heading.reset(LEVEL.start.yaw);
  game.setYaw(heading.current);
  compass.setHeading(heading.current);

  // Slew loop: advance toward target, then apply the SLEWED value to both the
  // audio (game) and the compass so they stay in lockstep and catch up together.
  let lastT = performance.now();
  const loop = (now: number) => {
    const dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;
    if (heading.tick(dt)) {
      game.setYaw(heading.current);
      compass.setHeading(heading.current);
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

function setupClap(
  graph: AudioGraph,
  renderer: HrtfRenderer,
  game: Game,
) {
  const clapRoom = new ClapRoom(graph, renderer);
  const listenBtn = document.getElementById('listen');
  listenBtn?.addEventListener('click', () => {
    // Clap from the player's current position, through the ACTUAL room geometry
    // (general solver). WALLS is the live wall list — already updated each frame
    // by the moving-walls loop below, so this picks up wall positions for free.
    const p = game.listenerPos;
    clapRoom.updateGeneralRoom(WALLS, [p.x, p.y, p.z], p.yaw, {
      maxOrder: 2,
      scattering: SCATTER,
      edges: EDGES,
    });
    clapRoom.clap();
    say('Clap! Listen to the room around you.');
  });

  // --- Moving walls: advance an animation clock, re-derive WALLS, and drive the
  // AMBIENT room IR continuously so you HEAR the space change. The throttle +
  // dirty-check + crossfade all live in ClapRoom.updateLive. Only runs when the
  // level actually has moving walls (the dirty check would no-op anyway, but the
  // gate avoids the per-frame signature/geometry work). ---
  if (HAS_MOVING_WALLS && SRC_LEVEL) {
    const level = SRC_LEVEL;
    const t0 = performance.now();
    const MIN_INTERVAL_MS = 70; // mirrors ClapRoom.updateLive's throttle (~14 Hz)
    let lastSigMs = -Infinity; // when we last bothered to build the signature
    const liveLoop = () => {
      const nowMs = performance.now();
      const t = (nowMs - t0) / 1000;
      // Live geometry must update EVERY frame (the clap button + collision-free
      // recompute read WALLS), even on frames we don't rebuild.
      WALLS = wallsAt(level, t);
      EDGES = diffractionEdgesAt(level, t);
      // The signature is only consumed at the throttle rate, so skip the string
      // allocation on frames inside the throttle window — updateLive would no-op
      // on them anyway.
      if (nowMs - lastSigMs >= MIN_INTERVAL_MS) {
        lastSigMs = nowMs;
        const p = game.listenerPos;
        const sig = liveRebuildSignature(level, t, { x: p.x, z: p.z, yaw: p.yaw });
        clapRoom.updateLive(WALLS, sig, [p.x, p.y, p.z], p.yaw, {
          maxOrder: 2,
          scattering: SCATTER,
          edges: EDGES,
          minIntervalMs: MIN_INTERVAL_MS,
        });
      }
      liveRafId = requestAnimationFrame(liveLoop);
    };
    // Guard against setupClap / the loop starting twice (duplicate loops would
    // double the rebuild rate). Cancel any prior loop before starting.
    if (liveRafId != null) cancelAnimationFrame(liveRafId);
    liveRafId = requestAnimationFrame(liveLoop);
  }
}
