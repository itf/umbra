/**
 * Runtime side of the magnitude-PCA model (HUTUBS-derived, baked by
 * scripts/bake-hrtf-pca-hutubs.mjs; legacy CIPIC bake was scripts/bake-hrtf-pca.mjs).
 *
 * The bake produced: a MEAN log-magnitude head + K principal eigen-deformations, over
 * a direction grid × downsampled magnitude bins. This module loads that asset and
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
  /** Per-PC: eigScale (std-dev weight unit), the dequantized eigenvector [dirs*bins], the
   *  application KIND — 0 = magnitude (deform every direction by +weight·eig), 1 = front/back
   *  CONTRAST (hemisphere-signed: +weight·eig front, −weight·eig back) — and a short
   *  user-facing NAME for the manual knobs. v1/v2 have no kind byte → all magnitude; v1–v3
   *  have no name → a generic `Real-ear shape N` default is filled in. */
  pcs: { scale: number; vec: Float32Array; kind: number; name: string }[];
  /** Grid dims. For a FLAT per-direction grid (HUTUBS bake, v2) both equal `dirs` and
   *  `az`/`el` hold one entry per direction; for the legacy factored grid (CIPIC v1)
   *  they are the AZ/EL axis lengths and dir index = a + gridAz*e. */
  gridAz: number;
  gridEl: number;
  /** true when az/el are per-direction (flat) rather than a factored AZ×EL grid. */
  flatGrid: boolean;
  /** Bake FFT size; the feature log-frequency spacing uses HALF-1 = nfft/2 as its base.
   *  Legacy v1 models had no field → default 256. */
  nfft: number;
}

/** Default URL of the baked PCA model (HUTUBS-derived; copied into the assets tree). */
export const PCA_MODEL_URL = assetUrl('assets/hrtf/hrtf_pca.bin');

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

/** PC application kinds (mirrors KIND_* in scripts/bake-hrtf-pca-ss2.mjs). */
export const PC_KIND_MAGNITUDE = 0;
export const PC_KIND_FRONTBACK = 1;


/** Parse the .bin produced by the PCA bake. Throws on bad magic/version.
 *  v1 = legacy CIPIC (factored grid, no NFFT); v2 = flat grid + NFFT; v3 = + per-PC kind;
 *  v4 = + per-PC name (length-prefixed UTF-8). */
export function parsePcaModel(buf: ArrayBuffer): HrtfPcaModel {
  const dv = new DataView(buf);
  let o = 0;
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'HPCA') throw new Error('bad PCA magic: ' + magic);
  o = 4;
  const ver = dv.getUint32(o, true); o += 4;
  if (ver < 1 || ver > 4) throw new Error('unsupported PCA version ' + ver);
  // v2+ inserts NFFT right after the version; v1 (legacy CIPIC) had no such field → 256.
  let nfft = 256;
  if (ver >= 2) { nfft = dv.getUint32(o, true); o += 4; }
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
  const pcs: { scale: number; vec: Float32Array; kind: number; name: string }[] = [];
  for (let kk = 0; kk < k; kk++) {
    const scale = dv.getFloat32(o, true); o += 4;
    const q = dv.getFloat32(o, true); o += 4;
    // v3+ stores a KIND byte before each eigenvector; v1/v2 have none → magnitude.
    const kind = ver >= 3 ? dv.getUint8(o++) : PC_KIND_MAGNITUDE;
    // v4+ stores a length-prefixed UTF-8 NAME; older versions get a generic default.
    let name = `Real-ear shape ${kk + 1}`;
    if (ver >= 4) {
      const nameLen = dv.getUint8(o++);
      if (nameLen > 0) {
        name = new TextDecoder().decode(new Uint8Array(buf, o, nameLen));
        o += nameLen;
      }
    }
    const vec = new Float32Array(feat);
    for (let i = 0; i < feat; i++) { vec[i] = (dv.getInt8(o) / 127) * q; o += 1; }
    pcs.push({ scale, vec, kind, name });
  }
  // Flat grid (v2/HUTUBS): az & el are per-direction and both lengths equal `dirs`.
  const flatGrid = gridAz === dirs && gridEl === dirs && az.length === dirs;
  return { subjects, dirs, bins, k, az, el, mean, pcs, gridAz, gridEl, flatGrid, nfft };
}

