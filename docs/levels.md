# Bundled demo levels, the loader-by-id, and the picker

The game ships a curated set of **demo levels** as committed JSON, loadable by a
stable id and selectable from a **level picker** on the game's start screen. This
is how every player gets the same showcase content without first opening the
editor — and how a level can be linked to directly (`?level=<id>`).

## The pieces

```
src/levels/*.json        the committed Level JSON (one file per demo)
src/levels/index.ts      the manifest: id → { name, description, json }
src/level/builtins.ts    the loader-by-id (validates + exposes the demos)
src/ui/levelPicker.ts    the picker (pure model + thin DOM wiring)
src/main.ts              entry point: ?level routing + mounting the picker
index.html               #picker-screen / #start-screen markup
```

### JSON + manifest

Each `src/levels/*.json` is a full `Level` (see `src/level/schema.ts`) and must
pass `isLevel`. The manifest (`src/levels/index.ts`) imports each JSON (Vite's
`resolveJsonModule`) and pairs it with a stable `id` and a one-line
`description`:

```ts
export const BUILTIN_MANIFEST: BuiltinEntry[] = [
  { id: 'small-concrete-room', name: '…', description: '…', json: smallConcrete },
  …
];
```

The manifest is the single source of truth for both the loader and the picker.

### Loader-by-id (`src/level/builtins.ts`)

At module load it validates every manifest entry with `isLevel` (throwing on a
malformed demo) and exposes:

- `builtinLevels(): { id, name, description }[]` — the picker's listing.
- `getBuiltin(id): Level | undefined` — the validated level for an id (a fresh
  clone each call; unknown id → `undefined`).
- `isBuiltinId(id): boolean`.

### `?level=` routing (`src/main.ts`)

- `?level=current` — the editor's working level from `localStorage` (unchanged).
- `?level=<id>` — a bundled demo via `getBuiltin`.
- no `?level` (or an unknown id) — show the picker.

A preselected level jumps straight to the **Begin** screen; audio still waits for
the Begin user-gesture (browser autoplay requirement).

### The picker (`src/ui/levelPicker.ts`)

`buildPickerModel(builtins, savedNames)` is a **pure** merge (builtins first,
then saved levels) returning `PickerItem[]` — unit-tested without a DOM.
`renderLevelPicker()` is the thin wiring: a `<ul role="list">` of real
`<button>`s with descriptive `aria-label`s under `Demo levels` / `Your saved
levels` headings. Saved levels come from IndexedDB `listLevels()`; if IndexedDB
is unavailable the picker just shows the builtins.

Selecting an item loads the level (`getBuiltin` or `loadSavedLevel`) and reveals
the Begin screen.

## Schema: new level fields

These fields were added to the `Level` schema alongside the new levels and are
now authorable in the editor:

- **`ambience: AmbientSource[]`** — continuous, non-goal sound sources (fountain,
  AC hum, brown noise). Each has `id`, `x`, `z`, `sound`, `gain`, and optionally
  `freq`/`soundUrl`. Rendered spatially at their world position.
- **`events: ReactionEvent[]`** — time-windowed acoustic events that require a
  player reaction. Each event names a `sourceId` (must match an ambient source's
  `id`), a `type` (`'crossing'` | `'door'`), and a `start`/`end` time window (s).
- **`requiredReactions: number`** — minimum reactions the player must register
  (press **R** inside an event window) to unlock the win condition. Makes reaction
  levels possible without a beacon goal.
- **`winPoint: { x, z }` / `winRadius: number`** — a win area independent of
  beacons. The player wins by reaching within `winRadius` metres of `winPoint`
  (after satisfying any `requiredReactions` gate). Lets silent levels and reaction
  levels have a clear destination.
- **`clutter: number`** — a 0..1 per-level density for random-object clutter
  (acoustically scattering objects scattered through the room). Omitting or setting
  0 means a bare room.

## The demo levels and what each showcases

### Navigation / geometry

