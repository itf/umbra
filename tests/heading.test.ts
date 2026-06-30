import { describe, it, expect } from 'vitest';
import { Heading, keyTurnDelta, announceHeading } from '../src/game/heading';

const DEG = Math.PI / 180;

describe('keyTurnDelta (keyboard turning)', () => {
  it('Right turns positive (clockwise), Left negative', () => {
    expect(keyTurnDelta('ArrowRight', false)).toBeCloseTo(5 * DEG, 9);
    expect(keyTurnDelta('ArrowLeft', false)).toBeCloseTo(-5 * DEG, 9);
  });
  it('Shift makes a larger step', () => {
    expect(keyTurnDelta('ArrowRight', true)).toBeCloseTo(15 * DEG, 9);
    expect(keyTurnDelta('ArrowLeft', true)).toBeCloseTo(-15 * DEG, 9);
  });
  it('non-arrow keys produce no turn', () => {
    expect(keyTurnDelta('a', false)).toBe(0);
    expect(keyTurnDelta(' ', true)).toBe(0);
  });
  it('accumulated key turns drive a Heading toward the intended yaw', () => {
    const h = new Heading(0);
    for (let i = 0; i < 6; i++) h.setTarget(h.desired + keyTurnDelta('ArrowRight', false));
    expect(h.desired).toBeCloseTo(30 * DEG, 9); // six 5° nudges = 30° right
  });
});

describe('announceHeading', () => {
  it('zero is the start direction', () => {
    expect(announceHeading(0)).toMatch(/start direction/i);
    expect(announceHeading(2 * Math.PI)).toMatch(/start direction/i);
  });
  it('right turns up to 180° announce right', () => {
    expect(announceHeading(90 * DEG)).toBe('Turned 90 degrees right.');
  });
  it('beyond 180° announce as the shorter left turn', () => {
    expect(announceHeading(270 * DEG)).toBe('Turned 90 degrees left.');
  });
});

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
