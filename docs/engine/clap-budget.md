# Sonar / Clap Budget

The clap/echo probe is the game's signature "flash sonar" verb. By default it is
**free and unlimited** — which means probing carries no tension. The clap budget
turns it into a *managed resource*: a level can cap the number of claps and/or
force a cooldown between them, so every probe becomes a deliberate decision.

## The model — `src/game/clapBudget.ts`

`ClapBudget` is a **pure, deterministic** class — it never reads the clock itself;
the caller injects `nowMs` (a millisecond number). Two independent, optional
constraints:

- **Hard budget** (`max`): at most N claps for the whole run. `0`/`undefined`
  (and negatives) ⇒ unlimited.
- **Cooldown** (`cooldownMs`): minimum ms between consecutive claps. `0`/`undefined`
  ⇒ no cooldown.

API:

| method | meaning |
| --- | --- |
| `isManaged()` | true if any constraint applies (drives whether the UI shows a counter) |
| `hasBudget()` | true if the total is capped |
| `remaining()` | claps left, or `Infinity` when unlimited |
| `canClap(nowMs)` | `{ ok }` or `{ ok:false, reason:'exhausted'\|'cooling', waitMs }` |
| `consume(nowMs)` | same result; on success decrements + arms cooldown, else no state change |

Exhaustion takes priority over cooling. A refused `consume` mutates nothing.

## Eyes-free announcements (`src/main.ts`)

The game is played eyes-closed, so the budget is spoken via the ARIA live regions:

- On start (when budgeted): `say("Sonar budget: 6 claps left. Clap deliberately.")`
- After each clap: `say("Clap! Listen to the room around you. 5 claps left.")`
- Refused — exhausted: `alert("No claps left.")`
- Refused — cooling: `alert("Echo ready in 2s.")`

The `#listen` button's `aria-label` reflects the remaining count and the button is
`disabled` once the budget is exhausted. **When unlimited (`isManaged()===false`)
nothing is shown or announced — the button behaves exactly as before.**

## Schema + back-compat

`src/level/schema.ts` adds two optional `Level` fields, threaded into `GameLevel`
by `src/level/load.ts`:

```jsonc
"clapBudget": 6,        // max claps; absent/0 ⇒ unlimited
"clapCooldownMs": 1500  // ms between claps; absent/0 ⇒ none
```

Both optional, so old levels, the editor's "current" level, and the default room
omit them and keep today's free clap. No `isLevel` change was needed.

## The Clap-Maze level — `src/levels/clap-maze.json`

A 10×16 m concrete room with six **double-sided** brick interior walls forming a
serpentine corridor: a wall blocks each row with the gap alternating
left → right → left, so you map the route by *where the echo isn't*. Budget: **6
claps**, 1.5 s cooldown — enough to probe at each junction if you spend them
wisely. Registered as builtin id `clap-maze`.

## What's tested — `tests/clapBudget.test.ts`

- Pure model: unlimited never refuses; `0`/negative collapse to unlimited;
  budget decrements + refuses at 0; cooldown blocks within the window and allows
  at/after it (deterministic injected clock); budget+cooldown compose with
  exhaustion priority.
- Schema/load: `clap-maze` round-trips its budget into `GameLevel`; a level
  without a budget threads `undefined` ⇒ unlimited.
- The `clap-maze` builtin passes `isLevel` + `loadLevel`, has a `clapBudget` and
  interior walls (also covered by the builtins loop).

## Deferred

Surfacing `clapBudget`/`clapCooldownMs` in the level **editor** (a Room-panel
number field) is deferred — it needs matching `editor.html` markup and another
track may add it. The schema/load support is in place, so authoring via JSON works
today.
