/**
 * Loudness-EQ audio glue — builds the master-bus correction filter chain from a
 * stored curve, and the equal-loudness comparison tones for the calibration UI.
 *
 * The PURE staircase logic + curve shape live in loudnessEq.ts; this file is the
 * thin Web-Audio layer (integration / ear-verified). It deliberately does NOT touch
 * the engine: main.ts inserts the returned chain on the shared master GainNode path.
 */
import type { EqBand } from './loudnessEq';

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
  const BASE = 0.25; // reference linear gain (comfortable, headroom for boosts)
  const t0 = ctx.currentTime + 0.05;

  const tone = (freq: number, gainDb: number, start: number): { osc: OscillatorNode } => {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const lin = BASE * Math.pow(10, gainDb / 20);
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(lin, start + 0.02);
    g.gain.setValueAtTime(lin, start + TONE - 0.05);
    g.gain.linearRampToValueAtTime(0, start + TONE);
    osc.connect(g);
    g.connect(dest);
    osc.start(start);
    osc.stop(start + TONE + 0.02);
    return { osc };
  };

  const a = tone(refFreq, 0, t0);
  const b = tone(bandFreq, gainDb(bandGainDb), t0 + TONE + GAP);

  return () => {
    try {
      a.osc.stop();
    } catch {
      /* already stopped */
    }
    try {
      b.osc.stop();
    } catch {
      /* already stopped */
    }
  };
}

/** Local helper so the closure above reads naturally; just passes the dB through. */
function gainDb(db: number): number {
  return Number.isFinite(db) ? db : 0;
}
