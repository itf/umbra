# Credits & Attributions

This file lists **third-party assets** bundled with this project and their license
obligations. These audio assets are **not** original to this repository — they were
sourced from Wikimedia Commons and are used under the licenses stated below.

The tongue-click recordings under `public/audio/clicks/` are candidate "probe" sounds
for the echolocation trainer (a sharp mouth click is a near-impulse broadband transient,
which makes it an excellent acoustic probe). See `docs/click-probe-sounds.md` for the
full sourcing research.

## Sound credits — tongue-click probes

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
Where audio was trimmed/normalized/resampled for use as a probe, that derived
clip is likewise released under CC BY-SA 3.0.
```

## License notes

- **CC BY-SA 3.0 files** (Dental, Alveolar lateral, Palatoalveolar, Bilabial clicks,
  all recorded by Peter Isotalo). Attribution is required. These files are also
  dual-licensed under GFDL 1.2+; we rely on the CC BY-SA 3.0 option. The share-alike
  clause attaches to the specific *adapted audio asset*, not to the game code that plays
  it — audio and software are separate works. **Any trimmed, normalized, resampled, or
  otherwise processed derivative of these files is itself released under CC BY-SA 3.0**
  (see `https://creativecommons.org/licenses/by-sa/3.0/`) and must retain the attribution
  above.

- **CC0 1.0 file** ("Percussive alveolar click" by Eshaan011). This is a public-domain
  dedication and requires **no attribution** and imposes **no share-alike** obligation.
  It is credited here anyway as a courtesy.

## Processing status

At the time these assets were added, `ffmpeg`/`ffprobe` were **not available** in the
build environment, so the probe-ready processing (trim to the click transient, downmix to
mono, resample to 48000 Hz, peak-normalize to about -1 dBFS, export as `.ogg` + `.wav`)
was **not** performed. The **original, unmodified** files are stored under
`public/audio/clicks/original/`. Each is Ogg Vorbis, mono, 44100 Hz. Processing must be
completed later; see `public/audio/clicks/manifest.json` for the per-file status.

Licenses were re-verified against each file's Wikimedia Commons page at download time
(June 2026) and matched the metadata recorded above.
