/**
 * Companion-voice / narrative layer — PURE data + selection (no DOM, no audio).
 *
 * A lightweight characterful "guide" that frames objectives and reacts to game
 * events — the device the celebrated audio games (The Nightjar, A Blind Legend)
 * use for immersion, but accessibility-native (every line is spoken through the
 * existing ARIA live regions / Web Speech by the wiring in main.ts).
 *
 * This module owns ONLY the line catalog (keyed by mode + event) and the
 * selection/variety logic. It is deliberately deterministic and side-effect free
 * so it's trivially unit-testable: variety comes from a caller-supplied rotation
 * index/seed — never Date.now()/Math.random() in here. The DOM wiring, rate
 * limiting, prioritisation vs. critical cues, and the opt-in/remember preference
 * live in main.ts + companionStore.ts.
 */

/** The game modes a line can be keyed by (mirrors the level's goal/mode). */
export type CompanionMode = 'beacon' | 'absorber' | 'sonar' | 'stealth';

/**
 * The companion events. These are derived from the existing GameCallbacks in
 * main.ts (not 1:1 with them — e.g. `progress` only fires at distance
 * milestones, `heard` only in stealth), keeping the companion characterful
 * rather than chatty.
 */
export type CompanionEvent =
  | 'start' // level start — objective framing
  | 'progress' // a closing-distance milestone (NOT per step)
  | 'win' // arrival / success
  | 'caught' // a monster reached you
  | 'heard' // you made a noise loud enough to be heard (stealth)
  | 'stumble' // you stumbled / mis-stepped
  | 'absorberFound'; // (alias of win for absorber mode — kept distinct for flavour)

/** Optional context the selection can use (e.g. the progress band). */
export interface CompanionContext {
  /**
   * A coarse closeness band for `progress` lines: 0 = almost there, 1 = close,
   * 2 = getting closer, 3 = far. Mirrors main.ts's updateFootHints bands so the
   * companion and the status read-out agree about "how close".
   */
  band?: number;
  /**
   * Rotation seed for variety. When several lines exist for a (mode,event),
   * `seed mod N` selects one — so repeated fires rotate deterministically
   * instead of repeating. Callers pass a per-event call count (see main.ts).
   * Defaults to 0 (the first line) when omitted.
   */
  seed?: number;
}

/**
 * The line catalog. Each (mode → event → lines[]) entry holds SHORT, skippable
 * characterful lines. `progress` is special: it's an array-of-arrays indexed by
 * the closeness band (0..3) so "almost there" reads differently from "far".
 *
 * Lines are intentionally terse — the companion punctuates, it never monologues
 * over critical audio. A `null`/missing entry means "the companion has nothing
 * to say here" (the selection returns null), which is correct and common.
 */
interface ModeLines {
  start: string[];
  win: string[];
  caught?: string[];
  heard?: string[];
  stumble?: string[];
  /** Indexed by closeness band 0..3 (almost / close / closer / far). */
  progress?: string[][];
}

/** Shared lines that don't depend on the mode (fallbacks / generic flavour). */
const SHARED = {
  caught: [
    'It found you. Stop — breathe — and try again.',
    'Caught. Next time, make less noise.',
  ],
  stumble: [
    'Easy. Find your footing.',
    'Steady now.',
  ],
  heard: [
    'Careful — it heard you.',
    'It turned toward you. Freeze.',
  ],
};

