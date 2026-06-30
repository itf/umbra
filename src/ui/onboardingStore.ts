/**
 * Onboarding persistence — thin, testable localStorage wrapper for the
 * "calibration done" / "tutorial done" / "L-R swap" flags. Kept separate from the
 * state machines so those stay pure. Every read/write is guarded: localStorage
 * can throw (private mode, disabled storage), in which case we degrade to
 * in-memory-only (the flow still works, it just won't be remembered).
 */

export const CALIBRATION_DONE_KEY = 'ps.onboarding.calibrationDone';
export const TUTORIAL_DONE_KEY = 'ps.onboarding.tutorialDone';
export const SWAP_KEY = 'ps.onboarding.swapLR';

/**
 * Per-mode first-time primers. Each special mode (absorber, sonar-budget,
 * stealth) teaches its verb/goal in context the FIRST time a player loads it,
 * then sets its flag so it never re-walls a returning player. Keyed by the
 * GameLevel `goal`/mode id so the flags are stable and forward-compatible.
 */
export type PrimerMode = 'absorber' | 'sonar' | 'stealth';
export const MODE_PRIMER_KEY: Record<PrimerMode, string> = {
  absorber: 'ps.onboarding.primer.absorber',
  sonar: 'ps.onboarding.primer.sonar',
  stealth: 'ps.onboarding.primer.stealth',
};

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Resolve a storage backend; null when unavailable. Overridable for tests. */
function resolveStorage(): Storage | null {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    /* access itself can throw in some sandboxes */
  }
  return null;
}

export class OnboardingStore {
  private store: Storage | null;
  /** In-memory fallback so the session is consistent even without localStorage. */
  private mem = new Map<string, string>();

  constructor(store: Storage | null = resolveStorage()) {
    this.store = store;
  }

  private read(key: string): string | null {
    try {
      const v = this.store?.getItem(key);
      if (v != null) return v;
    } catch {
      /* fall through to memory */
    }
    return this.mem.has(key) ? this.mem.get(key)! : null;
  }

  private write(key: string, value: string) {
    this.mem.set(key, value);
    try {
      this.store?.setItem(key, value);
    } catch {
      /* memory already updated */
    }
  }

  private flag(key: string): boolean {
    return this.read(key) === '1';
  }
  private setFlag(key: string, on: boolean) {
    this.write(key, on ? '1' : '0');
  }

  calibrationDone(): boolean {
    return this.flag(CALIBRATION_DONE_KEY);
  }
  setCalibrationDone(on = true) {
    this.setFlag(CALIBRATION_DONE_KEY, on);
  }

  tutorialDone(): boolean {
    return this.flag(TUTORIAL_DONE_KEY);
  }
  setTutorialDone(on = true) {
    this.setFlag(TUTORIAL_DONE_KEY, on);
  }

  /** Session L/R swap preference (persisted so it survives reload). */
  swap(): boolean {
    return this.flag(SWAP_KEY);
  }
  setSwap(on: boolean) {
    this.setFlag(SWAP_KEY, on);
  }

  /** Has this mode's first-time primer already been shown? */
  modePrimerSeen(mode: PrimerMode): boolean {
    return this.flag(MODE_PRIMER_KEY[mode]);
  }
  /** Mark a mode's first-time primer as shown (so it never shows again). */
  setModePrimerSeen(mode: PrimerMode, on = true) {
    this.setFlag(MODE_PRIMER_KEY[mode], on);
  }

  /** True when the player has never done onboarding (first run). */
  isFirstRun(): boolean {
    return !this.calibrationDone() && !this.tutorialDone();
  }
}
