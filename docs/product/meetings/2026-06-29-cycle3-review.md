# Meeting — Cycle 3/4 Review & New-Content Planning

**Attendees:** PM (chair), Game Design, UX/Accessibility, Acoustics/Eng.
**Context:** Cycle-3 builds shipped — editor authoring (`7e2c330`), trainer progression
(`db2a062`); plus the e2e smoke harness (`faacebf`). 381 unit + 8 e2e green.

## Review
- **Editor (user priority):** find-the-absorber-class levels are now authorable
  end-to-end, absorber round-trip bug fixed, autosave added. ✅
- **Trainer:** persistence + reversals/streaks + Thaler distance ladder + 4-way
  orientation. Honest simplification on orientation (single-panel tilt) logged. ✅
- **e2e:** real keyboard completion now guarded — accessibility can't silently regress. ✅
- **Quality posture:** every build tsc+test gated, committed green. Good cadence.

## Decision: Cycle 4 — first NEW GAME CONTENT

Research ranks daily-challenge + clap-budget + stealth + decoy as the highest
impact-per-effort, all building on existing primitives. The editor now authors
`clapBudget`/`clapCooldownMs`, so the **clap-budget survival mode** is the natural next
step (the plumbing meets the content). Pair with the stealth mode (makes the
already-built noise-hunter monster a real *game*), and the daily-challenge retention layer.

| Build | Scope | Effort | Why |
|-------|-------|--------|-----|
| **4A — Sonar/clap-budget survival mode** | Enforce clapBudget/cooldown in-game (the schema+editor already carry them; wire the actual limiting + a SPOKEN budget readout + out-of-claps state). A win/lose tuned around scarce probes. One level. | S–M | Plumbing already exists end-to-end; turns "click deliberately" discipline into a mode. High impact. |
| **4B — Stealth: evade the noise-hunter** | A mode objective: reach the exit UNCAUGHT past the noise-trail monster. Tiptoe on soft floors (quieter noise), freeze, slip by. Add escape/exit state + "throw-a-sound decoy" verb (one-shot positioned noise that pulls the monster). One level. | M | monster.ts + noiseEvents + floor materials + per-material footstep loudness all exist. The genre's praised "agency over fear" loop. |
| **4C — Daily Challenge + streak** | One seeded scenario/day (deterministic generators already exist); complete to extend a localStorage streak; spoken streak status; shareable score string. Works for both a trainer drill and a level. | S | "Single best retention lever" (research). Pure product layer, no engine change. Reuses trainerStore patterns. |

**Sequencing:** 4A and 4C are small and disjoint (game.ts/clapBudget vs a new daily
module + trainer/levels) → parallel. 4B (stealth) is larger and touches game.ts/monster —
run it after 4A lands to avoid game.ts contention. Each gets an e2e smoke added.

## Principles
- Keep accessibility-first: every new mode's state (budget left, caught/escaped, streak)
  must be SPOKEN via the live region, and covered by an e2e smoke.
- Author-ability: where a new mode adds a schema field, add the editor control too
  (don't recreate the "ships but un-authorable" gap).

## Actions
- [next, parallel] 4A clap-budget survival + 4C daily challenge.
- [after 4A] 4B stealth + decoy.
- Add e2e smokes for each. Reconvene for Cycle-4 review → guided onboarding + remaining
  a11y (compass widget, detents) + polish.
