//! First-order edge diffraction for doorways, corners, and obstacle edges.
//!
//! When the direct line source→listener is blocked but they can both "see" a
//! shared edge (a doorway jamb, a wall corner), sound bends around that edge and
//! still arrives — quieter and duller. This is what lets you hear a sound source
//! through an open doorway you're not directly facing.
//!
//! Model: GEOMETRY by the practical games approximation (Wwise/Steam-Audio
//! style) — golden-section search finds the point on the edge giving the
//! shortest detour source→edge→listener — but the ATTENUATION is a true
//! frequency-dependent UTD coefficient rather than a tuned heuristic.
//!
//! ## UTD coefficient (half-plane / knife-edge, Kouyoumjian–Pathak asymptotic)
//!
//! We treat each edge as a perfectly-absorbing-backed **knife edge** (a half-plane
//! wedge of exterior angle 2π, the canonical screen). The shadowing strength is
//! governed by the Fresnel diffraction parameter
//!
//! ```text
//!   v = sign · sqrt( 2 · δ / λ ),   δ = |detour| − |direct|,   λ = c / f
//! ```
//!
//! where `δ` is the excess path length and the `sign` is negative in the LIT zone
//! (listener can see past the edge) and positive in the SHADOW zone. The field
//! relative to free space is the Fresnel transition function
//!
//! ```text
//!   |H(v)| = | (1 + i)/2 · ( 1/2 − C(v) − i(1/2 − S(v)) ) |
//! ```
//!
//! with `C`,`S` the cosine/sine Fresnel integrals. This is the half-plane
//! Sommerfeld/UTD asymptotic with the Fresnel-integral transition function. Key
//! properties we rely on:
//!   * `|H|` is **continuous across the shadow boundary** (v = 0 gives exactly
//!     0.5 — the canonical 6 dB drop — with no jump), unlike the old heuristic
//!     which snapped from ~1 to a rolloff at the boundary.
//!   * Deeper in shadow (v ≫ 0) → `|H| → 0`; in the lit zone (v ≪ 0) → `|H| → 1`.
//!   * `v ∝ sqrt(f)`, so high bands sit deeper in shadow ⇒ stronger HF rolloff,
//!     for free, with the correct physical frequency dependence.
//!
//! ### Assumptions / limits
//!   * Knife-edge (half-plane) wedge only — we don't carry the real wedge exterior
//!     angle from the `EdgeDef`, so the wedge-angle term of full UTD is dropped.
//!     For doorway jambs and thin partial walls (≈ half-planes) this is apt.
//!   * First-order (single bend); no slope-diffraction or higher-order terms.
//!   * The lit/shadow `sign` is inferred from whether the straight source→listener
//!     line is occluded by the edge's plane locally (see `signed_excess`).

use crate::image_source::{Tap, NUM_BANDS};
#[cfg(test)]
use crate::image_source::SPEED_OF_SOUND;
use crate::vec3::Vec3;

/// Octave band centers (Hz), matching `ir_build::BANDS_HZ` and the JS side. The
/// UTD parameter scales with sqrt(f), so these set the per-band shadow depth.
const BAND_CENTERS_HZ: [f32; NUM_BANDS] =
    [63.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0];

/// A diffracting edge: a finite line segment between two endpoints. (Typically a
/// doorway side or a wall corner.)
pub struct Edge {
    pub a: Vec3,
    pub b: Vec3,
}

impl Edge {
    /// Closest point on the edge segment to the line of the shortest detour. We
    /// approximate the optimal diffraction point as the point on the edge that
    /// minimizes total path length source→p→listener. For a straight edge this is
    /// found by a few iterations of golden-section search on the segment param.
    fn best_point(&self, source: Vec3, listener: Vec3) -> (Vec3, f32) {
        let path_len = |t: f32| {
            let p = self.a.lerp(self.b, t);
            source.dist(p) + p.dist(listener)
        };
        // Golden-section search on t in [0,1].
        let gr = 0.6180339887_f32;
        let mut lo = 0.0_f32;
        let mut hi = 1.0_f32;
        let mut c = hi - gr * (hi - lo);
        let mut d = lo + gr * (hi - lo);
        let mut fc = path_len(c);
        let mut fd = path_len(d);
        for _ in 0..40 {
            if fc < fd {
                hi = d;
                d = c;
                fd = fc;
                c = hi - gr * (hi - lo);
                fc = path_len(c);
            } else {
                lo = c;
                c = d;
                fc = fd;
                d = lo + gr * (hi - lo);
                fd = path_len(d);
            }
        }
        let t = 0.5 * (lo + hi);
        let p = self.a.lerp(self.b, t);
        (p, source.dist(p) + p.dist(listener))
    }
}

