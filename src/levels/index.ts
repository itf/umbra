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
import clapMaze from './clap-maze.json';
import findTheOpening from './find-the-opening.json';
import cathedral from './cathedral.json';
import slowSoundVault from './slow-sound-vault.json';
import findTheFoam from './find-the-foam.json';
import sonarVault from './sonar-vault.json';
import stealthEscape from './stealth-escape.json';
// Cycle-6A level pack — a short difficulty arc per mode.
import beaconMeadow from './beacon-meadow.json';
import beaconWarren from './beacon-warren.json';
import shiftingVault from './shifting-vault.json';
import foamCathedral from './foam-cathedral.json';
import twoDeadSpots from './two-dead-spots.json';
import glassGalleryFoam from './glass-gallery-foam.json';
import sonarTight from './sonar-tight.json';
import sonarLabyrinth from './sonar-labyrinth.json';
import stealthTwinWardens from './stealth-twin-wardens.json';
import stealthChokepoint from './stealth-chokepoint.json';

/**
 * Coarse grouping used by the picker to list levels under mode/showcase
 * headings. `showcase` = the original acoustics-tour levels; the four mode
 * categories cluster each game mode's difficulty arc.
 */
export type BuiltinCategory = 'showcase' | 'beacon' | 'absorber' | 'sonar' | 'stealth';

export interface BuiltinEntry {
  id: string;
  /** Display name (falls back to the JSON's own `name`). */
  name: string;
  /** One-line description of the feature this demo showcases. */
  description: string;
  /** Coarse mode/showcase grouping for the picker. Absent ⇒ 'showcase'. */
  category?: BuiltinCategory;
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
    category: 'stealth',
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
  {
    id: 'clap-maze',
    name: 'Clap-Maze',
    description: 'A serpentine brick maze navigated by echo, with a tight clap budget — probe deliberately at each junction to find where the echo isn’t.',
    category: 'sonar',
    json: clapMaze,
  },
  {
    id: 'find-the-opening',
    name: 'Find the Opening',
    description: 'A narrow concrete corridor blocked by a wall with a single off-centre doorway. Clap — and listen to your own FOOTSTEPS echo down the corridor and through the gap — to find the opening, then walk through to the faint drip beyond.',
    json: findTheOpening,
  },
  {
    id: 'cathedral',
    name: 'Cathedral',
    description: 'A vast marble nave with stone columns and an 18 m vaulted ceiling — the FDN late-reverb tail gives a long, grand decay. Walk to the bell.',
    json: cathedral,
  },
  {
    id: 'slow-sound-vault',
    name: 'Slow-Sound Vault',
    description: 'Alien physics: sound travels at 150 m/s, so echoes lag, the beacon arrives late and Dopplers hard. A small concrete vault to feel the slowed speed of sound.',
    json: slowSoundVault,
  },
  {
    id: 'find-the-foam',
    name: 'Find the Foam',
    description: 'Echolocation hunt: clap in a bright concrete room and listen for the DEAD SPOT where a foam patch swallows the echo. Walk to that wall to win — no beacon.',
    category: 'absorber',
    json: findTheFoam,
  },
  {
    id: 'sonar-vault',
    name: 'Sonar Vault',
    description: 'Sonar-budget survival: a serpentine concrete-and-brick vault with only 6 claps and a long cooldown. Probe at each junction, then navigate from memory to the bell — running out of claps is spoken, not fatal.',
    category: 'sonar',
    json: sonarVault,
  },
  {
    id: 'stealth-escape',
    name: 'Stealth Escape',
    description: 'Slip past a noise-hunting monster to the exit. Tread the quiet carpet corridor (not the loud gravel), and press T to throw a sound decoy that lures the monster away. Being heard or caught is spoken.',
    category: 'stealth',
    json: stealthEscape,
  },

  // ===========================================================================
  // Cycle-6A level pack — a short, legible difficulty arc per mode. Grouped by
  // mode (easy → hard within each) so a player can find "more <mode> levels".
  // ===========================================================================

  // --- BEACON: open → occluded maze → moving-wall / slow-sound twist ---
  {
    id: 'beacon-meadow',
    name: 'Beacon Meadow',
    description: 'EASY beacon. A warm, open wood-panelled room with a music-box beacon dead ahead — a gentle first walk to learn the homing cue.',
    category: 'beacon',
    json: beaconMeadow,
  },
  {
    id: 'beacon-warren',
    name: 'Beacon Warren',
    description: 'MEDIUM beacon. A brick warren of three offset baffles occludes a dripping beacon — weave the serpentine, following the sound as it muffles and clears.',
    category: 'beacon',
    json: beaconWarren,
  },
  {
    id: 'shifting-vault',
    name: 'Shifting Vault',
    description: 'HARD beacon. A bright marble vault where sound crawls at 220 m/s, so the bell arrives late and a sliding sheet-metal wall keeps re-shaping the echoes — trust the lagging beacon.',
    category: 'beacon',
    json: shiftingVault,
  },

  // --- ABSORBER: subtle big room → pick-the-deadest → bright-room contrast ---
  {
    id: 'foam-cathedral',
    name: 'Foam in the Cathedral',
    description: 'HARD absorber. A vast 9 m marble cathedral rings for a long time; one small rock-wool panel barely dents that tail — hunt the faint, subtle dead spot.',
    category: 'absorber',
    json: foamCathedral,
  },
  {
    id: 'two-dead-spots',
    name: 'The Deadest Spot',
    description: 'MEDIUM absorber. A live ceramic room with TWO soft patches — a velvet drape and a dead rock-wool panel. Clap both walls and walk to the DEADER one to win.',
    category: 'absorber',
    json: twoDeadSpots,
  },
  {
    id: 'glass-gallery-foam',
    name: 'The Glass Gallery',
    description: 'EASY absorber. A brilliant, ringing glass gallery where a fibreglass panel kills the echo hard — the brightest room makes the dead spot the easiest to hear.',
    category: 'absorber',
    json: glassGalleryFoam,
  },

  // --- SONAR-BUDGET: tight & few claps → long with a patient cooldown ---
  {
    id: 'sonar-tight',
    name: 'Four Claps',
    description: 'MEDIUM sonar. A compact two-baffle vault with only FOUR claps — spend each probe at a junction, then commit to the bell from memory.',
    category: 'sonar',
    json: sonarTight,
  },
  {
    id: 'sonar-labyrinth',
    name: 'The Patient Labyrinth',
    description: 'HARD sonar. A long four-turn stone labyrinth, eight claps but a 3.5 s cooldown — patience is the resource; probe, walk, wait, probe again.',
    category: 'sonar',
    json: sonarLabyrinth,
  },

  // --- STEALTH: two wardens (long quiet route) → decoy chokepoint ---
  {
    id: 'stealth-twin-wardens',
    name: 'Twin Wardens',
    description: 'HARD stealth. TWO noise-hunters patrol the loud gravel; a long silent foam corridor hugs the left wall — keep to the quiet and they never hear you pass.',
    category: 'stealth',
    json: stealthTwinWardens,
  },
  {
    id: 'stealth-chokepoint',
    name: 'The Chokepoint',
    description: 'HARD stealth. A single warden sits squarely in the only gateway. Throw a decoy (T) to one side to lure it off the gap, then slip through on the quiet spine.',
    category: 'stealth',
    json: stealthChokepoint,
  },
];
