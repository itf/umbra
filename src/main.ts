import { startAudio, type AudioGraph } from './engine/audioGraph';
import { HrtfRenderer } from './engine/hrtf/renderer';
import type { InterpolatingHrtfRenderer } from './engine/hrtf/interpolatingRenderer';
import { Compass } from './game/compass';
import { initAcoustics } from './engine/acoustics/core';
import { ClapRoom } from './engine/acoustics/clapRoom';
import type { WallDef, EdgeDef } from './engine/acoustics/core';
import { Game, type GameLevel } from './game/game';
import { ClapBudget } from './game/clapBudget';
import {
  clapFiredAnnouncement,
  clapRefusedAnnouncement,
  budgetIntroAnnouncement,
  remainingPhrase as budgetRemainingPhrase,
} from './game/clapAnnounce';
import {
  Heading,
  keyTurnDelta,
  announceHeadingWithDirection,
  crossedDetent,
  COMPASS_POINTS,
} from './game/heading';
import { currentEditorLevel, loadLevel, boxRoomWalls, wallsAt, diffractionEdgesAt, liveRebuildSignature } from './level/load';
import { getBuiltin, builtinLevels } from './level/builtins';
import { repeatSelection, nextSelection, harderSelection } from './game/nextRun';
import { loadLevel as loadSavedLevel, listLevels } from './level/storage';
import type { Level } from './level/schema';
import { renderLevelPicker, type PickerSelection } from './ui/levelPicker';
import { Router, type ScreenState } from './ui/router';
import { renderProgressScreen } from './ui/progress';
import { renderLandingScreen } from './ui/landing';
import { LandingDemo } from './ui/landingDemo';
import { mountClickTypes } from './ui/clickTypes';
import { renderCreditsScreen } from './ui/credits';
import { loadClicksManifest, cachedClicksManifest } from './game/clicksManifest';
import { probeOptions } from './game/probeCatalog';
import { ProbeResolver } from './game/probeResolver';
import { loadCustomLoop } from './game/customAudio';
import type { LevelInfo, ProgressCategory, TrainerInfo } from './game/progressSummary';
import { generateLevel } from './game/sandbox';
import { OnboardingStore, type PrimerMode } from './ui/onboardingStore';
import { SettingsStore } from './ui/settingsStore';
import { mountSettings, type SettingsPanel } from './ui/settings';
import { Speech } from './ui/speech';
import { TrainerStore } from './trainer/trainerStore';
import { DailyStreakStore } from './trainer/dailyStreakStore';
import { ScoreStore } from './game/scoreStore';
import { announceCompletion, summarizeBest } from './game/scoreModel';
import { companionLine, modeForLevel, type CompanionEvent, type CompanionContext } from './game/companion';
import { renderControlsSpeech } from './game/controls';
import { mountCalibration } from './ui/calibration';
import { mountTutorial } from './ui/tutorial';
import { mountLoudnessEq } from './ui/loudnessEqUi';
import { buildEqChain, type EqChain } from './ui/loudnessEqAudio';
import { selectBackendFromSearch } from './engine/steamaudio/toggle';
import type { SpatialBackend } from './game/game';

const HRTF_URL = '/assets/hrtf/sadie_h3.hrtf';

const statusEl = document.getElementById('status')!;
const alertsEl = document.getElementById('alerts')!;
const landingScreen = document.getElementById('landing-screen')!;
const pickerScreen = document.getElementById('picker-screen')!;
const progressScreen = document.getElementById('progress-screen')!;
const startScreen = document.getElementById('start-screen')!;
const gameScreen = document.getElementById('game-screen')!;
const startButton = document.getElementById('start-button') as HTMLButtonElement;
const backButton = document.getElementById('back-to-picker') as HTMLButtonElement | null;
const startLevelName = document.getElementById('start-level-name');
const calibrationScreen = document.getElementById('calibration-screen')!;
const tutorialScreen = document.getElementById('tutorial-screen')!;
const engineToggle = document.getElementById('engine-steam-toggle') as HTMLInputElement | null;

const onboarding = new OnboardingStore();
const settings = new SettingsStore();

/**
 * Resolve the effective high-fidelity (Steam Audio) engine preference. A SAVED
 * Settings preference wins (the user expressed an explicit choice); otherwise the
 * `?engine=steam` URL param decides. This is the single source of truth read by the
 * Settings toggle, the Begin-screen checkbox seeding, and the Begin handler.
 */
function steamEnginePref(): boolean {
  if (settings.hasSteamEnginePref()) return settings.steamEngineEnabled();
  return selectBackendFromSearch(location.search) === 'steam';
}

/** Effective Steam HRTF choice: our SADIE SOFA (true) vs Steam's generic (false).
 *  The Settings toggle OR the ?engine=steam-sofa URL override enables SADIE. */
function steamSofaPref(): boolean {
  return settings.steamSofaHrtf()
    || new URLSearchParams(location.search).get('engine') === 'steam-sofa';
}

// Initialise the Begin-screen engine toggle from the effective preference (saved
// Settings choice, else ?engine=steam). The checkbox stays the source of truth at
// Begin (it can override), and the Settings toggle keeps it in sync.
if (engineToggle) {
  engineToggle.checked = steamEnginePref();
}
const trainerStore = new TrainerStore();
const dailyStreakStore = new DailyStreakStore();
const scoreStore = new ScoreStore();
// The mounted settings panel (audio mix + prefs). Null until the game starts +
// setupSettings mounts it; the in-game S key + the ⚙ button drive it.
let settingsPanel: SettingsPanel | null = null;
/**
 * The currently-running Game, for the live Settings "Apply now" hot-swap (engine
 * on/off + reverb/reflection levels). Set right after construction in the Begin
 * handler, nulled in the run teardown. Null ⇒ no level running (Apply announces so).
 */
let currentGame: Game | null = null;
/**
 * The running level's debug-overlay setter (show/hide + persist), or null when no
 * level is active. Lets the standalone Settings panel toggle the live overlay of the
 * current run (the run registers this on start, clears it on teardown).
 */
let currentDebugOverlaySetter: ((on: boolean) => void) | null = null;
/**
 * The running level's PROBE trigger — fires a clap/probe to hear the room (the same
 * action as the on-screen echo button), or null when no level is active. Lets the
 * Down-arrow key and the dedicated probe button fire it. Registered by setupClap on
 * start, cleared on teardown.
 */
let currentProbeTrigger: (() => void) | null = null;
/** The landing page's guided-demo controller, or null when not on the landing. Held so
 *  leaving the landing disposes its AudioContext. */
let landingDemo: LandingDemo | null = null;
/**
 * Whether the live run currently has the Steam Audio engine. Tracked alongside
 * `currentGame` so Apply can decide LIGHT (level tweak on a running Steam backend)
 * vs HEAVY (engine toggled) without reaching into Game internals.
 */
let currentEngineIsSteam = false;
/** Whether the live Steam backend was built with our SADIE HRTF (vs generic). Lets
 *  Apply detect an HRTF change (which needs a full rebuild — HRTF is baked at create). */
let currentSteamIsSofa = false;
/** Ambisonic order the live Steam backend was built with (1..3). Lets Apply detect an
 *  order change (a rebuild — order is baked at world creation). 0 ⇒ no Steam backend. */
let currentSteamOrder = 0;
/** The effective clutter (level.clutter ∨ slider) BAKED into the current geometry. Clutter
 *  is baked into wall materials at level load, so Apply must detect a change and re-bake +
 *  re-push the geometry live (otherwise clutter only takes effect on a full page reload). */
let currentClutter = 0;

// Companion-voice preference. OPTIONAL + remembered: defaults ON for first-timers
// (stored pref), but `?companion=off` / `?companion=on` overrides AND persists the
// choice — a clean way for 6C's settings UI (or a URL) to flip it. `setCompanion`
// is the single enable/disable others can call.
function setCompanion(on: boolean) {
  onboarding.setCompanionEnabled(on);
}
{
  const param = new URLSearchParams(location.search).get('companion');
  if (param === 'off') setCompanion(false);
  else if (param === 'on') setCompanion(true);
}
/** Whether the companion voice is currently enabled (URL param + stored pref). */
function companionEnabled(): boolean {
  return onboarding.companionEnabled();
}

// Session L/R channel swap (from calibration / persisted preference). Inverts the
// master output channels for the whole session by inserting a crossed
// splitter→merger on the master→limiter path. Applied to the singleton AudioGraph
// from startAudio(), so calibration and the real game share one swap node.
let swapNode: { splitter: ChannelSplitterNode; merger: ChannelMergerNode } | null = null;
// Per-user loudness-EQ correction chain, spliced at the HEAD of the master path
// (master → eq → [swap] → limiter), so the swap stage always operates on the node
// returned by `eqOutNode()` rather than `master` directly.
let eqChain: EqChain | null = null;

/** The node that feeds the swap/limiter stage: the EQ output if present, else master. */
function eqOutNode(graph: AudioGraph): AudioNode {
  return eqChain ? eqChain.output : graph.master;
}

/**
 * (Re)build the whole master→limiter path for the current EQ + swap state. Tears down
 * any existing EQ/swap wiring, splices the loudness-EQ chain (when a stored curve
 * exists), then routes through the channel-swap if `wantSwap`. Idempotent: safe to
 * call after a curve change or a swap toggle.
 */
