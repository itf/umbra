# Echolocation Training — Research & Exercise Design

> A research/ideas deliverable: how humans learn flash sonar (click-based echolocation), the
> concrete exercises instructors and researchers use, a progression ladder, and how each rung
> could be realized in a browser-based binaural web-audio game.

## 0. Scope and TL;DR

Human echolocation ("flash sonar", "FlashSonar", "SonarVision") is a trainable perceptual
skill. Both blind and sighted (blindfolded) people can learn it, and measurable gains appear
within **an hour** for coarse depth judgments and grow steadily over **weeks** of structured
practice. The teaching arc is remarkably consistent across instructors and labs:

1. **Presence / absence** — "is there a big reflective thing near me or not?"
2. **Localization** — "which side / what direction is it?"
3. **Discrimination** — distance, size, orientation, then material/texture.

The canonical entry exercise is a **flat reflective panel held in front of the learner**, who
reports *present vs. absent*, then *near vs. far*, then *left vs. right*. This maps almost
one-to-one onto a 2-alternative-forced-choice (2AFC) web game with a movable virtual reflector
and a staircase difficulty controller. The preferred probe is a **short, broadband tongue
click** because it is brief, repeatable, and spectrally rich.

---

## 1. How the skill is learned (pedagogy)

### 1.1 Who can learn it, and how fast
- Novice **sighted** people, blindfolded, can estimate object depth after roughly **one hour**
  of training, and improve size-discrimination over multiple sessions (with large individual
  variability). See *Depth Echolocation Learnt by Novice Sighted People*
  ([PLOS One, 2016](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0156654)).
