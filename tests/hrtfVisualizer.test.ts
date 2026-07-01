/**
 * Pure tests for the calibration visualizer's projection. No canvas/DOM: we only
 * check the geometry that maps a listener-relative source position to screen space,
 * so the diagram never contradicts what the audio is doing.
 */
import { describe, it, expect } from 'vitest';
import { project, type ProjectConfig } from '../src/ui/hrtfVisualizer';

const cfg: ProjectConfig = { w: 260, h: 200, scale: 70, headY: 1.6 };
const cx = cfg.w / 2;
const cy = cfg.h / 2;

describe('visualizer project()', () => {
  it('places a source to the RIGHT at higher screen-x than a source to the LEFT', () => {
    const right = project(1, cfg.headY, 0, cfg);
    const left = project(-1, cfg.headY, 0, cfg);
    expect(right.sx).toBeGreaterThan(cx);
    expect(left.sx).toBeLessThan(cx);
  });

  it('raises the dot on screen (smaller sy) as the source goes UP', () => {
    const low = project(0, cfg.headY, -1, cfg);
    const high = project(0, cfg.headY + 1, -1, cfg);
    expect(high.sy).toBeLessThan(low.sy); // screen y grows downward
  });

  it('reads FRONT as nearer (depth01→1, bigger radius) than BACK', () => {
    const front = project(0, cfg.headY, -1, cfg);
    const back = project(0, cfg.headY, 1, cfg);
    expect(front.depth01).toBeGreaterThan(back.depth01);
    expect(front.r).toBeGreaterThan(back.r);
  });

  it('puts a centred ear-level source at the head centre', () => {
    const p = project(0, cfg.headY, 0, cfg);
    expect(p.sx).toBeCloseTo(cx, 5);
    expect(p.sy).toBeCloseTo(cy, 5);
  });

  it('keeps the ground shadow at (or above) ear level, never following height', () => {
    const high = project(0, cfg.headY + 1, -1, cfg);
    const ear = project(0, cfg.headY, -1, cfg);
    expect(high.gy).toBeCloseTo(ear.gy, 5); // shadow ignores height
    expect(high.sy).toBeLessThan(high.gy); // dot sits above its shadow
  });
});
