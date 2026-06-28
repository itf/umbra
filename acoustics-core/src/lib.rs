//! WASM-facing API for the acoustics core.
//!
//! We expose a flat `Float32Array` interface rather than rich objects: JS calls
//! `compute_shoebox_taps(...)` and gets back a packed array it can read without
//! per-tap allocation. Layout per tap (stride = TAP_STRIDE):
//!   [ delay, gain, dirx, diry, dirz, order, band0..band7 ]

mod diffraction;
mod geometry;
mod image_source;
mod vec3;

use diffraction::{diffract_tap, Edge};
use geometry::{Room, Wall};
use image_source::{compute_taps, Shoebox, ShoeboxMaterials, Tap, NUM_BANDS};
use vec3::Vec3;
use wasm_bindgen::prelude::*;

const TAP_HEADER: usize = 6; // delay, gain, dirx, diry, dirz, order
pub const TAP_STRIDE: usize = TAP_HEADER + NUM_BANDS;

/// Append one tap to a packed output buffer in TAP_STRIDE layout.
fn push_tap(out: &mut Vec<f32>, t: &Tap) {
    out.push(t.delay);
    out.push(t.gain);
    out.push(t.dir.x);
    out.push(t.dir.y);
    out.push(t.dir.z);
    out.push(t.order as f32);
    out.extend_from_slice(&t.band_gains);
}

#[wasm_bindgen]
pub fn tap_stride() -> usize {
    TAP_STRIDE
}

#[wasm_bindgen]
pub fn num_bands() -> usize {
    NUM_BANDS
}

/// Compute early-reflection taps for a shoebox room.
///
/// `room_size`: [x, y, z]
/// `absorption`: 6*NUM_BANDS flat array, wall-major (order: -x,+x,-y,+y,-z,+z)
/// `listener`/`source`: [x, y, z]
///
/// Returns a packed Float32Array (see module docs for layout).
#[wasm_bindgen]
pub fn compute_shoebox_taps(
    room_size: &[f32],
    absorption: &[f32],
    listener: &[f32],
    source: &[f32],
    max_order: u32,
) -> Vec<f32> {
    assert_eq!(room_size.len(), 3);
    assert_eq!(absorption.len(), 6 * NUM_BANDS);
    assert_eq!(listener.len(), 3);
    assert_eq!(source.len(), 3);

    let mut abs = [[0.0f32; NUM_BANDS]; 6];
    for w in 0..6 {
        for b in 0..NUM_BANDS {
            abs[w][b] = absorption[w * NUM_BANDS + b];
        }
    }

    let room = Shoebox {
        size: Vec3::new(room_size[0], room_size[1], room_size[2]),
        materials: ShoeboxMaterials { absorption: abs },
    };

    let taps = compute_taps(
        &room,
        Vec3::new(listener[0], listener[1], listener[2]),
        Vec3::new(source[0], source[1], source[2]),
        max_order,
    );

    let mut out = Vec::with_capacity(taps.len() * TAP_STRIDE);
    for t in &taps {
        push_tap(&mut out, t);
    }
    out
}

/// Compute taps for a GENERAL room of convex polygonal walls, plus optional
/// first-order edge diffraction.
///
/// Geometry is passed flat to avoid object marshalling:
///   `verts`:      all wall vertices, xyz triples, concatenated wall by wall
///   `wall_sizes`: number of vertices in each wall (sums to verts.len()/3)
///   `wall_abs`:   NUM_BANDS absorption values per wall, concatenated
///   `edges`:      optional diffracting edges as [ax,ay,az,bx,by,bz] sextuples
///                 (pass empty for none)
#[wasm_bindgen]
pub fn compute_room_taps(
    verts: &[f32],
    wall_sizes: &[u32],
    wall_abs: &[f32],
    edges: &[f32],
    listener: &[f32],
    source: &[f32],
    max_order: u32,
) -> Vec<f32> {
    assert_eq!(listener.len(), 3);
    assert_eq!(source.len(), 3);
    assert_eq!(wall_abs.len(), wall_sizes.len() * NUM_BANDS);
    assert_eq!(edges.len() % 6, 0);

    // Rebuild walls from the flat encoding.
    let mut walls = Vec::with_capacity(wall_sizes.len());
    let mut vi = 0usize;
    for (w, &count) in wall_sizes.iter().enumerate() {
        let mut vs = Vec::with_capacity(count as usize);
        for _ in 0..count {
            vs.push(Vec3::new(verts[vi * 3], verts[vi * 3 + 1], verts[vi * 3 + 2]));
            vi += 1;
        }
        let mut absb = [0.0f32; NUM_BANDS];
        for b in 0..NUM_BANDS {
            absb[b] = wall_abs[w * NUM_BANDS + b];
        }
        walls.push(Wall::new(vs, absb));
    }
    let room = Room::new(walls);

    let l = Vec3::new(listener[0], listener[1], listener[2]);
    let s = Vec3::new(source[0], source[1], source[2]);
    let taps = room.compute_taps(l, s, max_order);

    let mut out = Vec::with_capacity((taps.len() + edges.len() / 6) * TAP_STRIDE);
    for t in &taps {
        push_tap(&mut out, t);
    }

    // First-order diffraction over each provided edge.
    if !edges.is_empty() {
        let direct = l.dist(s);
        for e in edges.chunks_exact(6) {
            let edge = Edge {
                a: Vec3::new(e[0], e[1], e[2]),
                b: Vec3::new(e[3], e[4], e[5]),
            };
            if let Some(t) = diffract_tap(&edge, s, l, direct) {
                push_tap(&mut out, &t);
            }
        }
    }

    out
}
