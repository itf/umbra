/**
 * Settings persistence (6C) — a thin, testable localStorage wrapper for the new
 * audio/preference settings that don't already live in onboardingStore:
 *   - master VOLUME (0..1, stored as a percent-derived float)
 *   - the "getting warmer" proximity CUE on/off
 *
 * Companion-voice and L/R swap already have homes in onboardingStore (COMPANION_KEY,
 * SWAP_KEY); the settings PANEL wires those through onboardingStore directly. This
 * store owns only the two new prefs. Mirrors onboardingStore's guarded pattern:
 * every read/write wrapped (localStorage can throw in private mode / disabled
 * storage), degrading to an in-memory map so the session stays consistent.
 *
 * The clamp + volume math is pure (see `clampVolume`) so it's unit-testable without
 * DOM or storage.
 */

export const MASTER_VOLUME_KEY = 'ps.settings.masterVolume';
export const WARMER_CUE_KEY = 'ps.settings.warmerCue';

/** Default master volume (full scale). */
export const DEFAULT_MASTER_VOLUME = 1;

/**
 * PURE: clamp a master-volume value to [0,1]. Accepts any number (incl. NaN /
 * out-of-range from a corrupt store or a slider), returning a safe gain. NaN and
 * non-finite collapse to the default so the game is never accidentally muted by
 * bad data.
 */
export function clampVolume(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_MASTER_VOLUME;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/** PURE: a 0..100 integer percent → a clamped 0..1 gain. */
export function percentToVolume(pct: number): number {
  return clampVolume(pct / 100);
}

/** PURE: a 0..1 gain → a rounded 0..100 integer percent (for labels/sliders). */
export function volumeToPercent(v: number): number {
  return Math.round(clampVolume(v) * 100);
}

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;

function resolveStorage(): Storage | null {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    /* access itself can throw in some sandboxes */
  }
  return null;
}

export class SettingsStore {
  private store: Storage | null;
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

  /** Stored master volume in [0,1]; the default (full) when unset/corrupt. */
  masterVolume(): number {
    const raw = this.read(MASTER_VOLUME_KEY);
    if (raw == null) return DEFAULT_MASTER_VOLUME;
    return clampVolume(Number(raw));
  }
  /** Persist the master volume (clamped to [0,1]). */
  setMasterVolume(v: number) {
    this.write(MASTER_VOLUME_KEY, String(clampVolume(v)));
  }

  /**
   * "Getting warmer" cue on/off. DEFAULTS TO ON when never set (the historical
   * behaviour), and is remembered once toggled.
   */
  warmerCueEnabled(): boolean {
    const v = this.read(WARMER_CUE_KEY);
    if (v == null) return true; // unset ⇒ default ON
    return v === '1';
  }
  setWarmerCueEnabled(on: boolean) {
    this.write(WARMER_CUE_KEY, on ? '1' : '0');
  }
}
