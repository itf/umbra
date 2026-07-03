/**
 * Compact, shareable "head response" profile code — encode/decode the 5 warp scalars
 * + the chosen base head into a short URL-safe string so a user can carry their
 * calibration to another device or hand it to a friend ("load my head response").
 *
 * Format (versioned): "U1." + base64url(JSON({b, p})) where b = base id and p is the
 * clamped params. Kept tiny (a handful of numbers) so it pastes easily. Pure — no DOM,
 * no storage. Unit-tested in tests/hrtfProfileCode.test.ts.
 */
import {
  clampPersonalization,
  NEUTRAL_PERSONALIZATION,
  type HrtfPersonalization,
} from '../engine/hrtf/personalize';

const PREFIX = 'U1.';

export interface HrtfProfile {
  base: string;
  params: HrtfPersonalization;
}

/** base64url (no padding) of a UTF-8 string, working in browser or node. */
function b64urlEncode(s: string): string {
  const b64 = typeof btoa !== 'undefined'
    ? btoa(unescape(encodeURIComponent(s)))
    : Buffer.from(s, 'utf-8').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = typeof atob !== 'undefined'
    ? atob(b64)
    : Buffer.from(b64, 'base64').toString('binary');
  // Reverse the UTF-8 escaping used on encode.
  try {
    return decodeURIComponent(escape(bin));
  } catch {
    return bin;
  }
}

/** Encode a profile to a share code. Params are clamped so a code is always sane, and
 *  fields left at their NEUTRAL value are DROPPED (decode merges over NEUTRAL) so the code
 *  stays compact and adding new neutral-by-default params doesn't bloat existing codes. */
export function encodeProfile(profile: HrtfProfile): string {
  const clamped = clampPersonalization(profile.params) as unknown as Record<string, unknown>;
  const neutral = NEUTRAL_PERSONALIZATION as unknown as Record<string, unknown>;
  const p: Record<string, unknown> = {};
  for (const key of Object.keys(clamped)) {
    const v = clamped[key];
    // Keep non-neutral scalars and any non-empty pcaWeights; drop exact-neutral scalars.
    if (Array.isArray(v)) { if (v.some((x) => x !== 0)) p[key] = v; }
    else if (v !== neutral[key]) p[key] = v;
  }
  return PREFIX + b64urlEncode(JSON.stringify({ b: profile.base, p }));
}

/**
 * Decode a share code back to a profile, or null if it's malformed / wrong version.
 * Params are merged over NEUTRAL (so a code from before a field existed still loads)
 * and clamped. The base falls back to the caller's default if missing.
 */
export function decodeProfile(code: string, defaultBase = 'sadie_h3'): HrtfProfile | null {
  const shared = decodeSharedProfile(code, defaultBase);
  return shared ? { base: shared.base, params: shared.params } : null;
}

// ---- SHAREABLE PROFILE (v2): name + comp strength + schema signature ------------------
// A full tuning snapshot for sharing across devices / with friends. Superset of the v1
// params code: adds the profile NAME, the over-ear COMP strength, and the schema SIGNATURE
// (BASE_HRTFS ids + PCA layout) so the importer can refuse to silently apply a snapshot from
// an incompatible head-set / PC layout. Format: "U2." + base64url(JSON({b,p,c,n,s})).
// Round-trip is lossless. Tuning-only numbers → nothing sensitive ever goes in a URL.
const SHARE_PREFIX = 'U2.';

export interface SharedProfile {
  base: string;
  params: HrtfPersonalization;
  compStrength: number;
  name: string;
  /** Schema signature at export (empty when the exporter didn't know it). */
  sig: string;
}

