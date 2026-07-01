# Click-probe sound sources (tongue / palatal clicks)

Research + sourcing shortlist for realistic tongue-click "probe" sounds to replace or
supplement the Web-Audio-synthesized probe/beacon in the echolocation trainer.

**Status: NOT downloaded. This is a sourced, attributed shortlist for approval before we fetch anything.**

All candidates are IPA click-consonant recordings from Wikimedia Commons. A palatal /
(post)alveolar / dental oral click is a sharp, near-impulse-like broadband transient produced by
a tongue-suction release — acoustically close to the synthetic impulse we already use, which is
exactly what makes it a good echolocation probe (see "Why clicks work as probes" below).

Reference on the sound itself: https://en.wikipedia.org/wiki/Palatal_click

---

## 1. Candidate files

Each file page follows the pattern `https://commons.wikimedia.org/wiki/File:<name>`.
Direct media URLs are on `upload.wikimedia.org`. Note: many recordings embed the click
**between two [a] vowels** (e.g. `[ǀa: aǀa:]`) — we would trim to isolate the click transient.

| # | File | IPA | Author / uploader | License | Format / duration |
|---|------|-----|-------------------|---------|-------------------|
| 1 | Dental_click.ogg | [ǀ] | Peter Isotalo (User:Karmosin) | CC BY-SA 3.0 **and** GFDL 1.2+ (dual) | Ogg Vorbis, ~2.2 s |
| 2 | Alveolar_lateral_click.ogg | [ǁ] | Peter Isotalo (User:Karmosin) | CC BY-SA 3.0 **and** GFDL 1.2+ (dual) | Ogg Vorbis, ~1.8 s |
| 3 | Palatoalveolar_click.ogg | [ǂ] | Peter Isotalo (User:Karmosin) | CC BY-SA 3.0 **and** GFDL 1.2+ (dual) | Ogg Vorbis, ~1.8 s |
| 4 | Bilabial_click.ogg | [ʘ] | Peter Isotalo (User:Karmosin) | CC BY-SA 3.0 **and** GFDL 1.2+ (dual) | Ogg Vorbis, ~2.1 s |
| 5 | Percussive_alveolar_click.ogg | (sublingual percussive, Sandawe) | Eshaan011 | **CC0 1.0** (public domain) | Ogg Vorbis, ~1.5 s |

### Page + media URLs

1. **Dental click** `[ǀ]`
   - Page: https://commons.wikimedia.org/wiki/File:Dental_click.ogg
   - Media: https://upload.wikimedia.org/wikipedia/commons/1/1f/Dental_click.ogg
2. **Alveolar lateral click** `[ǁ]`
   - Page: https://commons.wikimedia.org/wiki/File:Alveolar_lateral_click.ogg
   - Media: https://upload.wikimedia.org/wikipedia/commons/f/f4/Alveolar_lateral_click.ogg
3. **Palatoalveolar click** `[ǂ]`
   - Page: https://commons.wikimedia.org/wiki/File:Palatoalveolar_click.ogg
   - Media: https://upload.wikimedia.org/wikipedia/commons/8/89/Palatoalveolar_click.ogg
4. **Bilabial click** `[ʘ]`
   - Page: https://commons.wikimedia.org/wiki/File:Bilabial_click.ogg
   - Media: https://upload.wikimedia.org/wikipedia/commons/9/9a/Bilabial_click.ogg
5. **Percussive alveolar click** (CC0)
   - Page: https://commons.wikimedia.org/wiki/File:Percussive_alveolar_click.ogg
   - Media: https://upload.wikimedia.org/wikipedia/commons/c/c4/Percussive_alveolar_click.ogg

License URLs:
- CC BY-SA 3.0 Unported: https://creativecommons.org/licenses/by-sa/3.0/
- GFDL 1.2+: http://www.gnu.org/copyleft/fdl.html
- CC0 1.0: https://creativecommons.org/publicdomain/zero/1.0/

> Sample rate is not stated on the file pages; Commons IPA .ogg clips are typically mono and
> low bitrate (~87–109 kbps Vorbis). Verify actual rate/channels after download (`ffprobe`).

---

## 2. License obligations

