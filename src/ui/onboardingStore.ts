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
 * Companion-voice preference. The optional spoken "guide" (companion.ts) is
 * OPT-IN-but-default-ON for first-timers; some players want pure acoustics, so
 * it MUST be toggleable and the choice remembered. Stored separately from the
 * onboarding "done" flags so 6C's settings UI can flip it cleanly.
 */
export const COMPANION_KEY = 'ps.onboarding.companion';

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

  private remove(key: string) {
    this.mem.delete(key);
    try {
      this.store?.removeItem(key);
    } catch {
      /* memory already cleared */
    }
  }

  /**
   * Wipe ALL onboarding + primer + preference flags so first-run onboarding
   * replays from scratch (the 6C "reset progress" affordance calls this). Removes
   * the calibration/tutorial "done" flags, every per-mode primer flag, and the
   * companion + swap preferences — returning the player to a clean first-run state.
   */
  clearAll() {
    this.remove(CALIBRATION_DONE_KEY);
    this.remove(TUTORIAL_DONE_KEY);
    this.remove(SWAP_KEY);
    this.remove(COMPANION_KEY);
    for (const key of Object.values(MODE_PRIMER_KEY)) this.remove(key);
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

  /**
   * Companion-voice on/off. DEFAULTS TO ON when the player has never expressed a
   * preference (no stored key) — first-timers get the guide, but it's fully
   * toggleable and, once set, remembered. Returns the stored choice otherwise.
   */
  companionEnabled(): boolean {
    const v = this.read(COMPANION_KEY);
    if (v == null) return true; // unset ⇒ default ON for first-timers
    return v === '1';
  }
  /** Set + remember the companion-voice preference (6C's settings toggle calls this). */
  setCompanionEnabled(on: boolean) {
    this.setFlag(COMPANION_KEY, on);
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
