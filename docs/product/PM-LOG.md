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

**3A Editor SHIPPED** (`7e2c330`): absorber-patch tool, goal mode, clap-budget fields,
absorber round-trip bug fix, validate-on-save, autosave+guard. +11 tests (350 total).
**3B Trainer** still building (agent `a5f3dc5c…`); trainer files held uncommitted until done.

### Cycle 3 — Build COMPLETE
- **3A Editor SHIPPED** (`7e2c330`): absorber tool, goal mode, clap fields, round-trip
  fix, autosave. +11 tests.
- **3B Trainer SHIPPED** (`db2a062`): persistence + reversals/streaks + Thaler distance
  ladder + 4-way orientation drill. +31 tests. 381 total, tsc clean.

### Cycle 4 — Build (in progress)
- **3C e2e smoke harness** (agent `ac9602eb…`): Playwright (greenfield — was installed
  but unconfigured) covering the keyboard completion path, find-the-absorber, editor boot,
  help-key/a11y. Guards the accessibility win from silent regression.

### Known limitations / follow-ups (tracked, not blocking)
- 4-way orientation drill encodes the 4 classes as a single panel's tilt-about-horizontal
  (closest the image-source engine supports), not full multi-panel plank geometry. Revisit
  if richer orientation cues are wanted.
- Warmer beacon cue doesn't cover custom-audio (soundUrl) beacons — only the synth voice.
- Editor canvas is pointer-only (screen-reader a11y of the canvas is a separate larger track).
- Compass widget a11y + cardinal detents (G2) still open.

### Cycle 4 — Build (in progress)
- **3C e2e harness SHIPPED** (`faacebf`): Playwright, 8/8 green incl. REAL keyboard
  completion + absorber + editor + a11y. Guards the accessibility win.
- Cycle-3 review meeting held (`meetings/2026-06-29-cycle3-review.md`) → first new
  game content.
- **4A Sonar-budget survival** (agent `ad480127…`): spoken clap-budget feedback +
  out-of-claps tension + sonar-vault level. (clap mechanic already enforced; this is the
  experience layer.) Touches game/main + a level.
- **4C Daily Challenge + streak** (agent `adb19ce8…`): seed-of-the-day + localStorage
  streak + shareable score, spoken. Pure product layer. Touches trainer + a new daily module.
- Disjoint → parallel. Then **4B Stealth** (evade noise-hunter + decoy) after 4A frees game.ts.

**4A Sonar-budget SHIPPED** (`f977fd0`): spoken clap economy (routed to assertive region),
out-of-sonar tension, Sonar Vault level. +9 tests +3 e2e (391 unit, 11 e2e).
- **4C Daily Challenge** still building (agent `adb19ce8…`, trainer/daily.* — held).
- **4B Stealth mode** dispatched (agent `a9e4034a…`, game.ts/monster + stealth-escape level
  + throw-a-sound decoy). game.ts freed by 4A. Watch index.ts contention (4B adds a level).

**4C Daily Challenge SHIPPED** (`44cbdce`): clock-free daily seed + idempotent streak +
shareable score, spoken. +26 tests +2 e2e (417 unit, 13 e2e).
- **4B Stealth** still building (agent `a9e4034a…`, game.ts/load.ts/schema.ts +
  stealth-escape level + decoy). Its WIP has an in-progress tsc state — held until done.

### Cycle 4 — Build COMPLETE
- **4A Sonar-budget** (`f977fd0`), **4C Daily Challenge** (`44cbdce`), **4B Stealth+decoy**
  (`762bc73`). 424 unit + 16 e2e green. Product is now multi-mode: beacon, absorber,
  sonar-budget, stealth + a coaching trainer with daily challenges.
