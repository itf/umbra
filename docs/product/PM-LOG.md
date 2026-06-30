# Product Development Loop — PM Log

Autonomous product-development loop. Acting as PM: brainstorm → research → build →
test (incl. e2e) → commit, spawning subagents (research, design, UX, engineering),
holding cross-functional "meetings" with notes after each major change. Goal: make
papasangre a better experience for users. Running until told to stop.

## Operating cadence
1. **Discovery** — parallel research agents (landscape, data, UX) → synthesize.
2. **Meeting** — PM + UX + design + eng review findings → pick next build (notes in `meetings/`).
3. **Build** — engineering agent(s) implement a vertical slice; tests + tsc gate.
4. **Verify** — run suite, build, (e2e where possible); fix findings.
5. **Commit** after each major change. Loop.

## Principles
- Eyes-free, accessibility-first (the core audience is blind/low-vision).
- Build on existing engine strengths (reflections, materials, occlusion, Doppler,
  moving walls, monsters, HRTF, the click-free interpolating renderer).
- Every shipped change: tsc clean + tests green + committed. No regressions to the
  default game.
- Prefer small, complete vertical slices over half-built breadth.

## Cycle log

### Cycle 1 — Discovery (in progress)
Spawned 3 research agents:
- Audio-game landscape & mechanics → `research-audio-games.md`
- Acoustic materials datasets (expand the palette) → `materials-research.md` + `materials-proposed.json`
- UX audit + editor backlog → `ux-audit.md`
Next: synthesis meeting → roadmap → first build.

**Cycle 1 progress:**
- ✓ `research-audio-games.md` landed. Headline: the Thaler 10-week echolocation study
  gives evidence-backed trainer milestones (adaptive distance ladder; 4-way orientation
  drill); onboarding/UI is the #1 cited audio-game failure (cheap to fix, high impact);
  daily streak + adaptive difficulty are the retention levers; Kish FlashSonar validates
  a graduated guided onboarding. Note: cross-references an existing `docs/ideas/brainstorm.md`.
- ✓ `materials-proposed.json` landed (20 materials, cited 8-band absorption + scattering;
  2 name-overlaps with existing water/marble; has extra fields source/notes to strip at merge).
- … `materials-research.md` pending (the rationale/contrast report).
- … `ux-audit.md` pending (accessibility + editor backlog).
- Likely early builds: (1) expand material palette + add to material-ID trainer drill;
  (2) onboarding/accessibility quick wins; (3) editor feature backlog; (4) adaptive
  distance ladder + daily challenge. Final order set at the synthesis meeting.

**Cycle 1 — Discovery COMPLETE.** All 3 research docs in; synthesis meeting held
(`meetings/2026-06-29-cycle1-synthesis.md`); roadmap set. Committed.

### Cycle 2 — Build (in progress, 2 parallel engineering agents)
- **#1 Accessibility + game feel** (agent `a56c898f…`): keyboard turning (THE gate —
  game was uncompletable without a mouse drag), continuous "getting warmer" beacon cue,
  win chime, "how to play" key. Touches main.ts/game.ts/beaconSounds.ts.
- **#2 Materials + material-ID drill** (agent `a9e836c4…`): merge 20 cited materials,
  reconcile water/marble, separable-7 material-ID set. Touches materials.ts/exercises.ts.
- Disjoint files → safe in parallel. Gate each on tsc + tests, commit separately.
- Next meeting: "playtest review" after #1+#2 land → pick from #3 editor / #4 trainer / #5 daily.

**#2 Materials SHIPPED** (commit `5066fe2`): +18 cited materials, water/marble reconciled,
easy→hard material-ID ladder + "which wall is metal" drill, +10 tests (328 total).
**#1 Accessibility** still building (agent `a56c898f…`); its files (index.html,
beaconSounds.ts, game.ts, heading.ts, main.ts, tests/heading.test.ts) held uncommitted
until it finishes, then commit + run full suite + playtest-review meeting.

### Cycle 2 — Build COMPLETE
- **#1 Accessibility SHIPPED** (`006e625`): keyboard turning [the gate], warmer cue,
  win chime, help key. +21 tests. 339 total.
- **#2 Materials SHIPPED** (`5066fe2`).
- Playtest-review meeting held (`meetings/2026-06-29-cycle2-playtest-review.md`).

### Cycle 3 — Build (in progress, 2 parallel agents)
- **3A Editor authoring** (agent `a2833af0…`, USER PRIORITY): fix absorber silent-hide
  bug, goal-mode selector, clap-budget fields, primary-beacon badge, absorber-patch tool,
  validate-on-save, autosave+guard. Touches editor/* + schema.
- **3B Trainer progression** (agent `a5f3dc5c…`): persist sessions (localStorage),
  announce reversals/streaks, Thaler adaptive distance ladder + 4-way orientation drill.
  Touches trainer/*.
- Disjoint → parallel-safe. Then **3C** e2e smoke harness (keyboard completion path +
  absorber mode). Commit each on green; reconvene for Cycle-3 review.
