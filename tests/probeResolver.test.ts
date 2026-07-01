import { describe, it, expect, vi } from 'vitest';
import { ProbeResolver } from '../src/game/probeResolver';

// ProbeResolver calls loadClicksManifest() internally; stub it to a fixed manifest so
// the test is deterministic and offline.
vi.mock('../src/game/clicksManifest', () => ({
  loadClicksManifest: async () => [
    { id: 'dental', file: '/audio/clicks/dental.ogg', label: 'Dental click' },
  ],
}));

/** A fake AudioBuffer stand-in (ProbeResolver only stores/returns it). */
const FAKE_BUF = { length: 1 } as unknown as AudioBuffer;

describe('ProbeResolver', () => {
  it('returns a synth name unchanged for a synth choice (no decode)', async () => {
    const decode = vi.fn(async () => FAKE_BUF);
    const r = new ProbeResolver(() => 'mouthclick', decode);
    await Promise.resolve(); // let warm()'s manifest promise settle
    expect(r.probe()).toEqual({ probe: 'mouthclick' });
    expect(decode).not.toHaveBeenCalled();
  });

  it('falls back to clap until a recording decodes, then returns the buffer', async () => {
    let resolveDecode: (b: AudioBuffer) => void = () => {};
    const decode = vi.fn(() => new Promise<AudioBuffer | null>((res) => { resolveDecode = res; }));
    const r = new ProbeResolver(() => 'rec:dental', decode);
    // Before decode resolves: synth fallback.
    await Promise.resolve();
    expect(r.probe()).toEqual({ probe: 'clap' });
    // Resolve the decode; now the buffer is returned.
    resolveDecode(FAKE_BUF);
    await Promise.resolve();
    await Promise.resolve();
    expect(r.probe()).toEqual({ probe: FAKE_BUF });
  });

  it('re-decodes when the choice changes to a different recording at runtime', async () => {
    const decode = vi.fn(async () => FAKE_BUF);
    let choice = 'clap';
    const r = new ProbeResolver(() => choice, decode);
    await Promise.resolve();
    expect(r.probe()).toEqual({ probe: 'clap' });
    // Switch to a recording; probe() triggers a re-warm.
    choice = 'rec:dental';
    r.probe(); // kicks warm()
    await Promise.resolve();
    await Promise.resolve();
    expect(decode).toHaveBeenCalledWith('/audio/clicks/dental.ogg');
  });
});
