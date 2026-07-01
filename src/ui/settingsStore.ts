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
/** BEACON VOLUME (0..1): a multiplier on the dry beacon voice level (the bell/tone/etc.
 *  that you home in on). Lets the user turn a too-hot beacon down — which also tames the
 *  reflected field it drives in hard rooms. LIVE-applicable. Default 1 (full). */
export const BEACON_VOLUME_KEY = 'ps.settings.beaconVolume';
/** Global room CLUTTER (0..1) added on top of each level's own clutter — tames a
 *  hard, fluttery room (more scattering + absorption). Default 0 (no extra). */
export const CLUTTER_KEY = 'ps.settings.clutter';
/** DEBUG OVERLAY (top-down minimap + live audio readout). Was URL-only (?debug=1);
 *  this pref lets the Settings panel / a key toggle it too. Default OFF. */
export const DEBUG_OVERLAY_KEY = 'ps.settings.debugOverlay';
/** AUTO-STEP: holding the forward key walks at a constant medium-slow cadence
 *  (accessibility / simplification) instead of one step per press. Default OFF. */
export const AUTO_STEP_KEY = 'ps.settings.autoStep';
/** REALISTIC CLICK PROBE: when on, the in-game echo/clap excitation is the
 *  research-modelled expert mouth click (game/clickProbe.ts) instead of the default
 *  broadband noise burst. Default OFF (noise burst — unchanged behaviour). */
export const REALISTIC_CLICK_KEY = 'ps.settings.realisticClick';
/** PROBE CHOICE: which echo/probe sound the player fires. A probe-catalog id — a synth
 *  preset name ('clap', 'mouthclick', …) or 'rec:<id>' for a CC recording. Default the
 *  legacy noise-burst clap so existing behaviour is unchanged. Supersedes the older
 *  boolean REALISTIC_CLICK toggle (kept for back-compat migration). */
export const PROBE_CHOICE_KEY = 'ps.settings.probeChoice';

/**
 * Per-user multi-band LOUDNESS-EQ correction curve (a utility, not a game): an
 * array of {freq, gainDb} produced by the equal-loudness calibration, applied to the
 * master bus so the user's headphones/ears sound flat. VERSIONED so a future band/
 * format change can be detected and discarded rather than mis-applied.
 */
export const LOUDNESS_EQ_KEY = 'ps.settings.loudnessEq';
export const LOUDNESS_EQ_VERSION = 1;

/** A single EQ correction point (mirrors loudnessEq.EqBand; kept local to avoid a
 *  store→ui import cycle). */
export interface LoudnessEqBand {
  freq: number;
  gainDb: number;
}

/** Default master volume (full scale). */
export const DEFAULT_MASTER_VOLUME = 1;

