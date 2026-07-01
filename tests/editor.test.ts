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
  applyAbsorberProp, defaultAbsorber, lintLevel,
  applyAmbienceProp, defaultAmbience, applyEventProp, defaultEvent,
} from '../src/editor/apply';
import { emptyLevel, type Level, type WallObj, type WallPatch } from '../src/level/schema';
import { exportLevel, importLevel } from '../src/level/storage';
import { kindLabel, objectListModel, type SelKind } from '../src/editor/objectList';
import { MONSTER_PRESETS } from '../src/game/monsterSounds';

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

describe('kindLabel', () => {
  it('labels every selectable kind', () => {
    const expected: Record<SelKind, string> = {
      start: 'Start point',
      beacon: 'Beacon',
      wall: 'Wall',
      floor: 'Floor zone',
      ceiling: 'Ceiling zone',
      monster: 'Monster',
      absorber: 'Wall material patch',
      exit: 'Escape exit',
      ambience: 'Ambient source',
      win: 'Win area',
    };
    for (const [kind, label] of Object.entries(expected)) {
      expect(kindLabel(kind as SelKind)).toBe(label);
    }
  });
});

describe('objectListModel', () => {
  it('lists start first, then every object with kind + id labels', () => {
    const lvl = emptyLevel('List');
    lvl.beacons = [{ id: 'b1', x: 1, z: 1, freq: 440, goalRadius: 0.8 }];
    lvl.walls = [{ id: 'wall-1', ax: 0, az: 0, bx: 2, bz: 0, material: 'concrete' }];
    lvl.floors = [{ id: 'f2', x: 0, z: 0, w: 1, d: 1, material: 'carpet' }];
    lvl.ceilings = [{ id: 'c1', x: 0, z: 0, w: 1, d: 1, height: 2, material: 'wood' }];
    lvl.monsters = [{ id: 'm1', x: 3, z: 3, speed: 1, sound: 'growl' }];

    const model = objectListModel(lvl);
    // Exactly one entry per object (1 start + 1 each).
    expect(model.map((e) => e.id)).toEqual(['start', 'b1', 'wall-1', 'f2', 'c1', 'm1']);
    expect(model.map((e) => e.kind)).toEqual(['start', 'beacon', 'wall', 'floor', 'ceiling', 'monster']);
    expect(model[0].label).toBe('Start');
    expect(model[1].label).toBe('Beacon b1 (goal)');
    expect(model[2].label).toBe('Wall wall-1');
    expect(model[3].label).toBe('Floor f2 (carpet)');
    expect(model[4].label).toBe('Ceiling c1 (wood)');
    expect(model[5].label).toBe('Monster m1 (growl)');
  });

  it('includes every object as multiple are added', () => {
    const lvl = emptyLevel('Many');
    lvl.beacons = [
      { id: 'b1', x: 1, z: 1, freq: 440, goalRadius: 0.8 },
      { id: 'b2', x: 2, z: 2, freq: 440, goalRadius: 0.8 },
    ];
    lvl.monsters = [
      { id: 'm1', x: 3, z: 3, speed: 1, sound: 'growl' },
      { id: 'm2', x: 4, z: 4, speed: 1, sound: 'hum' },
    ];
    const model = objectListModel(lvl);
    // start + 2 beacons + 2 monsters = 5.
    expect(model).toHaveLength(5);
    expect(model.filter((e) => e.kind === 'beacon')).toHaveLength(2);
    expect(model.filter((e) => e.kind === 'monster')).toHaveLength(2);
  });
});

describe('absorber patches in the object list', () => {
  function withFoam(): Level {
    const lvl = emptyLevel('Foam');
    lvl.goal = 'absorber';
    lvl.absorbers = [
      { id: 'foam-1', wall: '-z', u0: 6.5, v0: 0.8, uSize: 3, vSize: 1.6, material: 'acoustic_foam' },
      { id: 'foam-2', wall: '+x', u0: 1, v0: 1, uSize: 2, vSize: 1, material: 'curtain' },
    ];
    return lvl;
  }

  it('enumerates every absorber so it can be selected/deleted', () => {
    const model = objectListModel(withFoam());
    const abs = model.filter((e) => e.kind === 'absorber');
    expect(abs.map((e) => e.id)).toEqual(['foam-1', 'foam-2']);
    expect(abs[0].label).toContain('-z');
    expect(abs[0].label).toContain('acoustic_foam');
  });

  it('marks the first absorber as the goal in absorber mode', () => {
    const model = objectListModel(withFoam());
    const abs = model.filter((e) => e.kind === 'absorber');
    expect(abs[0].label).toContain('(goal)');
    expect(abs[1].label).not.toContain('(goal)');
  });

  it('marks the first beacon as the goal in beacon mode (default)', () => {
    const lvl = emptyLevel('Bm');
    lvl.beacons = [
      { id: 'b1', x: 1, z: 1, freq: 440, goalRadius: 0.8 },
      { id: 'b2', x: 2, z: 2, freq: 440, goalRadius: 0.8 },
    ];
    const beacons = objectListModel(lvl).filter((e) => e.kind === 'beacon');
    expect(beacons[0].label).toContain('(goal)');
    expect(beacons[1].label).not.toContain('(goal)');
  });
});

