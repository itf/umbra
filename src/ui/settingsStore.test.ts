import { describe, it, expect } from 'vitest';
import {
  SettingsStore,
  clampVolume,
  percentToVolume,
  volumeToPercent,
  DEFAULT_MASTER_VOLUME,
  MASTER_VOLUME_KEY,
  STEAM_ENGINE_KEY,
  TTS_ENABLED_KEY,
  TTS_VOICE_KEY,
  TTS_RATE_KEY,
  TTS_PITCH_KEY,
  clampTtsRate,
  clampTtsPitch,
  clampLevel,
  STEAM_REVERB_LEVEL_KEY,
  STEAM_REFLECTION_LEVEL_KEY,
  DEFAULT_STEAM_REVERB_LEVEL,
  DEFAULT_STEAM_REFLECTION_LEVEL,
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

describe('SettingsStore steam engine preference', () => {
  it('defaults OFF and unset when never chosen', () => {
    const s = new SettingsStore(memStorage());
    expect(s.steamEngineEnabled()).toBe(false);
    expect(s.hasSteamEnginePref()).toBe(false);
  });
  it('get/set round-trips, persists, and records that a pref exists', () => {
    const backing = memStorage();
    const s = new SettingsStore(backing);
    s.setSteamEngineEnabled(true);
    expect(s.steamEngineEnabled()).toBe(true);
    expect(s.hasSteamEnginePref()).toBe(true);
    expect(backing.map.get(STEAM_ENGINE_KEY)).toBe('1');
    expect(new SettingsStore(backing).steamEngineEnabled()).toBe(true);
    s.setSteamEngineEnabled(false);
    expect(s.steamEngineEnabled()).toBe(false);
    expect(s.hasSteamEnginePref()).toBe(true); // explicit OFF still counts as a pref
  });
});

describe('SettingsStore TTS (spoken voice, 8A)', () => {
  it('TTS enabled DEFAULTS OFF (opt-in, no double-speak for SR users)', () => {
    expect(new SettingsStore(memStorage()).ttsEnabled()).toBe(false);
  });
  it('TTS enabled round-trips and persists', () => {
    const backing = memStorage();
    const s = new SettingsStore(backing);
    s.setTtsEnabled(true);
    expect(s.ttsEnabled()).toBe(true);
    expect(backing.map.get(TTS_ENABLED_KEY)).toBe('1');
    expect(new SettingsStore(backing).ttsEnabled()).toBe(true);
  });
  it('TTS voice defaults empty (auto-pick) and persists a name', () => {
    const backing = memStorage();
    const s = new SettingsStore(backing);
    expect(s.ttsVoice()).toBe('');
    s.setTtsVoice('Alice');
    expect(s.ttsVoice()).toBe('Alice');
    expect(backing.map.get(TTS_VOICE_KEY)).toBe('Alice');
  });
  it('TTS rate defaults to 1, clamps, and persists', () => {
    const backing = memStorage();
    const s = new SettingsStore(backing);
    expect(s.ttsRate()).toBe(1);
    s.setTtsRate(99);
    expect(s.ttsRate()).toBe(2);
    expect(backing.map.get(TTS_RATE_KEY)).toBe('2');
    s.setTtsRate(0.1);
    expect(s.ttsRate()).toBe(0.5);
  });
  it('TTS pitch defaults to 1, clamps, and persists', () => {
    const backing = memStorage();
    const s = new SettingsStore(backing);
    expect(s.ttsPitch()).toBe(1);
    s.setTtsPitch(-3);
    expect(s.ttsPitch()).toBe(0);
    expect(backing.map.get(TTS_PITCH_KEY)).toBe('0');
    s.setTtsPitch(9);
    expect(s.ttsPitch()).toBe(2);
  });
  it('returns defaults for corrupt stored rate/pitch', () => {
    const backing = memStorage();
    backing.map.set(TTS_RATE_KEY, 'garbage');
    backing.map.set(TTS_PITCH_KEY, 'nope');
    const s = new SettingsStore(backing);
    expect(s.ttsRate()).toBe(1);
    expect(s.ttsPitch()).toBe(1);
  });
});

describe('clampTtsRate / clampTtsPitch (pure)', () => {
  it('rate to [0.5,2], default on non-finite', () => {
    expect(clampTtsRate(0.1)).toBe(0.5);
    expect(clampTtsRate(3)).toBe(2);
    expect(clampTtsRate(1.2)).toBe(1.2);
    expect(clampTtsRate(NaN)).toBe(1);
  });
  it('pitch to [0,2], default on non-finite', () => {
    expect(clampTtsPitch(-1)).toBe(0);
    expect(clampTtsPitch(5)).toBe(2);
    expect(clampTtsPitch(NaN)).toBe(1);
  });
});

describe('clampLevel (pure)', () => {
  it('clamps to [0,1], default on non-finite', () => {
    expect(clampLevel(-1, 1)).toBe(0);
    expect(clampLevel(0, 1)).toBe(0);
    expect(clampLevel(0.3, 1)).toBe(0.3);
    expect(clampLevel(2, 1)).toBe(1);
    expect(clampLevel(NaN, 0.5)).toBe(0.5);
  });
});

describe('SettingsStore Steam reverb / reflection levels', () => {
  it('default to full (1.0) when unset — byte-identical to today', () => {
    const s = new SettingsStore(memStorage());
    expect(DEFAULT_STEAM_REVERB_LEVEL).toBe(1);
    expect(DEFAULT_STEAM_REFLECTION_LEVEL).toBe(1);
    expect(s.steamReverbLevel()).toBe(1);
    expect(s.steamReflectionLevel()).toBe(1);
  });
  it('reverb level round-trips, clamps, and persists', () => {
    const backing = memStorage();
    const s = new SettingsStore(backing);
    s.setSteamReverbLevel(0.3);
    expect(s.steamReverbLevel()).toBe(0.3);
    expect(backing.map.get(STEAM_REVERB_LEVEL_KEY)).toBe('0.3');
    expect(new SettingsStore(backing).steamReverbLevel()).toBe(0.3);
    s.setSteamReverbLevel(5);
    expect(s.steamReverbLevel()).toBe(1);
    s.setSteamReverbLevel(-5);
    expect(s.steamReverbLevel()).toBe(0);
  });
  it('reflection level round-trips, clamps, and persists', () => {
    const backing = memStorage();
    const s = new SettingsStore(backing);
    s.setSteamReflectionLevel(0.5);
    expect(s.steamReflectionLevel()).toBe(0.5);
    expect(backing.map.get(STEAM_REFLECTION_LEVEL_KEY)).toBe('0.5');
    expect(new SettingsStore(backing).steamReflectionLevel()).toBe(0.5);
  });
  it('returns defaults for corrupt stored values', () => {
    const backing = memStorage();
    backing.map.set(STEAM_REVERB_LEVEL_KEY, 'garbage');
    backing.map.set(STEAM_REFLECTION_LEVEL_KEY, 'nope');
    const s = new SettingsStore(backing);
    expect(s.steamReverbLevel()).toBe(DEFAULT_STEAM_REVERB_LEVEL);
    expect(s.steamReflectionLevel()).toBe(DEFAULT_STEAM_REFLECTION_LEVEL);
  });
});

describe('SettingsStore without storage (degrades to memory)', () => {
  it('keeps the session consistent', () => {
    const s = new SettingsStore(null);
    s.setMasterVolume(0.3);
    s.setSteamEngineEnabled(true);
    expect(s.masterVolume()).toBe(0.3);
    expect(s.steamEngineEnabled()).toBe(true);
  });
});
