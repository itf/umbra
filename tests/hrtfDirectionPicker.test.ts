/**
 * Pure tests for the two-input direction picker's compass geometry + labels.
 */
import { describe, it, expect } from 'vitest';
import { compassToAz, azLabel, elLabel } from '../src/ui/hrtfDirectionPicker';

describe('compassToAz', () => {
  const cx = 100, cy = 100;
  it('maps a click straight UP to azimuth 0 (front)', () => {
    expect(compassToAz(cx, cy - 50, cx, cy)).toBeCloseTo(0, 5);
  });
  it('maps a click to the RIGHT to +90°', () => {
    expect(compassToAz(cx + 50, cy, cx, cy)).toBeCloseTo(Math.PI / 2, 5);
  });
  it('maps a click DOWN to ±180° (behind)', () => {
    expect(Math.abs(compassToAz(cx, cy + 50, cx, cy))).toBeCloseTo(Math.PI, 5);
  });
  it('maps a click to the LEFT to −90°', () => {
    expect(compassToAz(cx - 50, cy, cx, cy)).toBeCloseTo(-Math.PI / 2, 5);
  });
  it('ignores distance from centre (only bearing matters)', () => {
    const near = compassToAz(cx + 10, cy - 10, cx, cy);
    const far = compassToAz(cx + 80, cy - 80, cx, cy);
    expect(near).toBeCloseTo(far, 5);
  });
});

describe('labels', () => {
  it('azLabel names the 8 cardinal-ish bearings', () => {
    expect(azLabel(0)).toBe('front');
    expect(azLabel(Math.PI / 2)).toBe('right');
    expect(azLabel(Math.PI)).toBe('behind');
    expect(azLabel(-Math.PI / 2)).toBe('left');
  });
  it('elLabel spans below → overhead', () => {
    expect(elLabel(-90)).toBe('below');
    expect(elLabel(0)).toBe('ear level');
    expect(elLabel(90)).toBe('overhead');
  });
});
