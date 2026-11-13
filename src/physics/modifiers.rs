use crate::items::{ItemInfo, ItemsDat};
use super::config::{CharacterModifiers, MaladyKind};

/// Table-driven ability descriptor derived from an equipped Growtopia item.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct ItemPhysicsEffect {
    pub speed_multiplier: f32,
    pub is_speedy: bool,
    pub jump_multiplier: f32,
    pub air_jumps: u8,
    pub slow_fall: bool,
    pub air_thrust_accel: f32,
    pub long_jump_speed_boost: f32,
    pub punch_damage: u8,
    pub punch_reach_bonus: u8,
    pub build_reach_bonus: u8,
    pub label: Option<&'static str>,
}

impl ItemPhysicsEffect {
    pub const fn neutral() -> Self {
        Self {
            speed_multiplier: 1.0,
            is_speedy: false,
            jump_multiplier: 1.0,
            air_jumps: 0,
            slow_fall: false,
            air_thrust_accel: 0.0,
            long_jump_speed_boost: 1.0,
            punch_damage: 6,
            punch_reach_bonus: 0,
            build_reach_bonus: 0,
            label: None,
        }
    }
}

/// Server-driven modifier inputs extracted from incoming Growtopia packets.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ServerCharacterModifiers {
    /// Decoded ability mod bits (never raw ENet/tank packet flags).
    pub state_mod_flags: u32,
    /// Decoded bits from SetExtraMods (0x2D) when provided by server.
    pub extra_mods_bits: u32,
    /// True if server explicitly overrode base walk speed away from 250.0 px/s.
    pub server_walk_speed_overridden: bool,
    /// Authoritative punch reach from SetCharacterState (animation_type - 126).
    pub server_punch_reach: u8,
    /// Authoritative build reach from SetCharacterState (jump_count - 126).
    pub server_build_reach: u8,
}

const HIGH_SPEED_ITEM_IDS: &[u32] = &[
    496,  // Air Robinsons
    592,  // Tiny Horsie
    1496, // Rushboard
    1740, // StarBoard
];

const JETPACK_ITEM_IDS: &[u32] = &[
    160,  // Jetpack
    1140, // Astronaut Pack
];

const DOUBLE_JUMP_ITEM_IDS: &[u32] = &[
    156,  // Fairy Wings
    362,  // Angel Wings
    678,  // Crimson Eagle Wings
    1206, // Devil Wings
    1460, // Golden Angel Wings
    1550, // Bubble Wings
    1574, // Parrot Wings
    1672, // Rainbow Wings
    1674, // Phoenix Wings
];

const SLOW_FALL_ITEM_IDS: &[u32] = &[
    1020, // Parasol
];

const PUNCH_DAMAGE_ITEM_IDS: &[u32] = &[
    98, // Pickaxe
];

