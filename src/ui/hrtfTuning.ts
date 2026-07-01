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
import { NEUTRAL_PERSONALIZATION, type HrtfPersonalization } from '../engine/hrtf/personalize';
import { Staircase, type StaircaseTrial } from './hrtfStaircase';
import { EXERCISES, STAIRCASE_CONFIG, type Exercise, type ExerciseParam } from './hrtfExercises';
import { mountVisualizer } from './hrtfVisualizer';
import {
  makeTestDirections,
  dirToPosition,
  angularError,
  screenToDirection,
  decideWinner,
  type Direction,
  type Attempt,
} from './hrtfLocalize';

/**
 * The measured base head-responses the user can choose to personalize on top of.
 * Each is a different real person's ears; which one fits YOU best is itself part of
 * the calibration (the "pick the closest head" idea). SADIE H3 is our default; CIPIC
 * 124 is the subject Steam Audio ships (baked into our own format). id is stored in
 * settings so the game/beacon later loads the same base.
 */
export interface BaseHrtf { id: string; label: string; url: string; }
export const BASE_HRTFS: readonly BaseHrtf[] = [
  { id: 'sadie_h3', label: 'Default (SADIE H3)', url: '/assets/hrtf/sadie_h3.hrtf' },
  { id: 'cipic_124', label: 'Steam’s (CIPIC 124)', url: '/assets/hrtf/cipic_124.hrtf' },
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
  const staircases = new Map<ExerciseParam, Staircase>();
  let curTrial: StaircaseTrial | null = null;
  /** For 'ab', we play A then B and remember which the user is auditioning. */

  function currentExercise(): Exercise {
    return EXERCISES[exIdx];
  }

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

  async function ensureRenderers(a: HrtfPersonalization, b: HrtfPersonalization) {
    // (Re)build both renderers with the two candidate warps. Building is cheap
    // relative to a trial (a few hundred ms of min-phase precompute) and only
    // happens once per trial, so tear down + rebuild keeps the code simple and
    // guarantees each candidate is exactly its warp.
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
  }

  /** Select which warp (A or B) the next sweep uses; instant while gated silent. */
  function selectCandidate(which: 'a' | 'b') {
    if (!gainA || !gainB) return;
    gainA.gain.value = which === 'a' ? 1 : 0;
    gainB.gain.value = which === 'b' ? 1 : 0;
  }

  /** Open/close the audible gate with a short ramp so passes fade in/out cleanly. */
  function setGate(on: boolean) {
    if (!gate) return;
    const t = ctx.currentTime;
    gate.gain.setTargetAtTime(on ? 1 : 0, t, 0.02);
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
      const step = () => {
        if (disposed) return resolve();
        const elapsed = performanceNow() - startPerf;
        const t = Math.min(1, elapsed / durMs); // ONE pass, no loop
        const [x, y, z] = ex.trajectory(t);
        srcA?.setPosition(x, y, z);
        srcB?.setPosition(x, y, z);
        if (t >= 1) {
          setGate(false);
          const id = setTimeout(resolve, 120); // let the fade-out finish
          seqTimers.push(id);
          return;
        }
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

  async function renderExercise() {
    if (exIdx >= EXERCISES.length) return finish();
    const ex = currentExercise();
    const sc = staircaseFor(ex);

    // If this parameter has converged, commit its value and advance.
    if (sc.done) {
      params[ex.param] = sc.current;
      exIdx++;
      return renderExercise();
    }

    curTrial = sc.nextTrial();
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
    param: 'itdScale' | 'elevTilt' | 'frontBackTilt' | 'notchHz' | 'notchDepth',
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
    input.value = String(fpParams[param]);
    const fmt = () => {
      name.textContent = label;
      const v = fpParams[param];
      readout.textContent =
        param === 'itdScale' ? `${v.toFixed(2)}×`
        : param === 'notchHz' ? `${(v / 1000).toFixed(1)} kHz`
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
      name.textContent = `Real-ear shape ${k + 1}`;
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
      slider('Front vs behind (brightness) — start here', 'frontBackTilt', -18, 18, 1),
      slider('Left / right spread (out-of-head)', 'itdScale', 0.5, 2.0, 0.02),
      slider('UP / DOWN — pinna notch frequency', 'notchHz', 4000, 11000, 100),
      slider('Up / down notch strength', 'notchDepth', 0, 24, 1),
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
    const toLocalize = bigButton('Point to where sounds come from (recommended)', () => { carry(); renderLocalization(); });
    const toGuided = bigButton('Guided “which felt better” test', () => { carry(); renderExercise(); });
    const toPca = bigButton('Refine to real ears (advanced)', () => { carry(); void renderPca(); });
    const nextRow = document.createElement('div');
    nextRow.className = 'hrtf-motions';
    nextRow.append(nextLabel, toLocalize, toGuided, toPca);
    const back = bigButton('Back', () => { teardownFreePlay(); showIntro(); });

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
  let locExIdx = 0;
  let locTrial: StaircaseTrial | null = null;
  let locAttempts: Attempt[] = [];
  let locWhich: 'a' | 'b' = 'a';
  let locTarget: Direction | null = null;
  const locStaircases = new Map<ExerciseParam, Staircase>();
  const ATTEMPTS_PER_CANDIDATE = 2;

  function teardownLoc() {
    clearTimers();
    if (locSrc) { try { noise.disconnect(locSrc.input); } catch { /* noop */ } }
    try { locSrc?.disconnect(); } catch { /* noop */ }
    try { locGain?.disconnect(); } catch { /* noop */ }
    locViz?.dispose();
    locSrc = null; locGain = null; locRenderer = null; locViz = null;
  }

  /** (Re)build one renderer+source for the localization probe with warp `warp`. */
  async function locEnsureRenderer(warp: HrtfPersonalization) {
    if (locSrc) { try { noise.disconnect(locSrc.input); } catch { /* noop */ } }
    try { locSrc?.disconnect(); } catch { /* noop */ }
    try { locGain?.disconnect(); } catch { /* noop */ }
    locRenderer = await InterpolatingHrtfRenderer.create(ctx, baseUrl(), { personalize: warp });
    if (disposed) return;
    locRenderer.setListener({ x: 0, y: 1.6, z: 0, yaw: 0 });
    locSrc = locRenderer.createSource();
    locGain = ctx.createGain();
    locGain.gain.value = 0.5; // half volume — comfortable, per user pref
    noise.connect(locSrc.input);
    locSrc.output.connect(locGain);
    locGain.connect(dest);
  }

  function locStaircaseFor(ex: Exercise): Staircase {
    let sc = locStaircases.get(ex.param);
    if (!sc) {
      sc = new Staircase({ ...STAIRCASE_CONFIG[ex.param], start: params[ex.param] });
      locStaircases.set(ex.param, sc);
    }
    return sc;
  }

  /** Play the current candidate's probe at a fresh random direction, hide the true
   *  dot, and wait for the user to click where they heard it. */
  async function locPlayAndAsk() {
    if (disposed) return;
    // Pick target direction seeded by attempt index for reproducibility across runs.
    const seed = locExIdx * 101 + locAttempts.length * 7 + 1;
    locTarget = makeTestDirections(1, seed)[0];
    const [tx, ty, tz] = dirToPosition(locTarget, 1, 1.6);
    locViz?.showSource(false);
    locViz?.setGuess(null);
    p.textContent = 'Listen…';
    await playBeeps(ctx, dest, locWhich === 'a' ? 1 : 2);
    if (disposed) return;
    // Play a ~1.5 s static burst at the target (a fixed point localizes cleaner than a
    // moving sweep for a "where is it" judgement).
    locSrc?.setPosition(tx, ty, tz);
    if (locGain) { const t = ctx.currentTime; locGain.gain.setValueAtTime(0.0001, t); locGain.gain.exponentialRampToValueAtTime(0.5, t + 0.03); }
    p.textContent = 'Where did the sound come from? Click on the diagram to point.';
    deps.say('Where did it come from? Point on the diagram.');
    const stop = setTimeout(() => {
      if (locGain) { const t = ctx.currentTime; locGain.gain.setTargetAtTime(0.0001, t, 0.05); }
    }, 1500);
    seqTimers.push(stop);
  }

  /** The user clicked the diagram: record the angular error, advance the trial. */
  function locOnPick(sx: number, sy: number, vcfg: { w: number; h: number; scale: number }) {
    if (!locTarget || !locViz) return;
    const guess = screenToDirection(sx, sy, vcfg);
    const [gx, gy, gz] = dirToPosition(guess, 1, 1.6);
    locViz.setGuess({ x: gx, y: gy, z: gz });
    locViz.showSource(true); // reveal the truth so the user sees how close they were
    const err = angularError(locTarget, guess);
    locAttempts.push({ which: locWhich, error: err });
    const degOff = Math.round((err * 180) / Math.PI);
    deps.say(degOff < 25 ? 'Close.' : degOff < 60 ? 'Not bad.' : 'Off.');
    p.textContent = `You were about ${degOff}° off. Next…`;
    const id = setTimeout(() => locNextAttempt(), 1100);
    seqTimers.push(id);
  }

  /** Decide the next probe: alternate A/B until each has enough attempts, then judge. */
  async function locNextAttempt() {
    if (disposed) return;
    const ex = EXERCISES[locExIdx];
    const sc = locStaircaseFor(ex);
    const verdict = decideWinner(locAttempts, ATTEMPTS_PER_CANDIDATE);
    if (verdict && locTrial) {
      sc.answer(verdict, locTrial);
      params[ex.param] = sc.current;
      return locAdvanceExercise();
    }
    // Not decided yet — play whichever candidate has fewer attempts next.
    const na = locAttempts.filter((a) => a.which === 'a').length;
    const nb = locAttempts.filter((a) => a.which === 'b').length;
    locWhich = na <= nb ? 'a' : 'b';
    const warp = withParam(params, ex.param, locWhich === 'a' ? locTrial!.a : locTrial!.b);
    await locEnsureRenderer(warp);
    await locPlayAndAsk();
  }

  /** Move to the next parameter (or finish) — sets up a fresh A/B trial. */
  async function locAdvanceExercise() {
    if (disposed) return;
    // Advance past converged staircases.
    while (locExIdx < EXERCISES.length) {
      const ex = EXERCISES[locExIdx];
      const sc = locStaircaseFor(ex);
      if (sc.done) { params[ex.param] = sc.current; locExIdx++; continue; }
      // Start a new trial for this parameter.
      locTrial = sc.nextTrial();
      locAttempts = [];
      locWhich = 'a';
      const warp = withParam(params, ex.param, locTrial.a);
      await locEnsureRenderer(warp);
      await locPlayAndAsk();
      return;
    }
    // All parameters done.
    teardownLoc();
    deps.save(params);
    deps.say('Localization calibration complete. Your 3D audio is tuned to how you actually hear.');
    deps.alert('Calibration complete.');
    deps.onDone();
  }

  function renderLocalization() {
    controls.innerHTML = '';
    clearTimers();
    teardownAudio();
    teardownFreePlay();
    h.textContent = 'Point to the sound';
    p.textContent =
      'A sound will play somewhere around you. Point to where you heard it by clicking the diagram — front is the bottom of the ring, higher up on screen is farther up/behind. We measure how close you get with two different tunings and keep the one that helps you most. This takes a couple of minutes.';
    const vizWrap = document.createElement('div');
    vizWrap.className = 'hrtf-viz-wrap';
    locViz = mountVisualizer(vizWrap, { onPick: locOnPick });
    controls.append(vizWrap);
    const begin = bigButton('Begin', () => { startNoise(); locExIdx = 0; locStaircases.clear(); void locAdvanceExercise(); }, true);
    const back = bigButton('Back', () => { teardownLoc(); showIntro(); });
    controls.append(begin, back);
    begin.focus();
  }

  // ------------------------------------------------------------------------
  // PCA REFINEMENT — the principled endgame. After the parametric tuning, morph the
  // magnitude response along the axes REAL human ears vary (the CIPIC PCA model), one
  // principal component at a time, via the SAME objective "point to the sound" scoring:
  // two candidate weights per PC, the one that localizes better wins. Weights stay in
  // the real-ear range (±2.5 std-dev) so it only ever morphs between measured humans.
  // ------------------------------------------------------------------------
  let pcaModelLoaded: import('../engine/hrtf/hrtfPca').HrtfPcaModel | null = null;
  let pcaK = 0;
  let pcaIdx = 0;
  const pcaStaircases = new Map<number, Staircase>();

  async function renderPca() {
    controls.innerHTML = '';
    clearTimers();
    teardownAudio(); teardownFreePlay(); teardownLoc();
    h.textContent = 'Refine to real ears';
    p.textContent = 'Loading the real-ear model…';
    const { loadPcaModel } = await import('../engine/hrtf/hrtfPca');
    pcaModelLoaded = await loadPcaModel();
    if (!pcaModelLoaded) {
      p.textContent = 'The real-ear refinement model is unavailable in this build.';
      controls.append(bigButton('Back', () => showIntro()));
      return;
    }
    pcaK = pcaModelLoaded.k;
    p.textContent =
      'Same as before — a sound plays around you and you point to where you heard it. Now we morph your 3D audio along the ways real human ears differ, keeping whatever helps you locate sounds best. A couple of minutes.';
    const vizWrap = document.createElement('div');
    vizWrap.className = 'hrtf-viz-wrap';
    locViz = mountVisualizer(vizWrap, { onPick: pcaOnPick });
    controls.append(vizWrap);
    const begin = bigButton('Begin', () => { startNoise(); pcaIdx = 0; pcaStaircases.clear(); void pcaAdvance(); }, true);
    const back = bigButton('Back', () => { teardownLoc(); showIntro(); });
    controls.append(begin, back);
    begin.focus();
  }

  function pcaStaircaseFor(k: number): Staircase {
    let sc = pcaStaircases.get(k);
    if (!sc) {
      const start = params.pcaWeights?.[k] ?? 0;
      // Coarse→fine over the real-ear weight range (±2.5 std-dev).
      sc = new Staircase({ start, step: 1.2, minStep: 0.3, min: -2.5, max: 2.5, reversals: 2 });
      pcaStaircases.set(k, sc);
    }
    return sc;
  }

  async function pcaAdvance() {
    if (disposed || !pcaModelLoaded) return;
    while (pcaIdx < pcaK) {
      const sc = pcaStaircaseFor(pcaIdx);
      if (sc.done) {
        const w = (params.pcaWeights ?? new Array(pcaK).fill(0)).slice();
        while (w.length < pcaK) w.push(0);
        w[pcaIdx] = sc.current; params.pcaWeights = w;
        pcaIdx++; continue;
      }
      locTrial = sc.nextTrial();
      locAttempts = [];
      locWhich = 'a';
      const warp = withPcaWeight(params, pcaIdx, locTrial.a, pcaK);
      await locEnsureRenderer(warp);
      await locPlayAndAsk();
      return;
    }
    // All PCs done — commit + save.
    teardownLoc();
    deps.save(params);
    deps.say('Refinement complete. Your 3D audio is tuned to how real ears vary.');
    deps.alert('Refinement complete.');
    deps.onDone();
  }

  /** Pointing handler for the PCA stage — scores like localization, but the winner
   *  advances the PCA weight staircase (not a parametric one). */
  function pcaOnPick(sx: number, sy: number, vcfg: { w: number; h: number; scale: number }) {
    if (!locTarget || !locViz) return;
    const guess = screenToDirection(sx, sy, vcfg);
    const [gx, gy, gz] = dirToPosition(guess, 1, 1.6);
    locViz.setGuess({ x: gx, y: gy, z: gz });
    locViz.showSource(true);
    const err = angularError(locTarget, guess);
    locAttempts.push({ which: locWhich, error: err });
    const degOff = Math.round((err * 180) / Math.PI);
    p.textContent = `You were about ${degOff}° off. Next…`;
    const id = setTimeout(() => pcaNextAttempt(), 1000);
    seqTimers.push(id);
  }

  async function pcaNextAttempt() {
    if (disposed || !locTrial) return;
    const sc = pcaStaircaseFor(pcaIdx);
    const verdict = decideWinner(locAttempts, ATTEMPTS_PER_CANDIDATE);
    if (verdict) {
      sc.answer(verdict, locTrial);
      const w = (params.pcaWeights ?? new Array(pcaK).fill(0)).slice();
      while (w.length < pcaK) w.push(0);
      w[pcaIdx] = sc.current; params.pcaWeights = w;
      return pcaAdvance();
    }
    const na = locAttempts.filter((a) => a.which === 'a').length;
    const nb = locAttempts.filter((a) => a.which === 'b').length;
    locWhich = na <= nb ? 'a' : 'b';
    const warp = withPcaWeight(params, pcaIdx, locWhich === 'a' ? locTrial.a : locTrial.b, pcaK);
    await locEnsureRenderer(warp);
    await locPlayAndAsk();
  }

  function showIntro() {
    controls.innerHTML = '';
    h.textContent = 'Personalize your 3D audio';
    p.textContent =
      'Tune 3D audio to your ears. Best first: POINT TO THE SOUND — we play a sound around you, you point where you heard it, and we keep the tuning that makes you most accurate. Or adjust by hand with the KNOBS, or take the GUIDED “which felt better” test. When you’ve tuned the basics, REFINE TO REAL EARS morphs along how human ears actually vary. Nothing saves until you choose to.';
    const localizeBtn = bigButton('Point to the sound (recommended)', () => { startNoise(); renderLocalization(); }, true);
    const knobsBtn = bigButton('Adjust by hand (knobs)', () => { startNoise(); renderFreePlay(); });
    const guided = bigButton('Guided “which felt better” test', () => { startNoise(); renderExercise(); });
    const pcaBtn = bigButton('Refine to real ears (advanced)', () => { startNoise(); void renderPca(); });
    const skipBtn = bigButton('Skip', skip);
    controls.append(localizeBtn, knobsBtn, guided, pcaBtn, skipBtn);
    (controls.querySelector('button') as HTMLElement).focus();
  }

  // Fold free-play + localization teardown into dispose.
  const baseDispose = dispose;
  const disposeAll = () => { teardownFreePlay(); teardownLoc(); if (fpApplyTimer) clearTimeout(fpApplyTimer); baseDispose(); };

  showIntro();
  return disposeAll;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
