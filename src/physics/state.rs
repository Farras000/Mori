use crate::protocol::packet::PacketFlags;

/// Dynamic physical state of an entity in world pixel space.
#[derive(Debug, Clone, PartialEq)]
pub struct PhysicsState {
    /// World position in sub-pixels (x, y).
    pub pos: (f32, f32),
    /// Velocity vector in pixels/s (vx, vy).
    pub vel: (f32, f32),
    /// True if character is standing firmly on a solid surface or platform.
    pub on_ground: bool,
    /// True if submerged in a water or slime tile.
    pub in_water: bool,
    /// True if actively in upward flight of a jump arc.
    pub is_jumping: bool,
    /// True if facing left (controls visual orientation & packet flag).
    pub facing_left: bool,
    /// True if currently propelled by a trampoline / pinball bumper.
    pub trampoline: bool,
    /// True if sliding on ice or low-friction surface.
    pub sliding: bool,
}

impl Default for PhysicsState {
    fn default() -> Self {
        Self {
            pos: (0.0, 0.0),
            vel: (0.0, 0.0),
            on_ground: true,
            in_water: false,
            is_jumping: false,
            facing_left: false,
            trampoline: false,
            sliding: false,
        }
    }
}

impl PhysicsState {
    pub fn new(x: f32, y: f32) -> Self {
        Self {
            pos: (x, y),
            ..Default::default()
        }
    }

    /// Convert the current physical state into Growtopia GameUpdatePacket flags.
    pub fn to_packet_flags(&self) -> PacketFlags {
        let mut flags = PacketFlags::empty();

        if self.on_ground {
            flags |= PacketFlags::STANDING;
        }

        if self.vel.0.abs() > 5.0 {
            flags |= PacketFlags::WALK;
        }

        if self.facing_left {
            flags |= PacketFlags::FACING_LEFT;
        }

        if self.is_jumping || (!self.on_ground && self.vel.1 < -20.0) {
            flags |= PacketFlags::JUMP;
        }

        if self.in_water {
            flags |= PacketFlags::SWIM;
        }

        if self.trampoline {
            flags |= PacketFlags::TRAMPOLINE;
        }

        if self.sliding {
            flags |= PacketFlags::SLIDE;
        }

        flags
    }
}
