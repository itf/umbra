/**
 * Settings persistence (6C) — a thin, testable localStorage wrapper for the new
 * audio/preference settings that don't already live in onboardingStore:
 *   - master VOLUME (0..1, stored as a percent-derived float)
 *   - the high-fidelity (Steam Audio) ENGINE preference on/off
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
// High-fidelity (Steam Audio) engine preference. Mirrors the Begin-screen / URL
// `?engine=steam` choice so the in-game Settings toggle can persist it; honoured by
// the NEXT level start (the audio backend is constructed at Begin, not hot-swapped).
export const STEAM_ENGINE_KEY = 'ps.settings.steamEngine';
// Spoken-voice (Web Speech / TTS) prefs (8A). TTS is OPT-IN: default OFF so a
// screen-reader user isn't double-spoken by both their AT and our synthesis.
export const TTS_ENABLED_KEY = 'ps.settings.ttsEnabled';
export const TTS_VOICE_KEY = 'ps.settings.ttsVoice';
export const TTS_RATE_KEY = 'ps.settings.ttsRate';
export const TTS_PITCH_KEY = 'ps.settings.ttsPitch';
// Steam Audio reverb / reflection LEVELS (0..1 multipliers on the backend's
// hardcoded base sends). Only affect the Steam Audio engine; the next run reads
// them at backend create() time (not a live hot-swap). BOTH default to 1.0 (full =
// today's behavior); the user tunes them down in the UI to localize rooms.
export const STEAM_REVERB_LEVEL_KEY = 'ps.settings.steamReverbLevel';
export const STEAM_REFLECTION_LEVEL_KEY = 'ps.settings.steamReflectionLevel';

/** Default master volume (full scale). */
export const DEFAULT_MASTER_VOLUME = 1;

/** Default Steam reverb level — full (= today's behavior). User tunes it down in the UI. */
export const DEFAULT_STEAM_REVERB_LEVEL = 1;
/** Default Steam reflection level — full (keep geometry echo cues). */
export const DEFAULT_STEAM_REFLECTION_LEVEL = 1;

/** PURE: clamp a 0..1 level; non-finite ⇒ `fallback`. */
export function clampLevel(v: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/** TTS rate/pitch defaults (mirrors speech.ts neutral values). */
export const DEFAULT_TTS_RATE = 1;
export const DEFAULT_TTS_PITCH = 1;

/** PURE: clamp a TTS rate to [0.5, 2]; non-finite ⇒ default. */
export function clampTtsRate(r: number): number {
  if (!Number.isFinite(r)) return DEFAULT_TTS_RATE;
  if (r < 0.5) return 0.5;
  if (r > 2) return 2;
  return r;
}

/** PURE: clamp a TTS pitch to [0, 2]; non-finite ⇒ default. */
export function clampTtsPitch(p: number): number {
  if (!Number.isFinite(p)) return DEFAULT_TTS_PITCH;
  if (p < 0) return 0;
  if (p > 2) return 2;
  return p;
}

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
   * High-fidelity (Steam Audio) engine on/off. `hasSteamEnginePref()` distinguishes
   * "never set" from an explicit choice, so a URL `?engine=steam` can still take
   * precedence at Begin when the user hasn't expressed a Settings preference.
   * DEFAULTS TO OFF (our own engine) when unset.
   */
  hasSteamEnginePref(): boolean {
    return this.read(STEAM_ENGINE_KEY) != null;
  }
  steamEngineEnabled(): boolean {
    return this.read(STEAM_ENGINE_KEY) === '1';
  }
  setSteamEngineEnabled(on: boolean) {
    this.write(STEAM_ENGINE_KEY, on ? '1' : '0');
  }

  /**
   * Spoken-voice (TTS) on/off. DEFAULTS TO OFF when never set — the safe
   * accessibility choice (no double-speak for screen-reader users). Opt-in.
   */
  ttsEnabled(): boolean {
    const v = this.read(TTS_ENABLED_KEY);
    if (v == null) return false; // unset ⇒ default OFF (opt-in)
    return v === '1';
  }
  setTtsEnabled(on: boolean) {
    this.write(TTS_ENABLED_KEY, on ? '1' : '0');
  }

  /** Preferred TTS voice name; empty string when unset (⇒ auto-pick). */
  ttsVoice(): string {
    return this.read(TTS_VOICE_KEY) ?? '';
  }
  setTtsVoice(name: string) {
    this.write(TTS_VOICE_KEY, name);
  }

  /** TTS rate in [0.5, 2]; the default when unset/corrupt. */
  ttsRate(): number {
    const raw = this.read(TTS_RATE_KEY);
    if (raw == null) return DEFAULT_TTS_RATE;
    return clampTtsRate(Number(raw));
  }
  setTtsRate(r: number) {
    this.write(TTS_RATE_KEY, String(clampTtsRate(r)));
  }

  /** TTS pitch in [0, 2]; the default when unset/corrupt. */
  ttsPitch(): number {
    const raw = this.read(TTS_PITCH_KEY);
    if (raw == null) return DEFAULT_TTS_PITCH;
    return clampTtsPitch(Number(raw));
  }
  setTtsPitch(p: number) {
    this.write(TTS_PITCH_KEY, String(clampTtsPitch(p)));
  }

  /**
   * Steam Audio reverb level in [0,1]; the (reduced) default when unset/corrupt.
   * A 0..1 MULTIPLIER on the backend's hardcoded reverb send. Read at backend
   * create() time — applies on the next run, not live.
   */
  steamReverbLevel(): number {
    const raw = this.read(STEAM_REVERB_LEVEL_KEY);
    if (raw == null) return DEFAULT_STEAM_REVERB_LEVEL;
    return clampLevel(Number(raw), DEFAULT_STEAM_REVERB_LEVEL);
  }
  setSteamReverbLevel(v: number) {
    this.write(STEAM_REVERB_LEVEL_KEY, String(clampLevel(v, DEFAULT_STEAM_REVERB_LEVEL)));
  }

  /**
   * Steam Audio reflection level in [0,1]; full by default. A 0..1 MULTIPLIER on
   * the backend's hardcoded reflect send (+ wet). Read at backend create() time.
   */
  steamReflectionLevel(): number {
    const raw = this.read(STEAM_REFLECTION_LEVEL_KEY);
    if (raw == null) return DEFAULT_STEAM_REFLECTION_LEVEL;
    return clampLevel(Number(raw), DEFAULT_STEAM_REFLECTION_LEVEL);
  }
  setSteamReflectionLevel(v: number) {
    this.write(STEAM_REFLECTION_LEVEL_KEY, String(clampLevel(v, DEFAULT_STEAM_REFLECTION_LEVEL)));
  }
}
