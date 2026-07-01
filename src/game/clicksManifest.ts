/**
 * Shared loader for the CC tongue-click recordings manifest
 * (public/audio/clicks/manifest.json). Cached module-level so the click-types page,
 * the probe chooser (Settings + trainer), and the credits screen all fetch it once.
 * BASE_URL-aware so it resolves under a deployed sub-path.
 */
import type { ClickManifestEntry } from './probeCatalog';

let cache: ClickManifestEntry[] | null = null;
let inflight: Promise<ClickManifestEntry[]> | null = null;

function baseUrl(): string {
  const raw = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  return raw.replace(/\/?$/, '/');
}

/** Fetch + cache the clicks manifest. Returns [] on any failure (never throws). */
export async function loadClicksManifest(): Promise<ClickManifestEntry[]> {
  if (cache) return cache;
  if (inflight) return inflight;
  inflight = fetch(`${baseUrl()}audio/clicks/manifest.json`)
    .then((r) => (r.ok ? r.json() : []))
    .then((j) => {
      cache = Array.isArray(j) ? (j as ClickManifestEntry[]) : [];
      return cache;
    })
    .catch(() => {
      cache = [];
      return cache;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** The cached manifest if already loaded, else null (synchronous peek). */
export function cachedClicksManifest(): ClickManifestEntry[] | null {
  return cache;
}