**CC BY-SA 3.0 files (#1–#4).** We may use them in the app — including a commercial/closed app —
provided we give attribution: author name, the work title, the license (with link), and a link
back to the source. The share-alike (SA) clause applies **only to *adapted* material** (a
"derivative" of the audio itself — e.g. if we pitch-shift, filter, resample, or otherwise
transform the recording). If we redistribute an *adapted* version of one of these clips, that
adapted clip must itself be released under CC BY-SA 3.0 (or a compatible later version).

Key clarifications:
- **Using a file as-is** (playing it in the app, or trimming leading/trailing silence, which is
  arguably not creative adaptation) requires attribution but does **not** force our whole game or
  codebase to become share-alike. SA is not "viral" across the whole application — it attaches to
  the specific adapted audio asset, not to code that merely plays it (audio and software are
  separate works; there is no combined-derivative here).
- **Processing** (normalize, EQ, trim to a transient, pitch/rate change) produces an *adaptation*.
  The safe reading: ship the processed click under CC BY-SA 3.0 too, with attribution. This does
  not affect the rest of the repo, only that asset file.
- GFDL is offered in the alternative — irrelevant for us; we rely on the CC BY-SA 3.0 option.

**CC0 file (#5).** Public-domain dedication. No obligations at all — no attribution required, and
no share-alike. We can trim/process/redistribute freely. (Crediting is still polite and we can
list it, but it is optional.) This makes #5 the lowest-friction choice.

**Where attribution lives.** A dedicated **Credits / Licenses screen** in the app (or an
`ATTRIBUTIONS`/`CREDITS.md` shipped with the build) satisfies "reasonable" attribution. It does
not need to be on-screen during play. Keep the block below in that screen.

---

## 3. Recommendation for probe use

We want: short, dry, broadband, sharp transient, low background noise, mono.

Ranked:

1. **#5 Percussive_alveolar_click.ogg (CC0)** — best default. CC0 = zero obligations, a crisp
   percussive click, recent upload. Trim to the transient and it's ready.
2. **#3 Palatoalveolar_click.ogg `[ǂ]`** — closest to the "palatal click" the design references;
   sharp, high-frequency-rich. Best *tonal* match to the wiki article. CC BY-SA (attribute).
3. **#1 Dental_click.ogg `[ǀ]`** — the familiar "tsk" click; very sharp, bright, impulse-like.
4. **#2 Alveolar_lateral_click.ogg `[ǁ]`** — slightly broader/wetter; good variety/alt probe.
5. **#4 Bilabial_click.ogg `[ʘ]`** — lower/duller (lip-based), least broadband; skip for probe,
   fine as a distinct "beacon" flavour.

Processing we'd want on any of them:
- **Trim**: isolate just the click burst — cut the surrounding `[a:]` vowels and silence.
- **Normalize** to a consistent peak (e.g. −1 dBFS) so probe loudness is uniform across files.
- **Downmix to mono** if any file is stereo.
- **Resample** to the engine's rate (match the Web Audio context, typically 48 kHz).
- Optional gentle high-pass (~150–200 Hz) to keep it dry/impulsive; avoid heavy EQ.
- Remember: processing #1–#4 creates a CC BY-SA adaptation → keep attribution and mark that asset SA.

---

## 4. Ready-to-paste ATTRIBUTIONS block

```
Sound credits — tongue-click probes

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

### Why clicks work as probes (for the credits/README note)

A palatal/oral click is generated by a rapid tongue-suction *release* — mechanically an impulse.
Its energy is spread across a wide frequency band (a near-flat, short broadband burst) rather than
concentrated at one pitch. Broadband + short duration = the closest natural analogue to an ideal
acoustic impulse, so a single click excites the whole room response at once: early reflections and
the size/shape of the space are encoded across many frequencies simultaneously. That is precisely
why human echolocators use sharp mouth clicks — and why these recordings map well onto the
impulse-style probe the engine already emits.

---

## 5. Not usable / avoid

- **File:Velar_click.ogg** — although it is CC0 (uploader FonzuWiki) and would be legally fine, its
  page states it is the *"alleged pronunciation of a velar click [ʞ], which is physically
  impossible."* It's a novelty/synthetic demo, not a genuine oral-suction click — **not
  acoustically representative**, so avoid it as a probe.
- **File:Retrflx click.wav** — appears in the category but its per-file license/author were not
  confirmed in this pass. **Do not use until its license page is verified.**
- General rule: skip any Commons audio whose file page shows *no* explicit license, a
  "non-free"/"fair use" tag, or CC **BY-NC** / **ND** variants — NC (non-commercial) and ND
  (no-derivatives) are both incompatible with shipping/processing in the game.

---

_Sourced from Wikimedia Commons file pages, June 2026. Confirm each license on the file page again
at download time (uploads can be re-licensed or deleted)._
