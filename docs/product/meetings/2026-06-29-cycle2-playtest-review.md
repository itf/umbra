# Meeting — Cycle 2 Playtest Review & Next-Cycle Planning

**Attendees:** PM (chair), UX/Accessibility, Game Design, Acoustics/Eng.
**Context:** Cycle-2 builds shipped — materials (`5066fe2`) and accessibility (`006e625`).

## What shipped (and review)
- **Accessibility (`006e625`)** — keyboard turning (arrows + Shift), heading
  announcements, "getting warmer" beacon cue, win chime, help key. **Verdict:** the
  single most important change of the loop — the game went from *uncompletable without a
  mouse* to keyboard-completable for the blind/keyboard audience. tsc clean, 339 tests,
  build OK. Open follow-ups (logged, not blocking): warmer cue for custom-audio beacons,
  compass-widget a11y, cardinal detents.
- **Materials (`5066fe2`)** — +18 cited materials, water/marble reconciled, easy→hard
  material-ID ladder + "which wall is metal" drill. **Verdict:** improves trainer cue
  quality and level palette; clean. Verified the ladder pairs separable corners.

Both validated by tests + reasoning. No e2e harness yet (flagged below as a gap).

## Decision: Cycle 3 builds

The user's stated priority is **a nicer level editor with more features**. The editor
can't author the modes we already SHIP (absorber, clap-budget) — that's the biggest
content-unlock gap. Pair it with the cheap, high-value trainer-progression wins.

| Build | Scope | Effort | Why |
|-------|-------|--------|-----|
| **3A — Editor authoring (flagship)** | S1 goal-mode selector, S2 clap-budget/cooldown fields, S4 primary-beacon badge, enumerate absorbers in objectList (fix the silent-hide bug), S5 validate-on-save lint, **M1 absorber-patch tool**, M4 autosave + unsaved-guard | M–L | User priority; unlocks authoring find-the-absorber + sonar-budget levels; fixes a correctness bug (absorbers silently dropped on load) | 
| **3B — Trainer progression** | T1 persist sessions (localStorage), T2 announce reversals/streaks, T3 adaptive distance ladder + 4-way orientation drill (Thaler-backed) | S–M | Cheap, evidence-backed; turns one-shot drills into a coach |
| **3C — e2e smoke harness** | A minimal Playwright (or headless) smoke test: load a level, keyboard-turn, step, reach beacon, assert win fires; load find-the-foam, assert absorber goal. | S–M | We've shipped 4 builds with no end-to-end coverage; the keyboard path especially deserves a guard so accessibility doesn't silently regress |

**Run 3A and 3B in parallel** (disjoint: editor/* + schema vs trainer/*). **3C after**,
so it can smoke-test the new editor-authored modes too.

## Principles reaffirmed
- Keep accessibility-first: the editor itself is pointer-only (A-level gap) — note it,
  but the immediate win is *authoring power*; editor-canvas a11y is a separate larger track.
- Every build: tsc + tests + commit. Fix the absorber-enumeration bug as part of 3A
  (it's a real correctness issue, not just a feature gap).

## Actions
- [next] Dispatch 3A (editor authoring) + 3B (trainer progression) in parallel.
- [after] 3C e2e smoke harness covering the keyboard completion path + absorber mode.
- Reconvene for a Cycle-3 review → then new game modes (decoy-throw, sonar-stealth) +
  daily challenge + guided onboarding.
