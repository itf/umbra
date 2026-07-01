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
import { mountHrtfTuning } from './hrtfTuning';
import type { HrtfPersonalization } from '../engine/hrtf/personalize';

const HRTF_URL = '/assets/hrtf/sadie_h3.hrtf';

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
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 440;
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.5, t + 0.02);
    g.gain.setValueAtTime(0.5, t + 0.55);
    g.gain.linearRampToValueAtTime(0, t + 0.6);
    osc.connect(g);
    g.connect(probe.input);
    osc.start(t);
    osc.stop(t + 0.65);
  }

  function render() {
    clearControls();
    const step = machine.current;
    if (step === 'intro') {
      deps.say(
        'Audio calibration is optional but recommended. It checks your headphones, sets a comfortable volume, and can tune the 3D sound to your ears. Start it now, or skip — you can always run it later from Settings.',
      );
      const start = bigButton('Calibrate now (recommended)', onStart, true);
      const skip = bigButton('Skip for now', skip_, false);
      controls.append(start, skip);
    } else if (step === 'left') {
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
      finish();
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

  async function onStart() {
    deps.say('Loading sound…');
    try {
      graph = await startAudio();
      renderer = await HrtfRenderer.create(graph.ctx, HRTF_URL);
      applySwap(graph);
      machine.begin();
      render();
    } catch (err) {
      deps.alert('Could not start audio: ' + (err as Error).message);
    }
  }

  function answer(heard: Side) {
    machine.answer(heard);
    render();
  }

  function onVolumeOk() {
    stopVolumeTone();
    machine.confirmVolume();
    render();
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

  function finish() {
    stopVolumeTone();
    cleanupProbe();
    deps.store.setSwap(machine.swapped);
    // Two OPTIONAL, INDEPENDENT tuning steps follow the headphone check: equal-
    // loudness EQ and HRTF personalization. Rather than force loudness first, offer
    // a chooser so the user can do either, both, or neither. Each is wired only when
    // the host provided its saver + a live graph; if neither is wired, finalize.
    if ((deps.saveLoudnessEq || deps.saveHrtfPersonalization) && graph) {
      chooseTuning();
      return;
    }
    done();
  }

  /** Post-headphone-check menu: pick loudness, HRTF personalization, or finish. */
  function chooseTuning() {
    clearControls();
    p.textContent =
      'Headphone check done. Two optional tune-ups are available — do either, both, or neither. We recommend 3D-audio (where sounds are) first.';
    deps.say(
      'Headphone check done. Two optional steps: 3D-audio personalization, and loudness calibration. We recommend 3D audio first. Choose one, or finish.',
    );
    // 3D-audio personalization FIRST + primary — locating sound is the point of the
    // game, so tune WHERE sounds are before HOW LOUD they are.
    if (deps.saveHrtfPersonalization) {
      controls.append(bigButton('Personalize 3D audio (where sounds are)', runHrtfTuning, true));
    }
    if (deps.saveLoudnessEq) {
      controls.append(bigButton('Loudness / hearing calibration', runLoudnessStep, !deps.saveHrtfPersonalization));
    }
    controls.append(bigButton('Finish — skip both', done));
    focusFirst();
  }

  /** Run the equal-loudness step, then return to the chooser (not straight to HRTF),
   *  so the user stays in control of what runs next. */
  function runLoudnessStep() {
    if (!deps.saveLoudnessEq || !graph) return chooseTuning();
    deps.say('Loudness calibration.');
    mountLoudnessEq(root, {
      ctx: graph.ctx,
      dest: graph.master,
      say: deps.say,
      alert: deps.alert,
      saveCurve: deps.saveLoudnessEq,
      onDone: backToChooserOrDone,
    });
  }

  /** After a step finishes: if the other step exists, return to the chooser;
   *  otherwise finalize. Keeps a single-step config from looping the menu. */
  function backToChooserOrDone() {
    if (deps.saveLoudnessEq && deps.saveHrtfPersonalization) {
      chooseTuning();
    } else {
      done();
    }
  }

  /**
   * OPTIONAL parametric HRTF personalization — reachable from the chooser without
   * touching loudness. Only wired when the host provided a saver + a live graph;
   * on finish it returns to the chooser (so the user can still do loudness) or
   * finalizes when it's the only tuning step.
   */
  function runHrtfTuning() {
    if (deps.saveHrtfPersonalization && graph) {
      mountHrtfTuning(root, {
        ctx: graph.ctx,
        dest: graph.master,
        hrtfUrl: deps.hrtfUrl ?? HRTF_URL,
        say: deps.say,
        alert: deps.alert,
        save: deps.saveHrtfPersonalization,
        start: deps.loadHrtfPersonalization?.(),
        baseHrtfId: deps.loadHrtfBase?.(),
        saveBaseHrtf: deps.saveHrtfBase,
        onDone: backToChooserOrDone,
      });
      return;
    }
    done();
  }

  function done() {
    deps.store.setCalibrationDone();
    deps.alert('Calibration complete.');
    deps.onDone();
  }

  render();
}
