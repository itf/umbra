//! Image-source method for early reflections in a shoebox (axis-aligned box) room.
//!
//! For an axis-aligned box, the image-source positions have a closed form: mirror
//! the source across each of the 6 wall planes, recursively, up to `max_order`.
//! Every reflection path is guaranteed valid (no occlusion test needed) for a
//! convex empty box, which makes this both exact and cheap — ideal for real-time
//! and for baking. Non-box geometry / interior objects come later via a general
//! mirror+visibility search.
//!
//! Each returned `Tap` carries: arrival delay, broadband gain, per-band gains
//! (frequency-dependent material absorption + air absorption), and arrival
//! direction relative to the listener — which the JS HRTF layer convolves.

use crate::vec3::Vec3;

pub const NUM_BANDS: usize = 8; // octave-ish bands, ~63Hz..16kHz
pub const SPEED_OF_SOUND: f32 = 343.0; // m/s at ~20C

/// Per-wall absorption: fraction of energy absorbed per band (0=reflective, 1=dead).
/// Order of walls: [-x, +x, -y, +y, -z, +z].
#[derive(Clone, Copy)]
pub struct ShoeboxMaterials {
    pub absorption: [[f32; NUM_BANDS]; 6],
}

pub struct Shoebox {
    /// Room spans [0,size.x] x [0,size.y] x [0,size.z].
    pub size: Vec3,
    pub materials: ShoeboxMaterials,
}

#[derive(Clone, Copy, Debug)]
pub struct Tap {
    pub delay: f32,             // seconds
    pub gain: f32,              // broadband 1/r attenuation
    pub band_gains: [f32; NUM_BANDS],
    pub dir: Vec3,              // unit vector from listener toward the (image) source
    pub order: u32,
}

/// Reflect a coordinate across a sequence of parallel walls using the standard
/// 1D image-source unfolding. For axis position `p` in room of length `L`,
/// the n-th image along that axis is at one of: 2*k*L ± p.
/// We instead enumerate per-axis reflection counts and build the mirrored point.
fn mirror_1d(p: f32, l: f32, n: i32) -> f32 {
    // Closed-form image position along one axis after |n| reflections.
    // Even n: the room is translated by n*L, point keeps its offset p.
    // Odd n: the room is flipped, so the offset becomes (L - p).
    if n & 1 == 0 {
        (n as f32) * l + p
    } else {
        (n as f32) * l + (l - p)
    }
}

/// Which walls were hit along one axis, for absorption bookkeeping.
/// Along axis with reflection index n, the path alternately hits the two walls.
/// We approximate band absorption by applying each wall's absorption once per
/// reflection it contributes (count split between the two walls).
fn axis_reflection_counts(n: i32) -> (u32, u32) {
    // returns (hits_on_minus_wall, hits_on_plus_wall)
    let total = n.unsigned_abs();
    if total == 0 {
        return (0, 0);
    }
    // Starting direction toward +wall (n>0) or -wall (n<0); walls alternate.
    let first_plus = n > 0;
    let mut plus = 0;
    let mut minus = 0;
    for i in 0..total {
        let hit_plus = if first_plus { i % 2 == 0 } else { i % 2 == 1 };
        if hit_plus {
            plus += 1;
        } else {
            minus += 1;
        }
    }
    (minus, plus)
}

pub fn compute_taps(
    room: &Shoebox,
    listener: Vec3,
    source: Vec3,
    max_order: u32,
    speed_of_sound: f32,
) -> Vec<Tap> {
    let mut taps = Vec::new();
    let max_n = max_order as i32;

    for nx in -max_n..=max_n {
        for ny in -max_n..=max_n {
            for nz in -max_n..=max_n {
                let order = nx.unsigned_abs() + ny.unsigned_abs() + nz.unsigned_abs();
                if order > max_order {
                    continue;
                }

                let ix = mirror_1d(source.x, room.size.x, nx);
                let iy = mirror_1d(source.y, room.size.y, ny);
                let iz = mirror_1d(source.z, room.size.z, nz);
                let image = Vec3::new(ix, iy, iz);

                let to_image = image.sub(listener);
                let dist = to_image.len();
                if dist < 1e-4 {
                    continue;
                }

                let delay = dist / speed_of_sound;
                let gain = 1.0 / dist.max(1.0); // 1/r, clamped to avoid huge near-field gain

                // Material absorption: multiply (1 - alpha) for each wall reflection.
                let mut band_gains = [1.0f32; NUM_BANDS];
                let (xm, xp) = axis_reflection_counts(nx);
                let (ym, yp) = axis_reflection_counts(ny);
                let (zm, zp) = axis_reflection_counts(nz);
                let wall_hits = [xm, xp, ym, yp, zm, zp];

                for (wall, &hits) in wall_hits.iter().enumerate() {
                    if hits == 0 {
                        continue;
                    }
                    for b in 0..NUM_BANDS {
                        let refl = (1.0 - room.materials.absorption[wall][b]).max(0.0);
                        band_gains[b] *= refl.powi(hits as i32);
                    }
                }

                // Air absorption: gentle high-frequency rolloff with distance.
                apply_air_absorption(&mut band_gains, dist);

                taps.push(Tap {
                    delay,
                    gain,
                    band_gains,
                    dir: to_image.normalized(),
                    order,
                });
            }
        }
    }

    // Direct path (order 0) is included above at nx=ny=nz=0.
    taps.sort_by(|a, b| a.delay.partial_cmp(&b.delay).unwrap());
    taps
}

