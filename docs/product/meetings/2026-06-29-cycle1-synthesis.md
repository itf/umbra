# Meeting — Cycle 1 Discovery Synthesis

**Attendees (roles):** PM (chair), UX/Accessibility, Game Design, Acoustics/Eng.
**Inputs:** `research-audio-games.md`, `materials-research.md` + `materials-proposed.json`,
`ux-audit.md`. **Goal:** turn discovery into a prioritized build roadmap for the loop.

## Headlines from research
- **UX (critical):** the shipped game is **not completable by keyboard / screen-reader
  users — there is no way to TURN without a pointer drag.** A keyboard `TurnControl`
  already exists (`src/game/turnControl.ts`) but isn't wired into `main.ts`. For an
  accessibility-first audio game this is the #1 issue. (UX audit §A1, §e.1)
- **Audio-game landscape:** onboarding/UI is the most-cited failure of the genre, not
  acoustics — cheap to fix in a PWA. Daily streak + adaptive difficulty are the proven
  retention levers; our seed-deterministic generators make a daily challenge nearly free.
- **Echolocation science (Thaler 10-week study):** gives evidence-backed trainer
  milestones — an **adaptive distance ladder** and a **4-way orientation drill** — and
  validates a graduated guided onboarding (Kish FlashSonar).
- **Materials:** 20 cited materials ready to merge; research identifies a
  **maximally-separable 7-material set** so the material-ID drill teaches real,
  distinguishable cues (and flags near-identical "mirror" clusters to avoid).
- **Editor (user priority):** ~75% of the schema is authorable, but it CANNOT create
  absorber patches, goal-mode, or clap-budget — features bundled levels already use.

## Decision: prioritization (impact ÷ effort, accessibility-weighted)

| # | Build | Why now | Effort | Status |
|---|-------|---------|--------|--------|
| 1 | **Keyboard turning + game-feel quick wins** (mount TurnControl + arrow keys; continuous "getting warmer" beacon cue; win flourish; "how to play" key) | Makes the game *playable by the core audience at all*; the rest is polish that compounds it. Highest impact, low effort. | S–M | **next** |
| 2 | **Material palette expansion + separable material-ID drill** | Data is researched + ready; improves trainer cue quality; independent of other work (already dispatched). | M | **in progress** |
| 3 | **Editor: author the missing modes** (goal=absorber + absorber-patch tool, clap-budget fields, monster sound preview, enumerate absorbers in objectList) | User explicitly wants a nicer level editor with more features; unlocks authoring the modes we already ship. | M–L | queued |
| 4 | **Trainer progression** (persist progress in localStorage; announce reversals/streaks; adaptive distance ladder + 4-way orientation drill from Thaler) | Converts one-shot drills into a motivating coach; evidence-backed. | M | queued |
| 5 | **Daily challenge + streak** (seed-deterministic level/exercise of the day) | Retention lever; nearly free given deterministic generators. | S–M | queued |
| 6 | **Guided onboarding mode** (graduated: seated L/R/front → turn → walk → clap) | Genre's #1 failure is onboarding; Kish/Thaler validate the curriculum. | M | later |
| 7 | **New game modes** (e.g. "throw a sound" decoy vs the noise-monster; sonar-budget stealth; orientation-panel hunt) | Build on existing primitives once the above foundation is solid. | M–L | backlog |

## Rationale
- **Accessibility before features.** Shipping more content on a game blind users can't
  even turn in would be backwards. #1 is the gate.
- **Parallelize independents.** #2 (materials) is already running — it doesn't touch the
  game loop, so it proceeds alongside #1.
- **Editor (#3) is a user-stated priority** and is the multiplier: better authoring →
  more/better levels → more reasons for the other modes.

## Immediate actions
- [in progress] #2 materials build (agent `a9e836…`).
- [next] #1 accessibility + game-feel quick wins — engineering build, then commit.
- Reconvene after #1 + #2 land (a "playtest review" meeting) to validate and pick from #3–#5.