/// Classify movement, jump, reach, and punch abilities of any equippable Growtopia item
/// across all equipment slots using known item IDs and metadata/`items.dat` patterns.
pub fn classify_item_physics(item: &ItemInfo) -> ItemPhysicsEffect {
    // Only wearable/consumable equippable gear applies persistent clothing modifiers
    if item.action_type != 20 && item.action_type != 107 {
        return ItemPhysicsEffect::neutral();
    }

    let name = item.name.to_ascii_lowercase();
    let desc = item.description.to_ascii_lowercase();
    let punch = item.punch_option.to_ascii_lowercase();
    let mut eff = ItemPhysicsEffect::neutral();

    let is_jetpack = JETPACK_ITEM_IDS.contains(&item.id)
        || name.contains("jetpack")
        || desc.contains("jump really high")
        || desc.contains("on the moon")
        || desc.contains("jetpack")
        || (item.clothing_type == 6 && desc.contains("rocket"));

    let is_double_jump = DOUBLE_JUMP_ITEM_IDS.contains(&item.id)
        || desc.contains("double jump")
        || desc.contains("double-jump")
        || desc.contains("jump twice")
        || name.contains("boosted boots")
        || (name.contains("wings") && !name.contains("chicken") && !desc.contains("cosmetic only"))
        || (desc.contains("flap") && desc.contains("wings"));

    let is_slow_fall = SLOW_FALL_ITEM_IDS.contains(&item.id)
        || desc.contains("slow fall")
        || desc.contains("slow-fall")
        || desc.contains("slow your fall")
        || desc.contains("slows your fall")
        || desc.contains("fall slowly")
        || desc.contains("glide down")
        || desc.contains("float down")
        || desc.contains("parachute")
        || name.contains("parasol")
        || name.contains("parachute")
        || name.contains("umbrella");

    let is_speedy = HIGH_SPEED_ITEM_IDS.contains(&item.id)
        || desc.contains("run faster")
        || desc.contains("walk faster")
        || desc.contains("move faster")
        || desc.contains("faster than walking")
        || desc.contains("speedy")
        || desc.contains("high speed")
        || name.contains("air robinson")
        || name.contains("starboard")
        || name.contains("rushboard")
        || name.contains("tiny horsie")
        || name.contains("riding ");

    let has_negated_jump = desc.contains("don't jump higher") || desc.contains("not jump higher");
    let is_high_jump = (!has_negated_jump && desc.contains("jump higher"))
        || desc.contains("high jump")
        || desc.contains("super jump")
        || name.contains("moon boots")
        || name.contains("pogo");

    let is_punch_damage = PUNCH_DAMAGE_ITEM_IDS.contains(&item.id)
        || name.contains("pickaxe")
        || desc.contains("break blocks faster")
        || desc.contains("fewer hits")
        || desc.contains("punch damage")
        || desc.contains("stronger punch")
        || desc.contains("punch harder")
        || punch.contains("punch damage")
        || punch.contains("fewer hits");

    let is_both_range = desc.contains("punch and build further")
        || desc.contains("build and punch further")
        || desc.contains("longer reach")
        || desc.contains("increase your range")
        || desc.contains("extended reach")
        || name.contains("extra undead arms");

    let is_punch_range = is_both_range
        || desc.contains("punch further")
        || desc.contains("punch farther")
        || desc.contains("punch range")
        || desc.contains("longer punch")
        || desc.contains("punching range")
        || punch.contains("punch range")
        || punch.contains("punch further")
        || name.contains("focused eyes")
        || name.contains("cyclopean visor");

    let is_build_range = is_both_range
        || desc.contains("build further")
        || desc.contains("build farther")
        || desc.contains("build range")
        || desc.contains("place blocks further")
        || desc.contains("place blocks farther")
        || desc.contains("building range");

    if is_jetpack {
        eff.jump_multiplier = eff.jump_multiplier.max(1.26);
        eff.air_thrust_accel = 320.0;
        eff.long_jump_speed_boost = 1.18;
        eff.label = Some("Jetpack High/Long Jump");
    }

    if is_double_jump && !is_jetpack {
        eff.air_jumps = eff.air_jumps.max(1);
        eff.label = Some("Double Jump");
    }

    if is_slow_fall {
        eff.slow_fall = true;
        if eff.label.is_none() {
            eff.label = Some("Slow Fall");
        }
    }

    if is_speedy {
        eff.is_speedy = true;
        eff.speed_multiplier = eff.speed_multiplier.max(1.10);
        if eff.label.is_none() {
            eff.label = Some("Speedy");
        }
    }

    if is_high_jump && !is_jetpack {
        eff.jump_multiplier = eff.jump_multiplier.max(1.28);
        if eff.label.is_none() {
            eff.label = Some("High Jump");
        }
    }

    if is_punch_damage {
        eff.punch_damage = 8;
        if eff.label.is_none() {
            eff.label = Some("Punch Damage");
        }
    }

    if is_punch_range {
        eff.punch_reach_bonus = 1;
        if eff.label.is_none() {
            eff.label = Some("Punch Range");
        }
    }

    if is_build_range {
        eff.build_reach_bonus = 1;
        if eff.label.is_none() {
            eff.label = Some("Build Range");
        }
    }

    eff
}

/// Detect malady changes from Growtopia `OnTalkBubble` / `OnConsoleMessage` text.
pub fn parse_malady_event(text: &str) -> Option<Option<MaladyKind>> {
    let lower = text.to_ascii_lowercase();
    if lower.contains("cured")
        || lower.contains("no longer have")
        || lower.contains("malady has worn off")
        || lower.contains("malady faded")
    {
        return Some(None);
    }
    if lower.contains("chicken feet") {
        return Some(Some(MaladyKind::ChickenFeet));
    }
    if lower.contains("brainworms") {
        return Some(Some(MaladyKind::Brainworms));
    }
    if lower.contains("gemcuts") {
        return Some(Some(MaladyKind::Gemcuts));
    }
    if lower.contains("grumbleteeth") {
        return Some(Some(MaladyKind::Grumbleteeth));
    }
    if lower.contains("broken heart") && lower.contains("malady") {
        return Some(Some(MaladyKind::BrokenHeart));
    }
    None
}

