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
- A simple **streak progression** raises difficulty as you answer correctly
  (`difficulty = min(1, streak·0.12)`) and resets on a miss — contrast shrinks as
  you improve.

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
- `src/trainer/trainer.ts` — page controller (reuses `ScenePlayer`).
- `trainer.html` — eyes-free UI.
- `tests/exercises.test.ts` — fairness/correctness/determinism tests.
