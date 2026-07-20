/// <reference lib="webworker" />
/**
 * AudioWorkletProcessor for the click-free interpolating HRTF renderer.
 *
 * It owns one `HrtfDsp` (the pure engine in interpolatingDsp.ts). The min-phase
 * HRIR data + ITD arrays are transferred ONCE at construction via processorOptions
 * (structured clone of Float32Arrays — works WITHOUT cross-origin isolation, so our
 * engine never needs COOP/COEP, unlike Steam Audio).
 *
 * Each render block: read the latest head-relative direction (posted from the main
 * thread on every pose update), recompute the interpolated IR (continuous, never
 * reset), and convolve the mono input → stereo output. No node swaps, no convolver
 * restarts → no click.
 */
import { HrtfDsp, type MinPhaseHrtf } from './interpolatingDsp';

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: any): void;
declare const AudioWorkletProcessor: {
  new (): { readonly port: MessagePort };
};

class HrtfProcessor extends AudioWorkletProcessor {
  private dsp: HrtfDsp;
  private dir: [number, number, number] = [0, 0, -1];
  // NEAR-FIELD per-ear ILD gains (r_ref/r_ear correction; 1 = no correction = at the
  // measurement shell). Targets posted from setPosition; the current values glide toward
  // them per-sample so a moving source doesn't zipper. Default 1 (no-op) until posted.
  private earGainL = 1; private earGainR = 1;
  private earTargetL = 1; private earTargetR = 1;

  private k: number;
  // IDLE EARLY-OUT. A reflection slot spends most of its life at zero gain (only a
  // handful of the pooled slots carry an active reflection at any moment), yet the
  // full 256-tap convolution ran every quantum regardless — the dominant waste in a
  // multi-source scene. We skip the DSP for a block when BOTH: (a) the input block is
  // all-zero, and (b) the convolution tail has already fully drained (the last `taps`
  // input samples were zero, so the FIR output is provably zero) and the ear-gain
  // glide has settled. Resuming is click-free: the history ring is all zeros after an
  // idle gap, so the first live block convolves cleanly up from silence. Tracks the
  // run of trailing zero-input samples so we never skip while the tail is still ringing.
  private zeroRun = Number.MAX_SAFE_INTEGER;

  constructor(options: { processorOptions: { mp: MinPhaseHrtf; k?: number } }) {
    super();
    const { mp, k } = options.processorOptions;
    this.k = k ?? 4;
    this.dsp = new HrtfDsp(mp, this.k);
    (this as any).port.onmessage = (e: MessageEvent) => {
      const d = e.data;
      if (d && d.type === 'dir') {
        this.dir[0] = d.x; this.dir[1] = d.y; this.dir[2] = d.z;
      } else if (d && d.type === 'earGains') {
        this.earTargetL = d.left; this.earTargetR = d.right;
      } else if (d && d.type === 'mp') {
        // Live HRIR-table swap (e.g. a personalization re-warp): replace the DSP in
        // place, REUSING this processor. This is what lets the free-play knobs update
        // without creating a new AudioWorkletNode per change (which leaked multi-MB
        // processors on the audio thread until it choked).
        this.dsp = new HrtfDsp(d.mp, this.k);
      }
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length < 2) return true;
    const outL = output[0];
    const outR = output[1];
    const n = outL.length;
    // mono input (use channel 0; silence if disconnected)
    const inCh = input && input[0] ? input[0] : null;

    // Is this input block EXACTLY zero? (Lossless test — not a quiet-gate. Any
    // non-zero sample, however faint, fails this and renders in full, so a barely
    // audible reflection is never dropped.) A disconnected input reads as null =
    // silence.
    let blockZero = true;
    if (inCh) {
      for (let i = 0; i < n; i++) {
        if (inCh[i] !== 0) { blockZero = false; break; }
      }
    }

    // EARLY-OUT: skip the DSP for this block iff its output is PROVABLY all zeros.
    // That needs the tail already fully drained BEFORE this block — i.e. the run of
    // trailing zero-input samples entering the block is >= taps, so no non-zero input
    // still lies within the FIR window at ANY sample of the block — AND this block's
    // input is itself all zero. Evaluate against the PRIOR run (before folding in this
    // block); otherwise the FIRST zero block after a tone would falsely qualify while
    // its early samples still convolve the tone's tail. Result: exactly one "tail"
    // block renders after signal stops, then subsequent silent blocks are skipped —
    // lossless (0 × any IR × any ear gain = 0), so no faint reflection is ever dropped.
    const taps = this.dsp.taps;
    const drainedBefore = this.zeroRun >= taps;

    // Update the trailing-zero run for next time (saturating to avoid overflow).
    if (blockZero) {
      this.zeroRun = this.zeroRun >= taps ? taps : this.zeroRun + n;
    } else {
      this.zeroRun = 0;
    }

    if (blockZero && drainedBefore) {
      // Snap the ear-gain glide to target while idle — nothing to scale, and the next
      // non-silent block then resumes at the settled gain (click-free, from silence).
      this.earGainL = this.earTargetL;
      this.earGainR = this.earTargetR;
      return true;
    }

    const mono = inCh ?? new Float32Array(n);
    this.dsp.setDirection(this.dir[0], this.dir[1], this.dir[2]);
    this.dsp.process(mono, outL, outR);
    // Apply the near-field per-ear gain, gliding toward the target each sample (one-pole,
    // ~5 ms at 48 kHz) so abrupt gain changes between messages don't click.
    const a = 0.0005;
    let gl = this.earGainL, gr = this.earGainR;
    const tl = this.earTargetL, tr = this.earTargetR;
    for (let i = 0; i < n; i++) {
      gl += (tl - gl) * a; gr += (tr - gr) * a;
      outL[i] *= gl; outR[i] *= gr;
    }
    this.earGainL = gl; this.earGainR = gr;
    return true;
  }
}

registerProcessor('hrtf-interpolating', HrtfProcessor);