/**
 * Map a normalized FFT frequency (bin/half, 0..1) to a fractional PCA curve-index
 * (0..bins-1), inverting the LOG-spaced sampling the bake used to build the features.
 *
 * The bake (toLogMagFeature) placed feature bin `b` at FFT index
 * `idx = 1 + (HALF-2)·(pow(HALF-1,frac)-1)/(HALF-2) = pow(HALF-1, frac)`, with
 * frac = b/(bins-1) and HALF = NFFT/2+1 → base = HALF-1 = NFFT/2. So the feature grid is
 * geometrically spaced: fnorm(b) = idx/(HALF-1) = base^(frac-1). Inverting for a given
 * normalized frequency fnorm gives frac = 1 + ln(fnorm)/ln(base), and the fractional
 * curve index is frac·(bins-1). Runtime nfft can differ from the bake's — this is
 * expressed purely in normalized frequency, so it stays correct at any runtime FFT size;
 * `base` (the bake's NFFT/2) comes from the model header (v1 CIPIC = 256/2 = 128,
 * v2 HUTUBS = 512/2 = 256).
 *
 * Reading the curve back with a LINEAR map (the old bug) landed every deformation at the
 * wrong frequency — e.g. a bump the bake stored for ~2 kHz got applied near ~10 kHz.
 */
export function normFreqToCurveIndex(fnorm: number, bins: number, bakeNfft: number): number {
  const base = bakeNfft / 2; // HALF-1
  // Clamp away from 0 (log(0) = -inf) using the smallest representable bake grid point.
  const f = Math.max(1 / base, Math.min(1, fnorm));
  const frac = 1 + Math.log(f) / Math.log(base); // 0..1 over the bake's log grid
  return Math.max(0, Math.min(bins - 1, frac * (bins - 1)));
}

/** Convert an engine unit vector (+x right, +y up, −z front) to az/el degrees
 *  (0° az = front, + az = right; el = elevation). Matches the grid stored by the bake. */
export function vecToAzEl(x: number, y: number, z: number): { az: number; el: number } {
  const el = Math.asin(Math.max(-1, Math.min(1, y))) * (180 / Math.PI);
  const az = Math.atan2(x, -z) * (180 / Math.PI); // 0 front, + right
  return { az, el };
}

/** Index of the nearest grid direction. Flat grid (v2): scan per-direction az/el.
 *  Factored grid (v1): scan the AZ and EL axes and combine as a + gridAz*e. */
export function nearestDirIndex(model: HrtfPcaModel, azDeg: number, elDeg: number): number {
  if (model.flatGrid) {
    let best = 0, bd = Infinity;
    for (let d = 0; d < model.dirs; d++) {
      const da = Math.abs(wrapDeg(model.az[d] - azDeg));
      const de = Math.abs(model.el[d] - elDeg);
      const dist = da + de;
      if (dist < bd) { bd = dist; best = d; }
    }
    return best;
  }
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
 * vector, at grid direction `dirIdx`: Σ wᵢ·scaleᵢ·eig. Weights are in std-dev units
 * (±2 ≈ the extremes of real ears). Interpolated across the spectrum and applied as exp(Δ)
 * to the min-phase magnitude.
 *
 * FRONT/BACK CONTRAST PCs (kind PC_KIND_FRONTBACK) are applied HEMISPHERE-SIGNED: the
 * contrast axis pushes front and back OPPOSITE ways, so their contribution is multiplied by
 * `hemisphereSign` (+1 for a front direction, −1 for back; ~0 near the median plane). The
 * caller passes the sign for `dirIdx`'s hemisphere; magnitude PCs ignore it. Default +1
 * keeps the old (all-magnitude) behavior for callers that don't compute a sign.
 */
export function deformationCurve(
  model: HrtfPcaModel, weights: number[], dirIdx: number, hemisphereSign = 1,
): Float32Array {
  const out = new Float32Array(model.bins);
  const base = dirIdx * model.bins;
  for (let kk = 0; kk < model.k; kk++) {
    const w = weights[kk] ?? 0;
    if (w === 0) continue;
    const { scale, vec, kind } = model.pcs[kk];
    const gain = w * scale * (kind === PC_KIND_FRONTBACK ? hemisphereSign : 1);
    for (let b = 0; b < model.bins; b++) out[b] += gain * vec[base + b];
  }
  return out;
}
