import { describe, it, expect } from 'vitest';
import { CalibrationMachine } from '../src/ui/calibrationMachine';
import { TutorialMachine, LESSONS, LESSON_GOAL } from '../src/ui/tutorialMachine';
import {
  OnboardingStore,
  CALIBRATION_DONE_KEY,
  TUTORIAL_DONE_KEY,
  SWAP_KEY,
  MODE_PRIMER_KEY,
} from '../src/ui/onboardingStore';

describe('CalibrationMachine (pure)', () => {
  it('walks intro → left → right → volume → done', () => {
    const m = new CalibrationMachine();
    expect(m.current).toBe('intro');
    m.begin();
    expect(m.current).toBe('left');
    m.answer('left');
    expect(m.current).toBe('right');
    m.answer('right');
    expect(m.current).toBe('volume');
    m.confirmVolume();
    expect(m.current).toBe('done');
    expect(m.snapshot().done).toBe(true);
  });

  it('both probes correct ⇒ orientationCorrect, no swap suggested', () => {
    const m = new CalibrationMachine();
    m.begin();
    m.answer('left');
    m.answer('right');
    expect(m.orientationCorrect()).toBe(true);
    expect(m.swapSuggested()).toBe(false);
  });

  it('both probes reversed ⇒ swapSuggested', () => {
    const m = new CalibrationMachine();
    m.begin();
    m.answer('right'); // left probe heard on the right
    m.answer('left'); // right probe heard on the left
    expect(m.swapSuggested()).toBe(true);
    expect(m.orientationCorrect()).toBe(false);
  });

  it('does not suggest swap until both probes answered', () => {
    const m = new CalibrationMachine();
    m.begin();
    expect(m.swapSuggested()).toBe(false);
    m.answer('right');
    expect(m.swapSuggested()).toBe(false); // only one answered
  });

  it('swap toggle is independent state', () => {
    const m = new CalibrationMachine();
    expect(m.swapped).toBe(false);
    expect(m.toggleSwap()).toBe(true);
    expect(m.swapped).toBe(true);
    expect(m.setSwap(false)).toBe(false);
  });

  it('respects an initial swap and reset keeps it', () => {
    const m = new CalibrationMachine({ swap: true });
    expect(m.swapped).toBe(true);
    m.begin();
    m.answer('left');
    m.reset();
    expect(m.current).toBe('intro');
    expect(m.swapped).toBe(true); // toggle survives a probe reset
  });

  it('ignores out-of-order calls', () => {
    const m = new CalibrationMachine();
    m.answer('left'); // before begin
    expect(m.current).toBe('intro');
    m.confirmVolume(); // not on volume
    expect(m.current).toBe('intro');
  });
});

describe('TutorialMachine (pure)', () => {
  it('starts on the first lesson (localizing — the Kish/Thaler seated start)', () => {
    const m = new TutorialMachine();
    expect(m.lesson).toBe('localizing');
    expect(m.done).toBe(false);
  });

  it('follows the graduated order localizing → turning → stepping → clapping', () => {
    expect(LESSONS).toEqual(['localizing', 'turning', 'stepping', 'clapping']);
  });

  it('gate requires the lesson goal before next advances', () => {
    const m = new TutorialMachine();
    expect(m.gateMet()).toBe(false);
    expect(m.next()).toBe('localizing'); // gate unmet ⇒ no advance
    for (let i = 0; i < LESSON_GOAL.localizing; i++) m.recordAction();
    expect(m.gateMet()).toBe(true);
    expect(m.next()).toBe('turning');
  });

  it('progress caps at the goal', () => {
    const m = new TutorialMachine();
    m.recordAction(100);
    expect(m.snapshot().progress).toBe(LESSON_GOAL.localizing);
  });

  it('completes after the last lesson', () => {
    const m = new TutorialMachine();
    for (const l of LESSONS) {
      for (let i = 0; i < LESSON_GOAL[l]; i++) m.recordAction();
      m.next();
    }
    expect(m.done).toBe(true);
    expect(m.lesson).toBe(null);
    expect(m.snapshot().index).toBe(LESSONS.length);
  });

  it('skip bypasses the gate; skipAll finishes immediately', () => {
    const m = new TutorialMachine();
    expect(m.skip()).toBe('turning'); // forced past unmet gate (localizing → turning)
    m.skipAll();
    expect(m.done).toBe(true);
    expect(m.lesson).toBe(null);
  });

  it('reset replays from the first lesson', () => {
    const m = new TutorialMachine();
    m.skipAll();
    m.reset();
    expect(m.lesson).toBe('localizing');
    expect(m.done).toBe(false);
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

describe('OnboardingStore (persistence)', () => {
  it('round-trips the done flags and swap', () => {
    const s = new OnboardingStore(fakeStorage());
    expect(s.calibrationDone()).toBe(false);
    expect(s.isFirstRun()).toBe(true);
    s.setCalibrationDone();
    expect(s.calibrationDone()).toBe(true);
    expect(s.isFirstRun()).toBe(false);
    s.setTutorialDone();
    expect(s.tutorialDone()).toBe(true);
    s.setSwap(true);
    expect(s.swap()).toBe(true);
    s.setSwap(false);
    expect(s.swap()).toBe(false);
  });

  it('writes the documented keys', () => {
    const fake = fakeStorage();
    const s = new OnboardingStore(fake);
    s.setCalibrationDone();
    s.setTutorialDone();
    s.setSwap(true);
    expect(fake._map.get(CALIBRATION_DONE_KEY)).toBe('1');
    expect(fake._map.get(TUTORIAL_DONE_KEY)).toBe('1');
    expect(fake._map.get(SWAP_KEY)).toBe('1');
  });

  it('per-mode primers default unseen, then remember once shown', () => {
    const fake = fakeStorage();
    const s = new OnboardingStore(fake);
    for (const mode of ['absorber', 'sonar', 'stealth'] as const) {
      expect(s.modePrimerSeen(mode)).toBe(false);
      s.setModePrimerSeen(mode);
      expect(s.modePrimerSeen(mode)).toBe(true);
      expect(fake._map.get(MODE_PRIMER_KEY[mode])).toBe('1');
    }
  });

  it('mode primer flags are independent of each other and of tutorial/calibration', () => {
    const s = new OnboardingStore(fakeStorage());
    s.setModePrimerSeen('stealth');
    expect(s.modePrimerSeen('stealth')).toBe(true);
    expect(s.modePrimerSeen('absorber')).toBe(false);
    expect(s.modePrimerSeen('sonar')).toBe(false);
    expect(s.tutorialDone()).toBe(false);
    expect(s.isFirstRun()).toBe(true); // primers don't affect first-run gating
  });

  it('degrades to memory when storage is null', () => {
    const s = new OnboardingStore(null);
    s.setCalibrationDone();
    expect(s.calibrationDone()).toBe(true); // in-memory fallback
  });

  it('degrades to memory when storage throws', () => {
    const throwing = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    };
    const s = new OnboardingStore(throwing);
    s.setTutorialDone();
    expect(s.tutorialDone()).toBe(true);
  });
});
