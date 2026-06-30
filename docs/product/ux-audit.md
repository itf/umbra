# Papa Sangre — UX & Accessibility Audit

Audience: blind / low-vision players of an eyes-free, headphone-only navigation game,
plus level authors using the 2D editor. This audit is based on reading the shipping
code (no changes were made). File:line citations point at the exact code reviewed.

Scope reviewed: `index.html`, `src/main.ts`, `src/ui/*`, `src/game/*`, `src/editor/*`,
`src/level/schema.ts`, `src/trainer/*`.

---

## TL;DR — what's already strong

The accessibility foundations are unusually good for a game:

- Dual ARIA live regions — `#status` (`aria-live="polite"`) and `#alerts`
  (`role="alert" aria-live="assertive"`) — `index.html:20-21`, driven by `say()` /
  `alert()` in `src/main.ts:68-73`. Steps, stumbles, win, caught, progress, and clap
  budget are all announced.
- First-run onboarding gate (calibration → tutorial → Begin) with completion
  remembered in localStorage: `src/main.ts:150-178`, `src/ui/onboardingStore.ts`.
- L/R + volume calibration is genuinely eyes-free with swap detection and a toggle:
  `src/ui/calibration.ts:98-241`, `src/ui/calibrationMachine.ts:107-116`.
- A narrated, interactive 3-lesson tutorial (step / turn / clap), skippable and
  replayable: `src/ui/tutorial.ts:116-220`.
- Focus is moved to the first actionable control on every screen
  (`src/main.ts:141,186,219`; `calibration.ts:51-52`; `tutorial.ts:47-48`).
- The echolocation trainer is screen-reader-first with a rigorous 2-down/1-up adaptive
  staircase: `src/trainer/trainer.ts`, `src/trainer/adaptive.ts`.

The gaps below are mostly *missing continuous feedback* and *missing editor surface for
features the schema already supports* — not broken foundations.

---

## (a) Top accessibility gaps — prioritized

### A1 — CRITICAL: keyboard / screen-reader users cannot TURN in the actual game
The shipped game wires turning **only** through the drag-based `Compass`
(`src/main.ts:440-476`). The keyboard handler binds **A = left step, L = right step and
nothing else** (`src/main.ts:381-385`). Arrow keys are described as "reserved for
turning" in the start screen hint (`index.html:57`) but **no arrow handler exists on the
game screen** — they do nothing.

Note: a fully keyboard-accessible `TurnControl` with `ArrowLeft`/`ArrowRight` nudging and
a spoken `headingDescription` **does exist** (`src/game/turnControl.ts:107-134`) — but it
is only imported by the debug overlay (`src/debug/debug.ts:15`), never by `main.ts`. So a
keyboard-only or screen-reader user can step but cannot change heading → the game is
effectively unwinnable without a pointer/touch drag. This is the single highest-priority
fix.
Fix: mount `TurnControl` alongside (or instead of) `Compass` in `setupTurning`, bind
Arrow keys, and announce heading changes via the existing `say()`.

### A2 — HIGH: the Compass has no accessible semantics
`src/game/compass.ts` builds an SVG dial with pointer drag only — no `role`,
`aria-label`, `aria-valuenow`, or keyboard handling. Even with A1 fixed, the visible
control is opaque to assistive tech. Give it `role="slider"` semantics or pair it with
the `TurnControl` keyboard surface and a live heading read-out (e.g. "facing north",
"facing 30° right of start").

### A3 — HIGH: no in-game help / shortcut reference reachable eyes-free
The only place keys are documented is a visual `<p class="hint">` on the start screen
(`index.html:57`) that is never announced. There is no `?`/help affordance from the
picker or game. Add a "How to play (keyboard & gestures)" item to the picker `nav`
(`index.html:30-35`) that announces the control scheme.

### A4 — MEDIUM: tone/clap playback fires silently (no "playing now" cue)
Calibration probes (`calibration.ts:73-96`), the volume tone (`calibration.ts:138-156`),
and the in-game clap (`main.ts:517-542`) start the audio with no preceding announcement.
An eyes-free user who missed the spatial tone has no confirmation it played. Speak
"Tone playing on your left…" / "Clapping…" *before* the sound, and consider a short
neutral lead-in click.