- Cycle-4 review meeting held (`meetings/2026-06-29-cycle4-review.md`): biggest gap is now
  the FIRST-RUN experience (4 modes a newcomer can't learn cold) — genre's #1 failure.

### Cycle 5 — Build (in progress, 2 parallel agents)
- **5A Guided onboarding** (agent `abdb7b14…`): graduated localization (L/R/front) +
  clap/mode primers, skippable + remembered. Extends tutorial machine. Owns src/ui/* + main gate.
- **5B Editor stealth authoring** (agent `a6ce22cf…`): goal:'escape' + exit tool +
  decoyBudget + monster clarity + lint; closes the 4B authorability gap. Owns editor/*.
- Disjoint → parallel. Then **5C** a11y polish (compass widget, cardinal detents, custom-
  audio warmer cue) after 5A.

**5B Editor stealth authoring SHIPPED** (`b609ee2`): goal=escape selector, exit tool,
decoy-budget field, monster labels + sound preview, lint, lossless round-trip. +12 tests (436).
- **5A Guided onboarding** still building (agent `abdb7b14…`, src/ui/* + main onboarding
  gate + per-mode primers) — held until done. Then 5C a11y polish.

**5A Guided onboarding SHIPPED** (`a06ca3e`): localization-first lesson (L/R/front on real
HRTF) + controls surfacing + per-mode primers (remembered, never re-wall). +4 tests +3 e2e
(436 unit, 19 e2e). Both 5A+5B done.
- **5C a11y polish** (agent `a2c1dbaa…`): compass aria-valuenow/valuetext, cardinal
  detents/ticks, custom-audio beacon warmer cue. Closes logged G1/G2/compass follow-ups.
- Then Cycle-5 review → more levels per mode + narrative/companion voice + async-ghost.

### Cycle 5 — Build COMPLETE
- **5A Onboarding** (`a06ca3e`), **5B Editor stealth authoring** (`b609ee2`), **5C a11y
  polish** (`491b969`). 448 unit + 20 e2e green. Foundations solid: 4 authorable modes,
  trainer w/ daily challenge, graduated onboarding, compass a11y.
- Cycle-5 review (`meetings/2026-06-29-cycle5-review.md`): thinner areas now are CONTENT
  DEPTH (1-2 levels/mode) and ENGAGEMENT PULL (no narrative/companion voice).

### Cycle 6 — Build (in progress, 2 parallel agents)
- **6A Level pack** (agent `a9291ccb…`): ~8-10 new levels giving each mode a difficulty
  arc + picker grouping; all solvability-tested. Owns src/levels/* + index.ts + levelPicker.
- **6B Companion-voice layer** (agent `ab599eb6…`): optional characterful spoken guide
  keyed by (mode,event), rate-limited, remembered, ?companion=off. Owns game/companion.ts +
  main.ts wiring.
- Then **6C** settings/mix (volume, companion toggle, reset) after 6B.

**6A Level pack SHIPPED** (`2e7979e`): +10 levels (2-3/mode, easy→hard) + picker grouping
by category. +8 tests (456). FLAGGED for ear-check: stealth AI catch-dynamics (decoy bait,
foam-corridor audibility) reasoned not tested.
- **6B Companion voice** still building (agent `ab599eb6…`, game/companion.ts + main.ts +
  onboardingStore companion flag) — held until done. Then 6C settings/mix.

**6B Companion voice SHIPPED** (`e1168b0`): optional spoken guide keyed by (mode,event),
deterministic variety, rate-limited, sequenced after critical cues, ?companion=off persists.
+18 tests +2 e2e (474 unit, 22 e2e). Both 6A+6B done.
- **6C Settings/mix** (agent `a8064e4b…`): spoken settings panel — master volume,
  companion toggle, warmer-cue toggle, L/R swap / re-calibrate, reset progress. Persisted +
  applied on load. Then Cycle-6 review.

### Cycle 6 — Build COMPLETE
- **6A Level pack** (`2e7979e`), **6B Companion voice** (`e1168b0`), **6C Settings**
  (`04a1b21`). 486 unit + 23 e2e. Product is feature-rich: 4 modes, 27 levels, trainer +
  daily, onboarding, companion, settings, full a11y.
- Cycle-6 review (`meetings/2026-06-29-cycle6-review.md`): after 18 builds, HARDEN before
  widening. Risks: unverified-by-ear tuning (stealth AI, levels, mix) + cohesion drift.

### Cycle 7 — Consolidate & verify (in progress, 2 parallel agents)
- **7A Stealth-AI sim verification** (agent `a786eaf4…`): headless monster-AI simulation
  turning "reasoned not tested" stealth tuning into real tests; tune failing levels.
- **7C PWA/docs/release-readiness** (agent `a4e852bf…`): FIX broken PWA icons (manifest
  references nonexistent assets/icons/*), add public/_headers (COOP/COEP for deployed Steam
  path), refresh TECHNICAL/PRODUCT/DEPLOY docs. Closes items open since session start.
- Then **7B cohesion** (controls source-of-truth, announcement-phrasing audit).
- Authored `NEEDS-PLAYTEST.md` — the honest list of what only a human ear can confirm.

**7A Stealth-AI sim SHIPPED** (`2cfc89e`): headless monster-AI simulation; all 3 stealth
levels verified as built (careful route survivable, loud route caught, decoy lures warden).
+7 tests (493). No JSON tuning needed, no AI bugs. Margin note: foam = inaudible (binary).
- **7C PWA/docs** still building (agent `a4e852bf…`, icons + _headers + DEPLOY/HOWTOPLAY/
  TECHNICAL/PRODUCT docs) — held until verified (needs `npm run build` to confirm icons in dist).

**7C PWA/docs SHIPPED** (`d55ae67`): fixed broken PWA icons (sonar-ping motif, valid
192/512/maskable PNGs verified in dist) — open since session start; production _headers
(COOP/COEP); DEPLOY/HOWTOPLAY + refreshed PRODUCT/TECHNICAL docs. Build OK, 493 tests.
- **7B Cohesion** (agent `a66bf88d…`): single controls/help source of truth (controls.ts
  consumed by speakControls + tutorial + HOWTOPLAY) + announcement-phrasing/clobbering
  audit. Behavior-preserving. Then Cycle-7 review.

**7B Cohesion SHIPPED** (`2888f34`): single controls source of truth (controls.ts) + found
& fixed a real announcement clobber (sonar budget-intro vs mode primer in assertive region).
+5 tests (498). Cycle 7 (harden & verify) COMPLETE.
- Cycle-7 review (`meetings/2026-06-29-cycle7-review.md`): product release-ready + coherent
  → return to breadth (engagement/replay).

### Cycle 8 — Engagement & replay (in progress, 2 parallel agents)
- **8A Web Speech companion voice** (agent `aeeb3eca…`): optional real TTS (voice/rate/pitch
  in settings), default OFF (avoid screen-reader double-speak), graceful fallback. Owns
  src/ui/speech.ts + settings + main say/alert hookup.
- **8B Scoring + per-level bests** (agent `a4b33b0b…`): time/claps per level, localStorage
  bests, "New best!" announce; seeds a leaderboard. Owns scoreStore + game.ts instrumentation.
- Both touch main.ts (different spots) — commit carefully. Then **8C** sandbox generator.

**8A Web Speech TTS** done (agent reported): optional spoken voice, default OFF
(screen-reader double-speak avoidance), graceful fallback, settings voice/rate/pitch +522
tests. NOT yet committed — 8A and 8B are ENTANGLED in main.ts/game.ts (8B wove ScoreStore/
announceCompletion in alongside 8A's Speech). 8B (`a4b33b0b…`) still running. Plan: commit
8A+8B TOGETHER as one "engagement layer" commit when 8B reports (splitting interwoven hunks
is error-prone). Tree currently green (522, tsc clean).

**8A+8B Engagement layer SHIPPED together** (`4f49b3f`, entangled in main/game): optional
Web Speech TTS (default OFF, graceful fallback) + per-level time/clap scoring with bests &
"New best!" announce + picker best display. +38 tests (536 unit, 25 e2e).
- **8C Sandbox generator** (agent `a2708409…`): pure seeded level generator (mode ×
  difficulty → solvable Level), endless freeplay, picker sandbox UI. Owns sandbox.ts +
  picker + main start flow. Then Cycle-8 review → leaderboard.
- NEEDS-PLAYTEST grew: TTS default-off tradeoff + voice quality; generated-level fairness.

**8C Sandbox SHIPPED** (`e5c8035`): pure seeded generator (mode×difficulty→solvable Level),
800-level fuzz, picker sandbox UI. +37 tests (573 unit, 26 e2e). Cycle 8 COMPLETE.
- Cycle-8 review (`meetings/2026-06-29-cycle8-review.md`): diminishing returns on raw
  breadth → bias to PROVE QUALITY + make work reviewable. Biggest risk = unverified-by-ear
  (NEEDS-PLAYTEST ~10 items, only the user can resolve).

### Cycle 9 — Engagement closer + harden + hand-off (in progress)
- **9A Local leaderboard** (agent `aa7c5f1f…`): "Best Times/Progress" summary screen over
  scoreStore + dailyStreakStore (cleared count, per-mode bests, streak), spoken. Owns
  progressSummary + a progress screen + picker entry.
- **9B Full regression + bundle/perf audit** (agent `aab0847b…`): run all unit+e2e, build,
  verify default bundle stays lean (three/steam lazy), perf sanity, dead-code scan → report.
- Then **9C** session hand-off doc + consolidated NEEDS-PLAYTEST with exact URLs/steps.

**9A Leaderboard + 9B audit SHIPPED** (`fd6301c`): Progress/Best-Times screen; regression
audit CLEAN (no regressions, default bundle lean, perf sane). +10 tests (583).
**Audit follow-ups SHIPPED** (`199a090`): PWA precache 7.2MB→488KB (exclude lazy Steam
assets), removed dead setProximity.
**9C Hand-off SHIPPED**: SESSION-HANDOFF.md (full review guide + URLs) + consolidated
NEEDS-PLAYTEST. Cycle 9 COMPLETE.

### Session totals
~24 feature/infra builds across 9 cycles. 583 unit + 26 e2e green, tsc clean, build OK,
release-ready. Product: 4 modes, 26 levels + infinite sandbox, trainer + daily, scoring,
companion+TTS, onboarding, settings, editor authoring, full a11y, PWA. The remaining work
is ear-dependent (NEEDS-PLAYTEST / SESSION-HANDOFF §4) — the user's call.
