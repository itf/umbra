/**
 * Footstep / stumble / feet-together sound synthesis.
 *
 * Feet are right below you and barely directional, so running them through the
 * full HRTF convolver sounded "funky" (the unnormalized close-range HRIR colors
 * them oddly). Instead we synthesize clean, natural-sounding steps and place them
 * with a light StereoPanner — the left foot slightly left, right foot slightly
 * right. A footstep = a soft broadband transient + a short low thump body; a
 * stumble = a heavier, longer, lower scuff; feet-together = a very quiet shuffle.
 */
import type { AudioGraph } from '../engine/audioGraph';
import type { HrtfRenderer } from '../engine/hrtf/renderer';
import type { Foot } from './player';

export class Footsteps {
  private graph: AudioGraph;

  // renderer kept for API compatibility / future per-foot room coupling.
  constructor(graph: AudioGraph, _renderer: HrtfRenderer) {
    this.graph = graph;
  }

  step(foot: Foot, _listener: { x: number; y: number; z: number; yaw: number }) {
    // Subtle pan: left foot a little left, right foot a little right.
    this.play({ pan: foot === 'L' ? -0.3 : 0.3, level: 0.5, thumpHz: 130, thumpLevel: 0.5, noiseDur: 0.05, thumpDur: 0.1, lp: 1800 });
  }

  stumble(_listener: { x: number; y: number; z: number }) {
    // Heavier, lower, centered, longer — clearly "you tripped".
    this.play({ pan: 0, level: 0.7, thumpHz: 80, thumpLevel: 0.85, noiseDur: 0.14, thumpDur: 0.22, lp: 900 });
  }

  feetTogether(_listener: { x: number; y: number; z: number }) {
    // Very quiet brushy shuffle, centered.
    this.play({ pan: 0, level: 0.18, thumpHz: 150, thumpLevel: 0.12, noiseDur: 0.06, thumpDur: 0.05, lp: 2400, band: true });
  }

  private play(o: {
    pan: number;
    level: number;
    thumpHz: number;
    thumpLevel: number;
    noiseDur: number;
    thumpDur: number;
    lp: number;
    band?: boolean;
  }) {
    const ctx = this.graph.ctx;
    const t = ctx.currentTime;
    const pan = ctx.createStereoPanner();
    pan.pan.value = o.pan;
    const out = ctx.createGain();
    out.gain.value = o.level;
    pan.connect(out).connect(this.graph.master);

    // Noise transient (the "tap" of the foot).
    const n = Math.ceil(o.noiseDur * ctx.sampleRate);
    const nbuf = ctx.createBuffer(1, n, ctx.sampleRate);
    const ch = nbuf.getChannelData(0);
    for (let i = 0; i < n; i++) ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2.2);
    const noise = ctx.createBufferSource();
    noise.buffer = nbuf;
    const filt = ctx.createBiquadFilter();
    if (o.band) {
      filt.type = 'bandpass';
      filt.frequency.value = o.lp;
      filt.Q.value = 0.7;
    } else {
      filt.type = 'lowpass';
      filt.frequency.value = o.lp;
    }
    noise.connect(filt).connect(pan);
    noise.start(t);

    // Low thump body (weight of the step). A decaying sine, no pitch sweep, so it
    // reads as a soft footfall rather than a synthetic blip.
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = o.thumpHz;
    const og = ctx.createGain();
    og.gain.setValueAtTime(o.thumpLevel, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + o.thumpDur);
    osc.connect(og).connect(pan);
    osc.start(t);
    osc.stop(t + o.thumpDur + 0.02);
  }
}
