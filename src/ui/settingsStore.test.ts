import { describe, it, expect } from 'vitest';
import {
  SettingsStore,
  clampVolume,
  percentToVolume,
  volumeToPercent,
  DEFAULT_MASTER_VOLUME,
  MASTER_VOLUME_KEY,
  WARMER_CUE_KEY,
} from './settingsStore';

/** A minimal in-memory Storage stand-in for deterministic, isolated tests. */
function memStorage() {
  const m = new Map<string, string>();
  return {
    map: m,
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

describe('clampVolume', () => {
  it('clamps to [0,1]', () => {
    expect(clampVolume(-1)).toBe(0);
    expect(clampVolume(0)).toBe(0);
    expect(clampVolume(0.5)).toBe(0.5);
    expect(clampVolume(1)).toBe(1);
    expect(clampVolume(2)).toBe(1);
  });
  it('defaults on non-finite (corrupt data never mutes)', () => {
    expect(clampVolume(NaN)).toBe(DEFAULT_MASTER_VOLUME);
    expect(clampVolume(Infinity)).toBe(1); // Infinity > 1 is finite-checked first → default
  });
});

describe('percent <-> volume', () => {
  it('percentToVolume clamps', () => {
    expect(percentToVolume(0)).toBe(0);
    expect(percentToVolume(50)).toBe(0.5);
    expect(percentToVolume(100)).toBe(1);
    expect(percentToVolume(150)).toBe(1);
    expect(percentToVolume(-10)).toBe(0);
  });
  it('volumeToPercent rounds', () => {
    expect(volumeToPercent(0)).toBe(0);
    expect(volumeToPercent(0.5)).toBe(50);
    expect(volumeToPercent(0.755)).toBe(76);
    expect(volumeToPercent(1)).toBe(100);
  });
});

describe('SettingsStore master volume', () => {
  it('defaults to full when unset', () => {
    const s = new SettingsStore(memStorage());
    expect(s.masterVolume()).toBe(DEFAULT_MASTER_VOLUME);
  });
  it('get/set round-trips and persists', () => {
    const backing = memStorage();
    const s = new SettingsStore(backing);
    s.setMasterVolume(0.4);
    expect(s.masterVolume()).toBe(0.4);
    expect(backing.map.get(MASTER_VOLUME_KEY)).toBe('0.4');
    // A fresh store over the same backing reads the persisted value.
    expect(new SettingsStore(backing).masterVolume()).toBe(0.4);
  });
  it('clamps on set', () => {
    const s = new SettingsStore(memStorage());
    s.setMasterVolume(5);
    expect(s.masterVolume()).toBe(1);
    s.setMasterVolume(-5);
    expect(s.masterVolume()).toBe(0);
  });
  it('returns default for corrupt stored value', () => {
    const backing = memStorage();
    backing.map.set(MASTER_VOLUME_KEY, 'garbage');
    expect(new SettingsStore(backing).masterVolume()).toBe(DEFAULT_MASTER_VOLUME);
  });
});

describe('SettingsStore warmer cue', () => {
  it('defaults ON when unset', () => {
    expect(new SettingsStore(memStorage()).warmerCueEnabled()).toBe(true);
  });
  it('get/set round-trips and persists', () => {
    const backing = memStorage();
    const s = new SettingsStore(backing);
    s.setWarmerCueEnabled(false);
    expect(s.warmerCueEnabled()).toBe(false);
    expect(backing.map.get(WARMER_CUE_KEY)).toBe('0');
    expect(new SettingsStore(backing).warmerCueEnabled()).toBe(false);
    s.setWarmerCueEnabled(true);
    expect(s.warmerCueEnabled()).toBe(true);
  });
});

describe('SettingsStore without storage (degrades to memory)', () => {
  it('keeps the session consistent', () => {
    const s = new SettingsStore(null);
    s.setMasterVolume(0.3);
    s.setWarmerCueEnabled(false);
    expect(s.masterVolume()).toBe(0.3);
    expect(s.warmerCueEnabled()).toBe(false);
  });
});
