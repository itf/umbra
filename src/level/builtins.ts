/**
 * Loader-by-id for the bundled demo levels.
 *
 * The committed JSON files in `src/levels/` are imported through the manifest
 * (`src/levels/index.ts`). Here we validate each one with `isLevel` exactly
 * once (at module load) and expose two small, pure APIs:
 *
 *   - `builtinLevels()` → the picker's listing: `{ id, name, description }[]`.
 *   - `getBuiltin(id)`  → the validated `Level` for an id (or `undefined`).
 *
 * `?level=<id>` on the game page (src/main.ts) resolves through `getBuiltin`.
 * Validation is strict: a malformed demo JSON throws here at load time, which
 * the test-suite asserts against so CI catches it.
 */
import type { Level } from './schema';
import { isLevel } from './schema';
import { BUILTIN_MANIFEST } from '../levels';

export interface BuiltinInfo {
  id: string;
  name: string;
  description: string;
}

interface BuiltinRecord extends BuiltinInfo {
  level: Level;
}

/** Validate the manifest once. `isLevel` mutates-in to back-fill defaults. */
function buildRegistry(): Map<string, BuiltinRecord> {
  const map = new Map<string, BuiltinRecord>();
  for (const entry of BUILTIN_MANIFEST) {
    // Deep-clone so `isLevel`'s back-fill never mutates the shared JS module
    // object (Vite gives the same import instance to every caller).
    const data = JSON.parse(JSON.stringify(entry.json));
    if (!isLevel(data)) {
      throw new Error(`Bundled level "${entry.id}" is not a valid Level.`);
    }
    if (map.has(entry.id)) {
      throw new Error(`Duplicate bundled level id "${entry.id}".`);
    }
    map.set(entry.id, {
      id: entry.id,
      name: entry.name || data.name,
      description: entry.description,
      level: data,
    });
  }
  return map;
}

const REGISTRY = buildRegistry();

/** The bundled demo levels as picker-ready info (id + name + description). */
export function builtinLevels(): BuiltinInfo[] {
  return [...REGISTRY.values()].map(({ id, name, description }) => ({ id, name, description }));
}

/**
 * The validated `Level` for a builtin id, or `undefined` for an unknown id.
 * Returns a fresh clone each call so callers (and `loadLevel`) can't mutate the
 * shared registry copy.
 */
export function getBuiltin(id: string): Level | undefined {
  const rec = REGISTRY.get(id);
  if (!rec) return undefined;
  return JSON.parse(JSON.stringify(rec.level)) as Level;
}

/** Whether `id` names a bundled level. */
export function isBuiltinId(id: string): boolean {
  return REGISTRY.has(id);
}
