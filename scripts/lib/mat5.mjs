/**
 * Minimal MATLAB level-5 MAT-file reader — just enough to pull the numeric arrays we
 * need from the CIPIC `hrir_final.mat` files (uncompressed miMATRIX elements). Not a
 * general reader: handles real numeric arrays (double/single/int) with names, which is
 * all CIPIC uses. No compression, no structs/cells beyond top level.
 *
 * Returns a map of variable name → { dims, data: Float64Array } (data in MATLAB's
 * column-major order, as stored).
 */
import { readFileSync } from 'node:fs';

const miINT8 = 1, miUINT8 = 2, miINT16 = 3, miUINT16 = 4, miINT32 = 5, miUINT32 = 6,
  miSINGLE = 7, miDOUBLE = 9, miMATRIX = 14;

function readTag(buf, o) {
  // Small-element form: upper 16 bits of first word hold nbytes when nonzero.
  const first = buf.readUInt32LE(o);
  const smallNBytes = (first >>> 16) & 0xffff;
  if (smallNBytes !== 0) {
    return { dtype: first & 0xffff, nbytes: smallNBytes, dataOffset: o + 4, next: o + 8 };
  }
  const dtype = first;
  const nbytes = buf.readUInt32LE(o + 4);
  const padded = nbytes + ((8 - (nbytes % 8)) % 8);
  return { dtype, nbytes, dataOffset: o + 8, next: o + 8 + padded };
}

function readNumeric(buf, tag) {
  const { dtype, nbytes, dataOffset } = tag;
  const n = (t) => {
    switch (t) {
      case miINT8: return { size: 1, get: (o) => buf.readInt8(o) };
      case miUINT8: return { size: 1, get: (o) => buf.readUInt8(o) };
      case miINT16: return { size: 2, get: (o) => buf.readInt16LE(o) };
      case miUINT16: return { size: 2, get: (o) => buf.readUInt16LE(o) };
      case miINT32: return { size: 4, get: (o) => buf.readInt32LE(o) };
      case miUINT32: return { size: 4, get: (o) => buf.readUInt32LE(o) };
      case miSINGLE: return { size: 4, get: (o) => buf.readFloatLE(o) };
      case miDOUBLE: return { size: 8, get: (o) => buf.readDoubleLE(o) };
      default: throw new Error('unsupported numeric dtype ' + t);
    }
  };
  const { size, get } = n(dtype);
  const count = nbytes / size;
  const out = new Float64Array(count);
  for (let i = 0; i < count; i++) out[i] = get(dataOffset + i * size);
  return out;
}

/** Parse one miMATRIX element starting at `o`; returns {name, dims, data} + next offset. */
function readMatrix(buf, o) {
  const outer = readTag(buf, o);
  if (outer.dtype !== miMATRIX) return { skip: outer.next };
  let p = outer.dataOffset;
  // Array flags (miUINT32, 2 values) — class in low byte of first.
  const flagsTag = readTag(buf, p); p = flagsTag.next;
  // Dimensions (miINT32).
  const dimsTag = readTag(buf, p);
  const dims = Array.from(readNumeric(buf, dimsTag)); p = dimsTag.next;
  // Name (miINT8).
  const nameTag = readTag(buf, p);
  let name = '';
  for (let i = 0; i < nameTag.nbytes; i++) name += String.fromCharCode(buf.readUInt8(nameTag.dataOffset + i));
  p = nameTag.next;
  // Real part (pr).
  const prTag = readTag(buf, p);
  let data = null;
  try { data = readNumeric(buf, prTag); } catch { data = null; }
  return { name, dims, data, next: outer.next };
}

/** Read all top-level numeric variables from a MAT-5 file. */
export function readMat5(path) {
  const buf = readFileSync(path);
  const vars = {};
  let o = 128; // skip header
  while (o + 8 <= buf.length) {
    const res = readMatrix(buf, o);
    if (res.skip != null) { o = res.skip; continue; }
    if (res.name && res.data) vars[res.name] = { dims: res.dims, data: res.data };
    o = res.next;
    if (!res.next || res.next <= 0) break;
  }
  return vars;
}