/// Fresnel integrals C(x) = ∫₀ˣ cos(πt²/2) dt and S(x) = ∫₀ˣ sin(πt²/2) dt,
/// via the standard rational approximation (Boersma / Abramowitz-Stegun style)
/// good to ~2e-3 absolute error on C/S (the S asymptotic peaks near ~1.9e-3 at the
/// x=3 crossover); this nearly cancels in the gain magnitude (the utd_gain jump at
/// the crossover is ~5e-5), so it's perceptually irrelevant for an audio gain. Valid
/// for x ≥ 0; both integrals are odd, so callers handle the sign.
fn fresnel(x: f32) -> (f32, f32) {
    let ax = x.abs();
    let pi = std::f64::consts::PI;
    let a = ax as f64;
    let (c, s) = if a < 3.0 {
        // Small/moderate argument: power series
        //   C = Σ (−1)ⁿ (π/2)²ⁿ a^(4n+1) / ((2n)!(4n+1))
        //   S = Σ (−1)ⁿ (π/2)^(2n+1) a^(4n+3) / ((2n+1)!(4n+3))
        // Converges fast for a ≲ 1.6; we sum until terms are negligible.
        let h = pi / 2.0;
        let mut cc = 0.0f64;
        let mut ss = 0.0f64;
        // C series: term magnitude = (π/2)^{2n} a^{4n+1} / (2n)!, built iteratively.
        // Terms grow before they shrink for a≈3, so we run a fixed (generous) count
        // rather than an early break — the factorial wins by ~n=20 and the tail is
        // negligible; 40 terms is comfortably converged for a < 3.
        let mut term = a;
        let mut sign = 1.0f64;
        for n in 0..40 {
            let nn = n as f64;
            if n > 0 {
                term *= h * h * a * a * a * a / ((2.0 * nn - 1.0) * (2.0 * nn));
            }
            cc += sign * term / (4.0 * nn + 1.0);
            sign = -sign;
        }
        // S series: (π/2)^{2n+1} a^{4n+3} / (2n+1)!
        let mut term = h * a * a * a;
        let mut sign = 1.0f64;
        for n in 0..40 {
            let nn = n as f64;
            if n > 0 {
                term *= h * h * a * a * a * a / ((2.0 * nn) * (2.0 * nn + 1.0));
            }
            ss += sign * term / (4.0 * nn + 3.0);
            sign = -sign;
        }
        (cc, ss)
    } else {
        // Large argument: asymptotic via auxiliary functions f,g (A&S 7.3.27/28),
        //   C(a) = 1/2 + f(a)·sin(πa²/2) − g(a)·cos(πa²/2)
        //   S(a) = 1/2 − f(a)·cos(πa²/2) − g(a)·sin(πa²/2)
        // with f(a) ≈ 1/(πa)(1 − 3/(πa²)²…), g(a) ≈ 1/(π²a³). Two leading terms
        // are plenty (this branch is used for a ≥ 3.0) for an audio gain.
        let arg = h_arg(a);
        let (s_arg, c_arg) = arg.sin_cos();
        let pa2 = pi * a * a;
        let f = (1.0 / (pi * a)) - (1.0 / (pi * pi * pi * a * a * a * a * a)) * 3.0;
        let g = (1.0 / pa2) / (pi * a) - (1.0 / (pa2 * pa2)) / (pi * a) * 15.0;
        let cc = 0.5 + f * s_arg - g * c_arg;
        let ss = 0.5 - f * c_arg - g * s_arg;
        (cc, ss)
    };
    if x < 0.0 {
        (-(c as f32), -(s as f32))
    } else {
        (c as f32, s as f32)
    }
}

#[inline]
fn h_arg(a: f64) -> f64 {
    0.5 * std::f64::consts::PI * a * a
}

