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
    /// Number of mid-air double jumps consumed since leaving ground.
    pub air_jumps_used: u8,
    /// Previous tick jump input state for edge-triggered double jumps.
    pub prev_jump_held: bool,
    /// True while descending under Slow Fall / Parasol drag.
    pub slow_falling: bool,
    /// Elapsed seconds of sustained airborne jetpack thrust in the current jump.
    pub jetpack_thrust_timer: f32,
    /// One-shot pulse emitted on the tick a jump or trampoline bounce begins.
    /// Consumed once when building a State movement packet so holding Jump does
    /// not transmit repeated PacketFlags::JUMP packets while airborne.
    pub jump_pulse: bool,
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
            air_jumps_used: 0,
            prev_jump_held: false,
            slow_falling: false,
            jetpack_thrust_timer: 0.0,
            jump_pulse: false,
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

        if self.jump_pulse {
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

        if self.slow_falling {
            flags |= PacketFlags::PARASOL;
        }

        flags
    }

    /// Serialize movement flags for a network State packet and clear the one-shot `jump_pulse`.
    pub fn consume_packet_flags(&mut self) -> PacketFlags {
        let flags = self.to_packet_flags();
        self.jump_pulse = false;
        flags
    }

    /// Serialize movement context flags for punch/place action packets without emitting or
    /// consuming a jump pulse.
    pub fn to_action_packet_flags(&self) -> PacketFlags {
        let mut flags = self.to_packet_flags();
        flags.remove(PacketFlags::JUMP);
        flags
    }
}
