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
import { renderMouthClick } from '../game/clickProbe';

/** A pure synth probe: builds a mono excitation buffer for a given sample rate. */
export type ProbeGenerator = (sampleRate: number) => Float32Array;

/**
 * The available synth probe preset names. `clap` is the legacy default.
 * `mouthclick` is the research-grounded expert mouth click (clickProbe.ts,
 * 2017 Thaler/Reich model) — the recommended realistic echolocation probe.
 */
export type ProbeName = 'clap' | 'click' | 'hiss' | 'snap' | 'stomp' | 'mouthclick';

/**
 * The default probe: the research-grounded expert mouth click (2017 Thaler/Reich).
 * This is the "good tongue click" — the recommended, most legible echolocation probe,
 * so it's what a new player fires by default. (The legacy noise-burst `clap` remains
 * selectable; it is no longer the default.)
 */
export const DEFAULT_PROBE: ProbeName = 'mouthclick';

const PROBE_NAMES: readonly ProbeName[] = ['clap', 'click', 'hiss', 'snap', 'stomp', 'mouthclick'];

/** Probe presets for UI pickers: name + a short human label/description. */
export const PROBE_PRESETS: ReadonlyArray<{ name: ProbeName; label: string; hint: string }> = [
  { name: 'clap', label: 'Clap', hint: 'broadband noise burst — the classic echo probe' },
  { name: 'click', label: 'Tongue click', hint: 'very short crisp transient — best for timing & direction' },
  { name: 'hiss', label: 'Hiss (shh)', hint: 'sustained filtered noise — faint reflections ring out' },
  { name: 'snap', label: 'Finger snap', hint: 'bright snappy transient with a short ping' },
  { name: 'stomp', label: 'Footstep (stomp)', hint: 'a low thump + tap, like a footfall — echolocate with your steps' },
  { name: 'mouthclick', label: 'Mouth click (realistic)', hint: 'research-modelled expert tongue click (2017 Thaler/Reich) — the recommended probe' },
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

/**
 * Footstep "stomp": a footfall-shaped excitation (~140ms) — a short broadband tap
 * (the heel/noise transient) over a low decaying ~80 Hz thump (the body/weight),
 * mirroring the in-game footstep synth (game/footsteps.ts) but as a single mono
 * probe buffer. Lets the trainer echolocate with a step sound instead of a clap.
 */
const stomp: ProbeGenerator = (sr) => {
  const n = Math.ceil(0.14 * sr);
  const ch = new Float32Array(n);
  const thumpHz = 80;
  const tapN = Math.ceil(0.04 * sr); // the noisy tap lives in the first ~40 ms
  for (let i = 0; i < n; i++) {
    const t = i / n;
    // Low thump body: a decaying sine, like the step's weight.
    const thump = 0.85 * Math.sin(2 * Math.PI * thumpHz * (i / sr)) * Math.exp(-t * 9);
    // Short broadband tap (heel strike), quadratic decay, only at the start.
    let tap = 0;
    if (i < tapN) {
      const te = 1 - i / tapN;
      tap = 0.6 * (Math.random() * 2 - 1) * te * te;
    }
    ch[i] = thump + tap;
  }
  // Normalize to ~unit peak so it sits at a comparable level to the other probes.
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(ch[i]));
  if (peak > 0) for (let i = 0; i < n; i++) ch[i] /= peak;
  return ch;
};

/**
 * Realistic mouth click: the 2017 Thaler/Reich expert-echolocator model
 * (game/clickProbe.ts). Each call applies a fresh jitter SEED with a small jitter
 * amount, so successive probes vary a few percent — repeated clicks sound natural
 * rather than a machine-gun of one identical sample — while staying the same "voice".
 * The generator itself is pure in (sampleRate); the per-fire variation comes from the
 * random seed, exactly like the noise probes' `Math.random()` bodies.
 */
const mouthclick: ProbeGenerator = (sr) =>
  renderMouthClick(sr, {
    voice: 'EE1',
    jitter: 0.03,
    seed: (Math.random() * 0x7fffffff) | 0,
  });

const GENERATORS: Record<ProbeName, ProbeGenerator> = { clap, click, hiss, snap, stomp, mouthclick };

/**
 * Resolve a (possibly unknown / missing) probe name to its pure generator,
 * falling back to `clap` for anything unrecognized.
 */
export function resolveProbe(name: unknown): ProbeGenerator {
  return isProbeName(name) ? GENERATORS[name] : GENERATORS[DEFAULT_PROBE];
}
