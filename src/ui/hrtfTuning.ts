/**
 * Movement-based perceptual HRTF tuning game (the "does this feel more like up?"
 * flow). OPTIONAL, launched from calibration or Settings.
 *
 * For each exercise (hrtfExercises.ts) it auditions two candidate personalizations
 * — A and B — by rendering the SAME moving pink-noise probe through TWO warped
 * interpolating renderers and crossfading between them, so switching A→B is
 * SEAMLESS (no silence, beating the ~3-5 min brain-adaptation window). A coarse→
 * fine Staircase per parameter turns the listener's answers into the final warp,
 * which is saved to settings and applied to the real beacon on the next build.
 *
 * Answer paradigms:
 *   • 'ab'    — plays A (first pass) then B (second pass); "which felt better?".
 *   • 'guess' — plays ONE candidate; "where did it end up?" A correct localization
 *               keeps/advances that candidate, a wrong one rejects it. Objective.
 *
 * The audio graph + DOM here are ear-verified; the pure decision logic lives in
 * hrtfStaircase.ts / hrtfExercises.ts (unit-tested).
 */
import { HrtfRenderer } from '../engine/hrtf/renderer';
import { InterpolatingHrtfRenderer } from '../engine/hrtf/interpolatingRenderer';
import { assetUrl } from '../engine/baseUrl';
import { NEUTRAL_PERSONALIZATION, type HrtfPersonalization } from '../engine/hrtf/personalize';
import { PC_KIND_FRONTBACK } from '../engine/hrtf/hrtfPca';
import { calDebugEnabled } from './calDebug';
import { Staircase, type StaircaseTrial } from './hrtfStaircase';
import { EXERCISES, STAIRCASE_CONFIG, PARAM_SAMPLE_KIND, type Exercise, type ExerciseParam } from './hrtfExercises';
import { mountVisualizer } from './hrtfVisualizer';
import { mountDirectionPicker, mountAnswerDiagram, type DirectionPicker } from './hrtfDirectionPicker';
import {
  makeTargetedDirection,
  dirToPosition,
  dirToVec,
  angularError,
  decomposeError,
  makeBasin,
  basinRecord,
  basinNext,
  basinMean,
  basinBucketValue,
  basinRemainingFraction,
  makePassOrder,
  rrNext,
  type BasinState,
  type BasinConfig,
  type Direction,
} from './hrtfLocalize';

/**
 * The measured base head-responses the user can choose to personalize on top of.
 * Each is a different real person's ears; which one fits YOU best is itself part of
 * the calibration (the "pick the closest head" idea). SADIE H3 is our default; CIPIC
 * 124 is the subject Steam Audio ships (baked into our own format). id is stored in
 * settings so the game/beacon later loads the same base.
 */
export interface BaseHrtf { id: string; label: string; url: string; }
// The measured base heads the calibration can pick between. SADIE H3 (default) + Steam's
// CIPIC 124, PLUS six maximally-DIVERSE real humans drawn from SADIE II (H4–H20) and SS2
// (Meta Reality Labs Sound Sphere 2, 78 subjects), chosen by farthest-point / max-min
// selection in HRTF log-magnitude space (scripts/select-diverse-heads-ss2.mjs) so they
// span how real ears differ — the base head is the biggest localization variable, so
// offering genuinely different ears gives the base-A/B tournament real range to find your
// fit. (~8 candidates is the established sweet spot for perceptual HRTF selection.)
// All native 48 kHz; SS2 windowed 384→256 taps. All scalar-level-matched to SADIE H3
// (scripts/normalize-base-heads.mjs) so switching heads changes spatial cues, not volume.
export const BASE_HRTFS: readonly BaseHrtf[] = [
  { id: 'sadie_h3', label: 'Default (SADIE H3)', url: assetUrl('assets/hrtf/sadie_h3.hrtf') },
  { id: 'cipic_124', label: 'Steam’s (CIPIC 124)', url: assetUrl('assets/hrtf/cipic_124.hrtf') },
  { id: 'sadie_h13', label: 'Head A (SADIE H13)', url: assetUrl('assets/hrtf/sadie_h13.hrtf') },
  { id: 'ss2_ztv', label: 'Head B (SS2 ZTV)', url: assetUrl('assets/hrtf/ss2_ztv.hrtf') },
  { id: 'ss2_gzu', label: 'Head C (SS2 GZU)', url: assetUrl('assets/hrtf/ss2_gzu.hrtf') },
  { id: 'ss2_ynb', label: 'Head D (SS2 YNB)', url: assetUrl('assets/hrtf/ss2_ynb.hrtf') },
  { id: 'ss2_fzk', label: 'Head E (SS2 FZK)', url: assetUrl('assets/hrtf/ss2_fzk.hrtf') },
  { id: 'ss2_rll', label: 'Head F (SS2 RLL)', url: assetUrl('assets/hrtf/ss2_rll.hrtf') },
];
export function baseHrtfById(id: string | undefined): BaseHrtf {
  return BASE_HRTFS.find((b) => b.id === id) ?? BASE_HRTFS[0];
}

export interface HrtfTuningDeps {
  ctx: AudioContext;
  /** Where the tuned probe should play out (usually the master bus). */
  dest: AudioNode;
  /** URL of the BASE measured set to personalize (fallback when no base id chosen). */
  hrtfUrl: string;
  say: (msg: string) => void;
  alert: (msg: string) => void;
  /** Persist the finished personalization. */
  save: (p: HrtfPersonalization) => void;
  /** Existing personalization to start from (so re-running refines, not resets). */
  start?: HrtfPersonalization;
  /** Currently-selected base HRTF id (which measured head to tune on). */
  baseHrtfId?: string;
  /** Persist the chosen base HRTF id when the user switches heads. */
  saveBaseHrtf?: (id: string) => void;
  onDone: () => void;
  /**
   * Which tuning tool to open on mount. Omitted (or 'intro') shows the chooser menu.
   * Lets a URL route deep-link straight into one tool (e.g. /calibrate/tune/localize).
   */
  initial?: 'intro' | 'localize' | 'knobs' | 'guided' | 'pca';
  /**
   * When present, tool selection + Back go through the ROUTER instead of swapping the
   * DOM directly — so each tool has its own URL and the browser Back button works.
   * 'tune' means "back to the chooser". Absent ⇒ standalone use (Settings): fall back to
   * the internal showIntro()/render*() transitions.
   */
  navigate?: (step: 'tune' | 'localize' | 'knobs' | 'guided' | 'pca') => void;
}

/** Build a candidate set of personalization params: base overlaid with one override.
 *  Tuning the notch FREQUENCY is silent unless the notch has some DEPTH, so we force
 *  a sensible depth whenever that's the parameter under test. */
function withParam(
  base: HrtfPersonalization,
  param: ExerciseParam,
  value: number,
): HrtfPersonalization {
  const next = { ...base, [param]: value };
  if (param === 'notchHz' && next.notchDepth === 0) next.notchDepth = 16;
  return next;
}

/** Candidate with one PCA weight (index `k`) set to `value`, others kept. */
function withPcaWeight(base: HrtfPersonalization, k: number, value: number, kCount: number): HrtfPersonalization {
  const w = (base.pcaWeights ?? new Array(kCount).fill(0)).slice();
  while (w.length < kCount) w.push(0);
  w[k] = value;
  return { ...base, pcaWeights: w };
}

/** Base overlaid with one BIAS override (frontBack / upDown), for probing a bias candidate. */
function withBias(base: HrtfPersonalization, which: 'frontBack' | 'upDown', value: number): HrtfPersonalization {
  return which === 'frontBack' ? { ...base, frontBackBias: value } : { ...base, upDownBias: value };
}