describe('applyAbsorberProp', () => {
  function patch(): WallPatch {
    return { id: 'p', wall: '-z', u0: 1, v0: 0.5, uSize: 2, vSize: 1, material: 'concrete' };
  }
  it('changes the face and material', () => {
    const p = patch();
    expect(applyAbsorberProp(p, 'wall', '+x', NaN)).toBe(true);
    expect(p.wall).toBe('+x');
    applyAbsorberProp(p, 'material', 'acoustic_foam', NaN);
    expect(p.material).toBe('acoustic_foam');
  });
  it('edits the rectangle and floors sizes at a positive minimum', () => {
    const p = patch();
    applyAbsorberProp(p, 'u0', '3.5', 3.5);
    applyAbsorberProp(p, 'uSize', '0', 0);
    expect(p.u0).toBe(3.5);
    expect(p.uSize).toBeGreaterThan(0);
  });
  it('returns false for unrelated keys', () => {
    expect(applyAbsorberProp(patch(), 'freq', '5', 5)).toBe(false);
  });
});

describe('defaultAbsorber', () => {
  it('produces an on-face, non-degenerate patch', () => {
    const p = defaultAbsorber('a1', '-z', 'acoustic_foam', 12, 3);
    expect(p.u0).toBeGreaterThanOrEqual(0);
    expect(p.u0 + p.uSize).toBeLessThanOrEqual(12);
    expect(p.v0 + p.vSize).toBeLessThanOrEqual(3);
    expect(p.uSize).toBeGreaterThan(0);
    expect(p.vSize).toBeGreaterThan(0);
  });
});

