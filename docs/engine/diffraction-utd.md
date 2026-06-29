# Diffraction: UTD coefficient + auto-derived edges

Sound bends around an edge — a doorway jamb, the end of a partial wall, a corner —
so a source is still heard when the straight line to it is blocked. Papasangre
models **first-order** edge diffraction in two halves:

1. **Geometry** (unchanged): for a diffracting edge, a golden-section search finds
   the point on the edge that minimises the total detour `source → edge →
   listener`. The tap's delay is `detour / c` and its broadband gain is `1/detour`.
2. **Attenuation** (new): a physically-grounded **UTD coefficient** replaces the
   old tuned heuristic. It gives the correct shadow-zone attenuation, the correct
   frequency dependence, and — critically — a **continuous** transition through the
   shadow boundary.

Plus a third piece on the level side:

3. **Edge derivation** (`load.ts`): diffracting edges are auto-derived from the
   authored level geometry, so diffraction "just works" without the caller hand-
   listing edges.

---

## 1. The UTD coefficient (`acoustics-core/src/diffraction.rs`)

### What was wrong with the heuristic

The previous attenuation was `1/(1 + k·excess)` with an ad-hoc per-band HF penalty.
Two problems:

- **Discontinuity at the shadow boundary.** The diffraction tap appeared with a
  near-unity gain the instant the listener crossed into shadow, then rolled off.
  Physically the field is continuous across that boundary (the direct path fades to
  zero exactly as the diffracted contribution rises to fill it), so the heuristic
  produced an audible step.
- **Frequency dependence was invented**, not derived — a band-index×excess factor.

### What we implement

A **half-plane (knife-edge) UTD coefficient**, the Kouyoumjian–Pathak asymptotic
with the Fresnel-integral transition function (the same family used by Steam Audio
and standard outdoor-sound-propagation models).

The shadowing strength is the **Fresnel diffraction parameter**

```
v = sign · sqrt( 2 · δ / λ ),     δ = |detour| − |direct|,   λ = c / f
```

where `δ` is the excess path length (how much longer the bent path is than the
straight line) and `sign` is **negative in the lit zone** (listener can see past the
edge) and **positive in the shadow zone**. The field relative to free space is the
Fresnel transition function

```
E = (1+i)/2 · [ (½ − C(v)) − i(½ − S(v)) ]
|H(v)| = (1/√2) · sqrt( (½ − C(v))² + (½ − S(v))² )
```

with `C`, `S` the cosine/sine Fresnel integrals. `|H(v)|` is the diffraction gain:

| regime                 | v        | `\|H(v)\|` |
|------------------------|----------|-----------|
| deep lit               | v → −∞   | → 1.0     |
| **shadow boundary**    | v = 0    | **= 0.5** (−6 dB) |
| deep shadow            | v → +∞   | → 0.0     |

`utd_gain(v)` evaluates `|H|`; `utd_band_gains(δ, c)` evaluates it per octave band
using the band centres `[63,125,250,500,1k,2k,4k,8k] Hz`.

### Why it's continuous across the shadow boundary

`|H(v)|` is a smooth function of `v`, equal to exactly `0.5` at `v = 0`. The δ→v map
adds a `sqrt` cusp at `δ = 0` (a vertical tangent — the gain changes fastest right at
the boundary) but **no discontinuity**: the value passes smoothly through 0.5 with no
jump between the lit (~1) and shadow (~0) regimes. This is the key improvement over
the heuristic, which snapped from ~1 to a rolloff at the boundary.

In the live engine the detour geometry only ever yields `δ ≥ 0` (the bent path is
never shorter than the straight line), so `diffract_tap` evaluates the shadow/boundary
side: at most `0.5` at grazing, falling toward `0` deeper in shadow. The lit side
(`δ < 0`) is defined so the boundary stays continuous when probed in tests.

### Why HF rolls off more in shadow — for free

Because `v ∝ sqrt(f)`, a high band sits at a larger `v` (deeper in shadow) than a low
band at the same `δ`. So `|H|` is smaller for high frequencies, and the gap widens as
`δ` grows: the diffracted path is **duller** the deeper into shadow you go, with the
correct physical frequency dependence. No separate HF heuristic is needed.

