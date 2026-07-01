import { describe, it, expect } from 'vitest';
import {
  NoiseTracker,
  makeNoiseEvent,
  loudnessFor,
  stepLoudnessForMaterial,
  STUMBLE_LOUDNESS,
  BUMP_LOUDNESS,
  NOISE_DECAY_MS,
} from '../src/game/noiseEvents';
import { DEFAULT_NOISE_THRESHOLD, makeMonster, updateMonster } from '../src/game/monster';

describe('loudness mapping', () => {
  it('loud floors are louder than soft floors for a step', () => {
    const gravel = stepLoudnessForMaterial('gravel');
    const carpet = stepLoudnessForMaterial('carpet');
    const foam = stepLoudnessForMaterial('acoustic_foam');
    expect(gravel).toBeGreaterThan(carpet);
    expect(carpet).toBeGreaterThanOrEqual(foam);
  });

  it('step loudness is normalized to [0,1]', () => {
    for (const m of ['gravel', 'carpet', 'acoustic_foam', 'concrete', 'wood', 'rough_stone']) {
      const l = stepLoudnessForMaterial(m);
      expect(l).toBeGreaterThanOrEqual(0);
      expect(l).toBeLessThanOrEqual(1);
    }
  });

  it('the quietest material maps to ~0 and a hard floor is high', () => {
    expect(stepLoudnessForMaterial('acoustic_foam')).toBeCloseTo(0, 5);
    expect(stepLoudnessForMaterial('concrete')).toBeGreaterThan(0.8);
  });

  // ---- SNEAK INTENT: locked to the absolute monster threshold ----------------
  it('soft floors are sneakable: step loudness STRICTLY below the monster threshold', () => {
    for (const soft of ['acoustic_foam', 'curtain', 'carpet', 'grass']) {
      expect(stepLoudnessForMaterial(soft)).toBeLessThan(DEFAULT_NOISE_THRESHOLD);
    }
  });

  it('hard/loud floors are audible: step loudness comfortably above the threshold', () => {
    for (const loud of ['concrete', 'tile', 'gravel', 'rough_stone']) {
      expect(stepLoudnessForMaterial(loud)).toBeGreaterThan(0.4);
    }
  });

  it('loudness is monotonic-ish in the material step level', () => {
    const order = ['acoustic_foam', 'curtain', 'carpet', 'grass', 'gravel', 'concrete'];
    const loud = order.map((m) => stepLoudnessForMaterial(m));
    for (let i = 1; i < loud.length; i++) {
      expect(loud[i]).toBeGreaterThanOrEqual(loud[i - 1]);
    }
  });

  it('unknown material falls back to concrete', () => {
    expect(stepLoudnessForMaterial('unobtanium')).toBeCloseTo(
      stepLoudnessForMaterial('concrete'),
      6,
    );
  });

  it('stumble and bump are large fixed spikes regardless of floor', () => {
    expect(loudnessFor('stumble', 'carpet')).toBe(STUMBLE_LOUDNESS);
    expect(loudnessFor('stumble', 'gravel')).toBe(STUMBLE_LOUDNESS);
    expect(loudnessFor('bump', 'acoustic_foam')).toBe(BUMP_LOUDNESS);
    expect(loudnessFor('bump', 'gravel')).toBe(BUMP_LOUDNESS);
  });

  it('ordering: bump ≈ stumble > gravel-step > carpet-step', () => {
    const stumble = loudnessFor('stumble', 'carpet');
    const bump = loudnessFor('bump', 'carpet');
    const gravelStep = loudnessFor('step', 'gravel');
    const carpetStep = loudnessFor('step', 'carpet');
    expect(stumble).toBeGreaterThan(gravelStep);
    expect(bump).toBeGreaterThan(gravelStep);
    expect(gravelStep).toBeGreaterThan(carpetStep);
    // bump and stumble both clearly above gravel, within ~0.2 of each other
    expect(Math.abs(stumble - bump)).toBeLessThan(0.2);
  });
});

describe('makeNoiseEvent', () => {
  it('builds a positioned event with computed loudness', () => {
    const e = makeNoiseEvent('step', 3, -4, 'gravel', 1000);
    expect(e).toMatchObject({ x: 3, z: -4, kind: 'step', tMs: 1000 });
    expect(e.loudness).toBe(stepLoudnessForMaterial('gravel'));
  });
});

