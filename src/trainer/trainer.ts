/**
 * Echolocation Trainer controller.
 *
 * Eyes-free / screen-reader-first drill page. A pure generator (`exercises.ts`)
 * produces a Question — either an A/B room-discrimination or a single-room
 * direction task. We reuse the debug `ScenePlayer` for playback: it already
 * fires a clap through the room IR (size/material cues) and renders a positioned
 * HRTF tone (direction cue). A/B scenes share one player; we `load` whichever
 * room the listener asks to hear, so they can replay A and B freely.
 *
 * Audio is gated behind a Begin button (browsers require a user gesture).
 * Everything is announced via an aria-live region so it plays with eyes closed.
 */
import { initAcoustics } from '../engine/acoustics/core';
import { startAudio } from '../engine/audioGraph';
import { HrtfRenderer } from '../engine/hrtf/renderer';
import { ScenePlayer, type ProbeSpec } from '../debug/scenePlayer';
import { PROBE_PRESETS, isProbeName } from '../debug/probes';
import {
  makeRandomQuestion,
  hasRoomB,
  echoDelayMs,
  ALL_TYPES,
  type Question,
  type ExerciseType,
} from './exercises';
import { Staircase, difficultyBand, progressAnnouncement } from './adaptive';
import { DistanceLadder, ladderAnnouncement } from './distanceLadder';
import { TrainerStore, summarizeProgress, trendSummary } from './trainerStore';
import { planReplay, replayAnnouncement, type ReplayPlan } from './replay';
import { shouldRunOnboarding, onboardingQuestion, ONBOARDING_REVEAL } from './onboarding';
import { drawSparkline } from './sparkline';
import {
  challengeForDate,
  dailyOpenAnnouncement,
  dailyResultAnnouncement,
  shareScoreString,
  type DailyChallenge,
  type DateStr,
} from './daily';
import { DailyStreakStore } from './dailyStreakStore';
import { selectBackendFromSearch } from '../engine/steamaudio/toggle';
import type { SpatialBackend } from '../game/game';

const HRTF_URL = '/assets/hrtf/sadie_h3.hrtf';
const $ = (id: string) => document.getElementById(id)!;

let player: ScenePlayer | null = null;
let current: Question | null = null;
let answered = false;
let score = 0;
let asked = 0;
let seedCounter = (Math.random() * 1e9) | 0;
/** Which room is currently loaded into the shared player, for A/B replay. */
let loadedRoom: 'A' | 'B' | null = null;
/**
 * Keyboard answer cursor: index into the current question's choice buttons that
 * Q/E cycles through and Enter/Space confirms. -1 = nothing highlighted yet.
 */
let answerCursor = -1;

/**
 * Adaptive staircase (default mode). 2-down/1-up: harder after 2 in a row right,
 * easier after one miss, step halving at reversals → parks the learner at their
 * discrimination threshold. The manual "Fixed — …" picker overrides it.
 */
const staircase = new Staircase();

/**
 * Thaler distance ladder for the `distance` exercise: backs the target away in
 * 33 cm steps once accuracy hits ≥90% over a window. Only consulted when the
 * selected exercise type is `distance` (it parameterises the near-panel distance).
 */
const distanceLadder = new DistanceLadder();

/** Trainer progress persistence (localStorage; degrades to memory). */
const trainerStore = new TrainerStore();
/** The exercise type this session is drilling (fixed at Begin). 'all' for mixed. */
let sessionType = 'all';
/** Per-session counters folded into a stored session sample on flush. */
let sessionTrials = 0;
let sessionCorrect = 0;
/** Whether this session has produced anything worth persisting yet. */
let sessionDirty = false;
/** One-shot returning-user greeting, spoken with the first question. */
let pendingGreeting = '';

/**
 * Freeze-frame replay state: after an A/B answer we auto-play A→gap→B with labels.
 * `replayToken` is bumped on Next (and on a new question) so an in-flight replay's
 * scheduled steps see a stale token and abort — that's how the Next button skips it.
 */
let replayToken = 0;
/** True while the onboarding "blind reference" trial is the active question. */
let onboardingActive = false;
/** True once onboarding has been consumed this session (so we don't re-enter). */
let onboardingDone = false;

/**
 * Persist the current sitting as ONE stored session: the first flush appends a
 * session sample; later flushes UPDATE that same sample in place (so a long
 * sitting is one session, not one-per-trial). Checkpointing on settle + on unload
 * means a returning user's "last session" reflects the work they actually did.
 */
