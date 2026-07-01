# Types of tongue / mouth clicks for echolocation

A human-readable reference for the in-app "Types of clicks" help page and the per-click "?"
info buttons. The structured/typed version of this content lives in
[`src/content/clickTypes.ts`](../src/content/clickTypes.ts). Recorded examples and their
licenses are catalogued in [`docs/click-probe-sounds.md`](./click-probe-sounds.md) and
[`public/audio/clicks/manifest.json`](../public/audio/clicks/manifest.json).

## The shared mechanism: velaric (mouth-suction) airstream

Every true click is a **click consonant** produced on a **velaric (lingual) ingressive
airstream** — the air comes from the mouth, not the lungs. The recipe is always the same:

1. The **back of the tongue seals against the soft palate (velum)**.
2. A **second, forward closure** is made — with the tongue tip at the teeth/palate, the side
   of the tongue, or the lips.
3. The tongue is **pulled down/back**, rarefying (lowering the pressure of) the small pocket
   of air trapped between the two closures.
4. The **forward closure is released**, and outside air rushes in with a sharp "pop".

Because the release is a rapid pressure equalisation, the sound is a near-impulse: a very short,
broadband transient. That is exactly why clicks make good echolocation probes — a single click
excites the whole room response at once (see "Why clicks work as probes" in
[`docs/click-probe-sounds.md`](./click-probe-sounds.md)). One click below (the percussive /
sublingual click) is **not** a suction click — it is a percussive tongue-slap — but it is
included because it produces a comparably crisp, usable ping.

References: <https://en.wikipedia.org/wiki/Click_consonant>,
<https://en.wikipedia.org/wiki/Palatal_click>.

---

## Kish palatal click (flash-sonar standard)

- **IPA:** — (not a standard IPA letter)
- **Recording:** none dedicated; the palatoalveolar clip is the closest recorded match.
- **How to make it:** Place the tip and front of the tongue lightly against the roof of the
  mouth just behind the top teeth (the alveolar ridge / front palate), with the back of the
  tongue sealed against the soft palate. Snap the tongue tip sharply **downward** and back to
  break the front seal, so air is drawn in with a crisp, forward-aimed "tock". Keep the jaw
  relaxed and the mouth slightly open — the motion is a quick flick, not a suck. This is the
  canonical click Daniel Kish teaches for flash sonar because it is repeatable and beams energy
  forward.
- **Articulation:** place — palatal / anterior-palatal (just behind the teeth);
  mechanism — lingual (velaric) ingressive, sharp downward tongue-tip release.
- **Acoustics:** Very short (~3 ms), broadband transient with peak energy around 2–4 kHz and a
  shoulder near 10 kHz; bright, sharp, and more directional than speech. The near-ideal acoustic
  impulse the training probe is modelled on.
- **Good probe?** **Yes.** The community and research standard: short, spectrally rich,
  forward-directional, and highly repeatable, so any change you hear is the room, not your click.
- **Diagram hint:** Mid-sagittal cross-section of the mouth. Tongue tip and blade contacting the
  roof just behind the upper teeth (alveolar ridge / front hard palate); back of tongue raised to
  seal against the soft palate. Downward arrow at the tongue tip for the sharp release.

## Palatal click — ⟨ǂ⟩

- **IPA:** ǂ
- **Recording:** `palatoalveolar` (CC BY-SA 3.0).
- **How to make it:** Lay the tongue nearly flat with broad contact across the roof of the mouth,
  and pull it **back** (rather than sharply down) to break the seal. The primary contact is
  farther back than the "tsk" click — across the hard palate — giving an extremely broad
  tongue-to-palate contact. Release the front of that contact to let air rush in.
- **Articulation:** place — palatal (broad contact across the hard palate);
  mechanism — lingual (velaric) ingressive, broad palatal suction release.
- **Acoustics:** Sharp and high-frequency-rich; a clean, bright transient. Broad, forward contact
  makes it one of the crisper clicks and a close tonal match to the flash-sonar palatal click.
- **Good probe?** **Yes.** The closest recorded stand-in for the Kish palatal click. (In IPA
  sources ⟨ǂ⟩ is labelled the palato-alveolar / palatal click.)
