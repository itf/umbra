# Player noise events

**Foundation for monster chase AI.** The monster (built next) will not hunt the
player's actual position — it hunts the **last place the player made noise**. So
the player emits positioned "noise events" with a loudness, and a tracker records
the most recent one. Moving carefully on soft floors emits little/no noise (the
monster loses the trail); loud floors, stumbles, and wall bumps give you away.

This is a **pure** model (`src/game/noiseEvents.ts`, no Web Audio / DOM) so it's
deterministically testable. It runs **parallel** to footstep audio — it does not
change the step mechanic or the footstep synthesis; it derives a *where + how
loud* signal from the same events, with loudness correlated to the actual sound.

## The `NoiseEvent` model

```ts
type NoiseKind = 'step' | 'stumble' | 'bump';
interface NoiseEvent { x: number; z: number; loudness: number; kind: NoiseKind; tMs: number; }
```

`loudness` is normalized to `[0,1]` (0 = inaudible, 1 = max spike). `tMs` is the
emission time on the same clock the caller uses for steps.

## Loudness mapping

The player makes noise when they:

- **step on a floor** — loudness derived from the material (loud on gravel/rough
  stone, near-silent on carpet/foam);
- **stumble** (wrong-foot / too-fast / frozen) — a large fixed spike on any floor;
- **bump a wall** — a large fixed spike on any floor.

**Step loudness** comes from each material's step `level` in
`src/game/stepSounds.ts` — the *same* presets that set the audible footstep gain
— linearly normalized across the min/max of all material step levels:

```
stepLoudness(material) = (level(material) − minLevel) / (maxLevel − minLevel)
```

clamped to `[0,1]`, falling back to `concrete` for unknown materials (matching
`soundsFor`). Because it reads `STEP_SOUNDS` directly, the table stays in sync if
presets change. Current `STEP_SOUNDS` range: `acoustic_foam` 0.28 (quietest) →
`concrete`/`tile`/`asphalt`/`rough_stone`/`wood` 0.55 (loudest). Representative
normalized step loudness:

| material        | step level | step loudness |
|-----------------|-----------:|--------------:|
| acoustic_foam   | 0.28       | 0.00          |
| curtain         | 0.30       | ~0.07         |
| carpet          | 0.32       | ~0.15         |
| grass           | 0.40       | ~0.44         |
| water           | 0.45       | ~0.63         |
| glass           | 0.45       | ~0.63         |
| gravel          | 0.50       | ~0.81         |
| concrete / rough_stone / wood / tile / asphalt | 0.55 | 1.00 |

**Stumble / bump** ignore the floor (you trip loudly on carpet too):

- `STUMBLE_LOUDNESS = 1.0` (loudest — you crash)
- `BUMP_LOUDNESS = 0.9`

Ordering guaranteed: `bump ≈ stumble > gravel-step > carpet-step > foam-step`.

## Decay

The emitted `loudness` is fixed, but a *stale* noise should be less compelling
than a fresh one. `NoiseTracker.loudnessAt(tMs)` returns the last noise's loudness
exponentially decayed from its emission time:

```
loudnessAt(t) = lastNoise.loudness · exp(−(t − tEmit) / NOISE_DECAY_MS)
```

with `NOISE_DECAY_MS = 2500` (decays to ~37% after 2.5 s). The monster can use
this so a fresh noise outweighs an older one of equal emitted loudness.

## Tracker API (what the monster consumes)

```ts
class NoiseTracker {
  constructor(onNoise?: (e: NoiseEvent) => void)
  emit(event: NoiseEvent): void        // record as most recent; newer replaces older
  lastNoise(): NoiseEvent | null        // the most recent event, or null
  loudnessAt(tMs: number): number       // decayed loudness of the last event (0 if none)
}
```

Helpers: `loudnessFor(kind, material)`, `stepLoudnessForMaterial(material)`, and
`makeNoiseEvent(kind, x, z, material, tMs)`.

## Where `game.ts` emits events

`Game` owns a `NoiseTracker` (constructed with the optional `GameCallbacks.onNoise`
so UI/AI can subscribe) and exposes `game.lastNoise()`. In `Game.step`:

- **step** (valid move): `makeNoiseEvent('step', s.x, s.z, floorMaterialAt(s.x,s.z), nowMs)`
  at the landing point, loudness from the floor underfoot.
- **wall bump** (move crosses a wall, undone): `makeNoiseEvent('bump', before.x, before.z, wall.material, nowMs)`
  at the position the player still occupies.
- **stumble** (wrong-foot / too-fast / frozen): `makeNoiseEvent('stumble', s.x, s.z, floorMaterialAt(...), nowMs)`
  at the player's position.

Each `emit` happens right after the corresponding footstep audio call, so the
two stay co-located but independent.

## What's tested

`tests/noiseEvents.test.ts` (pure, no Web Audio):

- mapping: gravel-step > carpet-step > foam-step; normalized to `[0,1]`; foam ≈ 0,
  concrete ≈ 1; unknown → concrete; stumble/bump are fixed spikes regardless of
  floor; ordering `bump ≈ stumble > gravel-step > carpet-step`.
- tracker: `emit` then `lastNoise()`; null before any emit; newer replaces older;
  `onNoise` callback fires; `loudnessAt` decays over time (fresh > stale; exact
  `exp(−1)` at one time constant); 0 before any noise.
- game-wiring mirror: the exact pure calls `game.ts` makes — a gravel step records
  a louder last-noise than a carpet step; a stumble records a loud last-noise at
  the player position.

The `game.ts` wiring itself needs Web Audio to construct, so it is kept thin
(a `makeNoiseEvent` + `tracker.emit` per site) and verified by the pure mirror
test plus ear/integration testing.
