/**
 * Spatial-backend selection — a tiny pure function so it can be unit-tested without
 * a DOM/URL. The default is ALWAYS our own engine (`ours`): no regression for the
 * shipping build, and the Steam Audio path (which dynamically loads `three` + a 6 MB
 * WASM) only engages on an explicit opt-in.
 *
 * Toggle source: the `engine` URL param.
 *   ?engine=steam → Steam Audio backend
 *   ?engine=ours  → our engine (explicit)
 *   absent / anything else → our engine (default)
 */
export type SpatialBackendChoice = 'ours' | 'steam';

/** Resolve the backend choice from a raw `engine` query-param value (or null). */
export function selectBackend(engineParam: string | null | undefined): SpatialBackendChoice {
  return engineParam === 'steam' ? 'steam' : 'ours';
}

/** Read the choice from a query string (e.g. `location.search`). */
export function selectBackendFromSearch(search: string): SpatialBackendChoice {
  const value = new URLSearchParams(search).get('engine');
  return selectBackend(value);
}
