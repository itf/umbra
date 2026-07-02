/**
 * PROFILES + RESUME — the shared save/restore layer for HRTF tuning state. A PROFILE is a
 * full tuning snapshot (base head + all personalization params incl. the front/back + up/down
 * biases + pcaWeights + the over-ear comp strength) with a name, id, and monotonic ordinal.
 * RESUME persistence (the in-progress LocSession) rides the SAME storage/versioning here so
 * there's ONE storage layer, not two.
 *
 * Everything is localStorage-backed via SettingsStore. Pure logic (schema, signature match,
 * list CRUD, ordinal) is unit-tested; the store is injected so tests use an in-memory backing.
 *
 * SIGNATURE: a profile / resume blob is stamped with a schema signature — the BASE_HRTFS ids
 * + the PCA layout (k + kinds). A snapshot from an INCOMPATIBLE model/head-set (a different
 * build) is flagged on load so we never silently apply wrong data (a pcaWeights vector aimed
 * at a different PC layout, or a base id that no longer exists).
 *
 * Time note: Date.now()/Math.random() can be unavailable in some contexts, so ordering uses a
 * MONOTONIC integer counter persisted in the blob (never wall-clock), and ids use crypto when
 * available else a counter-derived string. Nothing here crashes if time/crypto APIs are absent.
 */
import type { SettingsStore } from './settingsStore';
import type { HrtfPersonalization } from '../engine/hrtf/personalize';
import { clampPersonalization, NEUTRAL_PERSONALIZATION } from '../engine/hrtf/personalize';

/** localStorage keys owned by this layer. */
export const HRTF_PROFILES_KEY = 'ps.settings.hrtfProfiles';
export const HRTF_RESUME_KEY = 'ps.settings.hrtfCalResume';
/** Bump when the on-disk profile/resume shape changes incompatibly. */
export const HRTF_PROFILES_VERSION = 1;
/** The reserved, always-present "last calibration" profile id (auto-saved, not user-created). */
export const LAST_BEST_ID = 'last-best';
export const LAST_BEST_NAME = 'Last calibration (best)';

/** The tuning a profile captures — everything needed to reproduce a user's sound. */
export interface ProfileTuning {
  base: string;                 // base head id
  params: HrtfPersonalization;  // all warp scalars + biases + pcaWeights
  compStrength: number;         // over-ear comp strength [0,1]
}

export interface HrtfProfileEntry {
  id: string;
  name: string;
  /** Monotonic creation ordinal (NOT wall-clock) — sorts newest-last deterministically. */
  ordinal: number;
  /** true for the reserved auto-saved "Last calibration" entry (not user-created). */
  reserved?: boolean;
  tuning: ProfileTuning;
  /** Schema signature at save time (see signatureMatches). */
  sig: string;
}

/** The stored blob: a version + a monotonic counter + the entries. */
interface ProfilesBlob {
  version: number;
  /** Next ordinal to hand out (monotonic; survives reloads via the blob). */
  nextOrdinal: number;
  entries: HrtfProfileEntry[];
}

/** The PCA layout a signature needs — supplied by the caller once the model is known. */
export interface PcaLayout {
  k: number;
  kinds: number[];
}

/**
 * Build the schema signature from the available base-head ids + PCA layout. A profile saved
 * under signature X only cleanly applies where the current signature is also X. Deterministic
 * + order-independent for the head ids (sorted).
 */
export function schemaSignature(baseIds: readonly string[], pca: PcaLayout | null): string {
  const heads = [...baseIds].sort().join(',');
  const pcaSig = pca ? `${pca.k}:${pca.kinds.join('')}` : 'nopca';
  return `h[${heads}]|p[${pcaSig}]`;
}

/** Does a stored profile's signature match the current one? (empty stored sig = legacy/any) */
export function signatureMatches(stored: string, current: string): boolean {
  return !stored || stored === current;
}

/** Clamp + normalize a tuning read from storage/import so it can never drive nonsense. */
export function normalizeTuning(t: Partial<ProfileTuning> | undefined, defaultBase: string): ProfileTuning {
  const params = clampPersonalization({ ...NEUTRAL_PERSONALIZATION, ...(t?.params ?? {}) });
  const base = typeof t?.base === 'string' && t.base ? t.base : defaultBase;
  const compRaw = Number(t?.compStrength);
  const compStrength = Number.isFinite(compRaw) ? Math.min(1, Math.max(0, compRaw)) : 0;
  return { base, params, compStrength };
}

