# Meeting — Cycle 4 Review & Next Planning

**Attendees:** PM (chair), Game Design, UX/Accessibility, Acoustics/Eng.
**Context:** Cycle-4 shipped three new modes: sonar-budget survival (`f977fd0`), daily
challenge + streak (`44cbdce`), stealth escape + decoy (`762bc73`). 424 unit + 16 e2e.

## Review
- **Three genres added**, all on existing primitives, all eyes-free + e2e-guarded:
  flash-sonar discipline (clap economy), retention (daily streak), and stealth (the
  genre's praised "agency over fear" loop with a real verb, the decoy). ✅
- **Grounded engineering:** the stealth agent discovered carpet isn't silent (0.148 >
  0.12) and built the corridor from acoustic_foam — data-driven, not assumed. Good signal.
- **Coverage healthy:** every new mode has unit + e2e + solvability checks. The product
  is now genuinely multi-mode (beacon, absorber, sonar-budget, stealth) + a coaching
  trainer with daily challenges.

## Gap check (what's now the weakest link?)
The product breadth has outrun its **first-run experience**. Research said onboarding/UI
is the genre's #1 failure. We have calibration + a tutorial, but:
- New modes (absorber, sonar, stealth) have NO in-context teaching — a first-timer meets
  "throw a decoy" / "find the dead spot" with only a one-line spoken objective.
- Several authored a11y follow-ups remain open (compass-widget a11y, cardinal detents,
  warmer-cue for custom-audio beacons).
- The editor (now powerful) still can't author stealth `exit`/`decoyBudget` or escape goal
  — the "ships but un-authorable" gap reopened with 4B.

## Decision: Cycle 5

| Build | Scope | Effort | Why |
|-------|-------|--------|-----|
| **5A — Guided onboarding mode** | A graduated, spoken first-run path (Kish/Thaler-validated): seated L/R/front localization → turning → walking to a beacon → clap → one mode primer. Skippable, remembered (onboardingStore). Surfaces the controls + each mode's verb in context. | M | Genre's #1 failure; we now have 4 modes a newcomer can't learn cold. Highest UX leverage. |
| **5B — Editor: stealth + escape authoring + polish** | Author goal:'escape', exit, decoyBudget, monster placement clarity; close the 4B authorability gap. Plus quick polish (the deferred S3 monster-sound preview). | S–M | Keep the "every shipped mode is authorable" invariant; user-priority editor keeps improving. |
| **5C — a11y polish pass** | Compass-widget a11y (it's pointer-only as a widget), cardinal detents/ticks on turn (G2), warmer-cue for custom-audio beacons. Small, high-quality-of-life. | S | Closes logged a11y follow-ups; cheap. |

**Sequencing:** 5A (onboarding) is the flagship and touches ui/ + main — run it solo-ish.
5B (editor) and 5C (a11y polish) are disjoint from each other and from 5A's core (editor/*
vs game/compass) → run 5B + 5C in parallel, then 5A, OR 5A alongside 5B since 5A is
ui/onboarding and 5B is editor. Plan: **5A + 5B in parallel** (ui/main+onboarding vs
editor/*), then **5C** after 5A (both touch compass/turn announce).

## Principles
- Onboarding must be SKIPPABLE and remembered (don't wall returning/expert users).
- Maintain the authorability invariant (5B) and e2e coverage for new flows.

## Actions
- [next, parallel] 5A guided onboarding + 5B editor stealth-authoring.
- [after 5A] 5C a11y polish.
- Reconvene for Cycle-5 review. Backlog beyond: more levels per mode, async ghost/
  leaderboard (L), narrative/companion-voice layer, multiplayer exploration.
