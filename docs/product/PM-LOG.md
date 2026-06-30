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
