//! General (non-shoebox) room geometry: convex polygonal walls, with the
//! mirror + visibility image-source search. This follows the standard approach
//! used by pyroomacoustics: for each candidate image (source reflected across a
//! sequence of wall planes), reconstruct the reflection path and validate that
//! every bounce actually lands inside its wall and isn't occluded.
//!
//! Cost is exponential in reflection order (walls^order candidates), so order is
//! kept low (1–3). Visibility is the expensive part; we keep walls convex so the
//! in-polygon test is a cheap same-side check.

use crate::image_source::{Tap, NUM_BANDS};
#[cfg(test)]
use crate::image_source::SPEED_OF_SOUND;
use crate::vec3::Vec3;

/// A convex polygon wall lying on a plane, with per-band absorption.
pub struct Wall {
    pub verts: Vec<Vec3>,
    pub normal: Vec3, // unit, points into the room
    pub absorption: [f32; NUM_BANDS],
    /// If true, the wall reflects from BOTH faces (an interior wall / free-standing
    /// panel is exposed on both sides). If false (the default), only the normal
    /// side reflects (a perimeter wall, where you're always on the inside).
    pub double_sided: bool,
}

impl Wall {
    pub fn new(verts: Vec<Vec3>, absorption: [f32; NUM_BANDS]) -> Wall {
        // Normal from the first three vertices (assumed planar, CCW seen from room).
        let n = verts[1].sub(verts[0]).cross(verts[2].sub(verts[0])).normalized();
        Wall { verts, normal: n, absorption, double_sided: false }
    }

    /// Like `new`, but the wall reflects from both faces.
    pub fn new_double_sided(verts: Vec<Vec3>, absorption: [f32; NUM_BANDS]) -> Wall {
        let mut w = Wall::new(verts, absorption);
        w.double_sided = true;
        w
    }

    /// Signed distance from a point to the wall's plane (positive on normal side).
    fn signed_dist(&self, p: Vec3) -> f32 {
        p.sub(self.verts[0]).dot(self.normal)
    }

    /// Mirror a point across this wall's (infinite) plane.
    fn mirror(&self, p: Vec3) -> Vec3 {
        let d = self.signed_dist(p);
        p.sub(self.normal.scale(2.0 * d))
    }

    /// Ray (origin→target) intersection with the wall plane; returns the point and
    /// parameter t along the segment if it lies within [0,1] and inside the polygon.
    fn segment_hit(&self, a: Vec3, b: Vec3) -> Option<Vec3> {
        let denom = b.sub(a).dot(self.normal);
        if denom.abs() < 1e-9 {
            return None; // parallel
        }
        let t = self.verts[0].sub(a).dot(self.normal) / denom;
        if t <= 1e-5 || t >= 1.0 - 1e-5 {
            return None; // intersection not strictly between a and b
        }
        let hit = a.lerp(b, t);
        if self.contains(hit) {
            Some(hit)
        } else {
            None
        }
    }

    /// Convex-polygon containment: the point (assumed on the plane) is inside if
    /// it's on the same side of every edge.
    fn contains(&self, p: Vec3) -> bool {
        let n = self.verts.len();
        let mut sign = 0.0f32;
        for i in 0..n {
            let a = self.verts[i];
            let b = self.verts[(i + 1) % n];
            let edge = b.sub(a);
            let to_p = p.sub(a);
            let c = edge.cross(to_p).dot(self.normal);
            if c.abs() < 1e-6 {
                continue;
            }
            if sign == 0.0 {
                sign = c.signum();
            } else if c.signum() != sign {
                return false;
            }
        }
        true
    }
}

