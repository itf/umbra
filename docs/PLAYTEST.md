# Playtest Checklist

Things that require a human's ears (and sometimes a microphone) to validate.
Headless tests cover correctness and fairness; these cover perceptual quality and
game feel.

## Loudness EQ calibration

- [ ] Run the multi-band calibration to completion. Confirm the staircase
      converges — the questions feel like they're homing in on a level match, not
      bouncing wildly or stalling.
- [ ] After calibration, play a few trainer exercises. Confirm the applied master
      EQ perceptually flattens loudness across frequencies — the 125 Hz band should
      not sound dramatically quieter or louder than the 4 kHz or 8 kHz band.
- [ ] Repeat for a second listener with a different headphone/ear combination.
      Confirm the measured curves differ between listeners (the system is actually
      measuring individuals, not returning a fixed curve).

## Mouth-click recording

- [ ] Open the probe picker and tap "Record your click." Confirm the browser asks
      for microphone permission.
- [ ] Make a single mouth click during the ~1 s capture window. Confirm the
      recorded probe sounds like a clean, short transient (not silent, not clipped,
      not a long breath or background noise).
- [ ] Fire the recorded click in a trainer exercise. Confirm the echo is audible
      and the click is short enough that the echo is not masked.
- [ ] Try denying mic permission. Confirm a descriptive error message appears
      ("Microphone access denied. Grant permission and try again.") rather than
      a silent failure.

## HF pre-emphasis on the clap

- [ ] Compare the default synth clap with and without the +6 dB high-shelf (if
      there is a way to toggle it, otherwise compare to a recording without it).
      Confirm the clap sounds slightly brighter and crisper without being harsh.
- [ ] Run the `carpet` and `brick` discrimination drills. Confirm the material
      difference is clearly audible (the boost should help, not hurt, the timbre
      cue).

## Distance-estimation drill (`estimate`)

- [ ] Select the `estimate` exercise. Clap, listen to the echo delay, and pick a
      distance from the grid. Confirm the echo delay perceptually matches the
      revealed true distance (closer = sooner echo).
- [ ] Confirm the choice grid updates at higher difficulty (finer 0.25 m steps
      instead of 0.5 m steps).
- [ ] Confirm the post-answer feedback clearly states your % error and the
      tolerance that was applied, and that a correct guess within tolerance is
      announced as correct.

## Interleaved scheduler (mixed mode)

- [ ] Select all exercise types in mixed mode. Spend the first several trials
      noticing that the scheduler drills one type at a time (blocked phase) until
      you feel comfortable with it, then starts mixing types more freely.
- [ ] Confirm the transition from blocked to interleaved feels natural — it
      shouldn't flip abruptly after exactly N questions but should feel like the
      difficulty and variety are gradually increasing.
- [ ] Intentionally answer several questions of one type wrong. Confirm that type
      appears more frequently in the interleaved phase (weakness weighting).

## Freeze-frame replay

- [ ] Answer an A/B question incorrectly. Confirm the trainer immediately plays
      Room A, pauses briefly, then plays Room B, with spoken labels identifying
      which is correct and (for size/distance drills) the ground-truth dimensions
      or echo delay.
- [ ] Confirm the dimension/delay text remains visible on screen while each room
      is playing (it should not be overwritten mid-replay).
- [ ] Answer correctly. Confirm the same replay happens (reinforce, not just
      correct), with a slightly different intro ("Hear it again:").

## Silent find-the-door level

- [ ] Load "Find the Door." Confirm there is no beacon sound and no ambient sound
      — the level is completely silent until you clap or move.
- [ ] Navigate using only clap echoes and footstep reflections. Confirm the
      doorway opening is locatable — the echo returns differently (or is absent)
      in the direction of the gap.
- [ ] Step through the doorway and confirm the win condition triggers at the
      `winPoint` area beyond the opening.

## Reaction levels

### Fountain Crossing

- [ ] Load "Fountain Crossing." Confirm a fountain sound is audible ahead.
- [ ] Listen for a crossing event — a brief duck/muffle of the fountain water
      with a faint swoosh. Confirm the perceptual cue is clear enough to react to
      in time.
- [ ] Press **R** during a crossing. Confirm the game registers the reaction.
- [ ] Miss a crossing (do not press R). Confirm the level still proceeds but
      tracks the miss.
- [ ] React to ≥2 of 3 crossings and reach the fountain. Confirm the win
      condition triggers.

### Door in the AC Corridor

- [ ] Load "Door in the AC Corridor." Confirm a steady AC hum (brown noise) is
      audible at the far end.
- [ ] Listen for a door event — the AC sound leaks louder and brighter when the
      door opens, with an audible click at open and close. Confirm the click is
      distinct enough to react to reliably.
- [ ] Press **R** at the door open click/swell. Confirm the reaction is registered.
- [ ] React to ≥2 of 3 door openings and reach the far end. Confirm the win
      condition triggers.

## Material clap-trainer levels

- [ ] Load "Find the Carpet Wall." Clap from various positions. Confirm one wall
      direction sounds noticeably deader/softer (fewer high-frequency reflections)
      than the other three. Walk to the win area in front of it and confirm the
      win triggers.
- [ ] Load "Find the Half-Carpet Wall." Confirm the dead spot is narrower and
      harder to localise than the full-carpet level.
- [ ] Load "Find the Hard Wall." Confirm the single sheet-metal wall sounds
      distinctly brighter/ringier than the surrounding carpet walls, and is
      locatable by that timbre difference.
- [ ] Load "Find the Half-Metal Wall." Confirm this is the hardest of the four
      — only half a wall of metal in a foam room; confirm it is still
      distinguishable with careful clapwork.
