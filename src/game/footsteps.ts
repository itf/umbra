/**
 * Footstep / stumble / bump / feet-together sound synthesis, varying by the
 * material underfoot (or the wall you bumped). Feet are barely directional, so we
 * synthesize clean sounds and place them with a light StereoPanner rather than the
 * HRTF convolver. Hybrid: a recorded sample is used if provided, else we synth.
 */
import type { AudioGraph } from '../engine/audioGraph';
import type { HrtfRenderer } from '../engine/hrtf/renderer';
import type { Foot } from './player';
import { soundsFor, type StepSynth } from './stepSounds';

export class Footsteps {
  private graph: AudioGraph;
  private sampleCache = new Map<string, AudioBuffer | null>();

  // renderer kept for API compatibility / future per-foot room coupling.
  constructor(graph: AudioGraph, _renderer: HrtfRenderer) {
    this.graph = graph;
  }

  /** A step on `material`, panned slightly to the stepping foot's side. */
  step(foot: Foot, material: string) {
    const s = soundsFor(material);
    const pan = foot === 'L' ? -0.3 : 0.3;
    if (s.stepSample) this.playSample(s.stepSample, s.step.level, pan);
    else this.play(s.step, pan);
  }

  /** A stumble — material-independent, heavy and central. */
  stumble() {
    this.play(
      { level: 0.7, thumpHz: 80, thumpLevel: 0.85, noiseDur: 0.14, thumpDur: 0.22, lp: 900 },
      0,
    );
  }

  /** Bumping into a wall of `material`. */
  bump(material: string) {
    const s = soundsFor(material);
    if (s.bumpSample) this.playSample(s.bumpSample, s.bump.level, 0);
    else this.play(s.bump, 0);
  }

  /** Very quiet "feet together" cue after settling. */
  feetTogether() {
    this.play(
      { level: 0.18, thumpHz: 150, thumpLevel: 0.12, noiseDur: 0.06, thumpDur: 0.05, lp: 2400, band: true },
      0,
    );
  }

  // ---- procedural synthesis ----
  private play(o: StepSynth, pan: number) {
    const ctx = this.graph.ctx;
    const t = ctx.currentTime;
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    const out = ctx.createGain();
    out.gain.value = o.level;
    panner.connect(out).connect(this.graph.master);

    // Noise transient (the "tap"). For granular surfaces, several short grains.
    const grains = o.crunch ? 2 + Math.round(o.crunch * 4) : 1;
    for (let g = 0; g < grains; g++) {
      const dur = o.noiseDur * (g === 0 ? 1 : 0.5 + Math.random() * 0.5);
      const n = Math.max(1, Math.ceil(dur * ctx.sampleRate));
      const nbuf = ctx.createBuffer(1, n, ctx.sampleRate);
      const ch = nbuf.getChannelData(0);
      for (let i = 0; i < n; i++) ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2.2);
      const noise = ctx.createBufferSource();
      noise.buffer = nbuf;
      const filt = ctx.createBiquadFilter();
      filt.type = o.band ? 'bandpass' : 'lowpass';
      filt.frequency.value = o.lp * (g === 0 ? 1 : 0.6 + Math.random() * 0.8);
      if (o.band) filt.Q.value = 0.7;
      const gg = ctx.createGain();
      gg.gain.value = g === 0 ? 1 : (o.crunch ?? 0) * (0.4 + Math.random() * 0.5);
      noise.connect(filt).connect(gg).connect(panner);
      // Stagger grains slightly so a crunch sounds like scattering pebbles.
      noise.start(t + g * 0.008 * Math.random());
    }

    // Low thump body (weight of the step) — a decaying sine.
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = o.thumpHz;
    const og = ctx.createGain();
    og.gain.setValueAtTime(o.thumpLevel, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + o.thumpDur);
    osc.connect(og).connect(panner);
    osc.start(t);
    osc.stop(t + o.thumpDur + 0.02);
  }

  // ---- recorded-sample playback (loaded + cached on first use) ----
  private playSample(url: string, level: number, pan: number) {
    const cached = this.sampleCache.get(url);
    if (cached === undefined) {
      // Not loaded yet: kick off a fetch and synth-fallback this one time.
      this.sampleCache.set(url, null);
      fetch(url)
        .then((r) => r.arrayBuffer())
        .then((b) => this.graph.ctx.decodeAudioData(b))
        .then((buf) => this.sampleCache.set(url, buf))
        .catch(() => this.sampleCache.set(url, null));
      return;
    }
    if (cached === null) return; // still loading or failed
    const ctx = this.graph.ctx;
    const src = ctx.createBufferSource();
    src.buffer = cached;
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    const out = ctx.createGain();
    out.gain.value = level;
    src.connect(panner).connect(out).connect(this.graph.master);
    src.start();
  }
}
