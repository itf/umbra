/**
 * Orchestrator: turn the user's saved personalization into an in-memory SOFA the
 * PRIMARY (Steam Audio) engine can load as a custom HRTF.
 *
 * Pipeline (all offline, once at level start or on export):
 *   load base HrtfSet → precomputeMinPhase → personalizeMinPhase(warp)
 *     → reconstructHrtf (min-phase + ITD → full HRIRs) → writeSofa (h5wasm)
 *
 * The result is an ArrayBuffer of a SimpleFreeFieldHRIR SOFA at the base set's sample
 * rate (our SADIE/CIPIC assets are 48 kHz, which is what Steam expects). Handing this
 * to SteamAudioBackend.create({ personalizedSofa }) makes Steam spatialize with the
 * user's own tuned ears. If the personalization is neutral this still produces a valid
 * SOFA of the unmodified base — callers that want "default HRTF" should simply NOT call
 * this (pass nothing), which reverts Steam to its normal path.
 */
import { loadHrtf } from './sofa';
import { precomputeMinPhase } from './interpolatingDsp';
import { personalizeMinPhase, personalizePcaMinPhase, pcaIsNeutral, type HrtfPersonalization } from './personalize';
import { loadPcaModel } from './hrtfPca';
import { reconstructHrtf } from './sofaExport';
import { writeSofa } from './sofaWrite';

/** Build a personalized SOFA ArrayBuffer from a base HRTF URL + warp. */
export async function buildPersonalizedSofa(
  baseHrtfUrl: string,
  warp: HrtfPersonalization,
): Promise<ArrayBuffer> {
  const set = await loadHrtf(baseHrtfUrl);
  const baseMp = precomputeMinPhase(set);
  let warpedMp = personalizeMinPhase(baseMp, warp);
  // PCA refinement (real-ear magnitude morph) composes on top when weights are present.
  if (!pcaIsNeutral(warp.pcaWeights)) {
    const model = await loadPcaModel();
    if (model) warpedMp = personalizePcaMinPhase(warpedMp, model, warp.pcaWeights!, warp.frontBackBias ?? 0);
  }
  const rec = reconstructHrtf(warpedMp);
  const bytes = await writeSofa(rec, { title: 'Personalized HRTF (Umbra)' });
  // Return a standalone ArrayBuffer (the FS view may be backed by the WASM heap).
  return bytes.slice().buffer;
}
