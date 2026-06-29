# Design Ideas — Brainstorm

A working idea-bank for *papasangre*, the audio-only navigation game **and**
echolocation trainer. Grounded in what the engine can actually do today. Each
idea is tagged with priority (**HIGH / MED / SPEC**ulative), a one-line *why*,
and *what it needs* — explicitly calling out **composes existing pieces** vs.
**needs new engine work**.

> What's real today (read `docs/TECHNICAL.md` + `docs/engine/*`): image-source
> early reflections + 8-band materials + scattering + first-order UTD diffraction
> + FDN late-reverb tail; measured-HRTF binaural; **double-sided interior walls**;
> runtime speed-of-sound; propagation delay + Doppler for moving sources; moving
> walls (slide/translate) with live IR; audio-only listener glide; a monster that
> hunts your **last noise** (not your position); per-material footstep loudness
> driving that noise model; per-beacon synth presets + custom audio; the
> step-by-step movement mechanic (alternate feet, rhythm, stumble); a clap/echo
> probe. The big missing perf lever: the IR build is still ~32 ms in JS for the
> *room* convolver path (the live `HrtfSource` path is fine).

The engine's superpower, stated plainly: **it produces information a screen
cannot.** Room size, surface material, the side a wall is on, the distance to an
obstacle, a moving thing's approach — all carried in echo timing, color, and
direction. Every idea below should be earning its keep by leaning on *that*.

---

## 1. Gameplay / game modes

Beyond walk-to-the-beacon. The recurring theme: make the player **read the room
by ear** and **manage the noise they emit**.

### HIGH

- **Stealth: evade the noise-hunter** — *why:* the monster already hunts your
  last noise, so the whole stealth loop (tiptoe on carpet, freeze, lure it with a
  loud step, slip past) is one tuning pass away from being a *mode*, not a
  feature. *Needs:* composes existing pieces — `monster.ts` + `noiseEvents.ts` +
  floor zones. New: an explicit objective ("reach the exit without being caught")
  and a *lure* affordance (a throwable noise — see below). MED-effort.
- **Throw-a-sound decoy** — *why:* gives stealth a verb. Toss a pebble; it lands
  with a spatialized clack and registers as a `NoiseEvent` at the landing point,
  pulling the monster there. *Needs:* small new system — a one-shot positioned
  `HrtfSource` + a `NoiseTracker.emit` at the landing spot. The AI already chases
  the freshest loud noise, so it *just works*.
- **Collect-multiple-beacons (ordered or free)** — *why:* turns a single goal
  into a route you must build a mental map for; the natural backbone of a
  campaign. *Needs:* schema already has `beacons[]`; needs a "collected" state +
  next-objective flow + a win condition over N beacons. Each can use a different
  preset so they're distinguishable by timbre (beacon-garden already proves this).
- **Sonar-budget darkness ("flash sonar")** — *why:* the clap is free today, so
  there's no tension in probing. Give the player a *limited* clap budget (or a
  cooldown), and suddenly every probe is a decision — exactly the real-world
  echolocation discipline of *clicking deliberately*. *Needs:* composes existing
  pieces (the clap path + a counter/cooldown UI). The single most game-changing
  small tweak in this doc.

### MED

- **Escort / follow-a-sound** — *why:* invert the beacon — a friendly sound
  *moves* and you must keep pace (stay within earshot/range) as it wanders a
  route. Showcases Doppler + glide. *Needs:* a moving `HrtfSource` on a path (the
  monster movement code generalizes) + a "too far / lost it" fail state.
- **Hazards you hear: pits, traps, hissing gas** — *why:* a hazard that
  *announces itself* (a draft/hiss from a pit edge, a ticking pressure plate) is a
  pure-audio danger you must localize and route around. *Needs:* a hazard zone in
  `schema.ts` + an ambient positioned loop + an enter-zone fail. Roadmap already
  lists hazards.
- **Time pressure: the rising tide / closing walls** — *why:* combines two engine
  features (moving walls + a moving threat) into urgency. A wall-of-sound (white
  noise front, or literally moving walls) advances; you must out-navigate it.
  *Needs:* composes moving-walls + an advancing noise source. SPEC-adjacent on
  tuning.
- **The "noisy floor" gauntlet** — *why:* a level that is a puzzle of *where you
  can step quietly*. Gravel patches you must avoid, carpet stepping-stones across
  a stone floor, all while a monster listens. *Needs:* composes floor zones +
  monster. Pure level design — buildable today.

### SPEC

- **Async ghost / leaderboard** — race a recorded "ghost" of another player's
  noise trail, or post fastest stealth-clears. *Needs:* a recording/replay layer +
  storage; no engine changes but real product scope.
