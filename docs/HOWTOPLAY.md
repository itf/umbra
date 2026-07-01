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

<!-- Canonical source of truth: src/game/controls.ts (CONTROLS). The in-app help
     (?/H) and tutorial speak that list; keep this table in sync with it. -->

| Action | How | What it does |
|---|---|---|
| **Step** | Tap the **left** / **right** footprints, or press **A** (left) / **D** (right), alternating | Walk forward one stride. Keep a steady rhythm — rushing or stepping the wrong foot makes you **stumble**. Pause and both feet reappear (either foot may go next). |
| **Forward** | Press **W** | Does nothing by default. Enable **Auto-step** in Settings, then **hold W** to walk forward at a steady medium-slow pace instead of tapping A/D. |
| **Turn** | Drag the **compass dial**, or the **arrow keys** (**Left**/**Up** left, **Right**/**Down** right) or **Q**/**E** (hold **Shift** to turn farther) | Rotates your heading smoothly; the whole soundscape turns with you so you can face a sound and walk to it. |
| **Clap / echo (probe)** | Tap **echo**, or press the **Down arrow** | A clap/probe whose reflections reveal the room's size and surfaces. In **sonar** levels claps are limited. |
| **Decoy** | Press **T** | Throws a sound decoy to lure a monster away from you (stealth levels). |
| **Settings** | Press **S**, or open the settings panel | Master volume, companion-voice toggle, **auto-step**, **debug overlay**, "getting warmer" proximity cue, swap left/right channels, and reset progress. |
| **Debug overlay** | Press **G** | Toggles the top-down minimap + audio readout (also `?debug=1` in the URL, or the Settings toggle). |
| **Help** | Press **?** or **H** | Repeats the controls, spoken. |

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
