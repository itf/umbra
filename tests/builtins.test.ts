import { describe, it, expect } from 'vitest';
import { isLevel } from '../src/level/schema';
import { loadLevel } from '../src/level/load';
import { builtinLevels, getBuiltin, isBuiltinId } from '../src/level/builtins';
import { BUILTIN_MANIFEST } from '../src/levels';
import { buildPickerModel } from '../src/ui/levelPicker';

describe('bundled demo levels', () => {
  it('every builtin passes isLevel and loadLevel without throwing', () => {
    for (const info of builtinLevels()) {
      const lvl = getBuiltin(info.id)!;
      expect(lvl).toBeDefined();
      expect(isLevel(lvl)).toBe(true);
      expect(() => loadLevel(lvl)).not.toThrow();
    }
  });

  it('there is a healthy set of builtins', () => {
    expect(builtinLevels().length).toBeGreaterThanOrEqual(6);
  });

  it('getBuiltin returns the right level; unknown id → undefined', () => {
    const all = builtinLevels();
    for (const info of all) {
      const lvl = getBuiltin(info.id)!;
      // The manifest name should match (it falls back to the JSON name otherwise).
      expect(typeof lvl.name).toBe('string');
      expect(isBuiltinId(info.id)).toBe(true);
    }
    expect(getBuiltin('does-not-exist')).toBeUndefined();
    expect(isBuiltinId('does-not-exist')).toBe(false);
  });

  it('getBuiltin returns fresh clones (no shared mutable state)', () => {
    const id = builtinLevels()[0].id;
    const a = getBuiltin(id)!;
    a.name = 'mutated';
    const b = getBuiltin(id)!;
    expect(b.name).not.toBe('mutated');
  });
});

describe('showcase feature coverage', () => {
  const levels = () => builtinLevels().map((i) => getBuiltin(i.id)!);

  it('at least one level has a moving wall (motion)', () => {
    expect(levels().some((l) => l.walls.some((w) => w.motion != null))).toBe(true);
  });

  it('at least one level has a monster', () => {
    expect(levels().some((l) => l.monsters.length > 0)).toBe(true);
  });

  it('at least one level is open (outdoor)', () => {
    expect(levels().some((l) => l.open === true)).toBe(true);
  });

  it('at least one level has a non-tone beacon sound', () => {
    expect(
      levels().some((l) => l.beacons.some((b) => b.sound && b.sound !== 'tone')),
    ).toBe(true);
  });

  it('at least one level has a ceiling zone', () => {
    expect(levels().some((l) => l.ceilings.length > 0)).toBe(true);
  });

  it('there is a clear large-vs-small pair (room volumes differ a lot)', () => {
    const vols = levels()
      .filter((l) => !l.open)
      .map((l) => l.room.width * l.room.depth * l.room.height);
    const max = Math.max(...vols);
    const min = Math.min(...vols);
    expect(max).toBeGreaterThan(min * 4); // at least a 4× volume spread
  });

  it('every builtin is winnable: a first beacon with a goalRadius, OR a winPoint (silent levels)', () => {
    for (const l of levels()) {
      const b = l.beacons[0];
      if (b) {
        // Beacon-bearing level: the first beacon's goalRadius must be valid.
        expect(b.goalRadius).toBeGreaterThan(0);
      } else {
        // SILENT level (no beacons): it must declare an explicit win area instead.
        expect(l.winPoint, `${l.name} has no beacon and no winPoint`).toBeDefined();
      }
    }
  });
});

describe('picker model (pure)', () => {
  it('lists builtins first, then saved levels', () => {
    const builtins = builtinLevels();
    const model = buildPickerModel(builtins, ['My Maze', 'Other']);
    expect(model.length).toBe(builtins.length + 2);
    expect(model[0].source).toBe('builtin');
    expect(model[model.length - 1]).toMatchObject({ source: 'saved', ref: 'Other' });
  });

  it('keys are stable and namespaced by source', () => {
    const model = buildPickerModel(
      [{ id: 'x', name: 'X', description: 'd', category: 'beacon' }],
      ['Saved One'],
    );
    expect(model[0].key).toBe('builtin:x');
    expect(model[1].key).toBe('saved:Saved One');
  });

  it('carries the builtin category through to each item; saved rows are "saved"', () => {
    const builtins = builtinLevels();
    const model = buildPickerModel(builtins, ['Mine']);
    const byKey = new Map(model.map((m) => [m.key, m]));
    for (const b of builtins) {
      expect(byKey.get(`builtin:${b.id}`)!.category).toBe(b.category);
    }
    expect(byKey.get('saved:Mine')!.category).toBe('saved');
  });

  it('every mode is represented by at least two levels (a difficulty arc)', () => {
    const counts: Record<string, number> = {};
    for (const b of builtinLevels()) counts[b.category] = (counts[b.category] ?? 0) + 1;
    for (const mode of ['beacon', 'absorber', 'sonar', 'stealth']) {
      expect(counts[mode] ?? 0).toBeGreaterThanOrEqual(2);
    }
  });

  it('the manifest and registry agree on ids', () => {
    const manifestIds = BUILTIN_MANIFEST.map((e) => e.id).sort();
    const registryIds = builtinLevels().map((i) => i.id).sort();
    expect(registryIds).toEqual(manifestIds);
  });
});
