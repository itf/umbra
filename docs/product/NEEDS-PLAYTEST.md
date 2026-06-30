# Needs Human Playtest

Things the autonomous loop built and verified by tests/reasoning, but that only a human
ear/judgment can truly confirm. Surfaced honestly rather than claimed "done."

## Gameplay tuning
- **Stealth AI feel** — being addressed by a sim test (7A), but the *audible* tension
  (does dodging the warden feel fair/exciting?) needs a play session: `?level=stealth-escape`,
  `stealth-twin-wardens`, `stealth-chokepoint` (throw decoys with `T`).
- **New levels' difficulty curve** — the 10-level pack (2e7979e) is solvability-tested but
  the easy→hard *progression feel* per mode is reasoned: play through Beacon Meadow →
  Warren → Shifting Vault; Glass Gallery → Deadest Spot → Foam Cathedral; etc.
- **Absorber subtlety** — `foam-cathedral` (a small panel barely denting a long marble
  tail): is the dead spot actually findable by ear, or too subtle?
- **Sonar-budget tuning** — are 4 claps (`sonar-tight`) / the 3.5 s cooldown
  (`sonar-labyrinth`) tight-but-fair?

## Audio / mix
- **Companion-voice tone & timing** — lines + the ~1–1.4 s delays after critical cues
  (`?companion=off` to compare). Do they add immersion or chatter?
- **"Getting warmer" cue** — is the proximity loudness ramp helpful and subtle?
- **Win chime / detent ticks / master mix** — overall balance across modes.
- **The click-free interpolating beacon** — already user-confirmed clean; worth a final
  pass across the new levels/materials.

## Accessibility (with a real screen reader)
- The full keyboard + screen-reader flow end-to-end (onboarding → pick → play → settings)
  on an actual AT (NVDA/VoiceOver), not just ARIA assertions.

How to drive any of these: `npm run dev`, open `/?level=<id>` (add `&debug=1` for the
minimap, `&companion=off` to mute the guide). Settings: press `S` in-game.