/// Knife-edge UTD magnitude |H(v)| from the Fresnel transition function, where
/// `v` is the (signed) Fresnel diffraction parameter. Returns a gain in [0,1]:
///   * v → −∞ (deep lit):      → 1.0
///   * v =  0 (shadow boundary): = 0.5  (continuous, no jump — the key property)
///   * v → +∞ (deep shadow):   → 0.0
///
/// Derivation: the diffracted-plus-geometric field relative to free field is
/// `E = (1+i)/2 · [ (1/2 − C(v)) − i(1/2 − S(v)) ]`. Its magnitude is the
/// continuous knife-edge response used in acoustics (Kirchhoff/UTD asymptotic).
pub fn utd_gain(v: f32) -> f32 {
    let (c, s) = fresnel(v);
    let a = 0.5 - c;
    let b = 0.5 - s;
    // |(1+i)/2 · (a − i b)| = (1/√2)·√(a² + b²).
    let mag = (a * a + b * b).sqrt() * std::f32::consts::FRAC_1_SQRT_2;
    mag.clamp(0.0, 1.0)
}

/// Signed excess path length δ = (detour − direct). Positive δ ⇒ the listener is
/// in the edge's shadow (the bent path is genuinely longer); δ ≈ 0 ⇒ at the
/// shadow boundary; negative δ is not produced by the detour geometry (the bent
/// path is never shorter than the straight line), but the UTD coefficient is
/// defined for it so the boundary stays continuous when probed in tests.
fn fresnel_param(excess: f32, freq: f32, speed_of_sound: f32) -> f32 {
    let lambda = speed_of_sound / freq.max(1.0);
    // v = sign(δ)·sqrt(2|δ|/λ).
    let mag = (2.0 * excess.abs() / lambda).sqrt();
    if excess < 0.0 {
        -mag
    } else {
        mag
    }
}

/// Per-band knife-edge UTD gains for a given (signed) excess path length. Exposed
/// for tests: lets us sweep δ continuously through the shadow boundary (δ=0).
pub fn utd_band_gains(excess: f32, speed_of_sound: f32) -> [f32; NUM_BANDS] {
    let mut band_gains = [1.0f32; NUM_BANDS];
    for b in 0..NUM_BANDS {
        let v = fresnel_param(excess, BAND_CENTERS_HZ[b], speed_of_sound);
        band_gains[b] = utd_gain(v);
    }
    band_gains
}