function rebuildMasterPath(graph: AudioGraph, wantSwap: boolean) {
  // Fully detach the current chain.
  try { graph.master.disconnect(); } catch { /* noop */ }
  if (swapNode) {
    swapNode.splitter.disconnect();
    swapNode.merger.disconnect();
    swapNode = null;
  }
  if (eqChain) { eqChain.dispose(); eqChain = null; }

  // Head: master → (EQ) → tail.
  eqChain = buildEqChain(graph.ctx, settings.loudnessEq());
  if (eqChain) graph.master.connect(eqChain.input);
  const head = eqOutNode(graph);

  // Tail: head → (swap) → limiter.
  if (wantSwap) {
    const splitter = graph.ctx.createChannelSplitter(2);
    const merger = graph.ctx.createChannelMerger(2);
    head.connect(splitter);
    splitter.connect(merger, 0, 1); // left in → right out
    splitter.connect(merger, 1, 0); // right in → left out
    merger.connect(graph.limiter);
    swapNode = { splitter, merger };
  } else {
    head.connect(graph.limiter);
  }
}

/** Apply (or remove) the session L/R channel swap, preserving the EQ chain. */
function applyChannelSwap(graph: AudioGraph, want: boolean) {
  rebuildMasterPath(graph, want);
}

/** Re-apply the master path after the loudness-EQ curve changed, keeping the swap. */
function applyLoudnessEq(graph: AudioGraph) {
  rebuildMasterPath(graph, onboarding.swap());
}

/**
 * Apply the master output volume (0..1) to the AudioGraph's master gain with a
 * short smoothing ramp so a slider drag doesn't zipper. The single applier the
 * settings panel and apply-on-load both call. Persistence is the SettingsStore's job.
 */
function setMasterVolume(graph: AudioGraph, v: number) {
  const t = graph.ctx.currentTime;
  graph.master.gain.setTargetAtTime(Math.max(0, Math.min(1, v)), t, 0.03);
}

/**
 * Build the Steam Audio backend for the current settings, or return null on ANY
 * failure (no cross-origin isolation, WASM load error, …) so the caller NEVER leaves
 * the game silent — it falls back to our engine. Shared by the Begin handler and the
 * live "Apply now" engine hot-swap, so both honour the same SOFA / head-tracked /
 * reverb-reflection-level choices. The dynamic import keeps `three` + the 6 MB WASM
 * out of the default bundle (only opt-in pays for it).
 */
async function buildSteamBackend(
  ctx: AudioContext,
  master: AudioNode,
): Promise<SpatialBackend | null> {
  try {
    const { SteamAudioBackend } = await import('./engine/steamaudio/backend');
    // Our measured SADIE HRTF in Steam (vs Steam's generic): the Settings toggle, OR
    // the ?engine=steam-sofa URL override. Either enables the fork's custom-SOFA path.
    const wantSofa = settings.steamSofaHrtf()
      || new URLSearchParams(location.search).get('engine') === 'steam-sofa';
    // PATHING (directional diffraction) — ON by default whenever Steam is enabled (so the
    // Settings "High-fidelity audio" checkbox gets it, not just a URL param). It closes the
    // diffraction gap: without it the steam path has occlusion + a transmission leak but no
    // edge diffraction. Adds a per-level probe bake (~2-3 ms) + a per-frame diffraction sim.
    // URL override for A/B: `?engine=steam-path` forces ON, `?engine=steam-nopath` forces OFF.
    const engineParam = new URLSearchParams(location.search).get('engine');
    const wantPathing = engineParam === 'steam-nopath' ? false : true;
    const reflectionWetLevel = settings.steamReflectionWet();
    const reflectionBusLevel = settings.steamReflectionBus();
    const reverbBusLevel = settings.steamReverbBus();
    const steam = await SteamAudioBackend.create(ctx, master, {
      hrtf: true,
      scattering: SCATTER,
      sofaHrtf: wantSofa,
      headTrackedReflections: true,
      reflectionOrder: settings.steamReflectionOrder(),
      reflectionWetLevel,
      reflectionBusLevel,
      reverbBusLevel,
      pathing: wantPathing,
    });
    console.info(`[papasangre] Steam levels — reflection (per-source): ${reflectionWetLevel}, reflection bus: ${reflectionBusLevel}, reverb bus: ${reverbBusLevel}.`);
    console.info(`[papasangre] Steam Audio backend active (custom SADIE HRTF: ${wantSofa}, head-tracked reflections: true, pathing/diffraction: ${wantPathing}).`);
    return steam;
  } catch (e) {
    console.warn('[papasangre] Steam Audio unavailable — falling back to our engine.', e);
    return null;
  }
}

// OPTIONAL spoken-voice (Web Speech / TTS) layer. ADDITIVE to the ARIA live
// regions below — never a replacement. Default OFF (opt-in), so screen-reader
// users aren't double-spoken by both their AT and our synthesis. A silent no-op
// when the browser has no speechSynthesis. Seeded from persisted prefs here; the
// settings panel re-pushes on change via setupSettings.
const speech = new Speech();
speech.update({
  enabled: settings.ttsEnabled(),
  voiceName: settings.ttsVoice() || undefined,
  rate: settings.ttsRate(),
  pitch: settings.ttsPitch(),
});

// The live regions are ALWAYS written (unchanged whether TTS is on or off). TTS,
// when enabled, ALSO speaks the same text aloud — polite via #status queues,
// assertive via #alerts interrupts.
function say(msg: string) {
  statusEl.textContent = msg;
  speech.speak(msg, { assertive: false });
}
function alert(msg: string) {
  alertsEl.textContent = msg;
  speech.speak(msg, { assertive: true });
}

/**
 * A thin, DOM-bound adapter over the pure companion module (companion.ts). It
 * maps game events to spoken lines and enforces everything the pure module
 * deliberately doesn't: it's a NO-OP when the companion is disabled; it
 * rate-limits/dedupes (progress only on a band CHANGE, one line per event); it
 * rotates the line variety with a per-event call counter (the deterministic
 * `seed`); and it NEVER clobbers a critical announcement — urgent/critical lines
 * are spoken on a short delay AFTER the game's own assertive cue (win/caught/
 * heard) so the companion augments rather than overwrites it. Most lines ride the
 * polite #status region via say(); urgent stealth lines ride assertive alert().
 */
function makeCompanion(mode: ReturnType<typeof modeForLevel>) {
  // Per-event rotation counters → deterministic, non-repeating variety.
  const seeds: Partial<Record<CompanionEvent, number>> = {};
  let lastBand = -1;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;

  const speak = (line: string, urgent: boolean) => {
    if (urgent) alert(line);
    else say(line);
  };

  /**
   * Speak a companion line for `event`, if enabled and one exists. `urgent`
   * routes to the assertive region; `afterCriticalMs` delays the line so the
   * game's own critical announcement (already fired by the caller) lands first
   * and isn't clobbered.
   */
  const fire = (
    event: CompanionEvent,
    ctx: CompanionContext = {},
    opts: { urgent?: boolean; afterCriticalMs?: number } = {},
  ) => {
    if (!companionEnabled()) return;
    const seed = seeds[event] ?? 0;
    const line = companionLine(mode, event, { ...ctx, seed });
    if (line == null) return;
    seeds[event] = seed + 1; // rotate next time this event fires
    const urgent = opts.urgent ?? false;
    if (opts.afterCriticalMs && opts.afterCriticalMs > 0) {
      if (pendingTimer != null) clearTimeout(pendingTimer);
      pendingTimer = setTimeout(() => speak(line, urgent), opts.afterCriticalMs);
    } else {
      speak(line, urgent);
    }
  };

  return {
    /** Objective framing at level start (polite). */
    start: () => fire('start'),
    /**
     * Progress milestone. DEDUPED: only speaks when the coarse closeness band
     * actually changes (not per step). Polite.
     */
    progress: (band: number) => {
      if (band === lastBand) return;
      lastBand = band;
      fire('progress', { band });
    },
    /** Arrival line — sequenced AFTER the win alert so it doesn't clobber it. */
    win: () => fire('win', {}, { afterCriticalMs: 1200 }),
    /** Caught line — sequenced after the caught alert. */
    caught: () => fire('caught', {}, { afterCriticalMs: 1200 }),
    /** Urgent stealth "it heard you" — assertive, after the game's own cue. */
    heard: () => fire('heard', {}, { urgent: true, afterCriticalMs: 900 }),
  };
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
  beacons: [{ x: 4, z: 1.5, freq: 440 }],
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
/** The picked level's display name — used as the SCORE id (per-level bests). */
let LEVEL_ID = 'default-room';
/**
 * The selection that launched the currently-applied level, or null for the default
 * room. Retained so the post-win victory menu can compute Repeat / Next / Harder
 * (see game/nextRun.ts) — those re-run the SAME kind of level the player just beat.
 */
let LAST_LAUNCH: PickerSelection | null = null;
let HAS_MOVING_WALLS = false;
// Per-level speed of sound (m/s), or undefined ⇒ engine default 343. Threaded
// into BOTH the clap (echo timing) and the renderer (live propagation + Doppler).
let SPEED_OF_SOUND: number | undefined;
// rAF handle for the moving-walls live loop, so it is cancellable and can't be
// started twice (a duplicate loop would double the rebuild rate).
let liveRafId: number | null = null;

/**
 * The currently-running game's teardown handle, or null when no game is running.
 * "Back to levels" (and any re-navigation) calls `stopActiveRun()` so the Game's
 * audio nodes, the foot/turn/live rAF loops, and the keydown handler are all torn
 * down cleanly — no leaked audio, monster, or glide loops across screen changes.
 */
let activeRun: { teardown: () => void } | null = null;
function stopActiveRun() {
  if (liveRafId != null) { cancelAnimationFrame(liveRafId); liveRafId = null; }
  if (activeRun) {
    try { activeRun.teardown(); } catch (e) { console.warn('[papasangre] run teardown', e); }
    activeRun = null;
  }
}

/**
 * Apply a chosen Level to the module-level game state. Called when a level is
 * picked (or preselected via /level/<id>…), BEFORE the Begin gesture — Begin still
 * owns the user-gesture-to-start-audio step.
 */
function applyLevel(level: Level, displayName: string, launch: PickerSelection | null = null) {
  // CLUTTER: the settings slider only ADDS to a level's own clutter (max), so a level
  // that authored clutter is never made more live by a low slider. 0 ⇒ no extra.
  const effClutter = Math.max(level.clutter ?? 0, settings.clutter());
  currentClutter = effClutter; // remember what's baked, so Apply can detect a change
  const loaded = loadLevel(level, effClutter);
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
  // Room box for the pathing backend's probe grid — the room extent, not the interior
  // walls, so wall-less rooms still get probes. roomSize is [width, HEIGHT, depth].
  LEVEL.acousticRoomBounds = { width: ROOM[0], height: ROOM[1], depth: ROOM[2] };
  LEVEL_ID = displayName;
  LAST_LAUNCH = launch;
  if (startLevelName) startLevelName.textContent = `Now playing: ${displayName}`;
}

/** Hide every top-level onboarding/start section (game screen left untouched). */
function hideOnboardingScreens() {
  // Tear down the landing demo's audio when leaving the landing.
  if (!landingScreen.hidden) { landingDemo?.dispose(); landingDemo = null; }
  landingScreen.hidden = true;
  pickerScreen.hidden = true;
  startScreen.hidden = true;
  calibrationScreen.hidden = true;
  tutorialScreen.hidden = true;
  progressScreen.hidden = true;
  const ct = document.getElementById('click-types-screen'); if (ct) ct.hidden = true;
  const cr = document.getElementById('credits-screen'); if (cr) cr.hidden = true;
}

/** Reveal the Begin screen for a chosen level (hides the other screens). */
function showStartScreen() {
  stopActiveRun();
  hideOnboardingScreens();
  gameScreen.hidden = true;
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
    saveLoudnessEq: (curve) => settings.setLoudnessEq(curve),
    onDone: after,
  });
}

