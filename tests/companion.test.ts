/**
 * Companion-voice line catalog + selection — PURE logic tests. Locks down that
 * every mode/event yields a sane short line, that variety rotates
 * deterministically (no RNG/clock), that progress is band-keyed, and that the
 * selection returns null when there's nothing to say. Also covers the
 * mode-for-level classification and the store preference flag.
 */
import { describe, it, expect } from 'vitest';
import {
  companionLine,
  modeForLevel,
  type CompanionMode,
  type CompanionEvent,
} from '../src/game/companion';
import { OnboardingStore, COMPANION_KEY } from '../src/ui/onboardingStore';

const MODES: CompanionMode[] = ['beacon', 'absorber', 'sonar', 'stealth'];

describe('companionLine — catalog coverage', () => {
  it('returns a non-empty short line for start/win in every mode', () => {
    for (const mode of MODES) {
      for (const ev of ['start', 'win'] as CompanionEvent[]) {
        const line = companionLine(mode, ev);
        expect(line, `${mode}/${ev}`).toBeTruthy();
        expect(line!.length).toBeGreaterThan(0);
        expect(line!.length).toBeLessThanOrEqual(120); // short + skippable
      }
    }
  });

  it('returns a line for caught/heard/stumble in every mode (shared fallback ok)', () => {
    for (const mode of MODES) {
      for (const ev of ['caught', 'heard', 'stumble'] as CompanionEvent[]) {
        expect(companionLine(mode, ev), `${mode}/${ev}`).toBeTruthy();
      }
    }
  });

  it('progress yields a band-appropriate line for bands 0..3', () => {
    for (const mode of MODES) {
      for (let band = 0; band <= 3; band++) {
        const line = companionLine(mode, 'progress', { band });
        expect(line, `${mode}/progress/${band}`).toBeTruthy();
      }
    }
  });

  it('different bands give different progress lines (band actually matters)', () => {
    const near = companionLine('beacon', 'progress', { band: 0 });
    const far = companionLine('beacon', 'progress', { band: 3 });
    expect(near).not.toBe(far);
  });

  it('clamps out-of-range bands instead of returning null', () => {
    expect(companionLine('beacon', 'progress', { band: -5 })).toBeTruthy();
    expect(companionLine('beacon', 'progress', { band: 99 })).toBeTruthy();
  });
});

describe('companionLine — variety / rotation determinism', () => {
  it('rotates through the available lines by seed (deterministic, no repeats until cycle)', () => {
    // beacon/start has 2 lines: seed 0 and 1 differ, seed 2 wraps to seed 0.
    const s0 = companionLine('beacon', 'start', { seed: 0 });
    const s1 = companionLine('beacon', 'start', { seed: 1 });
    const s2 = companionLine('beacon', 'start', { seed: 2 });
    expect(s0).not.toBe(s1);
    expect(s2).toBe(s0); // wraps deterministically
  });

  it('is a pure function of (mode, event, context) — same inputs, same output', () => {
    const a = companionLine('stealth', 'heard', { seed: 3 });
    const b = companionLine('stealth', 'heard', { seed: 3 });
    expect(a).toBe(b);
  });

  it('handles negative and large seeds safely (non-negative modulo)', () => {
    expect(companionLine('sonar', 'win', { seed: -1 })).toBeTruthy();
    expect(companionLine('sonar', 'win', { seed: 1_000_003 })).toBeTruthy();
  });

  it('defaults to seed 0 (first line) when no seed given', () => {
    expect(companionLine('absorber', 'start')).toBe(
      companionLine('absorber', 'start', { seed: 0 }),
    );
  });
});

describe('companionLine — null when nothing to say', () => {
  it('returns null for an unknown event', () => {
    expect(companionLine('beacon', 'definitely-not-an-event' as CompanionEvent)).toBeNull();
  });

  it('returns null for an unknown mode', () => {
    expect(companionLine('nope' as CompanionMode, 'start')).toBeNull();
  });

  it('absorberFound aliases the win line', () => {
    expect(companionLine('absorber', 'absorberFound')).toBe(
      companionLine('absorber', 'win'),
    );
  });
});

describe('modeForLevel', () => {
  it('maps goal/clapBudget to the right mode, defaulting to beacon', () => {
    expect(modeForLevel({ goal: 'escape' })).toBe('stealth');
    expect(modeForLevel({ goal: 'absorber' })).toBe('absorber');
    expect(modeForLevel({ clapBudget: 5 })).toBe('sonar');
    expect(modeForLevel({})).toBe('beacon');
    expect(modeForLevel({ goal: 'beacon' })).toBe('beacon');
  });

  it('goal takes precedence over a clap budget', () => {
    expect(modeForLevel({ goal: 'escape', clapBudget: 3 })).toBe('stealth');
  });
});

/** Minimal in-memory localStorage stub. */
function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    _map: map,
  };
}

describe('OnboardingStore — companion preference', () => {
  it('defaults ON for a first-timer (no stored key)', () => {
    const s = new OnboardingStore(fakeStorage());
    expect(s.companionEnabled()).toBe(true);
  });

  it('round-trips an explicit off/on choice', () => {
    const fake = fakeStorage();
    const s = new OnboardingStore(fake);
    s.setCompanionEnabled(false);
    expect(s.companionEnabled()).toBe(false);
    expect(fake._map.get(COMPANION_KEY)).toBe('0');
    s.setCompanionEnabled(true);
    expect(s.companionEnabled()).toBe(true);
    expect(fake._map.get(COMPANION_KEY)).toBe('1');
  });

  it('is independent of the onboarding done flags / first-run gating', () => {
    const s = new OnboardingStore(fakeStorage());
    s.setCompanionEnabled(false);
    expect(s.isFirstRun()).toBe(true); // companion pref doesn't affect gating
    expect(s.calibrationDone()).toBe(false);
  });

  it('degrades to memory when storage is null', () => {
    const s = new OnboardingStore(null);
    expect(s.companionEnabled()).toBe(true); // default
    s.setCompanionEnabled(false);
    expect(s.companionEnabled()).toBe(false);
  });
});