/// Energy-pruning audibility floor for the image-source candidate search.
///
/// As we descend wall-chains, we accumulate each chain's broadband reflection
/// gain (product of per-wall reflection coefficients, see `wall_reflectivity`).
/// Once a chain's accumulated gain falls below this threshold it is INAUDIBLE —
/// no descendant can be louder (each further bounce only multiplies by ≤1) — so
/// we prune the entire subtree: we neither validate its tap nor push it onto the
/// search stack. This is what makes high reflection order affordable: absorbent
/// materials kill deep chains quickly, collapsing the `walls^order` explosion,
/// while low-absorption surfaces (concrete/marble) keep deep chains alive exactly
/// as long as they remain audible.
///
/// 1e-3 ≈ -60 dB of reflection gain. The threshold is deliberately conservative:
/// it gates ONLY the material reflection product (not the 1/r distance term), and
/// it uses the MAX over bands of the per-wall reflection coefficient (see
/// `wall_reflectivity`), so a wall that is reflective in ANY band is treated as
/// fully reflective for pruning purposes. Both choices ensure we never prune a
/// path that is still audible in some band. At order 1–2 with typical materials
/// nothing audible is pruned, so low-order results are byte-identical to before.
const ENERGY_THRESHOLD: f32 = 1e-3;

/// A wall's representative broadband reflection coefficient for energy pruning:
/// the MAX over bands of `(1 - absorption[b])`. Using the max (rather than the
/// mean) is the conservative choice — a wall that reflects strongly in any single
/// band counts as fully reflective, so pruning never culls a path that is still
/// audible in some band. Result is clamped to [0, 1].
fn wall_reflectivity(wall: &Wall) -> f32 {
    let mut r = 0.0f32;
    for b in 0..NUM_BANDS {
        r = r.max((1.0 - wall.absorption[b]).max(0.0));
    }
    r.min(1.0)
}

pub struct Room {
    pub walls: Vec<Wall>,
}

