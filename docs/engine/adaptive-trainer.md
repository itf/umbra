# Adaptive staircase — threshold tracking for the trainer

`src/trainer/adaptive.ts` turns the Echolocation Trainer from a quiz into a real
training instrument. Instead of a fixed difficulty (or the old punitive streak
ramp), it uses the standard psychophysics method — a **transformed up/down
staircase** — to keep the learner near their discrimination **threshold**.

## Why not the streak ramp?

The original controller drove difficulty as `min(1, streak·0.12)`, raised on a
correct answer and **reset to easy on any miss**. That is crude and demoralising:
one slip throws away all progress, and it has no notion of *where* the learner's
ability actually sits. A staircase, by contrast, makes small symmetric moves and
*converges* on the difficulty the learner can just barely handle.

## The rule (2-down / 1-up)

`Staircase` holds a difficulty in `[0,1]` and moves it after each answer:

- **N consecutive correct → harder** (difficulty up). Default `down = 2`.
- **M consecutive incorrect → easier** (difficulty down). Default `up = 1`.

A 2-down/1-up rule converges to the difficulty at which the learner is correct
**≈71%** of the time (Levitt 1971); 3-down/1-up targets ≈79%. Both `down` and
`up` are configurable. The consecutive counter resets after each move, so two
fresh correct answers are needed for each step up.

A single miss only nudges difficulty down by one step — it does **not** reset to
easy. This is the key behavioural difference from the streak ramp.

## Step size and reversals → convergence

A **reversal** is a change of direction (an up-move following a down-move or vice
versa). At each reversal the step **halves**, down to a floor (`minStep`,
default 0.04), starting from `startStep` (default 0.2). Large early steps find the
neighbourhood of the threshold quickly; shrinking steps then home in without
oscillating forever. `reversals` counts turning points; `stepSize` exposes the
current step.

Difficulty is clamped to `[0,1]` on every move.

## Threshold (mastery) estimate

`threshold()` returns the **mean difficulty over the last K reversals**
(`thresholdReversals`, default 6) — the classic staircase threshold estimator and
the trainer's mastery score. Before the first reversal it falls back to the
current difficulty so callers always get a number; `settled` reports whether
enough reversals have accumulated for a stable estimate.

## How difficulty flows into the generators

The staircase is purely a difficulty *controller*; it never touches scenes. The
controller (`trainer.ts`) does:

```
const d = staircase.current();               // adaptive difficulty
makeRandomQuestion(seed++, { difficulty: d, types });
// …on answer…
staircase.record(correct);                   // moves the staircase
```

So the difficulty feeds the existing `makeQuestion`/`makeRandomQuestion`
generators unchanged — it scales the contrast (room-size factor, direction/
reflector bearing offset, etc.) exactly as before.

## Level-roving (anti-loudness)

Each question uses a **fresh seed** (the controller increments `seedCounter`), so
the scene/jitter changes every trial and the learner can't memorise one room.
When *Mixed (all)* is selected the exercise **type** also roves (handled inside
`makeRandomQuestion`). The staircase's current difficulty is applied to whatever
type comes up, so the threshold tracks general discrimination skill rather than
one scene.

## Fixed vs adaptive mode

The page's *Difficulty* picker chooses **Adaptive** (default) or a **fixed** level
(easy…expert). In fixed mode the staircase is *not* driven (`record` is skipped),
so practice-at-a-level doesn't perturb the threshold tracker, and the chosen
constant difficulty is passed straight to the generator.

## Eyes-free progress cue

After each answer the aria-live region announces the current **band**
(`difficultyBand`: easy/moderate/firm/hard/expert) and, at reversals or once the
estimate has settled, a mastery readout: *"you're discriminating at about 70% of
full difficulty."*

## What is tested

`tests/adaptive.test.ts` (pure, no DOM/Web Audio):

- **Rule:** harder only after 2 consecutive correct; easier after 1 incorrect; a
  single miss does not reset to easy.
- **Reversals + step halving:** reversals counted correctly; step halves at each
  reversal and never drops below the floor.
- **Clamping:** difficulty stays within `[0,1]` when driven hard up or down.
- **Determinism:** the same correct/incorrect sequence yields an identical
  difficulty trajectory.
- **Convergence:** a simulated logistic observer (p≈0.71 correct at a known
  threshold) drives the estimated threshold to within ±0.12 of the simulated one
  over many trials.
- **Estimator:** averages only the last K reversals; falls back to current
  difficulty before any reversal.
