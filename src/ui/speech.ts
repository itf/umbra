/**
 * Spoken-voice layer (8A) — an OPTIONAL Web Speech (speechSynthesis) channel that
 * speaks the game's announcements ALOUD, ADDITIVE to the existing ARIA live regions
 * (#status / #alerts). It NEVER replaces the live regions: screen-reader users keep
 * their own assistive-tech voice; this is for the sighted-but-eyes-closed player who
 * wants the browser to talk.
 *
 * Design rules baked in here:
 *  - OPT-IN / DEFAULT OFF. The wiring in main.ts only calls `speak()` when the user
 *    has explicitly enabled TTS, so a screen-reader user never hears their AT voice
 *    AND our TTS at once (the double-speak trap). The `enabled` flag below is a second
 *    belt-and-braces gate.
 *  - GRACEFUL FALLBACK. If `speechSynthesis` is missing/unsupported, every method is a
 *    silent no-op and nothing throws — the live regions remain the sole channel.
 *  - Assertive lines INTERRUPT (cancel the queue, speak now); polite lines QUEUE.
 *  - PURE, testable logic (voice pick, rate/pitch clamp) is split from the live
 *    `speechSynthesis` calls so it can be unit-tested without a real engine.
 *
 * The class touches the live API; the exported pure helpers (`pickVoice`,
 * `clampRate`, `clampPitch`) have no dependency on the DOM/engine.
 */

/** Minimal shape of a voice we depend on (subset of SpeechSynthesisVoice). */
export interface VoiceInfo {
  name: string;
  lang: string;
  /** Local (on-device) voices are preferred — no network, lower latency. */
  localService?: boolean;
  /** The platform "default" voice flag, used as a last-resort tiebreaker. */
  default?: boolean;
}

export const DEFAULT_RATE = 1;
export const DEFAULT_PITCH = 1;
/** Web Speech allows 0.1..10 for rate; we keep a sane, usable sub-range. */
export const MIN_RATE = 0.5;
export const MAX_RATE = 2;
/** Web Speech allows 0..2 for pitch. */
export const MIN_PITCH = 0;
export const MAX_PITCH = 2;

/** PURE: clamp a rate to [MIN_RATE, MAX_RATE]; non-finite ⇒ default. */
export function clampRate(r: number): number {
  if (!Number.isFinite(r)) return DEFAULT_RATE;
  if (r < MIN_RATE) return MIN_RATE;
  if (r > MAX_RATE) return MAX_RATE;
  return r;
}

/** PURE: clamp a pitch to [MIN_PITCH, MAX_PITCH]; non-finite ⇒ default. */
export function clampPitch(p: number): number {
  if (!Number.isFinite(p)) return DEFAULT_PITCH;
  if (p < MIN_PITCH) return MIN_PITCH;
  if (p > MAX_PITCH) return MAX_PITCH;
  return p;
}

/**
 * PURE: choose a voice from a list given an optional preferred name.
 *  1. exact name match (the user's saved pick), if present;
 *  2. otherwise a sane default: a LOCAL English voice (no network, predictable),
 *     preferring the platform-default flag, then any English voice, then any voice.
 * Returns null only for an empty list (⇒ caller lets the engine pick).
 */
export function pickVoice(voices: VoiceInfo[], preferredName?: string): VoiceInfo | null {
  if (voices.length === 0) return null;
  if (preferredName) {
    const exact = voices.find((v) => v.name === preferredName);
    if (exact) return exact;
  }
  const isEn = (v: VoiceInfo) => /^en\b/i.test(v.lang) || /^en[-_]/i.test(v.lang);
  const localEn = voices.filter((v) => v.localService && isEn(v));
  const en = voices.filter(isEn);
  const pools = [localEn, en, voices];
  for (const pool of pools) {
    if (pool.length === 0) continue;
    return pool.find((v) => v.default) ?? pool[0];
  }
  return voices[0];
}

export interface SpeakOptions {
  /** Assertive lines interrupt (cancel + speak now); polite lines queue. */
  assertive?: boolean;
}

export interface SpeechSettings {
  enabled: boolean;
  /** Preferred voice name (as reported by the engine); empty ⇒ auto-pick. */
  voiceName?: string;
  rate: number;
  pitch: number;
}