- **Diagram hint:** Mid-sagittal cross-section. Tongue nearly flat with a broad contact band
  spanning the hard palate; arrow showing the tongue pulled backward to release. Note the wide
  contact area versus the pinpoint tip contact of the dental click.

## Dental click ("tsk") — ⟨ǀ⟩

- **IPA:** ǀ
- **Recording:** `dental` (CC BY-SA 3.0).
- **How to make it:** Press the tip of the tongue against the back of the upper front teeth (and
  the ridge just behind them), with the back of the tongue sealed against the soft palate. Pull
  the tongue tip sharply down and back to break the seal, producing the familiar disapproving
  "tsk-tsk". It is a thin, pinpoint contact at the teeth rather than a broad palatal one.
- **Articulation:** place — dental / post-alveolar (behind the upper teeth);
  mechanism — lingual (velaric) ingressive, tongue-tip suction release at the teeth.
- **Acoustics:** Very sharp, bright, and impulse-like — a thin, high-frequency "tick". Its crisp
  onset makes echo delay (distance) easy to time.
- **Good probe?** **Yes.** Familiar, easy to produce consistently, very sharp and bright — a
  strong alternative to the palatal click for many learners.
- **Diagram hint:** Mid-sagittal cross-section. Tongue tip against the back of the upper incisors
  / alveolar ridge (pinpoint contact at the teeth); back of tongue sealed to the velum; small
  downward arrow at the tip for release.

## Alveolar lateral click — ⟨ǁ⟩

- **IPA:** ǁ
- **Recording:** `alveolar-lateral` (CC BY-SA 3.0).
- **How to make it:** Set the tongue tip against the alveolar ridge (just behind the upper teeth)
  as if to say "l", keeping the back sealed to the soft palate. Instead of releasing at the tip,
  draw one **side** of the tongue away from the upper cheek teeth so air rushes in over the side
  of the tongue — the same lateral action used to "giddy-up" a horse. The release is at the side,
  not the front.
- **Articulation:** place — alveolar, lateral release (side of the tongue);
  mechanism — lingual (velaric) ingressive, lateral suction release.
- **Acoustics:** Slightly broader and "wetter" than the dental/palatal clicks — still a good sharp
  transient but with a touch more low-mid body from the side release.
- **Good probe?** **Yes.** A usable probe and a good variety/alternate: broadband and reasonably
  sharp, though marginally less crisp than the dental or palatal clicks.
- **Diagram hint:** Mid-sagittal (or oblique) cross-section. Tongue tip on the alveolar ridge with
  the back sealed to the velum; indicate that the release is at the **side** of the tongue (a
  lateral airflow arrow past the molars), unlike the central release of the other clicks.

## Bilabial click — ⟨ʘ⟩

- **IPA:** ʘ
- **Recording:** `bilabial` (CC BY-SA 3.0).
- **How to make it:** Seal the back of the tongue against the soft palate, then close the **lips**
  together to make the forward seal. Draw the tongue body back/down to rarefy the pocket of air
  behind the lips, then part the lips to let air pop in — like a soft, exaggerated kissing or
  "smack" sound. The forward closure here is the lips, not the tongue tip.
- **Articulation:** place — bilabial (lips);
  mechanism — lingual (velaric) ingressive, lip release (tongue-driven suction).
- **Acoustics:** Lower-pitched and duller than the tongue-tip clicks; the lip release gives the
  least broadband, softest transient of the set — more a low "pock" than a bright "tick".
- **Good probe?** **No.** Too low-frequency and not broadband enough, and it can't be aimed
  forward like a tongue click. Better reserved as a distinct "beacon" / flavour sound.
- **Diagram hint:** Mid-sagittal cross-section. Back of tongue sealed to the soft palate; the two
  **lips** closed to form the forward seal; arrow at the lips for the release. Emphasise that the
  forward closure is at the lips, not on the palate.

## Percussive / sublingual click

