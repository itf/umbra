/**
 * Guided tutorial screen — a gentle, spoken, eyes-free first-run that teaches the
 * three controls one at a time, each behind a practice gate:
 *
 *   1. STEPPING — alternate left/right in a steady rhythm (rushing stumbles).
 *   2. TURNING  — drag the compass; the soundscape rotates. Turn toward a tone.
 *   3. CLAPPING — tap echo to clap and hear the room.
 *
 * It is a SCRIPTED sequence (a lightweight practice harness), not the full Game:
 * it owns its own startAudio + HrtfRenderer + a single positioned tone, and a
 * Compass for the turn lesson. The pure step ordering / gate / completion logic
 * is the unit-tested `TutorialMachine`; the audio + DOM here are ear-verified.
 */
import { startAudio, type AudioGraph } from '../engine/audioGraph';
import { HrtfRenderer, type HrtfSource } from '../engine/hrtf/renderer';
import { Compass } from '../game/compass';
import { Heading } from '../game/heading';
import { Player } from '../game/player';
import { TutorialMachine, LESSON_GOAL } from './tutorialMachine';
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
    deps.say('A short tutorial teaches the three controls. Press Start to enable sound.');
    controls.append(btn('Start (enable sound)', onStart, true), btn('Skip tutorial', () => { machine.skipAll(); finish(true); }));
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
    deps.say('Clapping. Tap Echo to clap and hear the room around you. Try it once.');
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
    if (machine.lesson !== 'turning') stopTone();
    clear();
    if (!graph) { intro(); return; }
    const lesson = machine.lesson;
    if (lesson === 'stepping') stepping();
    else if (lesson === 'turning') turning();
    else if (lesson === 'clapping') clapping();
    else finish(false);
  }

  function finish(skipped: boolean) {
    if (cleanup) { cleanup(); cleanup = null; }
    stopTone();
    deps.store.setTutorialDone();
    deps.alert(skipped ? 'Tutorial skipped.' : 'Tutorial complete. Have fun.');
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
