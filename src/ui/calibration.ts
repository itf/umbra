/**
 * Calibration screen — the eyes-free headphone / left-right / volume check.
 *
 * Glue between the PURE `CalibrationMachine` (which step, swap outcome) and the
 * real audio engine: it plays a positioned tone hard-LEFT then hard-RIGHT using
 * an `HrtfSource` (placed at the listener's −x / +x — engine convention is +x =
 * right, −z = front, see docs/TECHNICAL.md), asks which side the player heard,
 * derives whether the headphones are reversed, offers a session "swap L/R"
 * toggle (inverts the master output channels), and a volume check.
 *
 * Audio playback + the DOM here are integration / ear-verified; the decision
 * logic is unit-tested in tests/onboarding.test.ts via CalibrationMachine.
 */
import { startAudio, type AudioGraph } from '../engine/audioGraph';
import { HrtfRenderer, type HrtfSource } from '../engine/hrtf/renderer';
import { CalibrationMachine, type Side } from './calibrationMachine';
import type { OnboardingStore } from './onboardingStore';
import { mountLoudnessEq } from './loudnessEqUi';
import type { EqBand } from './loudnessEq';
import { mountHrtfTuning, baseHrtfById, type LocResumeBlob } from './hrtfTuning';
import { mountHeadphoneCompLocalizeAb } from './headphoneCalibration';
import type { HrtfPersonalization } from '../engine/hrtf/personalize';
import { defaultCompStrengthFor, type HeadphoneType } from './settingsStore';
import { assetUrl } from '../engine/baseUrl';
import type { CalStep } from './router';

const HRTF_URL = assetUrl('assets/hrtf/sadie_h3.hrtf');

export interface CalibrationDeps {
  store: OnboardingStore;
  say: (msg: string) => void;
  alert: (msg: string) => void;
  /**
   * Apply (or remove) the session L/R channel swap on the shared AudioGraph. The
   * host owns the single swap node so calibration and the real game agree.
   */
  applySwap: (graph: AudioGraph, want: boolean) => void;
  /** Called when calibration finishes (done or skipped). */
  onDone: () => void;
  /**
   * Move to a calibration step via the ROUTER (each step has its own URL, so refresh
   * restores it and Back walks the flow). Every internal transition calls this instead
   * of rendering the next step directly; the router then calls back into `goToStep`.
   */
  navigate: (step: CalStep) => void;
  /**
   * Persist the per-user loudness-EQ correction curve produced by the equal-loudness
   * step. When omitted, the loudness step is skipped entirely (e.g. older callers).
   */
  saveLoudnessEq?: (curve: EqBand[]) => void;
  /**
   * Persist + load the parametric HRTF personalization produced by the OPTIONAL
   * "personalize 3D audio" step. When omitted, that step is skipped entirely.
   */
  saveHrtfPersonalization?: (p: HrtfPersonalization) => void;
  loadHrtfPersonalization?: () => HrtfPersonalization;
  /** Base measured-HRTF URL the personalization step warps (SADIE by default). */
  hrtfUrl?: string;
  /** Currently-chosen base HRTF id + a saver, so the personalization step can offer
   *  the "which measured head" picker. */
  loadHrtfBase?: () => string;
  saveHrtfBase?: (id: string) => void;
  /**
   * BASIC over-ear vs in-ear question — persist + LIVE-apply the headphone type and its
   * default comp strength (over-ear ⇒ a gentle default; in-ear ⇒ 0). When omitted, the
   * question is skipped. This is the everyday path; the advanced A/B fine-tune lives in
   * Settings.
   */
  saveHeadphoneComp?: (type: HeadphoneType, strength: number) => void;
  /**
   * The OBJECTIVE comp A/B step (/calibrate/compcheck): read the declared headphone type
   * (to gate — over-ear only) and persist JUST the chosen comp strength (0 = off, or the
   * active over-ear default) it decides by pointing error. When either is omitted, the
   * step is skipped. Distinct from `saveHeadphoneComp`, which also sets the TYPE.
   */
  loadHeadphoneType?: () => HeadphoneType | null;
  saveOverEarCompStrength?: (strength: number) => void;
  /** RESUME hooks for the interleaved calibration loop — the host owns storage + the
   *  schema-signature guard (loadResume returns null on a mismatched/absent snapshot). */
  saveResume?: (blob: LocResumeBlob) => void;
  loadResume?: () => LocResumeBlob | null;
  clearResume?: () => void;
}