/// Compute aggregate `CharacterModifiers` from equipped item IDs across all slots,
/// decoded server modifier packets, and any active malady.
pub fn resolve_character_modifiers(
    items_dat: &ItemsDat,
    equipped_ids: &[u32],
    malady: Option<MaladyKind>,
    server: ServerCharacterModifiers,
) -> CharacterModifiers {
    let mut mods = CharacterModifiers::default();
    let mut speed_mul: f32 = 1.0;
    let mut jump_mul: f32 = 1.0;
    let mut speedy_stacks: u8 = 0;
    let mut punch_reach_bonus: u8 = 0;
    let mut build_reach_bonus: u8 = 0;
    let mut has_jetpack = false;

    for &item_id in equipped_ids {
        if item_id == 0 {
            continue;
        }
        let Some(item) = items_dat.find_by_id(item_id) else {
            continue;
        };
        let eff = classify_item_physics(item);
        if eff.is_speedy {
            speedy_stacks = speedy_stacks.saturating_add(1);
        } else if !server.server_walk_speed_overridden {
            speed_mul = speed_mul.max(eff.speed_multiplier);
        }
        jump_mul = jump_mul.max(eff.jump_multiplier);
        mods.max_air_jumps = mods.max_air_jumps.max(eff.air_jumps);
        mods.slow_fall |= eff.slow_fall;
        mods.air_thrust_accel = mods.air_thrust_accel.max(eff.air_thrust_accel);
        mods.long_jump_speed_boost = mods.long_jump_speed_boost.max(eff.long_jump_speed_boost);
        mods.punch_damage = mods.punch_damage.max(eff.punch_damage);
        punch_reach_bonus = punch_reach_bonus.saturating_add(eff.punch_reach_bonus);
        build_reach_bonus = build_reach_bonus.saturating_add(eff.build_reach_bonus);
        if eff.air_thrust_accel > 0.0 {
            has_jetpack = true;
        }
    }

    // Decoded server ability bits (never raw packet flags).
    let mod_flags = server.state_mod_flags | server.extra_mods_bits;
    if (mod_flags & 0x02) != 0 {
        mods.max_air_jumps = mods.max_air_jumps.max(1);
    }
    if (mod_flags & 0x04) != 0 {
        jump_mul = jump_mul.max(1.28);
    }
    if (mod_flags & 0x08) != 0 && !server.server_walk_speed_overridden {
        speedy_stacks = speedy_stacks.max(1);
    }
    if (mod_flags & 0x400) != 0 {
        mods.slow_fall = true;
    }

    if speedy_stacks > 0 && !server.server_walk_speed_overridden {
        let capped = speedy_stacks.min(3);
        speed_mul *= 1.0 + 0.10 * (capped as f32);
    }

    mods.punch_reach = 2u8
        .saturating_add(punch_reach_bonus)
        .max(server.server_punch_reach)
        .clamp(2, 10);
    mods.build_reach = 2u8
        .saturating_add(build_reach_bonus)
        .max(server.server_build_reach)
        .clamp(2, 10);

    mods.malady = malady;
    match malady {
        Some(MaladyKind::ChickenFeet) => {
            speed_mul *= 0.68;
            jump_mul *= 0.78;
            mods.active_effects.push("Chicken Feet (-Spd/-Jump)".to_string());
        }
        Some(MaladyKind::Brainworms) => {
            speed_mul *= 0.88;
            mods.active_effects.push("Brainworms (-Spd)".to_string());
        }
        Some(MaladyKind::Gemcuts) => {
            mods.active_effects.push("Gemcuts".to_string());
        }
        Some(MaladyKind::Grumbleteeth) => {
            mods.active_effects.push("Grumbleteeth".to_string());
        }
        Some(MaladyKind::BrokenHeart) => {
            mods.active_effects.push("Broken Heart".to_string());
        }
        None => {}
    }

    if speedy_stacks > 0 && !server.server_walk_speed_overridden {
        mods.active_effects.push(format!("Speedy +{}%", speedy_stacks.min(3) * 10));
    }
    if has_jetpack {
        mods.active_effects.push("Jetpack High/Long Jump".to_string());
    } else if jump_mul > 1.05 {
        mods.active_effects.push("High Jump".to_string());
    }
    if mods.max_air_jumps > 0 {
        mods.active_effects.push("Double Jump".to_string());
    }
    if mods.slow_fall {
        mods.active_effects.push("Slow Fall".to_string());
    }
    if mods.punch_damage > 6 {
        mods.active_effects.push(format!("Punch Damage ({})", mods.punch_damage));
    }
    if mods.punch_reach > 2 {
        mods.active_effects.push(format!("Punch Range ({}t)", mods.punch_reach));
    }
    if mods.build_reach > 2 {
        mods.active_effects.push(format!("Build Range ({}t)", mods.build_reach));
    }

    mods.speed_multiplier = speed_mul.clamp(0.4, 1.35);
    mods.jump_multiplier = jump_mul.clamp(0.55, 1.5);
    mods
}

