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
export type BeaconPreset =
  | 'tone' | 'flat' | 'pulse' | 'bell' | 'musicbox' | 'drip' | 'hum'
  // Continuous AMBIENCE presets (Part B): positioned non-goal sources.
  //  - 'fountain'   — gentle continuous filtered water (layered bandpassed noise).
  //  - 'brownnoise' — a steady AC / brown-noise machine (low-passed brown noise).
  | 'fountain' | 'brownnoise'
  // Melodic / pretty presets (Part D): gentle, easily-localizable navigators.
  //  - 'chime'   — pulsed randomized wind-chime bell plucks from a pentatonic set.
  //  - 'harp'    — pulsed ascending plucked-string arpeggio (filtered saw pluck).
  //  - 'kalimba' — pulsed warm sine+triangle thumb-piano note from a short motif.
  //  - 'glass'   — continuous glass-harmonica: pure sines with slow swelling shimmer.
  | 'chime' | 'harp' | 'kalimba' | 'glass';

/** The default beacon preset — the music box, the friendliest navigator sound — used
 *  for any beacon with no explicit `sound` (the built-in navigator beacon,
 *  sandbox-generated levels, and back-fill for older saved levels / unknown names). */
export const DEFAULT_BEACON_PRESET: BeaconPreset = 'musicbox';

const PRESET_NAMES: readonly BeaconPreset[] = [
  'tone', 'flat', 'pulse', 'bell', 'musicbox', 'drip', 'hum', 'fountain', 'brownnoise',
  'chime', 'harp', 'kalimba', 'glass',
];

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

/** A major-pentatonic scale (semitone offsets, two octaves) — consonant even when
 *  the note order is shuffled, so it never sounds "wrong" for randomized presets. */
export const PENTATONIC: readonly number[] = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21];