export function mountHrtfTuning(root: HTMLElement, deps: HrtfTuningDeps): () => void {
  const { ctx, dest } = deps;
  // Which measured base head we're tuning on. Switchable in the UI; the chosen URL
  // feeds every renderer build. Falls back to deps.hrtfUrl if the id is unknown.
  let currentBase: BaseHrtf = deps.baseHrtfId
    ? baseHrtfById(deps.baseHrtfId)
    : { id: 'custom', label: 'Default', url: deps.hrtfUrl };
  const baseUrl = () => currentBase.url;
  // Running best estimate; each exercise's staircase writes back its parameter.
  const params: HrtfPersonalization = { ...(deps.start ?? NEUTRAL_PERSONALIZATION) };

  root.innerHTML = '';
  const h = document.createElement('h1');
  h.textContent = 'Personalize your 3D audio';
  const p = document.createElement('p');
  p.id = 'hrtf-tuning-instruction';
  const controls = document.createElement('div');
  controls.className = 'cal-controls';
  root.append(h, p, controls);

  // Comfortable playback levels for the calibration tools — never full volume, per user
  // pref. PROBE_LEVEL is the guided A/B probe (was full-scale 1.0); LOCALIZE_LEVEL is the
  // "point to the sound" / "refine to real ears" probe (already half volume).
  const PROBE_LEVEL = 0.55;
  const LOCALIZE_LEVEL = 0.5;

  // ---- audio: one shared moving pink-noise probe, split into two warped renderers.
  const noise = makePinkNoise(ctx); // looping BufferSource
  let noiseStarted = false;
  const startNoise = () => { if (!noiseStarted) { noise.start(); noiseStarted = true; } };
  let rendererA: InterpolatingHrtfRenderer | null = null;
  let rendererB: InterpolatingHrtfRenderer | null = null;
  let srcA: ReturnType<InterpolatingHrtfRenderer['createSource']> | null = null;
  let srcB: ReturnType<InterpolatingHrtfRenderer['createSource']> | null = null;
  let gainA: GainNode | null = null;
  let gainB: GainNode | null = null;
  /** Master gate: 0 = silent between passes, 1 = a pass is sounding. This is what
   *  makes each audition a DISCRETE, clearly-bounded sweep instead of an endless loop. */
  let gate: GainNode | null = null;
  let rafHandle = 0;
  let seqTimers: ReturnType<typeof setTimeout>[] = [];
  let disposed = false;

  // Sequence state.
  let exIdx = 0;
  /** Per-trial: play the sweep time-REVERSED (front→back becomes back→front, etc.) so the
   *  same exercise doesn't always present the identical motion. Toggled each trial. */
  let sweepReversed = false;
  const staircases = new Map<ExerciseParam, Staircase>();
  let curTrial: StaircaseTrial | null = null;
  /** For 'ab', we play A then B and remember which the user is auditioning. */

  function staircaseFor(ex: Exercise): Staircase {
    let sc = staircases.get(ex.param);
    if (!sc) {
      const cfg = STAIRCASE_CONFIG[ex.param];
      // Seed the staircase at the running best for this param.
      sc = new Staircase({ ...cfg, start: params[ex.param] });
      staircases.set(ex.param, sc);
    }
    return sc;
  }

  function bigButton(label: string, onClick: () => void, primary = false): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = label;
    b.className = primary ? 'primary' : 'secondary';
    b.addEventListener('click', onClick);
    return b;
  }

  /** The base URL the current A/B graph was built for, so a base-head switch rebuilds. */
  let abBuiltForUrl: string | null = null;

  async function ensureRenderers(a: HrtfPersonalization, b: HrtfPersonalization) {
    // Build the two renderers + graph ONCE, then across trials just HOT-SWAP each
    // candidate's warp via setPersonalization (re-warps the HRIR table and posts it to
    // the EXISTING worklet — no new AudioWorkletNode). Previously this tore down and
    // rebuilt two multi-MB worklets EVERY trial; disconnected worklet processors linger
    // on the audio thread faster than they're GC'd, so after a handful of trials the
    // audio thread starved and the tuner went silent. Reuse fixes that (same leak-free
    // pattern the free-play knobs use). We keep TWO renderers because the 'ab' exercises
    // genuinely play both A and B; 'guess' only plays B but reuse makes the second one
    // free to keep around.
    if (srcA && srcB && abBuiltForUrl === baseUrl()) {
      rendererA!.setPersonalization(a);
      rendererB!.setPersonalization(b);
      return;
    }
    teardownAudio();
    const set = (await HrtfRenderer.create(ctx, baseUrl())).set;
    rendererA = await InterpolatingHrtfRenderer.fromSetAsync(ctx, set, { personalize: a });
    rendererB = await InterpolatingHrtfRenderer.fromSetAsync(ctx, set, { personalize: b });
    for (const r of [rendererA, rendererB]) r.setListener({ x: 0, y: 1.6, z: 0, yaw: 0 });
    srcA = rendererA.createSource();
    srcB = rendererB.createSource();
    gainA = ctx.createGain();
    gainB = ctx.createGain();
    gate = ctx.createGain();
    gainA.gain.value = 1;
    gainB.gain.value = 0;
    gate.gain.value = 0; // silent until a pass plays
    noise.connect(srcA.input);
    noise.connect(srcB.input);
    srcA.output.connect(gainA);
    srcB.output.connect(gainB);
    gainA.connect(gate);
    gainB.connect(gate);
    gate.connect(dest);
    abBuiltForUrl = baseUrl();
  }

  /** Select which warp (A or B) the next sweep uses; instant while gated silent. */
  function selectCandidate(which: 'a' | 'b') {
    if (!gainA || !gainB) return;
    gainA.gain.value = which === 'a' ? 1 : 0;
    gainB.gain.value = which === 'b' ? 1 : 0;
  }

  /** Open/close the audible gate with a short ramp so passes fade in/out cleanly.
   *  Open level is PROBE_LEVEL (~55%), never full — per the comfortable-volume pref. */
  function setGate(on: boolean) {
    if (!gate) return;
    const t = ctx.currentTime;
    gate.gain.setTargetAtTime(on ? PROBE_LEVEL : 0, t, 0.02);
  }

  function clearTimers() {
    cancelAnimationFrame(rafHandle);
    for (const id of seqTimers) clearTimeout(id);
    seqTimers = [];
  }

  /**
   * Play ONE discrete sweep of candidate `which` along the trajectory, opening the
   * gate for its duration then closing it. Resolves when the sweep (plus fade-out)
   * has finished, so the caller can sequence "version one … version two … choose".
   */
  function playSweep(ex: Exercise, which: 'a' | 'b'): Promise<void> {
    selectCandidate(which);
    setGate(true);
    cancelAnimationFrame(rafHandle);
    const durMs = ex.durationSec * 1000;
    const startPerf = performanceNow();
    return new Promise((resolve) => {
      let settled = false;
      const finishSweep = () => {
        if (settled) return;
        settled = true;
        cancelAnimationFrame(rafHandle);
        setGate(false);
        const id = setTimeout(resolve, 120); // let the fade-out finish
        seqTimers.push(id);
      };
      // GUARANTEED completion off a wall-clock timer: requestAnimationFrame is throttled
      // to ~0 fps (or paused entirely) when the tab is hidden, on reduced-motion, and on
      // some mobile browsers. If the sweep's end depended on rAF alone, a paused rAF would
      // deadlock the whole "version 1 … version 2 … choose" sequence at the first pass —
      // exactly the "stuck at one beep" hang. So the timer owns resolution; rAF only
      // animates the source position and never gates progress.
      const endId = setTimeout(finishSweep, durMs);
      seqTimers.push(endId);
      const step = () => {
        if (disposed) { settled = true; cancelAnimationFrame(rafHandle); return resolve(); }
        if (settled) return;
        const elapsed = performanceNow() - startPerf;
        const raw = Math.min(1, elapsed / durMs); // ONE pass, no loop
        const t = sweepReversed ? 1 - raw : raw; // vary the motion direction per trial
        const [x, y, z] = ex.trajectory(t);
        srcA?.setPosition(x, y, z);
        srcB?.setPosition(x, y, z);
        if (raw >= 1) return finishSweep();
        rafHandle = requestAnimationFrame(step);
      };
      rafHandle = requestAnimationFrame(step);
    });
  }

  /** Wait `ms`, unless disposed. Used for the gap between the two versions. */
  function wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const id = setTimeout(resolve, ms);
      seqTimers.push(id);
    });
  }

  /** Start (or restart) the guided test: fresh staircases, round-robin from exercise 0. */
  function startGuided() {
    exIdx = -1;            // renderExercise looks AFTER exIdx → first trial = exercise 0
    staircases.clear();
    void renderExercise();
  }

  async function renderExercise() {
    // ROUND-ROBIN across exercises so the QUESTION visibly changes each trial instead of
    // hammering one exercise until its staircase converges (which read as "the same
    // question forever"). Find the next not-yet-converged exercise starting AFTER the
    // current one; wrap around. Finish only when every staircase is done.
    const total = EXERCISES.length;
    let next = -1;
    let nextTrial: StaircaseTrial | null = null;
    for (let step = 1; step <= total; step++) {
      const i = (exIdx + step) % total;
      const cand = EXERCISES[i];
      const csc = staircaseFor(cand);
      if (csc.done) { params[cand.param] = csc.current; continue; }
      const t = csc.nextTrial();
      // A rail-pinned staircase returns a===b (a degenerate, unanswerable trial that
      // would replay the SAME sound forever). Treat it as converged + skip.
      if (t.a === t.b) { params[cand.param] = csc.current; continue; }
      next = i; nextTrial = t; break;
    }
    if (next < 0 || !nextTrial) return finish(); // all converged / exhausted
    exIdx = next;
    const ex = EXERCISES[exIdx];
    const sc = staircaseFor(ex);

    curTrial = nextTrial;
    // Vary the motion each trial (front→back one time, back→front the next, …) so the
    // same exercise doesn't feel like the identical question repeated. Only for A/B
    // (preference) exercises — a 'guess' prompt is direction-specific ("did it end up in
    // front?") so reversing it would make the correct answer wrong.
    sweepReversed = ex.kind === 'ab' ? !sweepReversed : false;
    const a = withParam(params, ex.param, curTrial.a);
    const b = withParam(params, ex.param, curTrial.b);

    controls.innerHTML = '';
    p.textContent = 'Preparing…';
    await ensureRenderers(a, b);
    if (disposed) return;

    if (ex.kind === 'ab') {
      await playAbSequence(ex, sc);
    } else {
      await playGuessSequence(ex, sc);
    }
  }

  /**
   * A/B: play TWO clearly-labeled passes — "Version one" (sweep A), a short gap,
   * "Version two" (sweep B) — then ask which was better. The spoken label + the
   * silence between passes makes it unmistakable which version is which (the old
   * looping crossfade did not). Controls are disabled until both passes finish.
   */
  async function playAbSequence(ex: Exercise, sc: Staircase) {
    clearTimers();
    controls.innerHTML = '';

    // "beep" → version 1 sweep …short gap… "beep beep" → version 2 sweep.
    p.textContent = 'VERSION 1  (one beep)';
    await playBeeps(ctx, dest, 1);
    if (disposed) return;
    await playSweep(ex, 'a');
    if (disposed) return;

    // Gap between the two versions kept SHORT (< 1.5 s incl. the two beeps) so the
    // ear can hold version 1 while version 2 plays — longer and the comparison rots.
    p.textContent = 'VERSION 2  (two beeps)';
    await wait(350);
    await playBeeps(ctx, dest, 2); // ~0.35 s of beeps
    if (disposed) return;
    await playSweep(ex, 'b');
    if (disposed) return;

    // Choice worded by VERSION NUMBER + beep count, never abstract A/B.
    p.textContent = `${ex.prompt}  —  Which was better: version 1 (one beep) or version 2 (two beeps)?`;
    deps.say('Which was better — version one, one beep, or version two, two beeps?');
    const first = bigButton(`Version 1 — one beep  (${ex.choices[0]})`, () => answer(ex, sc, 'a'), true);
    const second = bigButton(`Version 2 — two beeps  (${ex.choices[1]})`, () => answer(ex, sc, 'b'));
    const neither = bigButton('Both felt wrong / can’t tell', () => rejectBoth(ex, sc));
    const replay = bigButton('▶ Play both again', () => playAbSequence(ex, sc));
    controls.append(first, second, neither, replay);
    first.focus();
  }

  /**
   * 'guess': play ONE sweep of the candidate under test, then ask where it ended up.
   * A correct localization accepts it, a wrong one rejects it.
   */
  async function playGuessSequence(ex: Exercise, sc: Staircase) {
    clearTimers();
    controls.innerHTML = '';
    p.textContent = 'Listen…';
    await playBeeps(ctx, dest, 1);
    if (disposed) return;
    await playSweep(ex, 'b');
    if (disposed) return;

    p.textContent = ex.prompt;
    deps.say(ex.prompt);
    // choices[0] is the CORRECT localization for the motion.
    const correct = bigButton(ex.choices[0], () => answer(ex, sc, 'b'), true);
    const wrong = bigButton(ex.choices[1], () => answer(ex, sc, 'a'));
    const neither = bigButton('Couldn’t tell either way', () => rejectBoth(ex, sc));
    const replay = bigButton('▶ Play it again', () => playGuessSequence(ex, sc));
    controls.append(correct, wrong, neither, replay);
    correct.focus();
  }

  function answer(ex: Exercise, sc: Staircase, chose: 'a' | 'b') {
    if (curTrial) sc.answer(chose, curTrial);
    // Keep the running best in sync so later exercises seed from it.
    params[ex.param] = sc.current;
    renderExercise();
  }

  /** "Both bad / can't tell" — jump the search elsewhere rather than forcing a pick. */
  function rejectBoth(ex: Exercise, sc: Staircase) {
    sc.bothBad();
    params[ex.param] = sc.current;
    renderExercise();
  }

  function finish() {
    // Commit every converged staircase, then persist + apply.
    for (const [param, sc] of staircases) {
      params[param] = sc.current;
    }
    teardownAudio();
    deps.save(params);
    deps.say('Personalization saved. Your 3D audio is now tuned to you.');
    deps.alert('Personalization complete.');
    deps.onDone();
  }

  function skip() {
    teardownAudio();
    deps.say('Personalization skipped.');
    deps.onDone();
  }

  function teardownAudio() {
    clearTimers();
    // Disconnect the INCOMING noise→source edges too: source.disconnect() only drops
    // the source's outgoing edges, so without this the old worklets stay fed by noise
    // and pile up trial after trial (audio-thread overload → drop-outs).
    if (srcA) { try { noise.disconnect(srcA.input); } catch { /* not connected */ } }
    if (srcB) { try { noise.disconnect(srcB.input); } catch { /* not connected */ } }
    try { srcA?.disconnect(); } catch { /* noop */ }
    try { srcB?.disconnect(); } catch { /* noop */ }
    try { gainA?.disconnect(); } catch { /* noop */ }
    try { gainB?.disconnect(); } catch { /* noop */ }
    try { gate?.disconnect(); } catch { /* noop */ }
    srcA = srcB = null;
    gainA = gainB = null;
    gate = null;
    rendererA = rendererB = null;
    abBuiltForUrl = null;
  }

  function dispose() {
    disposed = true;
    teardownAudio();
    try { noise.stop(); } catch { /* already stopped */ }
  }

  // ------------------------------------------------------------------------
  // FREE-PLAY "knobs" mode. The guided game only works once a sound already
  // reads as being in FRONT — if the generic HRTF fails front/back for you,
  // every A/B just "feels behind" and is unanswerable. So this mode lets you
  // move sliders while a probe alternates FRONT ↔ BACK, until front actually
  // snaps forward. Then you can save, or hand off to the guided game to refine.
  // ------------------------------------------------------------------------
  // ONE renderer + ONE source, built once. The knobs call renderer.setPersonalization,
  // which re-warps the HRIR table and posts it to the existing worklet — NO new nodes,
  // so nothing accumulates on the audio thread no matter how much you drag.
  let fpRenderer: InterpolatingHrtfRenderer | null = null;
  let fpSrc: ReturnType<InterpolatingHrtfRenderer['createSource']> | null = null;
  let fpGain: GainNode | null = null;
  let fpRaf = 0;
  let fpBuilt = false;
  let fpBuilding = false;
  /** Sighted "where is the sound" diagram, updated each frame from the loop. */
  let fpViz: ReturnType<typeof mountVisualizer> | null = null;
  /** Whether the free-play panel is showing the 5 real-ear (PCA) sliders. */
  let fpShowPca = false;
  let fpPcaK = 0;
  /** Per-PC human-readable names for the manual knobs (from the model; generic fallback). */
  let fpPcaNames: string[] = [];
  const fpParams: HrtfPersonalization = { ...params };

  function teardownFreePlay() {
    disposeFpGraph();
    fpViz?.dispose();
    fpViz = null;
  }

  /** Fully release just the free-play graph (keeps params). Used on base switch. */
  function disposeFpGraph() {
    cancelAnimationFrame(fpRaf);
    fpRaf = 0;
    if (fpSrc) {
      try { noise.disconnect(fpSrc.input); } catch { /* not connected */ }
      try { fpSrc.disconnect(); } catch { /* noop */ }
    }
    try { fpGain?.disconnect(); } catch { /* noop */ }
    fpSrc = null;
    fpGain = null;
    fpRenderer = null;
    fpBuilt = false;
  }

  /** Build the single free-play graph, then start the orbit. Tears down any existing
   *  graph first so a base-head switch swaps cleanly (no leak, no doubled noise). */
  async function fpBuild() {
    if (fpBuilding || disposed) return;
    if (fpBuilt) disposeFpGraph();
    fpBuilding = true;
    try {
      const renderer = await InterpolatingHrtfRenderer.create(ctx, baseUrl(), {
        personalize: { ...fpParams },
      });
      if (disposed) return;
      renderer.setListener({ x: 0, y: 1.6, z: 0, yaw: 0 });
      const src = renderer.createSource();
      const g = ctx.createGain();
      g.gain.value = 0.9;
      noise.connect(src.input);
      src.output.connect(g);
      g.connect(dest);
      fpRenderer = renderer;
      fpSrc = src;
      fpGain = g;
      fpBuilt = true;
      fpStartLoop();
      // If the real-ear (PCA) sliders are showing, make sure the model is cached on the
      // renderer so live weight drags apply synchronously (best-effort; no-op if absent).
      if (fpShowPca) void renderer.ensurePcaAndApply({ ...fpParams });
    } catch (err) {
      deps.alert('Audio tuning hit an error: ' + (err as Error).message);
    } finally {
      fpBuilding = false;
    }
  }

  /** Apply the current knob values LIVE — re-warps the HRIR table in the existing
   *  worklet (no rebuild, no leak). Cheap enough to call on every slider input. */
  function fpApplyParams() {
    fpRenderer?.setPersonalization({ ...fpParams });
  }

  /** The motions the user can CHOOSE between while tuning by hand. `there`/`back`
   *  makes a pass ping-pong so it loops smoothly (out then back) instead of jumping. */
  const FP_MOTIONS: ReadonlyArray<{ id: string; label: string; period: number; path: (t: number) => readonly [number, number, number] }> = [
    {
      id: 'orbit', label: 'Circle around me', period: 6000,
      path: (t) => { const a = t * 2 * Math.PI; return [Math.sin(a) * 2, 1.6, -Math.cos(a) * 2]; },
    },
    {
      id: 'frontback', label: 'Front ↔ behind', period: 4000,
      path: (t) => { const tri = t < 0.5 ? t * 2 : 2 - t * 2; return [0.4, 1.6, -2 + tri * 4]; },
    },
    {
      id: 'leftright', label: 'Left ↔ right', period: 3500,
      path: (t) => { const tri = t < 0.5 ? t * 2 : 2 - t * 2; return [-2 + tri * 4, 1.6, -1.2]; },
    },
    {
      id: 'overhead', label: 'Over the top (up/down)', period: 4000,
      path: (t) => { const tri = t < 0.5 ? t * 2 : 2 - t * 2; return [0, 1.6 + Math.sin(tri * Math.PI) * 1.5, -2 + tri * 4]; },
    },
    {
      // The user's calibration idea: a HELIX at 1 m — the source circles you once per
      // ~5 s while simultaneously riding a sine up and down between −60° and +60°
      // elevation. Because it sweeps every azimuth AND the full vertical arc at once,
      // it exercises the entire directional response continuously; if your notch is
      // right you should feel it spiralling up-and-over then down-and-behind, tracing
      // the visualizer dot. Two vertical cycles per orbit so up/down is felt on every
      // side, not just front.
      id: 'spiral', label: 'Spiral up & down (calibration)', period: 5000,
      path: (t) => {
        const az = t * 2 * Math.PI; // one full circle
        const elevDeg = 60 * Math.sin(t * 2 * Math.PI * 2); // ±60°, two cycles/orbit
        return spherical1m(az, elevDeg);
      },
    },
  ];
  let fpMotionId = 'orbit';

  /** Loop the currently-selected free-play motion around the head. */
  function fpStartLoop() {
    cancelAnimationFrame(fpRaf);
    const motion = FP_MOTIONS.find((m) => m.id === fpMotionId) ?? FP_MOTIONS[0];
    const startPerf = performanceNow();
    const step = () => {
      if (disposed || !fpSrc) return;
      const ph = ((performanceNow() - startPerf) % motion.period) / motion.period; // 0..1
      const [x, y, z] = motion.path(ph);
      fpSrc.setPosition(x, y, z);
      // Feed the diagram the SAME position the audio uses (listener at origin, so the
      // source-relative offset is just the path point minus the head at y=1.6).
      fpViz?.set(x, y, z);
      fpRaf = requestAnimationFrame(step);
    };
    fpRaf = requestAnimationFrame(step);
  }

  // Coalesce rapid drags: posting the (multi-MB) HRIR table to the worklet is cheap
  // but not free, so apply at most every ~80 ms while dragging; the latest value wins.
  let fpApplyTimer: ReturnType<typeof setTimeout> | null = null;
  function fpScheduleApply() {
    if (fpApplyTimer) return;
    fpApplyTimer = setTimeout(() => { fpApplyTimer = null; fpApplyParams(); }, 80);
  }

  function slider(
    label: string,
    // Only the SCALAR knobs are sliders (pcaWeights is a vector, tuned via A/B).
    param: 'itdScale' | 'elevTilt' | 'frontBackTilt' | 'notchHz' | 'notchDepth' | 'frontBackBias' | 'upDownBias',
    min: number,
    max: number,
    stepSize: number,
  ): HTMLElement {
    const wrap = document.createElement('label');
    wrap.className = 'hrtf-knob';
    const name = document.createElement('span');
    const readout = document.createElement('span');
    readout.className = 'hrtf-knob-value';
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(stepSize);
    input.value = String(fpParams[param] ?? 0);
    const isBias = param === 'frontBackBias' || param === 'upDownBias';
    const fmt = () => {
      name.textContent = label;
      const v = fpParams[param] ?? 0;
      readout.textContent =
        param === 'itdScale' ? `${v.toFixed(2)}×`
        : param === 'notchHz' ? `${(v / 1000).toFixed(1)} kHz`
        : isBias ? `${v > 0 ? '+' : ''}${v.toFixed(2)}`
        : `${v > 0 ? '+' : ''}${v.toFixed(0)}`;
    };
    fmt();
    input.addEventListener('input', () => {
      fpParams[param] = Number(input.value);
      fmt();
      fpScheduleApply(); // live: re-warp the existing worklet (no rebuild)
    });
    wrap.append(name, input, readout);
    return wrap;
  }

  /** A live slider for one PCA weight (index k), in std-dev units (−2.5..2.5). Mirrors
   *  the parametric `slider` but writes into fpParams.pcaWeights and re-warps live. */
  function pcaSlider(k: number): HTMLElement {
    const wrap = document.createElement('label');
    wrap.className = 'hrtf-knob';
    const name = document.createElement('span');
    const readout = document.createElement('span');
    readout.className = 'hrtf-knob-value';
    const input = document.createElement('input');
    input.type = 'range';
    input.min = '-2.5'; input.max = '2.5'; input.step = '0.1';
    const cur = () => fpParams.pcaWeights?.[k] ?? 0;
    input.value = String(cur());
    const fmt = () => {
      name.textContent = fpPcaNames[k] ?? `Real-ear shape ${k + 1}`;
      const v = cur();
      readout.textContent = `${v > 0 ? '+' : ''}${v.toFixed(1)}`;
    };
    fmt();
    input.addEventListener('input', () => {
      const w = (fpParams.pcaWeights ?? new Array(fpPcaK).fill(0)).slice();
      while (w.length < fpPcaK) w.push(0);
      w[k] = Number(input.value);
      fpParams.pcaWeights = w;
      fmt();
      fpScheduleApply();
    });
    wrap.append(name, input, readout);
    return wrap;
  }

  function renderFreePlay() {
    controls.innerHTML = '';
    root.classList.remove('hrtf-compact');
    clearTimers();
    teardownAudio(); // stop any guided-game graph
    h.textContent = 'Adjust your 3D audio by hand';
    p.textContent =
      'A sound moves around you on a loop, and the diagram shows where it IS. The sliders don’t move it — they change its TONE, which is how your ears tell front from back and up from down. Pick a MOTION (try “Spiral up & down”: the sound circles you at arm’s length while rising and falling between low and high overhead — match what you hear to the dot), then adjust each slider until the sound lands where the diagram says it should. Nothing is saved until you press Save.';

    // Sighted "where is the sound" diagram — the dot traces the SAME path the audio
    // plays, so you can check whether what you hear matches where it really is.
    const vizWrap = document.createElement('div');
    vizWrap.className = 'hrtf-viz-wrap';
    fpViz?.dispose();
    fpViz = mountVisualizer(vizWrap);
    const vizNote = document.createElement('p');
    vizNote.className = 'hrtf-viz-note';
    vizNote.textContent =
      'The dot is where the sound really is. Tune until you HEAR it there.';
    vizWrap.append(vizNote);

    // Base-head picker — CHOOSE which measured ear-response to tune on top of.
    const bases = document.createElement('div');
    bases.className = 'hrtf-motions hrtf-bases';
    const baseLabel = document.createElement('span');
    baseLabel.className = 'hrtf-group-label';
    baseLabel.textContent = 'Base head:';
    bases.append(baseLabel);
    const syncBaseButtons = () => {
      for (const b of Array.from(bases.querySelectorAll('button'))) {
        b.setAttribute('aria-pressed', String((b as HTMLButtonElement).dataset.base === currentBase.id));
      }
    };
    for (const bh of BASE_HRTFS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'secondary hrtf-motion-btn';
      b.textContent = bh.label;
      b.dataset.base = bh.id;
      b.addEventListener('click', () => {
        if (currentBase.id === bh.id) return;
        currentBase = bh;
        deps.saveBaseHrtf?.(bh.id);
        syncBaseButtons();
        deps.say(bh.label);
        // Switching the base means a genuinely different measured head → rebuild once
        // (infrequent, not per-drag, so no leak concern) with the new set. fpBuild
        // tears the old graph down itself.
        void fpBuild();
      });
      bases.append(b);
    }
    syncBaseButtons();

    // Motion picker — CHOOSE which path plays while you tune.
    const motions = document.createElement('div');
    motions.className = 'hrtf-motions';
    const syncMotionButtons = () => {
      for (const b of Array.from(motions.querySelectorAll('button'))) {
        b.setAttribute('aria-pressed', String((b as HTMLButtonElement).dataset.motion === fpMotionId));
      }
    };
    for (const m of FP_MOTIONS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'secondary hrtf-motion-btn';
      b.textContent = m.label;
      b.dataset.motion = m.id;
      b.addEventListener('click', () => {
        fpMotionId = m.id;
        syncMotionButtons();
        fpStartLoop(); // restart the loop with the newly-chosen motion
        deps.say(m.label);
      });
      motions.append(b);
    }
    syncMotionButtons();

    const knobs = document.createElement('div');
    knobs.className = 'hrtf-knobs';
    // Elevation is driven by the pinna NOTCH, not brightness — so give it a sensible
    // default depth the moment the user opens the knobs, so the frequency slider is
    // immediately audible on the "Over the top" motion.
    if (fpParams.notchDepth === 0) fpParams.notchDepth = 14;
    knobs.append(
      slider('Front vs behind — start here', 'frontBackTilt', -18, 18, 1),
      slider('Left / right spread (out-of-head)', 'itdScale', 0.5, 2.0, 0.02),
      slider('UP / DOWN — pinna notch frequency', 'notchHz', 4000, 11500, 100),
      slider('Up / down notch strength', 'notchDepth', 0, 24, 1),
      // Perceptual BIAS knobs — nudge ALL directions toward front/back (resp. up/down)
      // coloring, to correct a personal reversal ("everything sounds behind me").
      slider('Push sound forward / back', 'frontBackBias', -1, 1, 0.05),
      slider('Push sound up / down', 'upDownBias', -1, 1, 0.05),
    );

    // Rebuild the real-ear (PCA) sliders into the panel; loads the model on first show.
    const renderPcaKnobs = () => {
      // Drop any existing PCA sliders first.
      for (const el of Array.from(knobs.querySelectorAll('.hrtf-pca-knob'))) el.remove();
      if (!fpShowPca) return;
      for (let k = 0; k < fpPcaK; k++) {
        const el = pcaSlider(k);
        el.classList.add('hrtf-pca-knob');
        knobs.append(el);
      }
    };
    const pcaToggle = bigButton('Show real-ear shape sliders (advanced)', async () => {
      if (!fpShowPca) {
        const { loadPcaModel } = await import('../engine/hrtf/hrtfPca');
        const model = await loadPcaModel();
        if (!model) { deps.alert('The real-ear model is unavailable in this build.'); return; }
        fpPcaK = model.k;
        fpPcaNames = model.pcs.map((pc) => pc.name);
        fpShowPca = true;
        pcaToggle.textContent = 'Hide real-ear shape sliders';
        renderPcaKnobs();
        // Ensure the live renderer has the model cached so drags apply immediately.
        if (fpRenderer) await fpRenderer.ensurePcaAndApply({ ...fpParams });
      } else {
        fpShowPca = false;
        pcaToggle.textContent = 'Show real-ear shape sliders (advanced)';
        renderPcaKnobs();
      }
    });
    renderPcaKnobs();

    const save = bigButton('Save these settings', () => {
      teardownFreePlay();
      deps.save({ ...fpParams });
      deps.say('Saved. Your 3D audio is tuned.');
      deps.alert('Personalization saved.');
      deps.onDone();
    }, true);
    // After rough hand-tuning, offer ALL the next steps (not just one) — pointing is the
    // recommended objective test, but the guided A/B and the real-ear PCA refinement are
    // right here too. Each carries the hand-tuned values in as its starting point. (The
    // old single "guided test" handoff dead-ended into the coarse front/behind flow.)
    const carry = () => { Object.assign(params, fpParams); teardownFreePlay(); };
    const nextLabel = document.createElement('span');
    nextLabel.className = 'hrtf-group-label';
    nextLabel.textContent = 'Next — test / refine:';
    // carry() persists the hand-tuned values into `params`; the routed target renders in
    // the SAME mount so those values survive the URL change.
    const toTool = (step: 'localize' | 'guided' | 'pca', direct: () => void) =>
      deps.navigate ? (carry(), deps.navigate(step)) : (carry(), direct());
    const toLocalize = bigButton('Point to where sounds come from (recommended)', () => toTool('localize', renderLocalization));
    const toGuided = bigButton('Guided “which felt better” test', () => toTool('guided', startGuided));
    const toPca = bigButton('Refine to real ears (advanced)', () => toTool('pca', () => void renderPca()));
    const nextRow = document.createElement('div');
    nextRow.className = 'hrtf-motions';
    nextRow.append(nextLabel, toLocalize, toGuided, toPca);
    const back = bigButton('Back', () => { teardownFreePlay(); backToIntro(); });

    controls.append(vizWrap, bases, motions, knobs, pcaToggle, save, nextRow, back);
    void fpBuild();
    (knobs.querySelector('input') as HTMLElement | null)?.focus();
  }

  // ------------------------------------------------------------------------
  // LOCALIZATION mode — the OBJECTIVE calibration. For each parameter we audition
  // two candidate warps by playing a probe at a random direction and asking the
  // listener to POINT to where they heard it (by clicking the diagram). The
  // candidate whose pointing had the smaller angular error wins the A/B (see
  // hrtfLocalize.decideWinner) — no "which felt better", just measured accuracy.
  // Reuses the same per-parameter Staircase as the guided game.
  // ------------------------------------------------------------------------
  let locRenderer: InterpolatingHrtfRenderer | null = null;
  let locSrc: ReturnType<InterpolatingHrtfRenderer['createSource']> | null = null;
  let locGain: GainNode | null = null;
  let locViz: ReturnType<typeof mountVisualizer> | null = null;
  let locPicker: DirectionPicker | null = null;
  /** Base URL the localization graph was built for (rebuild on a base switch). */
  let locBuiltForUrl: string | null = null;
  /** The wiggle's OWN rAF handle (separate from the guided-game sweep's rafHandle so they
   *  can't cancel each other) + a generation id so a superseded async play aborts. */
  let wiggleRaf = 0;
  let locPlayGen = 0;
  /** Whether to REVEAL the answer after each pointing (3D model + 2D compass/arc diagram).
   *  Default OFF for calibration — a clean perceptual measurement isn't biased by the user
   *  learning the visual mapping; a "Show answers" checkbox flips it on. (A future game
   *  mode forces it on.) */
  let locShowAnswers = false;
  /** The answer diagram for the current reveal, cleared before the next round. */
  let locAnswerDiag: { dispose: () => void } | null = null;
  let locTarget: Direction | null = null;

  // ===================== BASIN-TRACKING SESSION (serializable) =====================
  // The localization loop is INTERLEAVED COORDINATE DESCENT over a pool of FACTORS: the
  // base-head comparison, each parameter, and each PCA weight. Every round we pick the next
  // not-yet-converged factor round-robin (order shuffled per pass, mix32-seeded → varied but
  // deterministic) and do ONE basin probe for it with a direction targeted to that factor.
  // Consecutive trials therefore vary factor AND head — the head comparison is SPARSED among
  // the rest instead of front-loaded, and it feels like tuning everything at once. Each trial
  // still scores exactly ONE factor's basin (attribution stays clean — coordinate descent,
  // not multi-knob-per-trial). Passes repeat until every factor's basin has converged, or the
  // global question cap. (BASIN class + tallies live in hrtfLocalize; Staircase stays for the
  // guided game.)
  //
  // locSession is PLAIN JSON-serializable (resume saves/reloads it verbatim): the factor pool,
  // per-factor basin + converged flag + chosen value, the current pass's shuffled order, and
  // the round-robin cursor. No class instances inside.
  type LocFactor =
    | { kind: 'base' }
    | { kind: 'param'; param: ExerciseParam }
    | { kind: 'pca'; pc: number }
    | { kind: 'bias'; which: 'frontBack' | 'upDown' };
  interface LocFactorState {
    factor: LocFactor;
    basin: BasinState;
    /** true once this factor's basin reached 'done' — skipped in later passes. */
    converged: boolean;
    /** the committed value once converged (head index / param value / pca weight). */
    chosen: number;
  }
  interface LocSession {
    /** Ordered factor pool (index-stable across save/reload). */
    factors: LocFactorState[];
    /** This pass's visiting order (indices into `factors`), shuffled per pass. */
    order: number[];
    /** Cursor into `order` — which factor the NEXT round probes. */
    cursor: number;
    /** Pass counter (0-based); reshuffles `order` each new pass. */
    pass: number;
    /** Total probes answered (progress + cap). */
    answered: number;
    /** 'pca' when this is the standalone Refine-to-real-ears session (PCA factors only,
     *  no base/params); 'full' for the main point-to-sound loop. */
    mode: 'full' | 'pca';
    done: boolean;
  }
  let locSession: LocSession = freshLocSession();
  function freshLocSession(): LocSession {
    return { factors: [], order: [], cursor: 0, pass: 0, answered: 0, mode: 'full', done: false };
  }
  /** Tuning basin config: a few buckets across each range, confirm the winner vs noise. */
  const BASIN_CFG: BasinConfig = { minPerBucket: 1, shortlistSize: 3, confirmCap: 8 };
  const BASIN_CFG_DISCRETE: BasinConfig = { minPerBucket: 2, shortlistSize: 3, confirmCap: 8, discrete: true };
  const PARAM_BUCKETS = 6; // buckets across a parameter's [min,max] range
  const PCA_BUCKETS = 6;   // buckets across a PC weight's [−bound, +bound] range
  /** Global cap on total probes across the whole interleaved loop (safety stop). */
  const LOC_QUESTION_CAP = 60;
  /** The value the CURRENT probe is auditioning (recorded into the active basin on answer). */
  let locProbeValue = 0;
  /** The factor index the CURRENT probe belongs to (set each round, used on answer). */
  let locActiveFactor = -1;
  /** Which head index the base comparison is currently probing (for the balanced-direction
   *  seed, so each head's k-th probe is the same direction). */
  let locBaseIdx = 0;
  /** Per-trial control area (picker + replay + progress), cleared between trials so the
   *  visualizer persists but Begin/Back don't linger. */
  let locTrialArea: HTMLElement | null = null;
  let locProgressEl: HTMLElement | null = null;
  /** The "space shrinking" bracket bar (per-parameter search-range remaining). */
  let locBracketEl: HTMLElement | null = null;
  /** Progress bookkeeping so the test never feels endless: how many pointings the user
   *  has done, a rough estimate of the total, and their recent error (for "getting
   *  better"). The estimate = attempts-per-candidate × 2 candidates × exercises, which is
   *  the worst case; staircases usually converge sooner, so we phrase it as "about". */
  let locAnswered = 0;
  /** Rough round estimate for the CURRENT stage, set when it starts, for "Round N of
   *  about M". Exercises share staircases by PARAM (only a few distinct params), and each
   *  converges in ~3 rounds — so estimate ≈ distinctParams × 3, NOT one-per-exercise
   *  (which over-counted badly and made the test feel endless). */
  const LOC_DISTINCT_PARAMS = new Set(EXERCISES.map((e) => e.param)).size;
  const ROUNDS_PER_PARAM = 3;
  let locEstTotal = LOC_DISTINCT_PARAMS * ROUNDS_PER_PARAM;
  const locErrHistory: number[] = [];

  function teardownLoc() {
    clearTimers();
    cancelAnimationFrame(wiggleRaf); wiggleRaf = 0; locPlayGen++;
    if (locSrc) { try { noise.disconnect(locSrc.input); } catch { /* noop */ } }
    try { locSrc?.disconnect(); } catch { /* noop */ }
    try { locGain?.disconnect(); } catch { /* noop */ }
    locViz?.dispose();
    locPicker?.dispose();
    locSrc = null; locGain = null; locRenderer = null; locViz = null; locPicker = null;
    locTrialArea = null; locProgressEl = null; locBracketEl = null;
    locBuiltForUrl = null;
  }

  /** Ensure ONE renderer+source for the localization probe warped to `warp`. Built once
   *  then HOT-SWAPPED per attempt via setPersonalization — building a fresh worklet each
   *  attempt leaked multi-MB processors on the audio thread and starved it after a few
   *  trials (the reported "stops working"). ensurePcaAndApply also loads/caches the PCA
   *  model so PCA-weight candidates re-warp synchronously on later attempts. */
  async function locEnsureRenderer(warp: HrtfPersonalization) {
    if (locSrc && locRenderer && locBuiltForUrl === baseUrl()) {
      await locRenderer.ensurePcaAndApply(warp);
      return;
    }
    // Different base (or first build): tear down the old graph, build fresh.
    if (locSrc) { try { noise.disconnect(locSrc.input); } catch { /* noop */ } }
    try { locSrc?.disconnect(); } catch { /* noop */ }
    try { locGain?.disconnect(); } catch { /* noop */ }
    locRenderer = await InterpolatingHrtfRenderer.create(ctx, baseUrl(), { personalize: warp });
    if (disposed) return;
    locRenderer.setListener({ x: 0, y: 1.6, z: 0, yaw: 0 });
    locSrc = locRenderer.createSource();
    locGain = ctx.createGain();
    locGain.gain.value = LOCALIZE_LEVEL; // half volume — comfortable, per user pref
    noise.connect(locSrc.input);
    locSrc.output.connect(locGain);
    locGain.connect(dest);
    locBuiltForUrl = baseUrl();
  }

  /** Play the current candidate's probe at a fresh random direction, hide the true
   *  dot, and show the picker + replay + progress for the user's answer. */
  async function locPlayAndAsk() {
    if (disposed) return;
    // TARGETED direction sampling: draw the probe from the region DIAGNOSTIC for the ACTIVE
    // factor (see hrtfLocalize.SampleKind), instead of uniform-over-sphere.
    //  • base head → 'balanced' (judged across the whole sphere), seeded so each head's k-th
    //    probe is the SAME direction (fair comparison): 9000 + that head's count.
    //  • PCA weight → 'elevation' (the pinna/ear-shape cue shows up off the horizontal;
    //    front/back contrast PCs also want off-median directions).
    //  • param → the param's sampleKind (front/back, elevation, or lateral).
    const fs = locSession.factors[locActiveFactor];
    const f = fs?.factor;
    if (f?.kind === 'base') {
      locTarget = makeTargetedDirection('balanced', 9000 + fs.basin.counts[locBaseIdx]);
    } else if (f?.kind === 'pca') {
      const n = fs.basin.counts.reduce((s, c) => s + c, 0);
      locTarget = makeTargetedDirection('elevation', 7000 + f.pc * 101 + n * 7);
    } else if (f?.kind === 'param') {
      const n = fs.basin.counts.reduce((s, c) => s + c, 0);
      locTarget = makeTargetedDirection(PARAM_SAMPLE_KIND[f.param], locActiveFactor * 101 + n * 7 + 1);
    } else if (f?.kind === 'bias') {
      // frontBack bias → front/back-ambiguous directions (measures reversal); upDown → elevated.
      const n = fs.basin.counts.reduce((s, c) => s + c, 0);
      const kind = f.which === 'frontBack' ? 'frontback' : 'elevation';
      locTarget = makeTargetedDirection(kind, 6000 + locActiveFactor * 101 + n * 7);
    } else {
      locTarget = makeTargetedDirection('balanced', 9000 + locSession.answered);
    }
    ensurePickerMounted();       // build the compass/arc ONCE, reuse across probes
    locResetForNextProbe();      // reset aim + progress in place — no teardown/navigation
    await locSoundTarget();
  }

  /** Play the CURRENT locTarget once (used by both the initial ask and Replay). */
  const WIGGLE_DEG = 2;   // radius of the tiny orbit, in spherical degrees
  const WIGGLE_HZ = 1.5;  // ~1.5 revolutions per second
  const LOC_BURST_MS = 1800;

  async function locSoundTarget() {
    if (!locTarget) return;
    // Cancel ANY in-flight playback first. Without this, a fast Replay / next-trial while
    // the beeps were still awaiting could start a SECOND wiggle loop racing the first on
    // the shared rAF handle — around possibly-different targets — so the heard position
    // jumped (the intermittent ~90°-off bug). A per-play generation id makes a stale
    // async continuation abort, and the wiggle has its OWN handle now.
    stopWiggle();
    const gen = ++locPlayGen;
    const target = locTarget; // snapshot so a later locTarget change can't hijack this play
    locViz?.showSource(false);
    locViz?.setGuess(null);
    await playBeeps(ctx, dest, 1); // single marker: each probe auditions ONE candidate value
    if (disposed || gen !== locPlayGen) return; // superseded by a newer play → abort
    // Place the source at the target IMMEDIATELY, BEFORE the gain ramps up — otherwise the
    // first audible frame plays at the PREVIOUS probe's position (the "wrong location, then
    // jumps to the right one" bug), because startWiggle's first setPosition is a rAF later.
    const [cx0, cy0, cz0] = dirToPosition(target, 1, 1.6);
    locSrc?.setPosition(cx0, cy0, cz0);
    // Play a ~1.8 s burst that WIGGLES in a tiny (~2°) circle around the target — small
    // motion breaks front/back confusion and aids externalization, while the perceived
    // location stays the circle's centre (what you point at).
    if (locGain) { const t = ctx.currentTime; locGain.gain.setValueAtTime(0.0001, t); locGain.gain.exponentialRampToValueAtTime(LOCALIZE_LEVEL, t + 0.03); }
    startWiggle(target);
    locPicker?.setEnabled(true); // probe is placed + playing → answering is now valid
    const stop = setTimeout(() => {
      if (gen !== locPlayGen) return;
      stopWiggle();
      if (locGain) { const t = ctx.currentTime; locGain.gain.setTargetAtTime(0.0001, t, 0.05); }
    }, LOC_BURST_MS);
    seqTimers.push(stop);
  }

  /** Stop the wiggle loop (its own handle, separate from the guided-game sweep's). */
  function stopWiggle() { cancelAnimationFrame(wiggleRaf); wiggleRaf = 0; }

  /** Orbit the probe in a tiny circle (radius WIGGLE_DEG) around direction `centre`,
   *  in the plane tangent to the sphere there, driven by rAF for the burst's duration. */
  function startWiggle(centre: Direction) {
    cancelAnimationFrame(wiggleRaf);
    const rad = (WIGGLE_DEG * Math.PI) / 180;
    // Centre unit vector + two orthonormal tangent vectors (right, up on the sphere).
    const c = dirToVec(centre);
    // "up" tangent: world-up projected off c; fall back near the poles.
    let upx = 0, upy = 1, upz = 0;
    const dotUp = c[0] * upx + c[1] * upy + c[2] * upz;
    upx -= dotUp * c[0]; upy -= dotUp * c[1]; upz -= dotUp * c[2];
    let ulen = Math.hypot(upx, upy, upz);
    if (ulen < 1e-3) { upx = 1; upy = 0; upz = 0; ulen = 1; } // c ≈ straight up/down
    upx /= ulen; upy /= ulen; upz /= ulen;
    // "right" tangent = c × up.
    const rx = c[1] * upz - c[2] * upy;
    const ry = c[2] * upx - c[0] * upz;
    const rz = c[0] * upy - c[1] * upx;
    const start = performanceNow();
    const step = () => {
      if (disposed || !locSrc) return;
      const th = ((performanceNow() - start) / 1000) * WIGGLE_HZ * 2 * Math.PI;
      const ca = Math.cos(rad), sa = Math.sin(rad);
      const ox = Math.cos(th), oy = Math.sin(th);
      // point on the small circle = cos(rad)*c + sin(rad)*(cosθ*right + sinθ*up)
      const vx = ca * c[0] + sa * (ox * rx + oy * upx);
      const vy = ca * c[1] + sa * (ox * ry + oy * upy);
      const vz = ca * c[2] + sa * (ox * rz + oy * upz);
      locSrc.setPosition(vx, 1.6 + vy, vz); // 1 m shell, head at y=1.6
      wiggleRaf = requestAnimationFrame(step);
    };
    wiggleRaf = requestAnimationFrame(step);
  }

  /** Build the pointing UI (progress + replay + compass/arc picker) ONCE, then reuse it
   *  every probe. Rebuilding it each round tore the whole screen down and back up — which
   *  read as "leaving to an answer page" between probes. Now it stays mounted; each new
   *  probe just resets the aim + progress (locResetForNextProbe). No answer page ever in
   *  no-reveal mode; the reveal (when the checkbox is on) is a transient overlay. */
  function ensurePickerMounted() {
    if (locPicker || !locTrialArea) return;
    locTrialArea.innerHTML = '';
    locProgressEl = document.createElement('p');
    locProgressEl.className = 'hrtf-loc-progress';
    locTrialArea.append(locProgressEl);
    // "Space shrinking" feedback: a small labelled bar showing how much of the current
    // parameter's search range is left. Shrinks toward empty as the staircase homes in.
    locBracketEl = document.createElement('p');
    locBracketEl.className = 'hrtf-loc-progress hrtf-loc-bracket';
    locTrialArea.append(locBracketEl);

    // "Play again" sits on the SAME row as the confirm button (via extraAction).
    const replay = bigButton('▶ Play the sound again', () => { void locSoundTarget(); });
    replay.classList.add('secondary', 'hrtf-loc-replay');

    locPicker = mountDirectionPicker(locTrialArea, {
      onCommit: onPickerCommit,
      // Live: mirror the current aim as a dot + head→source ray in the 3D model.
      onChange: (d) => { const [gx, gy, gz] = dirToPosition(d, 1, 1.6); locViz?.setGuess({ x: gx, y: gy, z: gz }); },
      onInHead: onPickerInHead,
      extraAction: replay,
      say: deps.say,
    });
  }

  /** Reset the mounted picker + progress for a fresh probe — in place, no teardown. */
  function locResetForNextProbe() {
    locAnswerDiag?.dispose(); locAnswerDiag = null; // drop any prior reveal overlay
    locViz?.showSource(false);                       // hide the truth while pointing
    locPicker?.reset();                              // aim back to front / ear level
    locPicker?.setEnabled(false);                    // off until the probe is placed + playing
    if (locProgressEl) locProgressEl.textContent = locProgressText();
    updateBracketBar();
    p.textContent = 'Where did the sound come from? Set the compass + height, then confirm.';
    deps.say('Where did it come from? Set the direction and height, then confirm.');
  }

  /** Human label for a parameter, for the shrinking-space bar. */
  const PARAM_LABEL: Record<ExerciseParam, string> = {
    itdScale: 'Width', elevTilt: 'Up/down', frontBackTilt: 'Front/back', notchHz: 'Height',
  };
  /** A short human label for a factor (for the "this round" note). */
  function factorLabel(f: LocFactor): string {
    if (f.kind === 'base') return 'best-fit head';
    if (f.kind === 'pca') return (pcaModelLoaded?.pcs[f.pc]?.name ?? `ear shape ${f.pc + 1}`).toLowerCase();
    if (f.kind === 'bias') return f.which === 'frontBack' ? 'forward/back bias' : 'up/down bias';
    return PARAM_LABEL[f.param].toLowerCase();
  }
  /** Render OVERALL tuning progress across the whole factor pool (we refine everything
   *  together now, not one bar grinding to zero before the next appears), plus which factor
   *  this round is touching. The bar fills as factors converge + partial basin progress. */
  function updateBracketBar() {
    if (!locBracketEl) return;
    const CELLS = 8;
    const factors = locSession.factors;
    if (factors.length === 0) { locBracketEl.textContent = ''; return; }
    // Overall progress = mean per-factor completion (1 − remaining fraction), converged = 1.
    let sum = 0;
    for (const fs of factors) {
      sum += fs.converged ? 1 : (1 - basinRemainingFraction(fs.basin, factorCfg(fs.factor)));
    }
    const done = sum / factors.length; // 0..1 overall
    const filled = Math.max(0, Math.min(CELLS, Math.round(done * CELLS)));
    const bar = '▓'.repeat(filled) + '░'.repeat(CELLS - filled);
    const nConv = factors.filter((f) => f.converged).length;
    const active = factors[locActiveFactor]?.factor;
    const thisRound = active ? ` — this round: ${factorLabel(active)}` : '';
    locBracketEl.textContent = `Overall tuning: ${bar} (${nConv}/${factors.length} locked)${thisRound}`;
  }

  /** "Round N of about M" plus, once there's history, whether accuracy is improving.
   *  If we run past the estimate (staircases occasionally need extra rounds), switch to
   *  "almost done" rather than a wrong "N of M". */
  function locProgressText(): string {
    const round = locAnswered + 1;
    // Rounds are variable now (adaptive stop), so the total is an upper bound → "up to".
    let s = round > locEstTotal
      ? `Round ${round} — almost done.`
      : `Round ${round} of up to about ${locEstTotal}.`;
    if (locErrHistory.length >= 4) {
      const half = Math.floor(locErrHistory.length / 2);
      const early = avg(locErrHistory.slice(0, half));
      const recent = avg(locErrHistory.slice(half));
      const deg = (r: number) => Math.round((r * 180) / Math.PI);
      // Frame improving aim as the search space closing in around the answer.
      if (recent < early - 0.08) s += ` Your aim is tightening (about ${deg(recent)}° off now) — closing in.`;
      else s += ` Recent aim: about ${deg(recent)}° off.`;
    }
    return s;
  }

  /** Route a committed pick into the interleaved loop. */
  function onPickerCommit(guess: Direction) {
    // Guard against a second commit while the next probe is still playing (double-tap /
    // fast answers otherwise mis-record a probe against the wrong target). Re-enabled once
    // the next probe is placed (in locSoundTarget). Picker stays mounted across probes.
    locPicker?.setEnabled(false);
    locOnPick(guess);
  }

  /** "It was inside my head" — an EXTERNALIZATION failure. We score it as a worst-case
   *  localization (a large fixed error) so the search moves AWAY from this candidate: an
   *  in-head sound is the worst possible outcome, not a neutral skip. Routed like a
   *  normal answer so the interleaved loop advances. π/2 (90°) ≈ "no usable direction". */
  const INHEAD_ERROR = Math.PI / 2;
  function onPickerInHead() {
    if (!locTarget) return;
    recordProbe(INHEAD_ERROR);
    locAnswered++; locSession.answered++;
    locErrHistory.push(INHEAD_ERROR);
    deps.say('Inside your head — we’ll steer away from that setting.');
    p.textContent = 'Inside your head — noted. Next…';
    const id = setTimeout(() => locNextAttempt(), 1000);
    seqTimers.push(id);
  }

  /** Record a probe's pointing error into the ACTIVE basin (the one whose value the current
   *  probe auditioned). Which basin depends on the stage; locProbeValue is the value probed. */
  function recordProbe(err: number) {
    const fs = locSession.factors[locActiveFactor];
    if (!fs) return;
    basinRecord(fs.basin, locProbeValue, err, fs.factor.kind === 'base');
  }

  /** The user committed a direction (compass + height): score it, advance the trial. */
  function locOnPick(guess: Direction) {
    if (!locTarget) return;
    const err = angularError(locTarget, guess);
    logAnswer(guess, err);
    recordProbe(err);
    locAnswered++; locSession.answered++;
    locErrHistory.push(err);
    const delay = locRevealResult(guess, err);
    const id = setTimeout(() => locNextAttempt(), delay);
    seqTimers.push(id);
  }

  /** DEBUG: console-log one answer so calibration behaviour can be analysed offline —
   *  true vs guessed direction, the SIGNED per-axis errors (which axis is failing?), the
   *  candidate under test + its param value, and the current full warp. */
  function logAnswer(guess: Direction, err: number) {
    if (!locTarget || !calDebugEnabled()) return;
    const deg = (r: number) => Math.round((r * 180) / Math.PI);
    const comp = decomposeError(locTarget, guess);
    const f = locSession.factors[locActiveFactor]?.factor;
    const phase = f ? f.kind : '?';
    const paramInfo = !f ? {}
      : f.kind === 'pca' ? { pc: f.pc, probeWeight: locProbeValue, weights: params.pcaWeights }
      : f.kind === 'base' ? { testingBase: currentBase.id }
      : f.kind === 'bias' ? { bias: f.which, probeValue: locProbeValue }
      : { param: f.param, probeValue: locProbeValue };
    console.log(`[hrtf-cal] ${phase} pass${locSession.pass} #${locAnswered + 1}`, {
      targetDeg: { az: deg(locTarget.az), el: deg(locTarget.el) },
      guessDeg: { az: deg(guess.az), el: deg(guess.el) },
      totalErrDeg: deg(err),
      signedErrDeg: { lateral: deg(comp.lateral), frontBack: deg(comp.frontBack), updown: deg(comp.updown), lateralWeight: +comp.lateralWeight.toFixed(2) },
      ...paramInfo,
      base: currentBase.id,
    });
  }

  /** Show the outcome of a pointing. When `locShowAnswers` is on, REVEAL the truth in the
   *  3D model AND the two 2D views (compass + arc), and pause longer so it can be studied.
   *  When off (default calibration), just announce "≈X° off" and advance quickly with no
   *  reveal — keeps the perceptual measurement unbiased. Returns the delay before advancing. */
  function locRevealResult(guess: Direction, err: number): number {
    const degOff = Math.round((err * 180) / Math.PI);
    deps.say(degOff < 25 ? 'Close.' : degOff < 60 ? 'Not bad.' : 'Off.');
    if (!locShowAnswers) {
      p.textContent = `You were about ${degOff}° off. Next…`;
      return 800;
    }
    // Full reveal: 3D model source at the TRUE target + guess ring, plus the 2D diagram.
    if (locTarget && locViz) {
      const [gx, gy, gz] = dirToPosition(guess, 1, 1.6);
      locViz.setGuess({ x: gx, y: gy, z: gz });
      const [stx, sty, stz] = dirToPosition(locTarget, 1, 1.6);
      locViz.set(stx, sty, stz);
      locViz.showSource(true);
    }
    p.textContent = `You were about ${degOff}° off. (Yellow = where it was, blue = where you pointed.)`;
    locAnswerDiag?.dispose();
    if (locTarget && locTrialArea) locAnswerDiag = mountAnswerDiagram(locTrialArea, locTarget, guess);
    return 2600;
  }

  /** The heads screened in the base phase (all registered base heads). */
  const BASE_HEADS = BASE_HRTFS;


  /** The distinct parameters we tune (each an exercise param). */
  const DISTINCT_PARAMS = [...new Set(EXERCISES.map((e) => e.param))] as ExerciseParam[];

  /** Build the factor pool for a session. `mode`='full' → base head + params (+ PCA weights
   *  when the model is loaded); 'pca' → PCA weights only (the standalone Refine screen). */
  function buildFactorPool(mode: 'full' | 'pca'): LocFactorState[] {
    const pool: LocFactorState[] = [];
    const mk = (factor: LocFactor, basin: BasinState): LocFactorState => ({ factor, basin, converged: false, chosen: 0 });
    if (mode === 'full') {
      pool.push(mk({ kind: 'base' }, makeBasin(0, BASE_HEADS.length, BASE_HEADS.length)));
      for (const param of DISTINCT_PARAMS) {
        const cfg = STAIRCASE_CONFIG[param];
        pool.push(mk({ kind: 'param', param }, makeBasin(cfg.min, cfg.max, PARAM_BUCKETS)));
      }
      // Perceptual BIAS factors — the objective loop finds each user's front/back + up/down
      // reversal bias (∈[−1,+1]). One basin each over the bias range.
      pool.push(mk({ kind: 'bias', which: 'frontBack' }, makeBasin(-1, 1, PARAM_BUCKETS)));
      pool.push(mk({ kind: 'bias', which: 'upDown' }, makeBasin(-1, 1, PARAM_BUCKETS)));
    }
    // PCA weight factors (both modes include these when the model is available).
    if (pcaModelLoaded) {
      for (let k = 0; k < pcaModelLoaded.k; k++) {
        const bound = pcaWeightBound(k);
        pool.push(mk({ kind: 'pca', pc: k }, makeBasin(-bound, bound, PCA_BUCKETS)));
      }
    }
    return pool;
  }

  /** basin config for a factor (discrete for the base-head comparison, continuous else). */
  function factorCfg(f: LocFactor): BasinConfig {
    return f.kind === 'base' ? BASIN_CFG_DISCRETE : BASIN_CFG;
  }

  /** Start (or restart) the interleaved loop. Builds the pool + the first pass order. */
  async function locStart(mode: 'full' | 'pca') {
    locSession = freshLocSession();
    locSession.mode = mode;
    locSession.factors = buildFactorPool(mode);
    locSession.order = makePassOrder(0, locSession.factors.length);
    locSession.cursor = 0;
    await locDriveRound();
  }

  /** Pick the next NOT-yet-converged factor round-robin (via the pure rrNext scheduler) and
   *  do ONE probe for it. Consecutive rounds land on DIFFERENT factors → factor AND head
   *  vary, and the base-head comparison is sparsed among the params. A factor whose basin
   *  reaches 'done' converges and drops out (no trial spent). Stop when every factor has
   *  converged OR the global question cap is hit. */
  async function locDriveRound() {
    if (disposed) return;
    const S = locSession;
    // Loop internally so a just-converged factor doesn't waste a trial — keep pulling the
    // next factor until one yields an actual probe, or all converge / cap hit.
    let guard = 0;
    while (guard++ < S.factors.length * 6 + 8) {
      if (S.answered >= LOC_QUESTION_CAP || S.factors.every((f) => f.converged)) return locFinish();
      const rr = rrNext({ order: S.order, cursor: S.cursor, pass: S.pass }, S.factors.map((f) => f.converged));
      S.order = rr.rr.order; S.cursor = rr.rr.cursor; S.pass = rr.rr.pass;
      if (rr.index < 0) return locFinish();
      const fs = S.factors[rr.index];
      const step = basinNext(fs.basin, factorCfg(fs.factor));
      if (step.done) {
        fs.converged = true; fs.chosen = step.value;
        commitFactor(fs);
        continue; // find another factor — don't spend a trial on a just-converged one
      }
      // Set up + play the probe for this factor; the next round lands on a DIFFERENT factor.
      locActiveFactor = rr.index;
      locProbeValue = step.value;
      await applyFactorProbe(fs.factor, step.value);
      await locPlayAndAsk();
      return;
    }
    return locFinish();
  }

  /** Apply the current factor's candidate value to the renderer (base head / param / PCA /
   *  bias) WITHOUT mutating the committed `params` (a probe is provisional). */
  async function applyFactorProbe(f: LocFactor, value: number) {
    if (f.kind === 'base') {
      locBaseIdx = Math.round(value);
      currentBase = BASE_HEADS[locBaseIdx];
      await locEnsureRenderer({ ...params });
    } else if (f.kind === 'param') {
      await locEnsureRenderer(withParam(params, f.param, value));
    } else if (f.kind === 'pca') {
      await locEnsureRenderer(withPcaWeight(params, f.pc, value, pcaModelLoaded?.k ?? 0));
    } else { // bias
      await locEnsureRenderer(withBias(params, f.which, value));
    }
  }

  /** Commit a converged factor's chosen value into `params` / the base head. */
  function commitFactor(fs: LocFactorState) {
    const f = fs.factor;
    if (f.kind === 'base') {
      currentBase = BASE_HEADS[Math.round(fs.chosen)];
      deps.saveBaseHrtf?.(currentBase.id);
      if (calDebugEnabled()) {
        const b = fs.basin;
        const summary = BASE_HEADS.map((h, i) => `${h.id} ${Math.round(basinMean(b, i) * 180 / Math.PI)}°×${b.counts[i]}`).join(', ');
        console.log(`[hrtf-cal] BASE chosen: ${currentBase.id} — ${summary}`);
      }
      deps.say(`Using ${currentBase.label}.`);
    } else if (f.kind === 'param') {
      params[f.param] = fs.chosen;
    } else if (f.kind === 'pca') {
      const kk = pcaModelLoaded?.k ?? 0;
      const w = (params.pcaWeights ?? new Array(kk).fill(0)).slice();
      while (w.length < kk) w.push(0);
      w[f.pc] = fs.chosen; params.pcaWeights = w;
    } else { // bias
      if (f.which === 'frontBack') params.frontBackBias = fs.chosen;
      else params.upDownBias = fs.chosen;
    }
  }

  /** All factors converged (or cap hit) → commit + save + finish. */
  function locFinish() {
    // Commit any factor that hit the cap without formally converging: use its best bucket.
    for (const fs of locSession.factors) {
      if (fs.converged) continue;
      fs.chosen = bestBasinValue(fs);
      fs.converged = true;
      commitFactor(fs);
    }
    locSession.done = true;
    teardownLoc();
    deps.save(params);
    if (locSession.mode === 'pca') {
      deps.say('Refinement complete. Your 3D audio is tuned to how real ears vary.');
      deps.alert('Refinement complete.');
    } else {
      deps.say('Localization calibration complete. Your 3D audio is tuned to how you actually hear.');
      deps.alert('Calibration complete.');
    }
    deps.onDone();
  }

  /** The value of a basin's lowest-mean-error bucket (for cap fallback). */
  function bestBasinValue(fs: LocFactorState): number {
    const b = fs.basin;
    let best = 0, bm = Infinity;
    for (let i = 0; i < b.nBuckets; i++) { const m = basinMean(b, i); if (m < bm) { bm = m; best = i; } }
    return basinBucketValue(b, best, fs.factor.kind === 'base');
  }

  /** Advance the interleaved loop after a pointing was recorded. */
  async function locNextAttempt() {
    if (disposed) return;
    return locDriveRound();
  }

  function renderLocalization() {
    controls.innerHTML = '';
    clearTimers();
    teardownAudio();
    teardownFreePlay();
    root.classList.add('hrtf-compact'); // tighter typography/spacing so it fits without scroll
    h.textContent = 'Point to the sound';
    p.textContent =
      'A sound will play somewhere around you. Say where it came from using TWO controls: the COMPASS (which way around you — front, right, behind, left) and the HEIGHT arc (below, ear level, or overhead). Then press “This is where it came from”. If it seemed to come from INSIDE your head with no direction, press that button instead — that tells us the tuning isn’t working yet. We keep whichever tuning helps you locate best. About a dozen quick rounds.';
    const vizWrap = document.createElement('div');
    vizWrap.className = 'hrtf-viz-wrap';
    locViz = mountVisualizer(vizWrap); // display only; input is the picker below
    // A trial area that gets cleared each round (so the Begin button — and later the
    // picker — don't pile up), while the visualizer above persists.
    // "Show answers" checkbox — OFF by default. Lives OUTSIDE locTrialArea (which is
    // wiped every round) so it PERSISTS and stays toggleable mid-test. When off,
    // calibration just says how far off you were and advances (unbiased measurement);
    // when on, it reveals the true direction in the 3D model + the two 2D views.
    const showRow = makeShowAnswersRow();
    locTrialArea = document.createElement('div');
    locTrialArea.className = 'hrtf-loc-trial';
    controls.append(vizWrap, locTrialArea, showRow); // checkbox at the END
    const begin = bigButton('Begin', () => {
      startNoise();
      locAnswered = 0; locErrHistory.length = 0;
      // Load the PCA model up front (best-effort) so its weights join the factor pool and
      // are tuned INTERLEAVED with the base head + params — then start the round-robin.
      void (async () => {
        if (!pcaModelLoaded) { try { const { loadPcaModel } = await import('../engine/hrtf/hrtfPca'); pcaModelLoaded = await loadPcaModel(); } catch { /* no PCA */ } }
        locEstTotal = estimateLocTotal('full');
        await locStart('full');
      })();
    }, true);
    const back = bigButton('Back', () => { teardownLoc(); backToIntro(); });
    locTrialArea.append(begin, back);
    begin.focus();
  }

  /** Upper-bound round estimate for progress text. Each factor ≈ its buckets × minPerBucket
   *  (explore) + a short confirm tail; heads are one discrete factor. */
  function estimateLocTotal(mode: 'full' | 'pca'): number {
    const pcaCount = pcaModelLoaded?.k ?? 0;
    const perParam = PARAM_BUCKETS * BASIN_CFG.minPerBucket + 3;
    const perPca = PCA_BUCKETS * BASIN_CFG.minPerBucket + 3;
    if (mode === 'pca') return pcaCount * perPca;
    const base = BASE_HRTFS.length * BASIN_CFG_DISCRETE.minPerBucket + 3;
    return Math.min(LOC_QUESTION_CAP, base + LOC_DISTINCT_PARAMS * perParam + pcaCount * perPca);
  }

  /** A persistent "Show me the answer" checkbox bound to locShowAnswers (default off). */
  function makeShowAnswersRow(): HTMLElement {
    const showRow = document.createElement('label');
    showRow.className = 'hrtf-loc-showans';
    const showCb = document.createElement('input');
    showCb.type = 'checkbox';
    showCb.checked = locShowAnswers;
    showCb.addEventListener('change', () => { locShowAnswers = showCb.checked; });
    showRow.append(showCb, document.createTextNode(' Show me the answer after each (for practice)'));
    return showRow;
  }

  // ------------------------------------------------------------------------
  // PCA REFINEMENT (standalone "Refine to real ears" screen). Runs the SAME interleaved
  // basin loop, but with a factor pool of PCA weights only (mode 'pca') — morphing the
  // magnitude along the axes real human ears vary. In the MAIN "point to the sound" loop
  // the PCA weights are already folded into the pool alongside the base head + params, so
  // they get tuned interleaved with everything else; this screen is for refining them alone.
  // ------------------------------------------------------------------------
  let pcaModelLoaded: import('../engine/hrtf/hrtfPca').HrtfPcaModel | null = null;

  async function renderPca() {
    controls.innerHTML = '';
    clearTimers();
    teardownAudio(); teardownFreePlay(); teardownLoc();
    root.classList.add('hrtf-compact'); // same compact layout as localization
    h.textContent = 'Refine to real ears';
    p.textContent = 'Loading the real-ear model…';
    const { loadPcaModel } = await import('../engine/hrtf/hrtfPca');
    pcaModelLoaded = await loadPcaModel();
    if (!pcaModelLoaded) {
      p.textContent = 'The real-ear refinement model is unavailable in this build.';
      controls.append(bigButton('Back', () => backToIntro()));
      return;
    }
    p.textContent =
      'Same as before — a sound plays around you and you point to where you heard it. Now we morph your 3D audio along the ways real human ears differ, keeping whatever helps you locate sounds best. About a dozen quick rounds.';
    const vizWrap = document.createElement('div');
    vizWrap.className = 'hrtf-viz-wrap';
    locViz = mountVisualizer(vizWrap); // display only; input is the picker
    const showRow = makeShowAnswersRow(); // persistent, outside the per-round trial area
    locTrialArea = document.createElement('div');
    locTrialArea.className = 'hrtf-loc-trial';
    controls.append(vizWrap, locTrialArea, showRow); // checkbox at the END
    const begin = bigButton('Begin', () => {
      startNoise();
      locAnswered = 0; locErrHistory.length = 0;
      locEstTotal = estimateLocTotal('pca');
      void locStart('pca'); // interleaved loop over PCA-weight factors only
    }, true);
    const back = bigButton('Back', () => { teardownLoc(); backToIntro(); });
    locTrialArea.append(begin, back);
    begin.focus();
  }

  /** Weight range for PC `k`'s basin. Magnitude PCs: ±2.5 std-dev (real-ear range). Front/
   *  back contrast PCs push front & back OPPOSITE ways, so a given |weight| moves twice the
   *  front-vs-back spread — a slightly wider ±3 lets the search reach a strong correction. */
  function pcaWeightBound(k: number): number {
    return pcaModelLoaded?.pcs[k]?.kind === PC_KIND_FRONTBACK ? 3 : 2.5;
  }

  /** Return to the chooser: via the router (its own URL) when routed, else in-page. */
  function backToIntro() {
    if (deps.navigate) deps.navigate('tune');
    else showIntro();
  }

  function showIntro() {
    controls.innerHTML = '';
    root.classList.remove('hrtf-compact');
    h.textContent = 'Personalize your 3D audio';
    p.textContent =
      'Tune 3D audio to your ears. Best first: POINT TO THE SOUND — we play a sound around you, you point where you heard it, and we keep the tuning that makes you most accurate. Or adjust by hand with the KNOBS, or take the GUIDED “which felt better” test. When you’ve tuned the basics, REFINE TO REAL EARS morphs along how human ears actually vary. Nothing saves until you choose to.';
    // When routed, tool selection goes through the router (its own URL); otherwise swap
    // the DOM directly. Either way the tool's own render calls startNoise().
    const open = (step: 'localize' | 'knobs' | 'guided' | 'pca', direct: () => void) =>
      deps.navigate ? deps.navigate(step) : (startNoise(), direct());
    const localizeBtn = bigButton('Point to the sound (recommended)', () => open('localize', renderLocalization), true);
    const knobsBtn = bigButton('Adjust by hand (knobs)', () => open('knobs', renderFreePlay));
    const guided = bigButton('Guided “which felt better” test', () => open('guided', startGuided));
    const pcaBtn = bigButton('Refine to real ears (advanced)', () => open('pca', () => void renderPca()));
    const skipBtn = bigButton('Skip', skip);
    controls.append(localizeBtn, knobsBtn, guided, pcaBtn, skipBtn);
    (controls.querySelector('button') as HTMLElement).focus();
  }

  // Fold free-play + localization teardown into dispose.
  const baseDispose = dispose;
  const disposeAll = () => { teardownFreePlay(); teardownLoc(); if (fpApplyTimer) clearTimeout(fpApplyTimer); baseDispose(); };

  // Open the tool the route asked for (deep-link), else the chooser. Each render fn tears
  // down the others' audio graphs first, and startNoise() is idempotent, so entering a tool
  // directly is safe. On a routed cold-load, main.ts re-arms audio before mounting.
  switch (deps.initial) {
    case 'localize': startNoise(); renderLocalization(); break;
    case 'knobs': startNoise(); renderFreePlay(); break;
    case 'guided': startNoise(); startGuided(); break;
    case 'pca': startNoise(); void renderPca(); break;
    default: showIntro(); break;
  }
  return disposeAll;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Arithmetic mean of a non-empty array (0 for empty). */