let sessionRecorded = false;
function flushSession() {
  if (!sessionDirty || sessionTrials === 0) return;
  const sample = { threshold: staircase.threshold(), trials: sessionTrials, correct: sessionCorrect };
  if (sessionRecorded) {
    trainerStore.updateLastSession(sessionType, sample);
  } else {
    trainerStore.recordSession(sessionType, sample);
    sessionRecorded = true;
  }
  sessionDirty = false;
  renderDashboard(); // reflect the freshly-checkpointed threshold in the trend
}

function announce(msg: string) {
  ($('live') as HTMLElement).textContent = msg;
}

/**
 * Render the per-skill progress dashboard: for every exercise type with history,
 * a labelled sparkline (canvas — the visible improvement curve) PLUS a spoken text
 * summary (the accessible truth, since canvas is invisible to screen readers). The
 * labels come straight from the #type picker so they stay in sync. Hidden entirely
 * when there's no history yet (a brand-new user sees nothing to clutter the page).
 */
function renderDashboard() {
  const panel = document.getElementById('progress-panel') as HTMLElement | null;
  const list = document.getElementById('progress-list') as HTMLElement | null;
  if (!panel || !list) return;
  const typeSel = document.getElementById('type') as HTMLSelectElement | null;
  // Map each picker value → its human label (covers 'all' + every exercise type).
  const labels = new Map<string, string>();
  if (typeSel) for (const opt of Array.from(typeSel.options)) labels.set(opt.value, opt.text);

  const map = trainerStore.load();
  list.innerHTML = '';
  let any = false;
  for (const [type, p] of Object.entries(map)) {
    if (!p.thresholdLog || p.thresholdLog.length === 0) continue;
    any = true;
    const label = labels.get(type) ?? type;
    const summary = trendSummary(label, p);

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:12px;margin:8px 0';

    const canvas = document.createElement('canvas');
    canvas.width = 120;
    canvas.height = 32;
    canvas.style.cssText = 'flex:0 0 auto;background:#101010;border-radius:6px';
    // Canvas is decorative; the adjacent text carries the meaning for AT.
    canvas.setAttribute('aria-hidden', 'true');
    drawSparkline(canvas, p);

    const text = document.createElement('span');
    text.style.cssText = 'font-size:14px;color:#ccc';
    text.textContent = summary;

    row.appendChild(canvas);
    row.appendChild(text);
    list.appendChild(row);
  }
  panel.hidden = !any;
}

// --- Daily Challenge ----------------------------------------------------------

/** Streak persistence for the daily challenge (localStorage; degrades to memory). */
const dailyStore = new DailyStreakStore();
/** When in daily mode, the day's fixed challenge; null in normal drill mode. */
let dailyChallenge: DailyChallenge | null = null;
/** The day's date string, captured once at the UI layer (browser clock is OK here). */
let dailyDate: DateStr | null = null;

/**
 * Today's date as YYYY-MM-DD. Read at the UI layer ONLY (new Date() is allowed in
 * trainer.ts but forbidden in the pure daily.ts module). Uses LOCAL date parts so
 * "today" matches the player's wall calendar. A ?date=YYYY-MM-DD override (tests)
 * lets the daily be exercised deterministically without faking the clock.
 */