/** Encode a full shareable profile to a compact base64url code (drops neutral params). */
export function encodeSharedProfile(sp: SharedProfile): string {
  const clamped = clampPersonalization(sp.params) as unknown as Record<string, unknown>;
  const neutral = NEUTRAL_PERSONALIZATION as unknown as Record<string, unknown>;
  const p: Record<string, unknown> = {};
  for (const key of Object.keys(clamped)) {
    const v = clamped[key];
    if (Array.isArray(v)) { if (v.some((x) => x !== 0)) p[key] = v; }
    else if (v !== neutral[key]) p[key] = v;
  }
  const payload = { b: sp.base, p, c: clamp01(sp.compStrength), n: sp.name, s: sp.sig };
  return SHARE_PREFIX + b64urlEncode(JSON.stringify(payload));
}

/** Decode a U2 (or legacy U1) code into a full SharedProfile, or null if malformed. */
export function decodeSharedProfile(code: string, defaultBase = 'sadie_h3'): SharedProfile | null {
  const trimmed = code.trim();
  try {
    if (trimmed.startsWith(SHARE_PREFIX)) {
      const obj = JSON.parse(b64urlDecode(trimmed.slice(SHARE_PREFIX.length))) as {
        b?: unknown; p?: unknown; c?: unknown; n?: unknown; s?: unknown;
      };
      if (!obj || typeof obj !== 'object' || !obj.p || typeof obj.p !== 'object') return null;
      return {
        base: typeof obj.b === 'string' && obj.b ? obj.b : defaultBase,
        params: clampPersonalization({ ...NEUTRAL_PERSONALIZATION, ...(obj.p as Partial<HrtfPersonalization>) }),
        compStrength: clamp01(Number(obj.c)),
        name: typeof obj.n === 'string' && obj.n ? obj.n : 'Shared profile',
        sig: typeof obj.s === 'string' ? obj.s : '',
      };
    }
    if (trimmed.startsWith(PREFIX)) {
      // Legacy v1 params-only code: no name/comp/sig.
      const obj = JSON.parse(b64urlDecode(trimmed.slice(PREFIX.length))) as { b?: unknown; p?: unknown };
      if (!obj || typeof obj !== 'object' || !obj.p || typeof obj.p !== 'object') return null;
      return {
        base: typeof obj.b === 'string' && obj.b ? obj.b : defaultBase,
        params: clampPersonalization({ ...NEUTRAL_PERSONALIZATION, ...(obj.p as Partial<HrtfPersonalization>) }),
        compStrength: 0,
        name: 'Shared profile',
        sig: '',
      };
    }
  } catch {
    return null;
  }
  return null;
}

/** The URL query param a shared profile rides in (hash-based, router-consistent). */
export const SHARE_URL_PARAM = 'hp';

/** Build a shareable URL for a profile. `baseUrl` defaults to the current location's origin+
 *  path (minus any existing hash). The code goes in the HASH query so it survives static
 *  hosting + the app's hash router, and never hits a server log as a path. */
export function encodeSharedProfileUrl(sp: SharedProfile, baseUrl?: string): string {
  const code = encodeSharedProfile(sp);
  const root = baseUrl ?? currentRoot();
  // Hash form: <root>#/?hp=<code> — the app reads location.hash on load.
  return `${root}#/?${SHARE_URL_PARAM}=${encodeURIComponent(code)}`;
}

/** Extract a shared profile from a URL (or a raw location.hash / search string), else null. */
export function decodeSharedProfileUrl(url: string, defaultBase = 'sadie_h3'): SharedProfile | null {
  // Pull the hp=<code> param from anywhere in the string (hash or query).
  const m = url.match(new RegExp(`[?&#]${SHARE_URL_PARAM}=([^&#]+)`));
  if (!m) return null;
  let code: string;
  try { code = decodeURIComponent(m[1]); } catch { code = m[1]; }
  return decodeSharedProfile(code, defaultBase);
}

function currentRoot(): string {
  try {
    if (typeof location !== 'undefined') {
      return location.origin + location.pathname + location.search;
    }
  } catch { /* no location */ }
  return '';
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}
