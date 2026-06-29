/**
 * Beacon sound presets — named synthesis recipes for the navigation beacon.
 *
 * Mirrors the hybrid model of `stepSounds.ts`: each preset is a small procedural
 * recipe built on Web Audio nodes, feeding ONE mono output. The game routes that
 * mono output into the existing `HrtfSource` so spatialization / Doppler /
 * propagation are completely unchanged — the preset only shapes the dry signal.
 *
 * A beacon may instead point at a custom audio file (`soundUrl`); that path is
 * handled by the game (fetch + cache + loop), falling back to the chosen synth
 * preset if the fetch fails.
 *
 * The PURE recipe logic (preset tables, partial/pitch math, melody data) lives
 * here and is unit-tested; the actual node graph (`BeaconVoice`) needs an
 * AudioContext and is ear-verified.
 */

/** The available beacon preset names. `tone` is the legacy pulsed sine; `flat` is a
 *  pure continuous sine (no tremolo) — useful for hearing directional/level cues
 *  cleanly, with no amplitude modulation of its own to mask them. */
export type BeaconPreset = 'tone' | 'flat' | 'pulse' | 'bell' | 'musicbox' | 'drip' | 'hum';

/** The default preset for old levels / unknown names (byte-identical to the
 *  original pulsed sine). */
export const DEFAULT_BEACON_PRESET: BeaconPreset = 'tone';

const PRESET_NAMES: readonly BeaconPreset[] = ['tone', 'flat', 'pulse', 'bell', 'musicbox', 'drip', 'hum'];

/** Whether a string is a known preset name. */
export function isBeaconPreset(name: unknown): name is BeaconPreset {
  return typeof name === 'string' && (PRESET_NAMES as readonly string[]).includes(name);
}

/** Resolve a (possibly missing / unknown) preset name to a valid one. */
export function resolveBeaconPreset(name: unknown): BeaconPreset {
  return isBeaconPreset(name) ? name : DEFAULT_BEACON_PRESET;
}

/** All preset names (for editor dropdowns). */
export function beaconPresetNames(): BeaconPreset[] {
  return [...PRESET_NAMES];
}

// ---------------------------------------------------------------------------
// Pure recipe math (unit-tested) — no Web Audio here.
// ---------------------------------------------------------------------------

/**
 * Inharmonic partials of a struck bell, as multiples of the base frequency.
 * Classic minor-third bell ratios (hum, prime, tierce, quint, nominal) — these
 * give the metallic, slightly dissonant ring. Returns absolute frequencies (Hz).
 */
export function bellPartials(baseHz: number): { freq: number; gain: number; decay: number }[] {
  // ratio, relative gain, decay seconds. Higher partials are quieter + shorter.
  const spec: [number, number, number][] = [
    [0.5, 0.5, 1.6],   // hum
    [1.0, 1.0, 1.3],   // prime / strike
    [1.2, 0.7, 1.0],   // tierce (minor third)
    [1.5, 0.5, 0.8],   // quint
    [2.0, 0.4, 0.6],   // nominal
    [2.7, 0.25, 0.45], // upper inharmonic
  ];
  return spec.map(([r, g, d]) => ({ freq: baseHz * r, gain: g, decay: d }));
}

/** A short repeating music-box motif as semitone offsets from the base note. */
export const MUSICBOX_MOTIF: readonly number[] = [0, 7, 12, 7]; // root, fifth, octave, fifth

/** Convert a semitone offset to a frequency given a base. */
export function semitoneToFreq(baseHz: number, semitones: number): number {
  return baseHz * Math.pow(2, semitones / 12);
}

/** The music-box motif as absolute frequencies for a base note. */
export function musicboxNotes(baseHz: number): number[] {
  return MUSICBOX_MOTIF.map((s) => semitoneToFreq(baseHz, s));
}

/**
 * Timing recipe for a preset's pulse loop (seconds). `loop` is the time between
 * re-triggers; `voiced` presets (hum) are continuous (loop = 0).
 */
export interface BeaconTiming {
  /** Seconds between re-triggers; 0 ⇒ continuous (not pulsed). */
  loop: number;
}

const TIMING: Record<BeaconPreset, BeaconTiming> = {
  tone: { loop: 0 },     // continuous tremolo'd sine (legacy)
  flat: { loop: 0 },     // continuous pure sine, no tremolo
  pulse: { loop: 0 },    // alias of tone
  bell: { loop: 2.4 },   // slow strikes — let the ring decay
  musicbox: { loop: 0.42 }, // one note per step of the motif
  drip: { loop: 1.1 },   // irregular-ish drips
  hum: { loop: 0 },      // continuous drone
};

export function beaconTiming(preset: BeaconPreset): BeaconTiming {
  return TIMING[preset];
}

// ---------------------------------------------------------------------------
// The voice (needs an AudioContext) — ear-verified, not unit-tested.
// ---------------------------------------------------------------------------

/**
 * A live beacon voice: builds the chosen preset's node graph, connecting its mono
 * output to `dest` (the HrtfSource.input). `freq` tunes pitched presets.
 *
 * start()/stop() drive the pulse/loop. The graph is intentionally simple and
 * cheap; it is rebuilt per voice (one per beacon).
 */