function todayStr(): DateStr {
  const override = new URLSearchParams(location.search).get('date');
  if (override && /^\d{4}-\d{2}-\d{2}$/.test(override)) return override;
  const d = new Date();
  const yyyy = d.getFullYear().toString().padStart(4, '0');
  const mm = (d.getMonth() + 1).toString().padStart(2, '0');
  const dd = d.getDate().toString().padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** Refresh the resting daily-panel status line (spoken on open, shown always). */
function refreshDailyStatus() {
  const date = todayStr();
  const challenge = challengeForDate(date);
  const st = dailyStore.load();
  const done = dailyStore.isCompletedOn(date);
  ($('daily-status') as HTMLElement).textContent =
    dailyOpenAnnouncement({ challenge, currentStreak: st.currentStreak, doneToday: done });
}

/** Read the difficulty-mode picker: 'adaptive' or a fixed numeric string. */
function fixedDifficulty(): number | null {
  const v = ($('difficulty-mode') as HTMLSelectElement).value;
  return v === 'adaptive' ? null : Number(v);
}

/** Difficulty for the NEXT question: the staircase's, unless fixed-mode overrides. */
function difficulty(): number {
  const fixed = fixedDifficulty();
  return fixed === null ? staircase.current() : fixed;
}

/** A user-picked File decoded once and reused as a probe buffer. */
let pickedProbeBuffer: AudioBuffer | null = null;

/**
 * Resolve the probe chosen in the UI into a ScenePlayer ProbeSpec. The same probe
 * is applied to BOTH rooms so the A/B comparison stays fair. Custom: a picked File
 * (decoded buffer) wins over a typed URL; falls back to the synth clap if neither.
 */
function selectedProbe(): ProbeSpec {
  const value = ($('probe') as HTMLSelectElement).value;
  if (isProbeName(value)) return value;
  // 'custom'
  if (pickedProbeBuffer) return { buffer: pickedProbeBuffer };
  const url = ($('probe-url') as HTMLInputElement).value.trim();
  if (url) return { url };
  return 'clap'; // nothing supplied → fall back
}

/** Apply the current UI probe to the player (awaited so loads finish before fire). */
async function applyProbe(p: ScenePlayer): Promise<void> {
  await p.setProbe(selectedProbe());
}

async function ensurePlayer(): Promise<ScenePlayer> {
  if (player) return player;
  await initAcoustics();
  const graph = await startAudio();
  const renderer = await HrtfRenderer.create(graph.ctx, HRTF_URL);
  player = new ScenePlayer(graph, renderer);

  // High-fidelity toggle: the checkbox (pre-seeded from ?engine=steam) selects the
  // Steam Audio backend for the continuous TONE / direction exercises. Loaded via a
  // dynamic import (keeps three + the 6 MB WASM out of the default bundle). On ANY
  // init failure (no cross-origin isolation, WASM error) we silently keep our engine.
  const toggle = document.getElementById('engine-steam-toggle') as HTMLInputElement | null;
  const wantSteam = toggle ? toggle.checked : selectBackendFromSearch(location.search) === 'steam';
  if (wantSteam) {
    try {
      const { SteamAudioBackend } = await import('../engine/steamaudio/backend');
      const backend: SpatialBackend = await SteamAudioBackend.create(graph.ctx, graph.master, { hrtf: true });
      player.setSteamBackend(backend);
      // Pump the Steam Audio sim each frame so occlusion + reflections track turns.
      let lastT = performance.now();
      const loop = (now: number) => {
        player?.tick(Math.min(0.05, (now - lastT) / 1000));
        lastT = now;
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
      console.info('[trainer] Steam Audio backend active for tone exercises.');
    } catch (e) {
      console.warn('[trainer] Steam Audio unavailable — using our engine.', e);
    }
  }
  return player;
}

/** Is the (default-off) panel-orientation drill enabled in settings? */
function orientationEnabled(): boolean {
  const t = document.getElementById('orientation-toggle') as HTMLInputElement | null;
  return t ? t.checked : false;
}

/** Room-size A/B drills whose answer is best understood by revealing dimensions. */
const SIZE_TYPES: ReadonlySet<ExerciseType> = new Set(['larger', 'wider', 'longer']);

/** "7.2 × 4.0 × 6.1 m" for a roomSize triple. */
function fmtRoom(size: [number, number, number]): string {
  return `${size.map((m) => m.toFixed(1)).join(' × ')} m`;
}

/**
 * A post-answer reveal of the ground-truth geometry behind a drill, so the learner
 * can connect what they heard to the numbers:
 *  - room-size drills (larger/wider/longer) → both rooms' dimensions (W × H × D),
 *  - the distance drill → the true wall-ahead distance in each room.
 * Empty for drills with nothing numeric to reveal.
 */
function sizeReveal(q: Question): string {
  if (SIZE_TYPES.has(q.type) && q.sceneA?.roomSize && q.sceneB?.roomSize) {
    return ` Room A: ${fmtRoom(q.sceneA.roomSize)}. Room B: ${fmtRoom(q.sceneB.roomSize)}.`;
  }
  if (q.type === 'distance' && q.wallDistsM) {
    // Also speak the ECHO ARRIVAL TIME (round-trip Δt = 2·d/343), closing the
    // perceptual loop between the heard delay and the wall distance.
    const da = q.wallDistsM.a, db = q.wallDistsM.b;
    return ` Room A wall: ${da.toFixed(1)} m — its echo returned about ${echoDelayMs(da).toFixed(1)} ms after the clap.` +
      ` Room B wall: ${db.toFixed(1)} m — ${echoDelayMs(db).toFixed(1)} ms.`;
  }
  return '';
}

function typeFilter(): ExerciseType[] | undefined {
  const sel = $('type') as HTMLSelectElement;
  if (sel.value !== 'all') return [sel.value] as ExerciseType[];
  // Mixed mode: the orientation drill (subtle elevation cue) only joins the
  // rotation when explicitly enabled in settings; otherwise drop it from ALL_TYPES.
  return orientationEnabled() ? undefined : ALL_TYPES.filter((t) => t !== 'orientation');
}

function nextQuestion() {
  asked++;
  answered = false;
  loadedRoom = null;
  replayToken++; // cancel any in-flight freeze-frame replay (Next skips it)
  // Daily mode: every "Next" replays the SAME seeded challenge (replay-for-fun),
  // the streak only changing on the first completion (handled in onAnswer).
  if (dailyChallenge) {
    current = dailyChallenge.question;
    renderQuestion(current);
    return;
  }
  current = makeRandomQuestion(seedCounter++, {
    difficulty: difficulty(),
    types: typeFilter(),
    // Distance ladder feeds the near-panel distance for the `distance` drill in
    // adaptive mode; ignored by every other exercise.
    nearDistanceM: fixedDifficulty() === null ? distanceLadder.distance() : undefined,
  });
  renderQuestion(current);
}

/**
 * Begin the one-shot onboarding "blind reference" trial: a forced, very-easy
 * larger/smaller discrimination that proves the skill in minute one. Rendered like
 * a normal A/B question, but flagged so its answer reveals the skill and bypasses
 * the staircase (see onOnboardingAnswer).
 */
function startOnboarding() {
  asked++;
  answered = false;
  loadedRoom = null;
  replayToken++;
  onboardingActive = true;
  current = onboardingQuestion();
  renderQuestion(current);
  announce(
    'First, a quick demonstration. Two rooms — one clearly small, one clearly large. ' +
    'Play Room A and Room B, then choose which room is LARGER.',
  );
}

function renderQuestion(q: Question) {
  ($('prompt') as HTMLElement).textContent = q.prompt;
  // The single source of truth for "is there a Room B?" is the question's actual
  // sceneB — not a hardcoded type list — so a single-scene exercise can never show
  // a dead "Play Room B" button (the bug).
  const isAB = hasRoomB(q);

  // Play controls.
  ($('play-ab') as HTMLElement).hidden = !isAB;
  ($('play-single') as HTMLElement).hidden = isAB;
  // Belt-and-suspenders: disable Room B so even if the row were shown it can't be
  // triggered without a sceneB (keyboard handler also gates on this).
  ($('play-b') as HTMLButtonElement).disabled = !isAB;

  // Answer buttons.
  const answers = $('answers');
  answers.innerHTML = '';
  for (const choice of q.choices) {
    const btn = document.createElement('button');
    btn.className = 'answer';
    btn.textContent = choice;
    btn.setAttribute('aria-label', `Answer ${choice}`);
    btn.addEventListener('click', () => onAnswer(choice, btn));
    answers.appendChild(btn);
  }

  ($('feedback') as HTMLElement).textContent = '';
  ($('next') as HTMLButtonElement).disabled = true;
  answerCursor = -1; // no keyboard choice highlighted on a fresh question

  // Spoken, eyes-free controls hint tailored to this question's affordances.
  const controls = hasRoomB(q)
    ? 'Keys: A play Room A, D play Room B, Q and E to move between answers, Enter to confirm.'
    : 'Keys: A play the sound, Q and E to move between answers, Enter to confirm.';

  // A one-shot greeting (returning-user progress) rides along on the first question
  // so the live region speaks it without a competing announcement clobbering it.
  const lead = pendingGreeting ? `${pendingGreeting} ` : '';
  pendingGreeting = '';
  announce(`${lead}Question ${asked}. ${q.prompt} Play the sounds, then choose. ${controls}`);
}

async function playRoom(room: 'A' | 'B') {
  if (!current) return;
  const p = await ensurePlayer();
  const scene = room === 'A' ? current.sceneA : current.sceneB!;
  if (loadedRoom !== room) {
    p.load(scene);
    loadedRoom = room;
  }
  await applyProbe(p);
  p.clap();
  announce(`Playing Room ${room}.`);
}

async function playSingle() {
  if (!current) return;
  const p = await ensurePlayer();
  if (loadedRoom !== 'A') {
    p.load(current.sceneA);
    loadedRoom = 'A';
  }
  // Direction scenes use a continuous tone beacon (loaded on `load`); for any
  // clap-bearing scene also fire a clap.
  if (p.hasClap) {
    await applyProbe(p);
    p.clap();
  }
  announce('Playing the sound. Where is it coming from?');
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run the freeze-frame post-answer replay: play A, gap, B, each with a spoken +
 * on-screen label naming which room is which and which was correct. Skippable —
 * each await checks `replayToken`; pressing Next (or starting a new question) bumps
 * the token so a stale in-flight replay aborts immediately. Uses the SAME ScenePlayer
 * path as Room A / Room B so the comparison sounds identical to manual playback.
 */
async function runReplay(plan: ReplayPlan) {
  const token = ++replayToken;
  const p = await ensurePlayer();
  if (token !== replayToken || !current) return;
  announce(replayAnnouncement(plan));
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    if (token !== replayToken || !current) return;
    const scene = step.room === 'A' ? current.sceneA : current.sceneB!;
    p.load(scene);
    loadedRoom = step.room;
    await applyProbe(p);
    if (token !== replayToken) return;
    p.clap();
    ($('feedback') as HTMLElement).textContent = step.label;
    // Let the clap + its room tail ring, then the inter-scene gap before the next.
    await sleep(1100);
    if (i < plan.steps.length - 1) await sleep(plan.gapMs);
  }
}

function onAnswer(choice: string, btn: HTMLButtonElement) {
  if (!current || answered) return;
  answered = true;
  const correct = choice === current.correctAnswer;
  if (correct) score++;

  // Onboarding "blind reference" trial: prove the skill, then bow out of the
  // staircase/persistence machinery (it's a one-shot orientation, not a score).
  if (onboardingActive) {
    onOnboardingAnswer(correct, btn);
    return;
  }

  // Daily-challenge mode: record (idempotent) the streak and produce the share
  // string, then short-circuit the normal staircase/persistence path.
  if (dailyChallenge && dailyDate) {
    onDailyAnswer(correct, choice, btn);
    return;
  }

  // Drive the adaptive staircase only in adaptive mode (so fixed practice at a
  // level doesn't perturb the threshold tracker).
  const adaptive = fixedDifficulty() === null;
  const reversalsBefore = staircase.reversals;
  if (adaptive) staircase.record(correct);
  const reversal = adaptive && staircase.reversals > reversalsBefore;

  // Distance-ladder stepping (Thaler 90%-over-window → step back) for the distance
  // drill in adaptive mode; other types ignore the ladder distance entirely.
  let ladderNote = '';
  if (adaptive && current.type === 'distance') {
    ladderNote = ladderAnnouncement(distanceLadder.record(correct));
  }

  // Fold into the persisted session sample (adaptive only — fixed practice
  // shouldn't masquerade as a threshold measurement).
  if (adaptive) {
    sessionTrials++;
    if (correct) sessionCorrect++;
    sessionDirty = true;
    if (staircase.settled) flushSession(); // checkpoint once the estimate is stable
  }

  for (const el of Array.from($('answers').children) as HTMLButtonElement[]) {
    el.disabled = true;
    if (el.textContent === current.correctAnswer) el.classList.add('correct');
    else if (el === btn) el.classList.add('wrong');
  }

  const verdict = (correct
    ? 'Correct.'
    : `Incorrect. The answer was ${current.correctAnswer}.`) + sizeReveal(current);

  // Eyes-free progress cue: the level band, and at reversals / settled, a mastery
  // readout ("discriminating at ~70% of full difficulty").
  let progress = '';
  if (adaptive) {
    progress = ` Level ${difficultyBand(staircase.current())}.`;
    if (reversal || staircase.settled) {
      const pct = Math.round(staircase.threshold() * 100);
      progress += ` You're discriminating at about ${pct}% of full difficulty.`;
    }
  } else {
    progress = ` Fixed level ${difficultyBand(difficulty())}.`;
  }

  // Terse, polite extras for the live region: a reversal turn / streak count
  // (from the staircase) and any distance-ladder step-back, only in adaptive mode.
  let extra = '';
  if (adaptive) {
    const note = progressAnnouncement({
      correct,
      reversal,
      lastMove: staircase.lastMove,
      streak: staircase.streak,
    });
    if (note) extra += ` ${note}`;
    if (ladderNote) extra += ` ${ladderNote}`;
  }

  ($('feedback') as HTMLElement).textContent = verdict;
  ($('score') as HTMLElement).textContent = `Score ${score} / ${asked}`;
  ($('next') as HTMLButtonElement).disabled = false;
  announce(`${verdict} Score ${score} of ${asked}.${extra}${progress} Press Next to continue.`);
  ($('next') as HTMLButtonElement).focus();

  // Freeze-frame replay of the correct comparison (A→gap→B with labels) so a wrong
  // answer teaches and a right one reinforces. Only for A/B drills; single-scene
  // exercises return a null plan and keep their current behaviour. Skippable: Next
  // bumps replayToken and the in-flight steps abort.
  maybeReplay(correct);
}

/** Kick off the freeze-frame replay for the current A/B question (no-op otherwise). */
function maybeReplay(correct: boolean) {
  if (!current) return;
  const plan = planReplay(current, correct);
  if (plan) void runReplay(plan);
}

/**
 * Onboarding answer: reveal that the player just echolocated, persist the seen-flag
 * so it never repeats, run the same labelled replay, and roll the trainer into
 * normal practice (the next "Next" generates a real adaptive question).
 */
function onOnboardingAnswer(correct: boolean, btn: HTMLButtonElement) {
  const q = current!;
  for (const el of Array.from($('answers').children) as HTMLButtonElement[]) {
    el.disabled = true;
    if (el.textContent === q.correctAnswer) el.classList.add('correct');
    else if (el === btn) el.classList.add('wrong');
  }
  const verdict = correct ? 'Correct.' : `Not quite — the answer was ${q.correctAnswer}.`;
  const reveal = ` ${ONBOARDING_REVEAL}`;
  trainerStore.markOnboardingSeen();
  onboardingActive = false;
  onboardingDone = true;
  ($('feedback') as HTMLElement).textContent = verdict + reveal;
  ($('next') as HTMLButtonElement).disabled = false;
  announce(`${verdict}${reveal} Press Next to start practising.`);
  ($('next') as HTMLButtonElement).focus();
  maybeReplay(correct);
}

/**
 * Daily-mode answer handling: mark the chosen/correct buttons, record the streak
 * (idempotent for the day), speak the result + new streak, and surface a shareable
 * score string. Replaying after completion is fine — the streak won't double-count.
 */
function onDailyAnswer(correct: boolean, _choice: string, btn: HTMLButtonElement) {
  const challenge = dailyChallenge!;
  const date = dailyDate!;
  const alreadyDoneToday = dailyStore.isCompletedOn(date);
  const { state, transition } = dailyStore.complete(date);

  for (const el of Array.from($('answers').children) as HTMLButtonElement[]) {
    el.disabled = true;
    if (el.textContent === challenge.question.correctAnswer) el.classList.add('correct');
    else if (el === btn) el.classList.add('wrong');
  }

  const verdict = (correct
    ? 'Correct.'
    : `Incorrect. The answer was ${challenge.question.correctAnswer}.`) + sizeReveal(challenge.question);
  const result = dailyResultAnnouncement({ correct, transition, alreadyDoneToday });

  // A direction/orientation challenge can fold its precise cue (e.g. the bearing)
  // into the share string for a richer brag; A/B drills just share the verdict.
  let detail = '';
  if (challenge.type === 'direction' && challenge.question.bearingDeg != null) {
    detail = `${Math.abs(Math.round(challenge.question.bearingDeg))}°`;
  }
  const share = shareScoreString({
    date,
    challenge,
    correct,
    currentStreak: state.currentStreak,
    detail,
  });

  ($('feedback') as HTMLElement).textContent = verdict;
  ($('score') as HTMLElement).textContent = `Daily — ${state.currentStreak}-day streak`;
  ($('next') as HTMLButtonElement).disabled = false;

  // Reveal the share field (back on the daily panel) populated with the score.
  const shareWrap = document.getElementById('daily-share') as HTMLElement | null;
  const shareText = document.getElementById('daily-share-text') as HTMLInputElement | null;
  if (shareWrap && shareText) {
    shareWrap.hidden = false;
    shareText.value = share;
  }
  refreshDailyStatus();
  announce(`${verdict} ${result} Your score: ${share}. Press Next to replay.`);
  ($('next') as HTMLButtonElement).focus();
  maybeReplay(correct);
}

/** Populate the probe picker and wire the custom URL/file inputs. */
function setupProbePicker() {
  const sel = $('probe') as HTMLSelectElement;
  const hint = $('probe-hint') as HTMLElement;
  for (const preset of PROBE_PRESETS) {
    const opt = document.createElement('option');
    opt.value = preset.name;
    opt.textContent = preset.label;
    sel.appendChild(opt);
  }
  const custom = document.createElement('option');
  custom.value = 'custom';
  custom.textContent = 'Custom recording…';
  sel.appendChild(custom);

  const updateHint = () => {
    const preset = PROBE_PRESETS.find((p) => p.name === sel.value);
    hint.textContent = preset ? preset.hint : 'play your own recording as the echo probe';
  };
  sel.addEventListener('change', updateHint);
  updateHint();

  // Decode a picked File once (via the AudioContext) and cache it as the buffer.
  ($('probe-file') as HTMLInputElement).addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) { pickedProbeBuffer = null; return; }
    try {
      const p = await ensurePlayer();
      pickedProbeBuffer = await p.decodeFile(file);
      sel.value = 'custom';
      updateHint();
    } catch {
      pickedProbeBuffer = null; // bad file → selectedProbe() falls back to clap
    }
  });
}

