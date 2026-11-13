use std::collections::HashMap;
use crate::physics::{CharacterModifiers, MaladyKind, PhysicsConfig, PhysicsState};

/// The bot's own identity in the current world.
#[derive(Debug, Clone)]
pub struct LocalPlayer {
    pub net_id:       u32,
    pub user_id:      u32,
    /// From SetCharacterState: value (net_id to echo in ping reply).
    pub hack_type:    u32,
    /// From SetCharacterState: jump_count - 126 (tile X position).
    pub build_length: u8,
    /// From SetCharacterState: animation_type - 126 (tile Y position).
    pub punch_length: u8,
    /// From SetCharacterState: vector_x2 (gravity).
    pub gravity:      f32,
    /// From SetCharacterState: vector_y2 (velocity).
    pub velocity:     f32,
    /// Server-enforced gravity override (validated from SetCharacterState).
    pub server_gravity: f32,
    /// Server-enforced walk speed override (validated from SetCharacterState).
    pub server_walk_speed: f32,
    /// Decoded SetCharacterState ability flags (NOT raw packet flags).
    pub char_state_flags: u32,
    /// Decoded ability flags from SetExtraMods (0x2D).
    pub extra_mods_bits: u32,
    /// Equipped item IDs across the 9 Growtopia slots:
    /// [hair, shirt, pants, feet, face, hand, back, mask, neck].
    pub equipped_clothes: [u32; 9],
    /// Active Growtopia malady affecting movement/jump, if any.
    pub malady: Option<MaladyKind>,
    /// Active physics simulation state.
    pub physics:      PhysicsState,
    /// Active physics configuration parameters.
    pub physics_cfg:  PhysicsConfig,
    /// Resolved item/malady physics modifiers.
    pub physics_mods: CharacterModifiers,
}

impl Default for LocalPlayer {
    fn default() -> Self {
        Self {
            net_id: 0,
            user_id: 0,
            hack_type: 0,
            build_length: 0,
            punch_length: 0,
            gravity: 0.0,
            velocity: 0.0,
            server_gravity: 1000.0,
            server_walk_speed: 250.0,
            char_state_flags: 0,
            extra_mods_bits: 0,
            equipped_clothes: [0; 9],
            malady: None,
            physics: PhysicsState::default(),
            physics_cfg: PhysicsConfig::default(),
            physics_mods: CharacterModifiers::default(),
        }
    }
}

/// Another player present in the same world.
#[derive(Debug, Clone)]
pub struct Player {
    pub net_id:     u32,
    pub user_id:    u32,
    pub name:       String,
    pub country:    String,
    pub position:   (f32, f32),
    pub avatar:     String,
    pub online_id:  String,
    pub e_id:       String,
    pub ip:         String,
    pub col_rect:   String,
    pub title_icon: String,
    pub m_state:    u32,
    pub sm_state:   u32,
    pub invisible:  bool,
    /// Equipped item IDs across the 9 Growtopia slots:
    /// [hair, shirt, pants, feet, face, hand, back, mask, neck].
    pub equipped_clothes: [u32; 9],
}

/// Parse a `key|value\nkey|value\n…` string into a map.
pub fn parse_pipe_map(s: &str) -> HashMap<String, String> {
    s.lines()
        .filter_map(|line| {
            let mut parts = line.splitn(2, '|');
            let key = parts.next()?.trim().to_string();
            let val = parts.next().unwrap_or("").to_string();
            if key.is_empty() { None } else { Some((key, val)) }
        })
        .collect()
}
