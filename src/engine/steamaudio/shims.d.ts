/**
 * Ambient module shims for the Steam Audio path. Both `three` and
 * `three-steam-audio` are only reached through a dynamic import on the `?engine=steam`
 * path and are used via `any` (the backend wraps them loosely). We don't ship
 * `@types/three`, so declare these as untyped modules to keep `tsc --noEmit` clean
 * without pulling type packages into the default build.
 */
declare module 'three';
declare module 'three-steam-audio';
