# Level editor

A top-down 2D map editor (`editor.html` + `src/editor/*`) that authors a `Level`
(`src/level/schema.ts`) the game loads. Everything is on the x/z plane in metres;
heights/materials are edited numerically. Levels save to IndexedDB by name and
export/import as JSON (`src/level/storage.ts`); **Play** writes a "current" copy to
`localStorage` that `/?level=current` reads.

The editor exposes **every field the schema supports**. This doc is the full surface.

## Layout

- **Topbar** — level name, New / Save / load-saved dropdown / Delete, Export JSON /
  Import JSON, ▶ Play.
- **Palette (left)** — tool buttons, the new-object material, the Room panel, and the
  Selection (properties) panel for whatever is selected.
- **Canvas (centre)** — the map; a status bar shows cursor coords + a hint.

## Tools

| Tool | Action |
|------|--------|
| Select / Move | Click an object to select; drag to move it. Delete/Backspace removes the selection (when the canvas is focused). |
| Start point | Click to (re)place the player start. |
| Beacon | Click to drop a goal beacon. |
| Wall | Drag to draw an interior wall segment a→b. |
| Floor zone | Drag a rectangle: a floor-material patch. |
| Ceiling zone | Drag a rectangle: a low-ceiling alcove. |
| Monster | Click to place a monster. |

The **Material** dropdown sets the material assigned to newly drawn walls / floor
zones / ceiling zones.

## Room panel (level-wide fields)

All of `Level`'s room/global fields are editable here:

- **Open space (no walls)** — `level.open`. Turning it on also clears `hasCeiling`
  (an open level is a street/field: no perimeter, ceiling, or floor box; the room
  dims just bound the canvas and set free-standing wall height).
- **Width / Depth / Height** — `level.room.{width,depth,height}`.
- **Wall material** — `level.roomMaterial` (the perimeter wall default).
- **Floor material** — `level.floorMaterial`.
- **Ceiling** checkbox — `level.hasCeiling`.
- **Ceiling height** — the default ceiling height (`level.room.height`).
- **Ceiling material** — `level.ceilingMaterial`.

(The three default-material dropdowns were the one schema gap and are now wired.)

## Selection / properties panel

Fields shown depend on the selected object kind. Numeric fields write live; a
material dropdown writes the object's `material`.

- **Start** — `x`, `z`, `yaw°` (degrees ↔ radians).
- **Beacon** — `x`, `z`, `freq`, `goal r`, plus:
  - **sound** — preset dropdown (`tone | pulse | bell | musicbox | drip | hum`,
    from `beaconPresetNames()`), writes `BeaconObj.sound`.
  - **custom url** — `BeaconObj.soundUrl`; blank clears it.
  - **Preview sound** — plays the selected preset for ~2.5 s through a throwaway
    `AudioContext` (synth only; it does not fetch the custom URL).
- **Wall** — `ax, az, bx, bz`, material, plus **motion** (see below).
- **Floor zone** — `x, z, w, d`, material.
- **Ceiling zone** — `x, z, w, d`, `height`, material.
- **Monster** — `x, z`, `speed` (m/s), `sound` (label/id).

### Wall motion

A `motion` dropdown (`none | translate | slide`) authors `WallObj.motion`
(`src/editor/apply.ts` → `applyWallMotion`):

- **none** — removes the `motion` field entirely (a static wall; old levels stay
  byte-identical).
- **translate** — seeds `{ kind:'translate', dx:2, dz:0, period:4 }` and reveals
  **move dx**, **move dz**, **period s**. The whole segment ping-pongs along
  `(dx,dz)` over `period`.
- **slide** — seeds `{ kind:'slide', openFraction:1, period:4 }` and reveals
  **open frac** (clamped 0..1) and **period s**. Endpoint `b` retracts toward the
  fixed jamb `a`, opening up to `openFraction` of the length, then closes.

Picking a kind re-renders the panel so the right param fields show. See
[`engine/moving-walls.md`](engine/moving-walls.md) for the runtime/acoustics.

## Canvas cues (`src/editor/view.ts`)

Minimal but informative; selected objects highlight in `#ffd166`:

- **Floor zones** — translucent material-coloured rectangles.
- **Ceiling zones** — dashed cyan rectangles labelled `ceil <height>m`.
- **Room perimeter** — solid material-coloured box when enclosed, dashed grey bound
  when `open`.
- **Walls** — material-coloured segments. **Moving walls draw DASHED** with a pink
  motion cue: `translate` shows a travel **arrow** along `(dx,dz)` and a `⇄ <period>s`
  label; `slide` shows a `↔ door <period>s` label.
- **Beacons** — dot + goal-radius ring, labelled `♪ <freq>Hz <sound>` (or `file`
  when a `soundUrl` is set).
- **Monsters** — red dot labelled `☠ <sound>`.
- **Start** — green dot with a facing arrow and `START` label.

## Persistence & round-trip

The whole `Level` is serialized, so every field above (including optional
`wall.motion`, `beacon.sound`/`soundUrl`, monster props, ceiling zones, open toggle,
and the default materials) round-trips through Save/Load (IndexedDB) and Export/Import
(JSON) unchanged. `isLevel()` back-fills fields added after older levels were saved.

## Tests

`tests/editor.test.ts` (pure, no DOM):

- `applyWallMotion` seeds translate/slide defaults, clears to `none` (removing the
  key), edits params, clamps `openFraction`, ignores cross-kind/non-positive/non-motion
  keys.
- A level built with **every feature** (moving translate + slide walls, beacon preset
  + custom url, monster, ceiling zone, open toggle, all default materials) survives a
  JSON export/import with **deep equality**.
- A wall set-then-cleared has no `motion` key after round-trip.

DOM wiring (pointer handlers, `renderProps`) is integration-noted; the testable
mutation logic is extracted into `src/editor/apply.ts`. `npm test` and
`npx tsc --noEmit` (for editor files) are green.
