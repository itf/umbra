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
  STEAM_REFLECTION_WET_KEY,
  STEAM_REFLECTION_BUS_KEY,
  STEAM_REVERB_BUS_KEY,
  DEFAULT_STEAM_REFLECTION_WET,
  DEFAULT_STEAM_REFLECTION_BUS,
  DEFAULT_STEAM_REVERB_BUS,
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

describe('SettingsStore Steam reflection / bus levels', () => {
  it('all three default to full (1.0) when unset — byte-identical to today', () => {
    const s = new SettingsStore(memStorage());
    expect(DEFAULT_STEAM_REFLECTION_WET).toBe(1);
    expect(DEFAULT_STEAM_REFLECTION_BUS).toBe(1);
    expect(DEFAULT_STEAM_REVERB_BUS).toBe(1);
    expect(s.steamReflectionWet()).toBe(1);
    expect(s.steamReflectionBus()).toBe(1);
    expect(s.steamReverbBus()).toBe(1);
  });
  it('reflection wet level round-trips, clamps, and persists', () => {
    const backing = memStorage();
    const s = new SettingsStore(backing);
    s.setSteamReflectionWet(0.3);
    expect(s.steamReflectionWet()).toBe(0.3);
    expect(backing.map.get(STEAM_REFLECTION_WET_KEY)).toBe('0.3');
    expect(new SettingsStore(backing).steamReflectionWet()).toBe(0.3);
    s.setSteamReflectionWet(5);
    expect(s.steamReflectionWet()).toBe(1);
    s.setSteamReflectionWet(-5);
    expect(s.steamReflectionWet()).toBe(0);
  });
  it('reflection bus level round-trips, clamps, and persists', () => {
    const backing = memStorage();
    const s = new SettingsStore(backing);
    s.setSteamReflectionBus(0.5);
    expect(s.steamReflectionBus()).toBe(0.5);
    expect(backing.map.get(STEAM_REFLECTION_BUS_KEY)).toBe('0.5');
    expect(new SettingsStore(backing).steamReflectionBus()).toBe(0.5);
  });
  it('reverb bus level round-trips, clamps, and persists', () => {
    const backing = memStorage();
    const s = new SettingsStore(backing);
    s.setSteamReverbBus(0.5);
    expect(s.steamReverbBus()).toBe(0.5);
    expect(backing.map.get(STEAM_REVERB_BUS_KEY)).toBe('0.5');
    expect(new SettingsStore(backing).steamReverbBus()).toBe(0.5);
  });
  it('returns defaults for corrupt stored values', () => {
    const backing = memStorage();
    backing.map.set(STEAM_REFLECTION_WET_KEY, 'garbage');
    backing.map.set(STEAM_REFLECTION_BUS_KEY, 'nope');
    backing.map.set(STEAM_REVERB_BUS_KEY, 'bad');
    const s = new SettingsStore(backing);
    expect(s.steamReflectionWet()).toBe(DEFAULT_STEAM_REFLECTION_WET);
    expect(s.steamReflectionBus()).toBe(DEFAULT_STEAM_REFLECTION_BUS);
    expect(s.steamReverbBus()).toBe(DEFAULT_STEAM_REVERB_BUS);
  });
});

describe('SettingsStore probe choice', () => {
  it('defaults to the noise-burst clap and round-trips a choice', () => {
    const s = new SettingsStore(memStorage());
    expect(s.probeChoice()).toBe('clap');
    s.setProbeChoice('rec:dental');
    expect(s.probeChoice()).toBe('rec:dental');
  });

  it('migrates the legacy realistic-click toggle to the mouthclick choice', () => {
    const s = new SettingsStore(memStorage());
    // Simulate an upgrading user who had the old boolean ON but never set a choice.
    s.setRealisticClick(true);
    expect(s.probeChoice()).toBe('mouthclick');
    // An explicit choice wins over the legacy toggle.
    s.setProbeChoice('clap');
    expect(s.probeChoice()).toBe('clap');
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
