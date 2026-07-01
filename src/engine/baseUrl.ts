/**
 * BASE_URL-aware runtime asset URLs. The app is deployed under a sub-path
 * (e.g. https://ivanaf.com/umbra/), so root-absolute URLs like
 * '/assets/hrtf/sadie_h3.hrtf' 404 there — they must resolve under Vite's
 * `base` (import.meta.env.BASE_URL) instead. Every runtime fetch of a file in
 * assets/ or public/ should go through assetUrl(). Mirrors the BASE_URL
 * handling already in src/game/clicksManifest.ts and src/ui/router.ts.
 */

/** Vite BASE_URL normalized to end with exactly one '/'. '/' in dev. */
export function baseUrl(): string {
  const raw =
    (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  return raw.replace(/\/?$/, '/');
}

/** Resolve a base-relative path ('assets/hrtf/x.hrtf') under BASE_URL. */
export function assetUrl(path: string): string {
  return baseUrl() + path.replace(/^\//, '');
}