function avg(xs: number[]): number {
  return xs.length ? xs.reduce((p, c) => p + c, 0) / xs.length : 0;
}

/** performance.now() with a plain-Date fallback (jsdom/tests). */
function performanceNow(): number {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : 0;
}

/**
 * A point on the 1 m shell at azimuth `az` (radians, 0 = front, +right) and
 * elevation `elevDeg` (degrees, + up). Engine convention: +x right, +y up, −z front,
 * listener at head height 1.6 m. Used by the spiral calibration motion so the probe
 * traces the exact 1 m helix the visualizer draws.
 */
function spherical1m(az: number, elevDeg: number): [number, number, number] {
  const el = (elevDeg * Math.PI) / 180;
  const r = 1; // 1 m — near enough to feel personal, far enough to externalize
  const cosEl = Math.cos(el);
  const x = Math.sin(az) * cosEl * r;
  const z = -Math.cos(az) * cosEl * r; // −z = front
  const y = 1.6 + Math.sin(el) * r;
  return [x, y, z];
}

/**
 * Play `count` short, WARM marker tones (centered, dry — NOT through the HRTF), so
 * the listener hears one soft tone = version 1, two = version 2. Warmth comes from a
 * LOW pitch (mid-200s Hz) run through a gentle low-pass to shave any edge, plus a
 * soft attack and long-ish decay so it's a mellow "pud" — friendly, not a beep. Kept
 * quiet (peak ~0.045). Instant + language-independent, so the gap between passes
 * stays tight. Resolves when the markers have finished.
 */
