# Meeting — Cycle 5 Review & Next Planning

**Attendees:** PM (chair), Game Design, UX/Accessibility, Acoustics/Eng.
**Context:** Cycle-5 shipped guided onboarding (`a06ca3e`), editor stealth authoring
(`b609ee2`), a11y polish (`491b969`). 448 unit + 20 e2e green.

## Review — state of the product
Foundations are now strong and coherent:
- **4 game modes** (beacon, absorber, sonar-budget, stealth) — all authorable in the editor.
- **Trainer**: adaptive staircase, persistence, Thaler drills, daily challenge + streak.
- **First-run**: graduated localization lesson + per-mode primers; fully keyboard/SR-accessible.
- **Quality**: 448 unit + 20 e2e, every flow gated, no regressions across 14 builds.

**Assessment:** breadth + accessibility + authorability are in good shape. The thinner
areas now are **content depth** (each mode has only 1–2 levels) and **emotional/engagement
pull** (the genre's celebrated games lean on narrative + a companion voice; we have none).

## Decision: Cycle 6 — depth & pull

| Build | Scope | Effort | Why |
|-------|-------|--------|-----|
| **6A — Level pack (depth per mode)** | A curated set of new hand-authored levels: 2–3 more per mode (beacon/absorber/sonar/stealth) with a difficulty progression, each solvability-tested. Use the now-rich material palette + the editor schema. Register + a simple "campaign"/ordering in the picker. | M | Each mode is currently a one-off; a progression turns modes into playable arcs. Direct play-value. |
| **6B — Companion-voice / narrative layer** | A lightweight, OPTIONAL spoken "guide" that frames objectives and reacts to events (arrival, getting caught, finding the dead spot) with short lines — the praised Nightjar/Blind-Legend device, but accessibility-native (it's already all audio). Data-driven lines per level/mode; skippable; uses Web Speech or pre-written status lines. | M | Research: voice/narrative is a top driver of the genre's immersion. We have the event hooks (onWin/onCaught/onStep/onNoise) already. |
| **6C — Mute/settings + audio-mix polish** | A spoken settings surface: master volume, toggle the companion voice, toggle the warmer cue, re-run calibration, reset progress. Small but expected QoL; currently no in-game settings. | S | Players need control over the new layers (esp. the companion voice) and a volume/mix control. |

**Sequencing:** 6A (levels — data + picker) and 6B (companion voice — game event hooks +
a data layer) are largely disjoint (levels/picker vs a new companion module + game hooks).
6C touches settings/main + game — run after 6B. Plan: **6A + 6B parallel**, then **6C**.

## Principles
- Companion voice must be OPTIONAL + remembered (some players will want pure acoustics);
  never block or talk over critical audio.
- Every new level solvability-tested; every new mode-arc reachable from the picker.
- Keep the e2e net green; add smokes for the campaign ordering + a companion-line fire.

## Actions
- [next, parallel] 6A level pack + 6B companion-voice layer.
- [after 6B] 6C settings/mix.
- Reconvene for Cycle-6 review. Beyond: async-ghost leaderboard (L), multiplayer
  exploration, a "sandbox/freeplay" mode, mobile-gesture parity audit.
