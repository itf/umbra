import { describe, it, expect } from 'vitest';
import { ClapBudget } from '../src/game/clapBudget';
import { isLevel } from '../src/level/schema';
import { loadLevel } from '../src/level/load';
import { getBuiltin } from '../src/level/builtins';

describe('ClapBudget (pure model)', () => {
  it('unlimited by default: never refuses, not managed', () => {
    const b = new ClapBudget();
    expect(b.isManaged()).toBe(false);
    expect(b.hasBudget()).toBe(false);
    expect(b.remaining()).toBe(Infinity);
    for (let i = 0; i < 100; i++) expect(b.consume(i).ok).toBe(true);
    expect(b.remaining()).toBe(Infinity);
  });

  it('max: 0 and negative collapse to unlimited (back-compat)', () => {
    expect(new ClapBudget({ max: 0 }).isManaged()).toBe(false);
    expect(new ClapBudget({ max: -3 }).hasBudget()).toBe(false);
    expect(new ClapBudget({ max: undefined }).remaining()).toBe(Infinity);
  });

  it('hard budget: consume decrements and refuses at 0', () => {
    const b = new ClapBudget({ max: 3 });
    expect(b.isManaged()).toBe(true);
    expect(b.remaining()).toBe(3);
    expect(b.consume(0).ok).toBe(true);
    expect(b.remaining()).toBe(2);
    expect(b.consume(1).ok).toBe(true);
    expect(b.consume(2).ok).toBe(true);
    expect(b.remaining()).toBe(0);
    const denied = b.consume(3);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toBe('exhausted');
    // A refused attempt changes no state.
    expect(b.remaining()).toBe(0);
  });

  it('cooldown: blocks within the window, allows after — deterministic clock', () => {
    const b = new ClapBudget({ cooldownMs: 1000 });
    expect(b.isManaged()).toBe(true);
    expect(b.hasBudget()).toBe(false); // cooldown alone: no total cap
    expect(b.consume(0).ok).toBe(true);
    const tooSoon = b.consume(400);
    expect(tooSoon.ok).toBe(false);
    if (!tooSoon.ok) {
      expect(tooSoon.reason).toBe('cooling');
      expect(tooSoon.waitMs).toBe(600);
    }
    // Still cooling: state unchanged, exactly at the boundary it is still blocked.
    expect(b.canClap(1000).ok).toBe(true); // elapsed == cooldown ⇒ allowed
    expect(b.consume(1000).ok).toBe(true);
    expect(b.consume(1500).ok).toBe(false);
  });

  it('budget + cooldown compose; exhaustion takes priority over cooling', () => {
    const b = new ClapBudget({ max: 1, cooldownMs: 1000 });
    expect(b.consume(0).ok).toBe(true);
    const r = b.consume(5000); // cooldown clear, but budget gone
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('exhausted');
  });
});

describe('clapBudget schema/load threading', () => {
  it('a level with clapBudget round-trips into GameLevel', () => {
    const lvl = getBuiltin('clap-maze')!;
    expect(isLevel(lvl)).toBe(true);
    expect(lvl.clapBudget).toBeGreaterThan(0);
    const loaded = loadLevel(lvl);
    expect(loaded.game.clapBudget).toBe(lvl.clapBudget);
    expect(loaded.game.clapCooldownMs).toBe(lvl.clapCooldownMs);
    const b = new ClapBudget({ max: loaded.game.clapBudget, cooldownMs: loaded.game.clapCooldownMs });
    expect(b.hasBudget()).toBe(true);
  });

  it('a level without clapBudget → unlimited', () => {
    const lvl = getBuiltin('small-concrete-room')!;
    const loaded = loadLevel(lvl);
    expect(loaded.game.clapBudget).toBeUndefined();
    expect(new ClapBudget({ max: loaded.game.clapBudget }).isManaged()).toBe(false);
  });
});

describe('clap-maze builtin', () => {
  it('passes isLevel + loadLevel, has a clap budget and interior walls', () => {
    const lvl = getBuiltin('clap-maze')!;
    expect(isLevel(lvl)).toBe(true);
    expect(() => loadLevel(lvl)).not.toThrow();
    expect(lvl.clapBudget).toBeGreaterThan(0);
    expect(lvl.walls.length).toBeGreaterThanOrEqual(3);
    expect(lvl.beacons[0].goalRadius).toBeGreaterThan(0);
  });
});