### A5 — MEDIUM: clap-budget announcement can be clobbered
`setupClap` announces the starting budget via `alert(...)` (`main.ts:512-515`) but the
intro `say('Walk to the beacon…')` (`main.ts:401`) lands immediately after. The polite
status line is overwritten; only the assertive region survives. Verify the budget
announcement is reliably heard (it currently uses `alert`, which is correct — keep it on
the assertive region and do not downgrade to `say`).

### A6 — LOW: messaging assumes sight; no step-of-N progress
- "Close your eyes" (`index.html:51`) assumes a sighted user; reframe as "Play eyes-free
  / audio-only".
- Calibration and tutorial never announce progress ("Step 2 of 4", "Lesson 1 of 3")
  (`calibration.ts:98-134`, `tutorial.ts:116-220`).
- The skip-link target is hard-coded to `#step-left` (`index.html:16`), which doesn't
  exist on the picker/calibration/tutorial screens.

---

## (b) Game-feel friction points + fixes

Core movement and the loss state are well-tuned; the weaknesses are all in *continuous
navigation feedback*. (Stepping: `player.ts:107-142`; material footstep synthesis:
`footsteps.ts`, `stepSounds.ts`; listener glide: `listenerGlide.ts:33`.)

| # | Friction | Where | Fix |
|---|----------|-------|-----|
| G1 | **No "getting warmer" audio for the beacon.** Distance is computed and spoken only in coarse bands (`updateFootHints`, `main.ts:430-438`), but beacon loudness/pitch is constant — directional only. | `game.ts` beacon render; `main.ts:430-438` | Scale beacon level (and/or pulse rate) continuously with proximity so closing in is *heard*, not just narrated. |
| G2 | **No heading confirmation while turning.** Only the beacon's spatial shift hints at rotation; no "you turned"/cardinal cue. | `main.ts:440-476`, `compass.ts` | Add a soft detent tick at cardinal/start headings and a spoken heading read-out (reuse `headingDescription`, `turnControl.ts:128-134`). |
| G3 | **Win is nearly silent.** Win just fades the beacon over 0.3s (`game.ts` win path) while loss has a dramatic catch roar (`monsterSounds.ts:113-154`). Asymmetric and anticlimactic. | `game.ts` onWin | Add a short victory flourish/arrival chime so success is as legible as failure. |
| G4 | **No wall-approach warning.** Collision is detected *after* a step and undone with a bump (`game.ts` collide path). | `game.ts` step collision | Optional "wall ahead" proximity cue on the clap, or a faint edge tone when a step would collide, before committing. |
| G5 | **Monster distance/phase not legible.** Threat is a spatialized growl + Doppler + catch roar (`monsterSounds.ts`, `noiseEvents.ts:49`), but there's no sense of how close it is or whether it's actively tracking. | `monster.ts`, `monsterSounds.ts` | Map growl intensity/filter to real distance; add a subtle cue when the monster (re)acquires your noise trail. |
| G6 | **Settle/"feet together" cue is very quiet** (level 0.18 vs steps 0.32–0.55, `footsteps.ts:45-50`), so "you may now lead with either foot" is easy to miss. | `footsteps.ts:45-50` | Raise level slightly or add a distinct settle motif. |

---

## (c) EDITOR feature backlog (prioritized S/M/L)

> This is the priority area: the goal is "a nicer interface to create levels with more
> features." The editor (`src/editor/editor.ts`) is a canvas-only, pointer-driven 2D map
> that can place start / beacon / wall (+motion) / floor / ceiling / monster, edit room
> dims + default materials + open/ceiling toggles + speed of sound, and save / load /
> export / import JSON (`editor.ts:442-497`, `src/level/storage.ts`). It has a beacon
> sound *preview* (`editor.ts:307-319`). Roughly **75% of the schema is authorable.**

### Schema features the editor CANNOT author today
Verified against `src/level/schema.ts` and the bundled levels:

| Schema field | Used by level | Editor UI? |
|--------------|---------------|-----------|
| `absorbers: WallPatch[]` (`schema.ts:147-155,228`) | `find-the-foam.json` | **NONE** |
| `goal: 'beacon' \| 'absorber'` (`schema.ts:226`) | `find-the-foam.json` | **NONE** |
| `clapBudget`, `clapCooldownMs` (`schema.ts:207-209`) | `clap-maze.json` | **NONE** |
| multiple beacons — only the *first* is the goal (`schema.ts:224,231`) | — | placeable, but role not surfaced |
| `WallObj.motion` translate/slide (`schema.ts:69-101`) | `sliding-door.json` | yes (`editor.ts:254-274`) |
| `speedOfSound` (`schema.ts:218`) | `slow-sound-vault.json` | yes (`editor.ts:410-418`) |
| `CeilingZone.height` steps (`schema.ts:122-130`) | `stepped-ceiling-alcove.json` | yes (`editor.ts:278-281`) |

Note `objectListModel` (`src/editor/objectList.ts:38-47`) doesn't even enumerate
absorbers, so a level with foam patches loaded into the editor silently hides them.

### Backlog

**Small (S)**
- **S1 — Goal-mode selector** (`beacon` vs `absorber`). One dropdown writing `level.goal`.
  Unlocks the existing "find the absorber" mode in-editor.
- **S2 — Clap budget / cooldown fields.** Two number inputs writing `clapBudget` /
  `clapCooldownMs` (mirror the existing `speedOfSound` input pattern, `editor.ts:410-418`).
- **S3 — Monster sound preview button.** The beacon already has one
  (`editor.ts:249,307-319`); reuse it for `MONSTER_PRESETS`.
- **S4 — "Primary beacon" badge.** Mark which beacon is the goal in the object list /
  props so multi-beacon intent is clear (`objectList.ts`, `editor.ts:240-250`).
- **S5 — Validate-on-save / lint.** Warn on absorber-goal levels with no absorbers, start
  outside the room, beacon unreachable, etc., via the `alert`/`flashHint` channel.

**Medium (M)**
- **M1 — Absorber patch tool (the big one).** A tool to place a `WallPatch`: pick a
  perimeter face (`-x/+x/-z/+z`) and drag a rectangle in face-space (`u0,v0,uSize,vSize`),
  plus material. Add it to the toolbar, `hitTest`, `findObj`, `moveObject`,
  `deleteSelected`, `renderProps`, and `objectListModel`. Directly enables foam/dead-spot
  levels without hand-editing JSON.
- **M2 — Per-wall absorber via face split.** Friendlier alternative/complement to M1:
  drag a sub-segment of a perimeter wall and assign it a different material; the loader
  already splits wall polygons for patches (`schema.ts:144-145`).
- **M3 — Acoustic preview in-editor.** Today only a dry beacon tone plays. Add a "clap
  here" preview that runs the same `ClapRoom` solver the game uses, from a chosen point,
  so authors can *hear* a room without launching the game.
- **M4 — Autosave / unsaved-changes guard.** Edits are lost on reload (no autosave;
  `editor.ts:442-497`). Add debounced autosave to the "current" slot and a beforeunload
  warning.
- **M5 — Undo/redo.** No history exists; destructive edits (delete, move) are
  irreversible.

**Large (L)**
- **L1 — Accessible editor.** The canvas is pointer-only and opaque to screen readers
  (no keyboard placement, no live announcements on place/select/move). Add: keyboard tool
  selection (e.g. 1–8), keyboard nudge/place of the selected object, and an ARIA live
  region announcing placements and selections. This makes the editor usable by the same
  blind authors the game serves — currently they cannot author at all.
- **L2 — Templated/guided level creation.** Wizards for the established level *types*
  (room-with-beacon, find-the-foam, clap-maze, monster-cellar, open-street) that
  pre-populate the right fields and goal mode, lowering the authoring floor.
- **L3 — Symmetry / array / mirror tools** for building mazes and corridors quickly
  (duplicate, mirror across an axis, snap-to-grid corridors) beyond the current 0.5 m
  snap (`editor.ts:73-75`).

---

