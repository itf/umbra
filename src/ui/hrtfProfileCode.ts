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
  const trimmed = code.trim();
  if (!trimmed.startsWith(PREFIX)) return null;
  try {
    const json = b64urlDecode(trimmed.slice(PREFIX.length));
    const obj = JSON.parse(json) as { b?: unknown; p?: unknown };
    if (!obj || typeof obj !== 'object' || !obj.p || typeof obj.p !== 'object') return null;
    const params = clampPersonalization({
      ...NEUTRAL_PERSONALIZATION,
      ...(obj.p as Partial<HrtfPersonalization>),
    });
    const base = typeof obj.b === 'string' && obj.b ? obj.b : defaultBase;
    return { base, params };
  } catch {
    return null;
  }
}
