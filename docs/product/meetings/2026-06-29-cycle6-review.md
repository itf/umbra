# Meeting — Cycle 6 Review & Next Planning

**Attendees:** PM (chair), Game Design, UX/Accessibility, Acoustics/Eng, QA.
**Context:** Cycle-6 shipped the level pack (`2e7979e`), companion voice (`e1168b0`),
settings panel (`04a1b21`). 486 unit + 23 e2e green.

## Review — where the product is now
After 18 builds this loop, papasangre is a complete, accessible, multi-mode audio game:
- **4 modes**, **27 levels** (per-mode difficulty arcs, grouped picker).
- **Trainer**: adaptive, persistent, daily challenge + streak, Thaler drills.
- **Onboarding**: graduated localization + per-mode primers.
- **Companion voice** (optional narrative) + **settings** (volume, toggles, reset).
- **Accessibility**: keyboard turning, compass aria value, spoken everything, focus mgmt.
- **Quality**: 486 unit + 23 e2e, every flow gated.

**Assessment:** breadth is now strong. Two risks emerge from moving fast across 18 builds:
1. **Unverified-by-ear gameplay tuning** — several things only a human can confirm:
   stealth AI catch-dynamics (does the warden take the decoy? can it hear foam steps?),
   companion-line tone/timing feel, the new levels' difficulty curve, mix levels.
2. **Cohesion drift** — many features added independently; worth a consolidation pass
   (consistent spoken-message style, a single help/controls source of truth, docs).

## Decision: Cycle 7 — consolidate & verify before more breadth

Rather than pile on another feature, spend a cycle hardening what's shipped (the
right PM call after a long build sprint). Three tracks:

| Build | Scope | Effort | Why |
|-------|-------|--------|-----|
| **7A — Playtest-instrumentation + stealth-AI verification** | Build a headless/sim harness that exercises the MONSTER AI (not just flood-fill): simulate a careful player on the quiet route + a decoy throw, assert the warden investigates the decoy and a foam-route player isn't caught — turning the flagged "reasoned not tested" stealth levels into actual tests. Tune any level that fails. | M | Closes the biggest unverified-gameplay risk; makes stealth levels trustworthy. |
| **7B — Cohesion pass** | One source of truth for controls/help (used by speakControls + tutorial + settings), consistent announcement phrasing/priority, and a short player-facing "how to play / modes" doc. Audit for any spoken-message clobbering across companion + mode + settings. | S–M | Reduces drift; improves the eyes-free UX coherence as a whole. |
| **7C — Docs + release-readiness** | Update TECHNICAL.md / a product overview reflecting all new modes/features; verify the PWA manifest + (the long-open) missing icons; a `_headers` for COOP/COEP so the Steam path works deployed; confirm production build + service worker. | S | We noted missing PWA icons + production COOP/COEP early in the session and never closed them; release-readiness matters now that there's a real product. |

**Sequencing:** 7A (sim harness — game/test) and 7C (docs/PWA/build — config/docs) are
disjoint → parallel. 7B (cohesion — touches main/ui/help) after, since it overlaps both.

## Principles
- After a breadth sprint, harden before widening. Verification > new features this cycle.
- Surface anything only a human can judge (tone, difficulty, mix) as an explicit
  "needs playtest" list for the user, rather than asserting it's done.

## Actions
- [next, parallel] 7A stealth-AI sim/verification + 7C docs/PWA/release-readiness.
- [after] 7B cohesion pass.
- Reconvene Cycle-7 review. Then breadth again (async-ghost leaderboard, sandbox, TTS voice).
- Compile a **"needs human playtest"** list for the user (stealth bait, level curve,
  companion tone, mix).
