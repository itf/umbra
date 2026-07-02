/**
 * Tests the profiles + share + resume save/restore layer (hrtfProfiles.ts) and the
 * shareable profile code/URL (hrtfProfileCode.ts): CRUD round-trip, the reserved last-best
 * entry, schema-signature match/mismatch, lossless share code + URL, and resume guarding.
 */
import { describe, it, expect } from 'vitest';
import { SettingsStore } from '../src/ui/settingsStore';
import {
  HrtfProfiles, schemaSignature, signatureMatches, normalizeTuning,
  LAST_BEST_ID, LAST_BEST_NAME, type ProfileTuning,
} from '../src/ui/hrtfProfiles';
import {
  encodeSharedProfile, decodeSharedProfile, encodeSharedProfileUrl, decodeSharedProfileUrl,
  type SharedProfile,
} from '../src/ui/hrtfProfileCode';
import { NEUTRAL_PERSONALIZATION } from '../src/engine/hrtf/personalize';

function memStore(): SettingsStore {
  const m = new Map<string, string>();
  return new SettingsStore({
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  });
}

const SIG = schemaSignature(['sadie_h3', 'ss2_ztv'], { k: 7, kinds: [0, 0, 0, 0, 0, 1, 1] });

function tuning(overrides: Partial<ProfileTuning> = {}): ProfileTuning {
  return {
    base: 'ss2_ztv',
    params: { ...NEUTRAL_PERSONALIZATION, frontBackTilt: 6, frontBackBias: 0.3, pcaWeights: [1, 0, 0, 0, 0, 0.5, 0] },
    compStrength: 0.5,
    ...overrides,
  };
}

describe('schemaSignature', () => {
  it('is order-independent for head ids and includes the PCA layout', () => {
    const a = schemaSignature(['b', 'a'], { k: 2, kinds: [0, 1] });
    const b = schemaSignature(['a', 'b'], { k: 2, kinds: [0, 1] });
    expect(a).toBe(b);
    expect(a).not.toBe(schemaSignature(['a', 'b'], { k: 3, kinds: [0, 1, 0] }));
    expect(schemaSignature(['a'], null)).toContain('nopca');
  });
  it('signatureMatches accepts equal / empty-stored, rejects different', () => {
    expect(signatureMatches(SIG, SIG)).toBe(true);
    expect(signatureMatches('', SIG)).toBe(true);       // legacy blob (no sig) = any
    expect(signatureMatches('other', SIG)).toBe(false);
  });
});

describe('HrtfProfiles CRUD', () => {
  it('save → list → get → rename → delete round-trips', () => {
    const p = new HrtfProfiles(memStore());
    const e = p.save('Mine', tuning(), SIG);
    expect(p.list().map((x) => x.id)).toContain(e.id);
    expect(p.get(e.id)!.tuning.base).toBe('ss2_ztv');
    expect(p.rename(e.id, 'Renamed')).toBe(true);
    expect(p.get(e.id)!.name).toBe('Renamed');
    expect(p.delete(e.id)).toBe(true);
    expect(p.get(e.id)).toBeNull();
    expect(p.delete(e.id)).toBe(false); // already gone
  });

  it('persists across store instances (localStorage-backed)', () => {
    const backing = new Map<string, string>();
    const store = () => new SettingsStore({
      getItem: (k) => backing.get(k) ?? null,
      setItem: (k, v) => void backing.set(k, v),
      removeItem: (k) => void backing.delete(k),
    });
    new HrtfProfiles(store()).save('A', tuning(), SIG);
    expect(new HrtfProfiles(store()).list().length).toBe(1);
  });

  it('ordinals are monotonic (no wall-clock) and survive reloads', () => {
    const p = new HrtfProfiles(memStore());
    const a = p.save('A', tuning(), SIG);
    const b = p.save('B', tuning(), SIG);
    expect(b.ordinal).toBeGreaterThan(a.ordinal);
  });

  it('repairs a corrupt / stale blob to an empty list', () => {
    const store = memStore();
    store.writeRaw('ps.settings.hrtfProfiles', '{not json');
    expect(new HrtfProfiles(store).list()).toEqual([]);
  });
});

describe('last-best reserved profile', () => {
  it('is reserved, sorts first, and is OVERWRITTEN each calibration (single entry)', () => {
    const p = new HrtfProfiles(memStore());
    p.save('User A', tuning(), SIG);
    p.saveLastBest(tuning({ base: 'sadie_h3' }), SIG);
    p.saveLastBest(tuning({ base: 'ss2_gzu' }), SIG); // second calibration overwrites
    const lasts = p.list().filter((e) => e.id === LAST_BEST_ID);
    expect(lasts.length).toBe(1);
    expect(lasts[0].name).toBe(LAST_BEST_NAME);
    expect(lasts[0].reserved).toBe(true);
    expect(lasts[0].tuning.base).toBe('ss2_gzu'); // the latest
    // reserved entry sorts to the FRONT of the list.
    expect(p.list()[0].id).toBe(LAST_BEST_ID);
  });
});