- **Co-op call-and-response (two players, two devices)** — one player is the
  beacon (taps to emit a sound), the other navigates to them; roles swap. *Needs:*
  networking — big. But it's a genuinely novel *audio-only* multiplayer.
- **Conversation/voice beacons** — a character calling out ("over here!", getting
  impatient as you stray) using custom-audio. *Needs:* recorded VO + the existing
  custom-audio beacon path. Cheap to prototype, high charm.

---

## 2. Level / world design

~12 concrete levels, each chosen to teach **one cue** and show off **one engine
feature**. (Engine notes: long reverb = big hard room via Eyring RT60; rough
echo = brick/scattering; bending = diffraction edges at free wall-ends; Doppler =
moving source/listener; alien physics = `speedOfSound`.)

### HIGH (buildable today, high "wow")

1. **The Cathedral** — a huge marble nave. *Cue taught:* reverb tail length =
   volume; a clap blooms for seconds. *Engine:* FDN late-reverb + big hard room.
   The flagship "listen to scale" level. (`stepped-ceiling-alcove` is a seed.)
2. **The Clap-Maze** — a tight maze of interior walls in near-darkness with a
   limited clap budget. *Cue:* near walls return fast/bright echoes; openings
   return *nothing* — you map the maze by where the echo *isn't*. *Engine:*
   double-sided interior walls + diffraction at corners + sonar budget. The
   purest "see with sound" level.
3. **Corridor of Doors** — a long hall lined with sliding doors that open and
   close on cycles; you must time your passage. *Cue:* a moving-wall opening
   changes the local echo + lets the beacon through. *Engine:* moving walls
   (`motion: slide`) + diffraction through the gap.
4. **The Wind Tunnel** — a sound source (or you) screams past on a track. *Cue:*
   Doppler pitch-bend tells you approach vs. recede and closest-approach timing.
   *Engine:* moving `HrtfSource` + propagation delay/Doppler.

### MED

5. **Hall of Moving Walls** — walls that ping-pong (`motion: translate`); the room
   *breathes*, its echo signature shifting. *Cue:* a changing reverb = changing
   geometry; navigate a space that won't hold still. *Engine:* moving walls
   (translate).
6. **The Flooded Cistern** — water floor + hard stone walls; dripping beacons
   (the `drip` preset) echoing in a long tail. *Cue:* material contrast (water vs
   stone) + reverb. *Engine:* `water` material + drip beacons + FDN tail. (Water's
   absorption is currently *estimated* — flag it; fine for a game level.)
7. **Open Street at Night** — `open: true`, buildings as free-standing blocks;
   a beacon around a corner you hear *bend* to you. *Cue:* diffraction — a sound
   you hear before you can walk straight to it. *Engine:* open levels + auto-edges
   (`open-street` is the seed; make it a proper level with corners to round).
8. **Material Gallery** — a row of alcoves, each a different surface (glass, brick,
   carpet, foam, wood); walk past and clap into each. *Cue:* material ID by echo
   color/roughness. *Engine:* floor + wall material zones. Doubles as a training
   "free play" room.

### SPEC (needs new engine work — worth it)

9. **The Alien Cavern ("speed of sound is wrong")** — `speedOfSound` halved or
   doubled, so echo *timing* lies about distance. *Cue:* recalibrate your
   distance sense; a puzzle where the trick *is* the wrong physics. *Engine:*
   `speedOfSound` is already a runtime param — this just needs to be **exposed in
   the schema/editor** (small) to author per-level. High-novelty, low-cost.
10. **The Elevation Stairwell** — a beacon above/below you. *Cue:* up/down
    localization (HRTF elevation). *Engine:* the HRTF set *has* elevation data but
    it's unverified (roadmap §HRTF "Elevation cues"). Needs verification work
    before it's reliable, but unlocks a whole vertical dimension.
11. **The Curved Plaza** — a rounded amphitheatre that focuses echoes. *Cue:*
    concave-geometry focusing. *Engine:* solver is convex-only — needs curved-wall
    tessellation (roadmap §"Non-flat geometry"). Real engine work; flag as L.
12. **The Whispering Gallery** — a domed room where a faint sound carries across
    via the wall. *Cue:* surprising propagation. *Engine:* depends on curved
    geometry (above) — SPEC pairing with #11.

---

## 3. Echolocation training — exercises + pedagogy

