/**
 * Runtime side of the CIPIC magnitude-PCA model (baked by scripts/bake-hrtf-pca.mjs).
 *
 * The bake produced: a MEAN log-magnitude head + K principal eigen-deformations, over
 * a CIPIC direction grid × downsampled magnitude bins. This module loads that asset and
 * applies a weighted deformation to a min-phase HRTF set's MAGNITUDE (never its timing —
 * ITD stays separate), giving a "morph along how real ears vary" warp that the A/B
 * localization search tunes via the weight vector.
 *
 * Applying PCA is a per-direction magnitude EQ: for each of our set's directions we
 * find the nearest CIPIC grid direction, build its deformation curve
 *   Δlogmag(bin) = Σ wᵢ·eigScaleᵢ·eig[dir][bin]
 * interpolate that curve across the FFT and multiply the min-phase IR's spectrum by
 * exp(Δlogmag). Kept approximate + cheap (a short cosine-domain nudge, like the
 * brightness tilt) so it runs over all directions at bake time with zero runtime cost.
 *
 * The parsing + nearest-direction + curve math are pure and unit-tested; the spectral
 * application reuses the FFT already in interpolatingDsp.
 */

import { assetUrl } from '../baseUrl';

export interface HrtfPcaModel {
  subjects: number;
  dirs: number;
  bins: number;
  k: number;
  az: number[];
  el: number[];
  /** Mean log-magnitude, [dirs*bins]. */
  mean: Float32Array;
  /** Per-PC: eigScale (std-dev weight unit) and the dequantized eigenvector [dirs*bins]. */
  pcs: { scale: number; vec: Float32Array }[];
  /** CIPIC grid dims. */
  gridAz: number;
  gridEl: number;
}

/** Default URL of the baked PCA model (copied into the assets tree). */
export const PCA_MODEL_URL = assetUrl('assets/hrtf/cipic_pca.bin');

let pcaModelCache: Promise<HrtfPcaModel | null> | null = null;
/** Fetch + parse the PCA model once (cached). Resolves null if the asset is missing
 *  or malformed, so callers degrade to no-PCA rather than break. */
export async function loadPcaModel(url: string = PCA_MODEL_URL): Promise<HrtfPcaModel | null> {
  if (!pcaModelCache) {
    pcaModelCache = (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const buf = await res.arrayBuffer();
        return parsePcaModel(buf);
      } catch {
        return null;
      }
    })();
  }
  return pcaModelCache;
}

/** Parse the .bin produced by bake-hrtf-pca.mjs. Throws on bad magic/version. */
export function parsePcaModel(buf: ArrayBuffer): HrtfPcaModel {
  const dv = new DataView(buf);
  let o = 0;
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'HPCA') throw new Error('bad PCA magic: ' + magic);
  o = 4;
  const ver = dv.getUint32(o, true); o += 4;
  if (ver !== 1) throw new Error('unsupported PCA version ' + ver);
  const subjects = dv.getUint32(o, true); o += 4;
  const dirs = dv.getUint32(o, true); o += 4;
  const bins = dv.getUint32(o, true); o += 4;
  const k = dv.getUint32(o, true); o += 4;
  const gridAz = dv.getUint32(o, true); o += 4;
  const gridEl = dv.getUint32(o, true); o += 4;
  const az: number[] = [];
  for (let i = 0; i < gridAz; i++) { az.push(dv.getFloat32(o, true)); o += 4; }
  const el: number[] = [];
  for (let i = 0; i < gridEl; i++) { el.push(dv.getFloat32(o, true)); o += 4; }
  const feat = dirs * bins;
  const mean = new Float32Array(feat);
  for (let i = 0; i < feat; i++) { mean[i] = dv.getFloat32(o, true); o += 4; }
  const pcs: { scale: number; vec: Float32Array }[] = [];
  for (let kk = 0; kk < k; kk++) {
    const scale = dv.getFloat32(o, true); o += 4;
    const q = dv.getFloat32(o, true); o += 4;
    const vec = new Float32Array(feat);
    for (let i = 0; i < feat; i++) { vec[i] = (dv.getInt8(o) / 127) * q; o += 1; }
    pcs.push({ scale, vec });
  }
  return { subjects, dirs, bins, k, az, el, mean, pcs, gridAz, gridEl };
}

/** Convert an engine unit vector (+x right, +y up, −z front) to CIPIC-style az/el degrees. */
export function vecToCipicAzEl(x: number, y: number, z: number): { az: number; el: number } {
  // CIPIC interaural-polar: azimuth is left(−)/right(+) lateral angle, elevation is the
  // polar angle in the median plane. Approximate with standard spherical for nearest-dir:
  const el = Math.asin(Math.max(-1, Math.min(1, y))) * (180 / Math.PI);
  const az = Math.atan2(x, -z) * (180 / Math.PI); // 0 front, + right
  return { az, el };
}

/** Index of the nearest CIPIC grid direction (az-major, matching the bake's a + AZ*e). */
export function nearestDirIndex(model: HrtfPcaModel, azDeg: number, elDeg: number): number {
  let bestA = 0, bestE = 0, bd = Infinity;
  for (let a = 0; a < model.gridAz; a++) {
    const da = Math.abs(wrapDeg(model.az[a] - azDeg));
    for (let e = 0; e < model.gridEl; e++) {
      const de = Math.abs(model.el[e] - elDeg);
      const d = da + de;
      if (d < bd) { bd = d; bestA = a; bestE = e; }
    }
  }
  return bestA + model.gridAz * bestE;
}

function wrapDeg(d: number): number {
  let x = d % 360;
  if (x > 180) x -= 360;
  if (x < -180) x += 360;
  return x;
}

/**
 * The per-direction log-magnitude DEFORMATION curve (length `bins`) for a given weight
 * vector, at CIPIC direction `dirIdx`: Σ wᵢ·scaleᵢ·eig. Weights are in std-dev units
 * (±2 ≈ the extremes of real ears). This is what gets interpolated across the spectrum
 * and applied as exp(Δ) to the min-phase magnitude.
 */
export function deformationCurve(model: HrtfPcaModel, weights: number[], dirIdx: number): Float32Array {
  const out = new Float32Array(model.bins);
  const base = dirIdx * model.bins;
  for (let kk = 0; kk < model.k; kk++) {
    const w = weights[kk] ?? 0;
    if (w === 0) continue;
    const { scale, vec } = model.pcs[kk];
    const gain = w * scale;
    for (let b = 0; b < model.bins; b++) out[b] += gain * vec[base + b];
  }
  return out;
}
