# Plan — Echolocation training + reaction/occlusion + content (orchestration)

Consolidated from the user's instructions. Tracks marked **[parallel]** are independent
enough to run as isolated worktree subagents; **[serial]** touch shared files
(main.ts/router) and are done in sequence by the orchestrator.

## Guiding principles (apply to every track)
- **Mobile parity**: every keyboard action needs an on-screen touch equivalent. The app
  runs on phones with no keys. Auto-step is the one intentional keyboard-only exception.
- **Accessibility / eyes-free**: everything announced; semantic HTML; focus management.
- **Interleaving over repetition**: within any training level/staircase, ALTERNATE the
  relevant problem types — never drill one exercise over and over (research: interleaved
  practice beats blocked). See src/trainer/ for the existing scheduler to extend.
- **Test + review + commit** each track: add tests, run a review agent, then commit.
- Ground click/probe work in the 2017 Thaler/Reich model (already ported in
  src/game/clickProbe.ts) and docs/echolocation-training.md.

## Status legend: [ ] todo · [~] in progress · [x] done

## DONE (committed)
- [x] Post-level victory menu (repeat/explore/next/harder)
- [x] New beacon sounds (chime/harp/kalimba/glass)
- [x] CC click assets downloaded + processed + attributed (public/audio/clicks/, CREDITS.md)
- [x] Realistic mouth-click probe synthesis (clickProbe.ts, 2017 model + jitter)
- [x] Click-types content data (src/content/clickTypes.ts) + docs/click-types.md
- [x] Monster ignores soft-floor steps (carpet/grass sneakable)
- [x] Path routing + landing/about page (/, /play, /level/:id, /progress)
- [x] Input/settings: debug-overlay toggle (G + Settings), auto-step (hold W/Up),
      Down = probe, Up/Down no longer turn.

## TRACK A — Trainer: L1/L2 + adaptive staircase + interleaving  [serial, orchestrator]
The existing src/trainer/ already covers most of L4–L12 (reflector/direction/distance/
estimate/size/orientation/gap/material/metal). The research-backed GAPS:
- [ ] **L1 Click calibration**: play the canonical mouth click (clickProbe.ts); optional
      record-your-own (src/trainer/clickRecorder.ts exists); show it's your probe. No room.
- [ ] **L2 Present/absent detection (2AFC)** ⭐ the canonical entry task: a reflective
      panel present vs. absent; "something / nothing". Include **silence catch-trials**
      (no-click control) to prove echo, not artifact, is used (Thaler control).
- [ ] **Adaptive staircase** (2-down-1-up ≈ 71%) driving the difficulty knob per level,
      shared across exercises. Pure + tested.
- [ ] **Interleaving within a level**: extend the scheduler so a level rotates its
      RELEVANT exercise variants rather than repeating one. Verify existing interleave
      scheduler (memory: "interleaved practice scheduler") and generalize.
- [ ] Wire the realistic clickProbe.ts as the trainer's probe sound.
- [ ] Trainer routes: /train (repoint landing "Train" button from /play → /train).
- Commit L1/L2+staircase first; then subsequent rungs/polish in separate commits.

## TRACK B — Reaction / occlusion mode  [parallel worktree]
User: "create levels/a mode which depend on reaction, i.e. press a button when something
occludes the sound source a bit." Also: existing reaction/events "doesn't work or needs
more instructions" — FIX + document it.
- [ ] Investigate the existing reaction/events mechanic (src/game/ events, onReaction,
      requiredReactions; ui + main.ts). Determine why it feels broken / unclear.
- [ ] Add an **occlusion-dip** event type: the beacon/source is briefly partly occluded
      (a level/HF dip); the player presses React when they detect it. Signal-detection
      scoring (hit/miss/false-alarm) already exists — reuse.
- [ ] Clear instructions/onboarding for the reaction mode (the current gap).
- [ ] On-screen React button already exists — ensure mobile parity + a key.
- [ ] Tests for the occlusion event generation + detection scoring.

## TRACK C — In-app Credits / Licenses screen  [serial, small]
- [ ] /credits route + screen listing CREDITS.md attributions (clicks CC0/CC-BY-SA),
      HRTF/SOFA, Steam Audio, etc. Landing already links to /credits (currently 404→landing).
- [ ] Accessible + focusable; link back to landing.

## TRACK D — "Types of clicks" help page + per-click "?"  [parallel worktree]
- [ ] A page (route or modal) rendering src/content/clickTypes.ts: each click's how-to-make,
      articulation, acoustics, probe suitability; play its sample (manifest.json) + the
      synthetic probe.
- [ ] Per-click "?" info buttons (from clickTypes) next to click selectors where used.
- [ ] Simple original mid-sagittal SVG articulation diagrams (no free ones exist on Commons
      per docs/click-types.md) OR clearly-marked placeholders.
- [ ] Mobile + eyes-free accessible.

## TRACK E — PM review  [agent, when enough has landed]
- [ ] Spawn a product-manager agent to review the whole app state (game + trainer +
      landing + a11y + mobile) and produce a prioritized findings/roadmap report.

## Probe sound assets follow-up
- [x] ffmpeg processing done (trim/mono/48k/normalize, ogg only).
