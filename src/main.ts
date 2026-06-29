import { startAudio, type AudioGraph } from './engine/audioGraph';
import { HrtfRenderer } from './engine/hrtf/renderer';
import type { InterpolatingHrtfRenderer } from './engine/hrtf/interpolatingRenderer';
import { Compass } from './game/compass';
import { initAcoustics } from './engine/acoustics/core';
import { ClapRoom } from './engine/acoustics/clapRoom';
import type { WallDef, EdgeDef } from './engine/acoustics/core';
import { Game, type GameLevel } from './game/game';
import { ClapBudget } from './game/clapBudget';
import { Heading } from './game/heading';
import { currentEditorLevel, loadLevel, boxRoomWalls, wallsAt, diffractionEdgesAt, liveRebuildSignature } from './level/load';
import { getBuiltin, builtinLevels } from './level/builtins';
import { loadLevel as loadSavedLevel, listLevels } from './level/storage';
import type { Level } from './level/schema';
import { renderLevelPicker, type PickerSelection } from './ui/levelPicker';
import { OnboardingStore } from './ui/onboardingStore';
import { mountCalibration } from './ui/calibration';
import { mountTutorial } from './ui/tutorial';
import { selectBackendFromSearch } from './engine/steamaudio/toggle';
import type { SpatialBackend } from './game/game';

const HRTF_URL = '/assets/hrtf/sadie_h3.hrtf';

const statusEl = document.getElementById('status')!;
const alertsEl = document.getElementById('alerts')!;
const pickerScreen = document.getElementById('picker-screen')!;
const startScreen = document.getElementById('start-screen')!;
const gameScreen = document.getElementById('game-screen')!;
const startButton = document.getElementById('start-button') as HTMLButtonElement;
const backButton = document.getElementById('back-to-picker') as HTMLButtonElement | null;
const startLevelName = document.getElementById('start-level-name');
const calibrationScreen = document.getElementById('calibration-screen')!;
const tutorialScreen = document.getElementById('tutorial-screen')!;
const engineToggle = document.getElementById('engine-steam-toggle') as HTMLInputElement | null;

// Initialise the engine toggle from the URL param so ?engine=steam pre-checks it;
// the checkbox is then the source of truth at Begin (it can override the param).
if (engineToggle) {
  engineToggle.checked = selectBackendFromSearch(location.search) === 'steam';
}

const onboarding = new OnboardingStore();

// Session L/R channel swap (from calibration / persisted preference). Inverts the
// master output channels for the whole session by inserting a crossed
// splitter→merger on the master→limiter path. Applied to the singleton AudioGraph
// from startAudio(), so calibration and the real game share one swap node.
let swapNode: { splitter: ChannelSplitterNode; merger: ChannelMergerNode } | null = null;
function applyChannelSwap(graph: AudioGraph, want: boolean) {
  if (want && !swapNode) {
    const splitter = graph.ctx.createChannelSplitter(2);
    const merger = graph.ctx.createChannelMerger(2);
    graph.master.disconnect();
    graph.master.connect(splitter);
    splitter.connect(merger, 0, 1); // left in → right out
    splitter.connect(merger, 1, 0); // right in → left out
    merger.connect(graph.limiter);
    swapNode = { splitter, merger };
  } else if (!want && swapNode) {
    graph.master.disconnect();
    swapNode.splitter.disconnect();
    swapNode.merger.disconnect();
    graph.master.connect(graph.limiter);
    swapNode = null;
  }
}

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
// Acoustic geometry for the clap (the general solver). Defaults to the built-in
// room's 6 walls; replaced by the editor level's geometry when loaded.
let WALLS: WallDef[] = boxRoomWalls(ROOM, 'concrete');
let EDGES: EdgeDef[] = [];
let SCATTER = 0.05;
let LEVEL: GameLevel = {
  start: { x: 4, z: 8.5, yaw: 0 }, // facing -z (toward the beacon end)
  beacon: { x: 4, z: 1.5, freq: 440 },
  goalRadius: 0.8,
  // Modeled beacon: same geometry the clap uses, so walls occlude the beacon and
  // openings let it diffract through.
  acousticWalls: WALLS,
  acousticEdges: EDGES,
  acousticScattering: SCATTER,
};
// The source level + a moving-walls flag, so the live IR loop can re-derive
// geometry from the animation clock. Null when running the built-in default room.
let SRC_LEVEL: Level | null = null;
let HAS_MOVING_WALLS = false;
// Per-level speed of sound (m/s), or undefined ⇒ engine default 343. Threaded
// into BOTH the clap (echo timing) and the renderer (live propagation + Doppler).
let SPEED_OF_SOUND: number | undefined;
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
  SPEED_OF_SOUND = loaded.speedOfSound;
  // Thread the acoustic geometry into the GameLevel so the beacon is rendered
  // through the room (occlusion + diffraction), not on a straight line.
  LEVEL.acousticWalls = WALLS;
  LEVEL.acousticEdges = EDGES;
  LEVEL.acousticScattering = SCATTER;
  if (startLevelName) startLevelName.textContent = `Now playing: ${displayName}`;
}

