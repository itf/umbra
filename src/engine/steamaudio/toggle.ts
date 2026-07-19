/**
 * Spatial-backend selection — tiny pure functions so they can be unit-tested without
 * a DOM/URL. `selectBackend` maps an explicit `?engine=` param (absent → `ours`);
 * `preferredBackend` adds the no-preference DEFAULT: high-fidelity (Steam). The
 * Steam path dynamically loads `three` + a 6 MB WASM; on any init failure the
 * caller falls back to our engine (see buildSteamBackend in main.ts).
 *
 * Toggle source: the `engine` URL param.
 *   ?engine=steam → Steam Audio backend (pathing/diffraction ON by default)
 *   ?engine=steam-sofa → Steam Audio + our SADIE SOFA HRTF (fork-only)
 *   ?engine=steam-path → Steam Audio, pathing forced ON (A/B)
 *   ?engine=steam-nopath → Steam Audio, pathing forced OFF (A/B)
 *   ?engine=ours  → our engine (explicit)
 *   absent / anything else → our engine (default)
 */
export type SpatialBackendChoice = 'ours' | 'steam';

/** All `engine` param values that select the Steam backend. `steam-sofa` also turns on
 *  the SADIE SOFA HRTF; pathing is ON by default and toggled via `steam-path` /
 *  `steam-nopath` — all decided downstream (see `wantPathing` / `wantSofa` in main.ts). */
const STEAM_ENGINE_VALUES = new Set(['steam', 'steam-sofa', 'steam-path', 'steam-nopath']);

/** Resolve the backend choice from a raw `engine` query-param value (or null). */
export function selectBackend(engineParam: string | null | undefined): SpatialBackendChoice {
  return engineParam != null && STEAM_ENGINE_VALUES.has(engineParam) ? 'steam' : 'ours';
}

/** Read the choice from a query string (e.g. `location.search`). */
export function selectBackendFromSearch(search: string): SpatialBackendChoice {
  const value = new URLSearchParams(search).get('engine');
  return selectBackend(value);
}

/**
 * Default backend when the user has expressed NO preference (no saved Settings
 * choice): an explicit `?engine=...` param wins; otherwise HIGH-FIDELITY (Steam).
 * Cross-origin isolation is NOT required — the vendored WASM is single-threaded and
 * degrades from its SharedArrayBuffer control channel to postMessage when
 * `crossOriginIsolated` is false (see backend.ts) — so the default holds on plain
 * static hosts (e.g. GitHub Pages) too.
 */
export function preferredBackend(search: string): SpatialBackendChoice {
  const value = new URLSearchParams(search).get('engine');
  if (value != null) return selectBackend(value);
  return 'steam';
}
