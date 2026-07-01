/**
 * Landing-page GUIDED DEMO — a dead-simple, self-contained "can I hear direction?"
 * taste of echolocation, right on the homepage. No trainer stack, no HRTF file: it
 * uses the browser's built-in HRTF `PannerNode` so a tone is genuinely placed in 3D.
 *
 * The trial: a soft tone starts in FRONT of you, then glides to the LEFT or RIGHT (a
 * coin-flip). You press "Left" or "Right"; the demo tells you if you were right and
 * offers another. It's the simplest 2AFC — a first "whoa, I can hear space" moment,
 * and a natural nudge toward Play / Train.
 *
 * Everything is announced via the caller's `say` so it works eyes-free. Audio is
 * created lazily on the first user gesture (browsers gate AudioContext on a gesture).
 */

/** The pure logic of one trial: which side the tone ends on. Seeded for testability. */
export type Side = 'left' | 'right';

/** PURE: pick the side from a 0..1 draw (≥0.5 → right). Extracted so it's testable. */
export function sideFromDraw(draw: number): Side {
  return draw >= 0.5 ? 'right' : 'left';
}

/** PURE: verdict text for an answer vs. the truth (spoken + shown). */
export function demoVerdict(answer: Side, truth: Side): { correct: boolean; text: string } {
  const correct = answer === truth;
  return {
    correct,
    text: correct
      ? `Correct — the sound moved to your ${truth}. Your ears just did echolocation's first job: direction.`
      : `Not quite — it moved to your ${truth}. Try another; headphones help a lot.`,
  };
}

interface DemoDeps {
  say: (msg: string) => void;
  /** Random 0..1 draw for the side (injected so tests are deterministic). */
  random?: () => number;
}

/**
 * A live demo controller mounted into `host`. Builds the Left/Right controls + a
 * "Play the sound" button; wires the audio lazily. `dispose()` stops audio + timers.
 */
export class LandingDemo {
  private host: HTMLElement;
  private say: (m: string) => void;
  private random: () => number;
  private ctx: AudioContext | null = null;
  private truth: Side = 'left';
  private answered = false;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private leftBtn!: HTMLButtonElement;
  private rightBtn!: HTMLButtonElement;
  private playBtn!: HTMLButtonElement;
  private feedback!: HTMLElement;

  constructor(host: HTMLElement, deps: DemoDeps) {
    this.host = host;
    this.say = deps.say;
    this.random = deps.random ?? (() => Math.random());
    this.build();
  }

  private build() {
    const doc = this.host.ownerDocument;
    this.host.innerHTML = '';
    const wrap = doc.createElement('div');
    wrap.className = 'landing-demo';

    const prompt = doc.createElement('p');
    prompt.className = 'landing-demo-prompt';
    prompt.textContent = 'Quick demo: press Play, then say which side the sound moved to.';
    wrap.appendChild(prompt);

    this.playBtn = doc.createElement('button');
    this.playBtn.type = 'button';
    this.playBtn.className = 'primary landing-demo-play';
    this.playBtn.textContent = '▶ Play the sound';
    this.playBtn.setAttribute('aria-label', 'Play the demo sound — it starts in front, then moves to one side');
    this.playBtn.addEventListener('click', () => void this.playTrial());
    wrap.appendChild(this.playBtn);

    const answers = doc.createElement('div');
    answers.className = 'landing-demo-answers';
    answers.setAttribute('role', 'group');
    answers.setAttribute('aria-label', 'Which side did the sound move to?');
    this.leftBtn = this.answerButton(doc, 'left', '◀ Left');
    this.rightBtn = this.answerButton(doc, 'right', 'Right ▶');
    answers.append(this.leftBtn, this.rightBtn);
    wrap.appendChild(answers);

    this.feedback = doc.createElement('p');
    this.feedback.className = 'landing-demo-feedback';
    this.feedback.setAttribute('aria-live', 'polite');
    wrap.appendChild(this.feedback);

    this.setAnswersEnabled(false); // enabled once a sound has played
    this.host.appendChild(wrap);
  }

  private answerButton(doc: Document, side: Side, label: string): HTMLButtonElement {
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = 'secondary landing-demo-answer';
    b.textContent = label;
    b.setAttribute('aria-label', `Answer: it moved to my ${side}`);
    b.addEventListener('click', () => this.answer(side));
    return b;
  }

  private setAnswersEnabled(on: boolean) {
    this.leftBtn.disabled = !on;
    this.rightBtn.disabled = !on;
  }

  /** Play one trial: tone in front → glide to a random side. */
  private async playTrial() {
    this.answered = false;
    this.feedback.textContent = '';
    this.truth = sideFromDraw(this.random());
    const ctx = this.ensureCtx();
    if (ctx.state === 'suspended') await ctx.resume();
    const t0 = ctx.currentTime;

    // A soft sine through an HRTF panner. Start in FRONT (z = -1, ahead of the
    // listener), then glide the panner to the chosen side over ~1.5 s.
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 440;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(0.25, t0 + 0.05); // gentle fade-in (no click)
    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'linear';
    // Start ahead of the listener.
    this.setPan(panner, 0, -1, t0);
    // Hold in front briefly, then glide to the side so the MOVEMENT is the cue.
    const endX = this.truth === 'right' ? 1.4 : -1.4;
    this.setPan(panner, 0, -1, t0 + 0.5);
    this.setPan(panner, endX, -0.2, t0 + 2.0);
    const dur = 2.3;
    gain.gain.setValueAtTime(0.25, t0 + dur - 0.1);
    gain.gain.linearRampToValueAtTime(0, t0 + dur); // fade-out
    osc.connect(gain).connect(panner).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);

    this.say('Listen — the sound starts in front, then moves. Which side did it go to? Left or right?');
    this.setAnswersEnabled(true);
    this.leftBtn.focus();
  }

  /** Ramp the panner position (x = right+, z = forward is -). */
  private setPan(p: PannerNode, x: number, z: number, when: number) {
    // positionX/Y/Z are AudioParams in modern browsers; fall back to setPosition.
    if (p.positionX) {
      p.positionX.linearRampToValueAtTime(x, when);
      p.positionZ.linearRampToValueAtTime(z, when);
    } else {
      (p as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(x, 0, z);
    }
  }

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      const Ctor = (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
      this.ctx = new Ctor();
    }
    return this.ctx;
  }

  private answer(side: Side) {
    if (this.answered) return;
    this.answered = true;
    this.setAnswersEnabled(false);
    const { text } = demoVerdict(side, this.truth);
    this.feedback.textContent = text;
    this.say(`${text} Press Play the sound for another, or choose Play or Train above.`);
    this.playBtn.textContent = '▶ Play again';
    this.playBtn.focus();
  }

  dispose() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    try { void this.ctx?.close(); } catch { /* already closed */ }
    this.ctx = null;
  }
}
