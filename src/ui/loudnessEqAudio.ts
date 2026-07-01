/**
 * Loudness-EQ audio glue — builds the master-bus correction filter chain from a
 * stored curve, and the equal-loudness comparison tones for the calibration UI.
 *
 * The PURE staircase logic + curve shape live in loudnessEq.ts; this file is the
 * thin Web-Audio layer (integration / ear-verified). It deliberately does NOT touch
 * the engine: main.ts inserts the returned chain on the shared master GainNode path.
 */
import type { EqBand } from './loudnessEq';
import { assetUrl } from '../engine/baseUrl';

/** Q for ~1-octave peaking bands (constant-Q). 1 octave ⇒ Q ≈ 1.41. */
const BAND_Q = 1.41;

/** A built EQ filter chain to splice onto the master bus. */
export interface EqChain {
  /** Connect the master output INTO this. */
  input: AudioNode;
  /** This feeds the next stage (swap/limiter). */
  output: AudioNode;
  /** Detach all internal nodes (caller re-wires master → next stage). */
  dispose: () => void;
}

/**
 * Build a series of peaking BiquadFilterNodes — one per band with a non-zero gain —
 * from the correction curve. Bands at 0 dB are skipped (no-op). Returns null when the
 * curve is empty or all-flat, so the caller can keep the dry path. The chain is
 * input → [peak]…[peak] → output (input === output when a single trivial gain node is
 * used to guarantee a stable splice point even if all bands are flat-but-present).
 */
export function buildEqChain(ctx: BaseAudioContext, curve: EqBand[] | null): EqChain | null {
  if (!curve || curve.length === 0) return null;
  const active = curve.filter((b) => Number.isFinite(b.gainDb) && Math.abs(b.gainDb) > 0.01);
  if (active.length === 0) return null;

  const nodes: BiquadFilterNode[] = active.map((b) => {
    const f = ctx.createBiquadFilter();
    f.type = 'peaking';
    f.frequency.value = b.freq;
    f.Q.value = BAND_Q;
    f.gain.value = b.gainDb;
    return f;
  });
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);

  return {
    input: nodes[0],
    output: nodes[nodes.length - 1],
    dispose: () => {
      for (const n of nodes) {
        try {
          n.disconnect();
        } catch {
          /* already detached */
        }
      }
    },
  };
}

/** One biquad-cascade band with its OWN type + Q (unlike the fixed-Q loudness EQ). */
export interface CompBiquad {
  type: BiquadFilterType;
  freq: number;
  Q: number;
  gainDb: number;
}

/**
 * Build a peaking/shelf biquad cascade from an explicit per-band list (each band keeps
 * its own type + Q), multiplying every gain by `scale`. Bands whose SCALED gain is ~0 dB
 * are skipped; returns null when nothing is left (so the caller keeps the dry path). Used
 * by the over-ear headphone compensation, which — unlike the loudness EQ — needs per-band
 * Q and a runtime strength scalar. Mirrors buildEqChain's splice contract (input/output).
 */
export function buildBiquadChain(
  ctx: BaseAudioContext,
  biquads: CompBiquad[] | null,
  scale: number,
): EqChain | null {
  if (!biquads || biquads.length === 0 || !(scale > 0)) return null;
  const active = biquads.filter(
    (b) => Number.isFinite(b.gainDb) && Number.isFinite(b.freq) && b.freq > 0 && Math.abs(b.gainDb * scale) > 0.01,
  );
  if (active.length === 0) return null;

  const nodes: BiquadFilterNode[] = active.map((b) => {
    const f = ctx.createBiquadFilter();
    f.type = b.type;
    f.frequency.value = b.freq;
    f.Q.value = Number.isFinite(b.Q) && b.Q > 0 ? b.Q : 1;
    f.gain.value = b.gainDb * scale;
    return f;
  });
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);

  return {
    input: nodes[0],
    output: nodes[nodes.length - 1],
    dispose: () => {
      for (const n of nodes) {
        try {
          n.disconnect();
        } catch {
          /* already detached */
        }
      }
    },
  };
}

