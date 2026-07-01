/**
 * clickTypes.ts — structured reference data for the types of tongue/mouth clicks
 * used in human echolocation ("flash sonar").
 *
 * Content data only (no UI). Consumed by the in-app "Types of clicks" help page
 * and by per-click "?" info buttons. UI wiring lives elsewhere.
 *
 * Articulatory descriptions are grounded in real phonetics: all of these are
 * CLICK CONSONANTS, produced on a VELARIC (lingual) INGRESSIVE airstream — the
 * air is not from the lungs. The back of the tongue seals against the soft
 * palate (velum), a second forward closure is made, the enclosed pocket of air
 * is rarefied by lowering/pulling the tongue, and the forward closure is
 * released so outside air rushes in with a sharp "pop". See:
 *   https://en.wikipedia.org/wiki/Click_consonant
 *   https://en.wikipedia.org/wiki/Palatal_click
 *
 * `assetId` cross-references the recorded click ids in
 * public/audio/clicks/manifest.json (see docs/click-probe-sounds.md).
 */

export interface ClickType {
  /** kebab-case stable identifier */
  id: string;
  /** human-readable label, e.g. "Palatal click" */
  name: string;
  /** IPA symbol/string, if applicable ("" when not a standard IPA letter) */
  ipa: string;
  /**
   * Precise articulatory how-to (2-4 sentences): exact tongue/lip placement and
   * the release action that produces the click, written for a learner to follow.
   */
  howToMake: string;
  /** short structured articulation description */
  articulation: {
    /** place of articulation, e.g. "palatal", "dental", "bilabial" */
    place: string;
    /** airstream/release mechanism producing the click */
    mechanism: string;
  };
  /**
   * 1-2 sentences on sound character: brightness, broadband-ness, sharpness,
   * suitability as an echolocation probe.
   */
  acoustics: string;
  /** is it a good echolocation probe? */
  goodProbe: boolean;
  /** why / why not it makes a good probe */
  probeNote: string;
  /** matching recording id in public/audio/clicks/manifest.json, if any */
  assetId?: string;
  /**
   * Hint for sourcing/drawing an articulation diagram later (NOT an image path):
   * describes what a mid-sagittal mouth cross-section should show and, crucially,
   * WHERE the constriction/contact is.
   */
  imageHint: string;
}