impl Room {
    /// Build a room, orienting every wall's normal to point toward the geometric
    /// centroid of all wall vertices (i.e. into the room). This frees callers
    /// from getting vertex winding right per wall.
    pub fn new(mut walls: Vec<Wall>) -> Room {
        let mut sum = Vec3::new(0.0, 0.0, 0.0);
        let mut count: f32 = 0.0;
        for w in &walls {
            for v in &w.verts {
                sum = sum.add(*v);
                count += 1.0;
            }
        }
        let centroid = sum.scale(1.0 / count.max(1.0));
        for w in &mut walls {
            // Double-sided walls reflect from both faces, so the normal's direction
            // is immaterial — leave it as authored (don't force it toward the
            // centroid, which for a coincident/interior wall is meaningless).
            if !w.double_sided && w.signed_dist(centroid) < 0.0 {
                w.normal = w.normal.scale(-1.0);
            }
        }
        Room { walls }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build an axis-aligned box room from 6 rectangular walls (normals inward),
    /// so we can cross-check the general solver against the closed-form shoebox.
    pub(super) fn box_room(sx: f32, sy: f32, sz: f32) -> Room {
        let a = [0.0; NUM_BANDS]; // rigid
        let v = |x: f32, y: f32, z: f32| Vec3::new(x, y, z);
        // Each wall's verts ordered so cross(v1-v0, v2-v0) points INTO the room.
        let walls = vec![
            // -x wall (x=0), normal +x
            Wall::new(vec![v(0.0, 0.0, 0.0), v(0.0, 0.0, sz), v(0.0, sy, sz), v(0.0, sy, 0.0)], a),
            // +x wall (x=sx), normal -x
            Wall::new(vec![v(sx, 0.0, 0.0), v(sx, sy, 0.0), v(sx, sy, sz), v(sx, 0.0, sz)], a),
            // -y (floor y=0), normal +y
            Wall::new(vec![v(0.0, 0.0, 0.0), v(sx, 0.0, 0.0), v(sx, 0.0, sz), v(0.0, 0.0, sz)], a),
            // +y (ceil y=sy), normal -y
            Wall::new(vec![v(0.0, sy, 0.0), v(0.0, sy, sz), v(sx, sy, sz), v(sx, sy, 0.0)], a),
            // -z (z=0), normal +z
            Wall::new(vec![v(0.0, 0.0, 0.0), v(0.0, sy, 0.0), v(sx, sy, 0.0), v(sx, 0.0, 0.0)], a),
            // +z (z=sz), normal -z
            Wall::new(vec![v(0.0, 0.0, sz), v(sx, 0.0, sz), v(sx, sy, sz), v(0.0, sy, sz)], a),
        ];
        Room::new(walls)
    }

    #[test]
    fn wall_normals_point_inward() {
        let room = box_room(8.0, 3.0, 10.0);
        let center = Vec3::new(4.0, 1.5, 5.0);
        for w in &room.walls {
            // Center should be on the positive (normal) side of every wall.
            assert!(w.signed_dist(center) > 0.0, "normal points outward");
        }
    }

    #[test]
    fn double_sided_wall_reflects_from_both_faces() {
        // A divider on the z=4 plane inside an 8x3x16 room. The room's vertex
        // centroid sits at z>4 (the larger side), so a SINGLE-sided divider's normal
        // is forced toward +z and its -z (small-side) face is dead. A listener on
        // that small side (z=2) should get NO near echo from the divider when it's
        // single-sided, but SHOULD when it's double-sided (round trip 2*2=4m).
        let a = [0.0; NUM_BANDS];
        let v = |x: f32, y: f32, z: f32| Vec3::new(x, y, z);
        let divider = || vec![v(0.0, 0.0, 4.0), v(8.0, 0.0, 4.0), v(8.0, 3.0, 4.0), v(0.0, 3.0, 4.0)];
        let mut single_walls = box_room(8.0, 3.0, 16.0).walls;
        single_walls.push(Wall::new(divider(), a));
        let single = Room::new(single_walls);

        let mut double_walls = box_room(8.0, 3.0, 16.0).walls;
        double_walls.push(Wall::new_double_sided(divider(), a));
        let double = Room::new(double_walls);

        let l = Vec3::new(4.0, 1.5, 2.0); // small side
        // The near divider echo: arrives from +z, round trip 2*(4-2)=4m.
        let near = |room: &Room| -> Vec<f32> {
            room.compute_taps(l, l, 1, SPEED_OF_SOUND)
                .into_iter()
                .filter(|t| t.order >= 1 && t.dir.z > 0.5 && t.delay < 0.02)
                .map(|t| t.delay)
                .collect()
        };
        assert!(near(&single).is_empty(), "single-sided back face must be dead");
        let d = near(&double);
        assert_eq!(d.len(), 1, "double-sided echoes exactly once (no double-count)");
        assert!((d[0] - 4.0 / SPEED_OF_SOUND).abs() < 1e-4, "4m round trip");
    }

    /// Build a box room with uniform per-band absorption on every wall.
    fn box_room_absorptive(sx: f32, sy: f32, sz: f32, alpha: f32) -> Room {
        let mut room = box_room(sx, sy, sz);
        for w in &mut room.walls {
            w.absorption = [alpha; NUM_BANDS];
        }
        room
    }

    #[test]
    fn energy_pruning_culls_absorptive_high_order_chains() {
        // Same geometry, high max_order. A highly ABSORPTIVE room (acoustic-foam-
        // like, alpha=0.9 → reflectivity 0.1 per bounce) drops below the -60 dB
        // audibility floor within ~3 bounces, so deep chains are pruned and it
        // returns FEWER taps than the RIGID (alpha=0) version, whose loud chains
        // survive to full order.
        let p = Vec3::new(4.0, 1.5, 5.0);
        let rigid = box_room_absorptive(8.0, 3.0, 10.0, 0.0);
        let foam = box_room_absorptive(8.0, 3.0, 10.0, 0.9);
        let order = 6;
        let rigid_taps = rigid.compute_taps(p, p, order, SPEED_OF_SOUND);
        let foam_taps = foam.compute_taps(p, p, order, SPEED_OF_SOUND);
        assert!(
            foam_taps.len() < rigid_taps.len(),
            "absorptive room must prune deep chains: foam={} rigid={}",
            foam_taps.len(),
            rigid_taps.len()
        );
    }

    #[test]
    fn energy_pruning_leaves_low_order_unchanged() {
        // The audibility floor must never cull a LOUD path. A rigid box's direct +
        // first-order counts are exactly as before pruning (1 direct, 6 first-order).
        let room = box_room(8.0, 3.0, 10.0);
        let l = Vec3::new(4.0, 1.5, 5.0);
        let s = Vec3::new(4.0, 1.5, 2.0);
        let direct = room.compute_taps(l, s, 0, SPEED_OF_SOUND);
        assert_eq!(direct.len(), 1, "direct path unchanged");

        let p = Vec3::new(4.0, 1.5, 5.0);
        let first = room.compute_taps(p, p, 1, SPEED_OF_SOUND);
        let first_order = first.iter().filter(|t| t.order == 1).count();
        assert_eq!(first_order, 6, "all 6 first-order reflections survive pruning");

        // Even a moderately absorptive room keeps every first-order reflection
        // (one bounce at alpha=0.5 → 0.5 gain, well above 1e-3).
        let absorptive = box_room_absorptive(8.0, 3.0, 10.0, 0.5);
        let af = absorptive.compute_taps(p, p, 1, SPEED_OF_SOUND);
        assert_eq!(
            af.iter().filter(|t| t.order == 1).count(),
            6,
            "first-order paths are audible and must not be pruned"
        );
    }

    #[test]
    fn direct_path_present_and_correct() {
        let room = box_room(8.0, 3.0, 10.0);
        let l = Vec3::new(4.0, 1.5, 5.0);
        let s = Vec3::new(4.0, 1.5, 2.0); // 3m ahead
        let taps = room.compute_taps(l, s, 0, SPEED_OF_SOUND);
        assert_eq!(taps.len(), 1);
        assert!((taps[0].delay - 3.0 / SPEED_OF_SOUND).abs() < 1e-5);
    }

    #[test]
    fn first_order_reflections_match_shoebox_floor() {
        // Listener=source at center; the floor reflection round-trips 2*1.5=3m.
        let room = box_room(8.0, 3.0, 10.0);
        let p = Vec3::new(4.0, 1.5, 5.0);
        let taps = room.compute_taps(p, p, 1, SPEED_OF_SOUND);
        let floor = 3.0 / SPEED_OF_SOUND;
        let has_floor = taps.iter().any(|t| (t.delay - floor).abs() < 1e-4);
        assert!(has_floor, "expected floor reflection at 3m round-trip");
        // Should find exactly the 6 first-order wall reflections (degenerate direct
        // path at dist 0 is dropped by visibility/length).
        let first_order = taps.iter().filter(|t| t.order == 1).count();
        assert_eq!(first_order, 6, "a box has 6 first-order reflections");
    }
}

impl Room {
    /// Is the straight segment a→b unobstructed by any wall (excluding the wall
    /// indices in `ignore`, which are the ones the path legitimately reflects off)?
    fn visible(&self, a: Vec3, b: Vec3, ignore: &[usize]) -> bool {
        for (i, w) in self.walls.iter().enumerate() {
            if ignore.contains(&i) {
                continue;
            }
            if w.segment_hit(a, b).is_some() {
                return false;
            }
        }
        true
    }