/** Mount + show the tutorial screen; `after` runs when it finishes/skips. */
function runTutorial(after: () => void) {
  hideOnboardingScreens();
  tutorialScreen.hidden = false;
  mountTutorial(tutorialScreen, { store: onboarding, say, alert, onDone: after });
}

/**
 * Show the picker (the default entry point), hiding the Begin screen, and
 * RE-RENDER it every time. Returning to the picker must repopulate it — rendering
 * only once at startup left it blank on return. Stops any in-progress run first
 * (no leaked audio/loops) and announces + focuses for eyes-free use.
 */
function showLanding() {
  stopActiveRun();
  hideOnboardingScreens();
  gameScreen.hidden = true;
  landingScreen.hidden = false;
  renderLandingScreen(landingScreen, {
    onPlay: () => navigate({ screen: 'picker' }),
    // "Train" → the /train route, which redirects to the trainer page (its own Vite
    // entry). A clean shareable URL; the redirect keeps the mature trainer intact.
    onTrain: () => navigate({ screen: 'train' }),
    onProgress: () => navigate({ screen: 'progress' }),
    onCredits: () => navigate({ screen: 'credits' }),
    onClicks: () => navigate({ screen: 'clicks' }),
    say,
  });
  // Mount the guided "which side?" demo into its host (dispose any prior instance so a
  // re-entry doesn't leak an AudioContext).
  landingDemo?.dispose();
  const demoMount = document.getElementById('landing-demo-mount');
  landingDemo = demoMount ? new LandingDemo(demoMount, { say }) : null;
}

function showPicker() {
  stopActiveRun();
  hideOnboardingScreens();
  gameScreen.hidden = true;
  pickerScreen.hidden = false;
  // Re-render into a fresh host on EVERY show, so the picker is never empty.
  void mountPicker();
  say('Choose a level.');
}

/** "Types of clicks" help page (/clicks): mount the click-types screen. */
function showClicks() {
  stopActiveRun();
  hideOnboardingScreens();
  gameScreen.hidden = true;
  const section = document.getElementById('click-types-screen');
  if (!section) { navigate({ screen: 'landing' }, { replace: true }); return; }
  section.hidden = false;
  void mountClickTypes(section, { say, onBack: () => navigateBack() });
}

/** Credits / licenses page (/credits): third-party attributions (CC clicks, HRTF…). */
function showCredits() {
  stopActiveRun();
  hideOnboardingScreens();
  gameScreen.hidden = true;
  const section = document.getElementById('credits-screen');
  if (!section) { navigate({ screen: 'landing' }, { replace: true }); return; }
  section.hidden = false;
  void renderCreditsScreen(section, { say, onBack: () => navigateBack() });
}

/** Human labels for the trainer exercise types shown on the progress screen. */
const TRAINER_LABELS: Record<string, string> = {
  all: 'Mixed drill',
  direction: 'Direction',
  distance: 'Distance',
  gap: 'Gap detection',
  orientation: 'Orientation',
  larger: 'Larger room',
  wider: 'Wider room',
  longer: 'Longer room',
  carpet: 'Carpet vs hard floor',
  brick: 'Brick vs soft wall',
  reflector: 'Reflector',
  material: 'Material',
  metal: 'Metal',
};

/** Read the trainer store into the progress-screen's trainer rows (read-only). */
function trainerRows(): TrainerInfo[] {
  const map = trainerStore.load();
  return Object.entries(map)
    .filter(([, p]) => p.best != null && p.sessions > 0)
    .map(([type, p]) => ({ label: TRAINER_LABELS[type] ?? type, best: p.best, sessions: p.sessions }));
}

/** Show the read-only "Best Times / Progress" screen, announcing its overview. */
function showProgress() {
  stopActiveRun();
  hideOnboardingScreens();
  gameScreen.hidden = true;
  progressScreen.hidden = false;
  const levels: LevelInfo[] = builtinLevels().map((b) => ({
    name: b.name,
    category: b.category as ProgressCategory,
  }));
  renderProgressScreen(progressScreen, {
    levels,
    // Scores are keyed by the level's display name (the id applyLevel records under).
    bestOf: (name) => scoreStore.best(name),
    streak: dailyStreakStore.load(),
    trainer: trainerRows(),
    say,
    onBack: () => navigateBack(),
  });
}

document.getElementById('open-progress')?.addEventListener('click', () =>
  navigate({ screen: 'progress' }),
);
// Home link from the picker → the landing page.
document.getElementById('picker-home')?.addEventListener('click', () =>
  navigate({ screen: 'landing' }),
);

/** Resolve a picker selection (builtin id, saved name, or generated) to a Level. */
async function resolveSelection(sel: PickerSelection): Promise<Level | undefined> {
  if (sel.source === 'builtin') return getBuiltin(sel.ref);
  if (sel.source === 'generated' && sel.sandbox) {
    // Pure, seeded, solvable in-memory level — never throws, always well-formed.
    return generateLevel(sel.sandbox);
  }
  return loadSavedLevel(sel.ref);
}

/**
 * Launch a picker selection: for builtins, route (deep-linkable /level/<id>, so
 * reload restores it and Back returns to the picker); for saved/generated levels
 * apply directly (no stable URL id — transient, as before) then gate onboarding →
 * Begin. Factored out of the picker's onSelect so the victory menu (Repeat / Next /
 * Harder) can re-launch the same way the picker does.
 */
async function launchSelection(sel: PickerSelection) {
  if (sel.source === 'builtin') {
    navigate({ screen: 'level', level: sel.ref });
    return;
  }
  const level = await resolveSelection(sel);
  if (!level) {
    alert(`Could not load "${sel.label}".`);
    return;
  }
  applyLevel(level, sel.label, sel);
  gateOnboarding(showStartScreen);
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
    onSelect: (sel) => { void launchSelection(sel); },
    // Surface each level's stored best ("Best: 42 seconds, 6 claps"). The score is
    // keyed by the level's display label (the same id applyLevel records under).
    bestFor: (item) => summarizeBest(scoreStore.best(item.label)) || undefined,
    // Probe chooser on the picker — same settings-backed store as the in-game Settings
    // panel, so a choice here is honoured in-level and stays in sync.
    probeChooser: {
      options: () => probeOptions(cachedClicksManifest() ?? []),
      get: () => settings.probeChoice(),
      set: (id) => settings.setProbeChoice(id),
    },
  });
  // Land focus on the first level so the picker is immediately operable eyes-free.
  (host.querySelector('button, [tabindex]') as HTMLElement | null)?.focus();
}

backButton?.addEventListener('click', () => navigate({ screen: 'picker' }));

// Replay onboarding from the picker (always available, ignores the "done" flags).
document.getElementById('redo-calibration')?.addEventListener('click', () => {
  runCalibration(() => navigate({ screen: 'picker' }));
});
document.getElementById('redo-tutorial')?.addEventListener('click', () => {
  runTutorial(() => navigate({ screen: 'picker' }));
});

/**
 * Resolve a level id from the URL (`/level/<id>`) to its Level, then run onboarding
 * → Begin. `current` is the editor's working level; otherwise a bundled demo by id.
 * Unknown ids fall back to the picker (returning false so the router can correct
 * the URL). The DOM-only Begin reveal is `showStartScreen`; this is the loader.
 */
function loadLevelById(id: string): boolean {
  if (id === 'current') {
    const edited = currentEditorLevel();
    if (!edited) return false;
    applyLevel(edited, edited.name || 'Editor level');
  } else {
    const builtin = getBuiltin(id);
    if (!builtin) return false;
    applyLevel(builtin, builtin.name, { source: 'builtin', ref: id, label: builtin.name });
  }
  // First-run onboarding (calibration → tutorial) runs once, then the Begin screen.
  gateOnboarding(showStartScreen);
  return true;
}