/// Compute a diffracted tap for one edge, given the direct distance (used to
/// gauge how much detour the bend adds → how deep in shadow). Returns None if the
/// edge offers no meaningful detour (degenerate).
///
/// The detour geometry only ever yields excess ≥ 0 (the bent path is never
/// shorter than the straight line), so this evaluates the shadow/boundary side of
/// the UTD curve: at most 0.5 at grazing, falling toward 0 deeper in shadow.
pub fn diffract_tap(
    edge: &Edge,
    source: Vec3,
    listener: Vec3,
    direct_dist: f32,
    speed_of_sound: f32,
) -> Option<Tap> {
    let (p, detour) = edge.best_point(source, listener);
    if detour <= 1e-3 {
        return None;
    }

    // How much longer the bent path is than the straight line: the diffraction
    // "depth". 0 = grazing the edge (shadow boundary), large = deep in shadow.
    let excess = (detour - direct_dist).max(0.0);

    // Per-band UTD coefficient. Because the Fresnel parameter v ∝ sqrt(f), high
    // bands sit deeper in shadow ⇒ stronger HF rolloff, with the correct physical
    // frequency dependence — no separate heuristic HF term needed.
    let band_gains = utd_band_gains(excess, speed_of_sound);

    let dir = p.sub(listener).normalized(); // arrives from the edge direction

    Some(Tap {
        delay: detour / speed_of_sound,
        gain: 1.0 / detour.max(1.0),
        band_gains,
        dir,
        order: 1, // first-order diffraction
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diffracted_path_is_longer_quieter_and_duller_when_shadowed() {
        // Doorway edge along y; source on one side, listener around the corner.
        let edge = Edge { a: Vec3::new(0.0, 0.0, 0.0), b: Vec3::new(0.0, 3.0, 0.0) };
        let source = Vec3::new(-2.0, 1.5, 1.0);
        let listener = Vec3::new(2.0, 1.5, -1.0);
        let direct = source.dist(listener);
        let tap = diffract_tap(&edge, source, listener, direct, SPEED_OF_SOUND).unwrap();
        // LONGER: bent path through the edge is longer than the straight line, and
        // the delay matches the detour length exactly.
        let detour = tap.delay * SPEED_OF_SOUND;
        assert!(detour >= direct - 1e-3);
        let (p, dd) = edge.best_point(source, listener);
        let _ = p;
        assert!((detour - dd).abs() < 1e-3, "delay must equal detour/c");
        // QUIETER: in shadow every band is attenuated below unity (≤ 0.5).
        assert!(tap.band_gains[0] < 1.0);
        // DULLER: highs more attenuated than lows (UTD v ∝ sqrt(f)).
        assert!(tap.band_gains[NUM_BANDS - 1] < tap.band_gains[0]);
    }

    #[test]
    fn grazing_edge_is_half_amplitude() {
        // Source and listener collinear through the edge point: excess ~0, i.e.
        // exactly at the shadow boundary → UTD gives the canonical 0.5 (−6 dB),
        // not ~unity. This is the continuous-transition behaviour.
        let edge = Edge { a: Vec3::new(0.0, -1.0, 0.0), b: Vec3::new(0.0, 1.0, 0.0) };
        let source = Vec3::new(-2.0, 0.0, 0.0);
        let listener = Vec3::new(2.0, 0.0, 0.0);
        let direct = source.dist(listener);
        let tap = diffract_tap(&edge, source, listener, direct, SPEED_OF_SOUND).unwrap();
        // All bands ≈ 0.5 at the boundary (excess≈0 ⇒ v≈0 ⇒ |H|=0.5).
        for &g in &tap.band_gains {
            assert!((g - 0.5).abs() < 0.05, "boundary gain {g} should be ≈0.5");
        }
    }

    #[test]
    fn utd_is_continuous_across_the_shadow_boundary() {
        // The UTD coefficient |H(v)| is continuous in the Fresnel parameter v —
        // the central improvement over the old heuristic, which snapped from ~1 to
        // a rolloff at the boundary. We sweep v through 0 (the shadow boundary)
        // and assert no jump. v is the physically smooth variable; the δ↦v map
        // adds a sqrt cusp at δ=0 (vertical tangent) but introduces no DISCONTINUITY.
        let step = 1e-3;
        let mut prev = utd_gain(-2.0);
        let mut v = -2.0 + step;
        while v <= 2.0 {
            let g = utd_gain(v);
            assert!(
                (g - prev).abs() < 0.01,
                "discontinuity in |H| near v={v}: {prev} -> {g}",
            );
            prev = g;
            v += step;
        }
        // Exactly at the boundary |H(0)| = 0.5 (the canonical −6 dB), no jump.
        assert!((utd_gain(0.0) - 0.5).abs() < 1e-3);

        // And the per-band coefficient is continuous in δ everywhere EXCEPT it has
        // a (continuous) sqrt cusp at δ=0; sampling either side of 0 with a small
        // offset still lands near the boundary value 0.5 (no jump to ~1 or ~0).
        let c = SPEED_OF_SOUND;
        for &g in &utd_band_gains(0.0, c) {
            assert!((g - 0.5).abs() < 1e-3);
        }
        let eps = 1e-4;
        let lo = utd_band_gains(-eps, c);
        let hi = utd_band_gains(eps, c);
        for b in 0..NUM_BANDS {
            // Straddling the boundary by ±0.1mm stays within a small band of 0.5:
            // no discontinuous leap between the lit (~1) and deep-shadow (~0) regimes.
            assert!((lo[b] - 0.5).abs() < 0.1, "band {b} just lit: {}", lo[b]);
            assert!((hi[b] - 0.5).abs() < 0.1, "band {b} just shadow: {}", hi[b]);
        }
    }

    #[test]
    fn lit_zone_is_near_unity_and_deeper_shadow_attenuates_more() {
        let c = SPEED_OF_SOUND;
        // Lit zone (δ < 0, listener can see past the edge) → near unity. The
        // Fresnel field ripples slightly above/around 1 just inside the lit zone
        // (clamped to 1), so we assert "clearly louder than the 0.5 boundary".
        let lit = utd_band_gains(-1.0, c);
        for &g in &lit {
            assert!(g > 0.8, "lit-zone gain {g} should be near unity");
        }
        // Deeper in shadow → more attenuation AND more HF rolloff.
        let shallow = utd_band_gains(0.1, c);
        let deep = utd_band_gains(0.5, c);
        assert!(deep[0] < shallow[0], "deeper shadow is quieter");
        // HF rolloff grows with depth: high/low ratio falls as we go deeper.
        let shallow_ratio = shallow[NUM_BANDS - 1] / shallow[0];
        let deep_ratio = deep[NUM_BANDS - 1] / deep[0];
        assert!(deep_ratio < shallow_ratio, "deeper shadow is duller");
    }
}