- **IPA:** — (percussive, not a suction click)
- **Recording:** `percussive-alveolar` (CC0 1.0 — public domain, no attribution required).
- **How to make it:** Rather than a suction release, this click is **percussive**: the underside
  of the tongue (or the tongue slapping down) strikes the floor of the mouth / lower teeth to make
  a sharp knock. Cup the tongue and snap it downward so its lower surface percussively hits the
  mouth floor, producing a dry click **without** the velaric suction of the true clicks. It is the
  sort of crisp knock heard in some Sandawe speech and in beatboxing.
- **Articulation:** place — sublingual / alveolar (tongue underside striking the mouth floor);
  mechanism — percussive tongue-slap (not a velaric suction release).
- **Acoustics:** A crisp, dry, percussive transient — short and clean with low background noise;
  broadband enough to work well as a ping despite not being a true suction click.
- **Good probe?** **Yes.** The recorded percussive-alveolar clip is CC0 (no attribution needed),
  crisp and dry, and trims cleanly to a transient — the lowest-friction recorded option for the
  trainer.
- **Diagram hint:** Mid-sagittal cross-section. Show the tongue cupped and its **underside** / body
  striking downward against the floor of the mouth or lower teeth (a percussive slap), with a
  downward impact arrow. Contrast: no velar seal / suction is required, unlike the true clicks.

---

## Which to use for echolocation

For echolocation practice, prefer the **sharp, broadband** clicks. The **palatal** and **dental**
("tsk") clicks are the standard — short (~3 ms), spectrally rich, and directional, so they behave
like an acoustic impulse and reveal room reflections cleanly. The **percussive/sublingual** click
is a good, low-friction recorded alternative. The **alveolar lateral** click is a fine variety
probe. The **bilabial** click is the odd one out — dull and low-frequency — and is better kept as
a distinct "beacon" sound than used as a ranging probe.

---

## Articulation diagrams

Sourcing status for freely-licensed **mid-sagittal mouth cross-sections** (tongue-in-mouth
diagrams) to illustrate each click. Same attribution diligence as
[`docs/click-probe-sounds.md`](./click-probe-sounds.md). **Nothing here has been downloaded** —
this is a sourced list for approval.

**Finding: no ready-made mid-sagittal *click* diagrams exist on Wikimedia Commons.** The images
that appear in the IPA click articles (e.g. `IPA_Unicode_0x01C2.svg`, `..._0x01C0.svg`,
`..._0x01C1.svg`, `..._0x0298.svg`) are **glyph renderings of the IPA symbol** (a font glyph on a
16×16-px canvas), *not* anatomical cross-sections — so they do **not** satisfy the "tongue position
in the mouth" requirement. The Commons `Category:Click consonants` contains only IPA charts, maps,
and audio, with no sagittal articulation drawings.

Generic / building-block diagrams that *are* freely licensed and could be adapted:

| Item | Commons page | Author | License | Direct URL |
|---|---|---|---|---|
| Places of articulation (overview chart, labels the palatal/alveolar/dental/labial regions) | <https://commons.wikimedia.org/wiki/File:Places_of_articulation.svg> | Ishwar (original), see file page | Public domain (per file page) — **verify at use** | <https://upload.wikimedia.org/wikipedia/commons/e/e2/Places_of_articulation.svg> |
| IPA symbol glyph ⟨ǂ⟩ (NOT a sagittal diagram — for reference only) | <https://commons.wikimedia.org/wiki/File:IPA_Unicode_0x01C2.svg> | Kwamikagami | CC BY-SA 4.0 | <https://upload.wikimedia.org/wikipedia/commons/b/b6/IPA_Unicode_0x01C2.svg> |

**Recommendation:** No clearly-free, click-specific mid-sagittal diagram exists, so **simple
original SVGs should be drawn** for each click using the per-click *diagram hint* above (they are
easy line drawings: an outline head/mouth with the two closures and a release arrow). The
`Places_of_articulation.svg` chart is a useful free reference/base for label positions, but confirm
its exact license on the file page before reusing it, and treat the IPA-glyph SVGs as symbols, not
diagrams.

_Sources checked June 2026: Wikipedia click-consonant articles, Wikimedia Commons file pages and
`Category:Click consonants`. Re-verify every license on the file page at use time._
