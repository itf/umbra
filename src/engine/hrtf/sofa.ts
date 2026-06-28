/**
 * Loader for the pre-baked compact HRTF binary (see scripts/bake-hrtf.mjs).
 * No HDF5 in the browser — just a flat little-endian read and a direction index.
 *
 * Direction convention (from SADIE/SOFA SourcePosition):
 *   azimuth°   : anti-clockwise (to the LEFT), 0° = front, 90° = left, 270° = right
 *   elevation° : 0° = horizontal, +up, -down
 */

export interface HrtfSet {
  sampleRate: number;
  taps: number; // IR length per ear
  count: number; // number of measured directions
  /** Measured directions as unit vectors in listener space (+x right, +y up, -z fwd). */
  dirs: Float32Array; // count * 3
  /** Left/right impulse responses, interleaved per direction: [L0..Ln, R0..Rn] * count. */
  irs: Float32Array; // count * 2 * taps
}

/** Convert SOFA spherical (az anti-clockwise/left, el) to a listener-space unit vector. */
export function sphericalToVec(azDeg: number, elDeg: number): [number, number, number] {
  const az = (azDeg * Math.PI) / 180;
  const el = (elDeg * Math.PI) / 180;
  const ce = Math.cos(el);
  // az=0 -> front (-z). az=90 (left) -> +x is RIGHT, so left is -x.
  // x = -sin(az)*cos(el) makes az=90 give x=-1 (left). y = sin(el). z = -cos(az)*cos(el).
  const x = -Math.sin(az) * ce;
  const y = Math.sin(el);
  const z = -Math.cos(az) * ce;
  return [x, y, z];
}

export async function loadHrtf(url: string): Promise<HrtfSet> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HRTF fetch failed: ${res.status} ${url}`);
  const buf = await res.arrayBuffer();
  const dv = new DataView(buf);

  let o = 0;
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'HRTF') throw new Error(`bad HRTF magic: ${magic}`);
  o += 4;
  const version = dv.getUint32(o, true); o += 4;
  if (version !== 1) throw new Error(`unsupported HRTF version ${version}`);
  const sampleRate = dv.getFloat32(o, true); o += 4;
  const count = dv.getUint32(o, true); o += 4;
  const taps = dv.getUint32(o, true); o += 4;

  const dirs = new Float32Array(count * 3);
  for (let m = 0; m < count; m++) {
    const az = dv.getFloat32(o, true); o += 4;
    const el = dv.getFloat32(o, true); o += 4;
    const [x, y, z] = sphericalToVec(az, el);
    dirs[m * 3] = x;
    dirs[m * 3 + 1] = y;
    dirs[m * 3 + 2] = z;
  }

  // IRs are contiguous Float32 from here; view directly without copying per-tap.
  const irs = new Float32Array(buf, o, count * 2 * taps);

  return { sampleRate, taps, count, dirs, irs };
}

/**
 * Find the index of the measured direction nearest to a query unit vector,
 * by maximum dot product. Linear scan over ~2800 dirs is ~microseconds and only
 * runs when a source's direction bucket changes, so an index/KD-tree isn't worth
 * the complexity yet.
 */
export function nearestDir(set: HrtfSet, x: number, y: number, z: number): number {
  let best = -1;
  let bestDot = -Infinity;
  const d = set.dirs;
  for (let m = 0; m < set.count; m++) {
    const dot = d[m * 3] * x + d[m * 3 + 1] * y + d[m * 3 + 2] * z;
    if (dot > bestDot) {
      bestDot = dot;
      best = m;
    }
  }
  return best;
}

/** Copy the L/R IR pair for a direction index into two Float32Arrays (length = taps). */
export function getIrPair(set: HrtfSet, index: number): { left: Float32Array; right: Float32Array } {
  const stride = 2 * set.taps;
  const base = index * stride;
  const left = set.irs.subarray(base, base + set.taps);
  const right = set.irs.subarray(base + set.taps, base + 2 * set.taps);
  return { left, right };
}
