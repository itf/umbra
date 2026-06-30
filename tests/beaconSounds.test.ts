import { describe, it, expect } from 'vitest';
import {
  bellPartials, musicboxNotes, semitoneToFreq, resolveBeaconPreset,
  isBeaconPreset, beaconPresetNames, beaconTiming, DEFAULT_BEACON_PRESET,
  MUSICBOX_MOTIF, proximityGain,
} from '../src/game/beaconSounds';
import { emptyLevel, isLevel, type Level } from '../src/level/schema';

describe('proximityGain ("getting warmer" cue)', () => {
  it('is louder closer and quieter far away (monotonic)', () => {
    const near = proximityGain(0.8);
    const mid = proximityGain(4);
    const far = proximityGain(8);
    expect(near).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(far);
  });
  it('NEVER exceeds unity — it ducks toward farGain when far, returns to unity up close', () => {
    // Regression guard: a >1 boost overdrove the master limiter (crackle at rest).
    expect(proximityGain(0.8)).toBeCloseTo(1.0, 6); // near = unity, not 1.8
    expect(proximityGain(0)).toBeCloseTo(1.0, 6);
    expect(proximityGain(8)).toBeCloseTo(0.55, 6); // far = ducked default
    expect(proximityGain(50)).toBeCloseTo(0.55, 6);
  });
  it('honors configured near/far gains', () => {
    expect(proximityGain(0.8, 0.8, 8, 1.0, 0.4)).toBeCloseTo(1.0, 6);
    expect(proximityGain(8, 0.8, 8, 1.0, 0.4)).toBeCloseTo(0.4, 6);
  });
  it('stays bounded ≤ unity and finite for degenerate input', () => {
    expect(proximityGain(Infinity)).toBe(1); // nearGain default
    const g = proximityGain(3);
    expect(g).toBeGreaterThanOrEqual(0.55);
    expect(g).toBeLessThanOrEqual(1.0);
  });
});

describe('beacon preset recipes', () => {
  it('bell partials scale with base frequency and ring down', () => {
    const p440 = bellPartials(440);
    const p880 = bellPartials(880);
    expect(p440.length).toBeGreaterThan(3);
    // First partial is the half-frequency "hum".
    expect(p440[0].freq).toBeCloseTo(220);
    // Doubling the base doubles every partial.
    p440.forEach((p, i) => expect(p880[i].freq).toBeCloseTo(p.freq * 2));
    // Partials are inharmonic (not integer multiples of the base).
    const ratios = p440.map((p) => p.freq / 440);
    expect(ratios).toContain(1.2); // minor-third tierce
    // Decays are positive and finite.
    for (const p of p440) expect(p.decay).toBeGreaterThan(0);
  });

  it('semitone math: +12 semitones doubles, +7 is a fifth', () => {
    expect(semitoneToFreq(440, 12)).toBeCloseTo(880);
    expect(semitoneToFreq(440, 0)).toBeCloseTo(440);
    expect(semitoneToFreq(440, 7) / 440).toBeCloseTo(Math.pow(2, 7 / 12));
  });

  it('musicbox notes follow the motif from the base note', () => {
    const notes = musicboxNotes(440);
    expect(notes.length).toBe(MUSICBOX_MOTIF.length);
    expect(notes[0]).toBeCloseTo(440);          // root
    expect(notes[2]).toBeCloseTo(880);          // octave
    expect(notes[1]).toBeCloseTo(semitoneToFreq(440, 7)); // fifth
  });

  it('preset lookup falls back to the default for unknown names', () => {
    expect(resolveBeaconPreset('bell')).toBe('bell');
    expect(resolveBeaconPreset('nope')).toBe(DEFAULT_BEACON_PRESET);
    expect(resolveBeaconPreset(undefined)).toBe(DEFAULT_BEACON_PRESET);
    expect(DEFAULT_BEACON_PRESET).toBe('tone');
    expect(isBeaconPreset('drip')).toBe(true);
    expect(isBeaconPreset('xyz')).toBe(false);
  });

  it('exposes all presets and their timing', () => {
    const names = beaconPresetNames();
    expect(names).toEqual(['tone', 'flat', 'pulse', 'bell', 'musicbox', 'drip', 'hum']);
    expect(beaconTiming('hum').loop).toBe(0);      // continuous
    expect(beaconTiming('flat').loop).toBe(0);     // continuous, no tremolo
    expect(beaconTiming('bell').loop).toBeGreaterThan(0); // pulsed
  });
});

describe('beacon schema back-compat', () => {
  it('an old beacon without `sound` validates and defaults to tone', () => {
    const lvl = emptyLevel();
    delete (lvl.beacons[0] as { sound?: unknown }).sound;
    expect(isLevel(lvl)).toBe(true);
    expect(lvl.beacons[0].sound).toBe('tone');
  });

  it('an unknown `sound` is normalized to the default on validate', () => {
    const lvl = JSON.parse(JSON.stringify(emptyLevel())) as Level;
    (lvl.beacons[0] as { sound?: unknown }).sound = 'bogus';
    expect(isLevel(lvl)).toBe(true);
    expect(lvl.beacons[0].sound).toBe('tone');
  });

  it('a beacon with sound + soundUrl round-trips through JSON', () => {
    const lvl = emptyLevel();
    lvl.beacons[0].sound = 'bell';
    lvl.beacons[0].soundUrl = 'sounds/custom.mp3';
    const round = JSON.parse(JSON.stringify(lvl)) as Level;
    expect(isLevel(round)).toBe(true);
    expect(round.beacons[0].sound).toBe('bell');
    expect(round.beacons[0].soundUrl).toBe('sounds/custom.mp3');
  });
});
