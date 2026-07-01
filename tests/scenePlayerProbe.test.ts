/**
 * Control-flow tests for ScenePlayer's probe wiring, without a real AudioContext.
 *
 *  - A recorded probe `{ url }` reuses loadCustomLoop's shared cache; on a load
 *    FAILURE the player falls back to the synth clap buffer when firing.
 *  - A successful recorded load fires the recorded buffer (cached, not re-fetched).
 *  - `decodeFile` decodes a picked Blob via the context.
 *
 * Plus the "clap in a different place" point as a pure acoustics test: two scenes
 * with the same room but different clap-source `pos` yield different room taps via
 * computeRoomTaps — proving the clap position changes what you hear.
 */
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ScenePlayer } from '../src/debug/scenePlayer';
import { loadCustomLoop, clearCustomAudioCache } from '../src/game/customAudio';
import { initAcoustics, computeRoomTaps } from '../src/engine/acoustics/core';
import { SCENES, sceneWalls } from '../src/debug/scenes';

// ---- a minimal fake audio graph so ScenePlayer constructs without Web Audio ----
type FakeBuf = { length: number; data: Float32Array; getChannelData(): Float32Array };

function fakeGraph(sampleRate = 48000) {
  const created: { buffer: AudioBuffer | null; started: boolean }[] = [];
  const ctx = {
    sampleRate,
    // connect() returns its destination so chained `.connect(a).connect(b)` works,
    // matching Web Audio (SelfSource wires input→convolver→dest that way).
    createGain: () => ({ gain: { value: 1 }, connect: (d: unknown) => d }),
    createConvolver: () => ({ normalize: true, connect: (d: unknown) => d, buffer: null }),
    createBuffer: (_ch: number, length: number): FakeBuf => {
      const data = new Float32Array(length);
      return { length, data, getChannelData: () => data };
    },
    createBufferSource: () => {
      const node = { buffer: null as AudioBuffer | null, started: false, connect: vi.fn(), start() { node.started = true; created.push(node); } };
      return node;
    },
    decodeAudioData: vi.fn(),
  };
  return { graph: { ctx, master: {} } as never, ctx, created };
}

// ScenePlayer needs a renderer only for IR build; we avoid clap()'s IR path by
// stubbing the scene check. We construct with a fake renderer that is never used
// by setProbe/probeBuffer/decodeFile.
const fakeRenderer = { set: {} } as never;

beforeEach(() => clearCustomAudioCache());

describe('ScenePlayer recorded probe control flow', () => {
  it('falls back to a synth clap buffer when the recorded load fails', async () => {
    const { graph, ctx, created } = fakeGraph();
    const player = new ScenePlayer(graph, fakeRenderer);
    // Pre-seed the shared cache as a FAILURE via injected fetch.
    const fetchBytes = vi.fn(async () => { throw new Error('404'); });
    expect(await loadCustomLoop(ctx as never, 'bad.wav', fetchBytes)).toBeNull();

    await player.setProbe({ url: 'bad.wav' });
    // Force a scene with a clap so clap() proceeds.
    (player as unknown as { scene: unknown }).scene = { sources: [{ kind: 'clap' }] };
    player.clap();
    const src = created.at(-1)!;
    // Fell back to a synth buffer the player created (a FakeBuf, length>0).
    expect((src.buffer as unknown as FakeBuf).length).toBeGreaterThan(0);
  });

  it('fires the recorded buffer when the load succeeds (cached, one fetch)', async () => {
    const { graph, ctx, created } = fakeGraph();
    const player = new ScenePlayer(graph, fakeRenderer);
    const recorded = { length: 12345 } as unknown as AudioBuffer;
    const fetchBytes = vi.fn(async () => new ArrayBuffer(8));
    const decode = vi.fn(async () => recorded);
    // Seed cache with a successful decode for this URL.
    expect(await loadCustomLoop(ctx as never, 'ok.wav', fetchBytes, decode)).toBe(recorded);

    await player.setProbe({ url: 'ok.wav' });
    (player as unknown as { scene: unknown }).scene = { sources: [{ kind: 'clap' }] };
    player.clap();
    const src = created.at(-1)!;
    expect(src.buffer).toBe(recorded);
    expect(fetchBytes).toHaveBeenCalledTimes(1); // served from cache
  });

  it('decodeFile decodes a Blob via the context', async () => {
    const { graph, ctx } = fakeGraph();
    const decoded = { length: 7 } as unknown as AudioBuffer;
    (ctx.decodeAudioData as ReturnType<typeof vi.fn>).mockResolvedValue(decoded);
    const player = new ScenePlayer(graph, fakeRenderer);
    const blob = { arrayBuffer: async () => new ArrayBuffer(8) } as Blob;
    expect(await player.decodeFile(blob)).toBe(decoded);
  });

  it('a pre-decoded { buffer } probe is fired directly', async () => {
    const { graph, created } = fakeGraph();
    const player = new ScenePlayer(graph, fakeRenderer);
    const buf = { length: 99 } as unknown as AudioBuffer;
    await player.setProbe({ buffer: buf });
    (player as unknown as { scene: unknown }).scene = { sources: [{ kind: 'clap' }] };
    player.clap();
    expect(created.at(-1)!.buffer).toBe(buf);
  });
});

describe('clap position changes the room IR', () => {
  beforeAll(async () => {
    // initAcoustics loads the wasm; mirror scenes.test.ts environment.
    const here = dirname(fileURLToPath(import.meta.url));
    const wasmDir = resolve(here, '../src/engine/acoustics/wasm');
    const mod = await import(resolve(wasmDir, 'acoustics_core.js'));
    await mod.default(readFileSync(resolve(wasmDir, 'acoustics_core_bg.wasm')));
    await initAcoustics();
  });

  it('two clap positions in the same room yield different taps', () => {
    const scene = SCENES.find((s) => s.roomSize && s.maxOrder > 0)!;
    const walls = sceneWalls(scene);
    const common = { walls, edges: scene.edges, listener: scene.listener, maxOrder: scene.maxOrder };
    const [sx, sy, sz] = scene.roomSize!;
    // Two genuinely different (non-mirror) positions in the room.
    const tapsA = computeRoomTaps({ ...common, source: [sx * 0.2, sy * 0.3, sz * 0.2] });
    const tapsB = computeRoomTaps({ ...common, source: [sx * 0.8, sy * 0.6, sz * 0.7] });
    expect(tapsA.length).toBeGreaterThan(0);
    expect(tapsB.length).toBeGreaterThan(0);
    // Different source positions ⇒ different taps (delay + bearing) = what you hear.
    const sig = (ts: typeof tapsA) =>
      ts.map((t) => `${t.delay.toFixed(6)}|${t.dir.map((d) => d.toFixed(4)).join(',')}`).join(';');
    expect(sig(tapsA)).not.toBe(sig(tapsB));
  });
});
