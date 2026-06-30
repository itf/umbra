/**
 * clickRecorder — record a mouth click from the microphone and process it into a
 * clean short probe buffer for use as an echolocation excitation signal.
 *
 * The DSP helpers are PURE (no mic, no AudioContext) so they can be unit-tested on
 * synthetic Float32Arrays. The async `record()` function is the only impure part;
 * it calls getUserMedia and is NOT imported or invoked in any test path.
 *
 * Trim window: 5 ms before peak → 45 ms after peak (mouth clicks run up to ~50 ms).
 * Fade: 2 ms linear ramp at each edge (avoids audible edge clicks).
 * Normalization: peak-normalized to 0.9.
 */

// ---------------------------------------------------------------------------
// Pure DSP helpers — exported for unit tests
// ---------------------------------------------------------------------------

/** Find the index of the sample with the maximum absolute value. */
export function findPeakIndex(buf: Float32Array): number {
  let best = 0;
  let bestAbs = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i]);
    if (a > bestAbs) { bestAbs = a; best = i; }
  }
  return best;
}

/**
 * Trim a window around the peak: `preSamples` before the peak, `postSamples`
 * after. Clamped at array bounds so a peak near the start or end never goes OOB.
 * Returns a NEW Float32Array (does not mutate `buf`).
 */
export function trimAroundPeak(
  buf: Float32Array,
  peakIndex: number,
  preSamples: number,
  postSamples: number,
): Float32Array {
  const start = Math.max(0, peakIndex - preSamples);
  const end   = Math.min(buf.length, peakIndex + postSamples + 1);
  return buf.slice(start, end);
}

/**
 * Apply a short linear fade-in and fade-out to `buf` (in-place).
 * `fadeSamples` is the ramp length in samples; clamped to half the buffer length.
 */
export function applyFades(buf: Float32Array, fadeSamples: number): void {
  const fade = Math.min(fadeSamples, Math.floor(buf.length / 2));
  for (let i = 0; i < fade; i++) {
    const g = i / fade;
    buf[i]              *= g;
    buf[buf.length - 1 - i] *= g;
  }
}

/**
 * Peak-normalize `buf` to `targetPeak` (default 0.9). In-place.
 * No-op if the buffer is silent (all zeros).
 */
export function peakNormalize(buf: Float32Array, targetPeak = 0.9): void {
  let peak = 0;
  for (const x of buf) { const a = Math.abs(x); if (a > peak) peak = a; }
  if (peak === 0) return;
  const scale = targetPeak / peak;
  for (let i = 0; i < buf.length; i++) buf[i] *= scale;
}

/**
 * Full pure pipeline: find peak → trim → fade → normalize.
 * Returns a new processed Float32Array.
 *
 * @param raw        Mono Float32Array from the microphone capture
 * @param sampleRate Sample rate of `raw`
 * @param preMs      Window before peak in ms (default 5)
 * @param postMs     Window after  peak in ms (default 45)
 * @param fadeMs     Fade-in/out duration in ms (default 2)
 */
export function processClickBuffer(
  raw: Float32Array,
  sampleRate: number,
  preMs  = 5,
  postMs = 45,
  fadeMs = 2,
): Float32Array {
  const peakIdx     = findPeakIndex(raw);
  const preSamples  = Math.round((preMs  / 1000) * sampleRate);
  const postSamples = Math.round((postMs / 1000) * sampleRate);
  const fadeSamples = Math.round((fadeMs / 1000) * sampleRate);
  const trimmed = trimAroundPeak(raw, peakIdx, preSamples, postSamples);
  applyFades(trimmed, fadeSamples);
  peakNormalize(trimmed);
  return trimmed;
}

// ---------------------------------------------------------------------------
// Impure: mic capture — kept behind a function so import never touches hardware
// ---------------------------------------------------------------------------

/** Duration in seconds of the mic capture window. */
const CAPTURE_DURATION_S = 1.0;

/**
 * Record ~1 s from the microphone, process it through the click pipeline, and
 * return a mono AudioBuffer ready for use as a probe.
 *
 * Rejects with a descriptive Error on permission-denied or no-mic situations.
 * Always stops mic tracks when done (success or failure).
 *
 * @param audioCtx  An AudioContext used only to wrap the result as an AudioBuffer.
 */
export async function record(audioCtx: AudioContext): Promise<AudioBuffer> {
  let stream: MediaStream | null = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (err: unknown) {
    const msg =
      err instanceof DOMException && err.name === 'NotAllowedError'
        ? 'Microphone access denied. Grant permission and try again.'
        : err instanceof DOMException && err.name === 'NotFoundError'
          ? 'No microphone found on this device.'
          : `Could not access the microphone: ${err instanceof Error ? err.message : String(err)}`;
    throw new Error(msg);
  }

  try {
    // Record via MediaRecorder (avoids OfflineAudioContext.createMediaStreamSource
    // which is not available in all browsers and not in the TS lib typings).
    // After CAPTURE_DURATION_S we stop, collect the blobs, decode via decodeAudioData,
    // then run the pure pipeline on the resulting PCM.
    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

    await new Promise<void>((resolve, reject) => {
      recorder.onerror = (e) => reject(new Error(`MediaRecorder error: ${(e as ErrorEvent).message ?? 'unknown'}`));
      recorder.onstop = () => resolve();
      recorder.start();
      setTimeout(() => recorder.stop(), CAPTURE_DURATION_S * 1000);
    });

    const blob = new Blob(chunks, { type: chunks[0]?.type ?? 'audio/webm' });
    const arrayBuf = await blob.arrayBuffer();
    const decoded = await audioCtx.decodeAudioData(arrayBuf);

    // Mix down to mono (sum channels / count) and run the pure pipeline.
    const nCh = decoded.numberOfChannels;
    const nSamples = decoded.length;
    const mono = new Float32Array(nSamples);
    for (let ch = 0; ch < nCh; ch++) {
      const chData = decoded.getChannelData(ch);
      for (let i = 0; i < nSamples; i++) mono[i] += chData[i];
    }
    if (nCh > 1) for (let i = 0; i < nSamples; i++) mono[i] /= nCh;

    const processed = processClickBuffer(mono, decoded.sampleRate);

    // Wrap the processed Float32Array in a real AudioBuffer.
    // `new Float32Array(processed)` copies into a plain ArrayBuffer, satisfying
    // the AudioBuffer.copyToChannel signature (which requires ArrayBuffer-backed).
    const out = audioCtx.createBuffer(1, processed.length, decoded.sampleRate);
    out.copyToChannel(new Float32Array(processed), 0);
    return out;
  } finally {
    for (const track of stream.getTracks()) track.stop();
  }
}