### Fresnel integral implementation

`fresnel(x)` computes `C(x)`, `S(x)` with two branches:

- `|x| < 3`: the convergent power series (accurate to ≪1e-3; validated against
  reference values C(0.5)=0.4923, C(1)=0.7799, C(1.5)=0.4453, C(2)=0.4883).
- `|x| ≥ 3`: the asymptotic auxiliary-function form `C = ½ + f·sin − g·cos`,
  `S = ½ − f·cos − g·sin`. The crossover at 3.0 is where the two branches agree to
  ~1e-3, so the seam is smooth.

### Assumptions / limits

- **Knife-edge (half-plane) wedge only.** We don't carry the real wedge exterior
  angle from the `EdgeDef`, so the full-UTD wedge-angle term is dropped. For doorway
  jambs and thin partial walls (≈ half-planes) this is the apt model.
- **First-order** (single bend); no slope-diffraction or second-order edge chaining.
- The lit/shadow `sign` follows from the detour geometry (`δ ≥ 0` ⇒ shadow side).

---

## 2. Auto-derived diffraction edges (`src/level/load.ts`)

`diffractionEdgesAt(level, t)` derives the diffracting edges from the level's
**interior walls**. Each interior wall is a thin vertical quad extruded from floor
(`y=0`) to room height. Its two **free ends** — the vertical edges at the segment
endpoints not joined to another wall or the perimeter — are exactly the surfaces
sound bends around (doorway jambs, the ends of partial walls). We emit one vertical
`EdgeDef` (`[x,0,z] → [x,height,z]`) per free end.

### "Free end" heuristic

An endpoint is **free** when it is:

- **not on the room perimeter** (`x ≈ 0` or `width`, `z ≈ 0` or `depth`, within
  `EDGE_EPS = 5 cm`) — an endpoint buried in a perimeter wall is a solid corner, not
  a diffracting free end; and
- **not coincident** (within `EDGE_EPS`) with any *other* wall's endpoint — a shared
  vertex is an L/T junction (solid), not a free end.

It is time-parameterised (`t` seconds) so moving walls' free ends track their motion,
mirroring `interiorWallsAt`. `loadLevel` returns the rest-pose edges in
`LoadedLevel.edges`; `main.ts` plumbs them to `ClapRoom.updateGeneralRoom` /
`updateLive`, and re-derives them per frame for moving-wall levels.

### Limits

- **First-order only** — one bend per edge.
- **Pragmatic free-end detection.** An endpoint that touches the *middle* of another
  wall (a true T-junction that doesn't share a vertex) is treated as free and
  over-emits an edge. This is acoustically near-harmless: the UTD coefficient is
  ≈ unity wherever the listener is not actually in that edge's shadow, so a spurious
  edge contributes a near-inaudible tap. We accept that rather than run full
  segment-incidence tests.
- Perimeter-only / open levels with no interior walls derive **no** edges.

---

## 3. What's tested

**Rust (`diffraction.rs`):**

- `utd_is_continuous_across_the_shadow_boundary` — `|H(v)|` swept through `v = 0`
  has no jump; `|H(0)| = 0.5`; sampling δ just either side of 0 stays near 0.5 (no
  leap between the lit ~1 and shadow ~0 regimes).
- `grazing_edge_is_half_amplitude` — at the boundary every band ≈ 0.5 (the canonical
  −6 dB), not ~unity.
- `lit_zone_is_near_unity_and_deeper_shadow_attenuates_more` — lit zone ≈ unity;
  deeper shadow is quieter and duller (HF/LF ratio falls with depth).
- `diffracted_path_is_longer_quieter_and_duller_when_shadowed` — the diffracted
  delay equals `detour/c`, the path is longer than direct, quieter, and duller.

**JS (`tests/load.test.ts`, `tests/wasmRoom.test.ts`):**

- An interior wall (doorway) auto-derives 2 free-end edges; a perimeter-buried end
  yields only the interior edge; an enclosed/open level with no interior walls
  derives none; a shared L-junction drops the shared corner.
- A doorway level (auto-derived edges) produces a first-order diffraction tap in the
  listener's shadow that is longer, quieter, and duller than the direct line.
