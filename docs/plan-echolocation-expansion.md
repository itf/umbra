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

## TRACK F — Sequence / multi-beacon mode  [serial, orchestrator]
User: a mode where you find MULTIPLE beacons in sequence — reaching beacon N starts
beacon N+1 playing and stops beacon N (arrival-triggered events). The LEVEL EDITOR
must expose this.
- [ ] Schema: an ordered `sequence: [beaconId...]` on the level. Only ONE beacon is
      audible at a time: the first sounds at start; reaching it silences it and starts
      the next; etc. Each non-active beacon is silent.
- [ ] Game: WIN = reach the FINAL beacon (single win target). Because every earlier
      beacon must sound-then-go-silent to reveal the next, the player is naturally led
      through all of them in order — no separate "collected N" counter needed. Arrival
      at beacon k (within goalRadius) fades k out + starts k+1. Reuse multi-beacon plumbing.
      The win target is just the last beacon (off-axis-start already handles facing).
- [ ] Off-axis start applies to the FIRST beacon (already generalized via winTarget).
- [ ] Editor: expose sequence authoring (order the beacons; mark sequence mode).
- [ ] Tests for the sequence progression + editor round-trip.

## PM REVIEW FINDINGS (2026-06-30) — fold into tracks
- P0 On-screen DECOY button (stealth unwinnable on mobile — keyboard-only T). [mobile parity]
- P0 Reaction mode clarity → TRACK B (agent running): announce event onset, confirm hits,
     speak "N reactions left", tutorial, and the OCCLUSION-DIP event type.
- P1 /credits route + accessible screen (landing link currently 404s) → TRACK C.
- P1 Wire clickProbe.ts as the ACTUAL probe (currently dead code; live probe is a noise
     burst in clapRoom.ts) — at least in the trainer, ideally the game echo too.
- P1 Real /train route (fold trainer into SPA) or clearly frame trainer.html as separate.
- P1 L2 present/absent 2AFC + silence catch-trials, as the tutorial → TRACK A.
- P2 Gate localization exercises behind detection mastery.
- Risk: silent win-failure when requiredReactions unmet (reach goal, no win, no reason).
- Risk: misconfigured event sourceId silently no-ops (no author warning).
- Stale docs/product/ux-audit.md claims (keyboard-turn + trainer persistence) — retire/annotate.

## DONE (additional)
- [x] Off-axis start: player never starts facing the goal within 5°; small ≤45°
      deterministic turn so you must orient by ear (never spun at a wall). load.ts.
- [x] Sequence (trail) mode — engine + game + EDITOR + tests (TRACK F complete).
- [x] Reaction fix + occlusion-dip event + onboarding (TRACK B) — merged.
- [x] Click-types help page /clicks + Credits screen /credits — built + WIRED (TRACK C/D).
- [x] On-screen Decoy button (mobile stealth parity) — PM P0.
- [x] Input/settings: debug toggle, auto-step, probe key, arrow remap.

## DONE (probe + trainer wave)
- [x] Realistic clickProbe wired: selectable in the trainer probe dropdown + a game
      "Realistic click probe" setting (noise-burst default unchanged). PM P1.
- [x] Trainer L1 (click calibration, unscored) + L2 (present/absent 2AFC detection with
      ~1/6 silence catch-trials, placed first so it interleaves early). PM P1.
- [x] Landing "Train" opens the trainer page directly.

## STILL OPEN (next)
- [ ] Real /train route (fold trainer.html into the SPA) — deferred (separate Vite entry).
- [ ] Gate localization exercises behind detection mastery (P2).
- [ ] Retire/annotate stale docs/product/ux-audit.md.

## Probe sound assets follow-up
- [x] ffmpeg processing done (trim/mono/48k/normalize, ogg only).
