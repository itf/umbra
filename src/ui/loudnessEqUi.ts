/**
 * Loudness-EQ calibration UI — the spoken, keyboard/screen-reader-operable surface
 * that drives the pure `LoudnessEqSession` and plays the comparison tones. Shared by
 * BOTH the onboarding calibration flow (calibration.ts) and the re-runnable button in
 * the settings panel (settings.ts), so the experience is identical in both places.
 *
 * Every prompt + result is announced via the caller's live-region `say`/`alert`. The
 * three controls are plain buttons ("the second tone is LOUDER", "QUIETER", "they're
 * EQUAL") plus a replay; focus moves to the first control after each render.
 *
 * Pure logic: loudnessEq.ts. Audio: loudnessEqAudio.ts. Persistence: settingsStore.ts.
 */
import {
  LoudnessEqSession,
  REFERENCE_FREQ,
  type EqBand,
  type LoudnessAnswer,
} from './loudnessEq';
import { playLoudnessPair } from './loudnessEqAudio';

export interface LoudnessEqUiDeps {
  /** A LIVE, resumed AudioContext to play tones into. */
  ctx: AudioContext;
  /** The node tones route to (the calibration/master bus). */
  dest: AudioNode;
  say: (msg: string) => void;
  alert: (msg: string) => void;
  /** Persist the finished correction curve. */
  saveCurve: (curve: EqBand[]) => void;
  /** Called when the user finishes or skips. */
  onDone: () => void;
  /** Optional injected RNG (band order); defaults to Math.random in app code. */
  rng?: () => number;
}

/**
 * Render the loudness-EQ calibration into `root` (replacing its contents) and run it
 * to completion. Returns a cleanup that stops any in-flight tone.
 */
export function mountLoudnessEq(root: HTMLElement, deps: LoudnessEqUiDeps): () => void {
  const session = new LoudnessEqSession({ rng: deps.rng });
  let stopTone: (() => void) | null = null;

  root.innerHTML = '';
  const h = document.createElement('h2');
  h.textContent = 'Hearing / loudness calibration';
  const p = document.createElement('p');
  p.textContent =
    'We will play two tones in turn: first a reference, then a test tone. Tell us whether the SECOND tone is louder, quieter, or equal. A few of these per band tunes the sound to your ears and headphones.';
  const controls = document.createElement('div');
  controls.className = 'cal-controls';
  root.append(h, p, controls);

  function stop() {
    try {
      stopTone?.();
    } catch {
      /* already stopped */
    }
    stopTone = null;
  }

  function play(bandFreq: number, gainDb: number) {
    stop();
    stopTone = playLoudnessPair(deps.ctx, deps.dest, REFERENCE_FREQ, bandFreq, gainDb);
  }

  function button(label: string, onClick: () => void, primary = false): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.className = primary ? 'primary' : 'secondary';
    b.addEventListener('click', onClick);
    return b;
  }

  function answer(verdict: LoudnessAnswer) {
    session.answer(verdict);
    render();
  }

  function render() {
    controls.innerHTML = '';
    const q = session.nextQuestion();
    if (!q) {
      finish();
      return;
    }
    play(q.freq, q.testGainDb);
    deps.say(
      `Band ${q.bandIndex + 1} of ${q.totalBands}, ${q.freq} hertz. Reference, then test tone. Is the second tone louder, quieter, or equal?`,
    );
    controls.append(
      button('Second tone is LOUDER', () => answer('band-louder'), true),
      button('Second tone is QUIETER', () => answer('reference-louder')),
      button("They're EQUAL", () => answer('equal')),
      button('Play again', () => play(q.freq, q.testGainDb)),
      button('Skip calibration', skip),
    );
    (controls.querySelector('button') as HTMLElement | null)?.focus();
  }

  function finish() {
    stop();
    const curve = session.curve();
    deps.saveCurve(curve);
    const summary = curve
      .filter((b) => b.freq !== REFERENCE_FREQ && Math.abs(b.gainDb) >= 1)
      .map((b) => `${b.freq} hertz ${b.gainDb >= 0 ? 'up' : 'down'} ${Math.abs(Math.round(b.gainDb))} decibels`)
      .join(', ');
    deps.alert(
      summary
        ? `Loudness calibration complete. Correction applied: ${summary}.`
        : 'Loudness calibration complete. Your hearing is fairly flat — no correction needed.',
    );
    deps.onDone();
  }

  function skip() {
    stop();
    deps.say('Loudness calibration skipped.');
    deps.onDone();
  }

  render();
  return stop;
}
