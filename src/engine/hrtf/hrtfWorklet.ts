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

  constructor(options: { processorOptions: { mp: MinPhaseHrtf; k?: number } }) {
    super();
    const { mp, k } = options.processorOptions;
    this.dsp = new HrtfDsp(mp, k ?? 4);
    (this as any).port.onmessage = (e: MessageEvent) => {
      const d = e.data;
      if (d && d.type === 'dir') {
        this.dir[0] = d.x; this.dir[1] = d.y; this.dir[2] = d.z;
      } else if (d && d.type === 'earGains') {
        this.earTargetL = d.left; this.earTargetR = d.right;
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