// --- ROUTING. `router.render` maps a screen state (from a navigation, the initial
// URL, or a Back/Forward popstate) to the right screen. Navigation goes through
// `navigate`, which pushes a history entry + updates the URL so reload restores the
// place and Back walks the screen history. Onboarding stays a transient gate (not a
// route), so gateOnboarding is untouched. ---
const router = new Router({
  render: (state: ScreenState) => {
    if (state.screen === 'landing') {
      showLanding();
    } else if (state.screen === 'picker') {
      showPicker();
    } else if (state.screen === 'progress') {
      showProgress();
    } else if (state.screen === 'clicks') {
      showClicks();
    } else if (state.screen === 'credits') {
      showCredits();
    } else if (state.screen === 'train') {
      // The trainer is its own Vite entry (trainer.html), not an in-SPA screen. /train
      // is a clean URL that redirects there (full nav). Keeps the mature trainer intact.
      const base = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
      location.replace(`${base.replace(/\/?$/, '/')}trainer.html`);
    } else if (state.screen === 'level' && state.level) {
      // An unknown/unloadable id → bounce to the picker (and fix the URL).
      if (!loadLevelById(state.level)) navigate({ screen: 'picker' }, { replace: true });
    } else {
      showLanding();
    }
  },
});
/** Navigate to a screen: pushes history + updates the URL, then renders it. */
function navigate(state: ScreenState, opts: { replace?: boolean } = {}) {
  router.go(state, opts);
}
/** Go back to the previous screen (or Home if we arrived here fresh, e.g. a deep-link).
 *  Every screen's "Back" uses this so it means "back to where I was". */
function navigateBack() {
  router.back({ screen: 'landing' });
}
// Seed the app from the initial URL (deep-link, progress, or picker), replacing the
// entry so Back never lands on a blank pre-app state.
router.start();
// Warm the CC clicks manifest so the Settings probe chooser can list the recordings
// synchronously (probeOptions reads the cache). Harmless if it fails (⇒ synth-only).
void loadClicksManifest();