/**
 * Live wrapper around `window.speechSynthesis`. Constructed once; `update()` pushes
 * the current settings in. If the engine is absent it's a permanent no-op.
 */
export class Speech {
  private synth: SpeechSynthesis | null;
  private settings: SpeechSettings = {
    enabled: false,
    voiceName: undefined,
    rate: DEFAULT_RATE,
    pitch: DEFAULT_PITCH,
  };
  private voices: SpeechSynthesisVoice[] = [];
  private onVoicesChanged: (() => void) | null = null;

  constructor(synth: SpeechSynthesis | null = resolveSynth()) {
    this.synth = synth;
    if (this.synth) {
      this.refreshVoices();
      // Voices frequently load asynchronously; re-read them when the engine signals.
      this.onVoicesChanged = () => this.refreshVoices();
      try {
        this.synth.addEventListener?.('voiceschanged', this.onVoicesChanged);
      } catch {
        /* some engines expose only onvoiceschanged; ignore if neither works */
      }
    }
  }

  /** Whether a real speech engine is present (false ⇒ everything no-ops). */
  isSupported(): boolean {
    return this.synth != null;
  }

  private refreshVoices() {
    try {
      this.voices = this.synth?.getVoices() ?? [];
    } catch {
      this.voices = [];
    }
  }

  /** The voices the engine currently knows about (may be empty until loaded). */
  availableVoices(): VoiceInfo[] {
    this.refreshVoices();
    return this.voices.map((v) => ({
      name: v.name,
      lang: v.lang,
      localService: v.localService,
      default: v.default,
    }));
  }

  /** Push the current user settings (enabled/voice/rate/pitch) into the wrapper. */
  update(s: Partial<SpeechSettings>) {
    this.settings = {
      ...this.settings,
      ...s,
      rate: s.rate != null ? clampRate(s.rate) : this.settings.rate,
      pitch: s.pitch != null ? clampPitch(s.pitch) : this.settings.pitch,
    };
  }

  /**
   * Speak `text` aloud, IF supported AND enabled. Assertive lines cancel anything
   * pending and speak immediately; polite lines queue behind whatever's speaking.
   * Never throws (a failed engine call degrades to silence — the live region still
   * showed the text).
   */
  speak(text: string, opts: SpeakOptions = {}) {
    if (!this.synth || !this.settings.enabled) return;
    const msg = text?.trim();
    if (!msg) return;
    try {
      if (opts.assertive) this.synth.cancel();
      const u = new SpeechSynthesisUtterance(msg);
      u.rate = clampRate(this.settings.rate);
      u.pitch = clampPitch(this.settings.pitch);
      const picked = pickVoice(this.availableVoices(), this.settings.voiceName);
      if (picked) {
        const v = this.voices.find((vv) => vv.name === picked.name);
        if (v) u.voice = v;
        u.lang = picked.lang;
      }
      this.synth.speak(u);
    } catch {
      /* engine hiccup → silent; the live region already carried the text */
    }
  }

  /**
   * Speak a SAMPLE line for auditioning the voice/rate/pitch from settings. Unlike
   * `speak()`, this ignores the `enabled` flag (the user is actively choosing a
   * voice), but still respects support (no-op + no throw when unsupported). Always
   * interrupts so successive previews don't pile up.
   */
  speakSample(text: string) {
    if (!this.synth) return;
    const prevEnabled = this.settings.enabled;
    this.settings.enabled = true;
    try {
      this.speak(text, { assertive: true });
    } finally {
      this.settings.enabled = prevEnabled;
    }
  }

  /** Stop anything currently speaking/queued (e.g. on disable). */
  cancel() {
    try {
      this.synth?.cancel();
    } catch {
      /* ignore */
    }
  }

  /** Detach the voices listener (tidy; rarely needed in a single-page session). */
  dispose() {
    if (this.synth && this.onVoicesChanged) {
      try {
        this.synth.removeEventListener?.('voiceschanged', this.onVoicesChanged);
      } catch {
        /* ignore */
      }
    }
  }
}

/** Resolve the live speechSynthesis, or null when unsupported (SSR/jsdom/old browser). */
function resolveSynth(): SpeechSynthesis | null {
  try {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window && window.speechSynthesis) {
      return window.speechSynthesis;
    }
  } catch {
    /* access can throw in locked-down contexts */
  }
  return null;
}
