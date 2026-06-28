//! First-order edge diffraction for doorways, corners, and obstacle edges.
//!
//! When the direct line source→listener is blocked but they can both "see" a
//! shared edge (a doorway jamb, a wall corner), sound bends around that edge and
//! still arrives — quieter and duller. This is what lets you hear a sound source
//! through an open doorway you're not directly facing.
//!
//! Model: the practical games approximation (Wwise/Steam-Audio style) rather than
//! full UTD integrals. For an edge segment, find the point on the edge giving the
//! shortest detour path source→edge→listener. Attenuate by:
//!   * the extra path length vs the straight line (1/r on the detour distance), and
//!   * a diffraction factor that grows with how far past the shadow boundary the
//!     listener sits (deeper in shadow = more attenuation + stronger HF rolloff).
//! The HF rolloff is encoded into the per-band gains so it threads through the
//! same renderer as reflections. This is cheap, stable, and perceptually right;
//! a true UTD coefficient can replace the factor later without changing callers.

use crate::image_source::{Tap, NUM_BANDS, SPEED_OF_SOUND};
use crate::vec3::Vec3;

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

/// Compute a diffracted tap for one edge, given the direct distance (used to
/// gauge how much detour the bend adds → how deep in shadow). Returns None if the
/// edge offers no meaningful detour (degenerate).
pub fn diffract_tap(edge: &Edge, source: Vec3, listener: Vec3, direct_dist: f32) -> Option<Tap> {
    let (p, detour) = edge.best_point(source, listener);
    if detour <= 1e-3 {
        return None;
    }

    // How much longer the bent path is than the straight line: the diffraction
    // "depth". 0 = grazing the edge (no shadowing), large = deep in shadow.
    let excess = (detour - direct_dist).max(0.0);

    // Diffraction attenuation: a smooth rolloff with excess path length. Tuned so
    // grazing incidence ≈ unity and a half-metre detour is clearly quieter.
    // factor in (0,1]; classic UTD ~ 1/sqrt of a Fresnel-like argument, which we
    // approximate with 1/(1 + k*excess).
    let broadband = 1.0 / (1.0 + 1.8 * excess);

    // Frequency-dependent: highs bend less than lows, so the shadowed path is
    // low-pass. Higher bands get extra attenuation that grows with excess.
    let mut band_gains = [broadband; NUM_BANDS];
    for b in 0..NUM_BANDS {
        // Band 0..7 ~ low..high. HF penalty scales with band index and excess.
        let hf_penalty = 1.0 / (1.0 + (b as f32 / (NUM_BANDS as f32)) * excess * 4.0);
        band_gains[b] *= hf_penalty;
    }

    let dir = p.sub(listener).normalized(); // arrives from the edge direction

    Some(Tap {
        delay: detour / SPEED_OF_SOUND,
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
    fn diffracted_path_is_longer_and_quieter_when_shadowed() {
        // Doorway edge along y; source on one side, listener around the corner.
        let edge = Edge { a: Vec3::new(0.0, 0.0, 0.0), b: Vec3::new(0.0, 3.0, 0.0) };
        let source = Vec3::new(-2.0, 1.5, 1.0);
        let listener = Vec3::new(2.0, 1.5, -1.0);
        let direct = source.dist(listener);
        let tap = diffract_tap(&edge, source, listener, direct).unwrap();
        // Bent path through the edge is longer than the straight line.
        assert!(tap.delay * SPEED_OF_SOUND >= direct - 1e-3);
        // And attenuated below unity.
        assert!(tap.band_gains[0] < 1.0);
        // Highs more attenuated than lows.
        assert!(tap.band_gains[NUM_BANDS - 1] < tap.band_gains[0]);
    }

    #[test]
    fn grazing_edge_is_barely_attenuated() {
        // Source and listener nearly collinear through the edge point: tiny excess.
        let edge = Edge { a: Vec3::new(0.0, -1.0, 0.0), b: Vec3::new(0.0, 1.0, 0.0) };
        let source = Vec3::new(-2.0, 0.0, 0.0);
        let listener = Vec3::new(2.0, 0.0, 0.0);
        let direct = source.dist(listener);
        let tap = diffract_tap(&edge, source, listener, direct).unwrap();
        // Edge point ~origin, detour ~= direct, so excess ~0 → near unity.
        assert!(tap.band_gains[0] > 0.9);
    }
}