export class BeaconVoice {
  private ctx: BaseAudioContext;
  private preset: BeaconPreset;
  private freq: number;
  private out: GainNode;
  /** Long-lived oscillators (continuous presets) to stop on teardown. */
  private oscillators: OscillatorNode[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private motifIndex = 0;
  private running = false;

  constructor(ctx: BaseAudioContext, dest: AudioNode, preset: BeaconPreset, freq: number) {
    this.ctx = ctx;
    this.preset = preset;
    this.freq = freq;
    this.out = ctx.createGain();
    this.out.gain.value = 1;
    this.out.connect(dest);
  }

  start() {
    if (this.running) return;
    this.running = true;
    if (this.preset === 'tone' || this.preset === 'pulse') return this.startTone();
    if (this.preset === 'flat') return this.startFlat();
    if (this.preset === 'hum') return this.startHum();
    // Pulsed presets: trigger once immediately, then on an interval.
    const period = beaconTiming(this.preset).loop;
    this.trigger();
    this.timer = setInterval(() => this.trigger(), period * 1000);
  }

  stop() {
    this.running = false;
    if (this.timer != null) { clearInterval(this.timer); this.timer = null; }
    const t = this.ctx.currentTime;
    for (const o of this.oscillators) {
      try { o.stop(t + 0.05); } catch { /* already stopped */ }
    }
    this.oscillators = [];
    try { this.out.disconnect(); } catch { /* noop */ }
  }

  private trigger() {
    if (this.preset === 'bell') this.triggerBell();
    else if (this.preset === 'musicbox') this.triggerMusicbox();
    else if (this.preset === 'drip') this.triggerDrip();
  }

  // --- continuous presets ---

  /** Legacy: pulsed sine with a 1.6 Hz tremolo LFO. Byte-identical to game.ts. */
  private startTone() {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = this.freq;
    const trem = ctx.createGain();
    trem.gain.value = 0.5;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 1.6;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.5;
    lfo.connect(lfoGain).connect(trem.gain);
    osc.connect(trem).connect(this.out);
    osc.start();
    lfo.start();
    this.oscillators.push(osc, lfo);
  }

  /** A pure continuous sine, no tremolo — bare directional/level cues, nothing to
   *  mask them. Useful for hearing the head-shadow loudness response (and any
   *  swap/refresh artifacts) cleanly. */
  private startFlat() {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = this.freq;
    const g = ctx.createGain();
    g.gain.value = 0.5; // match startTone's average level
    osc.connect(g).connect(this.out);
    osc.start();
    this.oscillators.push(osc);
  }

  /** A low harmonic drone (root + a few harmonics) with a slow vibrato. */
  private startHum() {
    const ctx = this.ctx;
    const base = this.freq * 0.5; // an octave down — easy low drone
    const mix = ctx.createGain();
    mix.gain.value = 0.5;
    // Slow vibrato applied to all partials via a shared detune LFO.
    const vibrato = ctx.createOscillator();
    vibrato.frequency.value = 0.18;
    const vibratoGain = ctx.createGain();
    vibratoGain.gain.value = 6; // cents
    vibrato.connect(vibratoGain);
    vibrato.start();
    this.oscillators.push(vibrato);
    const harmonics: [number, number, OscillatorType][] = [
      [1, 1.0, 'sine'], [2, 0.4, 'sine'], [3, 0.22, 'triangle'],
    ];
    for (const [mult, g, type] of harmonics) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = base * mult;
      vibratoGain.connect(osc.detune);
      const og = ctx.createGain();
      og.gain.value = g;
      osc.connect(og).connect(mix);
      osc.start();
      this.oscillators.push(osc);
    }
    mix.connect(this.out);
  }

  // --- pulsed presets ---

  /** A struck bell: several inharmonic partials with exponential decay. */
  private triggerBell() {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    for (const p of bellPartials(this.freq)) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = p.freq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(p.gain * 0.5, t);
      g.gain.exponentialRampToValueAtTime(0.0008, t + p.decay);
      osc.connect(g).connect(this.out);
      osc.start(t);
      osc.stop(t + p.decay + 0.05);
    }
  }

  /** A bright plucked music-box note: a single note from the repeating motif. */
  private triggerMusicbox() {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const notes = musicboxNotes(this.freq);
    const f = notes[this.motifIndex % notes.length];
    this.motifIndex++;
    // Bright pluck: triangle fundamental + a soft octave, fast exp decay.
    const dur = 0.3;
    for (const [mult, g, type] of [[1, 0.5, 'triangle'], [2, 0.18, 'sine']] as const) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = f * mult;
      const env = ctx.createGain();
      env.gain.setValueAtTime(g, t);
      env.gain.exponentialRampToValueAtTime(0.0008, t + dur);
      osc.connect(env).connect(this.out);
      osc.start(t);
      osc.stop(t + dur + 0.02);
    }
  }

  /** A water drip: a quick downward pitch sweep through a bandpass, randomized. */
  private triggerDrip() {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const jitter = 0.85 + Math.random() * 0.3;
    const f0 = this.freq * 2.4 * jitter;   // blip starts bright
    const f1 = this.freq * 0.9 * jitter;   // drops down quickly (the "ploop")
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(f1, t + 0.07);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = f1 * 1.5;
    bp.Q.value = 3;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0008, t);
    env.gain.exponentialRampToValueAtTime(0.6, t + 0.006);
    env.gain.exponentialRampToValueAtTime(0.0008, t + 0.18);
    osc.connect(bp).connect(env).connect(this.out);
    osc.start(t);
    osc.stop(t + 0.2);
  }
}