    /// Compute image-source taps up to `max_order` for a general room.
    pub fn compute_taps(
        &self,
        listener: Vec3,
        source: Vec3,
        max_order: u32,
        speed_of_sound: f32,
    ) -> Vec<Tap> {
        let mut taps = Vec::new();

        // Direct path.
        if self.visible(listener, source, &[]) {
            taps.push(self.make_tap(listener, source, &[], 0, speed_of_sound));
        }

        // Reflections: recursively reflect the source across walls.
        // State carries the current image position, the chain of wall indices, and
        // the chain's accumulated broadband reflection gain (product of per-wall
        // reflectivities) used for ENERGY PRUNING — see `ENERGY_THRESHOLD`.
        let mut stack: Vec<(Vec3, Vec<usize>, f32)> = vec![(source, Vec::new(), 1.0)];
        while let Some((img, chain, gain)) = stack.pop() {
            if chain.len() as u32 >= max_order {
                continue;
            }
            for (i, wall) in self.walls.iter().enumerate() {
                if chain.last() == Some(&i) {
                    continue; // can't reflect off the same wall twice in a row
                }
                // Reflect across a wall the image is in front of. A single-sided
                // wall reflects only from its normal face; a double-sided wall
                // reflects from EITHER face (interior walls / panels are exposed on
                // both sides), so any image off the plane qualifies.
                let sd = wall.signed_dist(img);
                if wall.double_sided {
                    if sd.abs() <= 1e-4 {
                        continue; // image lies on the plane — degenerate
                    }
                } else if sd <= 1e-4 {
                    continue; // behind the (single) face
                }
                // ENERGY PRUNING: accumulate this child chain's reflection gain. If
                // it has fallen below the audibility floor, prune the whole subtree —
                // skip validating its tap AND don't descend (no descendant can be
                // louder, since each further bounce multiplies by a coefficient ≤1).
                let child_gain = gain * wall_reflectivity(wall);
                if child_gain < ENERGY_THRESHOLD {
                    continue;
                }

                let new_img = wall.mirror(img);
                let mut new_chain = chain.clone();
                new_chain.push(i);

                if let Some(tap) = self.validate_path(listener, source, &new_chain, speed_of_sound) {
                    taps.push(tap);
                }
                stack.push((new_img, new_chain, child_gain));
            }
        }

        taps.sort_by(|a, b| a.delay.partial_cmp(&b.delay).unwrap());
        taps
    }

