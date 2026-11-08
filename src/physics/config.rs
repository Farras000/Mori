/// Physical configuration parameters for character movement.
#[derive(Debug, Clone, PartialEq)]
pub struct PhysicsConfig {
    /// World gravity in pixels/s^2 (default 1000.0, synced from SetCharacterState.vector_x2).
    pub gravity: f32,
    /// Maximum base horizontal movement speed in pixels/s (default 250.0, synced from SetCharacterState.vector_y2).
    pub walk_speed: f32,
    /// Horizontal acceleration in pixels/s^2.
    pub acceleration: f32,
    /// Ground friction dampening factor per tick (0.0 to 1.0).
    pub ground_friction: f32,
    /// Air resistance dampening factor per tick.
    pub air_friction: f32,
    /// Jump impulse (initial vertical velocity, upward is negative).
    pub jump_impulse: f32,
    /// Maximum downward falling speed (terminal velocity).
    pub terminal_velocity: f32,
    /// Hitbox width in pixels (centered horizontally in 32px tile).
    pub hitbox_width: f32,
    /// Hitbox height in pixels.
    pub hitbox_height: f32,
    /// Hitbox horizontal offset from tile left edge.
    pub hitbox_offset_x: f32,
    /// Hitbox vertical offset from tile top edge.
    pub hitbox_offset_y: f32,
    /// Water viscosity drag multiplier.
    pub water_drag: f32,
    /// Water upward swimming impulse.
    pub water_swim_impulse: f32,
    /// Trampoline bounce multiplier.
    pub trampoline_bounce: f32,
}

impl Default for PhysicsConfig {
    fn default() -> Self {
        Self {
            gravity: 1000.0,
            walk_speed: 250.0,
            acceleration: 2400.0,
            ground_friction: 0.82,
            air_friction: 0.94,
            jump_impulse: -440.0,
            terminal_velocity: 1000.0,
            hitbox_width: 20.0,
            hitbox_height: 30.0,
            hitbox_offset_x: 6.0,
            hitbox_offset_y: 2.0,
            water_drag: 0.45,
            water_swim_impulse: -180.0,
            trampoline_bounce: 1.15,
        }
    }
}
