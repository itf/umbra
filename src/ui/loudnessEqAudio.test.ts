import { describe, it, expect } from 'vitest';
import { buildBiquadChain, type CompBiquad } from './loudnessEqAudio';

/**
 * A tiny fake BiquadFilterNode + BaseAudioContext, enough to exercise buildBiquadChain
 * without a real Web Audio graph. Each created filter records the values assigned to it
 * and its outgoing connections so we can assert the chain shape + per-band settings.
 */
function fakeCtx() {
  const created: FakeBiquad[] = [];
  const ctx = {
    created,
    createBiquadFilter(): FakeBiquad {
      const node = new FakeBiquad();
      created.push(node);
      return node;
    },
  };
  return ctx as unknown as BaseAudioContext & { created: FakeBiquad[] };
}

class FakeBiquad {
  type = 'peaking';
  frequency = { value: 0 };
  Q = { value: 0 };
  gain = { value: 0 };
  connections: FakeBiquad[] = [];
  connect(dst: FakeBiquad) { this.connections.push(dst); }
  disconnect() { this.connections = []; }
}

const BANDS: CompBiquad[] = [
  { type: 'peaking', freq: 5000, Q: 1.4, gainDb: -4.6 },
  { type: 'peaking', freq: 12000, Q: 1.4, gainDb: 2.0 }, // above the notch-protect band → kept
];

describe('buildBiquadChain', () => {
  it('returns null for empty / null / zero-scale input', () => {
    expect(buildBiquadChain(fakeCtx(), null, 1)).toBe(null);
    expect(buildBiquadChain(fakeCtx(), [], 1)).toBe(null);
    expect(buildBiquadChain(fakeCtx(), BANDS, 0)).toBe(null);
    expect(buildBiquadChain(fakeCtx(), BANDS, -1)).toBe(null);
  });

  it('builds one node per band with its own type + Q, gain scaled by strength', () => {
    const ctx = fakeCtx();
    const chain = buildBiquadChain(ctx, BANDS, 0.5)!;
    expect(chain).not.toBe(null);
    expect(ctx.created.length).toBe(2);
    // Per-band Q is honoured (not the fixed 1.41 of the loudness EQ).
    expect(ctx.created[0].Q.value).toBeCloseTo(1.4);
    expect(ctx.created[0].frequency.value).toBe(5000);
    // Gain is the asset gain × strength.
    expect(ctx.created[0].gain.value).toBeCloseTo(-4.6 * 0.5);
    expect(ctx.created[1].gain.value).toBeCloseTo(2.0 * 0.5);
    // Chain is wired head → … → tail.
    expect(chain.input).toBe(ctx.created[0]);
    expect(chain.output).toBe(ctx.created[1]);
    expect(ctx.created[0].connections).toContain(ctx.created[1]);
  });

  it('NOTCH PROTECTION: never adds gain in 6–10 kHz (drops a +gain band there)', () => {
    const ctx = fakeCtx();
    // A +2 dB peak at 9 kHz (pinna-notch band) must be clamped to 0 → skipped entirely,
    // leaving only the −4.6 dB @5 kHz correction. The comp can't fill the pinna notches.
    buildBiquadChain(ctx, [
      { type: 'peaking', freq: 5000, Q: 1.4, gainDb: -4.6 },
      { type: 'peaking', freq: 9000, Q: 1.4, gainDb: 2.0 },
    ], 1);
    expect(ctx.created.length).toBe(1);
    expect(ctx.created[0].frequency.value).toBe(5000);
    // An ATTENUATION in-band is kept (deepening the notch is safe).
    const ctx2 = fakeCtx();
    buildBiquadChain(ctx2, [{ type: 'peaking', freq: 8000, Q: 1.4, gainDb: -3 }], 1);
    expect(ctx2.created.length).toBe(1);
    expect(ctx2.created[0].gain.value).toBeCloseTo(-3);
  });

  it('scales gain linearly with strength (half strength ⇒ half dB)', () => {
    const full = fakeCtx();
    buildBiquadChain(full, BANDS, 1);
    const half = fakeCtx();
    buildBiquadChain(half, BANDS, 0.5);
    expect(half.created[0].gain.value).toBeCloseTo(full.created[0].gain.value / 2);
  });

  it('drops bands whose SCALED gain is ~0 dB', () => {
    const ctx = fakeCtx();
    // A tiny gain × a tiny strength falls under the 0.01 dB skip threshold.
    const chain = buildBiquadChain(ctx, [{ type: 'peaking', freq: 1000, Q: 1, gainDb: 0.01 }], 0.1);
    expect(chain).toBe(null);
    expect(ctx.created.length).toBe(0);
  });

  it('dispose detaches every node', () => {
    const ctx = fakeCtx();
    const chain = buildBiquadChain(ctx, BANDS, 1)!;
    chain.dispose();
    for (const n of ctx.created) expect(n.connections.length).toBe(0);
  });
});