export function mountCalibration(root: HTMLElement, deps: CalibrationDeps) {
  const machine = new CalibrationMachine({ swap: deps.store.swap() });
  let graph: AudioGraph | null = null;
  let renderer: HrtfRenderer | null = null;
  let probe: HrtfSource | null = null;

  root.innerHTML = '';
  const h = document.createElement('h1');
  h.textContent = 'Calibration';
  const p = document.createElement('p');
  p.id = 'cal-instruction';
  p.textContent =
    'Optional audio calibration. Put your headphones on and we will check they are on the right ears, set a comfortable volume, and optionally tune the 3D sound to your ears. Or skip — you can run it anytime from Settings.';
  const controls = document.createElement('div');
  controls.className = 'cal-controls';
  root.append(h, p, controls);

  function focusFirst() {
    (controls.querySelector('button') as HTMLElement | null)?.focus();
  }

  function clearControls() {
    controls.innerHTML = '';
  }

  function bigButton(label: string, onClick: () => void, primary = false): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = label;
    b.className = primary ? 'primary' : 'secondary';
    b.addEventListener('click', onClick);
    return b;
  }

  /** Apply the current swap state via the host-owned swap node. */
  function applySwap(g: AudioGraph) {
    deps.applySwap(g, machine.swapped);
  }

  /** Play a 600 ms tone positioned hard on `side` (left = −x, right = +x). */
  function playSide(side: Side) {
    if (!graph || !renderer) return;
    if (!probe) {
      probe = renderer.createSource();
      probe.output.connect(graph.master);
    }
    renderer.setListener({ x: 0, y: 1.6, z: 0, yaw: 0 });
    const x = side === 'left' ? -3 : 3; // listener-relative: −x left, +x right
    probe.setPosition(x, 1.6, 0);
    const ctx = graph.ctx;
    // Band-limited NOISE (not a pure 440 Hz sine) — warmer, easier to place, and kept
    // at a comfortable level (peak ~0.3, was 0.5). A bandpass gives it a clear pitch
    // centre without the harsh whistle of a sine.
    const n = Math.max(1, Math.floor(ctx.sampleRate * 0.75));
    const nbuf = ctx.createBuffer(1, n, ctx.sampleRate);
    const nd = nbuf.getChannelData(0);
    for (let i = 0; i < n; i++) nd[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = nbuf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 550;
    bp.Q.value = 3;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.3, t + 0.03);
    g.gain.setValueAtTime(0.3, t + 0.55);
    g.gain.linearRampToValueAtTime(0, t + 0.6);
    src.connect(bp);
    bp.connect(g);
    g.connect(probe.input);
    src.start(t);
    src.stop(t + 0.65);
  }

  /** The intro screen (/calibrate): skip, or start the check. */
  function renderIntro() {
    clearControls();
    // First-run framing: the DEFAULT is good enough for most people, so make skipping
    // the easy, primary choice and present calibration as an optional extra. Either
    // way it's always available later from Settings.
    p.textContent =
      'The default audio works well for most people — you can just start playing. If you like, you can calibrate: check your headphones, set a comfortable volume, and tune the 3D sound to your ears. You can always calibrate later from Settings.';
    deps.say(
      'The default audio works well for most people. You can start playing now, or calibrate it to your ears first. You can always calibrate later from Settings.',
    );
    const skip = bigButton('Use the default — start playing', skip_, true);
    const start = bigButton('Calibrate first (optional)', onStart, false);
    controls.append(skip, start);
    focusFirst();
  }

  /** The L/R + volume check (/calibrate/orientation), driven by the machine's step.
   *  These micro-steps (left → right → volume) share one URL — the individual answers
   *  can't survive a reload anyway (they must actually be heard), so a cold load replays
   *  the check from the start. */
  function renderOrientation() {
    clearControls();
    const step = machine.current;
    if (step === 'left') {
      deps.say('Listen. A tone will play on your LEFT. Where did you hear it?');
      playSide('left');
      const left = bigButton('I heard it on the LEFT (correct)', () => answer('left'), true);
      const right = bigButton('It was on the RIGHT (swapped)', () => answer('right'));
      const replay = bigButton('Play it again', () => playSide('left'));
      controls.append(left, right, replay);
    } else if (step === 'right') {
      deps.say('Now a tone on your RIGHT. Where did you hear it?');
      playSide('right');
      const right = bigButton('I heard it on the RIGHT (correct)', () => answer('right'), true);
      const left = bigButton('It was on the LEFT (swapped)', () => answer('left'));
      const replay = bigButton('Play it again', () => playSide('right'));
      controls.append(right, left, replay);
    } else if (step === 'volume') {
      reportOrientation();
      deps.say(
        'Volume check. A steady tone is playing. Adjust your device volume so it is clear but comfortable, then continue.',
      );
      playVolumeTone();
      const cont = bigButton('Volume is good — continue', onVolumeOk, true);
      const replay = bigButton('Play the tone again', playVolumeTone);
      controls.append(cont, replay);
    } else {
      // Machine says done (or, on a cold load, still 'intro') — (re)start the check.
      machine.reset();
      machine.begin();
      renderOrientation();
      return;
    }
    focusFirst();
  }

  let volOsc: OscillatorNode | null = null;
  let volGain: GainNode | null = null;
  function playVolumeTone() {
    if (!graph) return;
    stopVolumeTone();
    const ctx = graph.ctx;
    volOsc = ctx.createOscillator();
    volGain = ctx.createGain();
    volOsc.type = 'sine';
    volOsc.frequency.value = 330;
    volGain.gain.value = 0.25;
    volOsc.connect(volGain);
    volGain.connect(graph.master);
    volOsc.start();
    volOsc.stop(ctx.currentTime + 2.5);
  }
  function stopVolumeTone() {
    try { volOsc?.stop(); } catch { /* already stopped */ }
    volOsc = null;
    volGain = null;
  }

  function reportOrientation() {
    if (machine.swapSuggested()) {
      deps.alert(
        'Your headphones appear to be on the wrong ears — the sides were reversed. Either swap them physically, or turn on Swap left and right below.',
      );
      // Offer the swap toggle once we know it's reversed.
      machine.setSwap(true);
      if (graph) applySwap(graph);
      deps.store.setSwap(true);
    } else if (machine.orientationCorrect()) {
      deps.alert('Headphone orientation is correct.');
    } else {
      deps.alert('Orientation noted.');
    }
    addSwapToggle();
  }

  function addSwapToggle() {
    const toggle = document.createElement('button');
    toggle.className = 'secondary';
    const sync = () => {
      toggle.setAttribute('aria-pressed', String(machine.swapped));
      toggle.textContent = machine.swapped ? 'Swap left/right: ON' : 'Swap left/right: OFF';
    };
    sync();
    toggle.addEventListener('click', () => {
      machine.toggleSwap();
      if (graph) applySwap(graph);
      deps.store.setSwap(machine.swapped);
      sync();
      deps.say(machine.swapped ? 'Left and right swapped.' : 'Swap turned off.');
    });
    controls.append(toggle);
  }

  /** Ensure a live audio graph + renderer, starting them on this (gesture) call if needed.
   *  Returns true on success. Browsers only allow audio to start from a user gesture, so
   *  every cold-loaded step routes through a button that calls this. */
  async function ensureAudio(): Promise<boolean> {
    if (graph) return true;
    deps.say('Loading sound…');
    try {
      graph = await startAudio();
      renderer = await HrtfRenderer.create(graph.ctx, HRTF_URL);
      applySwap(graph);
      return true;
    } catch (err) {
      deps.alert('Could not start audio: ' + (err as Error).message);
      return false;
    }
  }

  async function onStart() {
    if (!(await ensureAudio())) return;
    machine.reset();
    machine.begin();
    deps.navigate('orientation');
  }

  function answer(heard: Side) {
    machine.answer(heard);
    renderOrientation();
  }

  function onVolumeOk() {
    stopVolumeTone();
    machine.confirmVolume();
    // Orientation check done → persist the swap and move to the headphone-type question
    // (or straight past it when that saver isn't wired).
    deps.store.setSwap(machine.swapped);
    cleanupProbe();
    deps.navigate(deps.saveHeadphoneComp ? 'headphones' : 'tune');
  }

  // Tear down the L/R probe source so it doesn't linger on the shared master graph
  // (replaying calibration from the picker would otherwise pile up idle HRTF nodes).
  function cleanupProbe() {
    probe?.disconnect();
    probe = null;
  }

  function skip_() {
    stopVolumeTone();
    cleanupProbe();
    deps.store.setCalibrationDone();
    deps.say('Calibration skipped.');
    deps.onDone();
  }

  /**
   * The everyday "over-ear or in-ear?" question. Over-ear applies a gentle default
   * compensation (our HRTF is measured in-ear and double-filters on over-ear cups);
   * in-ear applies nothing. A REAL prompt — nothing is enabled until the user picks.
   */
  function askHeadphoneType() {
    clearControls();
    p.textContent =
      'One more thing: what are you wearing? Over-ear headphones colour the sound differently from in-ear buds, so we can adjust for it. (Compensation data: ARI HpIR database, Acoustics Research Institute, Vienna.)';
    deps.say('Are you wearing over-ear headphones, or in-ear earbuds?');
    const overEar = bigButton('Over-ear headphones (cups over the ears)', () => {
      deps.saveHeadphoneComp?.('overear', defaultCompStrengthFor('overear'));
      deps.say('Adjusting for over-ear headphones. You can fine-tune this in Settings.');
      afterHeadphoneType();
    }, true);
    const inEar = bigButton('In-ear / earbuds (tips in your ears)', () => {
      deps.saveHeadphoneComp?.('iem', 0);
      deps.say('No adjustment needed for in-ear.');
      afterHeadphoneType();
    });
    controls.append(overEar, inEar);
    focusFirst();
  }

  /** Continue past the headphone-type question into the optional tuning steps. */
  function afterHeadphoneType() {
    if (deps.saveLoudnessEq || deps.saveHrtfPersonalization) {
      deps.navigate('tune');
      return;
    }
    done();
  }

  // --- Sub-mounts (HRTF tuning component + loudness EQ). Each owns its own audio graph
  // and returns a dispose/stop we must call before mounting another or leaving. ---
  let tuningDispose: (() => void) | null = null;
  let loudnessDispose: (() => void) | null = null;
  let compCheckDispose: (() => void) | null = null;
  function disposeSubMounts() {
    tuningDispose?.(); tuningDispose = null;
    loudnessDispose?.(); loudnessDispose = null;
    compCheckDispose?.(); compCheckDispose = null;
  }

  /**
   * The 3D-audio tuning component (/calibrate/tune[/…]). `initial` selects which tool to
   * open (the chooser at 'tune', or a specific tool). Its tool switches + Back go through
   * the router via `navigate`, so each tool has its own URL. On Skip/finish it moves on to
   * loudness (if available) or completes.
   */
  function mountTuning(initial: 'intro' | 'localize' | 'knobs' | 'guided' | 'pca') {
    disposeSubMounts();
    root.innerHTML = ''; // the tuning component builds its own h/p/controls into root
    tuningDispose = mountHrtfTuning(root, {
      ctx: graph!.ctx,
      dest: graph!.master,
      hrtfUrl: deps.hrtfUrl ?? HRTF_URL,
      say: deps.say,
      alert: deps.alert,
      save: (p) => deps.saveHrtfPersonalization?.(p),
      start: deps.loadHrtfPersonalization?.(),
      baseHrtfId: deps.loadHrtfBase?.(),
      saveBaseHrtf: deps.saveHrtfBase,
      initial,
      navigate: (step) => deps.navigate(step),
      onDone: afterTuning,
      saveResume: deps.saveResume,
      loadResume: deps.loadResume,
      clearResume: deps.clearResume,
    });
  }

  /** After the 3D-audio component finishes/skips: run the objective comp A/B (over-ear
   *  only, if offered), then loudness, else done. compcheck itself no-ops+continues for
   *  non-over-ear, so routing here unconditionally is fine when the savers are present. */
  function afterTuning() {
    if (deps.saveOverEarCompStrength && deps.loadHeadphoneType && deps.loadHeadphoneType() === 'overear') {
      deps.navigate('compcheck');
    } else if (deps.saveLoudnessEq) {
      deps.navigate('loudness');
    } else {
      done();
    }
  }

  /** After the comp A/B finishes/skips: go to loudness if offered, else done. */
  function afterCompCheck() {
    if (deps.saveLoudnessEq) deps.navigate('loudness');
    else done();
  }

  /** The objective headphone-comp ON/OFF A/B (/calibrate/compcheck). Renders the probe
   *  through the chosen base head; keeps comp only if it measurably improves pointing. */
  function mountCompCheck() {
    disposeSubMounts();
    root.innerHTML = '';
    const baseUrl = deps.loadHrtfBase ? baseHrtfById(deps.loadHrtfBase()).url : (deps.hrtfUrl ?? HRTF_URL);
    compCheckDispose = mountHeadphoneCompLocalizeAb(root, {
      ctx: graph!.ctx,
      dest: graph!.master,
      hrtfUrl: baseUrl,
      say: deps.say,
      alert: deps.alert,
      headphoneType: deps.loadHeadphoneType?.() ?? null,
      save: (strength) => deps.saveOverEarCompStrength?.(strength),
      onDone: afterCompCheck,
    });
  }

  /** The equal-loudness step (/calibrate/loudness). On finish, calibration completes. */
  function mountLoudness() {
    disposeSubMounts();
    root.innerHTML = '';
    loudnessDispose = mountLoudnessEq(root, {
      ctx: graph!.ctx,
      dest: graph!.master,
      say: deps.say,
      alert: deps.alert,
      saveCurve: deps.saveLoudnessEq!,
      onDone: done,
    });
  }

  function done() {
    disposeSubMounts();
    cleanupProbe();
    deps.store.setCalibrationDone();
    deps.alert('Calibration complete.');
    deps.onDone();
  }

  // Restore the base calibration shell (h/p/controls) into root — the sub-mounts replace
  // root's contents, so a calibration-owned step must rebuild it before rendering.
  function restoreShell() {
    disposeSubMounts();
    if (!root.contains(controls)) {
      root.innerHTML = '';
      root.append(h, p, controls);
    }
  }

  /** A cold-loaded step that needs audio: browsers require a user gesture to start it, so
   *  render a single "Play / continue" button that arms audio then re-renders the step. */
  function renderColdArm(step: CalStep) {
    restoreShell();
    clearControls();
    h.textContent = 'Calibration';
    p.textContent = 'Press play to continue your calibration — this restarts the sound for this step.';
    deps.say('Press play to continue your calibration.');
    const play = bigButton('Play / continue', async () => {
      if (await ensureAudio()) goToStep(step);
    }, true);
    controls.append(play);
    focusFirst();
  }

  /**
   * Central router-driven renderer: show the given step. Called by the host's router on
   * navigation, reload (deep-link), and Back/Forward. Steps that need audio show the
   * cold-arm gesture button when the graph isn't live yet (e.g. after a refresh).
   */
  const NEEDS_AUDIO: Record<CalStep, boolean> = {
    intro: false, orientation: true, headphones: false, tune: true,
    localize: true, knobs: true, guided: true, pca: true, compcheck: true, loudness: true,
  };
  function goToStep(step: CalStep) {
    h.textContent = 'Calibration';
    if (NEEDS_AUDIO[step] && !graph) { renderColdArm(step); return; }
    switch (step) {
      case 'intro': restoreShell(); renderIntro(); break;
      case 'orientation':
        restoreShell();
        // Cold entry (machine still at intro/done) restarts the check from the top.
        if (machine.current === 'intro' || machine.current === 'done') { machine.reset(); machine.begin(); }
        renderOrientation();
        break;
      case 'headphones': restoreShell(); askHeadphoneType(); break;
      case 'tune': mountTuning('intro'); break;
      case 'localize': mountTuning('localize'); break;
      case 'knobs': mountTuning('knobs'); break;
      case 'guided': mountTuning('guided'); break;
      case 'pca': mountTuning('pca'); break;
      case 'compcheck':
        if (deps.saveOverEarCompStrength && deps.loadHeadphoneType) mountCompCheck();
        else afterCompCheck();
        break;
      case 'loudness':
        if (deps.saveLoudnessEq) mountLoudness();
        else done();
        break;
    }
  }

  /** Tear everything down (audio graph, sub-mounts, probe) — called when the host routes
   *  away from calibration, so no worklets/rAF loops leak. */
  function dispose() {
    stopVolumeTone();
    disposeSubMounts();
    cleanupProbe();
  }

  return { goToStep, dispose };
}
