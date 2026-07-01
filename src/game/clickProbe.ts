/**
 * Synthetic "mouth click" echolocation probe.
 *
 * A research-grounded model of the palatal tongue click used by blind expert
 * human echolocators, ported from the published model of:
 *
 *   Thaler, Reich, Zhang, Wang, Smith, Antoniou, Kish et al.,
 *   "Mouth-clicks used by blind expert human echolocators — signal description
 *    and model based signal synthesis", PLOS Comput. Biol. 13(8): e1005670 (2017).
 *   DOI: 10.1371/journal.pcbi.1005670
 *
 * The paper models each click (its Eq. 5) as a small SUM OF DAMPED SINUSOIDS
 * under a single shared exponential envelope:
 *
 *     Csynth(t) = -R(theta) * E(t) * SUM_i  N_i * cos(2*pi*f_i*t + phi_i)
 *     E(t)      = a * exp(-b * (t - c)) * H(t - c)          (Eq. 4)
 *
 * where H is the Heaviside step (onset at time c), b is the decay constant, and
 * f_i are the per-click mode ("peak") frequencies. R(theta) is a cardioid
 * DIRECTIVITY term used for spatial radiation; here we synthesize the on-axis
 * (forward) waveform, so R(theta) folds into the overall gain and we normalize.
 *
 * We port the published coefficients for expert echolocator EE1 (the richest,
 * 5-mode click); the fitted values used below are:
 *   - mode frequencies f_i (kHz): 3.54, 5.30, 6.93, 9.97, 11.88
 *       → peak energy in the 2–4 kHz region plus the characteristic ~10 kHz shoulder.
 *   - decay constant b = 1.57e3  (1/s)
 *   - rise magnitude a = 0.388, onset c = 0.130 ms
 * (EE2 and EE3 coefficients are included for reference / selectable "voices".)
 * Per-mode amplitudes N_i and phases phi_i are not tabulated in the article text;
 * the paper reports peak energy 2–4 kHz with a ~10 kHz shoulder, so we set N_i to
 * emphasise the low modes and give the ~10 kHz pair a moderate shoulder. These
 * per-mode amplitude/phase weights are therefore an APPROXIMATION of the fitted
 * S1-Code values, while the frequencies, decay, onset and rise are the published
 * numbers. Clicks last ~2–3 ms (5% energy) / ~3–4 ms (1% energy).
 *
 * The core renderer is a PURE, DETERMINISTIC function (no Web Audio). With the
 * default jitter of 0 it is bit-for-bit reproducible; a `seed` + `jitter` drives
 * a tiny seeded PRNG (mulberry32 — NOT Math.random) to perturb the modes a few
 * percent so successive probes sound subtly different but stay the same "voice".
 */

/** Published EE-fit parameters (Eq. 4/5) for the three expert echolocators. */
export interface ClickVoice {
  /** Mode ("peak") frequencies in Hz. */
  freqs: number[];
  /** Exponential decay constant b (1/s). */
  b: number;
  /** Rise magnitude a. */
  a: number;
  /** Onset time c, in seconds. */
  c: number;
}

/** Coefficients from PLOS Comput. Biol. 13(8):e1005670 (2017), Table (EE1–EE3). */
export const CLICK_VOICES: Record<'EE1' | 'EE2' | 'EE3', ClickVoice> = {
  EE1: { freqs: [3540, 5300, 6930, 9970, 11880], b: 1.57e3, a: 0.388, c: 0.130e-3 },
  EE2: { freqs: [2200, 7200, 10780, 13260], b: 1.05e3, a: 2.23, c: 0.101e-3 },
  EE3: { freqs: [3670, 10010], b: 1.56e3, a: 6.57, c: 0.963e-3 },
};

export interface MouthClickOpts {
  /** Which expert echolocator's fitted click to synthesize. Default 'EE1'. */
  voice?: 'EE1' | 'EE2' | 'EE3';
  /** Total render length in seconds. Default 0.006 (well under 20 ms). */
  durationMs?: number;
  /** Peak absolute amplitude after normalization. Default 1.0. */
  peak?: number;
  /**
   * Fractional per-click variation (0..~0.1) applied to mode freqs / decay /
   * amplitudes / overall gain via the seeded PRNG. 0 = canonical click.
   */
  jitter?: number;
  /** PRNG seed for the jitter. Same seed + jitter → identical output. Default 1. */
  seed?: number;
}

