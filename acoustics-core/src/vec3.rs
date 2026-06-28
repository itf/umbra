//! Minimal 3D vector math. Coordinate convention matches Web Audio's listener
//! space: +x right, +y up, -z forward (into the screen / ahead of the listener).
//!
//! Some helpers are unused until the general (non-shoebox) acoustics path lands.
#![allow(dead_code)]

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Vec3 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

impl Vec3 {
    pub const fn new(x: f32, y: f32, z: f32) -> Self {
        Vec3 { x, y, z }
    }

    pub fn sub(self, o: Vec3) -> Vec3 {
        Vec3::new(self.x - o.x, self.y - o.y, self.z - o.z)
    }

    pub fn add(self, o: Vec3) -> Vec3 {
        Vec3::new(self.x + o.x, self.y + o.y, self.z + o.z)
    }

    pub fn scale(self, s: f32) -> Vec3 {
        Vec3::new(self.x * s, self.y * s, self.z * s)
    }

    pub fn dot(self, o: Vec3) -> f32 {
        self.x * o.x + self.y * o.y + self.z * o.z
    }

    pub fn len(self) -> f32 {
        self.dot(self).sqrt()
    }

    pub fn dist(self, o: Vec3) -> f32 {
        self.sub(o).len()
    }

    pub fn normalized(self) -> Vec3 {
        let l = self.len();
        if l > 1e-9 {
            self.scale(1.0 / l)
        } else {
            self
        }
    }

    pub fn cross(self, o: Vec3) -> Vec3 {
        Vec3::new(
            self.y * o.z - self.z * o.y,
            self.z * o.x - self.x * o.z,
            self.x * o.y - self.y * o.x,
        )
    }

    pub fn lerp(self, o: Vec3, t: f32) -> Vec3 {
        self.add(o.sub(self).scale(t))
    }
}
