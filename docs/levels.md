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

## The demo levels and what each showcases

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

The size pair has a large volume spread (52 m³ vs 3456 m³); the test-suite
enforces a ≥4× spread.

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