/** Actions the trainer keyboard scheme can produce. */
export type TrainerKeyAction = 'playA' | 'playB' | 'prev' | 'next' | 'confirm' | null;

/**
 * PURE key → action mapping for the trainer (mirrors the game's eyes-free scheme):
 *   A = play Room A,  D = play Room B (only when a Room B exists),
 *   Q = previous answer,  E = next answer,  Enter/Space = confirm selection.
 * Returns null for any other key, or for D when `hasB` is false (so a single-scene
 * exercise never produces a "play Room B" that does nothing). Case-insensitive.
 */
export function trainerKeyAction(key: string, hasB: boolean): TrainerKeyAction {
  switch (key.toLowerCase()) {
    case 'a': return 'playA';
    case 'd': return hasB ? 'playB' : null;
    case 'q': return 'prev';
    case 'e': return 'next';
    case 'enter':
    case ' ':
    case 'spacebar': return 'confirm';
    default: return null;
  }
}

/** True when focus is in a text input/select so global keys must NOT hijack typing. */
function isTypingTarget(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null;
  if (!node) return false;
  const tag = node.tagName;
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || (node as HTMLElement).isContentEditable;
}

/** Highlight (and announce) the answer button at `answerCursor`. */
function highlightAnswer() {
  const btns = Array.from($('answers').children) as HTMLButtonElement[];
  btns.forEach((b, i) => b.classList.toggle('focused', i === answerCursor));
  const btn = btns[answerCursor];
  if (btn) {
    btn.focus();
    announce(`Answer: ${btn.textContent}. Press Enter to confirm.`);
  }
}