- A structured **10-week program (20 sessions, 2–3 h each)** produced robust gains in both blind
  and sighted adults, and transferred to real-world navigation, in Thaler et al.,
  *Human click-based echolocation: effects of blindness and age... a 10-week training program*
  ([PLOS One, 2021](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0252330) /
  [PMC8171922](https://pmc.ncbi.nlm.nih.gov/articles/PMC8171922/)).
- Expert acuity sets the ceiling: experienced blind echolocators detect distance changes of
  **~3 cm at a 50 cm reference** and **~7 cm at 150 cm** — *Human Click-Based Echolocation of
  Distance: Superfine Acuity...*
  ([J. Assoc. Res. Otolaryngology, 2019](https://link.springer.com/article/10.1007/s10162-019-00728-0)
  / [PMC6797687](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC6797687/)).

### 1.2 The teaching arc (Daniel Kish / World Access for the Blind)
Daniel Kish, who lost both eyes as an infant and self-taught tongue-click sonar, founded
**World Access for the Blind** (2000) and, with Jo Hook, authored the first systematic
FlashSonar curriculum (*Echolocation and FlashSonar*, WAFTB / Visioneers). See
[visioneers.org](https://visioneers.org/) and Kish's
[TED talk](https://www.ted.com/talks/daniel_kish_how_i_use_sonar_to_navigate_the_world),
plus the National Federation of the Blind write-up
*FlashSonar: Understanding and Applying Sonar Imaging to Mobility*
([nfb.org](https://nfb.org/flashsonar-understanding-and-applying-sonar-imaging-mobility)).

The pedagogical principles that recur:

- **Start with a strong, easy signal.** Large, flat, hard, close reflectors (a wall, a cookie
  sheet, a big foam/metal board) at close range produce the loudest, earliest, most obvious
  echo. Beginners learn "sonar exists" here before anything subtle.
- **Consistent probe.** Learners are taught a repeatable tongue click so the *outgoing* signal
  is held constant and all perceptual change is attributable to the environment.
- **Presence before position before property.** First just *notice* the reflected sound
  (a "sound shadow" / added coloration), then find *where* it is, then judge *what* it is
  (how far, how big, what shape, what material).
- **Active exploration.** Head turns and self-motion are encouraged — moving the head changes
  the echo and disambiguates direction/distance (see §1.3).
- **Fade the crutches.** Move the reflector farther, make it smaller, make it less reflective
  (metal → wood → foam → cloth), add background noise, and reduce the number of clicks allowed.

The EU **EchoProVIP** *Training Curriculum: Active echolocation for people with visual
impairment* ([PDF](https://firr.org.pl/wp-content/uploads/2020/03/O1_Curriculum_EchoProVIP_eng.pdf))
formalizes a similar sequence for orientation-and-mobility instructors.

### 1.3 Why head movement and self-motion matter
Exploratory **head movements** improve ranging in human sonar — *Ranging in Human Sonar:
Effects of Additional Early Reflections and Exploratory Head Movements*
([PLOS One, 2015](https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0115363) /
[PMC4281102](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC4281102/)). Interestingly, experts
localize **better when a target is 45° off-axis** than dead ahead, and they click more softly
in that case — *Human Echolocators Have Better Localization Off Axis*
([Psychological Science, 2022](https://journals.sagepub.com/doi/full/10.1177/09567976211068070)).
Design implication: don't force targets to be dead-ahead; off-axis and head-turn-enabled trials
are pedagogically legitimate and match expert behavior.

### 1.4 The acoustic cues, in the order they get trained
| Stage | Cue the learner exploits |
|---|---|
| Presence/absence | Added loudness/coloration; a faint delayed copy of the click; timbral change |
| Left/right | Interaural level & time differences (ILD/ITD) of the echo; head-shadow |
| Up/down, front/back | Spectral (pinna/HRTF) notches; effect of head tilt |
| Distance | Echo **delay** (time-of-flight) and echo **level**; direct-to-reflected ratio |
| Size | Angular extent → echo strength and spectral filling; loudness vs. a known distance |
| Orientation/shape | How the echo changes as you click from different angles |
| Material/texture | High-frequency content of the echo (hard/smooth reflects highs; soft/porous absorbs them) |

---

## 2. Known concrete exercises used by instructors & researchers

### 2.1 The classic "reflective panel present/absent" detection task ⭐
This is *the* foundational exercise and the one to build the game's tutorial around.

**Setup.** The instructor holds a flat, hard reflector — a metal cookie sheet, a foam board,
an acrylic/aluminum plate, or a clipboard — in front of the seated or standing learner. The
learner is blindfolded (if sighted) and makes a consistent tongue click (or the instructor
provides clicks). Foundational lab evidence that even naïve listeners can detect the mere
*presence* of a reflector: *Human Echolocation: Blind and Sighted Persons' Ability to Detect
Sounds Recorded in the Presence of a Reflecting Object*
([ResearchGate](https://www.researchgate.net/publication/44642050)).

**How it's run (progression within the one task):**
1. **Present vs. absent.** Panel is either held ~30–50 cm in front of the face, or removed. On
   each trial the learner clicks and reports "panel" or "no panel." Start close (loud echo).
2. **Randomize & silence-catch.** Randomly interleave absent trials so the learner can't
   pattern-match; add a "no-click / just listen" control to prove echolocation (not ambient
   cues) is doing the work — exactly the control condition used in the Thaler 10-week study.
3. **Distance sub-task.** Panel always present, at one of two distances (e.g., 30 vs. 60 cm) —
   learner reports "near/far." Reduce the ratio as they improve.
4. **Side / localization sub-task.** Panel present, held left vs. right (or at an angle) —
   learner reports the side, then points to it.
5. **Fade reflectivity.** Swap the metal plate for wood, then foam, then cloth-covered board;
   less-reflective material = harder. (Foam vs. aluminum measurably degrades distance accuracy —
   see the distance-estimation study below.)

### 2.2 Size / orientation discrimination (Thaler 10-week protocol)
From [PMC8171922](https://pmc.ncbi.nlm.nih.gov/articles/PMC8171922/):
- **Size discrimination.** Two foam discs on top/bottom bars; a 25.4 cm reference disc vs. a
  smaller comparison (5.1–22.9 cm). Learner clicks and says which bar held the *bigger* disc.
  Start at **33 cm**; after ≥90% correct in two straight sessions, step distance out in **33 cm**
  increments (66, 99...). Experts run at ~100 cm.
- **Orientation perception.** An 80×20 cm foam rectangle rotated to 0/45/90/135°; learner clicks
  (~20 s per trial) and names the orientation.
- **Virtual navigation.** Binaural click/click-echo recordings of T-, U-, Z-mazes; learner
  "walks" via keyboard, with collision timeouts. Later sessions randomize start orientation and
  test mirror-symmetric untrained mazes for transfer. **This is essentially already a web game.**

### 2.3 Distance estimation to objects of differing material
11 blindfolded sighted participants judged distance to **aluminum vs. foam** discs at 30/60/90 cm;
foam (less reflective) yielded worse accuracy and consistency, especially up close. A clean basis
for a "name that distance" mode with a material difficulty axis.
(See the distance/material findings summarized in
[PLOS One 2016](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0156654).)

### 2.4 Detection vs. localization are separable skills
*Comparing Echo-Detection and Echo-Localization in Sighted Individuals*
([PubMed 33673742](https://pubmed.ncbi.nlm.nih.gov/33673742/)) found most people are **better at
detection than localization**, especially at close range (1–1.7 m). Design implication: gate
localization levels behind detection mastery.

### 2.5 Corridor / virtual-wall distance discrimination
Blindfolded sighted + a blind expert discriminated front-wall distance in a virtual corridor
with sub-1 m thresholds across 0.75–4 m references, best (~20 cm) at 0.75 m. Confirms near space
is easiest and validates a procedural corridor level.

### 2.6 Material / texture discrimination (advanced)
*Discrimination of 2D wall textures by passive echolocation...*
([PMC8158938](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8158938/)) shows texture is judged
largely from the **reflected-to-direct level difference** and high-frequency content — the cue to
train last.

---

## 3. Progression ladder (beginner → advanced)

Each rung: **Goal · Setup · Learner action · Difficulty scaling · Acoustic cue trained.**

### Tier A — Sonar exists (presence/absence)

**L1 — Click calibration**
- *Goal:* produce a consistent probe. *Setup:* quiet room, no target. *Action:* practice a
  crisp tongue click, listen to your own click's timbre. *Scaling:* aim for repeatable
  loudness/spectrum. *Cue:* the outgoing reference signal itself.

**L2 — Big wall, present/absent**
- *Goal:* notice an echo at all. *Setup:* large flat reflector ~30 cm ahead vs. removed.
  *Action:* click, report "something / nothing." *Scaling:* start with the biggest, closest,
  hardest reflector; randomize present/absent. *Cue:* added loudness/coloration (delayed copy).

**L3 — Occlusion / sound-shadow with an external source**
- *Goal:* passive echo/shadow sensitivity. *Setup:* steady sound source + a board that blocks or
  reflects. *Action:* say when the board is present. *Scaling:* smaller board, off-axis. *Cue:*
  head-shadow + reflected coloration.

### Tier B — Where is it (localization)

**L4 — Left vs. right panel (2AFC)**
- *Goal:* lateralize an echo. *Setup:* panel present on left or right. *Action:* report side,
  then point. *Scaling:* move panel toward center; shrink angular separation. *Cue:* ILD/ITD.

**L5 — Which of N positions**
- *Goal:* finer azimuth. *Setup:* panel at one of 3–5 fanned positions. *Action:* name/point.
  *Scaling:* more positions, smaller spacing, off-axis bias (exploit off-axis advantage). *Cue:*
  ILD/ITD + head-turn spectral change.

**L6 — Up/down & front/back with head tilt**
- *Goal:* elevation & front/back. *Setup:* panel high vs. low (or front vs. behind). *Action:*
  tilt/turn head, click, report. *Scaling:* reduce allowed head movement. *Cue:* HRTF spectral
  notches.

### Tier C — What is it (discrimination)

**L7 — Near vs. far (2AFC distance)**
- *Goal:* coarse ranging. *Setup:* panel at 30 vs. 60 cm. *Action:* report near/far. *Scaling:*
  shrink the ratio toward expert thresholds (~3 cm @ 50 cm). *Cue:* echo delay + level.

**L8 — Name that distance (absolute)**
- *Goal:* absolute range estimate. *Setup:* panel at a random distance. *Action:* estimate cm.
  *Scaling:* larger range, less-reflective material. *Cue:* delay + direct-to-reflected ratio.

**L9 — Bigger vs. smaller (size 2AFC)**
- *Goal:* size discrimination. *Setup:* two discs, one bigger (Thaler protocol). *Action:* say
  which is bigger. *Scaling:* closer sizes; step distance out in 33 cm increments after ≥90%×2.
  *Cue:* angular extent → echo strength/spectral filling.

**L10 — Orientation of a panel**
- *Goal:* read a flat object's tilt. *Setup:* rectangle at 0/45/90/135°. *Action:* click from a
  fixed spot, name orientation. *Scaling:* more angles, greater distance. *Cue:* angle-dependent
  echo change.

**L11 — Aperture / gap finding**
- *Goal:* detect an opening. *Setup:* wall with a doorway-width gap somewhere. *Action:* scan,
  find the "quiet" direction (the gap). *Scaling:* narrower gap, farther wall, noise. *Cue:*
  *absence* of reflection in the gap direction.

**L12 — Material / texture (metal vs. foam vs. cloth)**
- *Goal:* judge surface. *Setup:* same-size/distance panel, different material. *Action:* name
  hard vs. soft. *Scaling:* more similar materials; add roughness/texture. *Cue:* high-frequency
  reflected content; reflected-to-direct level difference.

### Tier D — Use it (integration)

**L13 — Corridor distance-to-front-wall**
- *Goal:* ranging in a room. *Setup:* virtual corridor, front wall at variable distance.
  *Action:* judge/step to distance. *Scaling:* 0.75→4 m references; sub-1 m thresholds. *Cue:*
  front-wall echo delay/level vs. lateral walls.

**L14 — Virtual maze navigation**
- *Goal:* navigate by sonar. *Setup:* T/U/Z maze via binaural click-echo. *Action:* move,
  avoid collisions, find exit. *Scaling:* randomize start orientation, collision timeouts,
  untrained mirror mazes for transfer. *Cue:* everything above, integrated.

**L15 — Noisy / cluttered real-ish scene**
- *Goal:* robustness. *Setup:* multiple reflectors + background noise. *Action:* find/label a
  target among distractors. *Scaling:* more clutter, louder noise, fewer allowed clicks. *Cue:*
  segregating target echo from clutter and noise.

---

## 4. What makes a good practice probe sound

The probe is the *sonar ping*. A good one is **short, broadband, and repeatable**. The palatal
**tongue click** (tongue tip pulled sharply from behind the teeth/palate) is the community and
research standard.

**Acoustic properties of expert mouth clicks** (Thaler/Reich/Antoniou et al.,
*Mouth-clicks used by blind expert human echolocators*,
[PLOS Comp. Biol. 2017](https://phys.org/news/2017-08-mouth-clicks-human-echolocation-captured.html)
/ [ScienceDaily](https://www.sciencedaily.com/releases/2017/08/170831141320.htm)):
- **Very short** — around **3 ms**.
- **Peak energy ~2–4 kHz**, with additional strength near **10 kHz**.
- **More directional than speech** — energy is beamed forward, improving the outgoing signal.

**Why the click beats claps/hisses/finger-snaps:**
| Property | Why it matters | Tongue click | Clap | Hiss/"sh" | Snap |
|---|---|---|---|---|---|
| Short duration | Direct sound clears fast so the echo isn't masked | ✅ ~3 ms | ✗ longer, ringy | ✗ sustained (echo overlaps) | ~ok |
| Broadband | Reflected spectrum reveals size/material | ✅ | ~ | ✅ but sustained | ~ |
| Repeatable | Constant probe → change = environment, not you | ✅ (near-identical each time) | ✗ variable | ✗ | ✗ |
| Directional/forward | Aims energy at the target, quiet at the ears | ✅ | ✗ | ✗ | ✗ |
| Hands-free & fast | Rapid re-probing while moving | ✅ | ✗ | ~ | ✗ |
| Low self-masking | Doesn't fill the gap where the echo arrives | ✅ | ✗ | ✗ (worst) | ~ |

A sustained hiss is the clearest counter-example: because it *continues* while the echo returns,
the reflection overlaps and is masked, and there is no crisp onset to time delay from. The click's
impulsive onset is exactly what makes echo **delay** (distance) legible.

**In the game:** synthesize (or sample) a ~3 ms broadband impulse with peak ~2–4 kHz and a 10 kHz
shoulder, radiated with a mild forward directivity. Keep it *identical* every trial so the only
variable is the room. Optionally let the player record their **own** click as the probe (already
noted as a project capability) — good for realism, but offer the canonical synthetic click for
consistent scoring.

---

## 5. Mapping to a binaural web-audio game

**Common engine substrate (all levels).** A procedural room in Web Audio with:
- A **fixed listener** using an HRTF/binaural renderer (`PannerNode` type `HRTF`, or a convolver
  with an HRIR set) so ILD/ITD/spectral cues are real.
- A **movable virtual reflector panel** described by position, size, orientation, and a
  material (absorption + high-frequency rolloff). Render its echo as a delayed, filtered,
  binaurally-panned copy of the probe (image-source method — already in this project's acoustics
  stack), with delay = 2·distance/c and level ∝ size / distance².
- The **canonical click** convolved with the room impulse response; direct + reflections summed.
- **Head control** (mouse/gyro/keys) so head-turn cues and the off-axis advantage are trainable.

**Trial & scoring machinery reused everywhere:**
- **2AFC forced-choice** trials (present/absent, left/right, near/far, bigger/smaller).
- **Adaptive staircase** (e.g., 2-down-1-up ≈ 71% threshold, or 3-down-1-up) driving the
  difficulty parameter — distance ratio, angular separation, size difference, material contrast.
- **Silence/no-click catch trials** to prove echolocation, not artifacts, are being used
  (mirrors the Thaler control).
- **Randomized present/absent + position** to defeat pattern-matching.
- Log **threshold vs. session** to visualize learning (the whole point of the training).

| Level | Web-audio realization |
|---|---|
| L1 Click calibration | Play canonical click; optional record-your-own; show waveform/spectrum. No room. |
| L2 Present/absent | Panel at 30 cm or removed; 2AFC "something/nothing"; staircase on panel size then distance. |
| L3 Sound-shadow | Steady virtual source + occluder; 2AFC present/absent; staircase on occluder size. |
| L4 Left/right | Panel mirrored L/R; 2AFC side; staircase on azimuth toward center. |
| L5 Which position | Panel at 1 of N azimuths; N-AFC; staircase adds positions / narrows spacing; allow off-axis. |
| L6 Up/down, front/back | Elevation/front-back placement; head-tilt enabled; staircase reduces allowed head motion. |
| L7 Near/far 2AFC | Panel at d₁ vs d₂; staircase shrinks Δd toward ~3 cm@50 cm. |
| L8 Name-that-distance | Absolute estimate slider; score = |error|; scale range + material. (Project already has a distance mode.) |
| L9 Size 2AFC | Two discs, one larger; 2AFC; distance steps out +33 cm after ≥90%×2 (Thaler rule). |
| L10 Orientation | Rectangle at 0/45/90/135°; 4-AFC; staircase adds angles / distance. |
| L11 Gap finding | Wall with a gap; scan head to find the null; staircase narrows gap + adds noise. (Ties to project's "Find the Opening".) |
| L12 Material | Same geometry, vary absorption/HF-rolloff; 2AFC hard/soft; staircase reduces material contrast. |
| L13 Corridor ranging | Procedural corridor, variable front-wall distance; estimate or step; staircase on Δdistance (validated 0.75–4 m). |
| L14 Maze nav | T/U/Z procedural mazes; move-by-click with collision timeouts; randomize start + mirror mazes for transfer. |
| L15 Cluttered scene | Multiple reflectors + background noise bed; find/label target; staircase on clutter/noise/click budget. |

**Difficulty knobs (unified).** distance · panel size/angular extent · azimuth/elevation ·
material absorption & HF rolloff · number of distractors · background noise level ·
allowed clicks per trial · allowed head movement. A single staircase per level picks one primary
knob; secondary knobs advance between levels.

**Onboarding tie-in.** Make **L2 (reflective-panel present/absent, close and loud)** the tutorial —
it is the field-tested "aha, sonar is real" moment and the cleanest possible 2AFC trial.

---

## 6. Sources

- Kish / World Access for the Blind / Visioneers — https://visioneers.org/ ; TED talk
  https://www.ted.com/talks/daniel_kish_how_i_use_sonar_to_navigate_the_world
- NFB, *FlashSonar: Understanding and Applying Sonar Imaging to Mobility* —
  https://nfb.org/flashsonar-understanding-and-applying-sonar-imaging-mobility
- EchoProVIP *Training Curriculum: Active echolocation for people with visual impairment* —
  https://firr.org.pl/wp-content/uploads/2020/03/O1_Curriculum_EchoProVIP_eng.pdf
- Thaler et al., *Human click-based echolocation... 10-week training program*, PLOS One 2021 —
  https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0252330 /
  https://pmc.ncbi.nlm.nih.gov/articles/PMC8171922/
- *Depth Echolocation Learnt by Novice Sighted People*, PLOS One 2016 —
  https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0156654
- *Human Click-Based Echolocation of Distance: Superfine Acuity...*, JARO 2019 —
  https://link.springer.com/article/10.1007/s10162-019-00728-0 /
  https://www.ncbi.nlm.nih.gov/pmc/articles/PMC6797687/
- Reich/Thaler/Antoniou et al., *Mouth-clicks used by blind expert human echolocators*,
  PLOS Comp. Biol. 2017 — https://www.sciencedaily.com/releases/2017/08/170831141320.htm
- *Human Echolocators Have Better Localization Off Axis*, Psychological Science 2022 —
  https://journals.sagepub.com/doi/full/10.1177/09567976211068070
- *Ranging in Human Sonar: ...Exploratory Head Movements*, PLOS One 2015 —
  https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0115363 /
  https://www.ncbi.nlm.nih.gov/pmc/articles/PMC4281102/
- *Human Echolocation: Blind and Sighted Persons' Ability to Detect... a Reflecting Object* —
  https://www.researchgate.net/publication/44642050
- *Comparing Echo-Detection and Echo-Localization in Sighted Individuals* —
  https://pubmed.ncbi.nlm.nih.gov/33673742/
- *Discrimination of 2D wall textures by passive echolocation...* —
  https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8158938/
