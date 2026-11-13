use serde::{Deserialize, Serialize};

/// Known Growtopia maladies that modify movement or jump behavior.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MaladyKind {
    ChickenFeet,
    Brainworms,
    Gemcuts,
    Grumbleteeth,
    BrokenHeart,
}

/// Active item/malady multipliers and abilities applied during physics simulation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CharacterModifiers {
    /// Multiplier applied to base walk_speed (1.0 = normal, >1.0 faster, <1.0 slower).
    pub speed_multiplier: f32,
    /// Multiplier applied to base jump_impulse magnitude (1.0 = normal).
    pub jump_multiplier: f32,
    /// Number of extra mid-air jumps allowed (0 = none, 1 = wings double jump).
    pub max_air_jumps: u8,
    /// Enables slow-fall / parasol gliding while holding Jump during descent.
    pub slow_fall: bool,
    /// Maximum downward speed (px/s) while slow-falling.
    pub slow_fall_max_vy: f32,
    /// Upward thrust acceleration reduction (px/s^2) while holding Jump during flight (jetpack high/long jump).
    pub air_thrust_accel: f32,
    /// Extra horizontal airborne speed multiplier while jetpack-thrusting (long jump).
    pub long_jump_speed_boost: f32,
    /// Active malady affecting movement/jump, if any.
    pub malady: Option<MaladyKind>,
    /// Punch damage per hit (6 bare-handed / default, 8 with Pickaxe / Punch Damage gear).
    pub punch_damage: u8,
    /// Punch reach radius in tiles (2 default, increased by Punch Range items / server state).
    pub punch_reach: u8,
    /// Build/place reach radius in tiles (2 default, increased by Build Range items / server state).
    pub build_reach: u8,
    /// Human-readable active gear & status effect labels.
    pub active_effects: Vec<String>,
}

impl Default for CharacterModifiers {
    fn default() -> Self {
        Self {
            speed_multiplier: 1.0,
            jump_multiplier: 1.0,
            max_air_jumps: 0,
            slow_fall: false,
            slow_fall_max_vy: 145.0,
            air_thrust_accel: 0.0,
            long_jump_speed_boost: 1.0,
            malady: None,
            punch_damage: 6,
            punch_reach: 2,
            build_reach: 2,
            active_effects: Vec::new(),
        }
    }
}

/// Physical configuration parameters for character movement.
#[derive(Debug, Clone, PartialEq)]
pub struct PhysicsConfig {
    /// World gravity in pixels/s^2 (default 1000.0, synced from SetCharacterState.vector_x2).
    pub gravity: f32,
    /// Maximum base horizontal movement speed in pixels/s (default 250.0, synced from SetCharacterState.vector_y2).
    pub walk_speed: f32,
    /// Hard upper bound on horizontal speed after gear buffs (prevents runaway velocity).
    pub max_walk_speed_cap: f32,
    /// Horizontal acceleration in pixels/s^2.
    pub acceleration: f32,
    /// Ground friction dampening factor per 60Hz tick (0.0 to 1.0).
    pub ground_friction: f32,
    /// Air resistance dampening factor per 60Hz tick.
    pub air_friction: f32,
    /// Jump impulse (initial vertical velocity, upward is negative).
    pub jump_impulse: f32,
    /// Extra upward deceleration (px/s^2) when Jump key is released early during ascent (variable jump height).
    pub jump_cut_decel: f32,
    /// Maximum downward falling speed (terminal velocity).
    pub terminal_velocity: f32,
    /// Hitbox width in pixels (Growtopia native colrect|0|0|20|30).
    pub hitbox_width: f32,
    /// Hitbox height in pixels (Growtopia native colrect|0|0|20|30).
    pub hitbox_height: f32,
    /// Hitbox horizontal offset from entity origin (0.0 matching Growtopia OnSpawn colrect).
    pub hitbox_offset_x: f32,
    /// Hitbox vertical offset from entity origin (0.0 matching Growtopia OnSpawn colrect).
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
            max_walk_speed_cap: 335.0,
            acceleration: 1200.0,
            ground_friction: 0.72,
            air_friction: 0.94,
            jump_impulse: -450.0,
            jump_cut_decel: 5000.0,
            terminal_velocity: 400.0,
            hitbox_width: 20.0,
            hitbox_height: 30.0,
            hitbox_offset_x: 0.0,
            hitbox_offset_y: 0.0,
            water_drag: 0.45,
            water_swim_impulse: -180.0,
            trampoline_bounce: 1.15,
        }
    }
}
