# Audio-only listener glide

## What this adds

A footstep moves the **logical** player position instantly (the discrete Papa
Sangre step mechanic; see `src/game/player.ts`). Before this change,
`Game.syncListener()` fired once at the destination, so the **audio** listener
teleported between footfalls: the direction a sound came from snapped, and
listener-motion Doppler (via the delay line — see
[doppler-and-propagation-delay.md](./doppler-and-propagation-delay.md)) became an
instant jump rather than a smooth chirp.

The glide interpolates the **pose used for audio** (the HRTF listener + the beacon
source) from the old position to the new over a short window, so:

- the direction a sound comes from **sweeps** naturally instead of snapping, and
- listener-motion Doppler becomes a smooth **chirp** instead of an instant jump.

This realizes the "future lever" noted in the *Listener motion* section of
doppler-and-propagation-delay.md.

## Audio-only constraint (the logical step stays discrete)

This is **audio-only**. It does **not** change `player.ts`: alternation,
wrong-foot / rush stumble, stride, settling, freeze, and the **logical player
position** are all exactly as before (`player.test.ts` passes unchanged). The
player still logically steps instantly. We only interpolate the **audio pose**.

Why keep the logical step discrete: the discrete step is the *game* — its timing,
stumble rules, and win/collision logic depend on instantaneous position. The glide
is a cosmetic-audio smoothing layer on top; coupling gameplay to a mid-glide
position would change the feel and break the tested mechanic.

## Logical vs. audio pose split

| Consumer | Pose used |
|---|---|
| HRTF listener (`renderer.setListener`) | **glide** (interpolated) |
| Beacon source (`HrtfSource.setPosition`) | **glide** (interpolated) |
| Win check (`checkWin`) | **logical** (final) |
| Wall collision (`crossedWall`) | **logical** (final) |
| Progress callback (`onProgress`) | **logical** (final) |
| Clap / live-room (`Game.listenerPos`, main.ts) | **logical** (settled) |

So the HRTF listener + beacon follow the glide; everything gameplay-relevant
(win/collision/progress) and the clap/moving-walls path use the logical position.
The clap is on-demand and should reflect where you *are*, not a transient
mid-glide pose, so `listenerPos` deliberately returns the logical pose.

## Duration + easing

- **`STEP_GLIDE_MS = 200`** (`src/game/listenerGlide.ts`). Step-paced — it feels
  like the weight of one stride landing. Chosen **≤ the rush interval** (220 ms,
  `player.ts` `rushIntervalMs`) so back-to-back *legal* steps don't normally
  overlap glides.
- **`easeOutCubic`** — decelerates into the destination, so the audio pose
  "settles" onto the foot-plant (weight landing) rather than arriving at constant
  speed. `f(0.5) = 0.875`, i.e. most of the distance is covered early, then it
  eases in.

## Mid-glide retarget

A new step can land before the previous glide finishes (e.g. brisk legal stepping,
or a glide window that runs slightly past the next step). The controller
**retargets**: `Game.step` calls `glide.start(glide.current, newTarget, nowMs)` —
the glide starts from the **current interpolated audio pose**, not the old start,
so there is **no snap-back and no stutter**. Yaw is handled separately (see below),
so a retarget only ever re-aims the x/z sweep.

## Yaw

Yaw is **not** glided here. `heading.ts` already slews the heading toward its
target at a capped angular rate, so turning is already smooth; the audio pose just
follows the current slewed yaw. `setYaw` updates the audio yaw immediately and
re-applies it at the glide's current position, so a turn takes effect at once
whether or not a position glide is in flight.

## Wiring

- `src/game/listenerGlide.ts` — pure module: `glidePose(from, to, tNorm)`,
  `easeOutCubic`, and the `ListenerGlide` controller (clock injected via `tick`,
  output via an injected `setAudioPose` sink — no Web Audio / DOM).
- `Game` (`src/game/game.ts`) owns a `ListenerGlide` whose sink applies the pose to
  the HRTF listener + beacon (`applyAudioPose`). A successful `step` starts/retargets
  the glide; `setYaw` and wall-bump (no move) **snap** (`syncListener`).
- `Game.tick(nowMs)` advances the active glide. It is driven once per frame from
  the game page's existing rAF loop (`footLoop` in `src/main.ts`). Both `step`'s
  default `nowMs` and `tick`'s default clock are the audio clock
  (`ctx.currentTime * 1000`), so they agree.

## What's tested

`tests/listenerGlide.test.ts` (deterministic, no AudioContext — the controller's
sink is a fake pose collector, mirroring how the suite avoids Web Audio):

- `glidePose`: `tNorm=0 → from`, `tNorm=1 → to`, clamps out-of-range, monotonic,
  stays on the from→to segment, eased (midpoint past the linear midpoint);
  `easeOutCubic` pins endpoints and `f(0.5)=0.875`.
- Controller: advancing time moves the pose from start toward target and **reaches
  the target at/after the duration** then idles; **retarget mid-glide starts from
  the current interpolated pose** (no snap-back); an **idle tick emits nothing**;
  `snap` cancels and jumps; zero-length glide collapses to an immediate emit;
  `STEP_GLIDE_MS ≤ 220`.
- `player.test.ts` is unchanged and passing (logical position untouched).

## Performance

Per frame the glide is a handful of arithmetic ops plus the existing
`setListener` + `setPosition` (microseconds). When **idle** the tick is a **no-op**
(returns immediately, no AudioParam writes), so it never thrashes the audio graph
between steps and **idle frames allocate nothing**. While a glide is *active* each
tick allocates one transient pose (from `glidePose`, copied into the reused `cur`
object), for the ~200 ms a glide runs — negligible. The cost is negligible.

## Limitations

- The glide is **cosmetic audio only** — it does not affect gameplay (win,
  collision, progress, clap all use the logical pose).
- Very fast *legal* stepping can produce **overlapping glides**; handled by
  retarget (smooth, no snap), but a brand-new step always overrides an in-flight
  glide toward the newest destination.
- The Doppler chirp it produces is bounded by `DOPPLER_TAU` (0.05 s) smoothing in
  the delay line; the glide makes the *position* sweep smooth, the delay line then
  resamples it — see doppler-and-propagation-delay.md.
