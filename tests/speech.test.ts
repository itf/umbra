import { describe, it, expect } from 'vitest';
import {
  pickVoice,
  clampRate,
  clampPitch,
  Speech,
  DEFAULT_RATE,
  DEFAULT_PITCH,
  MIN_RATE,
  MAX_RATE,
  type VoiceInfo,
} from '../src/ui/speech';

describe('clampRate / clampPitch (pure)', () => {
  it('clamps rate to [0.5, 2]', () => {
    expect(clampRate(0.1)).toBe(MIN_RATE);
    expect(clampRate(1)).toBe(1);
    expect(clampRate(5)).toBe(MAX_RATE);
  });
  it('rate defaults on non-finite', () => {
    expect(clampRate(NaN)).toBe(DEFAULT_RATE);
    expect(clampRate(Infinity)).toBe(DEFAULT_RATE); // non-finite ⇒ safe default
  });
  it('clamps pitch to [0, 2]', () => {
    expect(clampPitch(-1)).toBe(0);
    expect(clampPitch(1)).toBe(1);
    expect(clampPitch(3)).toBe(2);
    expect(clampPitch(NaN)).toBe(DEFAULT_PITCH);
  });
});

describe('pickVoice (pure)', () => {
  const en: VoiceInfo = { name: 'Alice', lang: 'en-US', localService: true };
  const enRemote: VoiceInfo = { name: 'Cloud', lang: 'en-GB', localService: false };
  const fr: VoiceInfo = { name: 'Amelie', lang: 'fr-FR', localService: true };

  it('returns null for an empty list', () => {
    expect(pickVoice([])).toBeNull();
  });
  it('honours an exact preferred name', () => {
    expect(pickVoice([en, fr], 'Amelie')).toBe(fr);
  });
  it('falls back to the default pick when the preferred name is absent', () => {
    expect(pickVoice([en, fr], 'Nonexistent')).toBe(en);
  });
  it('prefers a LOCAL English voice', () => {
    expect(pickVoice([fr, enRemote, en])).toBe(en);
  });
  it('prefers any English voice over a non-English one when no local English exists', () => {
    expect(pickVoice([fr, enRemote])).toBe(enRemote);
  });
  it('honours the platform default flag within the chosen pool', () => {
    const a: VoiceInfo = { name: 'A', lang: 'en-US', localService: true };
    const b: VoiceInfo = { name: 'B', lang: 'en-US', localService: true, default: true };
    expect(pickVoice([a, b])).toBe(b);
  });
  it('falls back to any voice when none are English', () => {
    expect(pickVoice([fr])).toBe(fr);
  });
});

describe('Speech graceful fallback (no engine)', () => {
  it('is a silent no-op and never throws when speechSynthesis is absent', () => {
    const s = new Speech(null);
    expect(s.isSupported()).toBe(false);
    expect(s.availableVoices()).toEqual([]);
    expect(() => {
      s.update({ enabled: true, rate: 1.5, pitch: 1 });
      s.speak('hello', { assertive: true });
      s.speak('polite');
      s.speakSample('test');
      s.cancel();
      s.dispose();
    }).not.toThrow();
  });
});

/** A fake speechSynthesis recording calls without a real engine. */
function fakeSynth() {
  const spoken: { text: string; rate: number; pitch: number }[] = [];
  let cancels = 0;
  const voices = [
    { name: 'Alice', lang: 'en-US', localService: true, default: true },
    { name: 'Amelie', lang: 'fr-FR', localService: true },
  ];
  const synth = {
    getVoices: () => voices,
    speak: (u: { text: string; rate: number; pitch: number }) =>
      spoken.push({ text: u.text, rate: u.rate, pitch: u.pitch }),
    cancel: () => { cancels++; },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  return { synth, spoken, getCancels: () => cancels };
}

describe('Speech enabled-flag gating + interrupt behaviour', () => {
  // Provide a minimal SpeechSynthesisUtterance shim for the non-DOM test env.
  const orig = (globalThis as any).SpeechSynthesisUtterance;
  function withUtterance(fn: () => void) {
    (globalThis as any).SpeechSynthesisUtterance = class {
      text: string; rate = 1; pitch = 1; voice: unknown = null; lang = '';
      constructor(t: string) { this.text = t; }
    };
    try { fn(); } finally { (globalThis as any).SpeechSynthesisUtterance = orig; }
  }

  it('does NOT speak while disabled (default OFF), and speaks once enabled', () => {
    withUtterance(() => {
      const f = fakeSynth();
      const s = new Speech(f.synth as any);
      s.speak('ignored'); // enabled defaults false
      expect(f.spoken).toHaveLength(0);
      s.update({ enabled: true });
      s.speak('now');
      expect(f.spoken).toHaveLength(1);
      expect(f.spoken[0].text).toBe('now');
    });
  });

  it('assertive lines cancel (interrupt); polite lines do not', () => {
    withUtterance(() => {
      const f = fakeSynth();
      const s = new Speech(f.synth as any);
      s.update({ enabled: true });
      s.speak('polite');
      expect(f.getCancels()).toBe(0);
      s.speak('urgent', { assertive: true });
      expect(f.getCancels()).toBe(1);
    });
  });

  it('applies clamped rate/pitch from settings', () => {
    withUtterance(() => {
      const f = fakeSynth();
      const s = new Speech(f.synth as any);
      s.update({ enabled: true, rate: 99, pitch: -5 });
      s.speak('x');
      expect(f.spoken[0].rate).toBe(MAX_RATE);
      expect(f.spoken[0].pitch).toBe(0);
    });
  });

  it('speakSample speaks even while disabled (auditioning) without enabling persistently', () => {
    withUtterance(() => {
      const f = fakeSynth();
      const s = new Speech(f.synth as any);
      s.speakSample('preview'); // still disabled
      expect(f.spoken).toHaveLength(1);
      s.speak('still-off'); // gate restored
      expect(f.spoken).toHaveLength(1);
    });
  });

  it('availableVoices maps engine voices', () => {
    const f = fakeSynth();
    const s = new Speech(f.synth as any);
    const v = s.availableVoices();
    expect(v.map((x) => x.name)).toEqual(['Alice', 'Amelie']);
  });
});
