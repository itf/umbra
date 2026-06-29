# Monster chase AI

The final gameplay feature: levels can contain **monsters** that hunt you. The
defining rule, in the designer's words:

> The monster is **deaf to the player's actual position**. It chases the **last
> noise** the player made (loud floors, stumbles, wall bumps). If the player moves
> silently (soft floors, no stumbles), the monster has no fresh noise to chase and
> goes to / lingers at the last-heard location, losing the trail. Careful quiet
> movement evades; rushing/stumbling/loud surfaces give you away.

This rewards exactly the careful stepping the [noise model](./noise-events.md)
encodes: noise is *where + how loud*, derived from the same events that drive
footstep audio. The monster consumes `NoiseTracker.lastNoise()` and the decayed
loudness from `loudnessAt` — it never reads the player's coordinates to navigate.

## Architecture: pure AI core + spatial voice

Two modules, mirroring the noise-model / footstep split:

- **`src/game/monster.ts`** — a PURE, deterministically unit-testable AI core (no
  Web Audio / DOM). All decisions live here.
- **`src/game/monsterSounds.ts`** — `MonsterVoice`, a continuous growl through an
  `HrtfSource` (ear-verified, like `BeaconVoice`).

`game.ts` owns the runtime: one `{ state, src, voice }` per level monster, advanced
in `tick(nowMs)`.

## The AI state machine

`updateMonster(state, noise, nowMs, dtMs, tuning?) → newState` is a pure function.
State: `{ x, z, speed, target, targetTMs, phase }`, `phase ∈ {investigate, idle}`.

```
            fresh, still-audible noise (newer + decayedLoudness ≥ threshold)
   ┌──────────────────────────────────────────────────────────────┐
   ▼                                                                │
 IDLE  ──fresh noise──▶  INVESTIGATE  ──move toward target (≤speed·dt)──┐
   ▲                          │                                          │
   └────reached target────────┘◀─────────────────────────────────────────┘
        (within arrive radius / step covers remaining dist → snap & linger)
```

1. **Retarget** — if `noise` is *newer* than the noise currently chased
   (`noise.tMs > targetTMs`) **and** its decayed loudness right now
   (`decayedLoudness(noise, now)`) is **≥ threshold**, commit to it: target =
   `(noise.x, noise.z)`, `phase = investigate`. A noise that is older, or has
   faded below threshold, is ignored.
2. **Move** — step toward the target along the straight line, distance clamped to
   `speed · dt`. The monster never moves more than `speed·dt` in one update.
3. **Arrive / idle** — when within `arriveRadius` (or the step covers the whole
   remaining distance), snap to the target and switch to `idle`. With no fresh
   noise it lingers there indefinitely. (Minimum behaviour is idle-at-last-noise;
   a patrol/wander could be added in the `idle` branch without touching audio.)
4. **No target** — `idle` in place.

## Losing the trail (the evasion mechanic — decay × threshold)

The emitted loudness of a noise is fixed, but `decayedLoudness(noise, now) =
loudness · exp(−(now − tEmit) / NOISE_DECAY_MS)` fades it with the **same**
`NOISE_DECAY_MS = 2500 ms` the audio model uses. A noise stops attracting once its
decayed loudness drops below `noiseThreshold` (default **0.12**).

So the headline behaviour falls out: make one loud spike (stumble ≈ 1.0, gravel
step ≈ 0.81) and the monster homes on that spot. Then move **quietly** — soft
floors emit near-zero loudness (foam ≈ 0, carpet ≈ 0.15), and with no *new* loud
noise the last one keeps decaying. The monster reaches the stale spot and idles
there while you slip away; it does **not** track you. Cross a loud floor or stumble
and you hand it a fresh target again.

Threshold/decay interplay:
- **Higher threshold** ⇒ only loud/fresh noises attract ⇒ easier to evade.
- **Longer `NOISE_DECAY_MS`** ⇒ noises stay compelling longer ⇒ harder to evade.
- A quiet step *can* attract briefly if `decayedLoudness ≥ threshold` at that
  instant; a carpet step (0.15) is just above 0.12 when fresh and fades below it
  within a fraction of a second — so only sustained loud noise reliably leads it.

