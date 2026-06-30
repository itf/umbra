import { describe, it, expect } from 'vitest';
import {
  Heading,
  keyTurnDelta,
  announceHeading,
  announceHeadingWithDirection,
  compassDetent,
  compassDirection,
  crossedDetent,
  COMPASS_POINTS,
} from '../src/game/heading';

const DEG = Math.PI / 180;

describe('keyTurnDelta (keyboard turning)', () => {
  it('Right/Down arrows and E turn positive (right); Left/Up and Q turn negative (left)', () => {
    for (const k of ['ArrowRight', 'ArrowDown', 'e', 'E']) {
      expect(keyTurnDelta(k, false)).toBeCloseTo(5 * DEG, 9);
    }
    for (const k of ['ArrowLeft', 'ArrowUp', 'q', 'Q']) {
      expect(keyTurnDelta(k, false)).toBeCloseTo(-5 * DEG, 9);
    }
  });
  it('Shift makes a larger step', () => {
    expect(keyTurnDelta('ArrowRight', true)).toBeCloseTo(15 * DEG, 9);
    expect(keyTurnDelta('q', true)).toBeCloseTo(-15 * DEG, 9);
  });
  it('non-turn keys (incl. the A/D step keys) produce no turn', () => {
    expect(keyTurnDelta('a', false)).toBe(0); // step-left, not a turn
    expect(keyTurnDelta('d', false)).toBe(0); // step-right, not a turn
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

describe('compassDetent / compassDirection (8-point naming)', () => {
  it('yaw 0 is north (start direction)', () => {
    expect(compassDetent(0)).toBe(0);
    expect(compassDirection(0)).toBe('north');
  });
  it('clockwise (+yaw) walks N→E→S→W', () => {
    expect(compassDirection(45 * DEG)).toBe('north-east');
    expect(compassDirection(90 * DEG)).toBe('east');
    expect(compassDirection(180 * DEG)).toBe('south');
    expect(compassDirection(270 * DEG)).toBe('west');
    expect(compassDirection(315 * DEG)).toBe('north-west');
  });
  it('each octant is centred on its direction (±22.5°)', () => {
    expect(compassDirection(22 * DEG)).toBe('north');     // just inside north
    expect(compassDirection(23 * DEG)).toBe('north-east'); // crossed into NE
  });
  it('wraps cleanly past 360° and for negative yaw', () => {
    expect(compassDirection(360 * DEG)).toBe('north');
    expect(compassDirection(-90 * DEG)).toBe('west'); // -90° = 270° = west
    expect(compassDetent(720 * DEG)).toBe(0);
  });
  it('there are exactly 8 names', () => {
    expect(COMPASS_POINTS).toHaveLength(8);
  });
});

describe('crossedDetent (detent-crossing detection)', () => {
  it('returns null when staying within one detent', () => {
    expect(crossedDetent(0, 10 * DEG)).toBeNull(); // both north
  });
  it('returns the new detent index on a crossing', () => {
    expect(crossedDetent(20 * DEG, 30 * DEG)).toBe(1); // north → north-east
  });
  it('detects crossing in either direction', () => {
    expect(crossedDetent(30 * DEG, 20 * DEG)).toBe(0); // NE → N (turning left)
  });
  it('a fast sweep across several octants reports the final detent', () => {
    expect(crossedDetent(0, 95 * DEG)).toBe(2); // landed in east
  });
});

describe('announceHeadingWithDirection (G2 detent read-out)', () => {
  it('names the nearest direction alongside the relative turn', () => {
    expect(announceHeadingWithDirection(45 * DEG)).toBe(
      'Turned 45 degrees right, facing north-east.',
    );
    expect(announceHeadingWithDirection(270 * DEG)).toBe(
      'Turned 90 degrees left, facing west.',
    );
  });
  it('start direction is unchanged (already implies north)', () => {
    expect(announceHeadingWithDirection(0)).toBe(announceHeading(0));
    expect(announceHeadingWithDirection(0)).toMatch(/start direction/i);
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