export const CLICK_TYPES: ClickType[] = [
  {
    id: "kish-palatal",
    name: "Kish palatal click (flash-sonar standard)",
    ipa: "",
    howToMake:
      "Place the tip and front of the tongue lightly against the roof of the mouth just behind the top teeth (the alveolar ridge / front palate), with the back of the tongue sealed against the soft palate. Snap the tongue tip sharply DOWNWARD and back to break the front seal, so air is drawn in with a crisp, forward-aimed 'tock'. Keep the jaw relaxed and the mouth slightly open; the motion is a quick flick, not a suck. This is the canonical click Daniel Kish teaches for flash sonar because it is repeatable and beams energy forward.",
    articulation: {
      place: "palatal / anterior-palatal (just behind the teeth)",
      mechanism: "lingual (velaric) ingressive — sharp downward tongue-tip release",
    },
    acoustics:
      "Very short (~3 ms), broadband transient with peak energy around 2–4 kHz and a shoulder near 10 kHz; bright, sharp, and more directional than speech, beaming forward toward a target. This is the near-ideal acoustic impulse the training probe is modelled on.",
    goodProbe: true,
    probeNote:
      "The community and research standard for echolocation: short, spectrally rich, forward-directional, and highly repeatable, so any change in what you hear is due to the room, not your click.",
    // No dedicated recording; acoustically closest recorded match is the palatoalveolar clip.
    imageHint:
      "Mid-sagittal cross-section of the mouth. Tongue tip and blade contacting the roof just behind the upper teeth (alveolar ridge / front hard palate); back of tongue raised to seal against the soft palate (velum). Show a downward arrow at the tongue tip indicating the sharp downward release.",
  },
  {
    id: "palatal",
    name: "Palatal click",
    ipa: "ǂ",
    howToMake:
      "Lay the tongue nearly flat with broad contact across the roof of the mouth, and pull it BACK (rather than sharply down) to break the seal. The primary contact is farther back than the 'tsk' click — across the hard palate — giving an extremely broad tongue-to-palate contact. Release the front of that contact to let air rush in.",
    articulation: {
      place: "palatal (broad contact across the hard palate)",
      mechanism: "lingual (velaric) ingressive — broad palatal suction release",
    },
    acoustics:
      "Sharp and high-frequency-rich; a clean, bright transient. Because contact is broad and forward, it is one of the crisper clicks and a close tonal match to the flash-sonar palatal click.",
    goodProbe: true,
    probeNote:
      "Sharp and broadband; the closest recorded stand-in for the Kish palatal click and a good probe. (In IPA sources this ⟨ǂ⟩ symbol is labelled the palato-alveolar/palatal click.)",
    assetId: "palatoalveolar",
    imageHint:
      "Mid-sagittal cross-section. Tongue nearly flat with a broad contact band spanning the hard palate; arrow showing the tongue being pulled backward to release. Note the wide contact area versus the pinpoint tip contact of the dental click.",
  },
  {
    id: "dental",
    name: "Dental click (\"tsk\")",
    ipa: "ǀ",
    howToMake:
      "Press the tip of the tongue against the back of the upper front teeth (and the ridge just behind them), with the back of the tongue sealed against the soft palate. Pull the tongue tip sharply down and back to break the seal, producing the familiar disapproving 'tsk-tsk' sound. It is a thin, pinpoint contact at the teeth rather than a broad palatal one.",
    articulation: {
      place: "dental / post-alveolar (behind the upper teeth)",
      mechanism: "lingual (velaric) ingressive — tongue-tip suction release at the teeth",
    },
    acoustics:
      "Very sharp, bright, and impulse-like — a thin, high-frequency 'tick'. Its crisp onset makes echo delay (distance) easy to time.",
    goodProbe: true,
    probeNote:
      "Excellent probe: familiar, easy to produce consistently, very sharp and bright. A strong alternative to the palatal click for many learners.",
    assetId: "dental",
    imageHint:
      "Mid-sagittal cross-section. Tongue tip pressed against the back of the upper incisors / alveolar ridge (pinpoint contact at the teeth); back of tongue sealed to the velum; small downward arrow at the tip for release.",
  },
  {
    id: "alveolar-lateral",
    name: "Alveolar lateral click",
    ipa: "ǁ",
    howToMake:
      "Set the tongue tip against the alveolar ridge (just behind the upper teeth) as if to say 'l', keeping the back sealed to the soft palate. Instead of releasing at the tip, draw one SIDE of the tongue away from the upper cheek teeth so air rushes in over the side of the tongue — the same lateral action English speakers use to 'giddy-up' a horse. The release is at the side, not the front.",
    articulation: {
      place: "alveolar, lateral release (side of the tongue)",
      mechanism: "lingual (velaric) ingressive — lateral suction release",
    },
    acoustics:
      "Slightly broader and 'wetter' than the dental/palatal clicks — still a good sharp transient but with a touch more low-mid body from the side release. Good for variety as an alternate probe.",
    goodProbe: true,
    probeNote:
      "A usable probe and a good variety/alternate: broadband and reasonably sharp, though marginally less crisp than the dental or palatal clicks.",
    assetId: "alveolar-lateral",
    imageHint:
      "Mid-sagittal (or oblique) cross-section. Tongue tip on the alveolar ridge with the back sealed to the velum; indicate that the release is at the SIDE of the tongue (a lateral airflow arrow past the molars), unlike the central release of the other clicks.",
  },
  {
    id: "bilabial",
    name: "Bilabial click",
    ipa: "ʘ",
    howToMake:
      "Seal the back of the tongue against the soft palate, then close the LIPS together to make the forward seal. Draw the tongue body back/down to rarefy the pocket of air behind the lips, then part the lips to let air pop in — like a soft, exaggerated kissing or 'smack' sound. The forward closure here is the lips, not the tongue tip.",
    articulation: {
      place: "bilabial (lips)",
      mechanism: "lingual (velaric) ingressive — lip release (tongue-driven suction)",
    },
    acoustics:
      "Lower-pitched and duller than the tongue-tip clicks; the lip release produces the least broadband, softest transient of the set. More of a low 'pock' than a bright 'tick'.",
    goodProbe: false,
    probeNote:
      "Poor echolocation probe: too low-frequency and not broadband enough, and it can't be aimed forward like a tongue click. Better reserved as a distinct 'beacon'/flavour sound than as a ranging probe.",
    assetId: "bilabial",
    imageHint:
      "Mid-sagittal cross-section. Back of tongue sealed to the soft palate; the two LIPS closed to form the forward seal; arrow at the lips indicating the release. Emphasise that the forward closure is at the lips, not on the palate.",
  },
  {
    id: "percussive-sublingual",
    name: "Percussive / sublingual click",
    ipa: "",
    howToMake:
      "Rather than a suction release, this click is PERCUSSIVE: the underside of the tongue (or the tongue slapping down) strikes the floor of the mouth / lower teeth to make a sharp knock. Cup the tongue and snap it downward so its lower surface percussively hits the mouth floor, producing a dry click without the velaric suction of the true clicks. It is the sort of crisp knock heard in some Sandawe speech and in beatboxing.",
    articulation: {
      place: "sublingual / alveolar (tongue underside striking the mouth floor)",
      mechanism: "percussive (tongue-slap) — not a velaric suction release",
    },
    acoustics:
      "A crisp, dry, percussive transient — short and clean with low background noise. Broadband enough to work well as a ping despite not being a true suction click.",
    goodProbe: true,
    probeNote:
      "Good practical probe: the recorded percussive-alveolar clip is CC0 (no attribution needed), crisp and dry, and trims cleanly to a transient — the lowest-friction recorded option for the trainer.",
    assetId: "percussive-alveolar",
    imageHint:
      "Mid-sagittal cross-section. Show the tongue cupped and its UNDERSIDE / body striking downward against the floor of the mouth or lower teeth (a percussive slap), with a downward impact arrow. Contrast: no velar seal / suction is required, unlike the true clicks.",
  },
];
