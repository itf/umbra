/**
 * Guided tutorial screen — a gentle, spoken, eyes-free first-run that teaches the
 * core spatial cue and the controls one at a time, each behind a practice gate.
 * The ORDER follows the Kish/Thaler echolocation-training progression (seated
 * localization first, only then movement):
 *
 *   1. LOCALIZING — a beacon plays on your LEFT, then RIGHT, then straight AHEAD;
 *      you confirm where you heard it. Teaches the real HRTF cue the game runs on.
 *   2. TURNING    — drag the compass / arrow keys; the soundscape rotates. Turn a
 *      front-right tone until it is straight ahead.
 *   3. STEPPING   — alternate left/right in a steady rhythm (rushing stumbles).
 *   4. CLAPPING   — tap echo to clap and hear the room (echolocation).
 *
 * It is a SCRIPTED sequence (a lightweight practice harness), not the full Game:
 * it owns its own startAudio + HrtfRenderer + a single positioned tone, and a
 * Compass for the turn lesson. The pure lesson ordering / gate / completion logic
 * is the unit-tested `TutorialMachine`; the audio + DOM here are ear-verified.
 */
import { startAudio, type AudioGraph } from '../engine/audioGraph';
import { HrtfRenderer, type HrtfSource } from '../engine/hrtf/renderer';
import { Compass } from '../game/compass';
import { Heading } from '../game/heading';
import { Player } from '../game/player';
import { TutorialMachine, LESSON_GOAL } from './tutorialMachine';
import { renderControlsSpeech } from '../game/controls';
import type { OnboardingStore } from './onboardingStore';

const HRTF_URL = '/assets/hrtf/sadie_h3.hrtf';

export interface TutorialDeps {
  store: OnboardingStore;
  say: (msg: string) => void;
  alert: (msg: string) => void;
  onDone: () => void;
}

