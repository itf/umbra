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
export const STEAM_SOFA_KEY = 'ps.settings.steamSofaHrtf';
export const STEAM_REFLECTION_ORDER_KEY = 'ps.settings.steamReflectionOrder';
// Spoken-voice (Web Speech / TTS) prefs (8A). TTS is OPT-IN: default OFF so a
// screen-reader user isn't double-spoken by both their AT and our synthesis.
export const TTS_ENABLED_KEY = 'ps.settings.ttsEnabled';
export const TTS_VOICE_KEY = 'ps.settings.ttsVoice';
export const TTS_RATE_KEY = 'ps.settings.ttsRate';
export const TTS_PITCH_KEY = 'ps.settings.ttsPitch';
// Steam Audio reflection / bus LEVELS (0..1 multipliers on the backend's hardcoded
// base sends/wets). Only affect the Steam Audio engine. THREE knobs:
//  - steamReflectionWet → per-source reflected-field `wet` (applied via a REBUILD);
//  - steamReflectionBus → reflection bus wet + each source's reflect send (live);
//  - steamReverbBus     → reverb bus wet + each source's reverb send (live).
// ALL default to 1.0 (full = today's behavior); the user tunes them down to localize
// rooms (minimum on all three = truly no reflected/reverb energy).
export const STEAM_REFLECTION_WET_KEY = 'ps.settings.steamReflectionWet';
export const STEAM_REFLECTION_BUS_KEY = 'ps.settings.steamReflectionBus';
export const STEAM_REVERB_BUS_KEY = 'ps.settings.steamReverbBus';
/** Global room CLUTTER (0..1) added on top of each level's own clutter — tames a
 *  hard, fluttery room (more scattering + absorption). Default 0 (no extra). */
export const CLUTTER_KEY = 'ps.settings.clutter';

/** Default master volume (full scale). */
export const DEFAULT_MASTER_VOLUME = 1;

/** Default Steam per-source reflection wet level — full (= today's behavior). */
export const DEFAULT_STEAM_REFLECTION_WET = 1;
/** Default Steam reflection bus level — full (= today's behavior). */
export const DEFAULT_STEAM_REFLECTION_BUS = 1;
/** Default Steam reverb bus level — full (= today's behavior). */
export const DEFAULT_STEAM_REVERB_BUS = 1;

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
   * Steam Audio HRTF choice: ON ⇒ feed OUR measured SADIE SOFA into Steam (same ears
   * as our own engine); OFF ⇒ Steam's generic built-in HRTF. DEFAULTS TO OFF (generic).
   * Only affects the Steam path; takes effect on the next level start or via Apply
   * (the HRTF is baked at world creation, so applying it rebuilds the backend).
   * The `?engine=steam-sofa` URL still forces SADIE regardless of this setting.
   */
  steamSofaHrtf(): boolean {
    return this.read(STEAM_SOFA_KEY) === '1';
  }
  setSteamSofaHrtf(on: boolean) {
    this.write(STEAM_SOFA_KEY, on ? '1' : '0');
  }

  /**
   * Ambisonic ORDER of Steam's head-tracked reflected field, 1..3. Higher = sharper
   * reflection directionality at more CPU. DEFAULTS TO 1 (today's behavior). Baked at
   * world creation, so a change applies on the next level or via Apply (rebuild).
   */
  steamReflectionOrder(): number {
    const v = Math.round(Number(this.read(STEAM_REFLECTION_ORDER_KEY)));
    return Number.isFinite(v) && v >= 1 && v <= 3 ? v : 1;
  }
  setSteamReflectionOrder(order: number) {
    const v = Math.max(1, Math.min(3, Math.round(order)));
    this.write(STEAM_REFLECTION_ORDER_KEY, String(v));
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
   * Steam per-source REFLECTION WET level in [0,1]; full by default. A 0..1 MULTIPLIER
   * on each source's baked reflected-field `wet`. Applied via a source REBUILD.
   */
  steamReflectionWet(): number {
    const raw = this.read(STEAM_REFLECTION_WET_KEY);
    if (raw == null) return DEFAULT_STEAM_REFLECTION_WET;
    return clampLevel(Number(raw), DEFAULT_STEAM_REFLECTION_WET);
  }
  setSteamReflectionWet(v: number) {
    this.write(STEAM_REFLECTION_WET_KEY, String(clampLevel(v, DEFAULT_STEAM_REFLECTION_WET)));
  }

  /**
   * Steam REFLECTION BUS level in [0,1]; full by default. A 0..1 MULTIPLIER on the
   * shared reflection bus wet AND each source's reflect send. LIVE-applicable.
   */
  steamReflectionBus(): number {
    const raw = this.read(STEAM_REFLECTION_BUS_KEY);
    if (raw == null) return DEFAULT_STEAM_REFLECTION_BUS;
    return clampLevel(Number(raw), DEFAULT_STEAM_REFLECTION_BUS);
  }
  setSteamReflectionBus(v: number) {
    this.write(STEAM_REFLECTION_BUS_KEY, String(clampLevel(v, DEFAULT_STEAM_REFLECTION_BUS)));
  }

  /**
   * Steam REVERB BUS level in [0,1]; full by default. A 0..1 MULTIPLIER on the shared
   * reverb bus wet AND each source's reverb send. LIVE-applicable.
   */
  steamReverbBus(): number {
    const raw = this.read(STEAM_REVERB_BUS_KEY);
    if (raw == null) return DEFAULT_STEAM_REVERB_BUS;
    return clampLevel(Number(raw), DEFAULT_STEAM_REVERB_BUS);
  }
  setSteamReverbBus(v: number) {
    this.write(STEAM_REVERB_BUS_KEY, String(clampLevel(v, DEFAULT_STEAM_REVERB_BUS)));
  }

  /**
   * Global room CLUTTER (0..1), ADDED on top of each level's own clutter (the runtime
   * uses max(level, this)), so the slider only ever damps a too-live room and never
   * undoes a level that authored clutter. Default 0 (no extra). Affects BOTH engines;
   * applies on the next level load (re-load to hear a change).
   */
  clutter(): number {
    const raw = this.read(CLUTTER_KEY);
    if (raw == null) return 0;
    return clampLevel(Number(raw), 0);
  }
  setClutter(v: number) {
    this.write(CLUTTER_KEY, String(clampLevel(v, 0)));
  }
}
