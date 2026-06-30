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

## Added in later cycles (Cycle 4-9)
- **Companion voice tone & timing** (6B) — `&companion=off` to compare; immersive vs chatty.
- **TTS voice quality + the default-OFF decision** (8A) — opt-in to avoid screen-reader
  double-speak, but a sighted-eyes-closed player gets silence until they enable it (Settings → S).
- **Sandbox generated-level fairness** (8C) — esp. stealth at high difficulty (2 fast
  monsters); a quiet route is guaranteed but the chase *feel* isn't verified by sim.
- **Generated acoustic texture** — solvable + varied, but "fun to listen to" is subjective.
- **Daily challenge + streak loop** — does it pull you back?
- **Progress/leaderboard screen** — is the spoken summary useful/motivating?

See `SESSION-HANDOFF.md` §4 for the consolidated list with URLs.

## Acoustics fidelity notes (from user questions)
- **1/r distance attenuation IS modeled** on every beacon path (interp + legacy + modeled
  direct): `g = 1/max(1,dist)` amplitude + an air-absorption lowpass. So beacon loudness is
  an honest distance cue already → the artificial "getting warmer" cue is redundant (slated
  for removal once the navigation refactor lands; it caused the crackle).
- **Near-field / per-ear distance ILD is NOT modeled (known gap).** We use ONE
  distance-to-head-center 1/r for both ears, and the SADIE HRTFs are FAR-FIELD measured. So
  a source almost touching one ear will NOT get the huge L/R loudness difference real
  physics gives (~12 dB from the ~4× per-ear distance ratio at the side of the head, plus
  the near-field HRTF boost). Directional ILD at normal distances IS modeled (via HRTF,
  ~8.8 dB swing measured). Fixing near-field would need per-ear distance gain + a
  distance-variation-function (DVF) / near-field HRTF correction — a real but bounded
  enhancement; matters only for sources within ~0.5 m.
