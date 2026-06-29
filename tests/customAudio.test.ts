/**
 * Tests the reusable custom-audio helper's cache + fallback control flow with
 * INJECTED fetch/decode functions (no real AudioContext needed). Verifies:
 *  - a successful load is cached: the same URL returns the same buffer and only
 *    fetches/decodes once;
 *  - a failed fetch/decode returns null and is cached as null (no refetch);
 *  - attachCustomLoop invokes onFallback (and yields a null source) on failure;
 *  - shouldStart can veto a late-arriving buffer.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadCustomLoop, attachCustomLoop, clearCustomAudioCache } from '../src/game/customAudio';

// A minimal fake AudioBuffer (the helper only stores/returns it; decode is injected).
const fakeBuffer = { length: 1 } as unknown as AudioBuffer;

// A fake context whose decodeAudioData is never called when we inject decode, but
// createBufferSource must work for attachCustomLoop's success path.
function fakeCtx() {
  const source = {
    buffer: null as AudioBuffer | null,
    loop: false,
    connect: vi.fn(),
    start: vi.fn(),
  };
  return {
    ctx: { createBufferSource: () => source } as unknown as BaseAudioContext,
    source,
  };
}

beforeEach(() => clearCustomAudioCache());

describe('loadCustomLoop (cache)', () => {
  it('returns null for an empty/undefined url without fetching', async () => {
    const fetchBytes = vi.fn();
    expect(await loadCustomLoop({} as BaseAudioContext, undefined, fetchBytes)).toBeNull();
    expect(fetchBytes).not.toHaveBeenCalled();
  });

  it('caches a successful decode: same buffer, fetched/decoded once', async () => {
    const fetchBytes = vi.fn(async () => new ArrayBuffer(8));
    const decode = vi.fn(async () => fakeBuffer);
    const a = await loadCustomLoop({} as BaseAudioContext, 'u1', fetchBytes, decode);
    const b = await loadCustomLoop({} as BaseAudioContext, 'u1', fetchBytes, decode);
    expect(a).toBe(fakeBuffer);
    expect(b).toBe(fakeBuffer);
    expect(fetchBytes).toHaveBeenCalledTimes(1);
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it('caches a failure as null and never refetches', async () => {
    const fetchBytes = vi.fn(async () => { throw new Error('404'); });
    const decode = vi.fn();
    expect(await loadCustomLoop({} as BaseAudioContext, 'bad', fetchBytes, decode)).toBeNull();
    expect(await loadCustomLoop({} as BaseAudioContext, 'bad', fetchBytes, decode)).toBeNull();
    expect(fetchBytes).toHaveBeenCalledTimes(1); // cached as failed
  });

  it('caches a decode failure as null too', async () => {
    const fetchBytes = vi.fn(async () => new ArrayBuffer(8));
    const decode = vi.fn(async () => { throw new Error('bad audio'); });
    expect(await loadCustomLoop({} as BaseAudioContext, 'u2', fetchBytes, decode)).toBeNull();
    await loadCustomLoop({} as BaseAudioContext, 'u2', fetchBytes, decode);
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it('two concurrent loads of the same url share ONE fetch+decode', async () => {
    // Both calls start before either resolves; the in-flight promise is shared.
    let resolveFetch: (b: ArrayBuffer) => void;
    const fetchBytes = vi.fn(() => new Promise<ArrayBuffer>((r) => { resolveFetch = r; }));
    const decode = vi.fn(async () => fakeBuffer);
    const p1 = loadCustomLoop({} as BaseAudioContext, 'race', fetchBytes, decode);
    const p2 = loadCustomLoop({} as BaseAudioContext, 'race', fetchBytes, decode);
    resolveFetch!(new ArrayBuffer(8));
    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toBe(fakeBuffer);
    expect(b).toBe(fakeBuffer);
    expect(fetchBytes).toHaveBeenCalledTimes(1);
    expect(decode).toHaveBeenCalledTimes(1);
  });
});

describe('attachCustomLoop (fallback + start)', () => {
  it('starts a looping source on success and does NOT call onFallback', async () => {
    const { ctx, source } = fakeCtx();
    const onFallback = vi.fn();
    const handle = await attachCustomLoop(ctx, {} as AudioNode, 'ok', onFallback, {
      fetchBytes: async () => new ArrayBuffer(8),
      decode: async () => fakeBuffer,
    });
    expect(handle.source).toBe(source);
    expect(source.loop).toBe(true);
    expect(source.buffer).toBe(fakeBuffer);
    expect(source.start).toHaveBeenCalledOnce();
    expect(onFallback).not.toHaveBeenCalled();
  });

  it('invokes onFallback and yields a null source on failure', async () => {
    const { ctx } = fakeCtx();
    const onFallback = vi.fn();
    const handle = await attachCustomLoop(ctx, {} as AudioNode, 'bad', onFallback, {
      fetchBytes: async () => { throw new Error('nope'); },
    });
    expect(handle.source).toBeNull();
    expect(onFallback).toHaveBeenCalledOnce();
  });

  it('invokes onFallback for a missing url', async () => {
    const { ctx } = fakeCtx();
    const onFallback = vi.fn();
    const handle = await attachCustomLoop(ctx, {} as AudioNode, undefined, onFallback);
    expect(handle.source).toBeNull();
    expect(onFallback).toHaveBeenCalledOnce();
  });

  it('shouldStart can veto a late-arriving buffer (null source, no start)', async () => {
    const { ctx, source } = fakeCtx();
    const onFallback = vi.fn();
    const handle = await attachCustomLoop(ctx, {} as AudioNode, 'ok', onFallback, {
      fetchBytes: async () => new ArrayBuffer(8),
      decode: async () => fakeBuffer,
      shouldStart: () => false,
    });
    expect(handle.source).toBeNull();
    expect(source.start).not.toHaveBeenCalled();
    expect(onFallback).not.toHaveBeenCalled(); // success path; just vetoed start
  });
});
