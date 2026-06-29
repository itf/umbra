# Product Overview

A plain-language description of what this product is, who it's for, what it does
today, and where it's going. For the engineering details see `docs/TECHNICAL.md`.

---

## The idea

**Navigate a world you can only hear.** Inspired by *Papa Sangre* — a landmark
audio-only iOS game — this is a game and a training tool where you move through
spaces using nothing but spatial sound through headphones. No visuals are needed to
play: you find your way by listening to a beacon, to your own footsteps, and to the
echoes of the room around you.

It has two intertwined goals:

1. **A game** — walk to the beacon through rooms and (eventually) past hazards,
   using the signature step-by-step movement that made the original special.
2. **An echolocation trainer** — practice estimating the size of a room from its
   echoes, judging materials by how they reflect sound, and locating objects by
   their reflections. The acoustics are physically modeled, so what you learn
   transfers to how real spaces sound.

It runs in any modern browser, installs as an app (PWA), and works offline.

---

## Who it's for

- **Anyone who loved Papa Sangre** and wants that tense, eyes-closed,
  feel-your-way-forward experience again — now on the open web.
- **Blind and low-vision players**, for whom an audio-first game is not a gimmick
  but the native way to play. The whole interface is screen-reader friendly and
  designed to be played with your eyes closed.
- **People practicing echolocation** — a safe, repeatable place to train the ear on
  room size, materials, and object position with instant feedback.
- **Sound and game designers** experimenting with spatial audio and level design.

---

## What you can do today

### Get set up (first run)
On your first visit you're guided through a short, fully eyes-free setup before
playing:
- **Calibration** confirms your headphones are on the right ears (a tone plays on
  your left, then your right, and you say which side you heard) and that the
  volume is comfortable. If your headphones are reversed it tells you — and offers
  a one-tap **swap left/right** toggle for the session.
- A **guided tutorial** teaches the three controls one at a time, with spoken
  instructions and a "next" gate: **stepping** (alternate feet in a rhythm),
  **turning** (drag the compass to rotate the soundscape), and **clapping** (tap
  echo to hear the room).

Both are skippable, remembered so they don't repeat, and replayable any time from
the picker. See [`docs/onboarding.md`](onboarding.md).

### Play the game
- Put on headphones and **choose a level** from the picker on the start screen. It
  lists a set of **bundled demo levels** — a curated tour of the engine (small vs.
  large rooms, dead vs. live surfaces, a sliding door you hear open, a beacon
  garden, a monster cellar, an open street, a cathedral alcove) — plus any levels
  you've **saved** in the editor. (You can also deep-link a demo with `?level=<id>`.)
- Press **Begin**, and you're in the chosen space with a **beacon** pulsing
  somewhere ahead.
- **Walk** by tapping the **left and right footprints**, alternating your feet like
  real steps. Find a steady rhythm: walk too fast and you **stumble**; only the foot
  you're meant to step with is shown, and both reappear when you pause.
- **Turn** with the **compass dial** — drag it and your heading rotates smoothly at a
  natural pace; the whole soundscape turns with you, so you can face the beacon and
  walk to it.
- Tap **echo** to **clap** and hear the room around you — the size and surfaces of
  the space reveal themselves in the reflections.
- Reach the beacon to **win**.
- **Bumping into walls** is felt: you stop, and the wall's material colors the bump
  sound. **Footsteps change with the floor** under you — concrete sounds sharp,
  carpet soft, gravel crunches.
- **Monsters hunt you by sound.** A monster you place in a level prowls with a low,
  unmistakable growl you can hear and locate. It is **deaf to where you actually
  are** — it chases the **last place you made noise**. Stumble, rush, or cross a
  loud floor (gravel, stone) and you give yourself away; tiptoe on carpet or foam
  and the trail goes cold — it drifts to where it last heard you while you slip past.
  As it closes in, its growl pitches up (Doppler) — your cue to freeze or change
  course. Let it reach you and you're **caught**.