/** Default Steam per-source reflection wet level — full (= today's behavior). */
export const DEFAULT_STEAM_REFLECTION_WET = 1;
/** Default Steam reflection bus level — full (= today's behavior). */
export const DEFAULT_STEAM_REFLECTION_BUS = 1;
/** Default Steam reverb bus level — full (= today's behavior). */
export const DEFAULT_STEAM_REVERB_BUS = 1;
/** Default beacon volume — full (= today's behavior). */
export const DEFAULT_BEACON_VOLUME = 1;

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

  /** BEACON VOLUME in [0,1]; full by default. Multiplier on the dry beacon voice. LIVE. */
  beaconVolume(): number {
    const raw = this.read(BEACON_VOLUME_KEY);
    if (raw == null) return DEFAULT_BEACON_VOLUME;
    return clampLevel(Number(raw), DEFAULT_BEACON_VOLUME);
  }
  setBeaconVolume(v: number) {
    this.write(BEACON_VOLUME_KEY, String(clampLevel(v, DEFAULT_BEACON_VOLUME)));
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

  /**
   * DEBUG OVERLAY on/off (minimap + audio readout). Default OFF. The URL `?debug=1`
   * still force-enables it regardless (see main.ts) so the dev deep-link is unchanged;
   * this pref is the in-app (Settings / key) toggle. `hasDebugOverlayPref` lets the URL
   * win when the user has never expressed a preference.
   */
  hasDebugOverlayPref(): boolean {
    return this.read(DEBUG_OVERLAY_KEY) != null;
  }
  debugOverlay(): boolean {
    return this.read(DEBUG_OVERLAY_KEY) === '1';
  }
  setDebugOverlay(on: boolean) {
    this.write(DEBUG_OVERLAY_KEY, on ? '1' : '0');
  }

  /**
   * AUTO-STEP on/off: holding the forward key walks at a steady medium-slow cadence
   * rather than requiring one keypress per step. Default OFF (the normal per-press
   * alternating-foot cadence). Purely an input convenience — the game's step model is
   * unchanged; auto-step just fires steps on a timer while the key is held.
   */
  autoStep(): boolean {
    return this.read(AUTO_STEP_KEY) === '1';
  }
  setAutoStep(on: boolean) {
    this.write(AUTO_STEP_KEY, on ? '1' : '0');
  }

  /**
   * LEGACY realistic-click toggle. Superseded by the probe CHOOSER (`probeChoice`);
   * no live UI reads/writes it anymore. Retained ONLY so `probeChoice()` can migrate a
   * user who had the old boolean ON to the 'mouthclick' choice. Do not wire new UI to
   * these — use `probeChoice`/`setProbeChoice`.
   */
  realisticClick(): boolean {
    return this.read(REALISTIC_CLICK_KEY) === '1';
  }
  setRealisticClick(on: boolean) {
    this.write(REALISTIC_CLICK_KEY, on ? '1' : '0');
  }

  /**
   * PROBE CHOICE — which echo/probe the player fires (a probe-catalog id: a synth
   * preset name or 'rec:<id>'). Default 'clap' (the legacy noise burst). Migrates the
   * older boolean `realisticClick` toggle: if the new key is unset but the old flag was
   * ON, report 'mouthclick' so upgrading users keep their realistic click.
   */
  probeChoice(): string {
    const v = this.read(PROBE_CHOICE_KEY);
    if (v != null && v !== '') return v;
    if (this.read(REALISTIC_CLICK_KEY) === '1') return 'mouthclick'; // migrate old toggle
    return 'mouthclick'; // the good tongue click — the default, most legible probe
  }
  setProbeChoice(id: string) {
    this.write(PROBE_CHOICE_KEY, id);
  }

  /**
   * The stored per-user LOUDNESS-EQ correction curve, or null when never calibrated
   * or the stored payload is corrupt / a stale version. Each entry's gainDb is
   * defensively clamped to ±24 dB (a sane far-outer bound; the calibration itself
   * clamps tighter) so corrupt data can never produce an extreme filter.
   */
  loudnessEq(): LoudnessEqBand[] | null {
    const raw = this.read(LOUDNESS_EQ_KEY);
    if (raw == null) return null;
    try {
      const parsed = JSON.parse(raw) as { version?: number; bands?: unknown };
      if (parsed.version !== LOUDNESS_EQ_VERSION || !Array.isArray(parsed.bands)) return null;
      const bands: LoudnessEqBand[] = [];
      for (const b of parsed.bands as unknown[]) {
        const rec = b as { freq?: unknown; gainDb?: unknown };
        const freq = Number(rec.freq);
        const gainDb = Number(rec.gainDb);
        if (!Number.isFinite(freq) || freq <= 0 || !Number.isFinite(gainDb)) continue;
        bands.push({ freq, gainDb: Math.max(-24, Math.min(24, gainDb)) });
      }
      return bands.length ? bands : null;
    } catch {
      return null;
    }
  }

  /** Persist the loudness-EQ curve (versioned). Empty/absent ⇒ clears it. */
  setLoudnessEq(bands: LoudnessEqBand[] | null) {
    if (!bands || bands.length === 0) {
      this.clearLoudnessEq();
      return;
    }
    this.write(LOUDNESS_EQ_KEY, JSON.stringify({ version: LOUDNESS_EQ_VERSION, bands }));
  }

  /** Remove the loudness-EQ curve (the "reset EQ" path). */
  clearLoudnessEq() {
    this.mem.delete(LOUDNESS_EQ_KEY);
    try {
      this.store?.removeItem(LOUDNESS_EQ_KEY);
    } catch {
      /* memory already cleared */
    }
  }
}