function playBeeps(ctx: AudioContext, dest: AudioNode, count: number): Promise<void> {
  const toneMs = 150;
  const gapMs = 120;
  // One shared warmth low-pass for all the tones this call.
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 700;
  lp.Q.value = 0.3;
  lp.connect(dest);
  const t0 = ctx.currentTime;
  for (let i = 0; i < count; i++) {
    const start = t0 + (i * (toneMs + gapMs)) / 1000;
    const end = start + toneMs / 1000;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    // Low, warm pitches. Gentle rising minor-third pair for v2 (very soft cue).
    osc.frequency.value = count === 1 ? 262 : i === 0 ? 247 : 294; // ~C4 / B3→D4
    // Soft attack, mellow decay — quiet peak ~0.045, no click.
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(0.045, start + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0005, end);
    g.gain.linearRampToValueAtTime(0, end + 0.02);
    osc.connect(g);
    g.connect(lp);
    osc.start(start);
    osc.stop(end + 0.04);
  }
  const totalMs = count * toneMs + (count - 1) * gapMs;
  // Disconnect the shared filter once the last tone has fully rung out.
  setTimeout(() => { try { lp.disconnect(); } catch { /* noop */ } }, totalMs + 200);
  return new Promise((resolve) => setTimeout(resolve, totalMs + 60));
}

/**
 * A looping pink-ish noise BufferSource. Pink (−3 dB/oct) noise is the standard
 * probe for HRTF work: broadband so the high-frequency pinna notches that carry
 * elevation / front-back are excited, but not as harsh as white. Built with the
 * classic Voss-McCartney-lite one-pole approximation over a 2 s buffer.
 */
function makePinkNoise(ctx: AudioContext): AudioBufferSourceNode {
  const seconds = 2;
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < n; i++) {
    const white = Math.random() * 2 - 1;
    // Paul Kellet's economical pink filter (3-pole).
    b0 = 0.99765 * b0 + white * 0.0990460;
    b1 = 0.96300 * b1 + white * 0.2965164;
    b2 = 0.57000 * b2 + white * 1.0526913;
    d[i] = (b0 + b1 + b2 + white * 0.1848) * 0.15;
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  return src;
}
