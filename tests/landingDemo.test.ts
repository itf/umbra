import { describe, it, expect } from 'vitest';
import { sideFromDraw, demoVerdict } from '../src/ui/landingDemo';

describe('landing demo — pure logic', () => {
  it('sideFromDraw: <0.5 → left, >=0.5 → right', () => {
    expect(sideFromDraw(0)).toBe('left');
    expect(sideFromDraw(0.49)).toBe('left');
    expect(sideFromDraw(0.5)).toBe('right');
    expect(sideFromDraw(0.99)).toBe('right');
  });

  it('demoVerdict: correct when answer matches truth', () => {
    const r = demoVerdict('right', 'right');
    expect(r.correct).toBe(true);
    expect(r.text).toMatch(/Correct/);
    expect(r.text).toMatch(/right/);
  });

  it('demoVerdict: incorrect names the true side', () => {
    const r = demoVerdict('left', 'right');
    expect(r.correct).toBe(false);
    expect(r.text).toMatch(/Not quite/);
    expect(r.text).toMatch(/right/);
  });
});
