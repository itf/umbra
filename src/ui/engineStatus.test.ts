import { describe, it, expect } from 'vitest';
import { statusText, type EngineStatus } from './engineStatus';

describe('engine status line text', () => {
  it('Steam live: plain high-fidelity label, no warning', () => {
    const s: EngineStatus = { engine: 'steam', fellBack: false, reason: '' };
    expect(statusText(s)).toEqual({
      label: 'High-fidelity audio (Steam Audio)',
      detail: '',
      warn: false,
    });
  });

  it('our engine by choice (user did not want Steam): standard, no warning', () => {
    const s: EngineStatus = { engine: 'ours', fellBack: false, reason: '' };
    expect(statusText(s).warn).toBe(false);
    expect(statusText(s).label).toBe('Standard audio');
  });

  it('involuntary fallback: warns AND shows the reason', () => {
    const s: EngineStatus = {
      engine: 'ours',
      fellBack: true,
      reason: "couldn't download the audio engine (network or blocked script)",
    };
    const t = statusText(s);
    expect(t.warn).toBe(true);
    expect(t.label).toContain('high-fidelity unavailable');
    expect(t.detail).toContain("couldn't download");
  });

  it('fallback with no captured reason still warns (no dangling "Reason:")', () => {
    const s: EngineStatus = { engine: 'ours', fellBack: true, reason: '' };
    const t = statusText(s);
    expect(t.warn).toBe(true);
    expect(t.detail).toBe('');
  });
});
