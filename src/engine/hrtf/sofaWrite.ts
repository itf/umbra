/**
 * Serialize a reconstructed HRTF set (see sofaExport.ts) into a valid SOFA
 * (SimpleFreeFieldHRIR, HDF5/NetCDF-4) file in the browser, using h5wasm.
 *
 * The output follows the AES69 SOFA spec's SimpleFreeFieldHRIR convention closely
 * enough to load in Steam Audio, OpenAL Soft, SPARTA, the Python `sofar`/`pysofaconf`
 * tools, etc.:
 *   Dimensions: M (measurements) = count, R (receivers) = 2, E (emitters) = 1,
 *               N (samples) = taps, C (coordinate triplet) = 3, I (singleton) = 1.
 *   Datasets:   Data.IR [M][R][N], Data.SamplingRate [I], Data.Delay [I][R],
 *               SourcePosition [M][C], ReceiverPosition [R][C][I],
 *               ListenerPosition/Up/View, EmitterPosition.
 *   Global attrs: Conventions, SOFAConventions(+Version), APIName/Version,
 *               DataType, RoomType, plus the required bookkeeping strings.
 *
 * h5wasm must be initialised (`await ready`) before calling. Returns the file bytes
 * as a Uint8Array (read back from the in-memory FS) so the caller can offer a download.
 *
 * Not unit-tested here (needs the WASM runtime); the numeric reconstruction it relies
 * on is tested in tests/sofaExport.test.ts.
 */
import type { ReconstructedHrtf } from './sofaExport';

// h5wasm is imported lazily so the (large) WASM only loads when a user actually exports.
type H5Module = typeof import('h5wasm');

let h5ready: Promise<H5Module> | null = null;
async function getH5(): Promise<H5Module> {
  if (!h5ready) {
    h5ready = (async () => {
      const mod = (await import('h5wasm')) as unknown as H5Module;
      await (mod as any).ready;
      return mod;
    })();
  }
  return h5ready;
}

/** Build a SOFA file from a reconstructed HRTF and return its bytes. */
export async function writeSofa(rec: ReconstructedHrtf, opts: { title?: string } = {}): Promise<Uint8Array> {
  const h5 = await getH5();
  const { FS, File } = h5 as any;
  const path = `/export-${rec.count}-${rec.taps}.sofa`;
  // Fresh file each call.
  try { FS.unlink(path); } catch { /* not present */ }
  const f = new File(path, 'w');

  const M = rec.count;
  const R = 2;
  const N = rec.taps;

  const str = (name: string, value: string) => f.create_attribute(name, value);

  // --- required global attributes (AES69) ---
  str('Conventions', 'SOFA');
  str('Version', '2.1');
  str('SOFAConventions', 'SimpleFreeFieldHRIR');
  str('SOFAConventionsVersion', '1.0');
  str('APIName', 'umbra-hrtf-export');
  str('APIVersion', '1.0');
  str('AuthorContact', '');
  str('Organization', 'Umbra');
  str('License', 'CC0');
  str('DataType', 'FIR');
  str('RoomType', 'free field');
  str('Title', opts.title ?? 'Personalized HRTF (Umbra)');
  str('DateCreated', '');
  str('DateModified', '');
  str('ListenerShortName', 'listener');

  // --- data ---
  // Data.IR [M][R][N]
  f.create_dataset({ name: 'Data.IR', data: rec.irs, shape: [M, R, N], dtype: '<f8' });
  // Data.SamplingRate [I], with Units attribute.
  const sr = f.create_dataset({ name: 'Data.SamplingRate', data: [rec.sampleRate], shape: [1], dtype: '<f8' });
  sr.create_attribute('Units', 'hertz');
  // Data.Delay [I][R] — zero, since the ITD is baked into the IRs themselves.
  f.create_dataset({ name: 'Data.Delay', data: [0, 0], shape: [1, R], dtype: '<f8' });

  // SourcePosition [M][C] (azimuth°, elevation°, distance m), spherical.
  const srcPos = f.create_dataset({ name: 'SourcePosition', data: rec.positions, shape: [M, 3], dtype: '<f8' });
  srcPos.create_attribute('Type', 'spherical');
  srcPos.create_attribute('Units', 'degree, degree, metre');

  // ListenerPosition [I][C] at origin, cartesian; View (front −z? SOFA uses +x front)
  // SOFA cartesian convention: +x front, +y left, +z up. We emit the canonical head.
  const lp = f.create_dataset({ name: 'ListenerPosition', data: [0, 0, 0], shape: [1, 3], dtype: '<f8' });
  lp.create_attribute('Type', 'cartesian');
  lp.create_attribute('Units', 'metre');
  const lv = f.create_dataset({ name: 'ListenerView', data: [1, 0, 0], shape: [1, 3], dtype: '<f8' });
  lv.create_attribute('Type', 'cartesian');
  lv.create_attribute('Units', 'metre');
  const lu = f.create_dataset({ name: 'ListenerUp', data: [0, 0, 1], shape: [1, 3], dtype: '<f8' });
  lu.create_attribute('Type', 'cartesian');
  lu.create_attribute('Units', 'metre');

  // ReceiverPosition [R][C][I] — the two ears, +y left / −y right (SOFA +y = left).
  const earOffset = 0.09; // ~9 cm from head centre to each ear
  const recv = new Float64Array([0, earOffset, 0, 0, -earOffset, 0]); // [R][C] then I=1
  const rp = f.create_dataset({ name: 'ReceiverPosition', data: recv, shape: [R, 3, 1], dtype: '<f8' });
  rp.create_attribute('Type', 'cartesian');
  rp.create_attribute('Units', 'metre');

  // EmitterPosition [E][C][I] — single emitter at origin.
  const ep = f.create_dataset({ name: 'EmitterPosition', data: [0, 0, 0], shape: [1, 3, 1], dtype: '<f8' });
  ep.create_attribute('Type', 'cartesian');
  ep.create_attribute('Units', 'metre');

  f.flush();
  f.close();

  const bytes: Uint8Array = FS.readFile(path);
  try { FS.unlink(path); } catch { /* noop */ }
  return bytes;
}
