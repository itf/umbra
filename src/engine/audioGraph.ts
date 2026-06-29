/**
 * AudioContext bootstrap + master bus. iOS Safari requires the context to be
 * created/resumed inside a user gesture, so this is only called from the Begin
 * button handler.
 */
export interface AudioGraph {
  ctx: AudioContext;
  /** Master gain knob — connect all sources here. Feeds the limiter, then output. */
  master: GainNode;
  /**
   * Peak limiter (DynamicsCompressor) sitting between `master` and the safety
   * clip. Catches sustained over-level so the audio rarely reaches the ceiling.
   */
  limiter: DynamicsCompressorNode;
  /**
   * Final safety ceiling (WaveShaper tanh soft-clip) → destination. Mathematically
   * bounds the output to ±1 even on instantaneous transients the look-ahead-free
   * compressor can't catch.
   */
  safetyClip: WaveShaperNode;
}

let graph: AudioGraph | null = null;

/**
 * Configure a DynamicsCompressorNode as a brickwall-ish peak LIMITER. With a hard
 * knee, max ratio, low threshold, and fast attack it behaves as a transparent
 * limiter: it only pulls down the SUSTAINED summed peaks (beacon + footsteps +
 * room reverb + future monster) that would otherwise hard-clip at the
 * destination, leaving normal-level audio untouched. Short release → no pumping.
 *
 * A compressor alone is NOT a true brickwall: it has no look-ahead, so the very
 * first sample-block of a hard transient (e.g. several sounds whose onsets align)
 * overshoots before the attack engages — measured up to ~2.0 in the offline
 * harness. That is why `makeSafetyClip` follows it.
 */
export function makeLimiter(ctx: AudioContext): DynamicsCompressorNode {
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3; // dBFS — start limiting just below full scale
  limiter.knee.value = 0; // hard knee → brickwall behaviour
  limiter.ratio.value = 20; // max ratio → limiter, not gentle compressor
  limiter.attack.value = 0.003; // 3 ms — catch transients fast
  limiter.release.value = 0.1; // 100 ms — recover quickly, no pumping
  return limiter;
}

/**
 * Final safety ceiling: a WaveShaper whose curve is tanh(1.2·x). tanh is nearly
 * linear for small |x| (quiet audio passes through essentially untouched) and
 * saturates smoothly toward ±tanh(1.2)≈±0.83 as |x|→∞, so ANY input — including
 * the compressor's transient overshoot above ±1 — emerges strictly within [-1,1]
 * with NO hard-clip discontinuity (a hard clip would itself create a click). 4×
 * oversampling avoids aliasing from the nonlinearity.
 */
export function makeSafetyClip(ctx: AudioContext): WaveShaperNode {
  const shaper = ctx.createWaveShaper();
  const n = 2048;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(1.2 * x);
  }
  shaper.curve = curve;
  shaper.oversample = '4x';
  return shaper;
}

export async function startAudio(): Promise<AudioGraph> {
  if (graph) {
    await graph.ctx.resume();
    return graph;
  }
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  await ctx.resume();
  const master = ctx.createGain();
  master.gain.value = 0.9;
  const limiter = makeLimiter(ctx);
  const safetyClip = makeSafetyClip(ctx);
  master.connect(limiter);
  limiter.connect(safetyClip);
  safetyClip.connect(ctx.destination);
  graph = { ctx, master, limiter, safetyClip };
  return graph;
}

export function getGraph(): AudioGraph | null {
  return graph;
}
