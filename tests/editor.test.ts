/**
 * Editor logic tests — the pure, serializable parts:
 *  - applyWallMotion mutates / clears WallObj.motion correctly;
 *  - a level authored with every feature round-trips through export/import intact.
 *
 * DOM wiring (renderProps, pointer handlers) stays integration-noted; the pure
 * apply-functions are extracted into src/editor/apply.ts so they test without a
 * browser, mirroring the project's pure-core / ear-or-DOM-verified split.
 */
import { describe, it, expect } from 'vitest';
import {
  applyWallMotion, DEFAULT_TRANSLATE, DEFAULT_SLIDE,
} from '../src/editor/apply';
import { emptyLevel, type Level, type WallObj } from '../src/level/schema';
import { exportLevel, importLevel } from '../src/level/storage';

function wall(): WallObj {
  return { id: 'w1', ax: 0, az: 0, bx: 4, bz: 0, material: 'concrete' };
}

describe('applyWallMotion', () => {
  it('seeds a translate spec with defaults', () => {
    const w = wall();
    applyWallMotion(w, 'motionKind', 'translate', NaN);
    expect(w.motion).toEqual(DEFAULT_TRANSLATE);
  });

  it('seeds a slide spec with defaults', () => {
    const w = wall();
    applyWallMotion(w, 'motionKind', 'slide', NaN);
    expect(w.motion).toEqual(DEFAULT_SLIDE);
  });

  it("clearing to 'none' removes the motion field entirely", () => {
    const w = wall();
    applyWallMotion(w, 'motionKind', 'translate', NaN);
    expect(w.motion).toBeDefined();
    applyWallMotion(w, 'motionKind', 'none', NaN);
    expect(w.motion).toBeUndefined();
    expect('motion' in w).toBe(false);
  });

  it('edits translate params', () => {
    const w = wall();
    applyWallMotion(w, 'motionKind', 'translate', NaN);
    applyWallMotion(w, 'motionDx', '3', 3);
    applyWallMotion(w, 'motionDz', '-1.5', -1.5);
    applyWallMotion(w, 'motionPeriod', '6', 6);
    expect(w.motion).toEqual({ kind: 'translate', dx: 3, dz: -1.5, period: 6 });
  });

  it('clamps slide openFraction to 0..1 and ignores non-positive period', () => {
    const w = wall();
    applyWallMotion(w, 'motionKind', 'slide', NaN);
    applyWallMotion(w, 'motionOpen', '5', 5);
    expect(w.motion).toMatchObject({ openFraction: 1 });
    applyWallMotion(w, 'motionOpen', '-2', -2);
    expect(w.motion).toMatchObject({ openFraction: 0 });
    applyWallMotion(w, 'motionPeriod', '0', 0); // ignored
    expect(w.motion).toMatchObject({ period: DEFAULT_SLIDE.period });
  });

  it('ignores translate keys while in slide mode (and returns handled)', () => {
    const w = wall();
    applyWallMotion(w, 'motionKind', 'slide', NaN);
    const handled = applyWallMotion(w, 'motionDx', '9', 9);
    expect(handled).toBe(true);
    expect(w.motion).toEqual(DEFAULT_SLIDE);
  });

  it('returns false for non-motion keys', () => {
    expect(applyWallMotion(wall(), 'ax', '2', 2)).toBe(false);
  });
});

describe('full-feature level round-trips through export/import', () => {
  it('preserves moving wall + beacon preset + custom url + monster + ceiling zone + open + materials', () => {
    const lvl: Level = emptyLevel('Everything');
    lvl.open = true;
    lvl.hasCeiling = false;
    lvl.roomMaterial = 'glass';
    lvl.floorMaterial = 'carpet';
    lvl.ceilingMaterial = 'wood';
    lvl.start = { x: 1, z: 2, yaw: Math.PI / 2 };
    lvl.beacons = [
      { id: 'b1', x: 5, z: 5, freq: 523, goalRadius: 1, sound: 'bell', soundUrl: 'https://x/y.wav' },
      { id: 'b2', x: 8, z: 3, freq: 440, goalRadius: 0.8, sound: 'musicbox' },
    ];
    lvl.walls = [
      { id: 'w-static', ax: 0, az: 0, bx: 2, bz: 0, material: 'concrete' },
      { id: 'w-tr', ax: 3, az: 0, bx: 3, bz: 4, material: 'wood',
        motion: { kind: 'translate', dx: 2, dz: 1, period: 5 } },
      { id: 'w-door', ax: 6, az: 0, bx: 6, bz: 3, material: 'glass',
        motion: { kind: 'slide', openFraction: 0.7, period: 3 } },
    ];
    lvl.floors = [{ id: 'f1', x: 1, z: 1, w: 3, d: 2, material: 'tile' }];
    lvl.ceilings = [{ id: 'c1', x: 0, z: 0, w: 4, d: 4, height: 2, material: 'acoustic_foam' }];
    lvl.monsters = [{ id: 'm1', x: 9, z: 9, speed: 1.7, sound: 'growl' }];

    const round = importLevel(exportLevel(lvl));

    // Deep equality: every authored field survives the JSON trip unchanged.
    expect(round).toEqual(lvl);
    // Spot-check the motion specs specifically (the new editor surface).
    expect(round.walls[1].motion).toEqual({ kind: 'translate', dx: 2, dz: 1, period: 5 });
    expect(round.walls[2].motion).toEqual({ kind: 'slide', openFraction: 0.7, period: 3 });
    expect(round.walls[0].motion).toBeUndefined();
    expect(round.beacons[0]).toMatchObject({ sound: 'bell', soundUrl: 'https://x/y.wav' });
    expect(round.monsters[0]).toMatchObject({ speed: 1.7, sound: 'growl' });
    expect(round.ceilings[0]).toMatchObject({ height: 2, material: 'acoustic_foam' });
  });

  it('a static wall authored then cleared has no motion key after round-trip', () => {
    const lvl = emptyLevel('Cleared');
    const w: WallObj = { id: 'w', ax: 0, az: 0, bx: 1, bz: 0, material: 'concrete' };
    applyWallMotion(w, 'motionKind', 'translate', NaN);
    applyWallMotion(w, 'motionKind', 'none', NaN);
    lvl.walls = [w];
    const round = importLevel(exportLevel(lvl));
    expect('motion' in round.walls[0]).toBe(false);
  });
});
