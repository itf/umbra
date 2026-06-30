/**
 * Unit tests for the SOFA-fetch-or-fallback decision used by the Steam Audio path.
 * The backend itself can't run under vitest (needs Web Audio + a WASM worklet +
 * cross-origin isolation), but `loadSofaHrtf` is pure logic over an injectable fetch,
 * so the "use OUR SADIE SOFA, else fall back to the generic HRTF" branch IS testable.
 */
import { describe, it, expect } from 'vitest';
import { loadSofaHrtf, SADIE_SOFA_URL } from './backend';

const okResponse = (buf: ArrayBuffer): Response =>
  ({ ok: true, arrayBuffer: async () => buf }) as unknown as Response;

describe('loadSofaHrtf', () => {
  it('returns a sofa HRTF setting with the fetched bytes on success', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
    const result = await loadSofaHrtf(async () => okResponse(bytes));
    expect(result).toEqual({ type: 'sofa', data: bytes });
  });

  it('fetches OUR measured SADIE SOFA by default', async () => {
    let requested: string | undefined;
    await loadSofaHrtf(async (url) => {
      requested = String(url);
      return okResponse(new Uint8Array([1]).buffer);
    });
    expect(requested).toBe(SADIE_SOFA_URL);
  });

  it('falls back (null) on a non-OK response', async () => {
    const result = await loadSofaHrtf(
      async () => ({ ok: false, arrayBuffer: async () => new ArrayBuffer(0) }) as unknown as Response,
    );
    expect(result).toBeNull();
  });

  it('falls back (null) when fetch throws', async () => {
    const result = await loadSofaHrtf(async () => {
      throw new Error('network down');
    });
    expect(result).toBeNull();
  });

  it('falls back (null) on an empty body', async () => {
    const result = await loadSofaHrtf(async () => okResponse(new ArrayBuffer(0)));
    expect(result).toBeNull();
  });
});