export function mountTutorial(root: HTMLElement, deps: TutorialDeps) {
  const machine = new TutorialMachine();
  let graph: AudioGraph | null = null;
  let renderer: HrtfRenderer | null = null;
  let tone: HrtfSource | null = null;
  let toneOsc: OscillatorNode | null = null;

  root.innerHTML = '';
  const h = document.createElement('h1');
  h.textContent = 'Tutorial';
  const body = document.createElement('div');
  body.className = 'tut-body';
  const controls = document.createElement('div');
  controls.className = 'cal-controls';
  root.append(h, body, controls);

  function focusFirst() {
    (controls.querySelector('button') as HTMLElement | null)?.focus();
  }
  function clear() {
    body.innerHTML = '';
    controls.innerHTML = '';
  }
  function btn(label: string, onClick: () => void, primary = false): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = label;
    b.className = primary ? 'primary' : 'secondary';
    b.addEventListener('click', onClick);
    return b;
  }
  function nextButton() {
    const adv = btn('Next', () => { machine.next(); render(); }, true);
    adv.disabled = !machine.gateMet();
    controls.append(adv);
    return adv;
  }
  function skipAll() {
    const s = btn('Skip tutorial', () => {
      machine.skipAll();
      finish(true);
    });
    controls.append(s);
  }

  /** Place the practice tone a little to the player's front-right so turning helps. */
  function startTone() {
    if (!graph || !renderer) return;
    stopTone();
    tone = renderer.createSource();
    tone.output.connect(graph.master);
    renderer.setListener({ x: 0, y: 1.6, z: 0, yaw: 0 });
    tone.setPosition(2, 1.6, -2); // front-right
    toneOsc = graph.ctx.createOscillator();
    const g = graph.ctx.createGain();
    toneOsc.type = 'triangle';
    toneOsc.frequency.value = 440;
    g.gain.value = 0.3;
    toneOsc.connect(g);
    g.connect(tone.input);
    toneOsc.start();
  }
  function stopTone() {
    try { toneOsc?.stop(); } catch { /* already stopped */ }
    toneOsc = null;
    if (tone) { tone.disconnect(); tone = null; }
  }

  async function onStart() {
    deps.say('Loading sound…');
    try {
      graph = await startAudio();
      renderer = await HrtfRenderer.create(graph.ctx, HRTF_URL);
      render();
    } catch (err) {
      deps.alert('Could not start audio: ' + (err as Error).message);
    }
  }

  function intro() {
    deps.say(
      'A short tutorial. First you learn to hear where a sound is — left, right, or ahead — ' +
      'then turning, walking, and clapping. ' +
      renderControlsSpeech() +
      ' Press Start to enable sound.',
    );
    controls.append(btn('Start (enable sound)', onStart, true), btn('Skip tutorial', () => { machine.skipAll(); finish(true); }));
    focusFirst();
  }

  // --- Lesson 1: localizing (Kish/Thaler seated start) ----------------------
  // A short beacon plays from a fixed direction; the player confirms which side
  // they heard it on. We walk LEFT → RIGHT → FRONT so the player learns the three
  // anchor directions before any movement. Uses the REAL HRTF beacon path so the
  // cue is exactly what the game uses. Each correct answer satisfies one gate unit.
  type Dir = 'left' | 'right' | 'front';
  const LOCALIZE_DIRS: Dir[] = ['left', 'right', 'front'];
  /** Listener-relative position for a localization direction (engine: +x right, −z front). */
  function dirPosition(dir: Dir): [number, number, number] {
    if (dir === 'left') return [-3, 1.6, 0];
    if (dir === 'right') return [3, 1.6, 0];
    return [0, 1.6, -3]; // front
  }
  /** Play a ~700 ms beacon pulse at `dir` through the real HRTF source. */
  function playLocalizeTone(dir: Dir) {
    if (!graph || !renderer) return;
    stopTone();
    tone = renderer.createSource();
    tone.output.connect(graph.master);
    renderer.setListener({ x: 0, y: 1.6, z: 0, yaw: 0 });
    const [x, y, z] = dirPosition(dir);
    tone.setPosition(x, y, z);
    const ctx = graph.ctx;
    toneOsc = ctx.createOscillator();
    const g = ctx.createGain();
    toneOsc.type = 'triangle';
    toneOsc.frequency.value = 440;
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.35, t + 0.02);
    g.gain.setValueAtTime(0.35, t + 0.65);
    g.gain.linearRampToValueAtTime(0, t + 0.7);
    toneOsc.connect(g);
    g.connect(tone.input);
    toneOsc.start(t);
    toneOsc.stop(t + 0.72);
  }

  function localizing() {
    deps.say(
      'Localizing. A sound will play. Tell me where you hear it — on your LEFT, ' +
      'on your RIGHT, or straight AHEAD. We will do all three.',
    );
    let idx = 0;
    const prompt = document.createElement('p');
    prompt.className = 'tut-localize-prompt';
    body.append(prompt);

    const row = document.createElement('div');
    row.className = 'tut-localize';
    const left = btn('LEFT', () => answer('left'));
    const front = btn('AHEAD', () => answer('front'));
    const right = btn('RIGHT', () => answer('right'));
    const replay = btn('Play it again', () => playLocalizeTone(LOCALIZE_DIRS[idx]));
    row.append(left, front, right, replay);
    body.append(row);

    const adv = nextButton();
    skipAll();

    function present() {
      if (idx >= LOCALIZE_DIRS.length) return;
      prompt.textContent = `Where is the sound? (${idx + 1} of ${LOCALIZE_DIRS.length})`;
      playLocalizeTone(LOCALIZE_DIRS[idx]);
    }
    function answer(heard: Dir) {
      const want = LOCALIZE_DIRS[idx];
      if (heard === want) {
        idx++;
        machine.recordAction();
        adv.disabled = !machine.gateMet();
        if (machine.gateMet()) {
          stopTone();
          deps.alert('You localized all three. Press Next.');
        } else {
          deps.say('Correct. Listen again.');
          present();
        }
      } else {
        deps.alert(`Not quite — listen again. That sound was on your ${want === 'front' ? 'front' : want}.`);
        playLocalizeTone(want);
      }
    }
    present();
    focusFirst();
  }

  // --- Lesson 1: stepping ---------------------------------------------------
  function stepping() {
    deps.say(
      'Stepping. Tap LEFT, then RIGHT, alternating, in a steady rhythm. Rushing makes you stumble. Take a few steps.',
    );
    const row = document.createElement('div');
    row.className = 'tut-steps';
    const left = btn('Step LEFT', () => onStep('L'));
    const right = btn('Step RIGHT', () => onStep('R'));
    left.classList.add('tut-foot');
    right.classList.add('tut-foot');
    row.append(left, right);
    body.append(row);

    const player = new Player({ x: 0, z: 0, yaw: 0 });
    let goodSteps = 0;
    const adv = nextButton();
    skipAll();
    function onStep(foot: 'L' | 'R') {
      const r = player.step(foot, performance.now());
      if (r.outcome.kind === 'step') {
        goodSteps++;
        machine.recordAction();
        deps.say(`Good. ${goodSteps} of ${LESSON_GOAL.stepping} steps.`);
      } else {
        deps.alert(
          r.outcome.reason === 'too-fast' ? 'Too fast — slow your rhythm.' : 'Alternate left and right.',
        );
      }
      adv.disabled = !machine.gateMet();
      if (machine.gateMet()) deps.alert('Nicely done. Press Next.');
    }
    focusFirst();
  }

  // --- Lesson 2: turning ----------------------------------------------------
  function turning() {
    deps.say(
      'Turning. Drag the compass dial to turn — the whole soundscape rotates. A tone is playing to your front-right. Turn until it is straight ahead, then press Next.',
    );
    startTone();
    const heading = new Heading(0);
    const compass = new Compass({
      size: 260,
      onYaw: (yaw) => heading.setTarget(yaw),
      onRelease: () => heading.setTarget(heading.current),
    });
    body.append(compass.el);
    let counted = false;
    const adv = nextButton();
    skipAll();
    let lastT = performance.now();
    let raf = 0;
    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - lastT) / 1000);
      lastT = now;
      if (heading.tick(dt)) {
        compass.setHeading(heading.current);
        if (renderer) renderer.setListener({ x: 0, y: 1.6, z: 0, yaw: heading.current });
        if (tone) tone.setPosition(2, 1.6, -2);
        // Tone is at front-right (~+45°). "Ahead" means the head-local angle to it
        // is near zero. Reward turning roughly toward it.
        const targetYaw = Math.atan2(2, 2); // bearing to (dx=2, dz=-2): atan2(dx, -dz)=+45°
        if (!counted && Math.abs(angleDiff(heading.current, targetYaw)) < 0.35) {
          counted = true;
          machine.recordAction();
          adv.disabled = !machine.gateMet();
          deps.alert('The tone is ahead of you now. Press Next.');
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    cleanup = () => cancelAnimationFrame(raf);
    focusFirst();
  }

  // --- Lesson 3: clapping ---------------------------------------------------
  function clapping() {
    deps.say(
      'Clapping, or echolocation. Tap Echo to clap and hear the room — surfaces echo ' +
      'the clap back so you can sense walls and openings. Try it once.',
    );
    const echo = btn('Echo (clap)', () => {
      // A simple, un-spatialized clap burst so the lesson is self-contained.
      if (graph) {
        const ctx = graph.ctx;
        const src = ctx.createBufferSource();
        const len = Math.floor(ctx.sampleRate * 0.05);
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
        src.buffer = buf;
        const g = ctx.createGain();
        g.gain.value = 0.5;
        src.connect(g);
        g.connect(graph.master);
        src.start();
      }
      machine.recordAction();
      adv.disabled = !machine.gateMet();
      deps.alert('That is a clap. Press Next to finish.');
    });
    echo.classList.add('listen');
    body.append(echo);
    const adv = nextButton();
    skipAll();
    focusFirst();
  }

  let cleanup: (() => void) | null = null;

  function render() {
    if (cleanup) { cleanup(); cleanup = null; }
    // Both the localizing and turning lessons own a live tone; stop it before any
    // other lesson so a probe/source doesn't linger.
    if (machine.lesson !== 'turning' && machine.lesson !== 'localizing') stopTone();
    clear();
    if (!graph) { intro(); return; }
    const lesson = machine.lesson;
    if (lesson === 'localizing') localizing();
    else if (lesson === 'turning') turning();
    else if (lesson === 'stepping') stepping();
    else if (lesson === 'clapping') clapping();
    else finish(false);
  }

  function finish(skipped: boolean) {
    if (cleanup) { cleanup(); cleanup = null; }
    stopTone();
    deps.store.setTutorialDone();
    deps.alert(
      skipped
        ? 'Tutorial skipped.'
        : 'Tutorial complete. ' + renderControlsSpeech() + ' Have fun.',
    );
    deps.onDone();
  }

  render();
}

/** Smallest signed difference a−b wrapped to (−π, π]. */
function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}
