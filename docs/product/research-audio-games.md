# Research: Audio-Only Games, Echolocation Science, and Ideas for *papasangre*

*Researched 2026-06. A landscape scan of audio-only / blind-accessible games and
echolocation-training science, turned into a prioritized, engine-grounded idea
list. Companion to `docs/ideas/brainstorm.md` (which already covers many gameplay
modes); this doc adds the **research backing** and a **trainer-science** layer,
and re-prioritizes with effort/impact.*

> Engine reality check (`docs/TECHNICAL.md`, `docs/engine/*`): image-source early
> reflections + 8-band materials + scattering + first-order UTD diffraction + FDN
> late-reverb; measured-HRTF binaural; double-sided interior walls; runtime
> speed-of-sound; propagation delay + Doppler; moving walls with live IR; listener
> glide; a monster that hunts your **last noise**; per-material footsteps; beacon
> synth presets + custom audio; step-movement mechanic; clap/echo probe; a trainer
> with A/B discrimination drills (size, width, depth, material, reflector side,
> distance, gap).

---

## (a) Landscape summary

**What the celebrated audio-only games do well.** *Papa Sangre* and its sequel,
*The Nightjar*, and *A Blind Legend* are the genre's reference points. Their
praised qualities are remarkably consistent:

- **Binaural immersion + "play with your eyes closed."** Reviewers stress the
  experience is proportional to how much the player surrenders to the audio; the
  best moments come when 3D sound builds a vivid mental map a screen cannot
  ([TouchArcade](https://toucharcade.com/2011/01/26/papa-sangre-review-a-clever-binaural-audio-game-without-graphics/),
  [Sounding Out!](https://soundstudiesblog.com/2013/10/28/papa-sangre-immersion-and-audio-games/)).
- **A discrete step-movement mechanic that forces *listening between moves*.** Papa
  Sangre's tap-a-foot-per-step control (which we already mirror) is what makes the
  monster tension work — you must stop and listen ([TouchArcade](https://toucharcade.com/2011/01/26/papa-sangre-review-a-clever-binaural-audio-game-without-graphics/)).
- **Voice acting + narrative drive.** The Nightjar (Benedict Cumberbatch) and
  A Blind Legend lean on story and a guiding companion voice to give direction
  without visuals ([Nick Ryan](https://www.nickryanmusic.com/blog/the-nightjar-3d-audio-iphone-game)).
- **Empowerment, not only fear.** *Three Monkeys* (Incus Games) deliberately rejects
  the "run and hide in terror" loop, giving the player agency to hunt, seek, and
  attack — a noted contrast to the horror canon ([AudioGames forum](https://forum.audiogames.net/viewtopic.php?id=15264)).
  *Audio Defence: Zombie Arena* turns the same 3D-audio tech into an FPS where you
  shoot toward localized sounds.

**What players criticize.** Recurring complaints: price/download size relative to
short play length ([Wikipedia: Papa Sangre](https://en.wikipedia.org/wiki/Papa_Sangre));
and — across the broader catalogue — **poor onboarding and unlabeled UI**: games
that open with no spoken prompt telling you how to start, menus a screen reader
can't parse, and uncertainty about *when you're actually in the game*
([AFB crash course](https://afb.org/aw/14/11/15738),
[Design Guidelines for Audio Games](https://www.researchgate.net/publication/296643157_Design_Guidelines_for_Audio_Games)).
These are exactly the failure modes a PWA can design around.

**Accessibility best practice (transferable, even though we're audio-native).**
The Xbox Accessibility Guidelines and AFB's deep dives converge on: every menu
control must be **labeled and screen-reader announceable**; speak **context
changes** ("loading… done, you're in the level"); offer **speak-on-demand keys**
(e.g. a key for "where's my objective", health, score); encode each datum in
**multiple cues** (direction = spatial position, distance = volume, identity =
timbre/pitch — never one channel alone)
([Xbox AG 103/106](https://learn.microsoft.com/en-us/gaming/accessibility/xbox-accessibility-guidelines/106),
[AFB deep dive](https://www.afb.org/aw/fall2023/Blindness-Accessibility-in-Video-Games-A-Deep-Dive)).

**Echolocation science — the gold for our trainer.** Thaler and colleagues ran a
**10-week, 20-session click-based echolocation program** with blind *and* sighted
adults (21–79). Mean gains: **+21% size discrimination, +26% orientation
identification, +22% virtual-maze navigation**; some learners reached
expert-comparable performance, and gains were similar regardless of blindness or
age ([PLOS One](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0252330),
[Exp Brain Res](https://link.springer.com/article/10.1007/s00221-021-06230-5)).
Two of their four tasks are directly portable to our engine:

- **Size discrimination with adaptive distance.** Judge which of two disks is
  larger; **when accuracy ≥ 90% over two sessions, step the listener 33 cm
  farther away** (33 → 66 → 99 cm…). This is a ready-made *adaptive difficulty
  ladder* and a measurable milestone curve.
- **Orientation perception.** Judge a plank as vertical / 45° / 135° / horizontal —
  a 4-way classification, harder than A/B.
  ([Cerebral Cortex](https://academic.oup.com/cercor/article/34/6/bhae239/7696241))

Kish's *FlashSonar*/SonarVision curriculum independently confirms the **graduated
progression**: start seated, eyes closed, with an object held close to the face;
learn to hear it move left/right/front; only then add walking and cane-tapping
([NFB](https://nfb.org/flashsonar-understanding-and-applying-sonar-imaging-mobility),
[Visioneers](https://visioneers.org/daniel-kish/)). Both sources validate that our
A/B drills are the right *shape* but should (1) get an adaptive distance ladder,
(2) add multi-way classification, and (3) start from a near, head-locked object.

**Engagement patterns that fit.** Duolingo-style **daily streaks** raise daily
return ~2.3× past a 7-day streak; **adjustable/adaptive difficulty** lifts 30-day
retention ~22% by keeping players in flow
([Plotline](https://www.plotline.so/blog/streaks-for-gamification-in-mobile-apps),
[MoldStud](https://moldstud.com/articles/p-the-impact-of-game-difficulty-on-mobile-game-retention-rates-strategies-for-success)).
A daily seeded challenge + a streak is the single best retention lever for a
skill-training app, and our trainer is already seed-deterministic.

---

## (b) Prioritized feature / mode ideas

Effort: **S** ≈ days, **M** ≈ 1–2 weeks, **L** ≈ multi-week / new system.
Impact = experience uplift. Ordered by impact-per-effort.

| # | Name | One-line pitch | Why it fits our engine | Effort | Impact |
|---|------|----------------|------------------------|--------|--------|
| 1 | **Adaptive distance ladder** | Trainer auto-steps the target farther away once you hit ≥90% over two sessions (33→66→99 cm…), Thaler-style. | Drills are already seed-deterministic A/B over `Scene`; we just parameterize panel distance + track a per-exercise rung. | S | High |
| 2 | **Daily Challenge + streak** | One seeded scenario/day; complete it to extend a streak; a shareable score. | Trainer + levels are already seed-driven and deterministic; reuse `ScenePlayer`. Pure product layer, no engine change. | S | High |
| 3 | **Sonar/clap budget** | Limited (or cooldown-gated) claps so every probe is a decision — the real "click deliberately" discipline. | Clap path exists and is currently free; add a counter/cooldown + HUD readout (spoken). | S | High |
| 4 | **Spoken UI + speak-on-demand keys** | Every menu item labeled & announced; keys for "where's the objective", "what level", "repeat instructions"; speak context changes ("you're in the level now"). | Directly addresses the #1 catalogue criticism; PWA + Web Speech / ARIA-live. No acoustics change. | M | High |
| 5 | **Guided onboarding (head-locked → walk)** | A first-run tutorial: object held at face, "is it left or right?", then front/back, then take one step — mirrors Kish's seated start. | Composes positioned `HrtfSource` + clap + the step mechanic; scripted scene sequence. | M | High |
| 6 | **Orientation / multi-way ID drill** | Classify a panel as vertical / 45° / 135° / horizontal (4-way), beyond A/B. | Reflector drill already places a double-sided panel in an absorbent room; add rotation + 4-choice scoring. | M | High |
| 7 | **Stealth: evade the noise-hunter (mode)** | Reach the exit uncaught: tiptoe on carpet, freeze, slip past — make the monster a *mode*, not a feature. | `monster.ts` + `noiseEvents.ts` + floor zones already exist; add objective + caught/escape states. | M | High |
| 8 | **Throw-a-sound decoy** | Toss a pebble; it lands with a spatialized clack and pulls the monster to that spot — gives stealth a verb. | One-shot positioned `HrtfSource` + `NoiseTracker.emit` at landing; AI already chases freshest noise. | S | Med |
| 9 | **Material-ID & "find the absorber" as scored drills** | Promote clap-and-name-the-surface and find-the-dead-spot into trainer exercises with the adaptive ladder. | 8-band materials + scattering + the existing clap make these acoustically valid today. | S | Med |
| 10 | **Multi-beacon route / mini-campaign** | A built map of N beacons (distinct timbres) you must visit in order — forces a mental map. | `beacons[]` schema + per-beacon presets exist (beacon-garden proves distinguishability); add collected-state + win-over-N. | M | Med |
| 11 | **Companion voice guide** | A character that calls out, reacts when you stray, and narrates objectives — direction without visuals. | Custom-audio beacon path exists; record/synthesize VO lines + a "straying" trigger off heading error. | M | Med |
| 12 | **Corridor of Doors (timing level)** | Sliding doors open/close on cycles; time your passage by the changing echo + beacon leaking through the gap. | Moving walls (`motion: slide`) + diffraction through gaps already modeled. | S | Med |
| 13 | **Adaptive game difficulty (DDA)** | Scale monster aggression / time pressure / clap budget to recent performance to hold players in flow. | Tuning layer over monster + budget systems; retention-backed. | M | Med |
| 14 | **Hazards you hear (pits, hissing gas)** | Dangers that *announce themselves* (draft/hiss/ticking plate) you must localize and route around. | Hazard zone in `schema.ts` + ambient positioned loop + enter-zone fail; roadmap already lists hazards. | M | Med |
| 15 | **Async ghost / leaderboard** | Race a recorded "noise trail" of another run; post fastest stealth clears. | Needs a record/replay + storage layer; no acoustics change but real product scope. | L | Med |

*(Speculative, not ranked: real-time co-op call-and-response — one player is the
beacon, the other navigates, roles swap. Genuinely novel audio-only multiplayer
but requires networking — **L**.)*

---

## (c) Quick wins (ship fast)

1. **Sonar/clap budget (#3)** — one counter + spoken HUD; instantly adds tension
   to every probe and teaches deliberate clicking. (Already flagged as the single
   highest-leverage small tweak in `brainstorm.md`.)
2. **Daily Challenge + streak (#2)** — seed-of-the-day over the existing
   deterministic generators; the best retention lever for a skill app.
3. **Adaptive distance ladder (#1)** — the Thaler 90%→step-back rule on the
   existing distance/size drills; turns the trainer from flat drills into a
   measurable progression with milestones.
4. **Throw-a-sound decoy (#8)** — small new system that makes stealth a verb and
   "just works" with the existing noise-chasing AI.
5. **Speak context changes + a "where's my objective" key (subset of #4)** — closes
   the most-cited audio-game onboarding gap with a small Web Speech / ARIA-live
   addition, no acoustics work.

---

## (d) Sources

**Audio-only games & player reception**
- [Papa Sangre — Wikipedia](https://en.wikipedia.org/wiki/Papa_Sangre)
- [Papa Sangre review — TouchArcade](https://toucharcade.com/2011/01/26/papa-sangre-review-a-clever-binaural-audio-game-without-graphics/)
- [Papa Sangre & immersion — Sounding Out!](https://soundstudiesblog.com/2013/10/28/papa-sangre-immersion-and-audio-games/)
- [The Nightjar — Nick Ryan (sound designer)](https://www.nickryanmusic.com/blog/the-nightjar-3d-audio-iphone-game)
- [Three Monkeys — AudioGames.net forum](https://forum.audiogames.net/viewtopic.php?id=15264)
- [The World of Audio Games: A Crash Course — AFB AccessWorld](https://afb.org/aw/14/11/15738)
- [Design Guidelines for Audio Games — ResearchGate](https://www.researchgate.net/publication/296643157_Design_Guidelines_for_Audio_Games)

**Accessibility best practice**
- [Xbox Accessibility Guideline 106 (spatial audio / multi-cue) — Microsoft](https://learn.microsoft.com/en-us/gaming/accessibility/xbox-accessibility-guidelines/106)
- [Xbox Accessibility Guideline 103 — Microsoft](https://learn.microsoft.com/en-us/gaming/accessibility/xbox-accessibility-guidelines/103)
- [Blindness Accessibility in Video Games: A Deep Dive — AFB](https://www.afb.org/aw/fall2023/Blindness-Accessibility-in-Video-Games-A-Deep-Dive)

**Echolocation training science**
- [Human click-based echolocation: 10-week program — PLOS One](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0252330)
- [10-week training & auditory localization — Exp Brain Res](https://link.springer.com/article/10.1007/s00221-021-06230-5)
- [Cortical changes after 10 weeks of click training — Cerebral Cortex](https://academic.oup.com/cercor/article/34/6/bhae239/7696241)
- [FlashSonar: Understanding and Applying Sonar Imaging — NFB](https://nfb.org/flashsonar-understanding-and-applying-sonar-imaging-mobility)
- [Daniel Kish / SonarVision — Visioneers](https://visioneers.org/daniel-kish/)

**Engagement & retention**
- [Streaks and milestones for gamification — Plotline](https://www.plotline.so/blog/streaks-for-gamification-in-mobile-apps)
- [Game difficulty & mobile retention — MoldStud](https://moldstud.com/articles/p-the-impact-of-game-difficulty-on-mobile-game-retention-rates-strategies-for-success)
