import { describe, it, expect } from 'vitest';
import { Heading } from '../src/game/heading';

describe('rate-limited heading', () => {
  it('slews toward the target at no more than maxRate', () => {
    const h = new Heading(0, Math.PI); // π rad/s
    h.setTarget(Math.PI); // ask for a half-turn
    h.tick(0.1); // 0.1s → at most 0.1π rad
    expect(h.current).toBeGreaterThan(0);
    expect(h.current).toBeLessThanOrEqual(Math.PI * 0.1 + 1e-6);
  });

  it('eventually reaches the target', () => {
    const h = new Heading(0, Math.PI);
    h.setTarget(1.0);
    for (let i = 0; i < 100; i++) h.tick(0.05);
    expect(h.current).toBeCloseTo(1.0, 5);
  });

  it('a huge instantaneous target change cannot be applied in one tick', () => {
    const h = new Heading(0, Math.PI);
    h.setTarget(100); // absurd drag
    h.tick(0.016); // one frame
    expect(h.current).toBeLessThan(0.1); // capped, not teleported
  });

  it('reset snaps without slewing', () => {
    const h = new Heading(0, Math.PI);
    h.reset(2.0);
    expect(h.current).toBe(2.0);
    expect(h.tick(0.1)).toBe(false); // already settled
  });
});