/** Hide every top-level onboarding/start section (game screen left untouched). */
function hideOnboardingScreens() {
  pickerScreen.hidden = true;
  startScreen.hidden = true;
  calibrationScreen.hidden = true;
  tutorialScreen.hidden = true;
}

/** Reveal the Begin screen for a chosen level (hides the other screens). */
function showStartScreen() {
  hideOnboardingScreens();
  startScreen.hidden = false;
  startButton.disabled = false;
  startButton.focus();
}

/**
 * First-run onboarding gate: before the Begin screen, run any not-yet-completed
 * onboarding (calibration, then tutorial), then fall through to Begin. Each is
 * skippable and remembers completion (localStorage), so returning players go
 * straight to Begin. Replayable from the picker links regardless.
 */
function gateOnboarding(then: () => void) {
  if (!onboarding.calibrationDone()) {
    runCalibration(() => gateOnboarding(then));
  } else if (!onboarding.tutorialDone()) {
    runTutorial(() => gateOnboarding(then));
  } else {
    then();
  }
}

/** Mount + show the calibration screen; `after` runs when it finishes/skips. */
function runCalibration(after: () => void) {
  hideOnboardingScreens();
  calibrationScreen.hidden = false;
  mountCalibration(calibrationScreen, {
    store: onboarding,
    say,
    alert,
    applySwap: applyChannelSwap,
    onDone: after,
  });
}

/** Mount + show the tutorial screen; `after` runs when it finishes/skips. */
function runTutorial(after: () => void) {
  hideOnboardingScreens();
  tutorialScreen.hidden = false;
  mountTutorial(tutorialScreen, { store: onboarding, say, alert, onDone: after });
}

/** Show the picker (the default entry point), hiding the Begin screen. */
function showPicker() {
  hideOnboardingScreens();
  pickerScreen.hidden = false;
  // Move focus into the picker so an eyes-closed / screen-reader user lands on a
  // choice instead of the top of the document.
  (pickerScreen.querySelector('button, [tabindex]') as HTMLElement | null)?.focus();
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
      // First-run onboarding (calibration → tutorial) runs once, then Begin.
      gateOnboarding(showStartScreen);
    },
  });
  // Land focus on the first level so the picker is immediately operable eyes-free.
  (host.querySelector('button, [tabindex]') as HTMLElement | null)?.focus();
}

backButton?.addEventListener('click', showPicker);

// Replay onboarding from the picker (always available, ignores the "done" flags).
document.getElementById('redo-calibration')?.addEventListener('click', () => {
  runCalibration(showPicker);
});
document.getElementById('redo-tutorial')?.addEventListener('click', () => {
  runTutorial(showPicker);
});