const CATALOG: Record<CompanionMode, ModeLines> = {
  beacon: {
    start: [
      'Listen — the beacon is calling. Walk toward it.',
      'Follow the sound ahead. I am with you.',
    ],
    progress: [
      ['Almost on it. One more push.', 'There — right in front of you.'],
      ['Close now. Stay with the sound.', 'Nearly there. Keep going.'],
      ['Good — it is getting louder. This way.', 'You are closing in.'],
      ['It is faint and far. Trust your ears.', 'A long way yet. Take your time.'],
    ],
    win: [
      'You made it. Well done.',
      'There you are — the beacon is yours.',
    ],
  },
  absorber: {
    start: [
      'No beacon this time. Clap, and find the silence that swallows it.',
      'Listen for the dead spot — where the room goes quiet.',
    ],
    progress: [
      ['The echo is dying here. You are on it.', 'Almost — the room has gone hush.'],
      ['Quieter this way. Keep listening.', 'The echo thins. Follow it down.'],
      ['Somewhere here the sound is eaten. Hunt for it.', 'Clap again — feel where it goes flat.'],
      ['The room still rings. The silence is elsewhere.', 'Far from the dead spot yet.'],
    ],
    win: [
      'There — the silence. You found the absorber.',
      'The echo is gone. That is the spot.',
    ],
  },
  sonar: {
    start: [
      'Your claps are few. Spend each one like it matters.',
      'Sonar is limited here. Listen hard between probes.',
    ],
    progress: [
      ['Almost there — you read the room well.', 'On it. Nicely judged.'],
      ['Closing in. Your claps are paying off.', 'Close now. Trust what you heard.'],
      ['Getting warmer. Picture the room.', 'You are reading it right.'],
      ['Still far. Save a clap for later.', 'A way to go. Probe wisely.'],
    ],
    win: [
      'Found it — and with claps to spare.',
      'There. You earned that one.',
    ],
  },
  stealth: {
    start: [
      'Something hunts the noise you make. Tread softly to the exit.',
      'Stay quiet. It listens for your every step.',
    ],
    progress: [
      ['The way out is close. Quietly now.', 'Almost free. Do not rush it.'],
      ['The exit is near. Keep low and slow.', 'Close to escape. Hold your nerve.'],
      ['You are making ground. Stay soft.', 'Closer to the exit. Mind the loud floors.'],
      ['The exit is far. Pick a quiet path.', 'A long way to go. Avoid the gravel.'],
    ],
    win: [
      'You slipped out. It never knew.',
      'Free — and silent to the last. Well done.',
    ],
  },
};

/** Pick from a non-empty list by a rotation seed (deterministic variety). */
function rotate(lines: string[], seed = 0): string {
  const n = lines.length;
  // Non-negative modulo so a negative/large seed still indexes safely.
  const i = ((seed % n) + n) % n;
  return lines[i];
}

/**
 * The pure selection function: given a mode, an event, and optional context,
 * return ONE short companion line — or `null` when the companion has nothing to
 * say (a valid, common outcome the wiring treats as "stay silent").
 *
 * Variety: when several lines exist, `context.seed` rotates among them
 * deterministically (no RNG/clock here — the caller supplies the seed).
 */
export function companionLine(
  mode: CompanionMode,
  event: CompanionEvent,
  context: CompanionContext = {},
): string | null {
  const m = CATALOG[mode];
  if (!m) return null;
  const seed = context.seed ?? 0;

  switch (event) {
    case 'start':
      return rotate(m.start, seed);
    case 'win':
    case 'absorberFound':
      return rotate(m.win, seed);
    case 'caught':
      return rotate(m.caught ?? SHARED.caught, seed);
    case 'heard':
      // Only meaningful in stealth (the only mode with monsters that "hear"),
      // but allow any mode a shared urgent line if it ever fires.
      return rotate(m.heard ?? SHARED.heard, seed);
    case 'stumble':
      return rotate(m.stumble ?? SHARED.stumble, seed);
    case 'progress': {
      const bands = m.progress;
      if (!bands) return null;
      const band = context.band ?? 3;
      // Clamp the band into range; unknown bands fall back to "far".
      const row = bands[Math.max(0, Math.min(bands.length - 1, band))];
      if (!row || row.length === 0) return null;
      return rotate(row, seed);
    }
    default:
      return null;
  }
}

/**
 * Map a GameLevel goal/clap-budget to a CompanionMode, mirroring main.ts's
 * `currentPrimerMode` but always returning a mode (plain levels ⇒ 'beacon').
 * Kept here so the mode classification is shared + unit-tested.
 */
export function modeForLevel(level: {
  goal?: 'beacon' | 'absorber' | 'escape';
  clapBudget?: number;
}): CompanionMode {
  if (level.goal === 'escape') return 'stealth';
  if (level.goal === 'absorber') return 'absorber';
  if (level.clapBudget != null) return 'sonar';
  return 'beacon';
}