/** Move the answer cursor by `delta` (Q/E), wrapping, and highlight the result. */
function moveAnswer(delta: number) {
  const n = ($('answers').children.length);
  if (n === 0 || answered) return;
  answerCursor = answerCursor < 0
    ? (delta > 0 ? 0 : n - 1)
    : (answerCursor + delta + n) % n;
  highlightAnswer();
}

/** Confirm the highlighted answer (Enter/Space) by invoking its click handler. */
function confirmAnswer() {
  if (answered) return;
  const btns = Array.from($('answers').children) as HTMLButtonElement[];
  const btn = btns[answerCursor];
  if (btn && !btn.disabled) btn.click();
}

/**
 * Global keyboard handler for the trainer. Only active once the drill is visible;
 * ignored while typing in the probe URL / file picker / selects so it never eats
 * keystrokes. Additive to the on-screen buttons.
 */
function onKeyDown(e: KeyboardEvent) {
  if (($('drill') as HTMLElement).hidden) return; // drill not started yet
  if (isTypingTarget(e.target)) return; // don't hijack typing in inputs
  if (e.metaKey || e.ctrlKey || e.altKey) return; // leave shortcuts alone
  const action = trainerKeyAction(e.key, current ? hasRoomB(current) : false);
  if (!action) return;
  e.preventDefault();
  switch (action) {
    case 'playA': { void (current && hasRoomB(current) ? playRoom('A') : playSingle()); break; }
    case 'playB': void playRoom('B'); break;
    case 'prev': moveAnswer(-1); break;
    case 'next': moveAnswer(+1); break;
    case 'confirm':
      // After answering, Enter advances (matches the focused Next button); before
      // answering it confirms the highlighted choice.
      if (answered) { if (!($('next') as HTMLButtonElement).disabled) nextQuestion(); }
      else confirmAnswer();
      break;
  }
}