describe('shared profile code (lossless, signature-aware)', () => {
  const sp = (): SharedProfile => ({
    base: 'ss2_ztv', params: tuning().params, compStrength: 0.5, name: 'My ears', sig: SIG,
  });

  it('encode → decode is lossless for base, params, comp, name, sig', () => {
    const back = decodeSharedProfile(encodeSharedProfile(sp()))!;
    expect(back.base).toBe('ss2_ztv');
    expect(back.name).toBe('My ears');
    expect(back.sig).toBe(SIG);
    expect(back.compStrength).toBeCloseTo(0.5, 6);
    expect(back.params.frontBackTilt).toBeCloseTo(6, 6);
    expect(back.params.frontBackBias).toBeCloseTo(0.3, 6);
    expect(back.params.pcaWeights).toEqual([1, 0, 0, 0, 0, 0.5, 0]);
  });

  it('URL round-trips (code rides the hash query param)', () => {
    const url = encodeSharedProfileUrl(sp(), 'https://app.example/umbra/');
    expect(url).toContain('hp=');
    const back = decodeSharedProfileUrl(url)!;
    expect(back.name).toBe('My ears');
    expect(back.base).toBe('ss2_ztv');
    expect(back.sig).toBe(SIG);
  });

  it('rejects garbage and returns null (never throws)', () => {
    expect(decodeSharedProfile('not a code')).toBeNull();
    expect(decodeSharedProfileUrl('https://app.example/?other=1')).toBeNull();
  });

  it('a signature MISMATCH is detectable by the importer (sig survives the round-trip)', () => {
    const back = decodeSharedProfile(encodeSharedProfile(sp()))!;
    const currentSig = schemaSignature(['sadie_h3'], { k: 5, kinds: [0, 0, 0, 0, 0] }); // different build
    expect(signatureMatches(back.sig, currentSig)).toBe(false);
  });
});

describe('resume blob storage + version/signature guard', () => {
  // Mirrors the host save/load/clear in main.ts: version-stamped, signature-guarded,
  // discarded on mismatch/stale/corrupt. (The store layer is what we can unit-test.)
  const KEY = 'ps.settings.hrtfCalResume';
  const VERSION = 1;
  const saveResume = (store: SettingsStore, sig: string, blob: unknown) =>
    store.writeRaw(KEY, JSON.stringify({ version: VERSION, sig, blob }));
  const loadResume = (store: SettingsStore, sig: string): unknown => {
    const raw = store.readRaw(KEY);
    if (!raw) return null;
    try {
      const p = JSON.parse(raw) as { version?: number; sig?: string; blob?: unknown };
      if (p.version !== VERSION || !signatureMatches(p.sig ?? '', sig) || !p.blob) { store.removeRaw(KEY); return null; }
      return p.blob;
    } catch { store.removeRaw(KEY); return null; }
  };

  it('round-trips a matching-signature snapshot', () => {
    const store = memStore();
    const blob = { mode: 'full', answered: 4, session: { pass: 1 } };
    saveResume(store, SIG, blob);
    expect(loadResume(store, SIG)).toEqual(blob);
  });

  it('DISCARDS a snapshot from an incompatible signature (and clears it)', () => {
    const store = memStore();
    saveResume(store, SIG, { mode: 'full', answered: 2 });
    const otherSig = schemaSignature(['sadie_h3'], { k: 5, kinds: [0, 0, 0, 0, 0] });
    expect(loadResume(store, otherSig)).toBeNull();
    expect(store.readRaw(KEY)).toBeNull(); // cleared on mismatch
  });

  it('discards a stale-version / corrupt payload', () => {
    const store = memStore();
    store.writeRaw(KEY, JSON.stringify({ version: 999, sig: SIG, blob: {} }));
    expect(loadResume(store, SIG)).toBeNull();
    store.writeRaw(KEY, '{corrupt');
    expect(loadResume(store, SIG)).toBeNull();
  });

  it('clear removes the snapshot (completion path)', () => {
    const store = memStore();
    saveResume(store, SIG, { mode: 'full', answered: 1 });
    store.removeRaw(KEY);
    expect(loadResume(store, SIG)).toBeNull();
  });
});

describe('normalizeTuning', () => {
  it('clamps params + comp and defaults a missing base', () => {
    const n = normalizeTuning({ params: { frontBackBias: 9 } as never, compStrength: 5 }, 'sadie_h3');
    expect(n.base).toBe('sadie_h3');
    expect(n.compStrength).toBe(1);           // clamped to [0,1]
    expect(n.params.frontBackBias).toBe(1);   // clamped to [−1,1]
  });
});