The criticism that A/B size/width/length drills are **solvable by loudness
alone** is the key lesson. The `reflector` drill fixed it by mirroring scenes
(same loudness, only the *side* differs). **Design principle: every new drill
must hold loudness/RT constant and force the player onto the intended cue** — the
generator already *guarantees* "one variable at a time," and the tests enforce
it. Keep that invariant.

Each new drill maps to a real flash-sonar / human-echolocation skill.

### HIGH — new drills that resist the loudness shortcut

- **Distance-to-wall estimation** — clap facing one wall at distances X vs Y;
  "which wall is CLOSER?" *Real skill:* the core flash-sonar judgment — echo
  *delay* = distance. *Fair design:* hold room size/material constant; vary only
  the listener-to-wall gap, and **roving the absolute level** so loudness can't
  be used. *Needs:* new generator in `exercises.ts` (composes the shoebox solver).
- **Find-the-gap / doorway** — a wall ahead with an opening on the left vs right;
  "which side is the GAP?" *Real skill:* detecting an *aperture* by the absence of
  reflection + the diffraction signature at the jamb (flash-sonar "open door"
  detection — a documented blind-navigation skill). *Needs:* interior wall with a
  gap + auto-derived edges (both exist); new generator. Mirror left/right for
  fairness like `reflector`.
- **Count-the-objects** — 1 vs 2 vs 3 reflector panels around you; "how many
  objects?" *Real skill:* parsing multiple discrete echoes (advanced flash
  sonar). *Fair design:* same total reflective area split into N panels, roved
  level, so it's *count* not *loudness*. *Needs:* multi-panel scenes
  (`makePanel` already builds one double-sided panel — generalize to N).

### MED

- **Material ID with closer pairs** — current brick-vs-concrete is a big jump;
  add a difficulty axis that narrows the pair (concrete vs plaster, carpet vs
  foam) as the player improves. *Real skill:* surface discrimination. *Needs:* the
  `genBrick`/`genCarpet` generators + a per-difficulty material-pair ladder.
- **Shape discrimination: corner vs flat vs curved** — is the reflector ahead a
  flat panel, an inside corner (two panels), or (later) a curved face? *Real
  skill:* object-shape sensing — the hardest, most impressive flash-sonar skill.
  *Needs:* flat + corner are buildable now (two `makePanel`s); curved needs the
  curved-geometry work (§2.11). Start with flat-vs-corner.
- **Moving-reflector tracking** — a panel that drifts left→right; "which way is it
  moving?" or "is it approaching?" *Real skill:* tracking a moving object by
  echo direction + Doppler. *Needs:* a moving reflector — the moving-walls path +
  a clap loop, or a moving `HrtfSource` "sounding object." MED engine glue.
- **Walk-the-corridor-by-ear** — an *interactive* drill (bridges trainer↔game):
  walk a corridor in the dark using only wall echoes; score = bumps. *Real
  skill:* applied mobility echolocation. *Needs:* a minimal game-mode harness in
  the trainer page (reuses `game.ts` collision + clap). Highest-value bridge from
  "discriminate" to "navigate."

### Pedagogy — a structured curriculum

A ladder from *detect* → *discriminate* → *localize* → *navigate*. Gate
progression on demonstrated mastery (see §4 measurement).

- **Tier 0 — Calibrate & orient** (onboarding, §5): L/R balance check, "is this
  on your left or right?", front/back. Skill: trust the spatial render.
- **Tier 1 — Presence/absence:** "is there a wall ahead?" (clap → echo or
  silence). Distance-to-wall (near/far). Skill: detect an echo at all.
- **Tier 2 — Size & material:** larger/wider/longer (existing) + material ID.
  Skill: read a room's gross properties. *(Keep, but add level-roving so it's not
  loudness.)*
- **Tier 3 — Localize objects:** reflector side (existing), find-the-gap,
  count-the-objects. Skill: place discrete objects by echo direction.
- **Tier 4 — Shape & motion:** corner-vs-flat, moving-reflector tracking. Skill:
  characterize and track objects.
- **Tier 5 — Navigate:** walk-the-corridor, then a full clap-maze. Skill: move
  through space by ear. *(This is where trainer becomes game.)*

Each tier has a **gate**: e.g. ≥80% over the last 20 trials at difficulty ≥0.6
unlocks the next. Show progress as a per-skill mastery bar (screen-reader
announced). This turns scattered drills into a *course* with a finish line.

### Measuring progress / mastery

- Track per-drill **accuracy at the threshold difficulty** (not raw % — see §4),
  a rolling window, and a **psychometric threshold** (the difficulty at which the
  player is ~75% correct). Threshold *moving toward 1.0* = real improvement.
