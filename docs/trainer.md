# Echolocation Trainer

A structured drill page (`/trainer.html`) for building the skill of *reading rooms
by ear*. Where the game asks you to navigate and the debug page lets you browse
scenes, the trainer poses **discrimination questions** with scoring and instant
feedback, so the ear is trained against the physically-modeled acoustics.

It runs the same pipeline as everything else: each question is built from
`Scene` objects and played through the debug `ScenePlayer` (clap → room IR via the
WASM image-source solver → HRTF; or a positioned HRTF tone for direction).

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

- `src/trainer/exercises.ts` — pure generator (the correctness heart).
- `src/trainer/adaptive.ts` — pure adaptive staircase (threshold tracking).
- `src/trainer/trainer.ts` — page controller (reuses `ScenePlayer`).
- `trainer.html` — eyes-free UI.
- `tests/exercises.test.ts` — fairness/correctness/determinism tests.
- `tests/adaptive.test.ts` — staircase rule/convergence/determinism tests.
- `docs/engine/adaptive-trainer.md` — the staircase design in depth.
