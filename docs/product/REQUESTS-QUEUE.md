# Active user requests (post-session, being worked in parallel)

Tracked so nothing is lost across context compaction. Status as of the keybinding commit.

1. **Keybindings** — DONE (`7322e48`): arrows+Q/E turn (Left/Up=left, Right/Down=right),
   A/D step.

2. **Navigation/routing broken (HIGH).** The level-select screen is empty when you RETURN
   to it — it only populates on first page load. Need: pick another level after finishing
   a level AND mid-level (without finishing); reloading the page restores the same place;
   the browser BACK button goes to the previous screen. → screen routing + history/URL
   state; the picker must re-render on navigation, not just once at startup.
   OWNER: agent A (main.ts routing + levelPicker re-render).

3. **Settings: switch engine (Steam) in-game.** The Steam engine toggle is only on the
   Begin screen; add it to the in-game Settings panel so you can switch to/from Steam.
   OWNER: coordinator, after agent A (touches settings.ts + main.ts wiring).

4. **"Getting warmer" cue is unclear** — user doesn't know what it is. It's the beacon
   loudness-by-distance cue (just fixed in 747168c). Rename/explain it in Settings so it's
   understandable (or rework). OWNER: coordinator (with #3, settings.ts).

5. **Steam fork packaging.** As we modify three-steam-audio, make it a git SUBMODULE or
   VENDOR the compiled WASM so the dep is reproducible (not the local `file:../` link from
   2b38760). OWNER: agent D (fork repo + papasangre package.json/vite).

6. **Trainer A/B bug + keyboard (HIGH).** Sometimes only Room A has sound but Room B is
   still shown (real bug). Add keyboard play in the trainer: A/D = play room A/B, Q/E =
   select room. OWNER: agent B (trainer.ts, scenePlayer.ts, trainer.html).

7. **Steam head-tracked reflections** — in progress (background agent on the fork, the
   proper fix for maze navigation). Separate track.

Crackle-at-rest (default engine) was FIXED in 747168c.