- Persist per-skill history (IndexedDB, like saved levels) and announce trends
  ("your distance estimation improved this week"). *Needs:* a results store + the
  adaptive engine in §4.

---

## 4. Difficulty scaling

The generators already take `difficulty ∈ [0,1]`; today a naive **streak ramp**
(`difficulty = min(1, streak·0.12)`, reset on miss) drives it. That's coarse and
punitive (one slip resets you). Replace it with an **adaptive staircase** that
parks the player at their threshold.

### Knobs — what each drill can vary (existing vs. needs building)

- **Contrast size** — *exists.* `contrast()` already scales size factor (1.8→1.15)
  and direction jitter. The primary knob.
- **Level roving (anti-loudness)** — *needs building.* Randomize absolute
  playback level per scene so loudness can't be a crutch. Cheap, high-impact —
  add to `ScenePlayer`/trainer.
- **Reverberance masking** — *needs building.* Add a touch of reverb/background to
  blur the cue at high difficulty (a distractor room around the target). Composes
  existing FDN.
- **Distractor sounds** — *needs building.* Background ambience or a competing
  source the player must listen *past*. Composes positioned `HrtfSource`s.
- **Target size / proximity** — *exists for reflector* (bearing offset 40°→20°),
  generalize to other localization drills.
- **Time pressure** — *needs building.* Limit replays (you may play Room A only
  twice) or add an answer clock. A strong difficulty axis the A/B format ignores
  today.
- **Number of distractors/objects** — *needs building* (the count drill).

### Adaptive scheme — recommended

Use a **transformed up-down staircase** (Kaernbach 1-up/N-down, targeting ~75%),
not the streak ramp:

- Correct → *small* difficulty increase; incorrect → *larger* decrease (a
  weighted 1-up/2-down or 1-up/3-down converges to a defined percent-correct).
- Use **decreasing step sizes** after the first few reversals to home in on
  threshold.
- **Estimate the threshold** as the mean difficulty over the last K reversals;
  that number *is* the mastery score and the gate input for §3.
- *Stretch:* a lightweight **Bayesian/QUEST-style** estimator (maintain a belief
  over the threshold, pick the most-informative next difficulty). More efficient,
  more code — SPEC. The staircase gets 90% of the value.

*Needs:* a small pure `adaptive.ts` (testable like `exercises.ts`), wired into
`trainer.ts` to replace the streak line. The generators are already
difficulty-parameterized, so this is the highest-leverage trainer change.

---

## 5. Accessibility & onboarding

It's an eyes-free game; this is the native experience, not an add-on. Today there
is **no guided first-run** (roadmap §"Onboarding/tutorial" is 🔴) — the biggest
gap for new players.

### HIGH

- **Audio calibration / first-run check** — *why:* the whole game depends on
  headphones being on the right ears at a sane volume. A 60-second guided check:
  "you should hear this on your LEFT… now your RIGHT" (swap detection), a volume
  ramp, and a front/back confirmation. *Needs:* a positioned-tone sequence
  (trivial with `HrtfSource`) + a screen-reader-first flow. Should run before
  first play.
- **Guided movement tutorial (eyes-free)** — *why:* the step rhythm + stumble +
  compass are unintuitive without instruction. A spoken tutorial: tap left, tap
  right, find the rhythm (it tells you when you rush), turn to face a tone, walk
  to it, clap to hear the room. *Needs:* a scripted tutorial level + VO + gated
  steps. Composes the game; mostly content.

### MED

- **Haptics** — *why:* step/stumble/bump/caught feedback through touch (the
  original leaned on this) helps confirm actions eyes-free and aids deaf-blind and
  noisy-environment play. *Needs:* the Vibration API wired to step/bump/caught
  events (roadmap §Haptics, 🔴). Small, high-comfort.
- **Settings surface** — *why:* master/beacon volume, turn speed, rush
  sensitivity, (later) HRTF subject — all matter for accessibility and comfort.
  *Needs:* roadmap §Settings (🔴) + persistence.
- **Screen-reader flow polish across pages** — the trainer is already
  ARIA-first; extend the same rigor (announced state, focus management, large
  targets) to the *game's* win/lose/caught flows and the level picker.

### SPEC

- **HRTF personalization / fit** — let users pick an HRTF subject (or upload a
  SOFA) and A/B them to reduce front/back confusion. *Needs:* roadmap §"Selectable
  HRTF" — the loader accepts arbitrary SOFA; needs UI + in-browser bake. The main
  fix for the one persistent localization weakness.

---

## 6. Engine levers worth pulling (under-used today)

Capabilities that already exist but aren't yet earning experiences:

- **`speedOfSound` as a level param** — built, threaded everywhere, **exposed
  nowhere**. Surfacing it in schema/editor unlocks the Alien Cavern (§2.9) and
  distance-recalibration puzzles for almost no cost. *Highest ratio of novelty to
  effort in the whole doc.*
- **The FDN reverb tail at cathedral scale** — we have RT60-from-geometry but no
  level that *celebrates* it. The Cathedral (§2.1) is one big hard room away.
- **Doppler + propagation delay** — only the monster really moves today. Moving
  *sounding objects* (escort, wind-tunnel, moving reflector, passing vehicles in
  the open street) are all this lever. The movement code in `monster.ts`
  generalizes to a path-follower.
- **Moving walls** — slide/translate exist and the live IR tracks them; only
  `sliding-door` uses it. Corridor-of-doors, hall-of-moving-walls, and
  closing-walls time pressure are all here.
- **Custom audio (beacons & footsteps)** — `soundUrl` per beacon + sample URLs
  per material are built. This is the door to **VO characters, ambient
  soundscapes, and recorded real-world textures** with zero new engine code —
  pure content.
- **Double-sided interior walls** — just landed; the reflector drill uses one
  panel. Multi-panel scenes (count/shape drills) and free-standing obstacle
  courses are the obvious next users.
- **The noise model** — drives the monster, but the same `NoiseEvent` stream
  could drive *ambient consequences* (disturb a flock, trigger a trap, alert
  multiple listeners). Under-exploited.
- **Diffraction edges** — auto-derived at free wall-ends; the find-the-gap drill
  and around-the-corner beacons make them *audible as a teachable cue* rather than
  just physical correctness.

---

## 7. Recommended NEXT 5 (ordered)

Decisive. Each: effort (S/M/L) + why it's the highest leverage.

1. **Sonar/clap budget + the Clap-Maze level** — **S–M.** *Why first:* the clap is
   the signature verb and it's currently *free*, so it carries no tension. Making
   it a managed resource instantly creates strategy, and the clap-maze is the
   single best showcase of "navigate by echo." Touches the clap path + a tiny
   budget UI + one level. Transforms the game's feel for almost no engine work.

2. **Adaptive staircase for the trainer (`adaptive.ts`) + level-roving** — **S–M.**
   *Why:* the generators are already difficulty-parameterized and the streak ramp
   is the weakest link. A proper 1-up/2-down staircase + per-scene level roving
   kills the loudness shortcut *and* keeps every learner at their threshold,
   turning the trainer from a quiz into a real training instrument. Pure, testable,
   contained.

3. **Two anti-loudness drills: distance-to-wall + find-the-gap** — **M.** *Why:*
   these teach the two most fundamental real echolocation skills (echo-delay =
   distance; aperture detection) and both compose existing solver/diffraction
   pieces. They also fill Tiers 1 and 3 of the curriculum, making the ladder
   real. New generators in `exercises.ts`, same fairness discipline as `reflector`.

4. **Onboarding: calibration check + guided eyes-free tutorial** — **M.** *Why:*
   the game is unplayable-by-strangers without it; it's the top accessibility gap
   (🔴 on the roadmap) and gates every other feature's reach. Mostly content +
   flow, minimal engine. Do it before any campaign push so new players don't
   bounce.

5. **The Cathedral level + expose `speedOfSound` in the editor** — **S.** **✅ DONE.**
   *Why:* two near-free wins that activate already-built engines (FDN tail; runtime
   speed-of-sound). The Cathedral is the emotional "whoa, scale" moment the demo
   set lacks; the speed-of-sound toggle unlocks a whole class of alien/puzzle
   levels for the cost of one schema field + one editor input.
   *Shipped:* `cathedral` builtin (vast marble nave, long FDN tail) and a
   `slow-sound-vault` demo (`speedOfSound: 150`). `Level.speedOfSound?` threads
   through load → `GameLevel`/`LoadedLevel` → the clap (`computeRoomTaps`) AND the
   live sources (`renderer.setSpeedOfSound`, so beacon/monster delay + Doppler match).
   Editor Room panel gains a "Speed of sound (m/s)" input. See
   `docs/engine/speed-of-sound.md`.

---

### Cross-cutting note

The through-line for all five: **lean into what only an audio game can do** — the
clap-budget makes *listening* a resource, the anti-loudness drills make *echo
reading* the skill, the cathedral makes *scale* a feeling, and onboarding makes
the eyes-free interface learnable. None of the top five needs the big perf item
(WASM/FFT room-IR build); that stays a prerequisite for *continuously*
moving-wall-heavy levels (§2.5, closing-walls), which is why those sit one tier
down.