const DEFAULTS: Required<MouthClickOpts> = {
  voice: 'EE1',
  durationMs: 0.006, // 6 ms window captures the ~3 ms body + short decaying tail.
  peak: 1.0,
  jitter: 0,
  seed: 1,
};

/**
 * Per-mode amplitude weights N_i (approximation — see file header). Emphasise the
 * 2–4 kHz peak; give the ~10 kHz shoulder moderate weight. Applied by index,
 * clipped/padded to the voice's mode count.
 */
const MODE_WEIGHTS = [1.0, 0.7, 0.55, 0.6, 0.4];

/** Tiny deterministic PRNG (mulberry32). Not Math.random → tests stay reproducible. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * PURE. Render the mouth-click waveform into a mono Float32Array.
 *
 * Deterministic: identical inputs (incl. seed) always produce an identical array.
 */
export function renderMouthClick(sampleRate: number, opts: MouthClickOpts = {}): Float32Array {
  const o = { ...DEFAULTS, ...opts };
  const voice = CLICK_VOICES[o.voice];
  const n = Math.max(1, Math.round(o.durationMs * sampleRate));
  const out = new Float32Array(n);

  // Seeded jitter: symmetric perturbation in [-jitter, +jitter] per draw.
  const rng = mulberry32(o.seed);
  const jit = () => 1 + (o.jitter > 0 ? (rng() * 2 - 1) * o.jitter : 0);

  // Perturb the published params by a few percent (no-op when jitter = 0).
  const freqs = voice.freqs.map((f) => f * jit());
  const amps = voice.freqs.map((_, i) => (MODE_WEIGHTS[i] ?? 0.4) * jit());
  const b = voice.b * jit();
  const c = voice.c; // onset held fixed so clicks stay time-aligned
  const overallGain = jit();

  // Csynth(t) = E(t) * SUM_i N_i cos(2*pi*f_i (t-c) + phi_i), phases = 0 on-axis.
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    if (t < c) continue; // Heaviside: silent before onset.
    const env = voice.a * Math.exp(-b * (t - c)); // Eq. 4 (rise a, decay b).
    let s = 0;
    for (let m = 0; m < freqs.length; m++) {
      s += amps[m] * Math.cos(2 * Math.PI * freqs[m] * (t - c));
    }
    out[i] = overallGain * env * s;
  }

  // Normalize to peak amplitude.
  let maxAbs = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(out[i]);
    if (a > maxAbs) maxAbs = a;
  }
  if (maxAbs > 0) {
    const g = o.peak / maxAbs;
    for (let i = 0; i < n; i++) out[i] *= g;
  }
  return out;
}

/** Total sample count a render will produce for these opts. */
export function mouthClickLength(sampleRate: number, opts: MouthClickOpts = {}): number {
  const o = { ...DEFAULTS, ...opts };
  return Math.max(1, Math.round(o.durationMs * sampleRate));
}

/** Wrap the pure renderer into a mono AudioBuffer. */
export function mouthClickBuffer(ctx: BaseAudioContext, opts: MouthClickOpts = {}): AudioBuffer {
  const data = renderMouthClick(ctx.sampleRate, opts);
  const buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
  buf.getChannelData(0).set(data);
  return buf;
}

/**
 * Fire the click once through a gain into `dest`. Mirrors the one-shot probe
 * style used elsewhere (createBufferSource → gain → dest, auto start).
 */
export function playMouthClick(
  ctx: BaseAudioContext,
  dest: AudioNode,
  opts: MouthClickOpts & { gain?: number } = {},
): AudioBufferSourceNode {
  const { gain = 1, ...clickOpts } = opts;
  const src = ctx.createBufferSource();
  src.buffer = mouthClickBuffer(ctx, clickOpts);
  const g = ctx.createGain();
  g.gain.value = gain;
  src.connect(g).connect(dest);
  src.start();
  return src;
}