describe('lintLevel', () => {
  it('warns on absorber goal with no patches', () => {
    const lvl = emptyLevel('L'); lvl.goal = 'absorber'; lvl.absorbers = [];
    expect(lintLevel(lvl).some((w) => /absorber/i.test(w))).toBe(true);
  });
  it('warns on a start outside the room', () => {
    const lvl = emptyLevel('L'); lvl.start = { x: -5, z: 2, yaw: 0 };
    expect(lintLevel(lvl).some((w) => /outside/i.test(w))).toBe(true);
  });
  it('is silent for a well-formed default level', () => {
    expect(lintLevel(emptyLevel('OK'))).toEqual([]);
  });
  it('warns when sequence mode has fewer than 2 beacons', () => {
    const lvl = emptyLevel('L'); // one beacon by default
    lvl.sequence = [lvl.beacons[0].id];
    expect(lintLevel(lvl).some((w) => /at least 2 beacons/i.test(w))).toBe(true);
  });
  it('warns when a sequence references a missing beacon', () => {
    const lvl = emptyLevel('L');
    lvl.beacons = [
      { ...lvl.beacons[0], id: 'b1' },
      { ...lvl.beacons[0], id: 'b2', x: 3 },
    ];
    lvl.sequence = ['b1', 'ghost'];
    expect(lintLevel(lvl).some((w) => /ghost.*doesn't exist/i.test(w))).toBe(true);
  });
  it('is silent for a valid 2-beacon sequence', () => {
    const lvl = emptyLevel('L');
    lvl.beacons = [
      { ...lvl.beacons[0], id: 'b1' },
      { ...lvl.beacons[0], id: 'b2', x: 3 },
    ];
    lvl.sequence = ['b1', 'b2'];
    expect(lintLevel(lvl).filter((w) => /sequence/i.test(w))).toEqual([]);
  });
});

describe('absorber + objective fields round-trip through export/import', () => {
  it('a find-the-foam style level is lossless (absorbers, goal, clap budget)', () => {
    const lvl = emptyLevel('Foam round-trip');
    // import backfills the default beacon.sound; set it so the deep-equality holds.
    lvl.beacons = [{ id: 'b1', x: 6, z: 8, freq: 440, goalRadius: 1.5, sound: 'musicbox' }];
    lvl.goal = 'absorber';
    lvl.clapBudget = 5;
    lvl.clapCooldownMs = 600;
    lvl.absorbers = [
      { id: 'foam-1', wall: '-z', u0: 6.5, v0: 0.8, uSize: 3, vSize: 1.6, material: 'acoustic_foam' },
      { id: 'foam-2', wall: '+x', u0: 1, v0: 1, uSize: 2, vSize: 1, material: 'curtain' },
    ];
    const round = importLevel(exportLevel(lvl));
    expect(round).toEqual(lvl);
    expect(round.absorbers).toHaveLength(2);
    expect(round.goal).toBe('absorber');
    expect(round.clapBudget).toBe(5);
    expect(round.clapCooldownMs).toBe(600);
  });
});

describe('escape-mode authoring', () => {
  function escapeLevel(name = 'Esc'): Level {
    const lvl = emptyLevel(name);
    lvl.goal = 'escape';
    lvl.exit = { x: 2.5, z: 1.5 };
    lvl.decoyBudget = 3;
    lvl.beacons = [{ id: 'exit', x: 2.5, z: 1.5, freq: 330, goalRadius: 1, sound: 'musicbox' }];
    lvl.monsters = [{ id: 'm1', x: 8, z: 11, speed: 0.6, sound: 'growl' }];
    return lvl;
  }

  it('serializes goal/exit/decoyBudget and round-trips losslessly', () => {
    const lvl = escapeLevel('Round');
    const round = importLevel(exportLevel(lvl));
    expect(round).toEqual(lvl);
    expect(round.goal).toBe('escape');
    expect(round.exit).toEqual({ x: 2.5, z: 1.5 });
    expect(round.decoyBudget).toBe(3);
  });

  it('a level with no exit/decoyBudget has no such keys after round-trip', () => {
    const lvl = emptyLevel('Plain');
    const round = importLevel(exportLevel(lvl));
    expect('exit' in round).toBe(false);
    expect('decoyBudget' in round).toBe(false);
  });

  it('lists the exit (as goal) and labels monsters to evade in escape mode', () => {
    const model = objectListModel(escapeLevel());
    const exit = model.find((e) => e.kind === 'exit');
    expect(exit).toBeDefined();
    expect(exit!.id).toBe('__exit');
    expect(exit!.label).toContain('(goal)');
    const mon = model.find((e) => e.kind === 'monster');
    expect(mon!.label).toContain('evade');
    expect(mon!.label).toContain('growl');
  });

  it('kindLabel covers the exit', () => {
    expect(kindLabel('exit')).toBe('Escape exit');
  });

  describe('lint', () => {
    it('warns when escape goal has no exit', () => {
      const lvl = escapeLevel(); delete lvl.exit;
      expect(lintLevel(lvl).some((w) => /no exit/i.test(w))).toBe(true);
    });
    it('warns when escape goal has no monsters', () => {
      const lvl = escapeLevel(); lvl.monsters = [];
      expect(lintLevel(lvl).some((w) => /no monsters/i.test(w))).toBe(true);
    });
    it('warns when the exit is outside the room', () => {
      const lvl = escapeLevel(); lvl.exit = { x: -3, z: 1 };
      expect(lintLevel(lvl).some((w) => /exit position is outside/i.test(w))).toBe(true);
    });
    it('is silent for a well-formed escape level', () => {
      expect(lintLevel(escapeLevel())).toEqual([]);
    });
  });
});

describe('stealth-escape.json round-trips losslessly', () => {
  it('preserves goal/exit/decoyBudget/monsters', async () => {
    const raw = await import('../src/levels/stealth-escape.json');
    const lvl = importLevel(JSON.stringify(raw.default));
    const round = importLevel(exportLevel(lvl));
    expect(round).toEqual(lvl);
    expect(round.goal).toBe('escape');
    expect(round.exit).toEqual({ x: 2.5, z: 1.5 });
    expect(round.decoyBudget).toBe(3);
    expect(round.monsters).toHaveLength(1);
  });
});

describe('monster sound options', () => {
  it('come from MONSTER_PRESETS (growl/hum)', () => {
    expect(MONSTER_PRESETS).toEqual(['growl', 'hum']);
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
    lvl.speedOfSound = 150;

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
    expect(round.speedOfSound).toBe(150);
  });

  it('a level with no speedOfSound has no such key after round-trip', () => {
    const lvl = emptyLevel('Default-c');
    expect('speedOfSound' in lvl).toBe(false);
    const round = importLevel(exportLevel(lvl));
    expect(round.speedOfSound).toBeUndefined();
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

describe('ambient sources, win-areas, clutter + reaction events (Part B/C editor support)', () => {
  it('applyAmbienceProp edits position / preset / freq / gain (clamped) / url', () => {
    const a = defaultAmbience('a1', 2, 3);
    expect(a).toEqual({ id: 'a1', x: 2, z: 3, sound: 'hum', freq: 220, gain: 1 });
    applyAmbienceProp(a, 'sound', 'fountain', NaN);
    applyAmbienceProp(a, 'freq', '440', 440);
    applyAmbienceProp(a, 'gain', '5', 5);     // clamped to 2
    applyAmbienceProp(a, 'x', '7', 7);
    applyAmbienceProp(a, 'soundUrl', 'x.mp3', NaN);
    expect(a).toMatchObject({ sound: 'fountain', freq: 440, gain: 2, x: 7, soundUrl: 'x.mp3' });
    applyAmbienceProp(a, 'soundUrl', '', NaN); // empty clears
    expect('soundUrl' in a).toBe(false);
  });

  it('applyEventProp edits type / source / window and keeps end > start', () => {
    const e = defaultEvent('e1', 'fountain', 5);
    expect(e).toEqual({ id: 'e1', type: 'crossing', sourceId: 'fountain', start: 5, end: 7.5 });
    applyEventProp(e, 'type', 'door', NaN);
    applyEventProp(e, 'sourceId', 'ac', NaN);
    applyEventProp(e, 'start', '10', 10); // end (7.5) now <= start → bumped
    expect(e.type).toBe('door');
    expect(e.sourceId).toBe('ac');
    expect(e.start).toBe(10);
    expect(e.end).toBeGreaterThan(e.start);
  });

  it('lint warns on a silent level with no win point, dangling event source, and an impossible gate', () => {
    const lvl = emptyLevel('Bad');
    lvl.beacons = [];
    delete (lvl as Partial<Level>).winPoint;
    lvl.ambience = [{ id: 'fountain', x: 1, z: 1, sound: 'fountain', gain: 1 }];
    lvl.events = [{ id: 'e1', type: 'crossing', sourceId: 'nope', start: 1, end: 3 }];
    lvl.requiredReactions = 9;
    const w = lintLevel(lvl);
    expect(w.some((s) => /win area|win point/i.test(s))).toBe(true);
    expect(w.some((s) => s.includes('nope'))).toBe(true);
    expect(w.some((s) => /requiredReactions/.test(s))).toBe(true);
  });

  it('a reaction level (ambience + events + win + clutter) round-trips losslessly', () => {
    const lvl = emptyLevel('Reaction round-trip');
    lvl.beacons = [];
    lvl.winPoint = { x: 5, z: 2 };
    lvl.winRadius = 1.1;
    lvl.clutter = 0.3;
    lvl.requiredReactions = 2;
    lvl.ambience = [
      { id: 'fountain', x: 5, z: 1.5, sound: 'fountain', freq: 220, gain: 0.8 },
    ];
    lvl.events = [
      { id: 'c1', type: 'crossing', sourceId: 'fountain', start: 5, end: 7.5 },
      { id: 'c2', type: 'crossing', sourceId: 'fountain', start: 12, end: 14.5 },
    ];
    const round = importLevel(exportLevel(lvl));
    expect(round).toEqual(lvl);
  });

  it('objectListModel lists ambient sources and the win area', () => {
    const lvl = emptyLevel('L');
    lvl.ambience = [{ id: 'ac', x: 1, z: 1, sound: 'brownnoise', gain: 1 }];
    lvl.winPoint = { x: 2, z: 2 };
    const model = objectListModel(lvl);
    expect(model.some((e) => e.kind === 'ambience' && e.id === 'ac')).toBe(true);
    expect(model.some((e) => e.kind === 'win' && e.id === '__win')).toBe(true);
  });
});