function main() {
  setupProbePicker();
  renderDashboard(); // show the progress curves up front for returning users
  window.addEventListener('keydown', onKeyDown);
  // Pre-check the high-fidelity toggle when ?engine=steam is in the URL.
  const engineToggle = document.getElementById('engine-steam-toggle') as HTMLInputElement | null;
  if (engineToggle) engineToggle.checked = selectBackendFromSearch(location.search) === 'steam';
  // Flush the in-progress session sample when the user navigates away/reloads, so
  // a returning user's "last session" reflects the work they actually did.
  window.addEventListener('beforeunload', flushSession);
  window.addEventListener('pagehide', flushSession);

  $('begin').addEventListener('click', async () => {
    ($('begin') as HTMLButtonElement).disabled = true;
    announce('Loading audio…');
    await ensurePlayer();
    ($('begin') as HTMLElement).hidden = true;
    ($('drill') as HTMLElement).hidden = false;

    // Greet returning users with their stored progress for this exercise type.
    const typeSel = $('type') as HTMLSelectElement;
    sessionType = typeSel.value;
    const label = typeSel.options[typeSel.selectedIndex].text;
    pendingGreeting = summarizeProgress(label, trainerStore.get(sessionType));

    // First-ever launch: run the forced "blind reference" trial to prove the skill,
    // then fall through to normal practice. Gated by a persisted flag (never repeats)
    // and skipped in daily mode (this is the normal-Begin path).
    if (!onboardingDone && shouldRunOnboarding({ hasSeen: trainerStore.hasSeenOnboarding(), daily: false })) {
      startOnboarding();
    } else {
      nextQuestion();
    }
  });

  // Daily challenge: show today's status, and start the seeded daily drill.
  refreshDailyStatus();
  $('daily-begin').addEventListener('click', async () => {
    ($('daily-begin') as HTMLButtonElement).disabled = true;
    announce('Loading audio…');
    await ensurePlayer();
    dailyDate = todayStr();
    dailyChallenge = challengeForDate(dailyDate);
    const st = dailyStore.load();
    const done = dailyStore.isCompletedOn(dailyDate);
    // Hide the normal Begin panel; reveal the drill UI.
    ($('begin-panel') as HTMLElement).hidden = true;
    ($('daily-panel') as HTMLElement).hidden = true;
    ($('begin') as HTMLElement).hidden = true;
    ($('drill') as HTMLElement).hidden = false;
    pendingGreeting = dailyOpenAnnouncement({
      challenge: dailyChallenge,
      currentStreak: st.currentStreak,
      doneToday: done,
    });
    nextQuestion();
  });

  // Copy the shareable score (guarded — clipboard may be unavailable/denied).
  const copyBtn = document.getElementById('daily-copy');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const text = (document.getElementById('daily-share-text') as HTMLInputElement | null)?.value ?? '';
      if (!text) return;
      try {
        await navigator.clipboard?.writeText(text);
        announce('Score copied to clipboard.');
      } catch {
        announce('Copy unavailable — select the score text to copy it manually.');
      }
    });
  }

  $('play-a').addEventListener('click', () => playRoom('A'));
  $('play-b').addEventListener('click', () => playRoom('B'));
  $('play-s').addEventListener('click', () => playSingle());
  $('next').addEventListener('click', () => nextQuestion());

  // The orientation drill is gated behind its settings toggle: only reveal it as a
  // pickable exercise-type option while enabled. Disabling it while it's the chosen
  // type falls the picker back to Mixed so we never queue a hidden exercise.
  const orientToggle = $('orientation-toggle') as HTMLInputElement;
  const syncOrientation = () => {
    const opt = document.getElementById('type-orientation') as HTMLOptionElement | null;
    if (opt) opt.hidden = !orientToggle.checked;
    const typeSel = $('type') as HTMLSelectElement;
    if (!orientToggle.checked && typeSel.value === 'orientation') typeSel.value = 'all';
  };
  orientToggle.addEventListener('change', syncOrientation);
  syncOrientation();
}

// Auto-start only in a real browser. Guarded so the module can be imported by unit
// tests (node, no DOM) to exercise the pure helpers without booting the UI.
if (typeof document !== 'undefined') main();