### Train your ear (echolocation trainer)
A structured **drill page** (`/trainer.html`) that builds the skill of reading rooms
by ear. It plays you two rooms — **Room A** and **Room B**, replayable freely — and
asks a single fair question: which is **larger**, which is **wider**, which is
**longer**, which has **carpet** vs hard walls, which is **brick** vs **concrete**.
A separate **direction** drill plays one positioned sound and asks whether it's
**forward, behind, left, or right**. Each pair of rooms differs in *only* the thing
being tested, so the cue you learn is the real one. You get instant spoken
feedback, a running score, and difficulty that ramps with your streak. It's
eyes-free and screen-reader-first. See [`docs/trainer.md`](trainer.md).

### Explore the acoustics (debug page)
A set of **listenable scenes** lets you hear the engine directly: a beacon to turn
toward, a small room vs. a huge hall (same clap, very different echo), glass vs.
soft walls, a sound bending around a doorway, and a large object beside you — with
and without a room around it, so you can isolate what the object alone sounds like.

### Design your own levels (level editor)
A **top-down map editor** where you build spaces and play them instantly:
- Place the **start point**, **beacons**, **walls**, **floor zones** (different
  materials), **ceiling zones** (different heights — a low alcove inside a tall
  hall), and **monsters** (with their chase **speed** and **sound**).
- Give each beacon its own **sound** — a tone, bell, music box, drip, or low hum
  preset, or point it at your **own audio file** — and **preview** it in the editor.
- Make walls **move**: a wall that ping-pongs back and forth, or a **sliding door**
  that opens and closes — and the room acoustics track them as they move.
- Choose materials from a real palette: concrete, brick, glass, wood, carpet, foam,
  and outdoor surfaces like asphalt, grass, gravel, and water — for new objects and
  for the room's default walls, floor, and ceiling.
- Toggle **open space** — remove the room entirely and place buildings freely to
  simulate walking down a street between houses.
- **Save** levels in your browser, **export/import** them as files to share, and hit
  **Play** to drop straight into your design.

---

## What makes it different

- **Real acoustics, not faked reverb.** Echoes are computed from the actual room
  geometry and the physical sound-absorption of each surface. A small concrete room
  and a large carpeted one sound genuinely different because they *are* different —
  the same way they would be in life. This is what makes it a real trainer, not just
  a game with sound effects.
- **Rough surfaces sound rough.** A brick wall doesn't give a sharp echo like glass
  does — it scatters sound into a softer, spread-out reflection. The engine models
  this, so materials are distinguishable by ear.
- **Custom, swappable spatial hearing.** It uses real measured "head" data to place
  sounds in 3D around you, rather than the browser's generic spatializer — clearer
  and, in time, personalizable to your own ears.
- **Eyes-free by design.** Large touch targets, everything announced for screen
  readers, and a control scheme (alternating footsteps, a draggable compass) built
  to be operated without looking.
- **No install, works offline.** It's a web app that installs like a native one and
  keeps working with no connection.

---

## Current status

A complete, playable core:
- The game loop — walk, turn, stumble, clap, reach the beacon — works end to end.
- The acoustics engine models reflections, materials, scattering, and diffraction.
- The level editor lets you author and play custom spaces, indoor or open-air.
- The echolocation trainer drills room size, width, depth, materials, and sound
  direction with fair A/B comparisons, scoring, and ramping difficulty.

It is an early but solid foundation. The headline experience (navigate to a beacon
by sound, in a room whose echoes are real) is there.

---

## Where it's going

Near-term, the most impactful additions:
- **Richer beacon sounds** — bells, voices, water, or your own audio clips, so each
  goal has a character instead of a plain tone.
- **More varied levels** — multi-room layouts, streets, and training courses that
  ramp up difficulty.

Longer-term:
- **Moving and dynamic spaces** — doors that open, walls that shift, so the
  soundscape changes around you in real time.
- **Personalized hearing** — load your own ear profile for sharper, less ambiguous
  3D sound.
- **A deeper training mode** — building on the existing echolocation trainer with
  object-location drills, longer courses, and progress tracking over time.

See `docs/ROADMAP.md` for the concrete task list.