startButton.addEventListener('click', async () => {
  startButton.disabled = true;
  say('Loading spatial audio…');
  try {
    const graph = await startAudio();
    applyChannelSwap(graph, onboarding.swap());
    // Apply the persisted master volume on load (smoothed). `setMasterVolume`
    // below is the single applier the settings panel also calls.
    setMasterVolume(graph, settings.masterVolume());
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
    const wantSteam = engineToggle ? engineToggle.checked : steamEnginePref();
    if (wantSteam) {
      say('Loading Steam Audio backend…');
      // Build via the shared helper (returns null on ANY failure → our engine). The
      // live "Apply now" engine hot-swap uses the SAME builder, so Begin + Apply honour
      // identical SOFA / head-tracked / reverb-reflection-level choices.
      steam = await buildSteamBackend(ctx, graph.master);
    }

    startScreen.hidden = true;
    gameScreen.hidden = false;

    // Teardown registry for THIS run: every loop/listener/audio resource registers
    // its cleanup here, so "back to levels" (stopActiveRun) can stop the whole run
    // cleanly — no leaked audio nodes, rAF loops, or keydown handlers.
    const teardowns: Array<() => void> = [];
    activeRun = { teardown: () => { for (const t of teardowns) { try { t(); } catch { /* noop */ } } } };

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
    // Throttle the "You were heard!" cue (loud floors fire it on every step).
    let lastHeardMs = -Infinity;
    // SCORING: claps consumed this run. Bumped by setupClap on each fired clap and
    // read back by the game's injected `clapsUsed` getter when it builds the result.
    let clapsUsed = 0;
    const levelId = LEVEL_ID; // snapshot the picked level's id for this run's result
    // The OPTIONAL companion-voice adapter for THIS level's mode. A no-op when the
    // companion preference is off (checked per-fire), so the game behaves exactly
    // as before when disabled — it only ever AUGMENTS the existing cues below.
    const companion = makeCompanion(modeForLevel(LEVEL));
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
          : LEVEL.goal === 'escape'
            ? 'You slipped past — escaped!'
            : 'You reached the beacon. Level complete!');
        // Companion arrival line — sequenced AFTER the win alert (never clobbers it).
        companion.win();
        // Offer "what next?" (repeat / explore / next / harder / levels). Delayed past
        // the win + score alerts so it doesn't clobber them, and focused for eyes-free
        // keyboard use. Cancellable: if the player leaves (B / navigate) before it
        // fires, teardown clears it so it can't pop over the picker. `victoryTimer` +
        // `showVictoryMenu` are defined in the run setup below.
        victoryTimer = setTimeout(() => showVictoryMenu(), 2600);
      },
      // SCORING (additive, after onWin): persist the completion + announce a new best
      // or a comparison to the standing best. Never alters the win path above.
      onComplete: (result) => {
        const { isBest, previousBest } = scoreStore.record(result);
        const line = announceCompletion(result, isBest, previousBest);
        // Sequenced after the win alert + companion arrival line so it doesn't clobber
        // them; rides the assertive region (and TTS) so the stat isn't lost behind the
        // polite status chatter (progress/companion lines keep writing #status).
        setTimeout(() => alert(line), 1500);
      },
      onCaught: () => {
        // The monster physically reached you — a loss, distinct from a win.
        endRun('caught');
        alert('A monster caught you. Press start to try again.');
        companion.caught();
      },
      // Stealth feedback: the player made a noise loud enough to be heard. Assertive
      // so it cuts through routine step chatter. Throttled so a loud floor doesn't
      // spam every footfall.
      onHeard: () => {
        if (ended) return;
        const now = performance.now();
        if (now - lastHeardMs < 1500) return;
        lastHeardMs = now;
        alert('You were heard!');
        // Urgent companion follow-up, sequenced after the assertive cue above.
        companion.heard();
      },
      // The decoy verb landed: announce it (eyes-free), with remaining budget when limited.
      onDecoy: (remaining) => {
        const left = Number.isFinite(remaining)
          ? ` ${remaining} ${remaining === 1 ? 'decoy' : 'decoys'} left.`
          : '';
        alert(`Decoy thrown.${left}`);
      },
      // SEQUENCE (trail) mode: the sound just moved to the next beacon in the trail.
      // Announce progress so an eyes-free player knows to follow the new sound.
      onSequenceAdvance: (index, total) => {
        if (index >= total) alert('Last beacon — follow the final sound to finish.');
        else alert(`Beacon ${index} of ${total} reached. Follow the next sound.`);
      },
      onProgress: (d) => {
        updateFootHints(d);
        // Companion milestone, keyed to the SAME coarse band as the status hint
        // (deduped to band changes, so it's not per-step). 0=almost…3=far.
        companion.progress(companionBand(d));
      },
      // Reaction mechanic (Part C): spoken, eyes-free signal-detection feedback.
      onReaction: (outcome) => {
        if (outcome === 'hit') alert('Detected.');
        else if (outcome === 'false-alarm') alert('False alarm.');
        // 'ignored' (a redundant press) is intentionally silent.
      },
      onMissed: () => alert('Missed one.'),
    }, undefined, steam, interpRenderer, { levelId, clapsUsed: () => clapsUsed });

    // Expose the running game + its engine state for the live Settings "Apply now"
    // hot-swap; null both on teardown so Apply knows no level is running.
    currentGame = game;
    // Seed the user's beacon volume onto the fresh game (its voices are already built).
    game.setBeaconVolume(settings.beaconVolume());
    currentEngineIsSteam = steam != null;
    currentSteamIsSofa = steam != null && steamSofaPref();
    currentSteamOrder = steam != null ? settings.steamReflectionOrder() : 0;
    teardowns.push(() => {
      game.destroy();
      if (currentGame === game) { currentGame = null; currentEngineIsSteam = false; currentSteamIsSofa = false; currentSteamOrder = 0; }
    });

    // --- Settings panel (audio mix + preferences). Opened from the ⚙ button or the
    // S key; every control wired to its existing hook, every change spoken. ---
    setupSettings(graph, teardowns);

    // DEBUG overlay: top-down minimap + live audio readout. Enabled by EITHER the
    // `?debug=1` URL (dev deep-link, unchanged) OR the Settings "debug overlay" pref,
    // and toggleable live with the G key (see keydown). Dynamically imported so it
    // costs nothing when off. `debugOverlay` holds the live instance (null = hidden).
    const urlDebug = new URLSearchParams(location.search).get('debug') === '1';
    let debugOverlay: import('./debug/debugOverlay').DebugOverlay | null = null;
    const showDebugOverlay = () => {
      if (debugOverlay) return;
      void import('./debug/debugOverlay').then(({ DebugOverlay }) => {
        // Guard against a teardown that raced the dynamic import.
        if (activeRun == null && !urlDebug) return;
        debugOverlay = new DebugOverlay(game);
      });
    };
    const hideDebugOverlay = () => { debugOverlay?.destroy?.(); debugOverlay = null; };
    // Set the overlay on/off + persist. Used by the G key (toggle) and the Settings
    // panel (via currentDebugOverlaySetter). `announce` lets the key path speak while
    // the Settings path stays quiet (the panel speaks its own confirmation).
    const setDebugOverlayState = (on: boolean, announce = false) => {
      if (on) showDebugOverlay(); else hideDebugOverlay();
      settings.setDebugOverlay(on);
      if (announce) alert(on ? 'Debug overlay on.' : 'Debug overlay off.');
    };
    const toggleDebugOverlay = () => setDebugOverlayState(debugOverlay == null, true);
    if (urlDebug || settings.debugOverlay()) showDebugOverlay();
    // Let the standalone Settings panel drive this run's overlay (no announce — the
    // panel speaks its own line); cleared on teardown.
    currentDebugOverlaySetter = (on) => setDebugOverlayState(on, false);
    teardowns.push(() => { hideDebugOverlay(); currentDebugOverlaySetter = null; });
    // E2E TEST HOOK: expose read-only game state + a deterministic step driver so the
    // Playwright smoke harness can drive the keyboard-completion path with explicit
    // timestamps (the normal step clock is the audio context, which doesn't advance
    // reliably headless). Gated behind the ?debug=1 URL only (never on the normal path).
    if (urlDebug) {
      (window as unknown as { __ps?: unknown }).__ps = {
        debugState: () => game.debugState(),
        step: (foot: 'L' | 'R', nowMs: number) => { if (!ended) game.step(foot, nowMs); },
        throwDecoy: (nowMs?: number) => game.throwDecoy(nowMs),
        won: () => outcome === 'won',
        outcome: () => outcome,
      };
    }

    // --- Turn control: the compass dial AND keyboard arrows (both drive the same
    // slewed heading, so audio + dial stay in sync). `turnBy` lets the keydown
    // handler nudge the heading; it announces the new heading via the live region. ---
    const { setTurnDir } = setupTurning(game, teardowns);

    // --- Step buttons ---
    const stepLeft = document.getElementById('step-left') as HTMLButtonElement;
    const stepRight = document.getElementById('step-right') as HTMLButtonElement;
    const doStep = (foot: 'L' | 'R') => {
      if (ended) return;
      game.step(foot);
      updateFeet(game); // refresh immediately after a step
    };
    // pointerdown (not click) for tight rhythm response.
    const onLeft = (e: PointerEvent) => { e.preventDefault(); doStep('L'); };
    const onRight = (e: PointerEvent) => { e.preventDefault(); doStep('R'); };
    stepLeft.addEventListener('pointerdown', onLeft);
    stepRight.addEventListener('pointerdown', onRight);
    teardowns.push(() => {
      stepLeft.removeEventListener('pointerdown', onLeft);
      stepRight.removeEventListener('pointerdown', onRight);
    });
    // Leave the current run mid-level and return to the picker. Stops the game
    // cleanly (stopActiveRun tears down audio + loops) and routes to the picker so
    // the URL/history reflect it. Announced for eyes-free use.
    const backToPicker = () => {
      alert('Leaving the level. Back to level select.');
      navigate({ screen: 'picker' });
    };

    // --- VICTORY MENU: shown after a win (from onWin, above). Offers Repeat / Explore
    // / Next / Harder / Level-select. Repeat/Next/Harder re-launch a computed
    // PickerSelection (see game/nextRun.ts) exactly as the picker would; Explore
    // un-freezes THIS run in place with the goal disabled (free roam). Wired here so it
    // has the run's `game`/`ended`/`backToPicker` in scope; torn down with the run. ---
    const victoryMenu = document.getElementById('victory-menu');
    // The delayed "show menu" timer (set in onWin). Held so teardown can cancel it —
    // otherwise leaving within 2.6s of a win pops the menu over the next screen.
    let victoryTimer: ReturnType<typeof setTimeout> | null = null;
    const hideVictoryMenu = () => { if (victoryMenu) victoryMenu.hidden = true; };
    // Re-launch a computed selection; a null selection (e.g. Harder off a showcase
    // builtin) has no meaningful target — say so and leave the menu up.
    const launchNext = (sel: PickerSelection | null, noneMsg: string) => {
      if (!sel) { alert(noneMsg); return; }
      hideVictoryMenu();
      void launchSelection(sel);
    };
    const builtins = builtinLevels();
    const onVRepeat = () => { if (LAST_LAUNCH) launchNext(repeatSelection(LAST_LAUNCH), ''); };
    const onVNext = () =>
      launchNext(LAST_LAUNCH ? nextSelection(LAST_LAUNCH, builtins) : null, 'No next level for this one.');
    const onVHarder = () =>
      launchNext(LAST_LAUNCH ? harderSelection(LAST_LAUNCH, builtins) : null, 'This is already the hardest version.');
    const onVExplore = () => {
      hideVictoryMenu();
      ended = false; // un-freeze input for free roam
      game.enterFreeRoam();
      alert('Explore mode. The goal is off — walk the room freely. Press B to leave.');
    };
    // showVictoryMenu is referenced by onWin (above) via setTimeout; hoisted so the
    // forward reference resolves. Only shows for a WIN (never after being caught).
    function showVictoryMenu() {
      if (!victoryMenu || outcome !== 'won') return;
      // Next/Harder may have no target for saved/showcase levels — hide rather than
      // offer a dead button. Repeat/Explore/Levels always apply.
      const nextBtn = document.getElementById('victory-next') as HTMLButtonElement | null;
      const harderBtn = document.getElementById('victory-harder') as HTMLButtonElement | null;
      if (nextBtn) nextBtn.hidden = !(LAST_LAUNCH && nextSelection(LAST_LAUNCH, builtins));
      if (harderBtn) harderBtn.hidden = !(LAST_LAUNCH && harderSelection(LAST_LAUNCH, builtins));
      victoryMenu.hidden = false;
      (document.getElementById('victory-repeat') as HTMLElement | null)?.focus();
    }
    const vRepeat = document.getElementById('victory-repeat');
    const vExplore = document.getElementById('victory-explore');
    const vNext = document.getElementById('victory-next');
    const vHarder = document.getElementById('victory-harder');
    const vLevels = document.getElementById('victory-levels');
    vRepeat?.addEventListener('click', onVRepeat);
    vExplore?.addEventListener('click', onVExplore);
    vNext?.addEventListener('click', onVNext);
    vHarder?.addEventListener('click', onVHarder);
    vLevels?.addEventListener('click', backToPicker);
    teardowns.push(() => {
      if (victoryTimer != null) { clearTimeout(victoryTimer); victoryTimer = null; }
      hideVictoryMenu();
      vRepeat?.removeEventListener('click', onVRepeat);
      vExplore?.removeEventListener('click', onVExplore);
      vNext?.removeEventListener('click', onVNext);
      vHarder?.removeEventListener('click', onVHarder);
      vLevels?.removeEventListener('click', backToPicker);
    });
    // AUTO-STEP (hold-W-to-walk). A single alternating step, and a steady timer that
    // fires them while W is held. `autoFoot` alternates L/R just like manual stepping;
    // the game's own cadence/alternation rules still apply (auto-step just presses the
    // keys for you). MEDIUM-SLOW cadence so it reads as a calm walk, not a sprint.
    const AUTO_STEP_MS = 700; // one footfall every 0.7 s ≈ a relaxed walking pace
    let autoFoot: 'L' | 'R' = 'L';
    let autoTimer: ReturnType<typeof setInterval> | null = null;
    const autoStepOnce = () => {
      if (ended) return;
      doStep(autoFoot);
      autoFoot = autoFoot === 'L' ? 'R' : 'L';
    };
    const startAutoWalk = () => {
      if (autoTimer != null || ended) return;
      autoStepOnce(); // immediate first step, then a steady cadence
      autoTimer = setInterval(autoStepOnce, AUTO_STEP_MS);
    };
    const stopAutoWalk = () => {
      if (autoTimer != null) { clearInterval(autoTimer); autoTimer = null; }
    };
    teardowns.push(stopAutoWalk);
    // Auto-step is a KEYBOARD convenience only (hold W / Up). On mobile the footprint
    // buttons (one step per tap) are the movement affordance — no hold-to-walk gesture.

    // Keyboard controls. A = left step, D = right step, W = forward (single step, or
    // hold-to-walk with the auto-step setting); Left/Right arrows turn (the CRITICAL
    // keyboard-turning fix — the game is uncompletable without a pointer drag otherwise);
    // B = back to level select; G = toggle debug overlay; ? or H speaks the controls.
    const onKeyDown = (e: KeyboardEvent) => {
      // While the settings dialog is open it owns the keyboard (its own Escape/Tab/
      // control handlers) — don't let game keys (step/turn/decoy/help/S) leak through.
      if (settingsPanel?.isOpen()) return;
      // TURN: Left/Right and Up/Down arrows (up=left, down=right), plus Q (left) / E
      // (right). keyTurnDelta returns 0 for non-turn keys, so a single check covers all.
      // HOLD to rotate at constant speed; RELEASE stops at once (see keyup). The SIGN
      // of keyTurnDelta is the turn direction; it returns 0 for non-turn keys.
      const turnDelta = keyTurnDelta(e.key, e.shiftKey);
      if (turnDelta !== 0) {
        // Prevent the page from scrolling (arrows). Ignore auto-repeat — the hold is
        // driven continuously in the slew loop, not by repeated keydowns.
        e.preventDefault();
        if (!ended && !e.repeat) setTurnDir(Math.sign(turnDelta));
        return;
      }
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      // FORWARD (W or Up arrow): does NOTHING by default — stepping is A/D. ONLY when the
      // AUTO-STEP setting is enabled does HOLDING it walk forward at a steady medium-slow
      // cadence (alternating feet). Handled before the `e.repeat` guard so key-repeat is
      // irrelevant (the timer drives the cadence); startAutoWalk is idempotent.
      if (k === 'w' || k === 'ArrowUp') {
        e.preventDefault(); // never let Up scroll the page
        if (settings.autoStep() && !ended) startAutoWalk();
        return;
      }
      // DOWN arrow: fire the PROBE (clap to hear the room) — a dedicated key so the
      // player doesn't need the pointer or the clashing Space bar. Swallow it so the
      // page doesn't scroll. No-op once the run has ended.
      if (k === 'ArrowDown') {
        e.preventDefault();
        if (!ended && !e.repeat) currentProbeTrigger?.();
        return;
      }
      if (e.repeat) return;
      // STEP: A = left foot, D = right foot.
      if (k === 'a') doStep('L');
      else if (k === 'd') doStep('R');
      else if (k === 't') {
        // Throw a sound decoy — pulls the noise-hunter toward where it lands. No-op
        // (and a spoken cue) when out of decoys; announcement is via onDecoy.
        if (!ended && !game.throwDecoy()) alert('No decoys left.');
      }
      else if (k === 'r') { if (!ended) game.react(); }
      else if (k === 's') settingsPanel?.toggle();
      else if (k === 'b') backToPicker();
      else if (k === 'g') toggleDebugOverlay();
      else if (k === '?' || k === 'h') speakControls();
    };
    window.addEventListener('keydown', onKeyDown);
    teardowns.push(() => window.removeEventListener('keydown', onKeyDown));

    // HOLD-TO-ROTATE: releasing a turn key stops the rotation immediately. Stop on ANY
    // turn-key release (holding left+right at once isn't expected); a stray keyup also
    // safely halts the turn if a dialog stole focus mid-hold.
    const onKeyUp = (e: KeyboardEvent) => {
      if (keyTurnDelta(e.key, e.shiftKey) !== 0) setTurnDir(0);
      // Releasing the forward key (W or Up arrow) stops hold-to-walk at once.
      const uk = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (uk === 'w' || uk === 'ArrowUp') stopAutoWalk();
    };
    window.addEventListener('keyup', onKeyUp);
    teardowns.push(() => window.removeEventListener('keyup', onKeyUp));
    // Safety: if focus leaves the window mid-hold, the keyup may never fire — stop then.
    const onBlur = () => { setTurnDir(0); stopAutoWalk(); };
    window.addEventListener('blur', onBlur);
    teardowns.push(() => window.removeEventListener('blur', onBlur));

    // In-game "back to level select" button (also reachable via the B key). Visible
    // + focusable so it works for pointer and keyboard alike.
    const gameBackBtn = document.getElementById('game-back-to-picker');
    gameBackBtn?.addEventListener('click', backToPicker);
    teardowns.push(() => gameBackBtn?.removeEventListener('click', backToPicker));

    // --- React button (Part C): visible only when the level has reaction events.
    const reactBtn = document.getElementById('react') as HTMLButtonElement | null;
    if (reactBtn) {
      const hasEvents = (SRC_LEVEL?.events?.length ?? 0) > 0;
      reactBtn.hidden = !hasEvents;
      const onReact = () => { if (!ended) game.react(); };
      reactBtn.addEventListener('click', onReact);
      teardowns.push(() => reactBtn.removeEventListener('click', onReact));
    }

    // --- Decoy button: visible only on levels with monsters (stealth). Mirrors the T
    // key so throwing a decoy — and thus WINNING stealth — works on touch devices.
    const decoyBtn = document.getElementById('decoy') as HTMLButtonElement | null;
    if (decoyBtn) {
      const hasMonsters = (SRC_LEVEL?.monsters?.length ?? 0) > 0;
      decoyBtn.hidden = !hasMonsters;
      const onDecoy = () => { if (!ended && !game.throwDecoy()) alert('No decoys left.'); };
      decoyBtn.addEventListener('click', onDecoy);
      teardowns.push(() => decoyBtn.removeEventListener('click', onDecoy));
    }

    // --- Clap to hear the room (echo button) ---
    setupClap(graph, renderer, game, () => { clapsUsed += 1; }, teardowns);

    // Foot display loop: only the expected foot shows while walking; after the
    // player settles (idle ~1.4s) BOTH feet appear so either can lead. Polled so
    // the time-based settle transition happens on its own.
    let footRaf: number | null = null;
    const footLoop = () => {
      // Advance the audio-only listener glide each frame (no-op when idle), so the
      // HRTF listener + beacon sweep smoothly between footfalls instead of teleporting.
      game.tick();
      updateFeet(game);
      footRaf = requestAnimationFrame(footLoop);
    };
    footLoop();
    teardowns.push(() => { if (footRaf != null) cancelAnimationFrame(footRaf); });
    // First-time, in-context mode primer (teaches the verb/goal the FIRST time a
    // player meets a special mode), then the mode-aware objective. The primer is
    // remembered per-mode in onboardingStore so it never re-walls a returning
    // player; it's the assertive `alert`, the objective the polite `say`.
    const primerShown = maybeShowModePrimer();
    // Mode-aware objective, spoken (eyes-free). Escape/stealth gets its own brief.
    // The stealth brief shares the assertive region with the primer, so skip it on
    // the first run (the primer just taught the same thing and would be clobbered).
    if (LEVEL.goal === 'escape') {
      if (!primerShown) {
        alert(
          'Reach the exit without being heard. A monster hunts the noise you make — ' +
          'tread on carpet to stay quiet, avoid the gravel, and press T to throw a decoy.',
        );
      }
    } else if (LEVEL.goal === 'absorber') {
      say('Clap to hear the room, then walk to the dead spot where the echo is swallowed.');
    } else if ((LEVEL.events?.length ?? 0) > 0) {
      if (!primerShown) {
        const need = LEVEL.requiredReactions ?? 0;
        say(
          'Listen to the steady sound. Press React — the R key or the React button — ' +
          'the moment it briefly dips or is muffled.' +
          (need > 0 ? ` React to at least ${need} to win, then walk to the sound.` : ''),
        );
      }
    } else {
      say('Walk to the beacon ahead. Alternate left and right steps — and don\'t rush.');
    }
    // Companion objective-framing line, AFTER the plain objective above so it
    // augments (and doesn't clobber) it. No-op when the companion is disabled.
    // A short delay lets the objective land first in the polite region.
    setTimeout(() => companion.start(), 1400);
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

