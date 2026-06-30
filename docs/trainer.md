# Echolocation Trainer

A structured drill page (`/trainer.html`) for building the skill of *reading rooms
by ear*. Where the game asks you to navigate and the debug page lets you browse
scenes, the trainer poses **discrimination questions** with scoring and instant
feedback, so the ear is trained against the physically-modeled acoustics.

It runs the same pipeline as everything else: each question is built from
`Scene` objects and played through the debug `ScenePlayer` (clap → room IR via the
WASM image-source solver → HRTF; or a positioned HRTF tone for direction).

## First-launch onboarding

On the very first visit (`src/trainer/onboarding.ts`), before the normal flow
begins, the trainer forces a single maximally-easy size discrimination — a very
small room versus a very large one, "Which is LARGER?" — then reveals:
*"You just used echolocation."* This happens once, gated by a persisted flag in
`TrainerStore`, and never repeats. Daily-challenge mode skips it.

## A/B format

Most exercises present **Room A** and **Room B**. The player taps *Play Room A*
and *Play Room B* as many times as they like (each fires a clap through that
room's impulse response), then answers a single contrast question. The answer is
scored, and *Next* advances. The **direction** exercise is a single-scene variant
(one room, one positioned source).

## Selectable probe sounds

The "echo" you fire is **selectable** via a probe picker on the page: synth presets
(clap / tongue-click / hiss / finger-snap) plus a **custom recording** (URL or a
picked audio file). The chosen probe is applied to **both Room A and Room B** so the
A/B comparison stays fair. A sharp transient (click/snap) sharpens echo *timing*; a
sustained hiss makes *faint* reflections ring out. The clap fires from the scene's
clap-source position, so an off-centre clap genuinely changes the reflection
pattern. See `docs/engine/probe-sounds.md`.

### Record your own mouth click (`src/trainer/clickRecorder.ts`)

A **Record Click** button in the probe picker lets the player capture their own
mouth click from the microphone and use it as the excitation probe. The recording
pipeline is:

1. Captures ~1 s of audio via `getUserMedia`.
2. Mixes down to mono, finds the loudest peak.
3. Trims to a 5 ms pre-peak / 45 ms post-peak window (covering the full click envelope).
4. Applies 2 ms linear fade-in/out to suppress edge clicks.
5. Peak-normalises to 0.9.
6. Returns an `AudioBuffer` ready for `ScenePlayer`.

The DSP helpers (`findPeakIndex`, `trimAroundPeak`, `applyFades`, `peakNormalize`,
`processClickBuffer`) are pure, tested without Web Audio. Mic access is requested
only when the user taps the button; a descriptive error is shown on
permission-denied or no-mic.

## Fairness: one variable at a time

The drill only trains the right cue if the two rooms differ in **exactly** the
dimension being tested. This is a property the generator (`src/trainer/exercises.ts`)
*guarantees* and the tests (`tests/exercises.test.ts`) *assert* across 60 seeds:

| Type | Two scenes differ in… | Held identical | Cue trained |
|------|-----------------------|----------------|-------------|
| **larger** | total volume (all dims scaled by one factor — shape stays similar) | materials | Reverb time / echo return delay → room size |
| **wider** | x-extent only | depth, height, materials | Lateral echo spread/timing → width |
| **longer** | z-extent only | width, height, materials | Front/back echo delay → depth |
| **carpet** | wall material (carpet vs concrete) | geometry | Soft/dead vs live decay |
| **brick** | wall material (brick vs concrete) | geometry | Scattered/diffuse vs sharp specular echo |
| **reflector** | which side (left/right) the panel is on | room, panel distance/material | Direction of a single early echo |
| **distance** | distance to a wall straight ahead (e.g. 1.5 m vs 3 m) | room, panel size/material, direction (both dead ahead) | **Echo DELAY → distance** — the closer wall echoes back sooner |
| **estimate** | *(none — single scene)* | — | **Absolute echo delay → metres** — clap once, pick a distance |

### Anti-loudness drills (resist the "just judge loudness" shortcut)

Both the **reflector**, **distance** and **gap** drills follow the same pattern as
`genReflector`: the listener is enclosed in a large, **highly-absorbent foam room**
(its own reflections are faint and far-off, so room size/loudness is *not* a usable
cue) and the only crisp early echo comes from a **double-sided hard concrete panel**.
The image-source solver only reflects well for a listener *inside* geometry, so this
enclosing room is what makes a lone discriminating panel acoustically valid.

- **distance** — "is the wall CLOSER in A or B?" Two such rooms, each with a panel
  **directly ahead** (engine front, −z) at different distances. The cue is the
  **arrival delay** of the order-1 reflection: the closer wall echoes back sooner.
  *Loudness confound:* a closer wall is also slightly louder, so distances are kept
  modest (≈1.5–3 m) to make **timing** the decisive cue, not level. The distance
  **ratio** shrinks toward 1 as difficulty rises. The acoustic test asserts the
  closer-wall scene's first order-1 tap arrives at a strictly **shorter delay**.
  After answering, the post-answer reveal shows the exact echo delay in ms for each
  room (`echoDelayMs(d) = 2·d/343 × 1000`), closing the perceptual loop.
- **estimate** — "how far is the wall ahead?" A **single-scene** drill (no Room B).
  One concrete panel is placed straight ahead at a randomised distance drawn from
  a difficulty-appropriate grid (0.5 m steps at easy; 0.25 m steps at hard).
  Distance range: 0.75 m – 6.0 m. The player claps, then selects their guess from
  a labelled metre grid (e.g. "0.75 m", "1.25 m", …). Scoring uses a **tolerance
  band**: ±25% of the true distance at difficulty 0, narrowing to ±10% at
  difficulty 1. The verdict reports the % error and the tolerance that was applied.
  *Not available in mixed/all mode* — can only be selected as a single-type drill.
- **gap** — "which side is the DOORWAY/opening on?" A **single-scene** drill (one
  room, answer **Left/Right**). A hard wall sits front-and-to-one-side; the *other*
  side is the silent **gap**. The cue is the **direction** of the reflection — the
  solid side echoes, the gap side does not. Implemented as the simpler brainstorm
  option (a panel on one side only) rather than diffraction edges. A left-gap and a
  right-gap are exact left/right mirrors (same panel size, material, distance — only
  the side differs), so loudness can't distinguish them. The acoustic test asserts
  the gain-weighted mean lateral echo direction points to the **wall side** (away
  from the labeled gap) with audible magnitude.

For width vs length the tests check that the *non-tested* axes are equal to
floating-point tolerance and the tested axis differs, and that the labeled
`correctAnswer` is the room whose tested quantity is genuinely larger (or whose
material genuinely matches). For materials the geometry is asserted equal and the
winning room's material set is asserted to contain the named material while the
other does not.

## Direction exercise

A single room (dry/carpeted so direction dominates over echo) with a positioned
tone beacon 3 m from the listener at a known bearing. The player answers
**Forward / Behind / Left / Right**. Bearing convention: 0° = straight ahead,
+90° = right. The source is then placed to match the ENGINE's coordinate
convention — front is **−z**, right is +x (see `docs/TECHNICAL.md` and
`sofa.ts`: az=0 → −z) — so forward (0°) puts the source at −z, behind (180°) at
+z. `bearingToDirection` maps to 90°-wide quadrants centred on each cardinal
(forward = [315°,45°), right = [45°,135°), …). The test checks the quadrant
boundaries and, across seeds, that the source's actual world position — decoded
with the −z-forward engine convention — recovers the same direction as the
labeled answer (so a future regression that flips the axis is caught). This trains front/back
and lateral localization.

## HF pre-emphasis on the clap

All clap probes (synth presets and the recorded mouth click) pass through a
**+6 dB high-shelf filter above 1 kHz** applied per-clap in `ClapRoom.clap()`
(`src/engine/acoustics/clapRoom.ts`). The shelf boosts the 1–4 kHz band where
material cues (carpet vs concrete, metal vs wood) and pinna-shadow cues live,
making those differences more audible without changing the probe length or
affecting the dual-convolver crossfade path. The distance drill's echo-delay
feedback (`echoDelayMs`) is independent and unaffected.

## Scoring & difficulty

- Running **Score N / M** is announced after each answer.
- **Difficulty** is a 0..1 knob: 0 = big, obvious contrast; 1 = subtle. It scales
  the size factor (≈1.8× easy → ≈1.15–1.2× hard) and, for direction, how close to
  a quadrant boundary the source may sit.
- **Adaptive staircase (default).** The old streak ramp (`min(1, streak·0.12)`,
  reset on any miss) was punitive and crude. It is replaced by a transformed
  **2-down/1-up adaptive staircase** (`src/trainer/adaptive.ts`) that parks the
  learner at their discrimination **threshold**: difficulty steps UP after two
  correct in a row, DOWN after a single miss, with the step **halving at each
  reversal** so it converges. After each answer the controller calls
  `staircase.record(correct)` and uses `staircase.current()` for the NEXT question.
  See `docs/engine/adaptive-trainer.md` for the rule, convergence, and the mastery
  readout.
- **Fixed mode (override).** The page's *Difficulty* picker offers
  *Adaptive* (default) or a fixed level (easy…expert). In fixed mode the staircase
  is not driven, so you can practice at one contrast.
- **Eyes-free progress.** The aria-live region announces the current level **band**
  (easy/moderate/firm/hard/expert) after each answer, and at reversals (or once the
  estimate has settled) a mastery readout: *"you're discriminating at about 70% of
  full difficulty."*

## Interleaved practice scheduler (`src/trainer/scheduler.ts`)

When **mixed** or **all** mode is selected (multiple exercise types in rotation)
the `InterleavedScheduler` governs which type is asked next.

**Blocked → interleaved transition.** While any type is a *novice* (fewer than 6
trials OR staircase threshold below 0.5), the scheduler keeps drilling that type
until it clears — building one skill at a time without the confusion of constant
switching. Among multiple novice types, the least-practised is chosen. The
no-repeat cap (3 consecutive of the same type) still applies to prevent lock-in.

**Interleaved phase.** Once all active types are competent, the scheduler
switches to spaced interleaving weighted by **recent weakness**: each type's
weight is `1 − recentAccuracy` over the last 5 results, so weaker types are
visited more often. New/unstarted types default to weight 0.7 (moderate pull).
No type repeats more than 3 times in a row.

**Per-type staircases.** Each type maintains its own independent 2-down/1-up
adaptive staircase. Switching types resumes each type's own difficulty exactly
where it left off. Snapshot/restore lets the scheduler persist across sessions.

**Competence criterion.** A type is competent once it has ≥6 trials AND its
staircase threshold is ≥0.5 (mid-range difficulty). The MIN_TRIALS gate prevents
a lucky early streak from prematurely ending blocked practice.

## Freeze-frame replay (`src/trainer/replay.ts`)

After every A/B answer the trainer plays the **correct comparison back-to-back**
— Room A, a 500 ms gap, Room B — with a spoken and visible label for each room
("A is the larger room (correct)." / "B is smaller."). This replay always runs
in A→B order regardless of which was correct, so the learner reinforces a right
answer as naturally as they hear the difference after a wrong one.

**Size and distance reveal.** The replay labels optionally include the ground-truth
dimensions or wall distance for each room so the numbers remain visible while
that room plays. For example: *"A is the room with the closer wall (correct) —
wall 1.50 m, echo ≈8.7 ms."* Because the replay overwrites the feedback region,
this is where the reveal must live to stay on screen.

Single-scene exercises (direction, gap, orientation, estimate) have no Room B so
no replay is generated.

## Progress dashboard — sparkline (`src/trainer/sparkline.ts`)

A small canvas sparkline is drawn per exercise type on the progress dashboard.
The Y-axis is the adaptive staircase threshold (lower threshold = more difficult
contrast handled = better), **flipped** so an improving learner's line rises on
screen. The latest point is highlighted in gold. The accessible truth is the
spoken `trendSummary` text beside the canvas (the canvas alone is invisible to
screen readers).

## Loudness EQ calibration (`src/ui/loudnessEq*.ts`)

The calibration flow includes a **per-user multi-band equal-loudness matching**
step to correct for individual headphone/ear frequency-response variation. It
runs automatically on first calibration and is re-runnable from Settings.

**Method.** A 1-up/1-down staircase per non-reference band converges on each
band's *point of subjective equality* (PSE) relative to the 1 kHz reference:

- 7 log-spaced bands: 125, 250, 500, **1000** (reference, 0 dB), 2000, 4000, 8000 Hz.
- Each trial plays the reference (1 kHz at 0 dB), then the band at its current
  test gain. The player answers **Reference louder / Band louder / Equal**.
- *Band louder* → lower the test gain; *Reference louder* → raise it; *Equal* →
  log a reversal without moving.
- The step halves at each direction reversal (floor 0.5 dB, initial 4 dB).
  Convergence: 4 reversals or a 16-trial cap per band.
- The measured equal-loudness gain is the **mean of the reversal turn-points**
  (a robust PSE estimate), clamped to ±12 dB.

**Result.** The measured gain for each band is the correction the master EQ
must apply to flatten perceived loudness. Bands are presented in randomised order
(injected RNG for deterministic tests). The reference band is always 0 dB.
Persistence lives in `settingsStore`.

## Determinism

`makeQuestion(type, seed, {difficulty})` and `makeRandomQuestion(seed, …)` are
pure and seeded with a mulberry32 RNG (no `Math.random` in module scope), so the
same seed always yields the identical question. This makes the generator fully
testable without Web Audio.

## Eyes-free UI

- Gated behind a **Begin** button (browsers need a user gesture to start audio).
- Large touch targets (≥56 px), keyboard-operable buttons with ARIA labels.
- An `aria-live="assertive"` region announces the question, each *Playing Room X*,
  the correct/incorrect verdict with the answer, the score, and the prompt to
  press Next. Feedback also lives in a `role="status"` element. After answering,
  focus moves to **Next**.

## What is tested vs ear-verified

- **Tested** (`tests/exercises.test.ts`, part of `npm test`): fairness (only the
  tested axis differs), correctness (the labeled answer matches geometry/material),
  the direction bearing→answer mapping and boundaries, determinism, difficulty
  monotonicity, and that every generated scene is structurally valid for
  ScenePlayer (has a clap/source, room, listener). The debug `scenes.test.ts`
  already validates that such scenes produce non-empty valid taps through the WASM
  solver.
- **Ear-verified**: the actual rendered audio — that a "larger" room *sounds*
  larger, brick *sounds* rougher than concrete, etc. The acoustics correctness
  itself is covered by the engine's own tests; the trainer reuses that pipeline
  unchanged.

## Files

- `src/trainer/exercises.ts` — pure generator (the correctness heart); includes `echoDelayMs`, `scoreEstimate`, `estimateDistances`, `estimateTolerance`, `genEstimate`.
- `src/trainer/adaptive.ts` — pure adaptive staircase (threshold tracking).
- `src/trainer/scheduler.ts` — interleaved practice scheduler (blocked→interleaved, per-type staircases).
- `src/trainer/replay.ts` — pure freeze-frame replay planner (`planReplay`, `replayDescriptors`).
- `src/trainer/onboarding.ts` — pure first-launch onboarding gating (`shouldRunOnboarding`, `onboardingQuestion`).
- `src/trainer/sparkline.ts` — canvas sparkline for the progress dashboard.
- `src/trainer/clickRecorder.ts` — mic capture + DSP pipeline for mouth-click probe.
- `src/ui/loudnessEq.ts` — pure loudness-EQ calibration session (`LoudnessEqSession`).
- `src/ui/loudnessEqAudio.ts` — tone playback for the EQ calibration flow.
- `src/ui/loudnessEqUi.ts` — DOM wiring for the EQ calibration UI.
- `src/engine/acoustics/clapRoom.ts` — clap synthesis with HF pre-emphasis shelf.
- `src/trainer/trainer.ts` — page controller (reuses `ScenePlayer`).
- `trainer.html` — eyes-free UI.
- `tests/exercises.test.ts` — fairness/correctness/determinism tests (includes estimate scoring).
- `tests/adaptive.test.ts` — staircase rule/convergence/determinism tests.
- `tests/scheduler.test.ts` — blocked→interleaved transition, per-type staircase independence.
- `tests/replay.test.ts` — replay plan correctness and label wording.
- `tests/onboarding.test.ts` — onboarding gating conditions.
- `tests/clickRecorder.test.ts` — pure DSP helpers (no mic, no Web Audio).
- `tests/loudnessEq.test.ts` — calibration session convergence and PSE accuracy.
- `docs/engine/adaptive-trainer.md` — the staircase design in depth.
