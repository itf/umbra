/**
 * LIGHT Steam BUS-level math — `recomputeSends` + the `setBusLevels` send-gain contract.
 *
 * Steam Audio itself can't run under vitest (needs Web Audio + a WASM worklet +
 * cross-origin isolation), so this verifies the PURE recompute helper that decides a
 * live source's send gains from the two BUS levels, and that `setGain` is the channel a
 * bus-level change flows through (the connection handle each source retains). It does
 * NOT verify real audio. The per-source reflected `wet` is NOT covered here — it's baked
 * at create() and changed only via a rebuild (see game.ts setSteamReflectionWet test).
 */
import { describe, it, expect } from 'vitest';
import { recomputeSends, BUS_BASE_REFL, BUS_BASE_REVERB } from '../src/engine/steamaudio/backend';

describe('recomputeSends (LIGHT bus-level math)', () => {
  const base = { reflectSend: 1.0, reverbSend: 0.4 };

  it('scales each send from BASE by the matching 0..1 bus level', () => {
    // recomputeSends(base, reflectionBusLevel, reverbBusLevel)
    expect(recomputeSends(base, 0.25, 0.5)).toEqual({
      reflectSend: 1.0 * 0.25, // reflectionBusLevel
      reverbSend: 0.4 * 0.5, // reverbBusLevel
    });
  });

  it('level 1.0 leaves the base sends unchanged (today\'s behavior)', () => {
    expect(recomputeSends(base, 1, 1)).toEqual(base);
  });

  it('recomputes from BASE, not the previous (already-scaled) value', () => {
    const once = recomputeSends(base, 0.5, 0.5);
    // Applying a NEW level must re-derive from base, never compound the prior scale.
    const twice = recomputeSends(base, 1, 1);
    expect(twice).toEqual(base);
    expect(twice).not.toEqual(once);
  });

  it('exposes the create-time bus base wets (multiplied by the bus levels)', () => {
    expect(BUS_BASE_REFL).toBe(1);
    expect(BUS_BASE_REVERB).toBe(0.5);
  });
});

/**
 * The `setBusLevels` walk: a fake source carrying connection handles + base sends must
 * have each handle's `setGain` called with base × the new bus level. We replicate the
 * exact loop the backend runs (it can't be instantiated headless) over a fake source.
 */
describe('setBusLevels send-gain dispatch (fake source)', () => {
  it('calls reflConn/reverbConn setGain with the recomputed sends', () => {
    const reflCalls: number[] = [];
    const reverbCalls: number[] = [];
    const live = {
      reflConn: { setGain: (g: number) => reflCalls.push(g) },
      reverbConn: { setGain: (g: number) => reverbCalls.push(g) },
      base: { reflectSend: 0.8, reverbSend: 0.3 },
    };
    // Mirror SteamAudioBackend.setBusLevels' per-source body.
    const reflectionBusLevel = 0.5, reverbBusLevel = 0.25;
    const sends = recomputeSends(live.base, reflectionBusLevel, reverbBusLevel);
    live.reflConn.setGain(sends.reflectSend);
    live.reverbConn.setGain(sends.reverbSend);

    expect(reflCalls).toEqual([0.8 * 0.5]);
    expect(reverbCalls).toEqual([0.3 * 0.25]);
  });
});