/**
 * Coarse closeness band for distance (0 almost…3 far). Shared by the status hint
 * and the companion so the two agree about "how close" the player is.
 */
function companionBand(distance: number): number {
  return distance < 1 ? 0 : distance < 3 ? 1 : distance < 6 ? 2 : 3;
}

/** Announce closing distance at coarse thresholds (eyes-free progress feedback). */
let lastBand = -1;
function updateFootHints(distance: number) {
  const band = companionBand(distance);
  if (band !== lastBand) {
    lastBand = band;
    const labels = ['Almost there', 'Close', 'Getting closer', 'Far'];
    say(`${labels[band]} — ${distance.toFixed(1)} m to the beacon.`);
  }
}

/**
 * Mount the compass dial + the slewed-heading loop, and return a `turnBy(delta)`
 * that nudges the heading target by `delta` radians (used by the keyboard arrow
 * handler). Both the dial drag and the keyboard drive the SAME `Heading`, so the
 * audio and the visible dial always agree. Keyboard turns are announced (debounced)
 * via the live region so an eyes-free user hears their new heading.
 */
function setupTurning(
  game: Game,
  teardowns: Array<() => void>,
): { turnBy: (delta: number) => void; setTurnDir: (dir: number) => void } {
  const turnPad = document.getElementById('turn-pad')!;
  // Clear any compass left by a previous run, so returning to a level doesn't stack
  // dials in the turn pad.
  turnPad.replaceChildren();

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
  // As the SLEWED heading sweeps across an 8-point compass detent (N/NE/E/…), fire
  // a subtle, debounced spoken cue naming the new direction (G2). Only on a crossing
  // — never continuously — and rate-limited so a fast spin doesn't machine-gun the
  // live region. It rides the SAME polite `say()` as the keyboard read-out; a held
  // turn's settle announcement (below) supersedes it when the turn stops.
  let lastT = performance.now();
  let lastDetentSpokenAt = 0;
  let slewRaf: number | null = null;
  // HOLD-TO-ROTATE (keyboard): while a turn key is held, `turnDir` is -1 (left) /
  // +1 (right) and we advance the TARGET by maxRate·dir·dt each frame, so the slewed
  // heading tracks at full speed. On key release `setTurnDir(0)` snaps the target to
  // the current value, stopping instantly with no coast. 0 ⇒ idle (dial/other input).
  let turnDir = 0;
  const loop = (now: number) => {
    const dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;
    // Drive a held keyboard turn at constant angular speed (the same cap the slew
    // uses), by walking the target ahead of the value each frame.
    if (turnDir !== 0) heading.setTarget(heading.desired + turnDir * heading.maxRate * dt);
    const prev = heading.current;
    if (heading.tick(dt)) {
      game.setYaw(heading.current);
      compass.setHeading(heading.current);
      const detent = crossedDetent(prev, heading.current);
      // Subtle detent cue: only while actively slewing (target not yet reached) and
      // no more than ~3×/s, so passing several detents in a fast turn doesn't spam.
      if (detent != null && now - lastDetentSpokenAt > 300) {
        lastDetentSpokenAt = now;
        say(`Facing ${COMPASS_POINTS[detent]}.`);
      }
    }
    slewRaf = requestAnimationFrame(loop);
  };
  slewRaf = requestAnimationFrame(loop);
  teardowns.push(() => {
    if (slewRaf != null) cancelAnimationFrame(slewRaf);
    turnPad.replaceChildren();
  });

  // Keyboard turning: nudge the target heading, sync the dial, and announce the
  // new heading after a short idle so a held/repeated key doesn't spam the live
  // region (it speaks once the turn settles). The settle read-out NAMES the nearest
  // compass direction (G2), e.g. "Turned 45 degrees right, facing north-east."
  let announceTimer: ReturnType<typeof setTimeout> | null = null;
  const turnBy = (delta: number) => {
    if (delta === 0) return;
    heading.setTarget(heading.desired + delta);
    compass.setHeading(heading.desired);
    if (announceTimer != null) clearTimeout(announceTimer);
    announceTimer = setTimeout(() => say(announceHeadingWithDirection(heading.desired)), 250);
  };
  // HOLD-TO-ROTATE: dir -1 = left, +1 = right, 0 = stop. Setting a non-zero dir starts
  // a constant-speed turn (driven in the slew loop); setting 0 stops it IMMEDIATELY by
  // snapping the target to where the heading currently is (no coasting), then announces
  // the settled heading once.
  const setTurnDir = (dir: number) => {
    if (dir === turnDir) return;
    turnDir = dir;
    if (dir === 0) {
      heading.setTarget(heading.current); // stop here, don't coast to a stale target
      if (announceTimer != null) clearTimeout(announceTimer);
      announceTimer = setTimeout(() => say(announceHeadingWithDirection(heading.current)), 150);
    }
  };
  return { turnBy, setTurnDir };
}

