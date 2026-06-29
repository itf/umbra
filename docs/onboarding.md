# Onboarding: calibration + guided tutorial

New players — especially eyes-closed / screen-reader users — used to be dropped
straight into the game with no help. Onboarding fills that gap with two
fully eyes-free flows that run once on first play and are replayable any time:

1. a **calibration check** (headphones on the right ears + volume), and
2. a **guided 3-lesson tutorial** (stepping, turning, clapping).

Both are skippable, remember completion in `localStorage`, and are replayable
from the level picker.

---

## Flow / where it fits

The entry flow in `src/main.ts` is: picker → choose a level → **onboarding gate**
→ Begin screen → game. The gate (`gateOnboarding`) runs any not-yet-completed
onboarding before the Begin screen:

- calibration not done → run calibration, then re-check the gate;
- else tutorial not done → run tutorial, then re-check the gate;
- else → show the Begin screen.

Returning players (both flags set) go straight to Begin. The gate is applied on
every path that reaches Begin: a picker selection, `?level=current`, and
`?level=<id>`.

Screens follow the existing `#app > section:not([hidden])` one-at-a-time pattern.
Two new empty sections in `index.html` (`#calibration-screen`,
`#tutorial-screen`) are populated by their mount functions and toggled via the
`hidden` attribute alongside the picker/start screens.

---

## Part 1 — Calibration (`src/ui/calibration.ts`)

Steps (each gated by a player action, announced via the aria-live regions):

1. **intro** — "Press Start to enable sound." Start is the **user gesture** that
   boots audio (`startAudio()` — the same bootstrap the Begin button uses; no
   duplicate). Also offers **Skip calibration**.
2. **left** — plays a 440 Hz tone positioned **hard left** and asks where you
   heard it. Buttons: "I heard it on the LEFT (correct)" / "It was on the RIGHT
   (swapped)" / "Play it again".
3. **right** — same, **hard right**.
4. **volume** — reports the orientation result, plays a steady tone, and asks you
   to adjust device volume, then **continue**.
5. **done** — sets the "calibration done" flag and returns to the flow.

**Engine convention (positioning).** Per `docs/TECHNICAL.md`: **+x = right, −z =
front**, listener yaw 0 faces −z. A hard-**left** sound is therefore at the
listener's **−x**, hard-**right** at **+x**. The probe uses an `HrtfSource`
placed at `(−3, 1.6, 0)` / `(+3, 1.6, 0)` with the listener at the origin facing
forward.

**Swap detection + toggle.** The player reports the side they actually heard each
probe on. If **both** probes were heard on the opposite side, the headphones are
physically reversed: we announce it (assertive), auto-enable the session swap, and
expose a **Swap left/right** toggle button (`aria-pressed`). The swap inverts the
**master output channels** for the whole session via a crossed
`ChannelSplitter → ChannelMerger` inserted on the `master → limiter` path. That
swap node is **owned by the host** (`applyChannelSwap` in `main.ts`) so
calibration and the real game share one node and one source of truth; the
preference is persisted (`ps.onboarding.swapLR`) and re-applied in the Begin
handler.

---

## Part 2 — Guided tutorial (`src/ui/tutorial.ts`)

A **scripted** sequence (a lightweight practice harness, not the full `Game`): it
owns its own `startAudio()` + `HrtfRenderer` + one positioned tone + a `Compass`,
so it stays simple and self-contained. Three lessons, each with spoken
instructions and a **Next** gate that unlocks once you've practiced enough:

1. **Stepping** — "tap LEFT, then RIGHT, alternating, in a steady rhythm; rushing
   makes you stumble." Uses the real `Player` step machine: a few **good** steps
   satisfy the gate; rushing / wrong-foot produces the real stumble feedback.
2. **Turning** — "drag the compass; the whole soundscape rotates." A tone plays
   front-right; turning until it's roughly **ahead** satisfies the gate. Uses the
   real `Compass` + `Heading` slew, driving the `HrtfRenderer` listener yaw.
3. **Clapping** — "tap echo to clap and hear the room." One clap satisfies the
   gate (a short self-contained noise burst).

A **Skip tutorial** button is present on every lesson. Completion sets the
"tutorial done" flag.

---

## Eyes-free design

- **aria-live announcements** — every step/instruction goes through the existing
  `#status` (polite, via `say`) and `#alerts` (assertive, via `alert`) regions,
  reused from `main.ts`. Progress, results, stumbles, and completion are all
  spoken.
- **Focus management** — on each screen/step render, focus moves to the first
  control (mirrors the `showPicker`/`mountPicker` pattern), so a screen-reader /
  eyes-closed user always lands on an actionable button.
- **Large labeled buttons** — stacked, full-width, ≥44 px targets
  (`.cal-controls`, `.tut-foot`), descriptive text labels (not icons alone),
  keyboard operable (real `<button>`s).
- **Skippable + remembered** — nothing is forced after the first completion.

---

## Persistence (`src/ui/onboardingStore.ts`)

`localStorage` keys:

| Key                              | Meaning                         |
| -------------------------------- | ------------------------------- |
| `ps.onboarding.calibrationDone`  | calibration completed/skipped   |
| `ps.onboarding.tutorialDone`     | tutorial completed/skipped      |
| `ps.onboarding.swapLR`           | session L/R channel-swap pref   |

All reads/writes are guarded; if `localStorage` is unavailable or throws (private
mode), it degrades to an in-memory fallback — the flow still works, it just won't
be remembered across reloads.

---

## Replaying from the picker

Two buttons in the picker's page-links nav (`index.html`):

- **🎧 Calibrate audio** → `runCalibration`, returns to the picker on finish.
- **🚶 Replay tutorial** → `runTutorial`, returns to the picker on finish.

Both ignore the "done" flags, so onboarding can be redone at will.

---

## What's tested vs. ear/screen-reader-verified

**Unit-tested (pure, `tests/onboarding.test.ts`, 17 tests):**

- `CalibrationMachine` (`src/ui/calibrationMachine.ts`) — step sequence
  (intro→left→right→volume→done), per-probe answer recording, **swap-suggested**
  (both reversed) vs **orientation-correct**, the independent swap toggle, reset,
  and out-of-order guards.
- `TutorialMachine` (`src/ui/tutorialMachine.ts`) — lesson order, per-lesson
  practice gate (action counting + cap), `next` (gated), `skip` / `skipAll`
  (force), completion, reset/replay.
- `OnboardingStore` (`src/ui/onboardingStore.ts`) — the three flags round-trip,
  the documented keys, `isFirstRun`, and graceful degradation when storage is
  null or throws.

**Integration / ear- and screen-reader-verified (not unit-tested):** actual Web
Audio playback (the L/R tones, the master channel-swap routing, the tutorial tone
and clap), the DOM mounting, and the screen-reader announcements. Web Audio can't
render in vitest (and the vitest fork pool is capped in `vite.config.ts`), so the
**logic** was extracted into the three pure classes above and the audio/DOM is
left to manual verification.