/** A collision-resistant id without requiring crypto/time. Falls back to the ordinal. */
function makeId(ordinal: number): string {
  try {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (c?.randomUUID) return c.randomUUID();
  } catch { /* no crypto */ }
  return `p${ordinal}`;
}

/**
 * The profiles manager: SettingsStore-backed CRUD over the versioned blob. All reads repair
 * a missing/corrupt/stale blob to an empty list; all writes persist the full blob.
 */
export class HrtfProfiles {
  constructor(private store: SettingsStore) {}

  private read(): ProfilesBlob {
    const raw = this.store.readRaw(HRTF_PROFILES_KEY);
    if (raw == null) return { version: HRTF_PROFILES_VERSION, nextOrdinal: 1, entries: [] };
    try {
      const b = JSON.parse(raw) as Partial<ProfilesBlob>;
      if (b.version !== HRTF_PROFILES_VERSION || !Array.isArray(b.entries)) {
        return { version: HRTF_PROFILES_VERSION, nextOrdinal: 1, entries: [] };
      }
      const entries = b.entries.filter((e): e is HrtfProfileEntry =>
        !!e && typeof e.id === 'string' && typeof e.name === 'string' && !!e.tuning);
      const maxOrd = entries.reduce((m, e) => Math.max(m, e.ordinal || 0), 0);
      return { version: HRTF_PROFILES_VERSION, nextOrdinal: Math.max(b.nextOrdinal || 1, maxOrd + 1), entries };
    } catch {
      return { version: HRTF_PROFILES_VERSION, nextOrdinal: 1, entries: [] };
    }
  }

  private writeBlob(b: ProfilesBlob) {
    this.store.writeRaw(HRTF_PROFILES_KEY, JSON.stringify(b));
  }

  /** All profiles, newest-last by ordinal (reserved "last-best" always sorts FIRST). */
  list(): HrtfProfileEntry[] {
    const es = [...this.read().entries];
    es.sort((a, b) => {
      if (a.reserved !== b.reserved) return a.reserved ? -1 : 1;
      return a.ordinal - b.ordinal;
    });
    return es;
  }

  get(id: string): HrtfProfileEntry | null {
    return this.read().entries.find((e) => e.id === id) ?? null;
  }

  /** Save a NEW user profile snapshot; returns the created entry. */
  save(name: string, tuning: ProfileTuning, sig: string): HrtfProfileEntry {
    const blob = this.read();
    const ordinal = blob.nextOrdinal;
    const entry: HrtfProfileEntry = {
      id: makeId(ordinal), name: name.trim() || `Profile ${ordinal}`, ordinal, tuning, sig,
    };
    blob.entries.push(entry);
    blob.nextOrdinal = ordinal + 1;
    this.writeBlob(blob);
    return entry;
  }

  /** Upsert the RESERVED "Last calibration (best)" profile (overwritten each calibration). */
  saveLastBest(tuning: ProfileTuning, sig: string): HrtfProfileEntry {
    const blob = this.read();
    const ordinal = blob.nextOrdinal;
    const entry: HrtfProfileEntry = {
      id: LAST_BEST_ID, name: LAST_BEST_NAME, ordinal, reserved: true, tuning, sig,
    };
    blob.entries = blob.entries.filter((e) => e.id !== LAST_BEST_ID);
    blob.entries.push(entry);
    blob.nextOrdinal = ordinal + 1;
    this.writeBlob(blob);
    return entry;
  }

  rename(id: string, name: string): boolean {
    const blob = this.read();
    const e = blob.entries.find((x) => x.id === id);
    if (!e) return false;
    e.name = name.trim() || e.name;
    this.writeBlob(blob);
    return true;
  }

  /** Delete a profile. The reserved last-best CAN be deleted but is auto-recreated on the
   *  next calibration, so callers may allow it; returns false if the id wasn't found. */
  delete(id: string): boolean {
    const blob = this.read();
    const before = blob.entries.length;
    blob.entries = blob.entries.filter((e) => e.id !== id);
    if (blob.entries.length === before) return false;
    this.writeBlob(blob);
    return true;
  }
}
