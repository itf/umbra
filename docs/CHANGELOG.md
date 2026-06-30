# Changelog

## Unreleased

### Trainer

- **Distance-estimation drill (`estimate`)** — new single-scene exercise: clap a wall
  ahead, then pick its distance from a labelled metre grid (0.75–6.0 m). Graded by
  % error with a tolerance band that narrows from ±25% (easy) to ±10% (hard). The
  post-answer reveal shows your error and the tolerance that was applied.
  Only available as a single-type drill (not in mixed/all mode).
- **Post-answer echo-delay reveal** — for the `distance` drill the verdict now
  includes the round-trip echo delay in ms for each room (`2·d/343×1000`), closing
  the perceptual loop.
- **Interleaved practice scheduler** — mixed/all mode now uses a
  blocked→interleaved two-phase scheduler. While any type is novice (<6 trials or
  staircase threshold <0.5) it blocks on that type until competent, then switches to
  weakness-weighted interleaving (weight = 1 − recent accuracy over last 5 trials).
  Each type carries its own independent adaptive staircase; difficulty picks up
  exactly where it left off when a type is re-entered. Maximum 3 consecutive repeats
  of the same type.
- **Freeze-frame replay** — after every A/B answer the trainer plays the correct
  comparison back-to-back (Room A → 500 ms gap → Room B) with spoken and visible
  labels. Labels include ground-truth dimensions or wall distances where relevant,
  so the numbers stay visible while each room plays.
- **First-launch onboarding** — on the very first visit a forced maximally-easy
  size discrimination runs before the normal flow, ending with the spoken reveal
  "You just used echolocation." Shown once, then never again.
- **Progress sparkline dashboard** — a canvas sparkline per exercise type shows the
  adaptive threshold trend (line rising = improving). The accessible truth is a
  spoken `trendSummary` beside each canvas.
- **Per-user multi-band loudness EQ calibration** — 7-band (125–8000 Hz)
  equal-loudness matching via a 1-up/1-down staircase per band (4 dB initial step,
  halves at reversals, ±12 dB max, converges at 4 reversals or 16-trial cap). The
  measured correction curve is applied as a master EQ to flatten perceived loudness.
  Runs in the calibration flow and is re-runnable from Settings.
- **Record your own mouth click** — a "Record Click" button in the probe picker
  captures ~1 s from the microphone, auto-trims around the loudest peak (5 ms pre /
  45 ms post), fades and normalises, and uses the result as the clap probe.

### Audio

- **HF pre-emphasis on the clap** — a +6 dB high-shelf above 1 kHz is applied to
  the clap excitation in `ClapRoom`, boosting the 1–4 kHz band where material and
  pinna cues live, without altering probe length or the crossfade path.

### Levels

- **Silent find-the-door** (`find-the-door`) — no beacon, no ambient sound. A
  concrete corridor with an off-centre doorway. Navigate by clap echo and footstep
  reflections. Win area (`winPoint`/`winRadius`) marks the space beyond the gap.
- **Reaction levels** (new category) — ambient sources + timed reaction events.
  Player presses **R** when they detect a change in the ambient source; win requires
  reaching the destination after a minimum number of correct reactions.
  - `fountain-crossing` — water fountain that ducks/muffles as people cross;
    react to ≥2 of 3 crossings.
  - `door-in-the-ac-corridor` — AC hum that leaks louder/brighter when a door
    opens (with a click); react to ≥2 of 3 openings.
- **Material clap-trainers** (category `absorber`) — no beacon, find the target
  wall section by its echo timbre; walk to the win area in front of it.
  - `find-the-carpet` — easy; one whole concrete wall is carpet.
  - `find-the-carpet-half` — medium; only half of one wall is carpet.
  - `find-the-hard-wall` — medium (inverted); dead carpet room, one bright
    sheet-metal wall.
  - `find-the-metal-half` — hard; foam room, half of one wall is sheet metal.
- **Schema additions** — `ambience` (ambient sources), `events` (reaction events),
  `requiredReactions` (win gate), `winPoint`/`winRadius` (win area independent of
  beacons), `clutter` (acoustic object density 0..1).

### Editor

- **Ambient source tool** — place continuous non-goal sound sources; edit preset,
  freq, gain (0..2), soundUrl; preview; rendered as blue dots.
- **Win area tool** — place a `winPoint` + `winRadius`; dashed green ring on
  canvas; works with zero beacons.
- **Material patch tool** — place `WallPatch` absorber sections on perimeter faces;
  edit face, rectangle (u0/v0/uSize/vSize), material.
- **Reaction events panel** — level-global add/delete of reaction events; edit type
  (`crossing`|`door`), sourceId, start/end window.
- **Clutter + Required reactions** — new Room panel fields.
- **Save-time lint** — warns on dangling event sources, impossible reaction gates,
  unwinnable levels, silent levels; surfaced via `role="status" aria-live="polite"`
  status bar.
- **Full round-trip** — all new fields survive save/load (IndexedDB) and
  export/import (JSON) with deep equality; `isLevel()` back-fills new fields.
