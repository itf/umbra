/**
 * Bundled demo-level manifest. Each entry pairs a stable `id` (used in
 * `?level=<id>` and the picker) with its committed JSON and a one-line
 * `description` shown in the picker. This is the single source of truth that
 * drives both the loader-by-id (`src/level/builtins.ts`) and the level picker
 * (`src/ui/levelPicker.ts`).
 *
 * Adding a builtin: drop a `foo.json` in this directory (a valid `Level` that
 * passes `isLevel`), import it here, and append an entry below. The loader
 * validates every entry at module load, and the test-suite loops over all
 * builtins through `isLevel` + `loadLevel`, so a malformed demo fails CI.
 */
import smallConcrete from './small-concrete-room.json';
import largeHall from './large-concrete-hall.json';
import carpeted from './carpeted-room.json';
import glassTile from './glass-tile-room.json';
import slidingDoor from './sliding-door.json';
import beaconGarden from './beacon-garden.json';
import monsterCellar from './monster-cellar.json';
import openStreet from './open-street.json';
import steppedCeiling from './stepped-ceiling-alcove.json';
import sBendMaze from './s-bend-maze.json';

export interface BuiltinEntry {
  id: string;
  /** Display name (falls back to the JSON's own `name`). */
  name: string;
  /** One-line description of the feature this demo showcases. */
  description: string;
  /** The raw level JSON (validated by the loader, not here). */
  json: unknown;
}

/**
 * The ordered manifest. `json` is typed `unknown` on purpose: the JSON imports
 * are plain data and only become a `Level` after `isLevel` validation in the
 * loader, so we don't pretend they're already typed here.
 */
export const BUILTIN_MANIFEST: BuiltinEntry[] = [
  {
    id: 'small-concrete-room',
    name: 'Small Concrete Cell',
    description: 'A tiny, bright concrete room — short, tight echo. The small half of the size-contrast pair.',
    json: smallConcrete,
  },
  {
    id: 'large-concrete-hall',
    name: 'Large Concrete Hall',
    description: 'A cavernous concrete hall — long, booming echo. The large half of the size-contrast pair.',
    json: largeHall,
  },
  {
    id: 'carpeted-room',
    name: 'Carpeted Lounge (Dead)',
    description: 'Carpet, curtains and foam swallow the sound — a soft, dead room. Material contrast vs the tiled room.',
    json: carpeted,
  },
  {
    id: 'glass-tile-room',
    name: 'Tiled Bathhouse (Live)',
    description: 'Hard tile and glass — a bright, ringing, very live room. Material contrast vs the carpeted room.',
    json: glassTile,
  },
  {
    id: 'sliding-door',
    name: 'The Sliding Door',
    description: 'A wall with a sliding door you hear open and close (moving-wall acoustics) — pass when it opens.',
    json: slidingDoor,
  },
  {
    id: 'beacon-garden',
    name: 'Beacon Garden',
    description: 'Four beacons with different voices — bell, music box, drip and hum — to compare beacon presets.',
    json: beaconGarden,
  },
  {
    id: 'monster-cellar',
    name: 'Monster Cellar',
    description: 'A monster hunts your noise. Loud gravel vs quiet carpet patches make stealth matter.',
    json: monsterCellar,
  },
  {
    id: 'open-street',
    name: 'Open Street',
    description: 'An open outdoor space (no room, no ceiling) with free-standing buildings and a barrier wall — the beacon diffracts around the barrier.',
    json: openStreet,
  },
  {
    id: 'stepped-ceiling-alcove',
    name: 'Cathedral Alcove',
    description: 'A tall marble nave with a low-ceilinged wooden alcove — hear the ceiling drop as you enter.',
    json: steppedCeiling,
  },
  {
    id: 's-bend-maze',
    name: 'S-Bend Maze',
    description: 'Two walls to weave past: go right around the first, then left around the second, to reach the bell.',
    json: sBendMaze,
  },
];