| id | Level | Showcases |
|----|-------|-----------|
| `small-concrete-room` | Small Concrete Cell | Small bright room — tight echo (small half of the size pair) |
| `large-concrete-hall` | Large Concrete Hall | Cavernous echo (large half of the size pair) |
| `carpeted-room` | Carpeted Lounge (Dead) | Soft, dead material set (carpet/curtain/foam) |
| `glass-tile-room` | Tiled Bathhouse (Live) | Hard, live material set (tile/glass) — contrast vs carpet |
| `sliding-door` | The Sliding Door | A wall with `motion: slide` you hear open/close (moving walls) |
| `beacon-garden` | Beacon Garden | Four beacon presets: bell, musicbox, drip, hum |
| `monster-cellar` | Monster Cellar | A monster chasing your noise; loud gravel vs quiet carpet zones |
| `open-street` | Open Street | `open: true` outdoor space + diffraction at building corners |
| `stepped-ceiling-alcove` | Cathedral Alcove | A low ceiling zone inside a tall marble nave |
| `s-bend-maze` | S-Bend Maze | Two interior walls to weave past — map a route by echo |
| `clap-maze` | Clap-Maze | Serpentine brick maze + a tight **clap budget** (`clapBudget`/`clapCooldownMs`) — navigate by echo, probe deliberately. See `docs/engine/clap-budget.md` |
| `cathedral` | Cathedral | A vast 22×46×18 m marble nave with stone columns — the FDN **late-reverb tail** (auto-derived from the big, hard geometry via Eyring RT60) gives a long, grand decay. Bell beacon. |
| `slow-sound-vault` | Slow-Sound Vault | **Alien physics**: `speedOfSound: 150` (m/s). Echoes lag, the beacon arrives late and Dopplers hard — feel the slowed speed of sound on both the clap and the live beacon. See `docs/engine/speed-of-sound.md` |

The size pair has a large volume spread (52 m³ vs 3456 m³); the test-suite
enforces a ≥4× spread.

### Silent levels (no beacon)

| id | Level | Showcases |
|----|-------|-----------|
| `find-the-door` | Find the Door | **No beacon, total silence.** A bare concrete corridor with one off-centre doorway in the right-hand wall. Navigate by clap echo and footstep reflections alone. Win area (`winPoint`/`winRadius`) is the region beyond the doorway — no goal sound. |

### Reaction levels (press R when you detect a change)

Reaction levels introduce **ambient sound sources** (`ambience`) and **reaction
events** (`events`). During each event window, the ambient source changes
acoustically (a crossing muffles it; a door opening brightens it). The player
presses **R** when they detect the change. Win requires reaching the `winPoint`
after registering at least `requiredReactions` reactions.

| id | Level | Showcases |
|----|-------|-----------|
| `fountain-crossing` | Fountain Crossing | A `fountain` ambient source ahead. Three crossing events (each 2.5 s) duck and muffle the water as a person passes between you and it — a faint swoosh. Press **R** each crossing. React to ≥2, then walk to the fountain. |
| `door-in-the-ac-corridor` | Door in the AC Corridor | A `brownnoise` AC source at the far end. Three door events (2.5 s each) make the AC leak louder and brighter while the door is open, with a click at open/close. Press **R** when you hear the door open. React to ≥2, then reach the far end. |

### Material clap-trainers (find the target wall by its echo character; category `absorber`)

These levels have **no beacon and no ambient source**. Win is a `winPoint` area in
front of the target wall section. The player must locate the target wall by its
echo timbre.

| id | Level | Showcases |
|----|-------|-----------|
| `find-the-carpet` | Find the Carpet Wall | EASY. One whole concrete wall is carpet — the dead side swallows high frequencies. Walk to the area in front of it. |
| `find-the-carpet-half` | Find the Half-Carpet Wall | MEDIUM. Only half of one wall is carpet — narrower dead spot to localise. |
| `find-the-hard-wall` | Find the Hard Wall | MEDIUM (inverted). Dead carpet room; ONE bright sheet-metal wall rings back. Hunt the live wall. |
| `find-the-metal-half` | Find the Half-Metal Wall | HARD. Acoustic-foam room; only half of one wall is sheet metal — the smallest live spot to pin down. |

## Adding a new builtin

1. Author `src/levels/my-level.json` (a valid `Level`; pick materials/feature so
   the thing you want is audible; keep it small/quick).
2. `import myLevel from './my-level.json';` in `src/levels/index.ts` and append a
   `{ id, name, description, json: myLevel }` entry.
3. Done — the loader validates it, the picker lists it, and the test-suite loops
   it through `isLevel` + `loadLevel`. A malformed JSON fails CI.

## How saved (IndexedDB) levels coexist

Saved levels live in per-browser IndexedDB (the editor's store) and are listed in
the picker under **Your saved levels**, below the bundled demos. They load via
`loadLevel(name)` from `src/level/storage.ts`. The two sources are namespaced in
the picker model (`builtin:<id>` vs `saved:<name>`) so they never collide.

## Tests

`tests/builtins.test.ts`:

- every builtin passes `isLevel` + `loadLevel`;
- `getBuiltin` round-trips ids, unknown → `undefined`, returns fresh clones;
- feature coverage: a moving wall, a monster, an open level, a non-tone beacon, a
  ceiling zone, and a large-vs-small volume pair all exist;
- the pure picker model orders/keys correctly.