## (d) Trainer motivation / progression improvements

The trainer is structurally excellent (9 fair single-dimension exercises in
`src/trainer/exercises.ts`; 2-down/1-up staircase converging to ~71% in
`src/trainer/adaptive.ts:85-135`; aria-live + keyboard + autofocus in
`src/trainer/trainer.ts:48-50,228`). It is **motivationally hollow** — and crucially it
**persists nothing**: there is no `localStorage` anywhere in `trainer.ts` /
`exercises.ts` / `adaptive.ts`, so score, threshold and staircase state reset on every
reload (`trainer.ts:35-37`).

Improvements, roughly by impact-per-effort:

- **T1 (S) — Persist sessions.** Save threshold history + trial counts to localStorage
  (mirroring `onboardingStore.ts`); on load, announce "Last session: ~68% difficulty, 12
  reversals." Turns isolated drills into visible long-term progress.
- **T2 (S) — Announce reversals & streaks.** Reversals are tracked internally
  (`adaptive.ts:51-52,112`) but never surfaced. Announce "Reversal — stepping up" and
  "Correct, 3 in a row" for intrinsic reward.
- **T3 (S) — Sonic reward on answer.** Feedback is text-only (`trainer.ts:227`); add a
  pleasant tone for correct / neutral tone for incorrect — fitting for an audio game.
- **T4 (M) — Session goals / finish line.** Optional "stop after N reversals / N trials /
  M minutes," announced on completion. Open-ended drilling has no end state today.
- **T5 (M) — Exercise progression / unlocks.** All 9 types are mixed randomly, so a
  beginner can hit the hardest (gap/distance) on trial 1. Gate harder exercises behind
  early mastery: size → materials → direction → reflector/distance/gap.

---

## (e) Five highest-impact, lowest-effort changes to do first

1. **Wire up keyboard turning in the real game (A1).** Mount the existing
   `TurnControl` (`src/game/turnControl.ts`) in `setupTurning` and bind Arrow keys. This
   alone takes the game from "unplayable without a pointer drag" to keyboard-completable —
   the biggest accessibility win for the least code.
2. **Continuous "getting warmer" beacon cue (G1).** Scale beacon loudness/pulse with
   distance so closing in is audible, not just narrated in 4 bands.
3. **Add a victory flourish on win (G3).** A short arrival chime so success is as
   legible as the catch roar — trivial change, big satisfaction gain.
4. **Editor: goal-mode dropdown + clap-budget fields (S1 + S2).** A few inputs unlock
   two whole level modes (find-the-absorber, sonar-budget) that the schema already
   supports but the editor can't author.
5. **Persist trainer progress + announce reversals/streaks (T1 + T2).** Small
   localStorage layer + two announcements convert the trainer from a one-shot drill into
   a motivating coach.

---

## Appendix — new audio-only game ideas (using existing engine primitives)

The engine already has: modeled room acoustics + clap solver, moving walls
(`schema.ts:69-101`), variable speed of sound (`schema.ts:218`), absorber dead-spots,
noise-trail monster AI (`monster.ts`, `noiseEvents.ts`), and per-material footsteps.
Cheap-to-prototype modes on top of these:

- **Sonar budget escape** — fully realize `clapBudget`/`clapCooldownMs` as a survival
  mode: limited claps to map a maze and reach the exit.
- **Stealth past the monster** — lean into the noise-trail AI (`monster.ts`): cross soft
  vs loud floors to manage the sound you leave; reaching the beacon requires routing over
  carpet/foam to stay quiet.
- **Echo cartographer** — clap to "map" a hidden room, then answer questions about it
  (how many exits, where's the alcove) — a game-ified version of the trainer's
  reflector/gap exercises (`exercises.ts:325-498`).
- **The shifting maze** — use `WallMotion` translate/slide doors so the route changes in
  real time and must be re-heard each pass.
- **Alien acoustics levels** — `speedOfSound` extremes (already in
  `slow-sound-vault.json`) as a perception-bending challenge series.
- **Find-the-foam hunt** — expand the absorber mode into a series of escalating
  dead-spot searches with shrinking patches.
