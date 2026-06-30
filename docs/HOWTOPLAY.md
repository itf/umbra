# How to play

> Put on **headphones** — this is an audio-only game; stereo speakers won't place
> sounds around you. You can play with your eyes closed; everything is spoken and
> screen-reader friendly.

On first run you're walked through a short eyes-free setup: a **calibration**
(confirms your headphones aren't reversed, and the volume is comfortable) and a
**tutorial** that teaches each control one at a time. Both are skippable and
replayable from the picker. See [`onboarding.md`](onboarding.md).

> Cohesion note (Cycle 7B): controls/help are being consolidated into a single
> spoken source of truth. This doc describes the controls; the in-app tutorial and
> help speak them. If they ever disagree, the in-app help wins.

## Controls

| Action | How | What it does |
|---|---|---|
| **Step** | Tap the **left** / **right** footprints, alternating | Walk forward one stride. Keep a steady rhythm — rushing or stepping the wrong foot makes you **stumble**. Pause and both feet reappear (either foot may go next). |
| **Turn** | Drag the **compass dial** (also keyboard-turnable) | Rotates your heading smoothly; the whole soundscape turns with you so you can face a sound and walk to it. |
| **Clap / echo** | Tap **echo** | A clap whose reflections reveal the room's size and surfaces. In **sonar** levels claps are limited. |
| **Settings** | Open the settings panel | Master volume, companion-voice toggle, "getting warmer" proximity cue, swap left/right channels, and reset progress. |

## The four modes

A level's mode is set by how it's authored; the companion voice frames the goal
when you start.

- **Beacon** — the classic. A beacon pulses somewhere in the space; navigate to it
  by sound to win. Footsteps change with the floor; bumping a wall stops you and
  colours the bump by the wall's material.
- **Absorber** — find the **dead spot**: a patch of wall that swallows sound.
  Clap and move toward where the echo goes quiet; reaching the absorptive patch wins.
- **Sonar** — flash echolocation with a **limited clap budget** (and a cooldown).
  Spend your claps wisely to map the space and reach the goal.
- **Stealth** — reach the **exit** without being caught. Monsters are **deaf to
  where you are** — they hunt the **last place you made noise**. Stumbling, rushing,
  or crossing a loud floor (gravel, stone) gives you away; tiptoe on carpet or foam
  and the trail goes cold. A closing monster's growl pitches up (Doppler) — your cue
  to freeze or reroute. Get caught and the run ends.

## Other surfaces

- **Trainer** (`/trainer.html`) — drills for reading rooms by ear (size, width,
  depth, materials, direction), with a **daily challenge + streak** and adaptive
  difficulty. See [`trainer.md`](trainer.md).
- **Editor** (`/editor.html`) — author your own levels. See [`editor.md`](editor.md).
- **Debug** (`/debug.html`) — listenable acoustics scenes for verifying the engine.
