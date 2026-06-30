/**
 * Single source of truth for the keyboard control scheme.
 *
 * This is a PURE data module (no DOM, no audio) so every place that describes the
 * controls — the in-game ?/H help (`speakControls` in main.ts) and the tutorial's
 * intro + completion recap (ui/tutorial.ts) — consumes the SAME list and can never
 * drift apart. `docs/HOWTOPLAY.md` mirrors this list by hand; if you edit the
 * controls here, update that doc to match (it intentionally does not import TS).
 *
 * Each control is { keys, action } where `keys` is the spoken key phrasing and
 * `action` is a terse, second-person, eyes-free description of what it does.
 */
export interface Control {
  /** Human-spoken phrasing of the key(s), e.g. "Left and Right arrows". */
  keys: string;
  /** Terse, second-person description of the effect. */
  action: string;
}

/** The canonical keyboard controls, in the order they're spoken. */
export const CONTROLS: readonly Control[] = [
  {
    keys: 'Arrow keys, or Q and E',
    action: 'turn — left or up turns left, right or down turns right; hold Shift to turn farther',
  },
  {
    keys: 'A and D',
    action: 'step with your left and right foot — alternate them and do not rush',
  },
  { keys: 'Echo button', action: 'claps to hear the room' },
  { keys: 'T', action: 'throws a sound decoy to lure a monster away from you' },
  {
    keys: 'S',
    action: 'opens Settings — volume, companion voice, cues, and reset progress',
  },
  { keys: 'question mark or H', action: 'repeats these controls' },
] as const;

/**
 * Render the controls to a single spoken string for a live region. Begins with
 * "Controls:" and lists each control as "<keys> <action>." so a screen-reader /
 * eyes-free player hears every key and what it does.
 */
export function renderControlsSpeech(controls: readonly Control[] = CONTROLS): string {
  return 'Controls: ' + controls.map((c) => `${c.keys} ${c.action}.`).join(' ');
}
