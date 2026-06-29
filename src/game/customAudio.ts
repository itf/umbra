/**
 * Reusable custom-audio helper — the standard way to attach a recorded audio
 * file to ANY game object (beacons, monsters, and future things).
 *
 * The pattern everywhere is the same: a game object owns an `HrtfSource` for
 * spatialization (distance gain, air lowpass, propagation delay, Doppler, HRTF).
 * Normally a synth voice feeds that source's `input`. When the object instead has
 * a `soundUrl`, we want to LOOP that recording through the same `input` so it gets
 * the exact same spatial treatment — and fall back to the synth voice if the
 * fetch/decode fails or there is no URL.
 *
 * This module owns the generic fetch + decode + cache + loop + fallback flow with
 * NO object-specific knowledge, so any object can reuse it. The buffers are cached
 * across all callers (keyed by URL): a successful decode is cached as the buffer; a
 * failure is cached as `null` so a known-bad URL is never re-fetched.
 *
 * Web Audio decode needs an AudioContext, so `fetch`/`decode` are INJECTABLE (they
 * default to `globalThis.fetch` + `ctx.decodeAudioData`) which keeps the cache and
 * fallback control flow unit-testable without a real context.
 *
 * See docs/engine/custom-audio.md.
 */

/** Injectable fetch: URL → raw bytes. Defaults to `globalThis.fetch`. */
export type FetchBytes = (url: string) => Promise<ArrayBuffer>;
/** Injectable decode: bytes → AudioBuffer. Defaults to `ctx.decodeAudioData`. */
export type DecodeAudio = (bytes: ArrayBuffer) => Promise<AudioBuffer>;

/** Shared decoded-buffer cache, keyed by URL. `null` ⇒ known-failed (don't refetch). */
// Cache the in-flight PROMISE (not just the resolved value) keyed by URL, so two
// concurrent loads of the same URL share a single fetch+decode. The promise
// resolves to the buffer, or to null on empty-url/fetch/decode failure (a failure
// stays cached so it is never retried).
const cache = new Map<string, Promise<AudioBuffer | null>>();

/** Test/teardown hook: clear the shared buffer cache. */
export function clearCustomAudioCache(): void {
  cache.clear();
}

function defaultFetchBytes(url: string): Promise<ArrayBuffer> {
  return fetch(url).then((r) => r.arrayBuffer());
}

/**
 * Load + decode a custom audio file as a looping buffer, CACHED across calls.
 *
 * Returns the decoded `AudioBuffer`, or `null` if the URL is empty or the
 * fetch/decode failed (the failure is cached so it isn't retried). A successful
 * decode is cached and returned to every future caller for the same URL.
 *
 * `fetchBytes`/`decode` are injectable for testing; they default to
 * `globalThis.fetch` and `ctx.decodeAudioData`.
 */
export async function loadCustomLoop(
  ctx: BaseAudioContext,
  url: string | undefined,
  fetchBytes: FetchBytes = defaultFetchBytes,
  decode: DecodeAudio = (b) => ctx.decodeAudioData(b),
): Promise<AudioBuffer | null> {
  if (!url) return null;
  const inflight = cache.get(url);
  if (inflight) return inflight; // hit or in-flight: share the one promise
  const promise = (async () => {
    try {
      const bytes = await fetchBytes(url);
      return await decode(bytes);
    } catch {
      return null; // failure resolves to null and stays cached (never refetched)
    }
  })();
  cache.set(url, promise);
  return promise;
}

/** What `attachCustomLoop` returns: the live looping source, or null if it fell back. */
export interface CustomLoopHandle {
  /** The looping BufferSource feeding `dest`, or null when the fallback was used. */
  source: AudioBufferSourceNode | null;
}

/**
 * Attach a looping custom recording to an object's spatial input.
 *
 * Given an AudioContext, a destination node (an `HrtfSource.input`), and a URL,
 * this fetches + decodes (cached via {@link loadCustomLoop}) and starts a looping
 * `AudioBufferSourceNode` through `dest`. If the URL is missing or the fetch/decode
 * fails, it invokes `onFallback` instead (e.g. start the synth voice) and the
 * handle's `source` is null.
 *
 * `shouldStart()` is checked right before starting the buffer so a caller that has
 * since torn down / won / been caught can veto a late-arriving load (returning a
 * null source without starting audio). Defaults to always-start.
 *
 * Generic: no beacon/monster specifics. Returns a promise of a handle so the caller
 * can later `source?.stop()` on teardown.
 */
export async function attachCustomLoop(
  ctx: BaseAudioContext,
  dest: AudioNode,
  url: string | undefined,
  onFallback: () => void,
  opts: {
    fetchBytes?: FetchBytes;
    decode?: DecodeAudio;
    shouldStart?: () => boolean;
  } = {},
): Promise<CustomLoopHandle> {
  const buf = await loadCustomLoop(ctx, url, opts.fetchBytes, opts.decode);
  if (!buf) {
    onFallback();
    return { source: null };
  }
  if (opts.shouldStart && !opts.shouldStart()) {
    return { source: null };
  }
  const source = ctx.createBufferSource();
  source.buffer = buf;
  source.loop = true;
  source.connect(dest);
  source.start();
  return { source };
}