    /// Reconstruct and validate the reflection path for a wall chain. Walk the
    /// image back through each wall, checking each reflection point lands inside
    /// its wall and each segment is unobstructed.
    fn validate_path(
        &self,
        listener: Vec3,
        source: Vec3,
        chain: &[usize],
        speed_of_sound: f32,
    ) -> Option<Tap> {
        // Precompute images: img[k] = source mirrored across walls chain[0..k].
        // img[0] = source, img[chain.len()] = full image seen by the listener.
        let n = chain.len();
        let mut images: Vec<Vec3> = Vec::with_capacity(n + 1);
        images.push(source);
        let mut cur = source;
        for &wi in chain {
            cur = self.walls[wi].mirror(cur);
            images.push(cur);
        }

        // Trace from the listener toward the FULL image, peeling off walls in
        // reverse chain order. At bounce k (from last to first) the ray from the
        // running point aims at images[k] (the image of the source across the
        // already-resolved prefix) and must hit wall chain[k] inside its polygon.
        let mut points: Vec<Vec3> = Vec::with_capacity(n + 2);
        points.push(listener);
        let mut from = listener;
        for k in (0..n).rev() {
            let wall = &self.walls[chain[k]];
            // Reflection k is found by aiming the running point at images[k+1]
            // (the source reflected across chain[0..=k]) and intersecting wall
            // chain[k]. images[n] is the full image the listener sees.
            let hit = wall.segment_hit(from, images[k + 1])?;
            points.push(hit);
            from = hit;
        }
        points.push(source);

        // Each segment must be unobstructed by other walls.
        for w in points.windows(2) {
            if !self.visible(w[0], w[1], chain) {
                return None;
            }
        }

        Some(self.make_tap_path(&points, chain, speed_of_sound))
    }

    fn make_tap(
        &self,
        listener: Vec3,
        source: Vec3,
        chain: &[usize],
        order: u32,
        speed_of_sound: f32,
    ) -> Tap {
        let dir = source.sub(listener);
        let dist = dir.len().max(1e-4);
        let mut band_gains = [1.0f32; NUM_BANDS];
        for &wi in chain {
            for b in 0..NUM_BANDS {
                band_gains[b] *= (1.0 - self.walls[wi].absorption[b]).max(0.0);
            }
        }
        Tap {
            delay: dist / speed_of_sound,
            gain: 1.0 / dist.max(1.0),
            band_gains,
            dir: dir.normalized(),
            order,
        }
    }

    fn make_tap_path(&self, points: &[Vec3], chain: &[usize], speed_of_sound: f32) -> Tap {
        // Total path length = sum of segment lengths.
        let mut dist = 0.0;
        for w in points.windows(2) {
            dist += w[0].dist(w[1]);
        }
        dist = dist.max(1e-4);
        // Arrival direction = from listener toward the first reflection point.
        let dir = points[1].sub(points[0]).normalized();
        let mut band_gains = [1.0f32; NUM_BANDS];
        for &wi in chain {
            for b in 0..NUM_BANDS {
                band_gains[b] *= (1.0 - self.walls[wi].absorption[b]).max(0.0);
            }
        }
        Tap {
            delay: dist / speed_of_sound,
            gain: 1.0 / dist.max(1.0),
            band_gains,
            dir,
            order: chain.len() as u32,
        }
    }
}