#[cfg(test)]
mod tests {
    use super::*;

    fn synthetic_item(id: u32, name: &str, desc: &str, clothing_type: u8) -> ItemInfo {
        ItemInfo {
            id,
            name: name.to_string(),
            description: desc.to_string(),
            clothing_type,
            action_type: 20,
            ..Default::default()
        }
    }

    #[test]
    fn test_classify_real_items_dat_abilities() {
        if !std::path::Path::new("items.dat").exists() {
            return;
        }
        let data = std::fs::read("items.dat").expect("read items.dat");
        let items = ItemsDat::parse(&data).expect("parse items.dat");

        let fairy = classify_item_physics(items.find_by_id(156).unwrap());
        assert_eq!(fairy.air_jumps, 1);
        assert!(!fairy.slow_fall);

        // Devil Wings description contains "don't jump higher" - must not falsely boost jump!
        let devil = classify_item_physics(items.find_by_id(1206).unwrap());
        assert_eq!(devil.air_jumps, 1);
        assert_eq!(devil.jump_multiplier, 1.0);

        let jetpack = classify_item_physics(items.find_by_id(160).unwrap());
        assert!(jetpack.jump_multiplier > 1.2);
        assert!(jetpack.air_thrust_accel > 0.0);
        assert!(jetpack.long_jump_speed_boost > 1.0);

        let parasol = classify_item_physics(items.find_by_id(1020).unwrap());
        assert!(parasol.slow_fall);

        let shoes = classify_item_physics(items.find_by_id(496).unwrap());
        assert!(shoes.is_speedy && shoes.speed_multiplier >= 1.10);

        let pickaxe = classify_item_physics(items.find_by_id(98).unwrap());
        assert_eq!(pickaxe.punch_damage, 8);
    }

    #[test]
    fn test_speedy_stacking_capped_at_three() {
        let items = ItemsDat {
            version: 24,
            items: vec![
                synthetic_item(1, "Air Robinsons", "Run faster!", 4),
                synthetic_item(2, "Speedy Shirt", "Lets you walk faster.", 1),
                synthetic_item(3, "Speedy Hat", "Helps you move faster.", 0),
                synthetic_item(4, "Speedy Scarf", "Provides the Speedy mod.", 8),
            ],
        };

        let one = resolve_character_modifiers(&items, &[1], None, ServerCharacterModifiers::default());
        assert!((one.speed_multiplier - 1.10).abs() < 1e-4, "got {}", one.speed_multiplier);

        let two = resolve_character_modifiers(&items, &[1, 2], None, ServerCharacterModifiers::default());
        assert!((two.speed_multiplier - 1.20).abs() < 1e-4, "got {}", two.speed_multiplier);

        let three = resolve_character_modifiers(&items, &[1, 2, 3], None, ServerCharacterModifiers::default());
        assert!((three.speed_multiplier - 1.30).abs() < 1e-4, "got {}", three.speed_multiplier);

        let four = resolve_character_modifiers(&items, &[1, 2, 3, 4], None, ServerCharacterModifiers::default());
        assert!((four.speed_multiplier - 1.30).abs() < 1e-4, "4 items should cap at 1.30, got {}", four.speed_multiplier);
    }

    #[test]
    fn test_feet_double_jump_and_orthogonal_combat_gear() {
        let items = ItemsDat {
            version: 24,
            items: vec![
                synthetic_item(10, "Boosted Boots", "Allows you to double jump!", 4),
                synthetic_item(98, "Pickaxe", "Break blocks in fewer hits.", 5),
                synthetic_item(20, "Focused Eyes", "Lets you punch further.", 3),
                synthetic_item(30, "Extra Undead Arms", "Lets you build further and punch further!", 1),
            ],
        };

        let mods = resolve_character_modifiers(
            &items,
            &[10, 98, 20, 30],
            None,
            ServerCharacterModifiers::default(),
        );
        assert_eq!(mods.max_air_jumps, 1);
        assert_eq!(mods.punch_damage, 8);
        assert_eq!(mods.punch_reach, 4);
        assert_eq!(mods.build_reach, 3);
    }

    #[test]
    fn test_malady_event_parser() {
        assert_eq!(
            parse_malady_event("You caught a Malady: Chicken Feet!"),
            Some(Some(MaladyKind::ChickenFeet))
        );
        assert_eq!(
            parse_malady_event("You have been cured of your malady!"),
            Some(None)
        );
        assert_eq!(parse_malady_event("Hello world"), None);
    }
}
