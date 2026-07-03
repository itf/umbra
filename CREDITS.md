# Credits & Attributions

This file lists **third-party assets** bundled with this project and their license
obligations: tongue-click probe recordings (Wikimedia Commons) and HRTF/headphone
datasets used for binaural audio.

- [Tongue-click recordings](#tongue-click-recordings)
- [HRTF & headphone datasets](#hrtf--headphone-datasets)

---

## Tongue-click recordings

The tongue-click recordings under `public/audio/clicks/` are candidate "probe" sounds
for the echolocation trainer (a sharp mouth click is a near-impulse broadband transient,
which makes it an excellent acoustic probe). See `docs/click-probe-sounds.md` for the
full sourcing research.

```
"Dental click" [ǀ] — Peter Isotalo — CC BY-SA 3.0 —
  https://commons.wikimedia.org/wiki/File:Dental_click.ogg
"Alveolar lateral click" [ǁ] — Peter Isotalo — CC BY-SA 3.0 —
  https://commons.wikimedia.org/wiki/File:Alveolar_lateral_click.ogg
"Palatoalveolar click" [ǂ] — Peter Isotalo — CC BY-SA 3.0 —
  https://commons.wikimedia.org/wiki/File:Palatoalveolar_click.ogg
"Bilabial click" [ʘ] — Peter Isotalo — CC BY-SA 3.0 —
  https://commons.wikimedia.org/wiki/File:Bilabial_click.ogg
"Percussive alveolar click" — Eshaan011 — CC0 1.0 (public domain, no attribution required) —
  https://commons.wikimedia.org/wiki/File:Percussive_alveolar_click.ogg

CC BY-SA 3.0: https://creativecommons.org/licenses/by-sa/3.0/
CC0 1.0:      https://creativecommons.org/publicdomain/zero/1.0/
```

**License notes:**

- **CC BY-SA 3.0 files** (Dental, Alveolar lateral, Palatoalveolar, Bilabial clicks,
  all recorded by Peter Isotalo). Attribution is required. These files are also
  dual-licensed under GFDL 1.2+; we rely on the CC BY-SA 3.0 option. The share-alike
  clause attaches to the specific *adapted audio asset*, not to the game code that plays
  it — audio and software are separate works. **Any trimmed, normalized, resampled, or
  otherwise processed derivative of these files is itself released under CC BY-SA 3.0**
  and must retain the attribution above.
- **CC0 1.0 file** ("Percussive alveolar click" by Eshaan011). This is a public-domain
  dedication and requires **no attribution** and imposes **no share-alike** obligation.
  It is credited here anyway as a courtesy.

**Processing status:** at the time these assets were added, `ffmpeg`/`ffprobe` were
**not available** in the build environment, so the probe-ready processing (trim to the
click transient, downmix to mono, resample to 48000 Hz, peak-normalize to about -1 dBFS,
export as `.ogg` + `.wav`) was **not** performed. The **original, unmodified** files are
stored under `public/audio/clicks/original/`. Each is Ogg Vorbis, mono, 44100 Hz.
Processing must be completed later; see `public/audio/clicks/manifest.json` for the
per-file status. Licenses were re-verified against each file's Wikimedia Commons page
at download time (June 2026) and matched the metadata recorded above.

---

## HRTF & headphone datasets

These binaural head-related transfer function (HRTF) datasets are baked (via
`scripts/bake-hrtf*.mjs`) into the compact runtime binaries under `assets/hrtf/*.hrtf`
and used to render 3D positional audio and as selectable/tunable "base heads" for
personalization. Raw source SOFA files are not committed (`assets/hrtf/*.sofa` is
gitignored) — only the baked derivatives.

### SADIE II — default head

```
SADIE II HRTF database — University of York.
https://www.york.ac.uk/sadie-project/database.html
```

Used as the default binaural rendering head (`assets/hrtf/sadie_h3.hrtf`,
`sadie_h13.hrtf`). See the SADIE II site for license terms.

### CIPIC — alternate heads (via Steam Audio)

```
CIPIC HRTF Database — University of California, Davis (CIPIC Interface Laboratory).
Subject 124 SOFA file is bundled with Valve's Steam Audio (Apache 2.0) at
core/data/hrtf/cipic_124.sofa; the full 45-subject set is available at
https://github.com/amini-allight/cipic-hrtf-database
```

Used as alternate selectable base heads (`assets/hrtf/cipic_124.hrtf`, plus
`cipic_021.hrtf`, `cipic_051.hrtf`, `cipic_060.hrtf`, `cipic_061.hrtf` — subjects chosen
for spectral diversity from the mean ear). CIPIC data is available for research and
commercial use with attribution.

### Sound Sphere 2 (SS2) — alternate heads

```
Warnecke, M., Clapp, S., Ben-Hur, Z., Alon, D. L., Amengual Garí, S. V., & Calamia, P.
(2024). "Sound Sphere 2: A High-resolution HRTF Database." AES 5th International
Conference on Audio for Virtual and Augmented Reality (AVAR 2024), Redmond, WA, USA.
Meta Reality Labs Research. https://facebookresearch.github.io/SS2_HRTF/
Licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).
```

Used as five selectable base heads (`assets/hrtf/ss2_fzk.hrtf`, `ss2_gzu.hrtf`,
`ss2_rll.hrtf`, `ss2_ynb.hrtf`, `ss2_ztv.hrtf`).

**Modified:** HRIRs windowed from the original 384 taps to our standard 256-tap length
(raised-cosine fade over the trimmed tail); five subjects selected via farthest-point
diversity selection over PCA log-magnitude space. CC BY 4.0 requires attribution (given
above), a link to the license, and an indication that the material was modified (noted
here).

### ARI HpIR — over-ear headphone compensation

```
ARI HpIR database (Sennheiser HD 580 measurements) — Acoustics Research Institute,
Austrian Academy of Sciences (Vienna). CC BY-SA 3.0.
https://www.sofaconventions.org/mediawiki/index.php/Files
```

Used to derive the optional over-ear headphone compensation EQ
(`assets/hrtf/overear_comp.json`, `overear_comp_fir.wav`) — an average-inverse static
correction, not a redistribution of the raw measurements. Because the source is
CC BY-SA 3.0, this derived correction is likewise released under CC BY-SA 3.0.
