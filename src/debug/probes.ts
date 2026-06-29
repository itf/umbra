/**
 * Probe ("echo") sounds — the excitation fired through a scene's room impulse
 * response to reveal its reflections. Today the only probe was a hardcoded ~10ms
 * noise clap; this module makes the probe SELECTABLE.
 *
 * Each synth preset is a PURE function `(sampleRate) => Float32Array` producing a
 * short mono excitation buffer — no AudioContext needed, so the buffer shape
 * (length, envelope, edge values, energy) is unit-testable. The noise *samples*
 * may be random (Math.random is fine here — these are excitations, not exercise
 * content), but the ENVELOPE and LENGTH are deterministic functions of the sample
 * rate, which is what the tests assert.
 *
 * A probe can also be a recorded audio file (see ScenePlayer.setProbe); that path
 * reuses `loadCustomLoop` from game/customAudio and is NOT in this pure module.
 *
 * Different probes reveal reflections differently: a sharp transient (click/snap)
 * is good for timing/direction; a sustained hiss makes faint reflections ring out.
 *
 * See docs/engine/probe-sounds.md.
 */

/** A pure synth probe: builds a mono excitation buffer for a given sample rate. */
export type ProbeGenerator = (sampleRate: number) => Float32Array;

/** The available synth probe preset names. `clap` is the legacy default. */
export type ProbeName = 'clap' | 'click' | 'hiss' | 'snap';

/** The default probe (byte-compatible with the original hardcoded clap). */
export const DEFAULT_PROBE: ProbeName = 'clap';

const PROBE_NAMES: readonly ProbeName[] = ['clap', 'click', 'hiss', 'snap'];

/** Probe presets for UI pickers: name + a short human label/description. */
export const PROBE_PRESETS: ReadonlyArray<{ name: ProbeName; label: string; hint: string }> = [
  { name: 'clap', label: 'Clap', hint: 'broadband noise burst — the classic echo probe' },
  { name: 'click', label: 'Tongue click', hint: 'very short crisp transient — best for timing & direction' },
  { name: 'hiss', label: 'Hiss (shh)', hint: 'sustained filtered noise — faint reflections ring out' },
  { name: 'snap', label: 'Finger snap', hint: 'bright snappy transient with a short ping' },
];

/** Whether a string is a known synth probe name. */
export function isProbeName(name: unknown): name is ProbeName {
  return typeof name === 'string' && (PROBE_NAMES as readonly string[]).includes(name);
}

// ---------------------------------------------------------------------------
// Pure generators. Lengths are deterministic in the sample rate.
// ---------------------------------------------------------------------------

/**
 * Legacy clap: ~10ms decaying white-noise burst with a squared linear fade.
 * Behaviour identical to the original hardcoded probe.
 */
const clap: ProbeGenerator = (sr) => {
  const n = Math.ceil(0.01 * sr);
  const ch = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const env = 1 - i / n;
    ch[i] = (Math.random() * 2 - 1) * env * env;
  }
  return ch;
};

/**
 * Tongue click: a very short (~3ms) sharp transient — a single-cycle impulse with
 * a tiny noisy body, crisp. A fast-attack, fast-decay envelope keeps both edges
 * near zero.
 */
const click: ProbeGenerator = (sr) => {
  const n = Math.ceil(0.003 * sr);
  const ch = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / n;
    // Very fast attack (first ~10%), sharp exponential decay → a click.
    const attack = Math.min(1, t / 0.1);
    const env = attack * Math.exp(-t * 9);
    // A touch of tone for "body" plus noise for crispness.
    const tone = Math.sin(2 * Math.PI * (t * n) * 0.4);
    ch[i] = (0.6 * (Math.random() * 2 - 1) + 0.4 * tone) * env;
  }
  return ch;
};

/**
 * Hiss ("shh"): a longer (~220ms) broadband noise with a smooth raised-cosine
 * attack/decay so it starts and ends at exactly zero (no edge click) and sustains,
 * letting faint reflections ring out.
 */
const hiss: ProbeGenerator = (sr) => {
  const n = Math.ceil(0.22 * sr);
  const ch = new Float32Array(n);
  // Simple one-pole lowpass smoothing of white noise → a softer "shh".
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1); // 0..1 inclusive
    // Raised-cosine (Hann) window: zero at both ends, smooth in between.
    const env = 0.5 - 0.5 * Math.cos(2 * Math.PI * t);
    const white = Math.random() * 2 - 1;
    prev = prev * 0.5 + white * 0.5; // mild lowpass
    ch[i] = prev * env;
  }
  return ch;
};

/**
 * Finger snap: a bright snappy transient (~12ms) — a fast noise burst with a
 * little more body than the click, plus a short resonant ping that gives it the
 * characteristic "tck" ring.
 */
const snap: ProbeGenerator = (sr) => {
  const n = Math.ceil(0.012 * sr);
  const ch = new Float32Array(n);
  const pingHz = 2200; // resonant ping frequency
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const attack = Math.min(1, t / 0.05);
    const burstEnv = attack * Math.exp(-t * 14);
    const burst = (Math.random() * 2 - 1) * burstEnv;
    const ping = Math.sin(2 * Math.PI * pingHz * (i / sr)) * Math.exp(-t * 22) * attack;
    ch[i] = 0.7 * burst + 0.5 * ping;
  }
  return ch;
};

const GENERATORS: Record<ProbeName, ProbeGenerator> = { clap, click, hiss, snap };

/**
 * Resolve a (possibly unknown / missing) probe name to its pure generator,
 * falling back to `clap` for anything unrecognized.
 */
export function resolveProbe(name: unknown): ProbeGenerator {
  return isProbeName(name) ? GENERATORS[name] : GENERATORS[DEFAULT_PROBE];
}
