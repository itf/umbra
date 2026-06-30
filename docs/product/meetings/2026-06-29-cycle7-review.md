# Meeting — Cycle 7 Review & Next Planning

**Attendees:** PM (chair), Game Design, UX, Eng, QA.
**Context:** Cycle-7 (harden & verify) shipped: stealth-AI sim (`2cfc89e`), PWA/docs
release-readiness (`d55ae67`), cohesion pass (`2888f34`). 498 unit + 23 e2e green.

## Review — the hardening cycle paid off
- **Stealth levels** went from "reasoned" to **proven** by an AI simulation (careful route
  survivable, loud route caught, decoy lures the warden). No AI bugs.
- **Release-readiness:** the PWA-icons bug (open since the session's first turn) is fixed +
  verified in dist; production COOP/COEP headers added; docs refreshed.
- **Cohesion pass found a REAL bug** (sonar budget-intro clobbered by the mode primer in
  the assertive region) and fixed it — vindicating the "harden before widen" call. Controls
  now have a single source of truth.

**Assessment:** the product is release-ready and internally coherent. Good moment to return
to breadth — but pick features that deepen engagement/replay, the remaining research-ranked
high-impact items.

## Decision: Cycle 8 — engagement & replayability

| Build | Scope | Effort | Why |
|-------|-------|--------|-----|
| **8A — Real TTS companion voice (Web Speech)** | The companion + key announcements currently ride ARIA live regions only. Add optional Web Speech synthesis (voice/rate/pitch choice in settings) so the companion has an actual VOICE — the genre's immersion device done properly. Graceful fallback to live-region-only when unsupported; respects the companion on/off toggle. | M | Research: voice is a top immersion driver; we have the line catalog (6B) + settings (6C) hooks ready. |
| **8B — Score / time + per-level bests (replay)** | Track completion time + claps used (+ caught count) per level, store bests (localStorage, mirror trainerStore), announce "New best!" — turns one-and-done levels into replayable score chases. Feeds a future leaderboard. | S–M | Cheap replay lever on 27 levels; the daily-challenge streak proved the persistence pattern. |
| **8C — Sandbox / freeplay generator** | A "random level" / endless mode: seed-driven procedural rooms (reuse the deterministic generators + material palette) so there's infinite content beyond the 27 hand-authored levels. Pick mode + difficulty, get a fresh seeded room. | M–L | Infinite replay; the generators + seed infra already exist (daily challenge proved it). |

**Sequencing:** 8A (companion voice — settings + a speech module) and 8B (scoring — a
store + game hooks + announce) are disjoint → parallel. 8C (sandbox — a generator + picker
entry) after, larger.

## Principles
- TTS must be OPTIONAL + degrade gracefully (live-region fallback) — never required, never
  blocks the eyes-free baseline.
- Scoring must not pressure the core navigation experience (it's additive, announced, opt-in
  to care about).
- Keep the e2e net green; the NEEDS-PLAYTEST list grows with anything ear-dependent (TTS
  voice quality, generated-level fairness).

## Actions
- [next, parallel] 8A TTS companion voice + 8B scoring/bests.
- [after] 8C sandbox generator.
- Reconvene Cycle-8 review. Then: leaderboard (uses 8B), multiplayer exploration, more
  materials/levels, and a dedicated screen-reader playtest writeup.
