/**
 * Pure tests for the shareable head-response profile code.
 */
import { describe, it, expect } from 'vitest';
import { encodeProfile, decodeProfile } from '../src/ui/hrtfProfileCode';
import { NEUTRAL_PERSONALIZATION } from '../src/engine/hrtf/personalize';

describe('hrtf profile code', () => {
  const profile = {
    base: 'cipic_124',
    params: { itdScale: 1.3, elevTilt: -4, frontBackTilt: 6, notchHz: 8200, notchDepth: 14 },
  };

  it('round-trips a profile', () => {
    const code = encodeProfile(profile);
    const back = decodeProfile(code);
    expect(back).not.toBeNull();
    expect(back!.base).toBe('cipic_124');
    expect(back!.params.itdScale).toBeCloseTo(1.3, 5);
    expect(back!.params.notchHz).toBeCloseTo(8200, 5);
  });

  it('produces a compact, URL-safe code', () => {
    const code = encodeProfile(profile);
    expect(code.startsWith('U1.')).toBe(true);
    expect(code).not.toMatch(/[+/=]/); // url-safe, no padding
    expect(code.length).toBeLessThan(160);
  });

  it('rejects garbage and wrong-prefix strings', () => {
    expect(decodeProfile('not a code')).toBeNull();
    expect(decodeProfile('U1.@@@not-base64@@@')).toBeNull();
    expect(decodeProfile('')).toBeNull();
  });

  it('clamps out-of-range params from a code', () => {
    const wild = encodeProfile({ base: 'sadie_h3', params: { ...NEUTRAL_PERSONALIZATION, itdScale: 99, notchDepth: -50 } });
    const back = decodeProfile(wild)!;
    expect(back.params.itdScale).toBeLessThanOrEqual(2.0);
    expect(back.params.notchDepth).toBeGreaterThanOrEqual(0);
  });

  it('falls back to default base when the code omits it', () => {
    // Hand-craft a code with no base.
    const code = encodeProfile({ base: '', params: NEUTRAL_PERSONALIZATION });
    const back = decodeProfile(code, 'sadie_h3')!;
    expect(back.base).toBe('sadie_h3');
  });
});