/**
 * Classify the current level into a special mode that warrants a first-time
 * primer, or null for a plain beacon level (which the tutorial already covered).
 * Stealth = escape goal; absorber = absorber goal; sonar = a clap-budgeted level.
 */
function currentPrimerMode(): PrimerMode | null {
  if (LEVEL.goal === 'escape') return 'stealth';
  if (LEVEL.goal === 'absorber') return 'absorber';
  if ((LEVEL.events?.length ?? 0) > 0) return 'reaction';
  if (LEVEL.clapBudget != null) return 'sonar';
  return null;
}

/** One-line, in-context teaching for each special mode's verb/goal. */
function modePrimerText(mode: PrimerMode): string {
  switch (mode) {
    case 'stealth':
      return 'New mode — Stealth. A monster hunts the NOISE you make, not your position. ' +
        'Step softly on carpet, avoid loud floors, and press T to throw a decoy that lures it away.';
    case 'absorber':
      return 'New mode — Find the absorber. There is no beacon to follow. Clap with the Echo ' +
        'button to hear the room, then walk to the dead spot where one wall swallows the echo.';
    case 'sonar':
      return 'New mode — Sonar budget. Your claps are limited, so spend them wisely. ' +
        'Each Echo costs a clap; the button tells you how many remain.';
    case 'reaction':
      return 'New mode — Reaction. Listen to the steady sound ahead. Every so often ' +
        'something briefly passes in front of it and the sound DIPS — it gets quieter ' +
        'and more muffled for a moment. The instant you notice a dip, press React — ' +
        'the R key, or the React button on screen. Then walk to the sound. React to ' +
        'enough dips to win.';
  }
}

/**
 * Show the current mode's primer the FIRST time it's encountered, then remember
 * it so it never shows again (per-mode flag in onboardingStore). No-op for plain
 * beacon levels or for a mode already seen.
 */
function maybeShowModePrimer(): boolean {
  const mode = currentPrimerMode();
  if (!mode || onboarding.modePrimerSeen(mode)) return false;
  alert(modePrimerText(mode));
  onboarding.setModePrimerSeen(mode);
  return true;
}

/** Speak the keyboard control scheme via the live region (the ? / H help key). */
function speakControls() {
  say(renderControlsSpeech());
}

/**
 * Mount the settings panel and wire its opener (the ⚙ button + the S key, set up
 * in the keydown handler). Every control is wired to its existing hook here — the
 * single place that applies + persists each pref. Reset clears trainer + daily
 * streak + onboarding/primer flags so first-run onboarding replays.
 */
/**
 * Make the persisted Steam Audio settings LIVE on the running level (the Settings
 * "Apply now" verb), without restarting it. The decision:
 *
 *  - No level running → announce "start a level first" (nothing to apply to).
 *  - Engine UNCHANGED & a Steam backend is live → LIGHT: just push the new reverb/
 *    reflection levels (bus levels live via setSteamBusLevels → setGain; the
 *    per-source reflection level via setSteamReflectionWet → voice rebuild).
 *  - Engine UNCHANGED & Steam is OFF (staying off) → announce it only affects Steam.
 *  - Engine TOGGLED → HEAVY: rebuild the spatial voices on the new backend.
 *      • turning ON: build a Steam backend; on FAILURE keep our engine + announce
 *        (never silent).
 *      • turning OFF: setSpatialBackend(null) → back to our engine.
 *
 * State (won/caught/decoys/pose/monsters/footsteps) is preserved across the HEAVY
 * swap by Game.setSpatialBackend.
 */
async function applySteamNow(graph: AudioGraph) {
  const game = currentGame;
  if (!game) { say('Start a level first to apply Steam Audio settings.'); return; }
  // Beacon volume applies to BOTH engines (it's the dry beacon voice), so apply it
  // unconditionally, before the steam-specific early-returns below.
  game.setBeaconVolume(settings.beaconVolume());
  // CLUTTER applies to BOTH engines and is baked into wall materials at level load, so a
  // slider change needs the geometry re-baked + re-pushed live (else it only takes effect
  // on a full page reload). Detect a change vs what's baked and re-derive the walls/edges
  // from the raw level with the new effective clutter, then push them into the running game.
  if (SRC_LEVEL) {
    const effClutter = Math.max(SRC_LEVEL.clutter ?? 0, settings.clutter());
    if (effClutter !== currentClutter) {
      const reloaded = loadLevel(SRC_LEVEL, effClutter);
      WALLS = reloaded.walls;
      EDGES = reloaded.edges;
      SCATTER = reloaded.scattering;
      currentClutter = effClutter;
      // Re-push into the game (updates LEVEL.acousticWalls/edges + rebuilds the Steam
      // scene / re-solves the modeled beacon). Same path moving-wall levels use.
      game.setAcousticGeometry(WALLS, EDGES);
    }
  }
  const wantSteam = steamEnginePref();
  const wantSofa = steamSofaPref();
  const wantOrder = settings.steamReflectionOrder();
  const reflectionWetLevel = settings.steamReflectionWet();
  const reflectionBusLevel = settings.steamReflectionBus();
  const reverbBusLevel = settings.steamReverbBus();

  // The HRTF (SADIE vs generic) AND the Ambisonic order are baked at world creation,
  // so switching either needs a full backend rebuild even when engine on/off is unchanged.
  const engineUnchanged = wantSteam === currentEngineIsSteam;
  const bakedChanged = wantSteam && currentEngineIsSteam
    && (wantSofa !== currentSteamIsSofa || wantOrder !== currentSteamOrder);
  if (engineUnchanged && !bakedChanged) {
    if (currentEngineIsSteam) {
      // LIGHT: engine + HRTF unchanged, Steam live → re-scale the two bus levels in
      // place, then apply the per-source reflection level (which rebuilds the voices).
      game.setSteamBusLevels(reflectionBusLevel, reverbBusLevel);
      game.setSteamReflectionWet(reflectionWetLevel);
      say('Steam Audio levels applied.');
    } else {
      say('Those settings only affect Steam Audio, which is off.');
    }
    return;
  }

  // HEAVY: engine toggled OR a baked param (HRTF / order) changed → fresh backend.
  if (wantSteam) {
    say('Switching to high-fidelity audio…');
    const steam = await buildSteamBackend(graph.ctx, graph.master);
    if (!steam) {
      // Build failed → keep the current (our) engine; never leave the game silent.
      say('High-fidelity audio is unavailable here. Keeping the standard engine.');
      return;
    }
    // The backend build is async (dynamic import + WASM init); the run could have been
    // torn down (or replaced) meanwhile. If so, drop the freshly-built backend rather
    // than apply it to a dead/other game.
    if (currentGame !== game) { try { steam.dispose?.(); } catch { /* noop */ } return; }
    game.setSpatialBackend(steam);
    currentEngineIsSteam = true;
    currentSteamIsSofa = wantSofa;
    currentSteamOrder = wantOrder;
    say(bakedChanged && engineUnchanged
      ? 'Steam Audio settings applied.'
      : 'High-fidelity audio applied.');
  } else {
    game.setSpatialBackend(null);
    currentEngineIsSteam = false;
    currentSteamIsSofa = false;
    currentSteamOrder = 0;
    say('Switched to the standard audio engine.');
  }
}