/** A short warm kalimba motif (major-pentatonic, gently rising then settling). */
export const KALIMBA_MOTIF: readonly number[] = [0, 4, 7, 9, 7, 4]; // root, 3rd, 5th, 6th, 5th, 3rd

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
  fountain: { loop: 0 }, // continuous filtered water
  brownnoise: { loop: 0 }, // continuous AC / brown-noise machine
  chime: { loop: 1.8 },    // slow, sparse wind-chime plucks — let them ring
  harp: { loop: 2.2 },     // a full ascending arpeggio per re-trigger
  kalimba: { loop: 0.5 },  // one warm note per step of the motif
  glass: { loop: 0 },      // continuous swelling glass-harmonica shimmer
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
  /** Long-lived looping buffer sources (noise ambience presets) to stop on teardown. */
  private sources: AudioBufferSourceNode[] = [];
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
    if (this.preset === 'fountain') return this.startFountain();
    if (this.preset === 'brownnoise') return this.startBrownNoise();
    if (this.preset === 'glass') return this.startGlass();
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
    for (const s of this.sources) {
      try { s.stop(t + 0.05); } catch { /* already stopped */ }
    }
    this.sources = [];
    try { this.out.disconnect(); } catch { /* noop */ }
  }

  private trigger() {
    if (this.preset === 'bell') this.triggerBell();
    else if (this.preset === 'musicbox') this.triggerMusicbox();
    else if (this.preset === 'drip') this.triggerDrip();
    else if (this.preset === 'chime') this.triggerChime();
    else if (this.preset === 'harp') this.triggerHarp();
    else if (this.preset === 'kalimba') this.triggerKalimba();
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

  /** A 2 s looping white-noise buffer (the raw source for the ambience presets). */
  private whiteNoiseSource(): AudioBufferSourceNode {
    const ctx = this.ctx;
    const n = Math.floor(ctx.sampleRate * 2);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < n; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    return src;
  }

  /**
   * A gentle fountain: looping white noise split through TWO bandpass bands (a low
   * "burble" + a high "splash trickle"), each with a slow gain LFO so the water
   * shimmers rather than sounding like a static hiss. Continuous, easy to localize.
   */
  private startFountain() {
    const ctx = this.ctx;
    const src = this.whiteNoiseSource();
    const mix = ctx.createGain();
    mix.gain.value = 0.35;
    // Two filtered streams that together read as "running water".
    const bands: [number, number, number][] = [
      // centre Hz, Q, gain
      [520, 1.2, 0.7],   // low burble
      [2600, 2.0, 0.5],  // high trickle/splash
    ];
    for (const [freq, q, g] of bands) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = freq;
      bp.Q.value = q;
      const bg = ctx.createGain();
      bg.gain.value = g;
      // Slow shimmer LFO on this band's gain.
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.3 + Math.random() * 0.4;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = g * 0.4;
      lfo.connect(lfoGain).connect(bg.gain);
      lfo.start();
      this.oscillators.push(lfo);
      src.connect(bp).connect(bg).connect(mix);
    }
    mix.connect(this.out);
    src.start();
    this.sources.push(src);
  }

  /**
   * An AC / brown-noise machine: white noise integrated toward BROWN (a one-pole
   * leaky integrator), low-passed, with a faint steady hum partial — a constant,
   * unobtrusive "machine running" bed that LEAKS more when a door opens (Part C).
   */
  private startBrownNoise() {
    const ctx = this.ctx;
    const n = Math.floor(ctx.sampleRate * 2);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < n; i++) {
      const w = Math.random() * 2 - 1;
      // Leaky integrator → brown noise; rescale to keep it in range.
      last = (last + 0.02 * w) / 1.02;
      data[i] = last * 3.5;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    const g = ctx.createGain();
    g.gain.value = 0.4;
    src.connect(lp).connect(g).connect(this.out);
    src.start();
    this.sources.push(src);
    // A faint mains-hum partial gives the machine a tonal "presence".
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 120;
    const og = ctx.createGain();
    og.gain.value = 0.04;
    osc.connect(og).connect(this.out);
    osc.start();
    this.oscillators.push(osc);
  }

  /**
   * A glass harmonica: three pure sine partials (root + fifth + octave) each with a
   * slow, independent gain LFO so they swell and fade against one another — an
   * ethereal, shimmering continuous drone that is easy to localize but never harsh.
   */
  private startGlass() {
    const ctx = this.ctx;
    const mix = ctx.createGain();
    mix.gain.value = 0.4;
    // Root, fifth, octave — a consonant, bell-clear stack of pure tones.
    const partials: [number, number][] = [
      // frequency multiple, base gain
      [1.0, 0.5], [1.5, 0.32], [2.0, 0.22],
    ];
    for (const [mult, g] of partials) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = this.freq * mult;
      const og = ctx.createGain();
      og.gain.value = g * 0.5; // the LFO swells it up from here
      // Slow, per-partial shimmer LFO so the partials breathe out of phase.
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.12 + Math.random() * 0.18;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = g * 0.5;
      lfo.connect(lfoGain).connect(og.gain);
      lfo.start();
      osc.connect(og).connect(mix);
      osc.start();
      this.oscillators.push(osc, lfo);
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

  /**
   * A wind chime: one or two randomized bell-ish plucks picked from the pentatonic
   * set, each a soft sine with a fast attack and long exponential ring. Randomized
   * pitch + tiny stagger make it feel like a breeze catching a couple of tubes.
   */
  private triggerChime() {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const hits = 1 + (Math.random() < 0.5 ? 1 : 0); // usually one, sometimes two
    for (let i = 0; i < hits; i++) {
      const semi = PENTATONIC[Math.floor(Math.random() * PENTATONIC.length)];
      const f = semitoneToFreq(this.freq, semi);
      const at = t + i * (0.08 + Math.random() * 0.12); // slight stagger
      const dur = 1.4 + Math.random() * 0.6;
      // Sine fundamental + a quiet high partial for a glassy metallic edge.
      for (const [mult, g] of [[1, 0.4], [2.76, 0.08]] as const) {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = f * mult;
        const env = ctx.createGain();
        env.gain.setValueAtTime(0.0008, at);
        env.gain.exponentialRampToValueAtTime(g, at + 0.004);
        env.gain.exponentialRampToValueAtTime(0.0008, at + dur);
        osc.connect(env).connect(this.out);
        osc.start(at);
        osc.stop(at + dur + 0.05);
      }
    }
  }

  /**
   * A plucked-string arpeggio: a short ascending run of pentatonic notes, each a
   * soft sawtooth through a lowpass with a fast decay — a warm, harp-like pluck.
   */
  private triggerHarp() {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const steps = [0, 2, 4, 7, 9]; // rising major-pentatonic run
    const gap = 0.11;
    steps.forEach((semi, i) => {
      const at = t + i * gap;
      const f = semitoneToFreq(this.freq, semi);
      const dur = 0.6;
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = f;
      // Lowpass that closes as the note decays → the "pluck" softening.
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(f * 6, at);
      lp.frequency.exponentialRampToValueAtTime(f * 1.5, at + dur);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0008, at);
      env.gain.exponentialRampToValueAtTime(0.35, at + 0.005);
      env.gain.exponentialRampToValueAtTime(0.0008, at + dur);
      osc.connect(lp).connect(env).connect(this.out);
      osc.start(at);
      osc.stop(at + dur + 0.02);
    });
  }

  /**
   * A thumb-piano (kalimba) note: a single note from a short pentatonic motif, a
   * warm sine fundamental + a quiet triangle overtone, fast pluck decay — soft and
   * woody, gentler than the music box.
   */
  private triggerKalimba() {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const semi = KALIMBA_MOTIF[this.motifIndex % KALIMBA_MOTIF.length];
    this.motifIndex++;
    const f = semitoneToFreq(this.freq, semi);
    const dur = 0.55;
    for (const [mult, g, type] of [[1, 0.45, 'sine'], [2, 0.12, 'triangle']] as const) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = f * mult;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0008, t);
      env.gain.exponentialRampToValueAtTime(g, t + 0.006);
      env.gain.exponentialRampToValueAtTime(0.0008, t + dur);
      osc.connect(env).connect(this.out);
      osc.start(t);
      osc.stop(t + dur + 0.02);
    }
  }
}
