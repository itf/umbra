/**
 * Monster voice — a DISTINCT, continuous looping sound so a monster is locatable
 * by ear (the player evades by listening for where it is). Mirrors the BeaconVoice
 * pattern: a small procedural recipe feeding ONE mono output, which game.ts routes
 * into the monster's HrtfSource so spatialization / propagation delay / Doppler /
 * glide all apply for free. A CHASING monster nearing the player Dopplers up — a
 * great "it's gaining on you" cue.
 *
 * The voice is deliberately low and menacing (a growl/breath drone with slow
 * amplitude pulsing), unmistakable against the beacon's pitched tone. It needs an
 * AudioContext, so it is ear-verified rather than unit-tested (like BeaconVoice).
 */

/** A low growling/breathing drone, distinct from any beacon preset. */
export class MonsterVoice {
  private ctx: BaseAudioContext;
  private out: GainNode;
  private oscillators: OscillatorNode[] = [];
  private running = false;

  constructor(ctx: BaseAudioContext, dest: AudioNode) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 1;
    this.out.connect(dest);
  }

  start() {
    if (this.running) return;
    this.running = true;
    const ctx = this.ctx;

    // Low growl: a couple of detuned saw-ish oscillators an octave apart through a
    // lowpass for a throaty, dark timbre.
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    lp.Q.value = 2;
    lp.connect(this.out);

    const partials: [number, OscillatorType, number, number][] = [
      // freq(Hz), type, gain, detune(cents)
      [62, 'sawtooth', 0.5, -7],
      [62, 'square', 0.28, +9],
      [124, 'triangle', 0.2, 0],
    ];
    for (const [f, type, g, detune] of partials) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = f;
      osc.detune.value = detune;
      const og = ctx.createGain();
      og.gain.value = g;
      osc.connect(og).connect(lp);
      osc.start();
      this.oscillators.push(osc);
    }

    // GRITTY GROWL: a fast amplitude flutter (~22 Hz) gives the drone a rough,
    // throaty "rrrr" rasp instead of a smooth hum — this is what reads as a growl
    // by ear. Layered under a slow ~0.7 Hz "breath" heave so it also sounds alive
    // and its onset/offset are obvious as it moves.
    this.out.gain.value = 0.9; // louder so it's clearly audible while chasing

    const growl = ctx.createOscillator();
    growl.type = 'sawtooth';
    growl.frequency.value = 22; // rasp rate
    const growlDepth = ctx.createGain();
    growlDepth.gain.value = 0.4; // deep modulation = audible grit
    growl.connect(growlDepth).connect(this.out.gain);
    growl.start();
    this.oscillators.push(growl);

    const breath = ctx.createOscillator();
    breath.type = 'sine';
    breath.frequency.value = 0.7;
    const breathGain = ctx.createGain();
    breathGain.gain.value = 0.25;
    breath.connect(breathGain).connect(this.out.gain);
    breath.start();
    this.oscillators.push(breath);
  }

  /**
   * A short, loud CATCH roar — a rising snarl with a noise burst, played once when
   * the monster reaches the player. Route the provided `dest` to the master bus
   * (not the spatialized monster source) so the lunge is heard front-and-centre
   * regardless of where the monster was. Self-contained: builds + tears down its
   * own nodes, so it survives the chase audio fading out around it.
   */
  static roar(ctx: BaseAudioContext, dest: AudioNode) {
    const t = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(1.0, t + 0.04); // fast attack
    out.gain.exponentialRampToValueAtTime(0.0001, t + 0.9); // decay
    out.connect(dest);

    // Rising snarl: a sweep up then down for a lunge.
    const snarl = ctx.createOscillator();
    snarl.type = 'sawtooth';
    snarl.frequency.setValueAtTime(70, t);
    snarl.frequency.exponentialRampToValueAtTime(260, t + 0.18);
    snarl.frequency.exponentialRampToValueAtTime(90, t + 0.7);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1800, t);
    lp.frequency.exponentialRampToValueAtTime(500, t + 0.7);
    lp.Q.value = 3;
    snarl.connect(lp).connect(out);
    snarl.start(t);
    snarl.stop(t + 0.95);

    // Gnashing noise burst layered on top for teeth/impact.
    const dur = 0.5;
    const n = Math.ceil(dur * ctx.sampleRate);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) ch[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    const ng = ctx.createGain();
    ng.gain.value = 0.5;
    const nf = ctx.createBiquadFilter();
    nf.type = 'bandpass';
    nf.frequency.value = 900;
    noise.connect(nf).connect(ng).connect(out);
    noise.start(t);

    // Auto-cleanup after the roar.
    snarl.onended = () => { try { out.disconnect(); } catch { /* noop */ } };
  }

  stop() {
    this.running = false;
    const t = this.ctx.currentTime;
    for (const o of this.oscillators) {
      try { o.stop(t + 0.05); } catch { /* already stopped */ }
    }
    this.oscillators = [];
    try { this.out.disconnect(); } catch { /* noop */ }
  }
}