/**
 * The over-ear compensation asset (a static peaking-biquad cascade — the average-inverse
 * of the ARI HpIR headphone set). Fetched ONCE and cached; returns null if it can't be
 * loaded so the caller simply keeps the dry path. See assets/hrtf/overear_comp.json.
 *
 * Attribution (CC BY-SA 3.0): derived from the ARI HpIR database, Acoustics Research
 * Institute, Austrian Academy of Sciences (Vienna). Credited on the Credits screen.
 */
const OVEREAR_COMP_URL = assetUrl('assets/hrtf/overear_comp.json');
let overEarCompPromise: Promise<CompBiquad[] | null> | null = null;

export function loadOverEarComp(): Promise<CompBiquad[] | null> {
  if (!overEarCompPromise) {
    overEarCompPromise = (async () => {
      try {
        const res = await fetch(OVEREAR_COMP_URL);
        if (!res.ok) return null;
        const json = (await res.json()) as { biquads?: unknown };
        if (!Array.isArray(json.biquads)) return null;
        const out: CompBiquad[] = [];
        for (const b of json.biquads as unknown[]) {
          const rec = b as { type?: unknown; freq?: unknown; Q?: unknown; gainDb?: unknown };
          const freq = Number(rec.freq);
          const gainDb = Number(rec.gainDb);
          const Q = Number(rec.Q);
          if (!Number.isFinite(freq) || freq <= 0 || !Number.isFinite(gainDb)) continue;
          out.push({
            type: (typeof rec.type === 'string' ? rec.type : 'peaking') as BiquadFilterType,
            freq,
            Q: Number.isFinite(Q) && Q > 0 ? Q : 1,
            gainDb,
          });
        }
        return out.length ? out : null;
      } catch {
        return null; // offline / missing asset ⇒ dry path
      }
    })();
  }
  return overEarCompPromise;
}

/**
 * Play the equal-loudness comparison pair: the 1 kHz REFERENCE tone (A), a short
 * gap, then the BAND tone (B) at `bandFreq` with `bandGainDb` applied — both routed
 * to `dest` (the calibration master). Each tone is ~700 ms with soft fades to avoid
 * clicks. Returns a stop() to cancel an in-flight pair.
 */
export function playLoudnessPair(
  ctx: AudioContext,
  dest: AudioNode,
  refFreq: number,
  bandFreq: number,
  bandGainDb: number,
): () => void {
  const TONE = 0.7;
  const GAP = 0.25;
  // Reference linear gain — kept LOW (was 0.25) so calibration is never uncomfortably
  // loud, per user preference; there's still headroom for the +dB band boosts.
  const BASE = 0.15;
  const t0 = ctx.currentTime + 0.05;

  // One shared pink-ish noise buffer for both tones (cheaper + consistent timbre).
  const noiseBuf = makeNoiseBuffer(ctx, TONE + 0.1);

  // Each "tone" is NARROWBAND NOISE centred at `freq` (a bandpass over the noise),
  // not a pure sine — a warmer, easier-to-judge sound that still isolates the band.
  const tone = (freq: number, gainDb: number, start: number): { src: AudioBufferSourceNode } => {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = 4; // ~1/4-octave — a clear pitch centre without a whistling tone
    const g = ctx.createGain();
    // Bandpass noise is quieter than a sine at the same "gain", so lift a little.
    const lin = BASE * 1.8 * Math.pow(10, gainDb / 20);
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(lin, start + 0.03);
    g.gain.setValueAtTime(lin, start + TONE - 0.06);
    g.gain.linearRampToValueAtTime(0, start + TONE);
    src.connect(bp);
    bp.connect(g);
    g.connect(dest);
    src.start(start);
    src.stop(start + TONE + 0.02);
    return { src };
  };

  const a = tone(refFreq, 0, t0);
  const b = tone(bandFreq, gainDb(bandGainDb), t0 + TONE + GAP);

  return () => {
    try { a.src.stop(); } catch { /* already stopped */ }
    try { b.src.stop(); } catch { /* already stopped */ }
  };
}

/** A short looping-safe white-ish noise buffer for the calibration probes. */
function makeNoiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
  const n = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

/** Local helper so the closure above reads naturally; just passes the dB through. */
function gainDb(db: number): number {
  return Number.isFinite(db) ? db : 0;
}