## The catch model — navigate by noise, catch by proximity

Navigation uses noise; **catching uses honest geometry**. Each frame, after moving,
`caught(state, playerX, playerZ, radius)` tests real distance to the player's
*actual* position. The monster doesn't steer by that position — but because it
physically walks to where you last were, if you linger near a fresh noise it can
reach and catch you. Default `catchRadius = 0.8 m` (overridable per level via
`GameLevel.catchRadius`). On catch, `Game` fires `onCaught` once, freezes input
(like win), and fades the beacon + every monster voice.

## The spatialized monster voice — and why it Dopplers

`MonsterVoice` is a low growl (two detuned saw/square oscillators + an octave
through a lowpass, with a ~0.7 Hz "breathing" amplitude pulse) — deliberately
distinct from any beacon preset so the player can tell monster from goal by ear.
Its mono output feeds the monster's own `HrtfSource.input`, so it shares the exact
spatial pipeline as the beacon: propagation delay, distance gain, air lowpass, HRTF
convolution. Each frame `game.ts` calls `src.setPosition(state.x, head, state.z)`.

Because the `HrtfSource` models arrival time with a modulated delay line
([Doppler doc](./doppler-and-propagation-delay.md)), a monster **closing on you**
shrinks the source-to-listener distance every frame and the growl **pitches up** —
a free, physically-correct "it's gaining on you" cue. A monster that gives up and
recedes pitches down.

## Wiring

- **`schema.ts`** — `MonsterObj { id, x, z, speed, sound }` (unchanged) on
  `Level.monsters`.
- **`load.ts`** — `loadLevel` now maps `level.monsters` into
  `GameLevel.monsters: MonsterSpawn[]` (`{ x, z, speed, sound }`). A no-monster
  level yields `[]` — inert.
- **`game.ts`** — constructor builds one `Monster` state + `HrtfSource` + started
  `MonsterVoice` per spawn (none ⇒ no work). `tick(nowMs)` computes per-frame `dt`,
  feeds each monster `lastNoise()`, repositions its voice, and runs the catch test;
  `step()` early-returns once caught. `destroy()` stops voices and disconnects
  sources.
- **`main.ts`** — an `onCaught` handler announces "Caught!" and freezes input,
  mirroring `onWin`.

## Editor

Monsters were already placeable; the properties panel exposes **`speed`** (m/s)
and **`sound`** (label), which round-trip through save/load (`MonsterObj`). No new
editor fields were required.

## Tuning knobs

| Knob | Default | Effect |
|------|---------|--------|
| `speed` (per monster) | 1.2 m/s (editor) | how fast it closes |
| `catchRadius` (`GameLevel`) | 0.8 m | proximity to be caught |
| `noiseThreshold` (`MonsterTuning`) | 0.12 | min decayed loudness that attracts; ↑ = easier to evade |
| `NOISE_DECAY_MS` (noise model) | 2500 ms | how fast a noise fades; ↑ = harder to evade |
| `arriveRadius` (`MonsterTuning`) | 0.25 m | distance counted as "reached" → idle |

## What's tested vs ear-verified

**Unit-tested (`tests/monster.test.ts`, pure, no audio):**
- moves toward the last-noise location; never exceeds `speed·dt` per step;
- retargets when a newer still-loud noise arrives;
- does **not** retarget to a faded/stale noise below threshold (evasion);
- reaches and idles at the target; idles in place with no noise;
- catch: within radius of the **player** position → caught; not caught when far;
- **"silent player evades"** headline test — a single loud noise, then quiet
  movement away: the monster ends at the stale loud spot (idle), distance to the
  player grows, and `caught` is false;
- `decayedLoudness` matches `loudness·exp(−dt/τ)`.

**Plumbing (`tests/load.test.ts`):** monsters flow `Level → GameLevel`; a
no-monster level yields `[]`.

**Ear-verified:** the growl timbre, its locatability, and the Doppler pitch-up as a
monster closes in (the live `HrtfSource` delay line isn't rendered in CI — same
rationale as the [Doppler doc](./doppler-and-propagation-delay.md)).
