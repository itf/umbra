/**
 * Spatial-backend selection — a tiny pure function so it can be unit-tested without
 * a DOM/URL. The default is ALWAYS our own engine (`ours`): no regression for the
 * shipping build, and the Steam Audio path (which dynamically loads `three` + a 6 MB
 * WASM) only engages on an explicit opt-in.
 *
 * Toggle source: the `engine` URL param.
 *   ?engine=steam → Steam Audio backend
 *   ?engine=steam-sofa → Steam Audio + our SADIE SOFA HRTF (fork-only)
 *   ?engine=steam-path → Steam Audio + PATHING (directional diffraction, fork-only)
 *   ?engine=ours  → our engine (explicit)
 *   absent / anything else → our engine (default)
 */
export type SpatialBackendChoice = 'ours' | 'steam';

/** All `engine` param values that select the Steam backend. `steam-sofa` also turns on
 *  the SADIE SOFA HRTF; `steam-path` also turns on pathing/diffraction — both decided
 *  downstream (see `steamPathingPref` / `wantSofa` in main.ts). */
const STEAM_ENGINE_VALUES = new Set(['steam', 'steam-sofa', 'steam-path']);

/** Resolve the backend choice from a raw `engine` query-param value (or null). */
export function selectBackend(engineParam: string | null | undefined): SpatialBackendChoice {
  return engineParam != null && STEAM_ENGINE_VALUES.has(engineParam) ? 'steam' : 'ours';
}

/** Read the choice from a query string (e.g. `location.search`). */
export function selectBackendFromSearch(search: string): SpatialBackendChoice {
  const value = new URLSearchParams(search).get('engine');
  return selectBackend(value);
}
