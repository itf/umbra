/**
 * Reusable loudness helpers for baked .hrtf files. A PURE SCALAR level match: measure a
 * head's global RMS over ALL directions/taps/ears and rescale every IR sample by a single
 * gain so it matches a reference head's global RMS. This preserves each head's spectral +
 * directional shape (it's one number applied uniformly) — it is NOT diffuse-field EQ.
 *
 * WHY: different HRTF databases are normalized differently, so raw baked heads have wildly
 * different absolute loudness (e.g. HUTUBS ~3–4× SADIE, some peaking past 1.0 → clipping).
 * In the calibration A/B that reads as "a different, LOUDER probe" instead of a spatial
 * difference. Matching diffuse-field loudness makes the A/B about localization only.
 *
 * .hrtf layout (little-endian): magic 'HRTF'(4), version u32, sampleRate f32, M u32(dirs),
 *   N u32(taps), then M*[az,el] f32, then M*2*N f32 IR samples (L then R per direction).
 */
import { readFileSync, writeFileSync } from 'node:fs';

/** Parse a baked .hrtf into a mutable view. `irs` is a Float32Array over all samples. */
export function readHrtf(path) {
  const buf = readFileSync(path);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'HRTF') throw new Error(`not an HRTF file: ${path} (${magic})`);
  let o = 4;
  const version = dv.getUint32(o, true); o += 4;
  const sampleRate = dv.getFloat32(o, true); o += 4;
  const M = dv.getUint32(o, true); o += 4;
  const N = dv.getUint32(o, true); o += 4;
  const posBytes = M * 2 * 4;
  const posOffset = o;
  o += posBytes;
  const nSamples = M * 2 * N;
  const irs = new Float32Array(nSamples);
  for (let i = 0; i < nSamples; i++) { irs[i] = dv.getFloat32(o, true); o += 4; }
  return { version, sampleRate, M, N, posOffset, posBytes, dv, buf, irs };
}

/** Global RMS over every sample (all directions, taps, ears). */
export function globalRms(irs) {
  let s = 0;
  for (let i = 0; i < irs.length; i++) s += irs[i] * irs[i];
  return Math.sqrt(s / irs.length);
}

/** Peak absolute sample. */
export function peak(irs) {
  let p = 0;
  for (let i = 0; i < irs.length; i++) { const a = Math.abs(irs[i]); if (a > p) p = a; }
  return p;
}

/** Write a .hrtf back out with new IR samples, copying header + positions verbatim. */
export function writeHrtf(path, h, irs) {
  const headerBytes = 4 + 4 + 4 + 4 + 4;
  const out = new ArrayBuffer(headerBytes + h.posBytes + irs.length * 4);
  const ov = new DataView(out);
  let p = 0;
  for (const c of 'HRTF') ov.setUint8(p++, c.charCodeAt(0));
  ov.setUint32(p, h.version, true); p += 4;
  ov.setFloat32(p, h.sampleRate, true); p += 4;
  ov.setUint32(p, h.M, true); p += 4;
  ov.setUint32(p, h.N, true); p += 4;
  for (let i = 0; i < h.posBytes; i++) ov.setUint8(p + i, h.dv.getUint8(h.posOffset + i));
  p += h.posBytes;
  for (let i = 0; i < irs.length; i++) { ov.setFloat32(p, irs[i], true); p += 4; }
  writeFileSync(path, Buffer.from(out));
}

/** Rescale head at `path` by scalar gain (in place). Returns {before,after} RMS+peak. */
export function normalizeHrtfTo(path, refRms) {
  const h = readHrtf(path);
  const before = { rms: globalRms(h.irs), peak: peak(h.irs) };
  const gain = refRms / (before.rms || 1);
  for (let i = 0; i < h.irs.length; i++) h.irs[i] *= gain;
  const after = { rms: globalRms(h.irs), peak: peak(h.irs) };
  writeHrtf(path, h, h.irs);
  return { gain, before, after };
}