function setupSettings(graph: AudioGraph, teardowns: Array<() => void> = []) {
  const host = document.getElementById('settings-screen');
  if (!host) return;
  settingsPanel = mountSettings(host, {
    say,
    alert,
    getMasterVolume: () => settings.masterVolume(),
    setMasterVolume: (v) => {
      settings.setMasterVolume(v);
      setMasterVolume(graph, v);
    },
    getCompanion: () => companionEnabled(),
    setCompanion: (on) => setCompanion(on),
    // Auto-step (hold-W-to-walk): pure persisted pref; the in-game keydown reads it
    // live, so no live wiring is needed.
    getAutoStep: () => settings.autoStep(),
    setAutoStep: (on) => settings.setAutoStep(on),
    // Probe chooser: which echo sound the player fires (synth presets + CC recordings).
    // Persisted; setupClap reads it live at fire time, so no re-wiring is needed.
    getProbeChoice: () => settings.probeChoice(),
    setProbeChoice: (id) => settings.setProbeChoice(id),
    probeOptions: () => probeOptions(cachedClicksManifest() ?? []),
    // Debug overlay: persist the pref AND, if a level is running, toggle the live
    // overlay via the run's registered hook (mirrors the G key).
    getDebugOverlay: () => settings.debugOverlay(),
    setDebugOverlay: (on) => {
      settings.setDebugOverlay(on);
      currentDebugOverlaySetter?.(on);
    },
    // Room clutter (both engines) — persisted; baked into geometry at level load, so
    // it applies on the next level (applyLevel reads settings.clutter()).
    getClutter: () => settings.clutter(),
    setClutter: (v) => settings.setClutter(v),
    // High-fidelity (Steam Audio) engine. Persisted only — the backend is built at
    // Begin, so switching mid-session can't hot-swap the live graph; the next level
    // start honours the stored choice (see the Begin handler's wantSteam below). The
    // Begin-screen toggle + ?engine=steam URL stay valid; this is an extra control.
    getSteamEngine: () => steamEnginePref(),
    setSteamEngine: (on) => {
      settings.setSteamEngineEnabled(on);
      // Keep the Begin-screen checkbox in sync so returning to it shows the choice.
      if (engineToggle) engineToggle.checked = on;
    },
    // Steam HRTF: our SADIE vs generic. Persisted; applied on next level or via Apply
    // (an HRTF change forces a backend rebuild — it's baked at world creation).
    getSteamSofaHrtf: () => settings.steamSofaHrtf(),
    setSteamSofaHrtf: (on) => settings.setSteamSofaHrtf(on),
    getSteamReflectionOrder: () => settings.steamReflectionOrder(),
    setSteamReflectionOrder: (order) => settings.setSteamReflectionOrder(order),
    // Steam reflection / bus levels (3 knobs) — persisted by these setters; made live
    // by "Apply now" (the bus levels live; the per-source reflection level rebuilds).
    // All default 1.0 (= today's behavior).
    getSteamReflectionWet: () => settings.steamReflectionWet(),
    setSteamReflectionWet: (v) => settings.setSteamReflectionWet(v),
    getSteamReflectionBus: () => settings.steamReflectionBus(),
    setSteamReflectionBus: (v) => settings.setSteamReflectionBus(v),
    getSteamReverbBus: () => settings.steamReverbBus(),
    setSteamReverbBus: (v) => settings.setSteamReverbBus(v),
    getBeaconVolume: () => settings.beaconVolume(),
    setBeaconVolume: (v) => settings.setBeaconVolume(v),
    // LIVE "Apply now": make the persisted Steam engine + reverb/reflection choices
    // take effect on the RUNNING level without restarting it. Decides LIGHT vs HEAVY.
    applySteamNow: () => { void applySteamNow(graph); },
    getSwap: () => onboarding.swap(),
    setSwap: (on) => {
      onboarding.setSwap(on);
      applyChannelSwap(graph, on);
    },
    // Loudness / hearing EQ — re-run the SAME equal-loudness flow standalone. We close
    // the panel, host the flow in the settings screen, then on finish persist + apply
    // the curve LIVE to the running master and reopen settings.
    runLoudnessEq: () => {
      settingsPanel?.close();
      const eqHost = document.getElementById('settings-screen');
      if (!eqHost) return;
      eqHost.hidden = false;
      mountLoudnessEq(eqHost, {
        ctx: graph.ctx,
        dest: graph.master,
        say,
        alert,
        saveCurve: (curve) => {
          settings.setLoudnessEq(curve);
          applyLoudnessEq(graph); // live: rebuild master → eq → swap → limiter
        },
        onDone: () => {
          // Re-render the panel (host content was replaced) and reopen.
          setupSettings(graph, []);
          settingsPanel?.open();
        },
      });
    },
    hasLoudnessEq: () => settings.loudnessEq() != null,
    clearLoudnessEq: () => {
      settings.clearLoudnessEq();
      applyLoudnessEq(graph); // live: drop the EQ from the master path
    },
    // Spoken-voice (TTS). Each setter persists AND re-pushes into the live Speech
    // wrapper so the change applies immediately (and the test-voice sample uses it).
    ttsSupported: () => speech.isSupported(),
    getTtsEnabled: () => settings.ttsEnabled(),
    setTtsEnabled: (on) => {
      settings.setTtsEnabled(on);
      speech.update({ enabled: on });
      if (!on) speech.cancel();
    },
    availableVoices: () => speech.availableVoices(),
    getTtsVoice: () => settings.ttsVoice(),
    setTtsVoice: (name) => {
      settings.setTtsVoice(name);
      speech.update({ voiceName: name || undefined });
    },
    getTtsRate: () => settings.ttsRate(),
    setTtsRate: (r) => {
      settings.setTtsRate(r);
      speech.update({ rate: settings.ttsRate() });
    },
    getTtsPitch: () => settings.ttsPitch(),
    setTtsPitch: (p) => {
      settings.setTtsPitch(p);
      speech.update({ pitch: settings.ttsPitch() });
    },
    // Speak a sample line through the CURRENT voice/rate/pitch, bypassing the
    // enabled gate (the user is auditioning) — but only when an engine exists.
    testVoice: (line) => speech.speakSample(line),
    resetProgress: () => {
      trainerStore.clear();
      dailyStreakStore.clear();
      scoreStore.clear();
      onboarding.clearAll();
    },
  });
  const openBtn = document.getElementById('open-settings');
  const onOpen = () => settingsPanel?.open();
  openBtn?.addEventListener('click', onOpen);
  teardowns.push(() => openBtn?.removeEventListener('click', onOpen));
}

function setupClap(
  graph: AudioGraph,
  renderer: HrtfRenderer,
  game: Game,
  onClap: () => void = () => {},
  teardowns: Array<() => void> = [],
) {
  const clapRoom = new ClapRoom(graph, renderer);
  const listenBtn = document.getElementById('listen') as HTMLButtonElement | null;

  // PROBE CHOICE: the player's chosen echo probe (Settings' probe chooser). ProbeResolver
  // owns the choice→(synth name | decoded recording buffer) resolution + async caching;
  // `probeResolver.probe()` yields the arg for clapRoom.clap() live at fire time.
  const probeResolver = new ProbeResolver(
    () => settings.probeChoice(),
    (url) => loadCustomLoop(graph.ctx, url),
  );

  // In-game PROBE PICKER: a small <select> beside the echo button so the player can
  // change which sound they fire without opening Settings. Same persisted choice
  // (settings.probeChoice) the Settings chooser + ProbeResolver read, so the two stay
  // in sync and setupClap needs no extra wiring — the resolver reads it live at fire.
  const probePick = document.getElementById('probe-pick') as HTMLSelectElement | null;
  if (probePick) {
    const opts = probeOptions(cachedClicksManifest() ?? []);
    probePick.replaceChildren(
      ...opts.map((o) => {
        const el = document.createElement('option');
        el.value = o.id;
        el.textContent = o.label;
        el.title = o.hint;
        return el;
      }),
    );
    probePick.value = settings.probeChoice();
    const onPick = () => settings.setProbeChoice(probePick.value);
    probePick.addEventListener('change', onPick);
    teardowns.push(() => probePick.removeEventListener('change', onPick));
  }

  // The sonar budget for THIS run. Absent config ⇒ unlimited (today's free clap):
  // isManaged() is false, so no counter is shown or announced.
  const budget = new ClapBudget({ max: LEVEL.clapBudget, cooldownMs: LEVEL.clapCooldownMs });
  const BASE_CLAP_LABEL = 'Listen — clap to hear the room';

  /** Format remaining claps for the button label ("3 claps left"). */
  const remainingPhrase = () => budgetRemainingPhrase(budget.remaining());

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
  //
  // CLOBBER FIX (7B): on a sonar level's FIRST encounter the sonar primer fires its
  // own `alert` synchronously right after setupClap returns, which would overwrite
  // this budget intro in the same assertive region. Delay the intro slightly so it
  // lands AFTER the primer/objective block instead of being clobbered by it. On
  // return runs (no primer) the small delay is harmless.
  if (budget.isManaged() && budget.hasBudget()) {
    refreshClapUi();
    setTimeout(() => alert(budgetIntroAnnouncement(budget.remaining())), 1800);
  }

  const onListen = () => {
    const nowMs = performance.now();
    const res = budget.consume(nowMs);
    if (!res.ok) {
      // Refused — give a clear spoken cue (assertive), no clap fired.
      alert(clapRefusedAnnouncement(res.reason, res.ok ? 0 : res.waitMs));
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
    // Fire the player's CHOSEN probe (Settings' probe chooser): a synth preset name or
    // a decoded CC recording buffer. Defaults to the noise-burst clap.
    clapRoom.clap(probeResolver.probe());
    onClap(); // count this fired clap toward the run's score (claps used)
    say('Clap! Listen to the room around you.');
    // Announce remaining budget eyes-free; unmanaged levels stay exactly as before.
    // Use the assertive region for the budget cue so the last-clap warning and the
    // out-of-sonar state aren't lost behind the routine "Clap!" status text.
    if (budget.hasBudget()) {
      alert(clapFiredAnnouncement(budget.remaining(), true));
    }
    refreshClapUi();
  };
  listenBtn?.addEventListener('click', onListen);
  teardowns.push(() => listenBtn?.removeEventListener('click', onListen));

  // Dedicated PROBE key (Down arrow) fires the same clap/probe as the on-screen echo
  // button — a keyboard shortcut so the player doesn't need the pointer or the clashing
  // Space bar (which scrolls / activates focused controls). Registered module-level so
  // the keydown handler (a separate closure) can call it; cleared on teardown.
  currentProbeTrigger = onListen;
  teardowns.push(() => { if (currentProbeTrigger === onListen) currentProbeTrigger = null; });

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