describe('NoiseTracker', () => {
  it('emit then lastNoise returns the event', () => {
    const t = new NoiseTracker();
    const e = makeNoiseEvent('step', 1, 2, 'gravel', 100);
    t.emit(e);
    expect(t.lastNoise()).toBe(e);
  });

  it('lastNoise is null before any emit', () => {
    expect(new NoiseTracker().lastNoise()).toBeNull();
  });

  it('a newer event replaces the previous one', () => {
    const t = new NoiseTracker();
    t.emit(makeNoiseEvent('step', 0, 0, 'carpet', 100));
    const newer = makeNoiseEvent('stumble', 5, 5, 'carpet', 200);
    t.emit(newer);
    expect(t.lastNoise()).toBe(newer);
  });

  it('invokes the onNoise callback on emit', () => {
    const seen: number[] = [];
    const t = new NoiseTracker((e) => seen.push(e.tMs));
    t.emit(makeNoiseEvent('bump', 0, 0, 'wood', 42));
    expect(seen).toEqual([42]);
  });

  it('loudnessAt decays over time; a fresh noise is louder now than a stale one', () => {
    const t = new NoiseTracker();
    const e = makeNoiseEvent('stumble', 0, 0, 'carpet', 1000);
    t.emit(e);
    const atEmit = t.loudnessAt(1000);
    const later = t.loudnessAt(1000 + NOISE_DECAY_MS);
    expect(atEmit).toBeCloseTo(e.loudness, 6);
    expect(later).toBeLessThan(atEmit);
    expect(later).toBeCloseTo(e.loudness * Math.exp(-1), 6);
  });

  it('loudnessAt is 0 before any noise', () => {
    expect(new NoiseTracker().loudnessAt(0)).toBe(0);
  });
});

// Mirrors the game.ts wiring (which needs Web Audio to construct): a step on
// gravel records a louder last-noise than a step on carpet, and a stumble
// records a loud last-noise at the player's position. This exercises the exact
// pure calls game.ts makes (makeNoiseEvent + tracker.emit).
describe('game.ts wiring (pure mirror)', () => {
  it('gravel step records a louder last-noise than a carpet step', () => {
    const t = new NoiseTracker();
    t.emit(makeNoiseEvent('step', 1, 1, 'carpet', 100));
    const carpetLoud = t.lastNoise()!.loudness;
    t.emit(makeNoiseEvent('step', 2, 2, 'gravel', 200));
    expect(t.lastNoise()!.loudness).toBeGreaterThan(carpetLoud);
  });

  it('a stumble records a loud last-noise at the player position', () => {
    const t = new NoiseTracker();
    t.emit(makeNoiseEvent('stumble', 7, -3, 'carpet', 500));
    const last = t.lastNoise()!;
    expect(last.kind).toBe('stumble');
    expect(last.x).toBe(7);
    expect(last.z).toBe(-3);
    expect(last.loudness).toBe(STUMBLE_LOUDNESS);
  });
});

// Integration: a careful carpet step does NOT retarget the monster (its decayed
// loudness at emission is below threshold), while a concrete step DOES. This locks
// the end-to-end SNEAK mechanic across noiseEvents.ts + monster.ts.
describe('sneak mechanic (noise → monster retarget)', () => {
  it('a carpet step does not retarget the monster; a concrete step does', () => {
    const nowMs = 1000;
    const start = makeMonster(0, 0, 1);

    const carpet = makeNoiseEvent('step', 10, 10, 'carpet', nowMs);
    const afterCarpet = updateMonster(start, carpet, nowMs, 16);
    expect(afterCarpet.target).toBeNull();
    expect(afterCarpet.phase).toBe('idle');

    const concrete = makeNoiseEvent('step', 10, 10, 'concrete', nowMs);
    const afterConcrete = updateMonster(start, concrete, nowMs, 16);
    expect(afterConcrete.target).toEqual({ x: 10, z: 10 });
    expect(afterConcrete.phase).toBe('investigate');
  });
});
