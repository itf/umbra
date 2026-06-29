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

    // Slow "breathing" amplitude pulse (~0.7 Hz) so the drone heaves like something
    // alive — and makes onset/offset obvious as it moves.
    const breath = ctx.createOscillator();
    breath.type = 'sine';
    breath.frequency.value = 0.7;
    const breathGain = ctx.createGain();
    breathGain.gain.value = 0.35; // modulation depth around the 0.65 floor below
    this.out.gain.value = 0.65;
    breath.connect(breathGain).connect(this.out.gain);
    breath.start();
    this.oscillators.push(breath);
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
