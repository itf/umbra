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

    // A MUSIC-BOX beacon through an HRTF panner: a little run of plucked CHIME notes,
    // each a struck bell (fast attack, long ringing exponential decay, bright bell
    // partials) — the delicate, sparkling music-box sound, and easy to localize thanks
    // to its bright transient onsets. All notes share ONE panner that starts in FRONT,
    // holds, then glides to the chosen side, so the MOVEMENT is the cue.
    const dur = 4.2;
    const master = ctx.createGain();
    master.gain.value = 0.7; // comfortable overall level (per-note envelopes stay < 1)

    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'linear';
    this.setPan(panner, 0, -1, t0);
    this.setPan(panner, 0, -1, t0 + 1.0);
    const endX = this.truth === 'right' ? 1.4 : -1.4;
    this.setPan(panner, endX, -0.2, t0 + dur - 0.6);
    master.connect(panner).connect(ctx.destination);

    // A gentle ascending music-box motif (C5-E5-G5-C6-G5), one note every ~0.7 s so the
    // run spans the whole glide. Semitone ratios from a C5 base.
    const C5 = 523.25;
    const semis = [0, 4, 7, 12, 7, 4]; // up an octave arpeggio, then back down a bit
    const spacing = 0.62;
    for (let i = 0; i < semis.length; i++) {
      const when = t0 + 0.15 + i * spacing;
      if (when > t0 + dur - 0.3) break;
      this.pluckChime(ctx, master, C5 * Math.pow(2, semis[i] / 12), when);
    }

    this.say('Listen — the sound starts in front, then moves. Which side did it go to? Left or right?');
    this.setAnswersEnabled(true);
    this.leftBtn.focus();
  }

  /**
   * One struck MUSIC-BOX note into `dest` at time `when`: a set of bell partials (the
   * fundamental plus bright, slightly-inharmonic overtones a music box / celesta has),
   * each with a fast attack and a long exponential ring-down. Higher partials decay
   * faster than the fundamental (like a real struck tine), giving the bright "ting" that
   * mellows into a pure tone.
   */
  private pluckChime(ctx: AudioContext, dest: AudioNode, freq: number, when: number) {
    // ratio, level, decay(s) — mild inharmonicity for the metallic music-box shimmer.
    const partials: Array<[number, number, number]> = [
      [1, 0.5, 2.2],
      [2.01, 0.3, 1.3],
      [3.02, 0.16, 0.8],
      [4.05, 0.09, 0.5],
    ];
    for (const [ratio, level, decay] of partials) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = freq * ratio;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(level, when + 0.006); // near-instant strike
      g.gain.exponentialRampToValueAtTime(0.0005, when + decay); // long ring-out
      o.connect(g).connect(dest);
      o.start(when);
      o.stop(when + decay + 0.05);
    }
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
