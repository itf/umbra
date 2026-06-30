# Session Hand-off — Autonomous Product Loop

What the autonomous loop built, how to try each thing, and what needs YOUR ears.
**Status:** 583 unit tests + 26 e2e green, tsc clean, production build OK, release-ready.
Run `npm run dev`, open the printed URL. Add `&debug=1` for the minimap, `&companion=off`
to mute the guide. In-game: **S** = settings, **?/H** = controls, arrows turn, A/L step,
Echo button claps, **T** throws a decoy (stealth).

## 1. The original bug (fixed, you confirmed)
**Beacon clicking when turning** — root cause was our HRTF renderer restarting a
convolution on every direction-bucket crossing. Fixed with a continuously-interpolating
HRTF AudioWorklet (keeps the SADIE measured ears, no click). Also: reflections rendered as
head-tracked interpolating sources. You confirmed "no more clicking."
Bonus, on a separate branch (`feat/sofa-hrtf` in the sibling `three-steam-audio` clone):
proved we *can* feed our SADIE SOFA to Steam Audio's WASM (~12-line change) — upstream PR
prepared, not pushed.

## 2. What the product is now (built this session)
| Area | What |
|---|---|
| **Game modes** | Beacon (navigate to a sound), **Absorber** (clap, find the dead spot), **Sonar-budget** (scarce claps), **Stealth** (reach the exit unheard; throw decoys) |
| **Content** | 26 hand-authored levels (per-mode difficulty arcs, grouped picker) + an **infinite seeded Sandbox generator** (pick mode+difficulty, "Another" for a new level) |
| **Trainer** | Adaptive staircase, persistent progress, **Daily Challenge + streak**, Thaler-backed distance-ladder + 4-way orientation drills, +18 materials with a separable material-ID ladder |
| **Engagement** | Per-level **scoring/bests** ("New best!"), a **Progress / Best Times** screen, optional **companion voice** + real **Web Speech TTS** |
| **Onboarding** | Graduated localization lesson (L/R/front) + per-mode primers, skippable+remembered |
| **Accessibility** | **Keyboard turning** (was unplayable without a mouse!), compass aria-value, spoken everything, focus management, settings panel |
| **Authoring** | Editor can now create every mode (absorber patches, escape/exit, clap/decoy budgets, autosave, lint) |
| **Quality** | Playwright **e2e** (26 specs incl. a real keyboard completion), **stealth-AI simulation** tests, clean regression audit, PWA fixed (icons + 488 KB precache), deploy docs |

## 3. Try each thing (URLs)
- Click-free beacon: `/?level=large-concrete-hall` — turn freely.
- Find-the-absorber: `/?level=find-the-foam` — clap, find the wall that doesn't echo.
- Sonar-budget: `/?level=sonar-vault` — 6 claps; spoken budget.
- Stealth + decoy: `/?level=stealth-escape` (or `stealth-chokepoint`) — `T` throws a decoy.
- New levels: pick from the grouped picker (Beacon Meadow, Glass Gallery, Four Claps, Twin
  Wardens, …).
- Sandbox: the picker's top "Sandbox" section → mode + difficulty → Generate.
- Trainer + Daily: `/trainer.html` → "Today's challenge"; pick "Panel orientation (4-way)".
- Companion voice / TTS / volume / reset: in-game press **S**.
- Progress / best times: picker → "🏆 Your progress".
- Legacy renderer A/B: append `?hrtf=legacy`. Steam engine: `?engine=steam` (needs COOP/COEP).

## 4. NEEDS YOUR EARS (the loop can't judge these — see NEEDS-PLAYTEST.md)
1. **Stealth feel** — sim proves the geometry/AI catch dynamics are sound, but does dodging
   the warden + decoy timing *feel* fair/fun? (Esp. generated stealth at high difficulty.)
2. **Level difficulty curves** — the easy→hard progression per mode is reasoned, not felt.
3. **Absorber subtlety** — is `foam-cathedral`'s dead spot findable, or too subtle?
4. **Companion tone & timing** — immersive or chatty? (`&companion=off` to compare.)
5. **TTS** — voice quality, and the **default-OFF decision** (chosen to avoid double-speak
   for screen-reader users; means a sighted eyes-closed player gets silence until they
   enable it — your call whether that's right).
6. **Mix balance** — win chime, detents, warmer cue, master levels across modes.
7. **A real screen-reader pass** (NVDA/VoiceOver) end-to-end.

## 5. Process (how it ran)
9 cycles, each: discovery/research → cross-functional "meeting" (`docs/product/meetings/`) →
parallel builds by sub-agents on disjoint files → tsc + unit + e2e + build gate → commit on
green. Decisions, limitations, and the running log are in `docs/product/PM-LOG.md`.
After ~23 builds the loop deliberately pivoted from breadth to **harden + verify + hand off**
(Cycles 7+9), because the remaining risk is ear-dependent quality, not missing features.

## 6. Ready backlog (if you want more breadth)
Online/global leaderboard (local one exists), multiplayer, a narrative campaign, more
materials/levels, the Steam-SOFA integration (proven, PR-ready), seed-share for sandbox.
