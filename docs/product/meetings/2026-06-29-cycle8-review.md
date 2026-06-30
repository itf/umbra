# Meeting — Cycle 8 Review & Next Planning

**Attendees:** PM (chair), Game Design, UX, Eng, QA.
**Context:** Cycle-8 (engagement & replay) shipped: TTS voice + scoring (`4f49b3f`),
sandbox generator (`e5c8035`). 573 unit + 26 e2e green.

## Review
- **TTS companion voice** + **per-level scoring/bests** + **infinite seeded sandbox** —
  the product now has a real engagement/replay loop and unbounded content. The sandbox
  fuzz-tested 800 generated levels for validity + solvability — strong rigor.
- Across 8 cycles / 23 builds, quality has held: 573 unit + 26 e2e, every flow gated, no
  regressions, release-ready (PWA fixed, docs, deploy headers).

## Strategic read — diminishing returns on raw breadth
The product is now **very** broad: 4 modes, 27 + infinite levels, trainer + daily, scoring,
TTS, companion, onboarding, settings, editor, full a11y. Adding a 9th feature has less
marginal value than (a) making what exists demonstrably excellent, and (b) the items only a
HUMAN can validate. The honest PM position after this much autonomous building:

**The biggest open risk is not "too few features" — it's "unverified-by-ear quality."**
`NEEDS-PLAYTEST.md` has grown to ~10 items (stealth feel, level curves, companion tone,
TTS quality, mix, generated-level texture, a real screen-reader pass). The loop can't
resolve these; only the user can.

## Decision: Cycle 9 — one more high-value feature, then a QUALITY/REGRESSION-HARDENING
pass and a clear hand-off

| Build | Scope | Effort | Why |
|-------|-------|--------|-----|
| **9A — Local leaderboard / score history (uses 8B)** | A "Best Times" board: per-level + per-mode bests, total levels cleared, daily-challenge streak, all in one spoken/visible summary screen reachable from the picker. Built on scoreStore + dailyStreakStore. (No backend — local; a real online leaderboard is a future L.) | S–M | Closes the engagement loop 8B opened; cheap; pure product layer. |
| **9B — Full-suite regression + perf sanity** | Run the entire unit + e2e suite, an `npm run build` size check (the bundle has grown — verify the default path didn't bloat; confirm three/steam still lazy-only), and a quick acoustics perf check (interpolating worklet + reflections under load). Fix anything that regressed. | S–M | After 23 builds, a deliberate full-regression + bundle/perf audit before declaring stable. |
| **9C — Session hand-off doc + consolidated NEEDS-PLAYTEST** | A single "what was built this session, how to try each thing, what needs your ears" document so the user can efficiently review the whole body of work. Consolidate NEEDS-PLAYTEST with exact URLs/steps. | S | The user asked for an autonomous loop; a crisp hand-off makes the output actionable. |

**Sequencing:** 9A (leaderboard) + 9B (regression/perf) parallel (UI/store vs test/build);
9C (hand-off doc) after, summarizing everything incl. 9A/9B results.

## Principle
Bias from "more breadth" toward "prove quality + make the work reviewable." The user is
the only one who can judge the ear-dependent items; our job is to make that easy and to
guarantee nothing regressed.

## Actions
- [next, parallel] 9A leaderboard + 9B regression/perf audit.
- [after] 9C session hand-off + consolidated playtest guide.
- Reconvene Cycle-9 review. If the user wants more breadth after, the backlog (online
  leaderboard, multiplayer, more materials/levels, narrative campaign) is ready.
