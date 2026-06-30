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