// Entry point. `?level=current` loads the editor's working level; `?level=<id>`
// loads a bundled demo; otherwise show the picker. A preselected level jumps
// straight to the Begin screen (the audio still waits for the Begin gesture).
{
  const param = new URLSearchParams(location.search).get('level');
  if (param === 'current') {
    const edited = currentEditorLevel();
    if (edited) {
      applyLevel(edited, edited.name || 'Editor level');
      gateOnboarding(showStartScreen);
    } else {
      void mountPicker();
    }
  } else if (param) {
    const builtin = getBuiltin(param);
    if (builtin) {
      applyLevel(builtin, builtin.name);
      gateOnboarding(showStartScreen);
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
    applyChannelSwap(graph, onboarding.swap());
    const { ctx } = graph;
    const renderer = await HrtfRenderer.create(ctx, HRTF_URL);
    // Alien physics: if the level sets a speed of sound, the live beacon/monster
    // propagation delay + Doppler use it too (the clap gets it per-update below),
    // so the whole space sounds coherently slow/fast.
    if (SPEED_OF_SOUND != null) renderer.setSpeedOfSound(SPEED_OF_SOUND);
    await initAcoustics();

    // Backend selection (?engine=steam vs default ours). Steam Audio is loaded ONLY
    // on opt-in via a dynamic import (keeps three + the 6 MB WASM out of the default
    // bundle). On ANY init failure we fall back to our engine — never leave the game
    // silent. See docs/engine/steam-audio-backend.md.
    let steam: SpatialBackend | null = null;
    // The checkbox is the source of truth (pre-seeded from ?engine=steam); if it's
    // absent for any reason, fall back to the URL param.
    const wantSteam = engineToggle
      ? engineToggle.checked
      : selectBackendFromSearch(location.search) === 'steam';
    if (wantSteam) {
      say('Loading Steam Audio backend…');
      try {
        const { SteamAudioBackend } = await import('./engine/steamaudio/backend');
        steam = await SteamAudioBackend.create(ctx, graph.master, {
          hrtf: true,
          scattering: SCATTER,
        });
        console.info('[papasangre] Steam Audio backend active (?engine=steam).');
      } catch (e) {
        console.warn('[papasangre] Steam Audio unavailable — falling back to our engine.', e);
        steam = null;
      }
    }

    startScreen.hidden = true;
    gameScreen.hidden = false;

    // CLICK-FREE INTERPOLATING HRTF beacon (DEFAULT). The beacon — both the direct
    // path and its strongest reflections — is rendered through an AudioWorklet that
    // continuously interpolates the measured HRIRs, so turning the head never swaps a
    // ConvolverNode buffer (the swap reset a frame of audio → the click). On a level
    // WITH geometry the modeled beacon runs its reflections through the same worklet
    // (head-tracked, click-free); without geometry the plain beacon uses it. Skipped
    // on the Steam path (it has its own renderer). `?hrtf=legacy` opts back into the
    // old dual-convolver renderer for A/B. On any init failure we fall back to it too.
    let interpRenderer: InterpolatingHrtfRenderer | null = null;
    const wantInterp = new URLSearchParams(location.search).get('hrtf') !== 'legacy';
    if (wantInterp && !steam) {
      try {
        const { InterpolatingHrtfRenderer } = await import('./engine/hrtf/interpolatingRenderer');
        interpRenderer = await InterpolatingHrtfRenderer.fromSetAsync(ctx, renderer.set);
        if (SPEED_OF_SOUND != null) interpRenderer.setSpeedOfSound(SPEED_OF_SOUND);
      } catch (e) {
        console.warn('[papasangre] interpolating HRTF unavailable — using legacy beacon.', e);
        interpRenderer = null;
      }
    }

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
        alert(LEVEL.goal === 'absorber'
          ? 'You found the absorber. Level complete!'
          : 'You reached the beacon. Level complete!');
      },
      onCaught: () => {
        // The monster physically reached you — a loss, distinct from a win.
        endRun('caught');
        alert('A monster caught you. Press start to try again.');
      },
      onProgress: (d) => updateFootHints(d),
    }, undefined, steam, interpRenderer);

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
  const listenBtn = document.getElementById('listen') as HTMLButtonElement | null;

  // The sonar budget for THIS run. Absent config ⇒ unlimited (today's free clap):
  // isManaged() is false, so no counter is shown or announced.
  const budget = new ClapBudget({ max: LEVEL.clapBudget, cooldownMs: LEVEL.clapCooldownMs });
  const BASE_CLAP_LABEL = 'Listen — clap to hear the room';

  /** Format remaining claps for an eyes-free cue ("3 claps left"). */
  const remainingPhrase = () => {
    const n = budget.remaining();
    if (n === Infinity) return '';
    return n === 1 ? '1 clap left' : `${n} claps left`;
  };

  /** Refresh the echo button's label + disabled state for the current budget. */
  const refreshClapUi = () => {
    if (!listenBtn) return;
    if (!budget.isManaged()) return; // unlimited: leave the default label/enabled state
    const rem = budget.remaining();
    const exhausted = budget.hasBudget() && rem <= 0;
    listenBtn.disabled = exhausted;
    const suffix = budget.hasBudget() ? ` (${remainingPhrase()})` : '';
    listenBtn.setAttribute('aria-label', exhausted ? 'Echo — no claps left' : BASE_CLAP_LABEL + suffix);
  };
  // Announce the starting budget so an eyes-free player knows it's limited. Use the
  // assertive `alert` region, not `say` — the status region is overwritten by the
  // "Walk to the beacon…" intro right after setupClap returns, so a `say` here would
  // never be heard.
  if (budget.isManaged() && budget.hasBudget()) {
    alert(`Sonar budget: ${remainingPhrase()}. Clap deliberately.`);
    refreshClapUi();
  }

  listenBtn?.addEventListener('click', () => {
    const nowMs = performance.now();
    const res = budget.consume(nowMs);
    if (!res.ok) {
      // Refused — give a clear spoken cue, no clap fired.
      if (res.reason === 'exhausted') alert('No claps left.');
      else alert(`Echo ready in ${Math.ceil(res.waitMs / 1000)}s.`);
      refreshClapUi();
      return;
    }
    // Clap from the player's current position, through the ACTUAL room geometry
    // (general solver). WALLS is the live wall list — already updated each frame
    // by the moving-walls loop below, so this picks up wall positions for free.
    const p = game.listenerPos;
    clapRoom.updateGeneralRoom(WALLS, [p.x, p.y, p.z], p.yaw, {
      maxOrder: 2,
      scattering: SCATTER,
      edges: EDGES,
      speedOfSound: SPEED_OF_SOUND,
    });
    clapRoom.clap();
    // Announce remaining budget eyes-free; unmanaged levels stay exactly as before.
    const phrase = budget.hasBudget() ? ` ${remainingPhrase()}.` : '';
    say(`Clap! Listen to the room around you.${phrase}`);
    refreshClapUi();
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
      // Feed the live geometry to the modeled beacon too, so a beacon behind a
      // moving wall occludes/un-occludes as the wall slides (throttled inside).
      game.setAcousticGeometry(WALLS, EDGES);
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
          speedOfSound: SPEED_OF_SOUND,
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
