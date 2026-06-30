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
- **Palette (left)** — tool buttons, the new-object material, the Room panel, the
  Selection (properties) panel for whatever is selected, and the Objects outline.
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
| Ambient source | Click to place a continuous ambient sound (fountain, AC hum, etc.). |
| Win area | Click to place the win point (`winPoint`). Set the radius in the panel. Works with zero beacons. |
| Material patch | Click near a perimeter wall to place a `WallPatch` (absorber or other material). The tool places the patch on the nearest face; drag in the panel to adjust position. |

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
- **Clutter** — `level.clutter` (0..1). Acoustic object density. Empty / 0 means a
  bare room (field omitted).
- **Required reactions** — `level.requiredReactions`. Integer gate: the player must
  press **R** inside this many reaction events before the win condition unlocks.
  Empty / 0 means no gate (field omitted).

(The three default-material dropdowns were the one schema gap and are now wired.)

## Selection / properties panel

The panel opens with a **kind heading** announcing WHAT is selected — "Start point",
"Beacon", "Wall", "Floor zone", "Ceiling zone", "Monster", "Ambient source",
"Win area", or "Material patch" — plus the object's `id` (everything except
the singleton Start). Headings/labels come from `kindLabel()` in
`src/editor/objectList.ts`.

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
- **Monster** — `x, z`, `speed` (m/s), and **sound** — a preset dropdown
  (`growl | hum`) sourced from `MONSTER_PRESETS` in `src/game/monsterSounds.ts`
  (not hardcoded), defaulting via `resolveMonsterPreset` and writing `MonsterObj.sound`.
- **Ambient source** — `x`, `z`, `sound` (same preset list as beacons), `freq`,
  `gain` (clamped 0..2), `soundUrl` (blank clears). **Preview sound** plays the
  preset for ~2.5 s. The source is rendered as a blue dot on the canvas.
- **Win area** — `x`, `z`, `win radius` (metres). Sets `level.winPoint` and
  `level.winRadius`. Rendered as a dashed green ring. Works with zero beacons.
- **Material patch** — `wall` (face: `-x | +x | -z | +z`), `u0`, `v0`, `uSize`,
  `vSize` (in-plane rectangle on the perimeter face), `material`. The patch
  rectangle is clamped to the face extents so it can't go off-wall. Minimum
  dimension 0.1 m. Rendered as a coloured segment along the face.

## Objects outline

A collapsible **Objects** section in the palette lists every object in the scene,
labelled by kind + id (e.g. `Start`, `Beacon b1`, `Wall wall-1`, `Floor f2 (carpet)`,
`Ceiling c1 (wood)`, `Monster m1`, `Ambient a1`, `Win area`, `Patch p1`). Each row
is a real button: clicking it selects that object exactly as clicking it on the canvas
would — it sets `selectedId`, renders its properties, and highlights it on the map.
This makes tiny or overlapping objects reachable. The list is rebuilt on every render,
so it stays in sync as objects are added, removed, moved, or a level is loaded. The
flat model (`level → [{id, kind, label}]`) is built by `objectListModel()` in
`src/editor/objectList.ts`.

### Reaction events panel

A level-global **Reaction events** section in the Room panel (not tied to a selected
object) lists all `level.events`. **Add event** appends a default crossing event
(`type: 'crossing'`, 2.5 s window) referencing the first ambient source (or an
empty `sourceId` if none). Each event row exposes:

- **type** — `crossing` (ambient source is briefly occluded/muffled) or `door`
  (ambient source leaks louder through an opening).
- **source** — `sourceId`, must match an existing ambient source's `id`. The editor
  lint warns on dangling references.
- **start** / **end** — event window in seconds; `end` is kept > `start`.
- **Delete** — removes the event.

The **Required reactions** field in the Room panel sets `level.requiredReactions`
(how many events the player must react to before the win area unlocks).

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

### Lint warnings

On every save the editor runs `lintLevel()` (`src/editor/apply.ts`) and surfaces
any warnings in the `#hint` status bar (`role="status" aria-live="polite"`, so they
are announced to screen readers). Current checks:

- Goal `'absorber'` with no absorber patches.
- No beacons and no `winPoint` (level is unwinnable).
- A reaction event that references a non-existent ambient source id.
- A reaction event with a non-positive window (`end ≤ start`).
- `requiredReactions > events.length` (gate is impossible to satisfy).
- All sounds are silent (no beacon, no ambience, no win-condition feedback).

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
- **Ambient sources** — blue dot labelled with the source id and preset.
- **Win area** — dashed green ring at `winPoint` with `winRadius`.
- **Material patches** — coloured segment along the perimeter face, matching the
  patch material colour.
- **Start** — green dot with a facing arrow and `START` label.

## Persistence & round-trip

The whole `Level` is serialized, so every field above (including optional
`wall.motion`, `beacon.sound`/`soundUrl`, monster props, ceiling zones, open toggle,
the default materials, ambient sources, win area, wall patches, reaction events,
`clutter`, and `requiredReactions`) round-trips through Save/Load (IndexedDB) and
Export/Import (JSON) unchanged. `isLevel()` back-fills fields added after older
levels were saved.

## Tests

`tests/editor.test.ts` (pure, no DOM):

- `applyWallMotion` seeds translate/slide defaults, clears to `none` (removing the
  key), edits params, clamps `openFraction`, ignores cross-kind/non-positive/non-motion
  keys.
- `applyAbsorberProp` edits wall-face, material, and rectangle params; clamps
  minimum size to 0.1 m.
- `applyAmbienceProp` edits position, sound preset, freq, gain (0..2 clamp), and
  soundUrl (blank clears).
- `applyEventProp` edits type, sourceId, start/end (keeps end > start).
- `kindLabel` labels every selectable kind correctly (including ambient, win, patch).
- `objectListModel` lists Start first then every object with kind + id labels, and
  includes every object as more are added.
- Monster sound options come from `MONSTER_PRESETS` (`growl`/`hum`).
- `lintLevel` warns on: missing absorber patches, unwinnable level, dangling event
  source, non-positive event window, impossible required-reactions gate.
- A level built with **every feature** (moving translate + slide walls, beacon preset
  + custom url, monster, ceiling zone, open toggle, all default materials, ambient
  source, win area, wall patch, reaction event, clutter, requiredReactions) survives
  a JSON export/import with **deep equality**.
- A wall set-then-cleared has no `motion` key after round-trip.

DOM wiring (pointer handlers, `renderProps`) is integration-noted; the testable
mutation logic is extracted into `src/editor/apply.ts`. `npm test` and
`npx tsc --noEmit` (for editor files) are green.