/// Crude per-band air absorption: higher bands lose more energy over distance.
/// Coefficients are illustrative (dB/m rising with frequency), good enough to
/// make distant reflections sound duller — a real distance cue.
fn apply_air_absorption(band_gains: &mut [f32; NUM_BANDS], dist: f32) {
    // dB/m per band, roughly increasing with frequency.
    const DB_PER_M: [f32; NUM_BANDS] =
        [0.0002, 0.0005, 0.001, 0.002, 0.004, 0.01, 0.03, 0.08];
    for b in 0..NUM_BANDS {
        let db = DB_PER_M[b] * dist;
        let lin = 10f32.powf(-db / 20.0);
        band_gains[b] *= lin;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rigid_room(size: Vec3) -> Shoebox {
        Shoebox {
            size,
            materials: ShoeboxMaterials {
                absorption: [[0.0; NUM_BANDS]; 6], // perfectly reflective
            },
        }
    }

    #[test]
    fn direct_path_delay_matches_distance() {
        let room = rigid_room(Vec3::new(10.0, 3.0, 10.0));
        let listener = Vec3::new(5.0, 1.5, 5.0);
        let source = Vec3::new(5.0, 1.5, 2.0); // 3m straight ahead (-z)
        let taps = compute_taps(&room, listener, source, 0, SPEED_OF_SOUND);
        assert_eq!(taps.len(), 1);
        let expected = 3.0 / SPEED_OF_SOUND;
        assert!((taps[0].delay - expected).abs() < 1e-5, "{}", taps[0].delay);
    }

    #[test]
    fn first_reflection_delay_is_round_trip_to_wall() {
        // Listener and source colocated against geometry: easiest to reason about
        // the floor reflection. Room 10x4x10, listener+source at center height 2.
        let room = rigid_room(Vec3::new(10.0, 4.0, 10.0));
        let p = Vec3::new(5.0, 2.0, 5.0);
        let taps = compute_taps(&room, p, p, 1, SPEED_OF_SOUND);
        // Direct path is distance 0 -> skipped (dist<1e-4). The 6 first-order
        // reflections are each a mirror across one wall. Floor (-y) image is at
        // y = -2, distance = 4 => delay = 4/c. Ceiling (+y) image at y=6 => also 4.
        let floor_delay = 4.0 / SPEED_OF_SOUND;
        let has_floor = taps
            .iter()
            .any(|t| (t.delay - floor_delay).abs() < 1e-5);
        assert!(has_floor, "expected a 4m round-trip reflection");
    }

    #[test]
    fn glass_reflects_brighter_than_carpet() {
        // Compare high-band reflected energy: low absorption (glass) vs high (carpet).
        let mut glass = rigid_room(Vec3::new(8.0, 3.0, 8.0));
        let mut carpet = rigid_room(Vec3::new(8.0, 3.0, 8.0));
        // Set the +x wall: glass ~0.03 HF absorption, carpet ~0.6 HF absorption.
        for b in 0..NUM_BANDS {
            glass.materials.absorption[1][b] = 0.03;
            carpet.materials.absorption[1][b] = 0.6;
        }
        let listener = Vec3::new(2.0, 1.5, 4.0);
        let source = Vec3::new(2.0, 1.5, 4.0);
        let g = compute_taps(&glass, listener, source, 1, SPEED_OF_SOUND);
        let c = compute_taps(&carpet, listener, source, 1, SPEED_OF_SOUND);
        // The +x wall reflection: image at x = 2*8 - 2 = 14, dist 12.
        let pick = |taps: &Vec<Tap>| {
            taps.iter()
                .filter(|t| t.order == 1 && t.dir.x > 0.5)
                .map(|t| t.band_gains[NUM_BANDS - 1])
                .next()
                .unwrap()
        };
        assert!(pick(&g) > pick(&c), "glass should reflect more HF energy");
    }

    #[test]
    fn doubling_speed_of_sound_halves_delay() {
        let room = rigid_room(Vec3::new(10.0, 3.0, 10.0));
        let listener = Vec3::new(5.0, 1.5, 5.0);
        let source = Vec3::new(5.0, 1.5, 2.0); // 3m ahead
        let base = compute_taps(&room, listener, source, 0, SPEED_OF_SOUND);
        let fast = compute_taps(&room, listener, source, 0, SPEED_OF_SOUND * 2.0);
        assert_eq!(base.len(), 1);
        assert_eq!(fast.len(), 1);
        assert!((fast[0].delay - base[0].delay / 2.0).abs() < 1e-7, "{}", fast[0].delay);
    }
}
